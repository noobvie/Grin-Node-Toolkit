'use strict';

// Donor settings (design §16, reduced by §18 Part 3 and §19.17.6 Part C4) against an in-memory
// copy of the real schema: the bounded settings readers + validators, the retired
// `donor_name_blocklist` and its one-time carry into `names.blocked_words`, and the migration
// running twice. The name matchers that lived here (normalise, reserved words, the flag list,
// the review-queue flags) moved to lib/name-rule.js in C4 and are tested with it. v1's
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

// ── retired by Part C4 (design §19.17.6) ─────────────────────────────────────────────────
// The matching form, the reserved words, the flag-word list and the review-queue flags moved
// to lib/name-rule.js (the shared rule, donor shape) — the behaviour is tested there
// (scripts/test-name-rule.js, the shared fixture) and in test-donor-profiles.js [names v2].
{
  const gone = ['RESERVED', 'normalise', 'parseList', 'poolNameEntry', 'matchEntries', 'nameFlagContext', 'nameFlags'];
  check('C4: the v1/§18 name matchers are no longer exported', gone.every((k) => !(k in DN)), gone.filter((k) => k in DN).join(','));
  check('C4: the starter list is kept as a record (~40+ entries, no blank lines)', DN.STARTER_BLOCKLIST.length >= 40 && DN.STARTER_BLOCKLIST.every((w) => w.trim() === w && w !== ''));
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
        d.loyaltyPercentPerMonth === 10 && d.loyaltyCap === 3 && d.nameExpiryMonths === 12 && d.poolName === 'GRINIUM');
  check('settings: C4 — donorSettings no longer carries the retired flag-word list', !('listText' in d));
  const junk = DN.donorSettings({
    donor_rank_window_days: 'abc', donor_loyalty_percent_per_month: Infinity,
    donor_loyalty_cap: 0.5, donor_name_expiry_months: -1, donor_banner_slots: 11
  }, null);
  check('settings: "abc" / Infinity / -1 / cap<1 / slots 11 → defaults, never NaN', junk.rankWindowDays === 365 && junk.loyaltyPercentPerMonth === 10 &&
        junk.loyaltyCap === 3 && junk.nameExpiryMonths === 12 && junk.bannerSlots === 5);
  check('settings: null pool name → ""', junk.poolName === '');
  check('settings: stored strings parse ("30" → 30, "2.5" → 2.5)', DN.donorSettings({ donor_rank_window_days: '30', donor_loyalty_cap: '2.5' }).rankWindowDays === 30 &&
        DN.donorSettings({ donor_loyalty_cap: '2.5' }).loyaltyCap === 2.5);
  check('settings: window 0 (lifetime), expiry 0 (never) and slots 0 (banners off) are kept, not defaulted',
        DN.donorSettings({ donor_rank_window_days: 0, donor_name_expiry_months: 0 }).rankWindowDays === 0 &&
        DN.donorSettings({ donor_name_expiry_months: 0 }).nameExpiryMonths === 0 && DN.donorSettings({ donor_banner_slots: '0' }).bannerSlots === 0);
  // Write-side validators (pool-settings.js incentives block).
  const V = PoolSettings.validators.incentives;
  check('validator: the five donor keys exist in defaults + validators', ['donor_rank_window_days',
        'donor_loyalty_percent_per_month', 'donor_loyalty_cap', 'donor_name_expiry_months', 'donor_banner_slots'].every((k) =>
        Object.prototype.hasOwnProperty.call(PoolSettings.defaults.incentives, k) && typeof V[k] === 'function'));
  check('validator: donor_censored_display is gone from defaults AND validators (§18.6)',
        !('donor_censored_display' in PoolSettings.defaults.incentives) && !('donor_censored_display' in V));
  check('validator: C4 — donor_name_blocklist is gone from defaults AND validators',
        !('donor_name_blocklist' in PoolSettings.defaults.incentives) && !('donor_name_blocklist' in V));
  check('validator: window 0-3650 int', V.donor_rank_window_days('0') === 0 && throws(() => V.donor_rank_window_days(-1)) && throws(() => V.donor_rank_window_days(3651)));
  check('validator: loyalty % 0-100', V.donor_loyalty_percent_per_month('2.5') === 2.5 && throws(() => V.donor_loyalty_percent_per_month(101)));
  check('validator: cap 1-100 finite', V.donor_loyalty_cap(1) === 1 && throws(() => V.donor_loyalty_cap(0.9)) && throws(() => V.donor_loyalty_cap('Infinity')));
  check('validator: expiry 0-120 int', V.donor_name_expiry_months(0) === 0 && throws(() => V.donor_name_expiry_months(121)) && throws(() => V.donor_name_expiry_months('abc')));
  check('validator: banner slots 0-10 int', V.donor_banner_slots('0') === 0 && V.donor_banner_slots(10) === 10 &&
        throws(() => V.donor_banner_slots(11)) && throws(() => V.donor_banner_slots(-1)) && throws(() => V.donor_banner_slots('abc')));
  // Round trip through the real store: what updateSection persists is what donorSettings reads.
  const ps = new PoolSettings(db);
  ps.updateSection('incentives', { donor_rank_window_days: '90', donor_banner_slots: '3' });
  const back = DN.donorSettings(ps.getSection('incentives'), 'GRINIUM');
  check('validator: round trip through updateSection/getSection', back.rankWindowDays === 90 && back.bannerSlots === 3);
  check('validator: a save still carrying donor_censored_display is REFUSED (unknown key), not silently kept',
        throws(() => ps.updateSection('incentives', { donor_censored_display: 'marker' })));
  check('validator: C4 — a save carrying donor_name_blocklist is REFUSED with a message that points at Settings → Names',
        (() => { try { ps.updateSection('incentives', { donor_name_blocklist: 'x' }); return false; } catch (e) { return /Settings → Names/.test(e.message); } })());
}

// ── C4: the retired list is carried into names.blocked_words ONCE ────────────────────────
// retireDonorNameBlocklist() reads the RAW stored row (getSection never returns a retired key),
// carries the operator's own entries over, and deletes the row in the same transaction.
{
  const ps = new PoolSettings(db);
  const rawRow = () => db.prepare("SELECT value FROM pool_config WHERE section = 'incentives' AND key = 'donor_name_blocklist'").get();
  check('carry: no stored row → null, nothing written', ps.retireDonorNameBlocklist() === null && ps.getSection('names').blocked_words === '');
  ps.updateSection('names', { blocked_words: 'moon' });
  // A v1 save: the starter list (a leet re-spelling of one of its words included) + the
  // operator's own words, one that cannot match a name, one already on the Names page.
  db.prepare("INSERT INTO pool_config (section, key, value, value_type) VALUES ('incentives', 'donor_name_blocklist', ?, 'string')")
    .run(STARTER + '\nRug Pull\r\nsc4mmer\n  \nA55\ncafé\nMoon\n' + 'x'.repeat(40));
  check('carry: getSection never returns the retired key', !('donor_name_blocklist' in ps.getSection('incentives')));
  const r = ps.retireDonorNameBlocklist();
  check('carry: only the operator\'s own entries carry, folded (the starter words — any spelling — and duplicates do not)',
        r && JSON.stringify(r.carried) === JSON.stringify(['rugpull', 'scammer']), JSON.stringify(r));
  check('carry: an entry that cannot match a name is skipped and REPORTED, not fatal', r && r.skipped.length === 2 && r.skipped[0] === 'café');
  check('carry: names.blocked_words = what was there + the carried entries', ps.getSection('names').blocked_words === 'moon\nrugpull\nscammer');
  check('carry: the old row is deleted (that is the "done" marker)', rawRow() === undefined);
  ps.updateSection('names', { blocked_words: 'moon' });   // the operator later deletes a carried word
  check('carry: a second run is a no-op — a deleted word never comes back', ps.retireDonorNameBlocklist() === null && ps.getSection('names').blocked_words === 'moon');
  check('carry: the merge wrote an audited settings change', db.prepare("SELECT COUNT(*) AS n FROM admin_audit_log WHERE action = 'update_settings' AND target_id = 'names'").get().n >= 1);
  // The 500-entry cap: carried entries that would overflow are reported, the row still goes.
  ps.updateSection('names', { blocked_words: Array.from({ length: 499 }, (_, i) => `w${i}x`).join('\n') });
  db.prepare("INSERT INTO pool_config (section, key, value, value_type) VALUES ('incentives', 'donor_name_blocklist', 'alpha\nbravo\ncharlie', 'string')").run();
  const r2 = ps.retireDonorNameBlocklist();
  check('carry: at the 500 cap the overflow is reported, never silently dropped', r2.carried.length === 1 && r2.over_cap.length === 2 &&
        ps.getSection('names').blocked_words.split('\n').length === 500 && rawRow() === undefined);
  ps.updateSection('names', { blocked_words: '' });
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
