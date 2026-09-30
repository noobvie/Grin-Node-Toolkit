'use strict';

// Donor-name words + donor settings (design §16, reduced by §18 Part 3) against an in-memory
// copy of the real schema: normalisation + leet (now also stripping the §18.5 name separators),
// the fixed reserved words, the operator's flag-word list (never a RegExp), the documented
// Scunthorpe false positive, the review-queue flags (reserved / flag word / same as an approved
// donor), the bounded settings readers + validators, and the migration running twice. v1's
// capture, rescan, displayState, censor/un-censor and new-names count were DELETED in §18
// Part 3 (names are pre-moderated), and their arms with them — the "removed" block below pins
// that they stay gone. Kept from the v1 admin part: the donate-token parser the admin list
// marks rigs with, the per-address ledger aggregate + window boundary + active months, and the
// §16.6 score/order helpers.
// Run: node scripts/test-donor-names.js   (no server, no file on disk)

const path = require('path');
const APP = path.resolve(__dirname, '..');

const { initDb, getDb, createSchema, closeDb } = require(path.join(APP, 'lib/db.js'));
initDb(':memory:');
const db = getDb();

const DN = require(path.join(APP, 'lib/donor-names.js'));
const { lastDonatedAt, donorLedger, loyaltyMultiplier, donorScore, leagueOrder } = require(path.join(APP, 'lib/donor-ledger.js'));
const { parseDonateToken } = require(path.join(APP, 'lib/stratum-protocol.js'));
const PoolSettings = require(path.join(APP, 'lib/pool-settings.js'));

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else      { fail++; console.error(`  FAIL ${name}${extra ? ' — ' + extra : ''}`); }
}
const throws = (fn) => { try { fn(); return false; } catch (_) { return true; } };

const NOW = 1_800_000_000; // fixed clock for every dated assertion
const STARTER = DN.STARTER_BLOCKLIST.join('\n');
// One-name matcher over list TEXT (the lib takes the parsed list; tests read better with text).
const m = (name, listText, poolName) => DN.matchEntries(name, DN.parseList(listText), DN.poolNameEntry(poolName));

// A miner_accounts row is required by the FK; every address in this file goes through here.
const mkAddr = (i) => `grin1${String(i).padStart(58, 'q')}`;
function seedAddr(a) {
  db.prepare('INSERT OR IGNORE INTO miner_accounts (grin_address, balance) VALUES (?, 0)').run(a);
  return a;
}

// ── Migration ────────────────────────────────────────────────────────────────────────────
// The six v1 columns stay in the schema, UNREAD (§18.2/§18.6: dropping them is a later cleanup).
{
  const cols = () => new Set(db.prepare('PRAGMA table_info(miner_incentives)').all().map((c) => c.name));
  const want = ['donor_name', 'donor_name_set_at', 'donor_censor', 'donor_censor_word', 'donor_censor_at', 'donor_censor_by'];
  check('miner_incentives still carries the six v1 donor_* columns (unread)', want.every((c) => cols().has(c)));
  const before = cols().size;
  check('createSchema() runs a second time without error', !throws(() => createSchema()));
  check('… and adds nothing the second time', cols().size === before);
}

// ── normalise + leet ─────────────────────────────────────────────────────────────────────
{
  check('normalise lowercases and strips - and _', DN.normalise('My_Brand-X') === 'mybrandx');
  check('normalise maps the six leet digits', DN.normalise('a55-h0le') === 'asshole');
  check('normalise: 1337 → ieet', DN.normalise('1337') === 'ieet');
  check('normalise: digits outside the map survive', DN.normalise('rig2689') === 'rig2689');
  check('normalise: null/undefined → ""', DN.normalise(null) === '' && DN.normalise(undefined) === '');
  check('normalise: the §18.5 name separators (space . & \') are stripped too', DN.normalise("Acme & Co. 's") === 'acmecos');
  check('normalise: a spaced-out word reads as what it spells ("s h i t")', DN.normalise('s h i t') === 'shit');
}

// ── reserved words ───────────────────────────────────────────────────────────────────────
{
  check('reserved: "pool-admin" hits admin', m('pool-admin', '', '') === 'admin' || m('pool-admin', '', '') === 'pool');
  check('reserved: "grinium-rig" hits grinium', m('grinium-rig', '', '') === 'grinium');
  check('reserved: "0fficial" is caught through leet', m('0fficial', '', '') === 'official');
  check('reserved: pool name is applied (as typed in the badge)', m('zephyr-fan', '', 'Zephyr') === 'Zephyr');
  check('reserved: pool name is normalised on both sides', m('z3ph-yr', '', 'Zeph_Yr') === 'Zeph_Yr');
  check('reserved: a cased, spaced v2 name still hits ("The Grinium Team")', m('The Grinium Team', '', '') === 'grinium');
  check('reserved: fixed words outrank the pool name ("acmepool" hits pool first)', m('acmepool-fan', '', 'AcmePool') === 'pool');
  check('reserved: a 2-char pool name is NOT applied (would flag everyone)', m('cabbage', '', 'ab') === null);
  check('reserved: clean name → null', m('northern-hashworks', '', 'GRINIUM') === null);
  check('reserved: empty name → null', m('', STARTER, 'GRINIUM') === null);
}

// ── operator list (flag words) ───────────────────────────────────────────────────────────
{
  check('list: starter catches leet spelling ("sh1t-lord" → shit)', m('sh1t-lord', STARTER, '') === 'shit');
  check('list: entry returned as typed, matched normalised', m('mo0n-boy', 'Mo0n\n', '') === 'Mo0n');
  check('list: entries split on CRLF and trimmed, empties dropped', m('xyzzy', '\r\n  \r\n xyz \r\n', '') === 'xyz');
  check('list: separator-only entries are dropped, not matched', m('a-b', '-\n_\n--\n . ', '') === null);
  check('list: regex-special text never throws (not a RegExp)', !throws(() => m('acme', '(\n[\n*\n\\', '')) &&
        m('acme', '(\n[\n*\n\\', '') === null);
  check('list: parseList keeps order', DN.parseList('b\na').map((e) => e.entry).join(',') === 'b,a');
  // EXPECTED false positive — substring on the normalised name. Since §18 it costs nothing: a
  // hit is a flag in the review queue, and the admin approves the name anyway.
  check('Scunthorpe: "classic" is flagged by "ass" (EXPECTED false positive)', m('classic', STARTER, '') === 'ass');
  check('starter list has ~40+ entries and no blank lines', DN.STARTER_BLOCKLIST.length >= 40 && DN.STARTER_BLOCKLIST.every((w) => w.trim() === w && w !== ''));
}

// ── review-queue flags (design §18.6) ────────────────────────────────────────────────────
{
  const A = 'grin1aaa', B = 'grin1bbb', C = 'grin1ccc';
  const ctx = DN.nameFlagContext(STARTER, 'Zephyr', [{ address: A, name: 'ACME Inc.' }, { address: C, name: 'acme inc' }, { address: B, name: 'Other' }]);
  const types = (f) => f.map((x) => x.type).join(',');
  check('flags: a clean, unique name has no flags', DN.nameFlags('Northern Hashworks', B, ctx).length === 0);
  check('flags: reserved word → { type: reserved, word } (first in RESERVED order)', (() => {
    const f = DN.nameFlags('Pool Support', B, ctx);
    return types(f) === 'reserved' && f[0].word === 'support';
  })());
  check('flags: the pool name is reserved too', (() => {
    const f = DN.nameFlags('zephyr fans', B, ctx);
    return types(f) === 'reserved' && f[0].word === 'Zephyr';
  })());
  check('flags: a flag word → { type: word, word as typed in the list }', (() => {
    const f = DN.nameFlags('Sh1t Miner', B, ctx);
    return types(f) === 'word' && f[0].word === 'shit';
  })());
  check('flags: reserved AND a flag word both show, in that order', types(DN.nameFlags('Official Sh1t', B, ctx)) === 'reserved,word');
  check('flags: same as another approved donor (normalised — case, spaces, dots ignored)', (() => {
    const f = DN.nameFlags('Acme Inc', B, ctx);
    return types(f) === 'same_as_donor' && f[0].addresses.join(',') === [A, C].join(',');
  })());
  check('flags: the donor\'s OWN approved name is not an impersonation', (() => {
    const f = DN.nameFlags('acme inc.', A, ctx);
    return types(f) === 'same_as_donor' && f[0].addresses.join(',') === C;   // only the OTHER holder
  })());
  check('flags: an empty/none-alnum name returns [] (never throws)', DN.nameFlags('', B, ctx).length === 0 && DN.nameFlags(null, B, ctx).length === 0 &&
        DN.nameFlags('x', B, null).length === 0);
  check('flags: no approved names → no same_as_donor', DN.nameFlags('Acme Inc', B, DN.nameFlagContext('', '', [])).length === 0);
  check('flags: an empty flag list still applies the reserved words', types(DN.nameFlags('Grinium Official', B, DN.nameFlagContext('', '', []))) === 'reserved');
  // A 4000-entry list parsed ONCE per context — flagging 300 names must stay milliseconds.
  const big = Array.from({ length: 4000 }, (_, i) => `w0rd-${i.toString(36)}xx`).join('\n');
  const t0 = Date.now();
  const bigCtx = DN.nameFlagContext(big, 'GRINIUM', []);
  for (let i = 0; i < 300; i++) DN.nameFlags(`Donor Name ${i}`, B, bigCtx);
  check('flags: 300 names × a 4000-entry list in well under a second (parsed once)', Date.now() - t0 < 1000, `${Date.now() - t0} ms`);
}

// ── removed with v1 moderation (design §18 Part 3) ───────────────────────────────────────
{
  const gone = ['captureDonorName', 'rescanAll', 'adminCensor', 'countNewNames', 'NEW_NAME_DAYS', 'CENSORED_MARKER',
                'CENSORED_DISPLAY_VALUES', 'displayState', 'matchBlocklist'];
  check('removed: the v1 moderation API is no longer exported', gone.every((k) => !(k in DN)), gone.filter((k) => k in DN).join(','));
  check('removed: the lib no longer spells the censored marker or touches donor_censor',
        !/censored-donor|donor_censor|miner_incentives/.test(require('fs').readFileSync(path.join(APP, 'lib/donor-names.js'), 'utf8').replace(/\/\/[^\n]*/g, '')));
  check('removed: donorSettings no longer carries censoredDisplay', !('censoredDisplay' in DN.donorSettings({ donor_censored_display: 'marker' }, '')));
}

// ── donorSettings (bounded readers) ──────────────────────────────────────────────────────
{
  const d = DN.donorSettings({}, 'GRINIUM');
  check('settings: empty section → every default', d.rankWindowDays === 365 && d.bannerSlots === 5 &&
        d.loyaltyPercentPerMonth === 10 && d.loyaltyCap === 3 && d.nameExpiryMonths === 12 && d.listText === STARTER && d.poolName === 'GRINIUM');
  const junk = DN.donorSettings({
    donor_rank_window_days: 'abc', donor_loyalty_percent_per_month: Infinity,
    donor_loyalty_cap: 0.5, donor_name_expiry_months: -1, donor_name_blocklist: 42, donor_banner_slots: 11
  }, null);
  check('settings: "abc" / Infinity / -1 / cap<1 / slots 11 → defaults, never NaN', junk.rankWindowDays === 365 && junk.loyaltyPercentPerMonth === 10 &&
        junk.loyaltyCap === 3 && junk.nameExpiryMonths === 12 && junk.bannerSlots === 5);
  check('settings: non-string list → starter list; null pool name → ""', junk.listText === STARTER && junk.poolName === '');
  check('settings: stored strings parse ("30" → 30, "2.5" → 2.5)', DN.donorSettings({ donor_rank_window_days: '30', donor_loyalty_cap: '2.5' }).rankWindowDays === 30 &&
        DN.donorSettings({ donor_loyalty_cap: '2.5' }).loyaltyCap === 2.5);
  check('settings: window 0 (lifetime), expiry 0 (never) and slots 0 (banners off) are kept, not defaulted',
        DN.donorSettings({ donor_rank_window_days: 0, donor_name_expiry_months: 0 }).rankWindowDays === 0 &&
        DN.donorSettings({ donor_name_expiry_months: 0 }).nameExpiryMonths === 0 && DN.donorSettings({ donor_banner_slots: '0' }).bannerSlots === 0);
  check('settings: empty stored list is an empty list, not the starter', DN.donorSettings({ donor_name_blocklist: '' }).listText === '');

  // Write-side validators (pool-settings.js incentives block).
  const V = PoolSettings.validators.incentives;
  check('validator: the six donor keys exist in defaults + validators', ['donor_name_blocklist', 'donor_rank_window_days',
        'donor_loyalty_percent_per_month', 'donor_loyalty_cap', 'donor_name_expiry_months', 'donor_banner_slots'].every((k) =>
        Object.prototype.hasOwnProperty.call(PoolSettings.defaults.incentives, k) && typeof V[k] === 'function'));
  check('validator: donor_censored_display is gone from defaults AND validators (§18.6)',
        !('donor_censored_display' in PoolSettings.defaults.incentives) && !('donor_censored_display' in V));
  check('validator: default blocklist IS the starter list', PoolSettings.defaults.incentives.donor_name_blocklist === STARTER);
  check('validator: blocklist trims, drops empties, normalises CRLF', V.donor_name_blocklist(' a \r\n\r\n b\n') === 'a\nb');
  check('validator: blocklist size-capped', throws(() => V.donor_name_blocklist('x'.repeat(70000))) && throws(() => V.donor_name_blocklist(Array(4001).fill('w').join('\n'))));
  check('validator: window 0-3650 int', V.donor_rank_window_days('0') === 0 && throws(() => V.donor_rank_window_days(-1)) && throws(() => V.donor_rank_window_days(3651)));
  check('validator: loyalty % 0-100', V.donor_loyalty_percent_per_month('2.5') === 2.5 && throws(() => V.donor_loyalty_percent_per_month(101)));
  check('validator: cap 1-100 finite', V.donor_loyalty_cap(1) === 1 && throws(() => V.donor_loyalty_cap(0.9)) && throws(() => V.donor_loyalty_cap('Infinity')));
  check('validator: expiry 0-120 int', V.donor_name_expiry_months(0) === 0 && throws(() => V.donor_name_expiry_months(121)) && throws(() => V.donor_name_expiry_months('abc')));
  check('validator: banner slots 0-10 int', V.donor_banner_slots('0') === 0 && V.donor_banner_slots(10) === 10 &&
        throws(() => V.donor_banner_slots(11)) && throws(() => V.donor_banner_slots(-1)) && throws(() => V.donor_banner_slots('abc')));
  // Round trip through the real store: what updateSection persists is what donorSettings reads.
  const ps = new PoolSettings(db);
  ps.updateSection('incentives', { donor_name_blocklist: 'one\n\ntwo', donor_rank_window_days: '90', donor_banner_slots: '3' });
  const back = DN.donorSettings(ps.getSection('incentives'), 'GRINIUM');
  check('validator: round trip through updateSection/getSection', back.listText === 'one\ntwo' && back.rankWindowDays === 90 && back.bannerSlots === 3);
  check('validator: a save still carrying donor_censored_display is REFUSED (unknown key), not silently kept',
        throws(() => ps.updateSection('incentives', { donor_censored_display: 'marker' })));
  ps.updateSection('incentives', { donor_name_blocklist: STARTER });
  check('validator: starter list survives a store round trip byte for byte', ps.getSection('incentives').donor_name_blocklist === STARTER);
}

// ── lastDonatedAt (composite ledger read) ────────────────────────────────────────────────
{
  const a = seedAddr(mkAddr(21));
  check('ledger: never donated → null', lastDonatedAt(db, a, 0) === null);
  db.prepare(`INSERT INTO balance_log (grin_address, event_type, amount, balance_before, balance_after, locked_before, locked_after, reference_type, reference_id, created_at)
              VALUES (?, 'debit', 0.5, 1, 0.5, 0, 0, 'donation', 1, ?)`).run(a, NOW - 100);
  db.prepare(`INSERT INTO balance_log_daily (day, grin_address, event_type, reference_type, total_amount, event_count) VALUES (?, ?, 'debit', 'donation', 2, 3)`)
    .run(Math.floor((NOW - 40 * 86400) / 86400) * 86400, a);
  check('ledger: raw row above the horizon wins over a rolled day below it', lastDonatedAt(db, a, NOW - 10 * 86400) === NOW - 100);
  check('ledger: with the raw row below the horizon only the rolled day counts (day-aligned)',
        lastDonatedAt(db, a, NOW + 1) === Math.floor((NOW - 40 * 86400) / 86400) * 86400);
  check('ledger: a credit or a non-donation debit is not a donation', (() => {
    db.prepare(`INSERT INTO balance_log (grin_address, event_type, amount, balance_before, balance_after, locked_before, locked_after, reference_type, reference_id, created_at)
                VALUES (?, 'debit', 0.5, 1, 0.5, 0, 0, 'withdrawal', 2, ?)`).run(a, NOW - 1);
    return lastDonatedAt(db, a, 0) === NOW - 100;
  })());
}

// ── Part 3: parseDonateToken (the admin list's "tagged rig" flag) ───────────────────────
{
  check('token: plain donate10 → label "", 10', JSON.stringify(parseDonateToken('donate10')) === '{"label":"","percent":10}');
  check('token: acme-donate5 → label acme', JSON.stringify(parseDonateToken('acme-donate5')) === '{"label":"acme","percent":5}');
  check('token: underscore separator', parseDonateToken('rig_01_donate100').label === 'rig_01');
  check('token: donate0 is a live token (pause)', parseDonateToken('donate0').percent === 0);
  check('token: out-of-range donate101 is NOT tagged (a typo donates nothing)', parseDonateToken('donate101') === null);
  check('token: 4+ digits is a plain name', parseDonateToken('donate1000') === null);
  check('token: no token → null', parseDonateToken('rig01') === null && parseDonateToken('') === null && parseDonateToken(null) === null);
  check("token: label is the RAW label (the cut is the login's job, not the flag's)", parseDonateToken('northern-hashworks-donate10').label === 'northern-hashworks');
}

// ── Part 3: donorLedger (per-address aggregate over the composite) ──────────────────────
{
  const day = (t) => Math.floor(t / 86400) * 86400;
  const a = seedAddr(mkAddr(51)), b = seedAddr(mkAddr(52)), c = seedAddr(mkAddr(53));
  const ins = db.prepare(`INSERT INTO balance_log (grin_address, event_type, amount, balance_before, balance_after, locked_before, locked_after, reference_type, reference_id, created_at)
                          VALUES (?, 'debit', ?, 1, 0.5, 0, 0, 'donation', 9, ?)`);
  const rolled = db.prepare(`INSERT INTO balance_log_daily (day, grin_address, event_type, reference_type, total_amount, event_count) VALUES (?, ?, 'debit', 'donation', ?, ?)`);
  const H = day(NOW - 30 * 86400);          // rollup horizon: 30 days back, day-aligned
  // a: two rolled days (13 and 2 months back, different months) + two raw rows this month.
  rolled.run(day(NOW - 400 * 86400), a, 3, 2);
  rolled.run(day(NOW - 60 * 86400), a, 1, 1);
  ins.run(a, 0.25, NOW - 5 * 86400);
  ins.run(a, 0.25, NOW - 4 * 86400);
  // b: one rolled day exactly ON the 365-day cutoff edge (in — the day boundary rule). The
  // edge is only exact when `now` is itself day-aligned, so those checks use day(NOW).
  rolled.run(day(NOW) - 365 * 86400, b, 2, 1);
  // c: only a non-donation debit and a credit → not a donor.
  db.prepare(`INSERT INTO balance_log (grin_address, event_type, amount, balance_before, balance_after, locked_before, locked_after, reference_type, reference_id, created_at)
              VALUES (?, 'debit', 5, 5, 0, 0, 0, 'withdrawal', 1, ?)`).run(c, NOW - 10);
  db.prepare(`INSERT INTO balance_log (grin_address, event_type, amount, balance_before, balance_after, locked_before, locked_after, reference_type, reference_id, created_at)
              VALUES (?, 'credit', 5, 0, 5, 0, 0, 'reward', 1, ?)`).run(c, NOW - 20);

  const rows = donorLedger(db, { H, windowDays: 365, now: NOW });
  const ra = rows.find((r) => r.address === a), rb = rows.find((r) => r.address === b);
  check('ledger: only donation debits make a donor (c absent)', !rows.some((r) => r.address === c) && !!ra && !!rb);
  check('ledger: lifetime total sums rolled + raw', ra.total_donated === 4.5);
  check('ledger: in-window excludes the 400-day-old rolled day', ra.in_window_donated === 1.5);
  check('ledger: donation_count = Σ event_count + raw rows', ra.donation_count === 5);
  check('ledger: first/last across both sides (rolled day-aligned, raw exact)',
        ra.first_donated_at === day(NOW - 400 * 86400) && ra.last_donated_at === NOW - 4 * 86400);
  check('ledger: active months = distinct UTC months, lifetime (a: 3)', ra.active_months === 3);
  check('ledger: a rolled day whose midnight == cutoff is IN the window (whole day)',
        donorLedger(db, { H, windowDays: 365, now: day(NOW) }).find((r) => r.address === b).in_window_donated === 2 && rb.active_months === 1);
  check('ledger: one second past the edge → out',
        donorLedger(db, { H, windowDays: 365, now: day(NOW) + 1 }).find((r) => r.address === b).in_window_donated === 0);
  check('ledger: window 0 = lifetime', donorLedger(db, { H, windowDays: 0, now: NOW }).find((r) => r.address === a).in_window_donated === 4.5);
  check('ledger: junk window → lifetime, never NaN', (() => {
    const r = donorLedger(db, { H, windowDays: 'abc', now: NOW }).find((x) => x.address === a);
    return r.in_window_donated === 4.5 && Number.isFinite(r.total_donated);
  })());
  check('ledger: raw row BELOW the horizon is invisible (rollup contract, no double count)', (() => {
    ins.run(a, 100, H - 10);                                   // a raw row the rollup already folded
    const r = donorLedger(db, { H, windowDays: 0, now: NOW }).find((x) => x.address === a);
    return r.total_donated === 4.5;
  })());
  check('ledger: lastDonatedAt agrees with the aggregate', lastDonatedAt(db, a, H) === ra.last_donated_at);
}

// ── Part 3: §16.6 score + order helpers (inputs are the bounded donorSettings) ──────────
{
  const ds = DN.donorSettings({ donor_loyalty_percent_per_month: 10, donor_loyalty_cap: 3 }, 'x');
  check('score: ×1.4 after 4 months at 10 %', loyaltyMultiplier(4, ds) === 1.4);
  check('score: 0 months → ×1', loyaltyMultiplier(0, ds) === 1 && loyaltyMultiplier(-3, ds) === 1);
  check('score: cap ×3 reached at 20 months and held at 50', loyaltyMultiplier(20, ds) === 3 && loyaltyMultiplier(50, ds) === 3);
  check('score: A × mult, 9 dp', donorScore(1.5, 4, ds) === 2.1 && donorScore(0.000000001, 0, ds) === 0.000000001);
  check('score: nothing in window → 0 whatever the months', donorScore(0, 40, ds) === 0);
  check('score: NaN/Infinity in → 0/defaults out, never NaN', Number.isFinite(donorScore(NaN, 4, ds)) && Number.isFinite(donorScore(Infinity, 4, {})) &&
        donorScore(Infinity, 4, {}) === 0 && loyaltyMultiplier(4, { loyaltyPercentPerMonth: NaN, loyaltyCap: NaN }) === 1.4);
  const rows = [
    { id: 'late-big', score: 5, active_months: 2, first_donated_at: 500 },
    { id: 'early-big', score: 5, active_months: 2, first_donated_at: 100 },
    { id: 'loyal', score: 5, active_months: 6, first_donated_at: 900 },
    { id: 'top', score: 9, active_months: 1, first_donated_at: 999 },
    { id: 'zero', score: 0, active_months: 12, first_donated_at: 1 }
  ].sort(leagueOrder).map((r) => r.id).join(',');
  check('order: score DESC, then months DESC, then first donation ASC', rows === 'top,loyal,early-big,late-big,zero');
}

closeDb();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
