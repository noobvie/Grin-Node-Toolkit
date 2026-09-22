'use strict';

// Donor names (design §16, Part 2) — the name model end to end against an in-memory copy of
// the real schema: normalisation + leet, the fixed reserved words, the operator list (never a
// RegExp), the documented Scunthorpe false positive, the capture rule with its sticky `admin`
// and `allow` override, the '' clear, the rescan counts, displayState for all four states and
// both censored-display modes, the bounded settings readers + validators, the migration
// running twice, and — the one that matters most — the stratum gate: a LOWER never reaches
// the name write. Part 3 (admin) adds: the donate-token parser the admin list flags rigs with,
// the per-address ledger aggregate + window boundary + active months, the §16.6 score/order
// helpers, the censor/un-censor state machine WITH its audit rows, and the new-names count.
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
const StratumServer = require(path.join(APP, 'lib/stratum-server.js'));

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else      { fail++; console.error(`  FAIL ${name}${extra ? ' — ' + extra : ''}`); }
}
const throws = (fn) => { try { fn(); return false; } catch (_) { return true; } };

const NOW = 1_800_000_000; // fixed clock for every dated assertion
const MONTH = 31 * 86400;
const STARTER = DN.STARTER_BLOCKLIST.join('\n');

// A miner_accounts row is required by the FK; every address in this file goes through here.
const mkAddr = (i) => `grin1${String(i).padStart(58, 'q')}`;
function seedAddr(a) {
  db.prepare('INSERT OR IGNORE INTO miner_accounts (grin_address, balance) VALUES (?, 0)').run(a);
  return a;
}
const row = (a) => db.prepare('SELECT * FROM miner_incentives WHERE grin_address = ?').get(a) || null;

// ── Migration ────────────────────────────────────────────────────────────────────────────
{
  const cols = () => new Set(db.prepare('PRAGMA table_info(miner_incentives)').all().map((c) => c.name));
  const want = ['donor_name', 'donor_name_set_at', 'donor_censor', 'donor_censor_word', 'donor_censor_at', 'donor_censor_by'];
  check('miner_incentives carries the six donor_* columns', want.every((c) => cols().has(c)));
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
}

// ── reserved words ───────────────────────────────────────────────────────────────────────
{
  check('reserved: "pool-admin" hits admin', DN.matchBlocklist('pool-admin', '', '') === 'admin' || DN.matchBlocklist('pool-admin', '', '') === 'pool');
  check('reserved: "grinium-rig" hits grinium', DN.matchBlocklist('grinium-rig', '', '') === 'grinium');
  check('reserved: "0fficial" is caught through leet', DN.matchBlocklist('0fficial', '', '') === 'official');
  check('reserved: pool name is applied (as typed in the badge)', DN.matchBlocklist('zephyr-fan', '', 'Zephyr') === 'Zephyr');
  check('reserved: pool name is normalised on both sides', DN.matchBlocklist('z3ph-yr', '', 'Zeph_Yr') === 'Zeph_Yr');
  check('reserved: fixed words outrank the pool name ("acmepool" hits pool first)', DN.matchBlocklist('acmepool-fan', '', 'AcmePool') === 'pool');
  check('reserved: a 2-char pool name is NOT applied (would censor everyone)', DN.matchBlocklist('cabbage', '', 'ab') === null);
  check('reserved: clean name → null', DN.matchBlocklist('northern-hashworks', '', 'GRINIUM') === null);
  check('reserved: empty name → null', DN.matchBlocklist('', STARTER, 'GRINIUM') === null);
}

// ── operator list ────────────────────────────────────────────────────────────────────────
{
  check('list: starter catches leet spelling ("sh1t-lord" → shit)', DN.matchBlocklist('sh1t-lord', STARTER, '') === 'shit');
  check('list: entry returned as typed, matched normalised', DN.matchBlocklist('mo0n-boy', 'Mo0n\n', '') === 'Mo0n');
  check('list: entries split on CRLF and trimmed, empties dropped', DN.matchBlocklist('xyzzy', '\r\n  \r\n xyz \r\n', '') === 'xyz');
  check('list: separator-only entries are dropped, not matched', DN.matchBlocklist('a-b', '-\n_\n--', '') === null);
  check('list: regex-special text never throws (not a RegExp)', !throws(() => DN.matchBlocklist('acme', '(\n[\n*\n\\', '')) &&
        DN.matchBlocklist('acme', '(\n[\n*\n\\', '') === null);
  check('list: parseList keeps order', DN.parseList('b\na').map((e) => e.entry).join(',') === 'b,a');
  // EXPECTED false positive — substring on the normalised name (design §16.5 #2). The fix is
  // the admin un-censor (sets `allow`), which the capture + rescan tests below respect.
  check('Scunthorpe: "classic" is auto-censored by "ass" (EXPECTED false positive)', DN.matchBlocklist('classic', STARTER, '') === 'ass');
  check('starter list has ~40+ entries and no blank lines', DN.STARTER_BLOCKLIST.length >= 40 && DN.STARTER_BLOCKLIST.every((w) => w.trim() === w && w !== ''));
}

// ── captureDonorName ─────────────────────────────────────────────────────────────────────
{
  const opts = { listText: STARTER, poolName: 'GRINIUM', now: NOW };

  const a1 = seedAddr(mkAddr(1));
  let r = DN.captureDonorName(db, a1, 'acme', opts);
  check('capture: clean name stored, censor NULL', r.name === 'acme' && r.censor === null && r.word === null &&
        row(a1).donor_name === 'acme' && row(a1).donor_censor === null && row(a1).donor_name_set_at === NOW);
  check('capture: creates the miner_incentives row if missing', row(a1) !== null);

  const a2 = seedAddr(mkAddr(2));
  r = DN.captureDonorName(db, a2, 'sh1thead', opts);
  check('capture: list hit is STORED and auto-censored with the word', r.censor === 'auto' && r.word === 'shit' &&
        row(a2).donor_name === 'sh1thead' && row(a2).donor_censor === 'auto' && row(a2).donor_censor_word === 'shit' &&
        row(a2).donor_censor_at === NOW && row(a2).donor_censor_by === null);

  const a3 = seedAddr(mkAddr(3));
  r = DN.captureDonorName(db, a3, 'pool-official', opts);
  check('capture: reserved hit is stored + auto', r.censor === 'auto' && row(a3).donor_name === 'pool-official');

  // Sticky admin: an operator censor survives a rename, whatever the new name is.
  const a4 = seedAddr(mkAddr(4));
  DN.captureDonorName(db, a4, 'troll', opts);
  db.prepare("UPDATE miner_incentives SET donor_censor = 'admin', donor_censor_word = NULL, donor_censor_at = ?, donor_censor_by = 7 WHERE grin_address = ?").run(NOW - 100, a4);
  r = DN.captureDonorName(db, a4, 'innocent', { ...opts, now: NOW + 5 });
  check('capture: sticky admin — new name stored, censor stays admin', r.name === 'innocent' && r.censor === 'admin' &&
        row(a4).donor_name === 'innocent' && row(a4).donor_censor === 'admin' && row(a4).donor_censor_by === 7 &&
        row(a4).donor_censor_at === NOW - 100 && row(a4).donor_name_set_at === NOW + 5);
  check('capture: renamed-while-censored is detectable (set_at > censor_at)', row(a4).donor_name_set_at > row(a4).donor_censor_at);

  // Allow override: the list is skipped for this address.
  const a5 = seedAddr(mkAddr(5));
  DN.captureDonorName(db, a5, 'classic', opts);
  check('capture: "classic" auto-censored before the override', row(a5).donor_censor === 'auto');
  db.prepare("UPDATE miner_incentives SET donor_censor = 'allow', donor_censor_word = NULL, donor_censor_at = ?, donor_censor_by = 7 WHERE grin_address = ?").run(NOW, a5);
  r = DN.captureDonorName(db, a5, 'shithead', opts);
  check('capture: allow override — a list hit is NOT re-censored', r.censor === 'allow' && r.word === null &&
        row(a5).donor_name === 'shithead' && row(a5).donor_censor === 'allow');

  // '' clears the name; an auto verdict goes with it, admin/allow survive.
  r = DN.captureDonorName(db, a2, '', opts);
  check("capture: '' clears the name and an auto verdict", r.name === null && r.censor === null &&
        row(a2).donor_name === null && row(a2).donor_censor === null && row(a2).donor_censor_word === null && row(a2).donor_censor_at === null);
  r = DN.captureDonorName(db, a4, '', opts);
  check("capture: '' on an admin-censored address keeps the censor (sticky per address)", r.name === null && r.censor === 'admin' &&
        row(a4).donor_name === null && row(a4).donor_censor === 'admin' && row(a4).donor_censor_by === 7);
  r = DN.captureDonorName(db, a5, null, opts);
  check('capture: null clears too and keeps allow', r.name === null && r.censor === 'allow' && row(a5).donor_censor === 'allow');
  check('capture: a label outside the grammar throws (contract, not input)', throws(() => DN.captureDonorName(db, a1, 'Bad Name!', opts)));
  check('capture: an uppercase label is folded, not refused', DN.captureDonorName(db, a1, 'ACME', opts).name === 'acme');
  check('capture: donation_percent is untouched by a capture', row(a1).donation_percent === 0);

  // Part 5 review: a label of separators only is INSIDE the grammar (`--donate10` hands over
  // `-`, `_-_-donate10` hands over `_-_`), normalises to nothing, matches nothing, and used to
  // be stored — a card headed by the "name" `-`. It is no label: same as '' (clears).
  const a6 = seedAddr(mkAddr(6));
  DN.captureDonorName(db, a6, 'acme', opts);
  r = DN.captureDonorName(db, a6, '-', opts);
  check('capture: a separator-only label ("-") is no label — clears like \'\'', r.name === null && row(a6).donor_name === null);
  DN.captureDonorName(db, a6, 'acme', opts);
  r = DN.captureDonorName(db, a6, '_-_', opts);
  check('capture: "_-_" likewise', r.name === null && row(a6).donor_name === null);
  r = DN.captureDonorName(db, a6, '-a-', opts);
  check('capture: one real character is a name ("-a-" kept as typed)', r.name === '-a-' && row(a6).donor_name === '-a-');
  r = DN.captureDonorName(db, a6, '0', opts);
  check('capture: a leet digit alone is a name ("0" → normalises to "o", not empty)', r.name === '0');
}

// ── rescanAll ────────────────────────────────────────────────────────────────────────────
{
  // Fresh set of rows in the states the rescan must distinguish. The capture block above left
  // named rows behind; clear them so the counts below are exact.
  db.exec('UPDATE miner_incentives SET donor_name = NULL, donor_censor = NULL, donor_censor_word = NULL, donor_censor_at = NULL');
  const r1 = seedAddr(mkAddr(11)), r2 = seedAddr(mkAddr(12)), r3 = seedAddr(mkAddr(13)), r4 = seedAddr(mkAddr(14)), r5 = seedAddr(mkAddr(15)), r6 = seedAddr(mkAddr(16));
  const ins = db.prepare('INSERT INTO miner_incentives (grin_address, donor_name, donor_name_set_at, donor_censor, donor_censor_word, donor_censor_at) VALUES (?, ?, ?, ?, ?, ?)');
  ins.run(r1, 'classic', NOW, null, null, null);        // NULL → will hit "ass"
  ins.run(r2, 'shithead', NOW, 'auto', 'shit', NOW - 9); // stays auto, same word → censor_at kept
  ins.run(r3, 'sunny', NOW, 'auto', 'sun', NOW - 9);     // old list had "sun"; new one does not → cleared
  ins.run(r4, 'adminx', NOW, 'admin', null, NOW - 9);    // skipped
  ins.run(r5, 'fucker', NOW, 'allow', null, NOW - 9);    // skipped (override survives)
  ins.run(r6, null, null, null, null, null);             // no name → not walked
  const res = DN.rescanAll(db, { listText: STARTER, poolName: 'GRINIUM', now: NOW + 50 });
  check('rescan: scanned counts only NULL/auto rows with a name', res.scanned === 3, JSON.stringify(res));
  check('rescan: censored = rows in auto AFTER the scan', res.censored === 2, JSON.stringify(res));
  check('rescan: cleared = auto rows the new list no longer matches', res.cleared === 1, JSON.stringify(res));
  check('rescan: "classic" now auto:"ass" stamped at scan time', row(r1).donor_censor === 'auto' && row(r1).donor_censor_word === 'ass' && row(r1).donor_censor_at === NOW + 50);
  check('rescan: unchanged verdict keeps its original censor_at', row(r2).donor_censor === 'auto' && row(r2).donor_censor_at === NOW - 9);
  check('rescan: "sunny" released to NULL', row(r3).donor_censor === null && row(r3).donor_censor_word === null && row(r3).donor_censor_at === null);
  check('rescan: admin row untouched', row(r4).donor_censor === 'admin' && row(r4).donor_censor_at === NOW - 9);
  check('rescan: allow override survives a rescan', row(r5).donor_censor === 'allow');
  const again = DN.rescanAll(db, { listText: STARTER, poolName: 'GRINIUM', now: NOW + 60 });
  check('rescan: idempotent (second run: same censored, 0 cleared)', again.scanned === 3 && again.censored === 2 && again.cleared === 0, JSON.stringify(again));
  const empty = DN.rescanAll(db, { listText: '', poolName: 'GRINIUM', now: NOW + 70 });
  check('rescan: empty list clears every auto row (reserved words still apply)', empty.censored === 0 && empty.cleared === 2, JSON.stringify(empty));

  // Part 5 review: the rescan must parse the list ONCE, not once per name — at the validator's
  // ceiling (4000 entries) the per-row parse cost ~1 s for 300 names on the shared synchronous
  // connection, i.e. a stall of share intake on every list save. Pinned two ways: the
  // pre-parsed matcher is the same function as the one-name one (so the walk cannot drift),
  // and the walk's source calls parseList exactly once, above the loop.
  const big = Array.from({ length: 4000 }, (_, i) => `w0rd-${i.toString(36)}xx`).concat(['ass']).join('\n');
  const entries = DN.parseList(big), pe = DN.poolNameEntry('GRINIUM');
  check('rescan: matchEntries(parsed) ≡ matchBlocklist(text) for every name',
    ['classic', 'sunny', 'grinium-fan', 'w0rdyzxx', 'official', 'clean'].every((n) =>
      DN.matchEntries(n, entries, pe) === DN.matchBlocklist(n, big, 'GRINIUM')));
  const rescanSrc = (() => {
    const src = require('fs').readFileSync(path.join(APP, 'lib/donor-names.js'), 'utf8').replace(/\/\/[^\n]*/g, '');
    const a = src.indexOf('function rescanAll('); return src.slice(a, src.indexOf('\nfunction ', a + 1));
  })();
  check('rescan: parseList is called once, before the row loop, and the loop uses matchEntries',
    (rescanSrc.match(/parseList\(/g) || []).length === 1 &&
    rescanSrc.indexOf('parseList(') < rescanSrc.indexOf('for (const r of rows)') &&
    /for \(const r of rows\)[\s\S]*matchEntries\(/.test(rescanSrc) && !/for \(const r of rows\)[\s\S]*matchBlocklist\(/.test(rescanSrc));
  const t0 = Date.now();
  const bigRes = DN.rescanAll(db, { listText: big, poolName: 'GRINIUM', now: NOW + 80 });
  check('rescan: the 4000-entry list (+ "ass") censors exactly "classic" again', bigRes.scanned === 3 && bigRes.censored === 1 && bigRes.cleared === 0 &&
        row(r1).donor_censor === 'auto' && row(r1).donor_censor_word === 'ass', JSON.stringify(bigRes));
  check('rescan: the 4000-entry walk over these rows is milliseconds, not seconds', Date.now() - t0 < 2000, `${Date.now() - t0} ms`);
}

// ── displayState ─────────────────────────────────────────────────────────────────────────
{
  const base = { now: NOW, expiryMonths: 12, lastDonatedAt: NOW - 86400, censoredDisplay: 'masked' };
  const ds = (r, o = {}) => DN.displayState(r, { ...base, ...o });
  const named = (extra = {}) => ({ donor_name: 'acme', donor_name_set_at: NOW - 86400, donor_censor: null, ...extra });

  check('display: null row → masked, name null', JSON.stringify(ds(null)) === JSON.stringify({ name: null, name_state: 'masked' }));
  check('display: row without a name → masked', ds({ donor_name: null }).name_state === 'masked');
  check('display: clean recent name → shown with the name', JSON.stringify(ds(named())) === JSON.stringify({ name: 'acme', name_state: 'shown' }));
  check('display: auto censor + masked → censored, name null', JSON.stringify(ds(named({ donor_censor: 'auto' }))) === JSON.stringify({ name: null, name_state: 'censored' }));
  check('display: admin censor + masked → censored, name null', ds(named({ donor_censor: 'admin' })).name === null);
  check('display: auto censor + marker → the marker string', ds(named({ donor_censor: 'auto' }), { censoredDisplay: 'marker' }).name === DN.CENSORED_MARKER);
  check('display: admin censor + marker → the marker string', ds(named({ donor_censor: 'admin' }), { censoredDisplay: 'marker' }).name === DN.CENSORED_MARKER);
  check('display: allow → shown (override)', ds(named({ donor_censor: 'allow' })).name_state === 'shown');
  check('display: marker never leaks into shown/masked/expired',
        ds(named(), { censoredDisplay: 'marker' }).name === 'acme' &&
        ds(null, { censoredDisplay: 'marker' }).name === null &&
        ds(named({ donor_name_set_at: NOW - 14 * MONTH }), { censoredDisplay: 'marker', lastDonatedAt: NOW - 14 * MONTH }).name === null);
  // Expiry — calendar months after the LATER of last debit and capture.
  check('display: last debit 13 months ago, set_at older → expired',
        ds(named({ donor_name_set_at: NOW - 20 * MONTH }), { lastDonatedAt: NOW - 13 * MONTH }).name_state === 'expired');
  check('display: last debit 11 months ago → shown', ds(named({ donor_name_set_at: NOW - 20 * MONTH }), { lastDonatedAt: NOW - 11 * MONTH }).name_state === 'shown');
  check('display: no debit yet, captured yesterday → shown (not instantly expired)', ds(named(), { lastDonatedAt: null }).name_state === 'shown');
  check('display: no debit, captured 13 months ago → expired', ds(named({ donor_name_set_at: NOW - 13 * MONTH }), { lastDonatedAt: null }).name_state === 'expired');
  check('display: fresh re-capture refreshes an old donor', ds(named({ donor_name_set_at: NOW - 1000 }), { lastDonatedAt: NOW - 20 * MONTH }).name_state === 'shown');
  check('display: expiry 0 = never', ds(named({ donor_name_set_at: NOW - 60 * MONTH }), { expiryMonths: 0, lastDonatedAt: NOW - 60 * MONTH }).name_state === 'shown');
  check('display: censor outranks expiry', ds(named({ donor_censor: 'auto', donor_name_set_at: NOW - 30 * MONTH }), { lastDonatedAt: NOW - 30 * MONTH }).name_state === 'censored');
  check('display: exact calendar boundary — one second before is shown, at it expired', (() => {
    const set = Date.UTC(2026, 0, 31, 12, 0, 0) / 1000; // 31 Jan → 12 months later = 31 Jan 2027 12:00
    const at = Date.UTC(2027, 0, 31, 12, 0, 0) / 1000;
    return ds(named({ donor_name_set_at: set }), { now: at - 1, lastDonatedAt: null }).name_state === 'shown' &&
           ds(named({ donor_name_set_at: set }), { now: at, lastDonatedAt: null }).name_state === 'expired';
  })());
  check('display: blank/NaN expiry setting falls back to 12, not 0 (never) and not NaN',
        ds(named({ donor_name_set_at: NOW - 13 * MONTH }), { expiryMonths: 'abc', lastDonatedAt: NOW - 13 * MONTH }).name_state === 'expired' &&
        ds(named(), { expiryMonths: '' }).name_state === 'shown');
}

// ── donorSettings (bounded readers) ──────────────────────────────────────────────────────
{
  const d = DN.donorSettings({}, 'GRINIUM');
  check('settings: empty section → every default', d.censoredDisplay === 'masked' && d.rankWindowDays === 365 &&
        d.loyaltyPercentPerMonth === 10 && d.loyaltyCap === 3 && d.nameExpiryMonths === 12 && d.listText === STARTER && d.poolName === 'GRINIUM');
  const junk = DN.donorSettings({
    donor_censored_display: 'MARKER ', donor_rank_window_days: 'abc', donor_loyalty_percent_per_month: Infinity,
    donor_loyalty_cap: 0.5, donor_name_expiry_months: -1, donor_name_blocklist: 42
  }, null);
  check('settings: enum is case/space-tolerant but closed', junk.censoredDisplay === 'marker' && DN.donorSettings({ donor_censored_display: 'x' }).censoredDisplay === 'masked');
  check('settings: "abc" / Infinity / -1 / cap<1 → defaults, never NaN', junk.rankWindowDays === 365 && junk.loyaltyPercentPerMonth === 10 &&
        junk.loyaltyCap === 3 && junk.nameExpiryMonths === 12);
  check('settings: non-string list → starter list; null pool name → ""', junk.listText === STARTER && junk.poolName === '');
  check('settings: stored strings parse ("30" → 30, "2.5" → 2.5)', DN.donorSettings({ donor_rank_window_days: '30', donor_loyalty_cap: '2.5' }).rankWindowDays === 30 &&
        DN.donorSettings({ donor_loyalty_cap: '2.5' }).loyaltyCap === 2.5);
  check('settings: window 0 (lifetime) and expiry 0 (never) are kept, not defaulted', DN.donorSettings({ donor_rank_window_days: 0, donor_name_expiry_months: 0 }).rankWindowDays === 0 &&
        DN.donorSettings({ donor_name_expiry_months: 0 }).nameExpiryMonths === 0);
  check('settings: empty stored list is an empty list, not the starter', DN.donorSettings({ donor_name_blocklist: '' }).listText === '');

  // Write-side validators (pool-settings.js incentives block).
  const V = PoolSettings.validators.incentives;
  check('validator: the six keys exist in defaults + validators', ['donor_name_blocklist', 'donor_censored_display', 'donor_rank_window_days',
        'donor_loyalty_percent_per_month', 'donor_loyalty_cap', 'donor_name_expiry_months'].every((k) =>
        Object.prototype.hasOwnProperty.call(PoolSettings.defaults.incentives, k) && typeof V[k] === 'function'));
  check('validator: default blocklist IS the starter list', PoolSettings.defaults.incentives.donor_name_blocklist === STARTER);
  check('validator: blocklist trims, drops empties, normalises CRLF', V.donor_name_blocklist(' a \r\n\r\n b\n') === 'a\nb');
  check('validator: blocklist size-capped', throws(() => V.donor_name_blocklist('x'.repeat(70000))) && throws(() => V.donor_name_blocklist(Array(4001).fill('w').join('\n'))));
  check('validator: display enum closed', V.donor_censored_display(' Marker') === 'marker' && throws(() => V.donor_censored_display('hidden')));
  check('validator: window 0-3650 int', V.donor_rank_window_days('0') === 0 && throws(() => V.donor_rank_window_days(-1)) && throws(() => V.donor_rank_window_days(3651)));
  check('validator: loyalty % 0-100', V.donor_loyalty_percent_per_month('2.5') === 2.5 && throws(() => V.donor_loyalty_percent_per_month(101)));
  check('validator: cap 1-100 finite', V.donor_loyalty_cap(1) === 1 && throws(() => V.donor_loyalty_cap(0.9)) && throws(() => V.donor_loyalty_cap('Infinity')));
  check('validator: expiry 0-120 int', V.donor_name_expiry_months(0) === 0 && throws(() => V.donor_name_expiry_months(121)) && throws(() => V.donor_name_expiry_months('abc')));
  // Round trip through the real store: what updateSection persists is what donorSettings reads.
  const ps = new PoolSettings(db);
  ps.updateSection('incentives', { donor_censored_display: 'marker', donor_name_blocklist: 'one\n\ntwo', donor_rank_window_days: '90' });
  const back = DN.donorSettings(ps.getSection('incentives'), 'GRINIUM');
  check('validator: round trip through updateSection/getSection', back.censoredDisplay === 'marker' && back.listText === 'one\ntwo' && back.rankWindowDays === 90);
  // Put the stored list back to the shipped default: the server-capture block below reads
  // the REAL settings and expects the starter list.
  ps.updateSection('incentives', { donor_name_blocklist: STARTER, donor_censored_display: 'masked' });
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

// ── Part 3: adminCensor state machine + audit rows ──────────────────────────────────────
{
  db.prepare("INSERT OR IGNORE INTO users (id, username, password_hash, is_admin) VALUES (7,'mod','x',1)").run();
  const audits = (addr) => db.prepare("SELECT action, admin_id, target_type, target_id, details, ip FROM admin_audit_log WHERE target_type='donor' AND target_id=? ORDER BY id").all(addr);
  const a = seedAddr(mkAddr(61));
  DN.captureDonorName(db, a, 'classic', { listText: 'ass', poolName: 'x', now: NOW });
  check('censor: setup — "classic" auto-censored by "ass"', row(a).donor_censor === 'auto' && row(a).donor_censor_word === 'ass');

  let r = DN.adminCensor(db, a, { censor: false, adminId: 7, ip: '203.0.113.7', now: NOW });
  check('uncensor: auto → allow (the false-positive fix)', r.ok && r.censor === 'allow' && r.previous === 'auto' && row(a).donor_censor === 'allow');
  check('uncensor: clears the word, stamps at/by', row(a).donor_censor_word === null && row(a).donor_censor_at === NOW && row(a).donor_censor_by === 7);
  check('uncensor: audit row donor_uncensor / donor / address, details {name, previous}, admin + ip', (() => {
    const [x] = audits(a);
    return x && x.action === 'donor_uncensor' && x.admin_id === 7 && x.target_id === a && x.ip === '203.0.113.7' &&
           JSON.stringify(JSON.parse(x.details)) === JSON.stringify({ name: 'classic', previous: 'auto' });
  })());
  check('uncensor: again → 409 "already", no second audit row', (() => {
    const r2 = DN.adminCensor(db, a, { censor: false, adminId: 7, now: NOW + 1 });
    return !r2.ok && r2.code === 'already' && r2.censor === 'allow' && audits(a).length === 1;
  })());
  check('allow survives a rescan (the override is the point)', (() => {
    DN.rescanAll(db, { listText: 'ass\nclassic', poolName: 'x', now: NOW + 2 });
    return row(a).donor_censor === 'allow';
  })());
  check('allow survives a rename through capture', (() => {
    DN.captureDonorName(db, a, 'sh1thead', { listText: STARTER, poolName: 'x', now: NOW + 3 });
    return row(a).donor_name === 'sh1thead' && row(a).donor_censor === 'allow';
  })());

  r = DN.adminCensor(db, a, { censor: true, adminId: 7, ip: '203.0.113.7', now: NOW + 4 });
  check('censor: allow → admin', r.ok && r.censor === 'admin' && r.previous === 'allow' && row(a).donor_censor === 'admin');
  check('censor: audit row donor_censor with the CURRENT name and previous state', (() => {
    const x = audits(a)[1];
    return x && x.action === 'donor_censor' && JSON.parse(x.details).name === 'sh1thead' && JSON.parse(x.details).previous === 'allow';
  })());
  check('censor: again → 409, still one censor row', !DN.adminCensor(db, a, { censor: true, adminId: 7 }).ok && audits(a).length === 2);
  check('censor is sticky: a rename stays admin-censored and is "renamed while censored"', (() => {
    DN.captureDonorName(db, a, 'newname', { listText: '', poolName: 'x', now: NOW + 10 });
    const x = row(a);
    return x.donor_name === 'newname' && x.donor_censor === 'admin' && x.donor_name_set_at > x.donor_censor_at;
  })());
  check('censor is sticky: a rescan does not touch admin', (() => {
    DN.rescanAll(db, { listText: '', poolName: 'x', now: NOW + 11 });
    return row(a).donor_censor === 'admin';
  })());
  check('admin → uncensor → allow (never NULL: NULL would re-arm the auto-list)', (() => {
    const r3 = DN.adminCensor(db, a, { censor: false, adminId: 7, now: NOW + 12 });
    return r3.ok && row(a).donor_censor === 'allow' && row(a).donor_censor !== null;
  })());

  const b = seedAddr(mkAddr(62));
  check('censor: an address with NO name yet is allowed and sticky (pre-emptive)', (() => {
    const r4 = DN.adminCensor(db, b, { censor: true, adminId: 7, now: NOW });
    DN.captureDonorName(db, b, 'anything', { listText: '', poolName: 'x', now: NOW + 1 });
    return r4.ok && r4.name === null && row(b).donor_censor === 'admin' && DN.displayState(row(b), { now: NOW + 2 }).name_state === 'censored';
  })());
  const c = seedAddr(mkAddr(63));
  check('uncensor: NULL → allow (pre-emptive whitelist before the list gains the word)', (() => {
    DN.captureDonorName(db, c, 'classic', { listText: '', poolName: 'x', now: NOW });
    const r5 = DN.adminCensor(db, c, { censor: false, adminId: 7, now: NOW + 1 });
    DN.rescanAll(db, { listText: 'ass', poolName: 'x', now: NOW + 2 });
    return r5.ok && r5.previous === null && row(c).donor_censor === 'allow';
  })());
  check('censor: unknown address → not_found, nothing written, no audit row', (() => {
    const ghost = mkAddr(64);
    const r6 = DN.adminCensor(db, ghost, { censor: true, adminId: 7 });
    return !r6.ok && r6.code === 'not_found' && row(ghost) === null && audits(ghost).length === 0;
  })());
  check('censor: system caller (adminId null) still audited, FK-safe', (() => {
    const d = seedAddr(mkAddr(65));
    const r7 = DN.adminCensor(db, d, { censor: true });
    const [x] = audits(d);
    return r7.ok && x && x.admin_id === null && row(d).donor_censor_by === null;
  })());
  // Fail-closed: the audit INSERT is inside the transaction, so if it cannot land the state
  // change rolls back with it. Force it by pointing admin_id at a user that does not exist.
  check('censor: an audit row that cannot be written rolls the state change back', (() => {
    const e = seedAddr(mkAddr(66));
    let threw = false;
    try { DN.adminCensor(db, e, { censor: true, adminId: 424242 }); } catch (_) { threw = true; }
    return threw && (row(e) === null || row(e).donor_censor === null) && audits(e).length === 0;
  })());
}

// ── Part 3: countNewNames ───────────────────────────────────────────────────────────────
{
  // Earlier blocks captured names at various clocks, so take the baseline at EACH `now` the
  // assertions use and compare deltas — the window's contents differ per clock.
  const at = (t, days) => DN.countNewNames(db, days === undefined ? { now: t } : { now: t, days });
  const b1 = at(NOW + 100), b2 = at(NOW + 7 * 86400), b3 = at(NOW + 7 * 86400 + 1), b4 = at(NOW + 100, 'abc');
  const a = seedAddr(mkAddr(71)), b = seedAddr(mkAddr(72)), c = seedAddr(mkAddr(73));
  DN.captureDonorName(db, a, 'fresh', { listText: '', poolName: 'x', now: NOW });
  DN.captureDonorName(db, b, 'old', { listText: '', poolName: 'x', now: NOW - 8 * 86400 });
  DN.captureDonorName(db, c, 'gone', { listText: '', poolName: 'x', now: NOW });
  DN.captureDonorName(db, c, '', { listText: '', poolName: 'x', now: NOW + 1 });     // cleared: set_at fresh, name NULL
  check('new names: counts a capture inside 7 days, not an 8-day-old one, not a cleared name',
        at(NOW + 100) === b1 + 1);
  check('new names: exactly 7 days is still new; 7 days + 1 s is not',
        at(NOW + 7 * 86400) === b2 + 1 && at(NOW + 7 * 86400 + 1) === b3);
  check('new names: junk days → default window, never NaN', at(NOW + 100, 'abc') === b4 + 1);
}

// ── The stratum gate: which arms reach the name write ────────────────────────────────────
{
  const server = new StratumServer({ network: 'testnet', stratum_port: 0 });
  let stored = 0;                   // the stub's "current" donation %
  const calls = { set: [], capture: 0, warn: 0 };
  server.incentives = {
    donationPercent: () => stored,
    setDonation: (addr, p) => { calls.set.push(p); if (server._stubRefuse) return false; stored = p; return true; },
    settings: { getSection: (s) => (s === 'pool_info' ? { pool_name: 'GRINIUM' } : {}) },
    db
  };
  server._captureDonorName = () => { calls.capture++; };
  const origWarn = console.warn;
  console.warn = () => { calls.warn++; };
  const sess = (pct, label = 'acme') => ({ grinAddress: mkAddr(31), donationPercent: pct, donorLabel: label, acceptedShares: 4 });
  const reset = () => { calls.set.length = 0; calls.capture = 0; calls.warn = 0; };

  stored = 0; reset(); server._applyParkedDonation(sess(10));
  check('gate: from-zero set → written AND captured', calls.set.length === 1 && calls.capture === 1);

  stored = 10; reset(); server._applyParkedDonation(sess(5, 'stranger'));
  check('gate: a LOWER is written but NEVER reaches capture', calls.set.length === 1 && calls.capture === 0);

  stored = 10; reset(); server._applyParkedDonation(sess(10, 'stranger'));
  check('gate: same value re-sent → written, not captured', calls.set.length === 1 && calls.capture === 0);

  stored = 10; reset(); server._applyParkedDonation(sess(20, 'stranger'));
  check('gate: a raise into an occupied slot → refused, no write, no capture', calls.set.length === 0 && calls.capture === 0 && calls.warn === 1);

  stored = 10; reset(); server._applyParkedDonation(sess(0, 'stranger'));
  check('gate: donate0 on a live donor → written (pause), not captured (name kept)', calls.set.length === 1 && calls.capture === 0 && stored === 0);

  stored = 0; reset(); server._applyParkedDonation(sess(0, 'stranger'));
  check('gate: donate0 on a paused address is not from-zero → no capture', calls.set.length === 1 && calls.capture === 0);

  stored = 0; reset(); server._stubRefuse = true; server._applyParkedDonation(sess(10));
  check('gate: from-zero but setDonation refused (donations off) → no capture', calls.set.length === 1 && calls.capture === 0);
  server._stubRefuse = false;

  // The ceremony end to end through the gate: pause keeps, raise rewrites.
  stored = 0; reset(); server._applyParkedDonation(sess(10, 'first'));
  server._applyParkedDonation({ ...sess(0, 'first'), acceptedShares: 4 });
  server._applyParkedDonation(sess(5, 'second'));
  check('gate: ceremony = set (capture) → donate0 (no capture) → new label (capture)', calls.capture === 2 && stored === 5);

  console.warn = origWarn;
}

// ── The real capture path through the server helper (settings → lib → row) ──────────────
{
  const server = new StratumServer({ network: 'testnet', stratum_port: 0 });
  const a = seedAddr(mkAddr(41));
  const origLog = console.log;
  let logged = '';
  console.log = (line) => { logged += String(line) + '\n'; };
  server._captureDonorName({ grinAddress: a, donorLabel: 'sh1thead', password: 'SECRET-PASS', ip: '203.0.113.9' });
  console.log = origLog;
  check('server capture: writes through the real settings (starter list) → auto', row(a).donor_name === 'sh1thead' && row(a).donor_censor === 'auto' && row(a).donor_censor_word === 'shit');
  check('server capture: logs one line with the name + state, masked address', /Donor name "sh1thead" for grin1qqqq…/.test(logged) && /auto-censored: "shit"/.test(logged));
  check('server capture: log never carries the password, the IP or the full address', !logged.includes('SECRET-PASS') && !logged.includes('203.0.113.9') && !logged.includes(a));
}

closeDb();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
