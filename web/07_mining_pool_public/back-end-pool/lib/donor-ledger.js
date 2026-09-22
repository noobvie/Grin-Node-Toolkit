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
// donor-names.js has no dependency on this file, so this direction cannot cycle.
const { displayState, donorSettings } = require('./donor-names');

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

// ── §16.6 + §16.7 — the public wall ──────────────────────────────────────────────────────
// The whole /api/pool/donors response, built here rather than in the route so
// scripts/test-donor-league.js can run it against an in-memory DB (index.js starts a server
// on require, so a route can be read as text but never executed).
//
//   league   donors with GRIN in the window, leagueOrder, first LEAGUE_LIMIT — rank 1..N
//   past     donors with nothing in the window (lifetime > 0), pastOrder, first PAST_LIMIT,
//            plus `more` = how many the strip does not show. Disjoint from `league` by
//            construction (in-window > 0 vs not), so a donor is never on both.
//   totals   over EVERY donor, not the cards: donor_count, active_donors (LIVE tags, gated
//            on `active` like the badges), total_donated (lifetime Σ)
//   ranking  the four settings the page turns into its one ranking sentence
//   censored_display  what a censored name renders as ('masked' | 'marker')
//
// opts:
//   ds          donorSettings() — bounded (window ≥ 0, loyalty 0–100, cap ≥ 1, expiry ≥ 0),
//               so no NaN/Infinity reaches a multiplier; defaults when absent
//   now, H      clock + rollup horizon (resolved from the DB when absent)
//   active      donationsActive(): false reads every current_percent as 0 and active_donors
//               as 0 — with the operator's switch off a stored % is dormant, not a live cut
//   mask        REQUIRED: the address mask. Throws without one — a wall with no mask is the
//               §J11-1 leak, and the caller must not be able to get full addresses out of
//               this by forgetting an argument. Applied to BOTH arrays here.
//   rigsOnline  Map<address, n> or (address) => n. Display only, never ranked (§16.1 #10).
//
// Names go through the SAME displayState the account API uses, so a donor's own page and
// the wall can never disagree; `name` is null for every state but `shown`, and the censored
// marker only when the operator chose it (§16.7). No card field carries the censor word,
// the censoring admin, or the raw censor state — those are admin-side (§16.8).
//
// Cost: the ONE composite ledger scan this route has always done (now via donorLedger), one
// COUNT for active_donors, and one IN-list read of miner_incentives for the ≤ 120 cards shown.
function donorWall(db, opts = {}) {
  if (typeof opts.mask !== 'function') throw new Error('donorWall: an address mask function is required');
  const ds = opts.ds && typeof opts.ds === 'object' ? opts.ds : donorSettings({}, '');
  const now = Number.isFinite(opts.now) ? Math.floor(opts.now) : Math.floor(Date.now() / 1000);
  const h = resolveH(db, opts.H);
  const active = opts.active === true;
  const rigs = typeof opts.rigsOnline === 'function'
    ? opts.rigsOnline
    : (a) => (opts.rigsOnline && typeof opts.rigsOnline.get === 'function' ? opts.rigsOnline.get(a) : 0);

  const rows = donorLedger(db, { H: h, windowDays: ds.rankWindowDays, now });
  for (const r of rows) {
    r.multiplier = loyaltyMultiplier(r.active_months, ds);
    r.score = donorScore(r.in_window_donated, r.active_months, ds);
  }

  // Totals over EVERY donor (fixed 2026-09-21 — they were once summed after the LIMIT).
  const activeDonors = active
    ? db.prepare('SELECT COUNT(*) AS n FROM miner_incentives WHERE donation_percent > 0').get().n
    : 0;
  const totals = {
    donor_count: rows.length,
    active_donors: activeDonors,
    total_donated: round9(rows.reduce((a, r) => a + r.total_donated, 0))
  };

  const inWindow = rows.filter((r) => r.in_window_donated > 0).sort(leagueOrder);
  const outOfWindow = rows.filter((r) => !(r.in_window_donated > 0)).sort(pastOrder);
  const league = inWindow.slice(0, LEAGUE_LIMIT);
  const past = outOfWindow.slice(0, PAST_LIMIT);

  // Name + current % for the cards actually shown, one read. donation_percent is the only
  // non-donor_* column read; donor_censor is read for displayState and never emitted.
  const shown = league.concat(past);
  const incByAddr = new Map();
  if (shown.length) {
    const q = db.prepare(`
      SELECT grin_address, donation_percent, donor_name, donor_name_set_at, donor_censor
      FROM miner_incentives
      WHERE grin_address IN (${shown.map(() => '?').join(',')})
    `);
    for (const r of q.all(...shown.map((r) => r.address))) incByAddr.set(r.grin_address, r);
  }

  const card = (r, rank) => {
    const i = incByAddr.get(r.address) || null;
    const st = displayState(i, {
      now,
      expiryMonths: ds.nameExpiryMonths,
      censoredDisplay: ds.censoredDisplay,
      lastDonatedAt: r.last_donated_at
    });
    const n = Number(rigs(r.address));
    return {
      rank,
      name: st.name,
      name_state: st.name_state,
      address: opts.mask(r.address),
      in_window_donated: r.in_window_donated,
      total_donated: r.total_donated,
      active_months: r.active_months,
      multiplier: r.multiplier,
      score: r.score,
      current_percent: active && i ? (Number(i.donation_percent) || 0) : 0,
      first_donated_at: r.first_donated_at,
      last_donated_at: r.last_donated_at,
      donation_count: r.donation_count,
      rigs_online: Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
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
      name_expiry_months: ds.nameExpiryMonths
    },
    censored_display: ds.censoredDisplay
  };
}

module.exports = {
  lastDonatedAt, donorLedger, loyaltyMultiplier, donorScore, leagueOrder, pastOrder,
  donorWall, LEAGUE_LIMIT, PAST_LIMIT
};
