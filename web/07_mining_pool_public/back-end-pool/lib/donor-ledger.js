'use strict';

// Donor ledger reads — the composite `balance_log_daily` + `balance_log` shape every donor
// surface uses (design §16.3: lifetime totals, first/last dates and active months are all
// DERIVED from the ledger at read time; there is no column for them). One definition here,
// so the account page, the wall and the admin list can never disagree on what "last donated"
// or "active months" means. Part 2 added the per-address last debit; Part 3 added the
// per-address aggregate + the §16.6 score helpers; Part 4 added donorWall(), the public
// response built from those same rows.
//
// Horizon contract (lib/ledger-rollup.js): rolled days live in balance_log_daily with
// day < H, raw rows in balance_log with created_at >= H. A rolled day's timestamp is its
// UTC-day boundary, so anything read from the rollup side is day-aligned — second precision
// only inside the raw window.

const { getHorizon } = require('./ledger-rollup');
// Neither donor-names.js nor donor-profiles.js depends on this file, so these directions cannot
// cycle (donor-profiles.js takes its ledger facts as plain values for exactly that reason).
const { donorSettings } = require('./donor-names');
const { publicProfiles, bannerSlots } = require('./donor-profiles');
const { parseDonateToken } = require('./stratum-protocol');

const resolveH = (db, H) => (H === null || H === undefined ? getHorizon(db) : H);

// Unix time of the address's most recent donation debit, or null when it has never donated.
// H is the rollup horizon (0 = no rollup yet → whole ledger is raw); passed in by callers
// that already hold it, read here otherwise.
function lastDonatedAt(db, address, H = null) {
  const h = resolveH(db, H);
  const row = db.prepare(`
    SELECT MAX(t) AS last_donated_at FROM (
      SELECT day AS t
      FROM balance_log_daily
      WHERE grin_address = ? AND event_type = 'debit' AND reference_type = 'donation' AND day < ?
      UNION ALL
      SELECT created_at
      FROM balance_log
      WHERE grin_address = ? AND event_type = 'debit' AND reference_type = 'donation' AND created_at >= ?
    )
  `).get(address, h, address, h);
  return row && row.last_donated_at != null ? row.last_donated_at : null;
}

// Every address with at least one donation debit, aggregated over the whole composite:
//   total_donated      lifetime GRIN
//   in_window_donated  GRIN with t >= now - windowDays × 86400 (windowDays 0 → lifetime)
//   first/last_donated_at, donation_count
//   active_months      distinct UTC calendar months with a debit, lifetime (§16.1 #8)
// One GROUP BY over the same UNION /api/pool/donors has always scanned — no per-row query.
//
// Window boundary, stated once: a rolled day is one row stamped at its UTC midnight, so it is
// in the window WHOLE when that midnight is >= the cutoff and out WHOLE otherwise — a debit
// at 23:59 on a rolled day is counted by its day, not its second. Raw rows (created_at >= H)
// are compared at second precision. The cutoff therefore lands on a day edge for anything
// older than the horizon, which is what "365 days" means to a reader of the wall anyway.
function donorLedger(db, opts = {}) {
  const h = resolveH(db, opts.H);
  const now = Number.isFinite(opts.now) ? Math.floor(opts.now) : Math.floor(Date.now() / 1000);
  const windowDays = Number.isFinite(opts.windowDays) && opts.windowDays > 0 ? Math.floor(opts.windowDays) : 0;
  const cutoff = windowDays > 0 ? now - windowDays * 86400 : 0;
  return db.prepare(`
    SELECT grin_address AS address,
           SUM(amt)                                       AS total_donated,
           SUM(CASE WHEN t >= ? THEN amt ELSE 0 END)      AS in_window_donated,
           MIN(t)                                         AS first_donated_at,
           MAX(t)                                         AS last_donated_at,
           SUM(cnt)                                       AS donation_count,
           COUNT(DISTINCT strftime('%Y-%m', t, 'unixepoch')) AS active_months
    FROM (
      SELECT grin_address, total_amount AS amt, day AS t, event_count AS cnt
      FROM balance_log_daily
      WHERE event_type = 'debit' AND reference_type = 'donation' AND day < ?
      UNION ALL
      SELECT grin_address, amount, created_at, 1
      FROM balance_log
      WHERE event_type = 'debit' AND reference_type = 'donation' AND created_at >= ?
    )
    GROUP BY grin_address
    HAVING SUM(amt) > 0
  `).all(cutoff, h, h).map((r) => ({
    address: r.address,
    total_donated: round9(r.total_donated),
    in_window_donated: round9(r.in_window_donated),
    first_donated_at: r.first_donated_at,
    last_donated_at: r.last_donated_at,
    donation_count: r.donation_count || 0,
    active_months: r.active_months || 0
  }));
}

const round9 = (v) => parseFloat((Number(v) || 0).toFixed(9));

// ── §16.6 ranking helpers ─────────────────────────────────────────────────────────────────
// `ds` is donorSettings() from lib/donor-names.js — already bounded, so nothing here can see
// NaN or Infinity (memory reference_money_number_boundary_traps); the guards below are for a
// caller that passes a raw section by mistake, and resolve to the documented defaults.
//
//   mult  = min(1 + loyalty%/100 × months, cap)
//   score = in_window × mult
function loyaltyMultiplier(activeMonths, ds = {}) {
  const pct = Number.isFinite(ds.loyaltyPercentPerMonth) ? ds.loyaltyPercentPerMonth : 10;
  const cap = Number.isFinite(ds.loyaltyCap) && ds.loyaltyCap >= 1 ? ds.loyaltyCap : 3;
  const months = Number.isFinite(activeMonths) && activeMonths > 0 ? Math.floor(activeMonths) : 0;
  return parseFloat(Math.min(1 + (pct / 100) * months, cap).toFixed(4));
}

function donorScore(inWindowDonated, activeMonths, ds = {}) {
  const a = Number.isFinite(inWindowDonated) && inWindowDonated > 0 ? inWindowDonated : 0;
  return round9(a * loyaltyMultiplier(activeMonths, ds));
}

// League order: score DESC, active months DESC, first donation ASC (§16.1 #7 — the second
// key is reachable because months is an integer; 9-decimal amounts never tie). A comparator,
// so the admin list and the wall sort identically. Rows must carry `score`, `active_months`,
// `first_donated_at`.
function leagueOrder(a, b) {
  if (b.score !== a.score) return b.score - a.score;
  if (b.active_months !== a.active_months) return b.active_months - a.active_months;
  return (a.first_donated_at || 0) - (b.first_donated_at || 0);
}

// Past-donors order (§16.6): most recent last donation first. Rolled days are day-aligned,
// so two past donors tie by the day often — break on lifetime DESC, then address ASC, so the
// strip is stable between refreshes instead of shuffling on every poll.
function pastOrder(a, b) {
  if ((b.last_donated_at || 0) !== (a.last_donated_at || 0)) return (b.last_donated_at || 0) - (a.last_donated_at || 0);
  if (b.total_donated !== a.total_donated) return b.total_donated - a.total_donated;
  return a.address < b.address ? -1 : a.address > b.address ? 1 : 0;
}

const LEAGUE_LIMIT = 100;
const PAST_LIMIT = 20;

// One address's league rank (1-based) under exactly the ordering donorWall() uses, or null when
// it has nothing in the window (past strip / never donated) or ranks below LEAGUE_LIMIT — the
// same set of addresses that get a numbered card. Design §18.6: the account page's
// donor_profile.banner.slot_rank ("shows while you're in the top 5 — you're #8"). Same one
// composite ledger scan as the wall; the caller runs it only for an address that has donated.
function leagueRank(db, address, opts = {}) {
  const ds = opts.ds && typeof opts.ds === 'object' ? opts.ds : donorSettings({}, '');
  const rows = donorLedger(db, { H: opts.H, windowDays: ds.rankWindowDays, now: opts.now })
    .filter((r) => r.in_window_donated > 0);
  for (const r of rows) r.score = donorScore(r.in_window_donated, r.active_months, ds);
  rows.sort(leagueOrder);
  const idx = rows.findIndex((r) => r.address === address);
  return idx >= 0 && idx < LEAGUE_LIMIT ? idx + 1 : null;
}

// ── §18.3 — who is donating RIGHT NOW ────────────────────────────────────────────────────
// Pure: live stratum sessions in, Map<address, reading> out. The one definition the account
// page, its workers table, the wall and the admin list all read, so they can never disagree.
//
//   rigs_online       distinct worker names on MINING sessions
//   rigs_donating     how many of those carry a live `donateN` tag with N > 0
//   pct_min, pct_max  over the donating rigs; 0 when none donates
//   donating_workers  [{ name, percent }] for those rigs, sorted by name
//
// MINING sessions only (`acceptedShares > 0`, audit §J6-9): a session exists from an
// unauthenticated login, so without the accepted-share bar anyone could put "3 rigs donating"
// on someone else's card by opening sockets under their address. Distinct names, because one
// rig reconnecting shows up as two sessions for a moment. `donate0` counts as online, not as
// donating — a 0 % tag equals no tag (§18.1 #2). The same parseDonateToken rewards.js reads
// per share, so a rig that shows as donating here is exactly one whose shares donate.
//
// Not gated on the operator's switch — the callers gate (donationsActive()), since the
// readings they zero differ (rigs_online stays true with donations off).
function liveDonations(sessions) {
  const byAddr = new Map();   // address → Map<workerName, percent|null>
  for (const s of (sessions || [])) {
    if (!s || !(s.acceptedShares > 0)) continue;
    const a = s.grinAddress;
    if (!a) continue;
    let names = byAddr.get(a);
    if (!names) { names = new Map(); byAddr.set(a, names); }
    const name = s.workerName || 'default';
    if (!names.has(name)) {
      const t = parseDonateToken(name);
      names.set(name, t ? t.percent : null);
    }
  }
  const out = new Map();
  for (const [a, names] of byAddr) {
    const donating = [...names].filter(([, p]) => p > 0)
      .map(([name, percent]) => ({ name, percent }))
      .sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));
    const pcts = donating.map((w) => w.percent);
    out.set(a, {
      rigs_online: names.size,
      rigs_donating: donating.length,
      pct_min: pcts.length ? Math.min(...pcts) : 0,
      pct_max: pcts.length ? Math.max(...pcts) : 0,
      donating_workers: donating
    });
  }
  return out;
}

// The empty reading — what an address with no mining session reads as.
const NO_LIVE = Object.freeze({ rigs_online: 0, rigs_donating: 0, pct_min: 0, pct_max: 0, donating_workers: Object.freeze([]) });

// ── §16.6 + §16.7 — the public wall ──────────────────────────────────────────────────────
// The whole /api/pool/donors response, built here rather than in the route so
// scripts/test-donor-league.js can run it against an in-memory DB (index.js starts a server
// on require, so a route can be read as text but never executed).
//
//   league   donors with GRIN in the window, leagueOrder, first LEAGUE_LIMIT — rank 1..N
//   past     donors with nothing in the window (lifetime > 0), pastOrder, first PAST_LIMIT,
//            plus `more` = how many the strip does not show. Disjoint from `league` by
//            construction (in-window > 0 vs not), so a donor is never on both.
//   totals   over EVERY donor, not the cards: donor_count, active_donors (addresses with a
//            tagged rig mining NOW — rigs_donating > 0 — gated on `active` like the badges,
//            and counting a tagged address that has no card yet), total_donated (lifetime Σ)
//   ranking  the four settings the page turns into its one ranking sentence, plus
//            banner_slots — N of the page's Top-N spotlight (0 = no spotlight, no banners)
//
// opts:
//   ds          donorSettings() — bounded (window ≥ 0, loyalty 0–100, cap ≥ 1, expiry ≥ 0,
//               banner slots 0–10), so no NaN/Infinity reaches a multiplier; defaults when absent
//   now, H      clock + rollup horizon (resolved from the DB when absent)
//   active      donationsActive(): false reads every rigs_donating / pct_* as 0 and
//               active_donors as 0 — with the operator's switch off a tag moves nothing, so
//               nothing is advertised as a live cut
//   mask        REQUIRED: the address mask. Throws without one — a wall with no mask is the
//               §J11-1 leak, and the caller must not be able to get full addresses out of
//               this by forgetting an argument. Applied to BOTH arrays here.
//   live        liveDonations(sessions) — Map<address, reading>. Display only, never ranked
//               (§16.1 #10). Absent = nobody online.
//
// Card, per §18.3: rigs_online (ungated), rigs_donating, pct_min, pct_max. (The v1
// current_percent went in §18 Part 4 — it duplicated pct_max, and donate.html was its last
// reader.)
//
// Names (design §18.7, since §18 Part 3): the APPROVED, unexpired name from
// lib/donor-profiles.js publicProfiles() — the same expiry rule the donor's own account page
// reads through profileFor(). `name` is null for every name_state but `shown` (masked = no
// approved name, expired). A pending, rejected or removed name can never reach a card, and the
// v1 donor_name column on miner_incentives is not read at all: v1 names were never reviewed,
// so pre-moderation starts clean.
//
// Banners (design §18.7, §18 Part 4): `banner` is { url, width, height } ONLY on a league card
// whose rank ≤ donor_banner_slots and whose address has an approved, unexpired banner — else
// null. Past cards are always null: a banner is a place in the top N, not a thank-you. The
// URL is publicProfiles' publicUrl() (`/uploads/donors/<16 hex>.<png|jpg|gif>` or nothing),
// and a row whose stored dims are not positive integers shows no banner rather than one the
// page cannot reserve space for. The key is on every card so both arrays share one shape.
//
// Cost: the ONE composite ledger scan this route has always done (now via donorLedger) and one
// IN-list read of approved donor_requests for the ≤ 120 cards shown; active_donors comes from
// `live`.
function donorWall(db, opts = {}) {
  if (typeof opts.mask !== 'function') throw new Error('donorWall: an address mask function is required');
  const ds = opts.ds && typeof opts.ds === 'object' ? opts.ds : donorSettings({}, '');
  const now = Number.isFinite(opts.now) ? Math.floor(opts.now) : Math.floor(Date.now() / 1000);
  const h = resolveH(db, opts.H);
  const active = opts.active === true;
  const live = opts.live && typeof opts.live.get === 'function' ? opts.live : new Map();
  const liveFor = (a) => live.get(a) || NO_LIVE;
  const count = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.floor(Number(v)) : 0);
  const pct = (v) => (Number.isFinite(Number(v)) ? Math.max(0, Math.min(100, Number(v))) : 0);
  const slots = bannerSlots(ds);   // 0–10, re-bounded here too: a raw `ds` may skip donorSettings()
  const dim = (v) => Number.isSafeInteger(v) && v > 0;

  const rows = donorLedger(db, { H: h, windowDays: ds.rankWindowDays, now });
  for (const r of rows) {
    r.multiplier = loyaltyMultiplier(r.active_months, ds);
    r.score = donorScore(r.in_window_donated, r.active_months, ds);
  }

  // Totals over EVERY donor (fixed 2026-09-21 — they were once summed after the LIMIT).
  // active_donors: addresses with a tagged rig mining now. It read the stored v1 % column
  // until design §18.3; that column is dead, so a live tag is the only honest source.
  let activeDonors = 0;
  if (active) for (const v of live.values()) if (count(v && v.rigs_donating) > 0) activeDonors++;
  const totals = {
    donor_count: rows.length,
    active_donors: activeDonors,
    total_donated: round9(rows.reduce((a, r) => a + r.total_donated, 0))
  };

  const inWindow = rows.filter((r) => r.in_window_donated > 0).sort(leagueOrder);
  const outOfWindow = rows.filter((r) => !(r.in_window_donated > 0)).sort(pastOrder);
  const league = inWindow.slice(0, LEAGUE_LIMIT);
  const past = outOfWindow.slice(0, PAST_LIMIT);

  // Names for the cards actually shown, one read of APPROVED rows only. Nothing on
  // miner_incentives is read (the v1 donation_percent and donor_* columns are dead, §18.2/§18.6).
  const shown = league.concat(past);
  const lastByAddr = new Map(shown.map((r) => [r.address, r.last_donated_at]));
  const profiles = publicProfiles(db, shown.map((r) => r.address), { ds, now, lastDonatedAt: lastByAddr });

  const card = (r, rank) => {
    const st = profiles.get(r.address) || { name: null, name_state: 'masked', banner: null };
    const lv = liveFor(r.address);
    const donating = active ? count(lv.rigs_donating) : 0;
    // The slot rule: a numbered league card (past cards have rank null) inside the top N.
    const b = st.banner;
    const inSlot = Number.isSafeInteger(rank) && rank >= 1 && rank <= slots;
    const banner = inSlot && b && typeof b.url === 'string' && dim(b.width) && dim(b.height)
      ? { url: b.url, width: b.width, height: b.height } : null;
    return {
      rank,
      name: st.name,
      name_state: st.name_state,
      banner,
      address: opts.mask(r.address),
      in_window_donated: r.in_window_donated,
      total_donated: r.total_donated,
      active_months: r.active_months,
      multiplier: r.multiplier,
      score: r.score,
      first_donated_at: r.first_donated_at,
      last_donated_at: r.last_donated_at,
      donation_count: r.donation_count,
      rigs_online: count(lv.rigs_online),
      rigs_donating: donating,
      pct_min: donating ? pct(lv.pct_min) : 0,
      pct_max: donating ? pct(lv.pct_max) : 0
    };
  };

  return {
    league: league.map((r, idx) => card(r, idx + 1)),
    past: { donors: past.map((r) => card(r, null)), more: outOfWindow.length - past.length },
    totals,
    ranking: {
      window_days: ds.rankWindowDays,
      loyalty_percent_per_month: ds.loyaltyPercentPerMonth,
      loyalty_cap: ds.loyaltyCap,
      name_expiry_months: ds.nameExpiryMonths,
      banner_slots: slots
    }
  };
}

module.exports = {
  lastDonatedAt, donorLedger, loyaltyMultiplier, donorScore, leagueOrder, pastOrder,
  donorWall, liveDonations, leagueRank, NO_LIVE, LEAGUE_LIMIT, PAST_LIMIT
};
