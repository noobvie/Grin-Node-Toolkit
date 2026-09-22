'use strict';

// Donor league (design §16.6/§16.7, Part 4) — the public /api/pool/donors v2 response built by
// lib/donor-ledger.js donorWall() against an in-memory copy of the real schema. index.js starts
// a server on require, so the route itself is only ever read as text (test-public-leakage.js);
// everything the route hands the lib — switch state, live rigs, the mask — is passed here as
// fixtures. Covers: the 100/20 limits with totals over every donor and an exact Σ; the window
// dropping a donor whose last debit is older (and 0 = lifetime); active months across rollup +
// raw; the multiplier cap; tie order; past-strip order + `more`; expired → masked; censored +
// marker → the string and censored + masked → null; league/past disjoint; the mask being
// REQUIRED and applied to both arrays; blank/junk settings never reaching a score; the
// donations switch zeroing current_percent; rigs_online from a Map or a function.
// Run: node scripts/test-donor-league.js   (no server, no file on disk)

const path = require('path');
const APP = path.resolve(__dirname, '..');

const { initDb, getDb } = require(path.join(APP, 'lib/db.js'));
initDb(':memory:');
const db = getDb();

const DN = require(path.join(APP, 'lib/donor-names.js'));
const DL = require(path.join(APP, 'lib/donor-ledger.js'));
const { donorWall, LEAGUE_LIMIT, PAST_LIMIT } = DL;

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
function reset() {
  db.exec('DELETE FROM balance_log; DELETE FROM balance_log_daily; DELETE FROM miner_incentives; DELETE FROM miner_accounts;');
  allAddrs.clear();
}
const ds = (over = {}) => DN.donorSettings({
  donor_rank_window_days: 365, donor_loyalty_percent_per_month: 10, donor_loyalty_cap: 3,
  donor_name_expiry_months: 12, donor_censored_display: 'masked', ...over
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
  check('shape: every card carries exactly the §16.7 fields',
        w.league.every((c) => Object.keys(c).sort().join(',') ===
          'active_months,address,current_percent,donation_count,first_donated_at,in_window_donated,last_donated_at,multiplier,name,name_state,rank,rigs_online,score,total_donated'));
  check('shape: top level is league/past/totals/ranking/censored_display',
        Object.keys(w).sort().join(',') === 'censored_display,league,past,ranking,totals');
  check('shape: ranking echoes the four bounded settings',
        JSON.stringify(w.ranking) === JSON.stringify({ window_days: 365, loyalty_percent_per_month: 10, loyalty_cap: 3, name_expiry_months: 12 }));
  check('shape: censored_display echoes the setting', w.censored_display === 'masked');
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

// ── names: shown / masked / censored (marker + masked) / expired ─────────────────────────
{
  reset();
  const shown = seedAddr(1), noname = seedAddr(2), auto = seedAddr(3), adm = seedAddr(4), allow = seedAddr(5), old = seedAddr(6);
  for (const a of [shown, noname, auto, adm, allow]) raw(a, 1, NOW - 3600);
  setInc(shown, { donor_name: 'acme', donor_name_set_at: NOW - 86400, donation_percent: 10 });
  setInc(noname, { donation_percent: 5 });
  setInc(auto, { donor_name: 'sh1thead', donor_name_set_at: NOW - 86400, donor_censor: 'auto', donor_censor_word: 'shit', donor_censor_at: NOW - 86400 });
  setInc(adm, { donor_name: 'spam', donor_name_set_at: NOW - 86400, donor_censor: 'admin', donor_censor_at: NOW - 86400, donor_censor_by: 1 });
  setInc(allow, { donor_name: 'classic', donor_name_set_at: NOW - 86400, donor_censor: 'allow' });
  // old: name set 2 years ago, last debit 14 months ago (rolled) → in window (365 d? no: 14 months
  // ≈ 425 d → past) — use a raw debit 13 months ago is below H; so give it a rolled 200-day-old
  // debit (in window) and a set_at 13 months back: expiry counts from the LATER of the two.
  rolled(old, 1, NOW - 200 * 86400);
  setInc(old, { donor_name: 'veteran', donor_name_set_at: NOW - 400 * 86400 });

  let w = wall();
  const byAddr = (arr, a) => arr.find((c) => c.address === mask(a));
  const cs = byAddr(w.league, shown), cn = byAddr(w.league, noname), ca = byAddr(w.league, auto),
        cd = byAddr(w.league, adm), cl = byAddr(w.league, allow), co = byAddr(w.league, old);
  check('names: shown → name + name_state shown', cs && cs.name === 'acme' && cs.name_state === 'shown');
  check('names: no name → null + masked', cn && cn.name === null && cn.name_state === 'masked');
  check('names: auto-censored + masked display → null + censored', ca && ca.name === null && ca.name_state === 'censored');
  check('names: admin-censored + masked display → null + censored', cd && cd.name === null && cd.name_state === 'censored');
  check('names: allow override → shown even though the list would match', cl && cl.name === 'classic' && cl.name_state === 'shown');
  check('names: 200-day-old debit with a 12-month expiry → shown (ref = later of debit and set_at)', co && co.name_state === 'shown');
  check('names: current_percent from the row when donations are active', cs.current_percent === 10 && cn.current_percent === 5 && ca.current_percent === 0);

  w = wall({ ds: ds({ donor_censored_display: 'marker' }) });
  const ma = byAddr(w.league, auto), md = byAddr(w.league, adm), ms = byAddr(w.league, shown);
  check('marker: censored cards carry the literal string in `name`', ma && ma.name === DN.CENSORED_MARKER && md && md.name === DN.CENSORED_MARKER && ma.name_state === 'censored');
  check('marker: a shown name is unaffected by the display setting', ms && ms.name === 'acme');
  check('marker: censored_display echoes marker', w.censored_display === 'marker');
  check('marker: the string appears in NO field but `name`', (() => {
    const hits = [];
    const walk = (v, k) => {
      if (typeof v === 'string' && v === DN.CENSORED_MARKER && k !== 'name') hits.push(k);
      else if (Array.isArray(v)) v.forEach((x) => walk(x, k));
      else if (v && typeof v === 'object') Object.entries(v).forEach(([kk, x]) => walk(x, kk));
    };
    walk(w, '');
    return hits.length === 0;
  })());

  // Expiry: move the clock 13 months past the later of debit and set_at.
  w = wall({ now: NOW + 200 * 86400, ds: ds({ donor_rank_window_days: 0 }) });
  const eo = byAddr(w.league, old);
  check('expired: 12 months after the last debit the name is null + expired', eo && eo.name === null && eo.name_state === 'expired');
  check('expired: expiry 0 = never', (() => {
    const w2 = wall({ now: NOW + 200 * 86400, ds: ds({ donor_rank_window_days: 0, donor_name_expiry_months: 0 }) });
    const c = byAddr(w2.league, old);
    return c && c.name === 'veteran' && c.name_state === 'shown';
  })());

  // Leakage sweep on the masked-mode response with censored rows present.
  w = wall();
  const ks = keys(w);
  check('leak: no key named donor_censor*, donor_name_set_at or grin_address anywhere in the response',
        ![...ks].some((k) => /^donor_censor|donor_name_set_at|grin_address/.test(k)), [...ks].join(','));
  check('leak: no full address string anywhere in the response',
        !strings(w).some((s) => allAddrs.has(s) || /^grin1[a-z0-9]{40,}$/.test(s)));
  check('leak: the censor word never appears anywhere', !strings(w).some((s) => /shit/.test(s)));
  check('leak: the marker never appears under masked display', !strings(w).includes(DN.CENSORED_MARKER));
}

// ── donations switch: current_percent + active_donors gated ──────────────────────────────
{
  reset();
  const a = seedAddr(1), b = seedAddr(2);
  raw(a, 1, NOW - 3600);
  setInc(a, { donation_percent: 10 });
  setInc(b, { donation_percent: 5 });                    // live tag, no debit yet
  let w = wall({ active: true });
  check('switch ON: active_donors counts LIVE tags (2), including one with no card', w.totals.active_donors === 2 && w.totals.donor_count === 1);
  check('switch ON: current_percent on the card', w.league[0].current_percent === 10);
  w = wall({ active: false });
  check('switch OFF: active_donors 0 and every current_percent 0', w.totals.active_donors === 0 && w.league.every((c) => c.current_percent === 0));
  check('switch not a boolean true → treated as OFF', wall({ active: 'true' }).totals.active_donors === 0);
}

// ── rigs_online: display only, from a Map or a function, never ranked ────────────────────
{
  reset();
  const a = seedAddr(1), b = seedAddr(2);
  raw(a, 1, NOW - 3600); raw(b, 2, NOW - 3600);
  let w = wall({ rigsOnline: new Map([[a, 3]]) });
  const ca = w.league.find((c) => c.address === mask(a)), cb = w.league.find((c) => c.address === mask(b));
  check('rigs: Map lookup → 3, missing → 0', ca.rigs_online === 3 && cb.rigs_online === 0);
  w = wall({ rigsOnline: (addr) => (addr === b ? 2.7 : NaN) });
  check('rigs: function lookup, floored, NaN → 0', w.league.find((c) => c.address === mask(b)).rigs_online === 2 && w.league.find((c) => c.address === mask(a)).rigs_online === 0);
  check('rigs: order is by score, not rigs (b leads with 2 GRIN and fewer rigs)', w.league[0].address === mask(b));
  check('rigs: no rigsOnline at all → 0', wall().league.every((c) => c.rigs_online === 0));
}

// ── settings traps: blank / junk / Infinity never reach a score ──────────────────────────
{
  reset();
  const a = seedAddr(1);
  raw(a, 1, NOW - 3600); rolled(a, 1, NOW - 100 * 86400);
  const junk = DN.donorSettings({
    donor_rank_window_days: '', donor_loyalty_percent_per_month: 'abc', donor_loyalty_cap: 'Infinity',
    donor_name_expiry_months: '-5', donor_censored_display: 'MARKER '
  }, 'GRINIUM');
  const w = wall({ ds: junk });
  const c = w.league[0];
  check('traps: blank/junk settings resolve to the documented defaults',
        w.ranking.window_days === 365 && w.ranking.loyalty_percent_per_month === 10 && w.ranking.loyalty_cap === 3 && w.ranking.name_expiry_months === 12);
  check('traps: score and multiplier are finite numbers', Number.isFinite(c.score) && Number.isFinite(c.multiplier) && c.multiplier === 1.2);
  check('traps: enum is closed but case/space tolerant (MARKER → marker)', w.censored_display === 'marker');
  check('traps: no ds at all → defaults, not a throw', (() => {
    const w2 = donorWall(db, { now: NOW, H, active: true, mask });
    return w2.ranking.window_days === 365 && w2.censored_display === 'masked';
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
