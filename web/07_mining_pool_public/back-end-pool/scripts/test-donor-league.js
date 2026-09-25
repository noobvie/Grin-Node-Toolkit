'use strict';

// Donor league (design §16.6/§16.7, Part 4) — the public /api/pool/donors v2 response built by
// lib/donor-ledger.js donorWall() against an in-memory copy of the real schema. index.js starts
// a server on require, so the route itself is only ever read as text (test-public-leakage.js);
// everything the route hands the lib — switch state, live rigs, the mask — is passed here as
// fixtures. Covers: the 100/20 limits with totals over every donor and an exact Σ; the window
// dropping a donor whose last debit is older (and 0 = lifetime); active months across rollup +
// raw; the multiplier cap; tie order; past-strip order + `more`; names from APPROVED donor
// profiles only (§18 Part 3 — pending/rejected/removed and v1 names never reach a card) and
// expired → null; banners (§18 Part 4) only on league ranks ≤ donor_banner_slots, never on
// the past strip, never from a non-approved row; league/past disjoint; the mask being
// REQUIRED and applied to both arrays; blank/junk settings never reaching a score; the
// donations switch zeroing the live readings; and (design §18.3) liveDonations() — the one
// per-rig reading of who is donating now — plus the wall's rigs_* / pct_* fields built from it
// and NEVER from the dead v1 donation_percent column.
// Run: node scripts/test-donor-league.js   (no server, no file on disk)

const path = require('path');
const APP = path.resolve(__dirname, '..');

const { initDb, getDb } = require(path.join(APP, 'lib/db.js'));
initDb(':memory:');
const db = getDb();

const DN = require(path.join(APP, 'lib/donor-names.js'));
const DL = require(path.join(APP, 'lib/donor-ledger.js'));
const { donorWall, liveDonations, LEAGUE_LIMIT, PAST_LIMIT } = DL;

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else      { fail++; console.error(`  FAIL ${name}${extra ? ' — ' + extra : ''}`); }
}
const throws = (fn) => { try { fn(); return false; } catch (_) { return true; } };

const NOW = 1_800_000_000;                         // fixed clock
const day = (t) => Math.floor(t / 86400) * 86400;  // UTC-day align
const H = day(NOW - 30 * 86400);                   // rollup horizon: 30 days back
const round9 = (v) => parseFloat(Number(v).toFixed(9));

// The 9+4 mask the route passes (index.js maskAddr) — re-derived, index.js cannot be required.
const mask = (a) => { const s = String(a || ''); return s.length > 16 ? `${s.slice(0, 9)}…${s.slice(-4)}` : s; };
const MASK_RE = /^grin1[a-z0-9]{4}…[a-z0-9]{4}$/;

// ── fixtures ─────────────────────────────────────────────────────────────────────────────
const mkAddr = (i) => `grin1${String(i).padStart(56, 'q')}${String(i % 97).padStart(2, '0')}`;
const allAddrs = new Set();
function seedAddr(i) {
  const a = mkAddr(i);
  db.prepare('INSERT OR IGNORE INTO miner_accounts (grin_address, balance) VALUES (?, 0)').run(a);
  allAddrs.add(a);
  return a;
}
const insRaw = db.prepare(`INSERT INTO balance_log (grin_address, event_type, amount, balance_before, balance_after, locked_before, locked_after, reference_type, reference_id, created_at)
                           VALUES (?, 'debit', ?, 1, 0.5, 0, 0, 'donation', 9, ?)`);
const insRolled = db.prepare(`INSERT INTO balance_log_daily (day, grin_address, event_type, reference_type, total_amount, event_count)
                              VALUES (?, ?, 'debit', 'donation', ?, ?)`);
// A raw donation at `t` (must be ≥ H to be visible — the rollup contract) or a rolled day.
const raw = (a, amt, t) => insRaw.run(a, amt, t);
const rolled = (a, amt, t, cnt = 1) => insRolled.run(day(t), a, amt, cnt);
function setInc(a, fields) {
  db.prepare('INSERT OR IGNORE INTO miner_incentives (grin_address) VALUES (?)').run(a);
  const keys = Object.keys(fields);
  if (!keys.length) return;
  db.prepare(`UPDATE miner_incentives SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE grin_address = ?`)
    .run(...keys.map((k) => fields[k]), a);
}
// A donor_requests row (design §18.4) — the one source of a card's name since §18 Part 3.
function req(a, f) {
  db.prepare(`INSERT INTO donor_requests (grin_address, kind, status, name, submitted_at, decided_at, reason)
              VALUES (?, 'name', ?, ?, ?, ?, ?)`)
    .run(a, f.status, f.name, f.submitted_at || NOW - 2 * 86400, f.decided_at || null, f.reason || null);
}
function reset() {
  db.exec('DELETE FROM donor_requests; DELETE FROM donor_blocks; DELETE FROM balance_log; DELETE FROM balance_log_daily; DELETE FROM miner_incentives; DELETE FROM miner_accounts;');
  allAddrs.clear();
}
const ds = (over = {}) => DN.donorSettings({
  donor_rank_window_days: 365, donor_loyalty_percent_per_month: 10, donor_loyalty_cap: 3,
  donor_name_expiry_months: 12, ...over
}, 'GRINIUM');
const wall = (opts = {}) => donorWall(db, { ds: ds(), now: NOW, H, active: true, mask, ...opts });

// Every string anywhere in the response, for the leakage sweeps.
function strings(v, out = []) {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => strings(x, out));
  else if (v && typeof v === 'object') Object.values(v).forEach((x) => strings(x, out));
  return out;
}
function keys(v, out = new Set()) {
  if (Array.isArray(v)) v.forEach((x) => keys(x, out));
  else if (v && typeof v === 'object') Object.entries(v).forEach(([k, x]) => { out.add(k); keys(x, out); });
  return out;
}

// ── mask is required ─────────────────────────────────────────────────────────────────────
{
  check('mask: donorWall THROWS without a mask function (fail closed, §J11-1)',
        throws(() => donorWall(db, { ds: ds(), now: NOW, H })) && throws(() => donorWall(db, { ds: ds(), now: NOW, H, mask: 'x' })));
}

// ── 102 donors → league 100, totals 102, Σ exact ─────────────────────────────────────────
{
  reset();
  let sum = 0;
  for (let i = 1; i <= 102; i++) {
    const a = seedAddr(i);
    const amt = round9(0.1 + i * 0.001234567);      // distinct, 9-dp amounts
    raw(a, amt, NOW - i * 3600);
    sum += amt;
  }
  const w = wall();
  check(`limits: 102 in-window donors → league ${LEAGUE_LIMIT}`, w.league.length === LEAGUE_LIMIT && LEAGUE_LIMIT === 100);
  check('limits: totals.donor_count counts every donor (102), not the cards', w.totals.donor_count === 102);
  check('limits: totals.total_donated is the exact lifetime Σ over every donor',
        w.totals.total_donated === round9(sum), `${w.totals.total_donated} vs ${round9(sum)}`);
  check('limits: ranks are 1..100 in order', w.league.every((c, i) => c.rank === i + 1));
  check('limits: league sorted by score DESC', w.league.every((c, i) => i === 0 || w.league[i - 1].score >= c.score));
  check('limits: past is empty and more = 0 when everyone is in the window', w.past.donors.length === 0 && w.past.more === 0);
  check('limits: the 101st and 102nd in-window donors are on neither list (design as written)',
        w.league.length + w.past.donors.length === 100);
  check('mask: every league address is masked and none equals a seeded full address',
        w.league.every((c) => MASK_RE.test(c.address) && !allAddrs.has(c.address)));
  check('shape: every card carries exactly the §18.7 fields (banner in, current_percent gone)',
        w.league.every((c) => Object.keys(c).sort().join(',') ===
          'active_months,address,banner,donation_count,first_donated_at,in_window_donated,last_donated_at,multiplier,name,name_state,pct_max,pct_min,rank,rigs_donating,rigs_online,score,total_donated'));
  check('shape: top level is league/past/totals/ranking (censored_display is gone, §18.6)',
        Object.keys(w).sort().join(',') === 'league,past,ranking,totals');
  check('shape: ranking echoes the five bounded settings (banner_slots default 5)',
        JSON.stringify(w.ranking) === JSON.stringify({ window_days: 365, loyalty_percent_per_month: 10, loyalty_cap: 3, name_expiry_months: 12, banner_slots: 5 }));
}

// ── window: drops a donor whose last debit is older; 0 = lifetime ────────────────────────
{
  reset();
  const fresh = seedAddr(1), stale = seedAddr(2), edge = seedAddr(3);
  raw(fresh, 1, NOW - 86400);
  rolled(stale, 5, NOW - 400 * 86400);             // 400 days back, rolled
  rolled(edge, 2, day(NOW) - 365 * 86400);         // rolled day whose midnight == cutoff at day(NOW)

  let w = wall();
  check('window: a donor whose last debit is 400 days old leaves the league…',
        !w.league.some((c) => c.address === mask(stale)));
  check('window: …and lands on the past strip with lifetime intact',
        w.past.donors.some((c) => c.address === mask(stale) && c.total_donated === 5 && c.in_window_donated === 0 && c.rank === null && c.score === 0));
  check('window: totals still count the past donor (lifetime is never pruned)',
        w.totals.donor_count === 3 && w.totals.total_donated === 8);
  w = wall({ ds: ds({ donor_rank_window_days: 0 }) });
  check('window 0 = lifetime: the stale donor is back in the league and in_window == lifetime',
        w.league.some((c) => c.address === mask(stale) && c.in_window_donated === 5) &&
        w.league.every((c) => c.in_window_donated === c.total_donated) && w.past.donors.length === 0);
  check('window 0: ranking.window_days is 0 (page prints "all-time")', w.ranking.window_days === 0);
  w = wall({ now: day(NOW) });
  check('window edge: a rolled day whose UTC midnight == cutoff is IN, whole',
        w.league.some((c) => c.address === mask(edge) && c.in_window_donated === 2));
  w = wall({ now: day(NOW) + 1 });
  check('window edge: one second later it is OUT, whole',
        w.past.donors.some((c) => c.address === mask(edge)));
}

// ── active months across rollup + raw; multiplier cap; score ─────────────────────────────
{
  reset();
  const a = seedAddr(1), b = seedAddr(2);
  // a: rolled days in two different months + raw rows in this month → 3 distinct months.
  rolled(a, 1, NOW - 100 * 86400);
  rolled(a, 1, NOW - 60 * 86400);
  raw(a, 0.5, NOW - 5 * 86400);
  raw(a, 0.5, NOW - 4 * 86400);
  // b: one rolled day per month for 30 months → months 30 → mult capped at ×3. Starts at
  // m = 1: a rolled row at day(NOW) is ≥ H and therefore INVISIBLE by the rollup contract
  // (rolled = day < H, raw = created_at ≥ H) — a fixture that put one there counted 29.
  for (let m = 1; m <= 30; m++) rolled(b, 0.01, NOW - m * 31 * 86400);
  const w = wall();
  const ca = w.league.find((c) => c.address === mask(a));
  const cb = w.league.find((c) => c.address === mask(b));
  check('months: distinct UTC months across rollup + raw (a: 3)', ca && ca.active_months === 3, ca && String(ca.active_months));
  check('months: multiplier 1 + 0.1 × 3 = ×1.3', ca && ca.multiplier === 1.3);
  check('score: in-window × multiplier (a: 1.5 or 3 × 1.3)',
        ca && ca.score === round9(ca.in_window_donated * 1.3));
  check('cap: 30 months → multiplier held at the ×3 cap', cb && cb.active_months === 30 && cb.multiplier === 3);
  check('cap: a lower cap setting is honoured', (() => {
    const w2 = wall({ ds: ds({ donor_loyalty_cap: 1.5 }) });
    const c = w2.league.find((c) => c.address === mask(b));
    return c && c.multiplier === 1.5 && w2.ranking.loyalty_cap === 1.5;
  })());
  check('loyalty 0 %: every multiplier is ×1 and score == in-window', (() => {
    const w2 = wall({ ds: ds({ donor_loyalty_percent_per_month: 0 }) });
    return w2.league.every((c) => c.multiplier === 1 && c.score === c.in_window_donated);
  })());
}

// ── tie order: score DESC, months DESC, first_donated_at ASC ─────────────────────────────
{
  reset();
  // Three donors with identical in-window amounts and identical months → the third key.
  const early = seedAddr(1), late = seedAddr(2), more = seedAddr(3);
  raw(early, 1, NOW - 10 * 86400); rolled(early, 0.5, NOW - 200 * 86400);   // first = 200 d ago, months 2
  raw(late, 1, NOW - 10 * 86400);  rolled(late, 0.5, NOW - 100 * 86400);    // first = 100 d ago, months 2
  raw(more, 1, NOW - 10 * 86400);  rolled(more, 0.25, NOW - 100 * 86400); rolled(more, 0.25, NOW - 200 * 86400); // months 3
  const w = wall({ ds: ds({ donor_loyalty_percent_per_month: 0 }) });   // flat multiplier → equal scores
  check('ties: all three scores equal under a 0 % loyalty', new Set(w.league.map((c) => c.score)).size === 1);
  check('ties: more months first, then the earlier first donation',
        w.league.map((c) => c.address).join(' ') === [more, early, late].map(mask).join(' '),
        w.league.map((c) => c.address).join(' '));
}

// ── past strip: order + more ─────────────────────────────────────────────────────────────
{
  reset();
  const live = seedAddr(1);
  raw(live, 1, NOW - 3600);
  const pastAddrs = [];
  for (let i = 2; i <= 26; i++) {                  // 25 past donors, distinct last days
    const a = seedAddr(i);
    rolled(a, i * 0.1, NOW - (365 + i) * 86400);
    pastAddrs.push(a);
  }
  const w = wall();
  check(`past: strip capped at ${PAST_LIMIT} with more = 5`, w.past.donors.length === PAST_LIMIT && PAST_LIMIT === 20 && w.past.more === 5);
  check('past: newest last donation first', w.past.donors.every((c, i) => i === 0 || w.past.donors[i - 1].last_donated_at >= c.last_donated_at));
  check('past: the first row is the most recent past donor (i=2)', w.past.donors[0].address === mask(pastAddrs[0]));
  check('past: every past address is masked', w.past.donors.every((c) => MASK_RE.test(c.address) && !allAddrs.has(c.address)));
  check('past: never includes a league member', !w.past.donors.some((c) => w.league.some((l) => l.address === c.address)));
  check('past: totals count league + past + overflow (26)', w.totals.donor_count === 26);
  check('past: a same-day tie breaks on lifetime DESC then address ASC', (() => {
    reset();
    const t = NOW - 400 * 86400;
    const x = seedAddr(5), y = seedAddr(4), z = seedAddr(6);
    rolled(x, 1, t); rolled(y, 2, t); rolled(z, 1, t);
    const p = wall().past.donors.map((c) => c.address);
    return p.join(' ') === [y, x, z].sort((a, b) => (a === y ? -1 : b === y ? 1 : a < b ? -1 : 1)).map(mask).join(' ');
  })());
}

// ── empty league + non-empty past (the page's third empty state) ─────────────────────────
{
  reset();
  const a = seedAddr(1);
  rolled(a, 3, NOW - 500 * 86400);
  const w = wall();
  check('states: empty league, one past donor, totals 1 / 3',
        w.league.length === 0 && w.past.donors.length === 1 && w.past.more === 0 && w.totals.donor_count === 1 && w.totals.total_donated === 3);
  check('states: no donors at all → every list empty, totals zero', (() => {
    reset();
    const w2 = wall();
    return w2.league.length === 0 && w2.past.donors.length === 0 && w2.totals.donor_count === 0 && w2.totals.total_donated === 0;
  })());
}

// ── names: approved-only (design §18.7, since §18 Part 3) ────────────────────────────────
// A card's name is the APPROVED, unexpired donor_requests name (publicProfiles). Pending,
// rejected, withdrawn and removed rows never reach a card, and the v1 donor_name column on
// miner_incentives is not read at all — v1 names were never reviewed.
{
  reset();
  const shown = seedAddr(1), noname = seedAddr(2), pend = seedAddr(3), rej = seedAddr(4), v1 = seedAddr(5),
        rem = seedAddr(6), old = seedAddr(7);
  for (const a of [shown, noname, pend, rej, v1, rem]) raw(a, 1, NOW - 3600);
  req(shown, { name: 'Acme Inc.', status: 'approved', decided_at: NOW - 86400 });
  setInc(shown, { donation_percent: 10 });
  setInc(noname, { donation_percent: 5 });
  req(pend, { name: 'Pending Secret', status: 'pending' });
  req(rej, { name: 'Rejected Rude', status: 'rejected', decided_at: NOW - 100, reason: 'reason-text-for-the-donor' });
  setInc(v1, { donor_name: 'v1brand', donor_name_set_at: NOW - 86400 });                // v1 capture, never reviewed
  req(rem, { name: 'Taken Down', status: 'removed', decided_at: NOW - 100, reason: 'removed-reason' });
  // old: approved 400 days ago, last debit a rolled day 200 days ago (in window) — expiry counts
  // from the LATER of the two, so 12 months have not passed yet.
  rolled(old, 1, NOW - 200 * 86400);
  req(old, { name: 'Veteran', status: 'approved', decided_at: NOW - 400 * 86400 });

  let w = wall();
  const byAddr = (arr, a) => arr.find((c) => c.address === mask(a));
  const cs = byAddr(w.league, shown), cn = byAddr(w.league, noname), cp = byAddr(w.league, pend),
        cr = byAddr(w.league, rej), cv = byAddr(w.league, v1), cm = byAddr(w.league, rem), co = byAddr(w.league, old);
  check('names: approved → the name AS TYPED (case kept) + shown', cs && cs.name === 'Acme Inc.' && cs.name_state === 'shown');
  check('names: no request at all → null + masked', cn && cn.name === null && cn.name_state === 'masked');
  check('names: a PENDING name never reaches a card', cp && cp.name === null && cp.name_state === 'masked');
  check('names: a REJECTED name never reaches a card', cr && cr.name === null && cr.name_state === 'masked');
  check('names: a REMOVED name never reaches a card', cm && cm.name === null && cm.name_state === 'masked');
  check('names: a v1 donor_name on miner_incentives is NOT read (pre-moderation starts clean)', cv && cv.name === null && cv.name_state === 'masked');
  check('names: approved 400 d ago, last debit 200 d ago, 12-month expiry → shown (ref = the later)', co && co.name === 'Veteran' && co.name_state === 'shown');
  check('names: the dead v1 donation_percent column never reaches a card (10 / 5 stored, no live rig → pct 0)',
        cn.pct_max === 0 && cs.pct_max === 0 && cs.rigs_donating === 0);

  // Expiry: move the clock 200 days on — now 13+ months after the later of debit and approval.
  w = wall({ now: NOW + 200 * 86400, ds: ds({ donor_rank_window_days: 0 }) });
  const eo = byAddr(w.league, old);
  check('expired: 12 months after the later of last debit and approval the name is null + expired', eo && eo.name === null && eo.name_state === 'expired');
  check('expired: expiry 0 = never', (() => {
    const w2 = wall({ now: NOW + 200 * 86400, ds: ds({ donor_rank_window_days: 0, donor_name_expiry_months: 0 }) });
    const c = byAddr(w2.league, old);
    return c && c.name === 'Veteran' && c.name_state === 'shown';
  })());

  // Leakage sweep with every non-approved state present.
  w = wall();
  const ks = keys(w);
  check('leak: no key named donor_* (but totals.donor_count), reason, decided_by, image or grin_address anywhere in the response',
        ![...ks].some((k) => /^donor_(?!count$)|^reason$|decided_by|^image$|grin_address/.test(k)), [...ks].join(','));
  check('leak: no full address string anywhere in the response',
        !strings(w).some((s) => allAddrs.has(s) || /^grin1[a-z0-9]{40,}$/.test(s)));
  check('leak: no pending / rejected / removed name and no reason text anywhere',
        !strings(w).some((s) => /Pending Secret|Rejected Rude|Taken Down|reason-text|removed-reason|v1brand/.test(s)));
  check('leak: no censored_display key — the setting is gone (§18.6)', !('censored_display' in w));
}

// ── liveDonations(): per-rig, mining sessions only, distinct names (§18.3) ──────────────
{
  const A = mkAddr(1), B = mkAddr(2), C = mkAddr(3), X = mkAddr(4);
  const sess = (a, w, acc = 5) => ({ grinAddress: a, workerName: w, acceptedShares: acc });
  const m = liveDonations([
    sess(A, 'rig01-donate10'), sess(A, 'rig02'), sess(A, 'rig03-donate20'),
    sess(A, 'rig01-donate10'),                                  // the same rig reconnecting
    sess(B, 'donate0'), sess(B, 'rig-donate101'),               // 0 % tag + an out-of-range typo
    sess(C, 'donate5', 0),                                      // login only, no accepted share
    sess(X, null), { grinAddress: '', workerName: 'donate50', acceptedShares: 9 }, null
  ]);
  const a = m.get(A), b = m.get(B);
  check('live: distinct worker names — a reconnecting rig counts once (3 online, 2 donating)',
        a.rigs_online === 3 && a.rigs_donating === 2);
  check('live: pct range over the DONATING rigs only (10–20), untagged rig ignored',
        a.pct_min === 10 && a.pct_max === 20);
  check('live: donating_workers names each tagged rig with its own %, sorted',
        JSON.stringify(a.donating_workers) === JSON.stringify([{ name: 'rig01-donate10', percent: 10 }, { name: 'rig03-donate20', percent: 20 }]));
  check('live: donate0 and donate101 are online but NOT donating; pct 0',
        b.rigs_online === 2 && b.rigs_donating === 0 && b.pct_min === 0 && b.pct_max === 0 && b.donating_workers.length === 0);
  check('live: a session with no accepted share is not counted at all (§J6-9)', !m.has(C));
  check('live: a null worker name counts as the "default" rig; a blank address and a null session are skipped',
        m.get(X) && m.get(X).rigs_online === 1 && m.get(X).rigs_donating === 0 && !m.has('') && m.size === 3);
  check('live: no sessions / junk input → empty Map, never a throw',
        liveDonations().size === 0 && liveDonations(null).size === 0 && liveDonations([]).size === 0);
  check('live: the parser is the money path’s (MyBrand folded at login → donate10 reads 10)',
        liveDonations([sess(A, 'mybrand-donate10')]).get(A).pct_max === 10);
}

// ── the wall reads `live`: rigs_* / pct_* / active_donors, gated ──────────────────────────
{
  reset();
  const a = seedAddr(1), b = seedAddr(2), c = seedAddr(3);
  raw(a, 1, NOW - 3600); raw(b, 2, NOW - 3600);            // c: tagged live, no debit yet
  const sess = (ad, w) => ({ grinAddress: ad, workerName: w, acceptedShares: 3 });
  const live = liveDonations([
    sess(a, 'r1-donate5'), sess(a, 'r2-donate20'), sess(a, 'r3'),
    sess(b, 'rig01'),
    sess(c, 'donate10')
  ]);
  let w = wall({ live });
  const ca = w.league.find((x) => x.address === mask(a)), cb = w.league.find((x) => x.address === mask(b));
  check('wall: mixed tags → rigs_donating 2 of rigs_online 3, pct 5–20',
        ca.rigs_online === 3 && ca.rigs_donating === 2 && ca.pct_min === 5 && ca.pct_max === 20);
  check('wall: an untagged address reads paused (0 donating, 0 %) with its rig still online',
        cb.rigs_online === 1 && cb.rigs_donating === 0 && cb.pct_min === 0 && cb.pct_max === 0);
  check('wall: active_donors = addresses with a donating rig NOW, incl. one with no card yet (a, c)',
        w.totals.active_donors === 2 && w.totals.donor_count === 2);
  check('wall: order is by score, not rigs (b leads with 2 GRIN and fewer rigs)', w.league[0].address === mask(b));
  // The column is dead: set it to 100 on b and nothing changes.
  setInc(b, { donation_percent: 100 });
  w = wall({ live });
  check('wall: miner_incentives.donation_percent = 100 is ignored (b still 0 %)',
        w.league.find((x) => x.address === mask(b)).pct_max === 0 && w.totals.active_donors === 2);
  w = wall({ live, active: false });
  check('switch OFF: rigs_donating / pct_* / active_donors all 0, rigs_online kept',
        w.totals.active_donors === 0 &&
        w.league.every((x) => x.rigs_donating === 0 && x.pct_min === 0 && x.pct_max === 0) &&
        w.league.find((x) => x.address === mask(a)).rigs_online === 3);
  check('switch not a boolean true → treated as OFF', wall({ live, active: 'true' }).totals.active_donors === 0);
  check('wall: no `live` at all → every reading 0, not a throw',
        wall().league.every((x) => x.rigs_online === 0 && x.rigs_donating === 0) && wall().totals.active_donors === 0);
  check('wall: junk readings in `live` are bounded (NaN → 0, 250 % → 100, 2.7 rigs → 2)', (() => {
    const junk = new Map([[a, { rigs_online: 2.7, rigs_donating: NaN, pct_min: 5, pct_max: 5 }],
                          [b, { rigs_online: -1, rigs_donating: 1, pct_min: -3, pct_max: 250 }]]);
    const j = wall({ live: junk });
    const ja = j.league.find((x) => x.address === mask(a)), jb = j.league.find((x) => x.address === mask(b));
    return ja.rigs_online === 2 && ja.rigs_donating === 0 && ja.pct_max === 0 &&
           jb.rigs_online === 0 && jb.rigs_donating === 1 && jb.pct_min === 0 && jb.pct_max === 100;
  })());
}

// ── banners: the Top-N slot rule (design §18.7, §18 Part 4) ─────────────────────────────
// `banner` is { url, width, height } only on a LEAGUE card with rank ≤ donor_banner_slots and
// an approved, unexpired banner; null everywhere else, and always null on the past strip.
{
  reset();
  let seq = 0;
  const hex16 = () => (++seq).toString(16).padStart(16, '0');
  function banner(a, f = {}) {
    const file = f.file !== undefined ? f.file : `${hex16()}.png`;
    db.prepare(`INSERT INTO donor_requests (grin_address, kind, status, file, mime, width, height, bytes, submitted_at, decided_at, reason, image)
                VALUES (?, 'banner', ?, ?, 'image/png', ?, ?, 1000, ?, ?, ?, ?)`)
      .run(a, f.status || 'approved', file, f.width === undefined ? 800 : f.width, f.height === undefined ? 200 : f.height,
           NOW - 2 * 86400, f.status === 'pending' ? null : (f.decided_at || NOW - 86400), f.reason || null,
           f.status === 'pending' ? Buffer.from('pending-bytes') : null);
    return file;
  }
  // Seven in-window donors with strictly falling amounts → ranks 1..7 in address order, and
  // one past donor. Every one of them has an approved banner.
  const L = [];
  for (let i = 1; i <= 7; i++) { const a = seedAddr(i); raw(a, 10 - i, NOW - 3600); L.push(a); }
  const past = seedAddr(50);
  rolled(past, 5, NOW - 500 * 86400);
  const files = L.map((a) => banner(a));
  banner(past);
  const rankOf = (w, a) => w.league.find((c) => c.address === mask(a));

  let w = wall();
  check('banner: ranks come out 1..7 in the seeded order (fixture sanity)', L.every((a, i) => rankOf(w, a).rank === i + 1));
  check('banner: default 5 slots → ranks 1..5 carry { url, width, height }',
        L.slice(0, 5).every((a, i) => JSON.stringify(rankOf(w, a).banner) ===
          JSON.stringify({ url: `/uploads/donors/${files[i]}`, width: 800, height: 200 })));
  check('banner: rank 6 and 7 (N+1 and beyond) → null, though approved', rankOf(w, L[5]).banner === null && rankOf(w, L[6]).banner === null);
  check('banner: the past strip never carries one (approved and unexpired, still null)',
        w.past.donors.length === 1 && w.past.donors[0].banner === null);
  check('banner: ranking.banner_slots tells the page N', w.ranking.banner_slots === 5);

  w = wall({ ds: ds({ donor_banner_slots: 1 }) });
  check('banner: slots = 1 → rank 1 only', rankOf(w, L[0]).banner !== null && rankOf(w, L[1]).banner === null && w.ranking.banner_slots === 1);
  w = wall({ ds: ds({ donor_banner_slots: 7 }) });
  check('banner: slots = 7 → the boundary card (rank 7) has it', rankOf(w, L[6]).banner !== null);
  w = wall({ ds: ds({ donor_banner_slots: 0 }) });
  check('banner: slots = 0 → banners off: no card anywhere carries one', w.league.concat(w.past.donors).every((c) => c.banner === null) && w.ranking.banner_slots === 0);
  w = wall({ ds: ds({ donor_banner_slots: 99 }) });
  check('banner: slots 99 is bounded to the default (donorSettings 0–10), never "everyone"',
        w.ranking.banner_slots === 5 && rankOf(w, L[5]).banner === null);
  w = donorWall(db, { ds: { rankWindowDays: 365, bannerSlots: 'abc' }, now: NOW, H, active: true, mask });
  check('banner: a raw ds with junk bannerSlots → 5, not NaN (every comparison false = no banners at all)',
        w.ranking.banner_slots === 5 && rankOf(w, L[0]).banner !== null && rankOf(w, L[5]).banner === null);

  // What may NOT become a banner, each on a top-3 card.
  db.exec("DELETE FROM donor_requests");
  banner(L[0], { status: 'pending' });                          // pending: bytes in the DB, never public
  banner(L[1], { status: 'rejected', reason: 'banner-reject-reason' });
  banner(L[2], { file: '../../etc/passwd' });                   // approved row, file not the server's shape
  banner(L[3], { width: 0 });                                   // approved, dims junk
  banner(L[4], { status: 'removed', reason: 'banner-removed-reason' });
  w = wall();
  check('banner: pending / rejected / removed / bad file / zero width → null on a top-5 card',
        L.slice(0, 5).every((a) => rankOf(w, a).banner === null));
  check('banner: no pending bytes, reason, or path of a non-approved banner anywhere in the response',
        !strings(w).some((s) => /pending-bytes|banner-reject-reason|banner-removed-reason|passwd|\/uploads\//.test(s)));

  // Expiry hides an approved banner the same way it hides a name (§18.1 #9).
  db.exec("DELETE FROM donor_requests");
  const f0 = banner(L[0], { decided_at: NOW - 400 * 86400 });
  w = wall({ now: NOW + 400 * 86400, ds: ds({ donor_rank_window_days: 0 }) });
  check('banner: 12 months past the later of last debit and approval → null', rankOf(w, L[0]).banner === null);
  w = wall({ now: NOW + 400 * 86400, ds: ds({ donor_rank_window_days: 0, donor_name_expiry_months: 0 }) });
  check('banner: expiry 0 = never', rankOf(w, L[0]).banner && rankOf(w, L[0]).banner.url === `/uploads/donors/${f0}`);
}

// ── settings traps: blank / junk / Infinity never reach a score ──────────────────────────
{
  reset();
  const a = seedAddr(1);
  raw(a, 1, NOW - 3600); rolled(a, 1, NOW - 100 * 86400);
  const junk = DN.donorSettings({
    donor_rank_window_days: '', donor_loyalty_percent_per_month: 'abc', donor_loyalty_cap: 'Infinity',
    donor_name_expiry_months: '-5'
  }, 'GRINIUM');
  const w = wall({ ds: junk });
  const c = w.league[0];
  check('traps: blank/junk settings resolve to the documented defaults',
        w.ranking.window_days === 365 && w.ranking.loyalty_percent_per_month === 10 && w.ranking.loyalty_cap === 3 && w.ranking.name_expiry_months === 12);
  check('traps: score and multiplier are finite numbers', Number.isFinite(c.score) && Number.isFinite(c.multiplier) && c.multiplier === 1.2);
  check('traps: no ds at all → defaults, not a throw', (() => {
    const w2 = donorWall(db, { now: NOW, H, active: true, mask });
    return w2.ranking.window_days === 365 && w2.ranking.name_expiry_months === 12;
  })());
  check('traps: a raw settings object passed as ds (not donorSettings) still cannot NaN the score', (() => {
    const w2 = donorWall(db, { ds: { rankWindowDays: 'abc', loyaltyPercentPerMonth: NaN, loyaltyCap: -1 }, now: NOW, H, active: true, mask });
    return w2.league.every((x) => Number.isFinite(x.score) && Number.isFinite(x.multiplier));
  })());
  check('traps: JSON round trip has no null-from-Infinity in any number', (() => {
    const j = JSON.parse(JSON.stringify(w));
    const nums = [];
    const walk = (v) => { if (typeof v === 'number') nums.push(v); else if (v && typeof v === 'object') Object.values(v).forEach(walk); };
    walk(j);
    return nums.every(Number.isFinite);
  })());
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
