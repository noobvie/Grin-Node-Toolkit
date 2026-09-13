// Admin guard-tier regression tests — audit §J1 resolution pass.
//
// Guards two fixes that are easy to undo by accident:
//   §J1-1  the analytics/branding script + CSS sinks must stay in STEP_UP_SETTINGS_KEYS.
//          They look like cosmetic branding fields, so the risk is a future tidy-up dropping
//          them — which would silently re-open a secureAdmin → freshAdmin escalation
//          (public_html/login.html loads branding.js, so custom_head_html can keylog the
//          admin login form and harvest the password + a live TOTP code).
//   §J1-2  updateSection must write an admin_audit_log row naming the changed keys, must NOT
//          write one for a no-op save, must roll the row back with a rejected update, and must
//          never put a VALUE in the row (the alerts section holds live webhook URLs and a
//          Telegram bot token, and admin_audit_log is readable + CSV-exportable).
//
// Runs against a throwaway SQLite file in the OS temp dir — never the pool DB.
// Run: node scripts/test-admin-guards.js
const path = require('path');
const fs = require('fs');
const os = require('os');

const APP = path.resolve(__dirname, '..');
const dbFile = path.join(os.tmpdir(), `pool-guards-${Date.now()}.sqlite`);

const { initDb, getDb, createSchema, closeDb } = require(path.join(APP, 'lib/db.js'));
initDb(dbFile);
const db = getDb();
createSchema();
const PoolSettings = require(path.join(APP, 'lib/pool-settings.js'));
const ps = new PoolSettings(db);

// admin_audit_log.admin_id is a FK to users(id), so the audit row needs a real admin row.
db.prepare("INSERT INTO users (id, username, password_hash, is_admin) VALUES (7,'auditor','x',1)").run();

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name} ${extra}`); }
};

// WAL leaves -wal/-shm sidecars; close the handle first, then remove all three.
const cleanup = () => {
  try { closeDb(); } catch (_) {}
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(dbFile + suffix); } catch (_) {}
  }
};

const audits = () => db.prepare("SELECT * FROM admin_audit_log WHERE action='update_settings' ORDER BY id").all();
const lastAudit = () => { const rows = audits(); return rows.length ? rows[rows.length - 1] : null; };

try {
  console.log('\n[1] §J1-2 — updateSection writes an audit row');

  ps.updateSection('pool_info', { pool_fee_percent: 2 }, 7);
  let a = lastAudit();
  ok('a real change writes an audit row', audits().length === 1);
  ok('row is attributed to the admin', a && a.admin_id === 7);
  ok('target_id is the section', a && a.target_id === 'pool_info');
  ok('details names exactly the changed key',
    a && JSON.stringify(JSON.parse(a.details).changed_keys) === '["pool_fee_percent"]', a && a.details);

  // The settings form harvester posts EVERY field in the section on every save, so gating on
  // presence rather than change would write a row each time an operator pressed Save.
  const n1 = audits().length;
  ps.updateSection('pool_info', { pool_fee_percent: 2 }, 7);
  ok('a no-op save writes NO audit row', audits().length === n1, `count=${audits().length}`);

  const whole = { ...ps.getSection('pool_info') };
  whole.pool_name = 'Renamed Pool';
  ps.updateSection('pool_info', whole, 7);
  ok('a whole-section save names only the edited key',
    JSON.stringify(JSON.parse(lastAudit().details).changed_keys) === '["pool_name"]');

  console.log('\n[2] §J1-2 — the audit row records NAMES, never values');

  // This used to write to the `alerts` section, which held three live credentials until §J8-3
  // deleted it. The property under test is not "credentials are protected" but the broader rule
  // the audit writer actually implements — NO settings VALUE ever reaches admin_audit_log,
  // which is readable through GET /api/admin/audit-log and its CSV export. Any section proves
  // it; `analytics` is used because its values are free-form strings an operator pastes in.
  ps.updateSection('analytics', {
    ga_tracking_id: 'G-SUPERSECRETTOKEN',
    plausible_domain: 'hooks.slack.com',
  }, 7);
  ok('a settings change is still audited by NAME',
    JSON.parse(lastAudit().details).changed_keys.includes('ga_tracking_id'));
  const allDetails = audits().map(r => r.details).join('|');
  ok('a settings VALUE never appears in any audit row', !/SUPERSECRETTOKEN/.test(allDetails));
  ok('…nor does a second one from the same save', !/hooks\.slack\.com/.test(allDetails));

  console.log('\n[3] §J1-2 — the audit row rolls back with a rejected update');

  const n2 = audits().length;
  let threw = false;
  try {
    ps.updateSection('incentives', {
      lottery_pot_share_weighted_percent: 80,
      lottery_pot_equal_chance_percent: 80,
    }, 7);
  } catch (e) { threw = true; }
  ok('the cross-field rule still throws', threw);
  ok('ROLLBACK: no audit row survives a rejected update', audits().length === n2, `count=${audits().length} was ${n2}`);
  ok('ROLLBACK: the rejected value did not land',
    Number(ps.getSection('incentives').lottery_pot_share_weighted_percent) !== 80);

  // dormancy.js re-arms the policy anchor with userId=null. NULL never violates a FK, and an
  // unattributed row is more honest than no row.
  ps.updateSection('payout', { dormancy_policy_effective_at: 1234 }, null);
  ok('a system write is audited with admin_id NULL',
    lastAudit().admin_id === null && lastAudit().target_id === 'payout');

  console.log('\n[4] §J1-1 — the script/CSS sinks stay behind step-up');

  const src = fs.readFileSync(path.join(APP, 'index.js'), 'utf8');
  const at = src.indexOf('const STEP_UP_SETTINGS_KEYS');
  ok('STEP_UP_SETTINGS_KEYS still exists in index.js', at !== -1);
  const block = src.slice(at, src.indexOf(']);', at));
  const gated = [...block.matchAll(/^\s*'([a-z_]+)',/gm)].map(m => m[1]);

  for (const key of [
    'custom_head_html',   // branding.js re-creates <script> nodes out of this so they RUN
    'custom_body_html',
    'plausible_src', 'umami_src', 'matomo_url',  // third-party <script src> origins
    'custom_css', 'font_url', 'font_family',     // CSS injection sinks
    'custom_theme',       // §J9-3: setProperty() onto <html>+<body> on EVERY page
    'cta_link',           // reaches an <a href> verbatim → javascript: URI
  ]) {
    ok(`${key} is behind step-up`, gated.includes(key));
  }
  ok('pool_fee_percent (the pool cut) is still behind step-up',
    gated.includes('pool_fee_percent'));

  // §J9-1 / §J9-8: four pool_info keys and two access keys described an access control the
  // backend never had (a "private" pool accepted every miner). They were deleted rather than
  // enforced, because a login-only gate would still have published every member on the public
  // miner list. This asserts they stay deleted — re-adding one to defaults without a consumer
  // re-creates the exact deception, and re-adding it to the step-up set makes it look real.
  for (const key of ['pool_visibility', 'address_whitelist', 'max_miners', 'mining_mode',
                     'invite_codes_enabled', 'invite_codes']) {
    ok(`${key} is gone from PoolSettings.defaults`,
      !Object.keys(PoolSettings.defaults).some(sec =>
        Object.prototype.hasOwnProperty.call(PoolSettings.defaults[sec], key)));
    ok(`${key} is gone from STEP_UP_SETTINGS_KEYS`, !gated.includes(key));
  }

  // A gated key that exists in no section is a typo, and a typo makes the gate decorative.
  const allKeys = new Set();
  for (const sec of Object.keys(PoolSettings.defaults)) {
    Object.keys(PoolSettings.defaults[sec]).forEach(k => allKeys.add(k));
  }
  const orphans = gated.filter(k => !allKeys.has(k));
  ok('every gated key exists in a real section', orphans.length === 0, orphans.join(','));

  // The key-level gate exists so cosmetic edits do NOT prompt — over-gating trains the
  // operator to reflex-approve challenges, which is its own failure.
  ok('ordinary cosmetic branding keys stay ungated',
    !gated.includes('hero_heading') && !gated.includes('footer_text') && !gated.includes('accent_color'));

  console.log('\n[5] §J9 — settings & config integrity');

  // §J9-2 — the step-up "did this critical value actually change?" comparison used Number(),
  // which accepts 0x/0b/0o literals, while every validator uses parseFloat/parseInt, which do
  // not. `0x1` therefore compared EQUAL to a stored 1 (so no step-up was demanded) and then
  // stored 0 — the pool fee driven to zero on a plain secureAdmin session.
  const uAt = src.indexOf('const settingValueUnchanged =');
  const settingValueUnchanged = eval(
    '(' + src.slice(uAt, src.indexOf('\n  };', uAt) + 5)
      .replace('const settingValueUnchanged = ', '').replace(/;\s*$/, '') + ')');
  ok('§J9-2 hex literal reads as CHANGED (step-up demanded)', settingValueUnchanged('0x1', 1) === false);
  ok('§J9-2 binary/octal literals read as CHANGED',
    settingValueUnchanged('0b1010', 10) === false && settingValueUnchanged('0o12', 10) === false);
  ok('§J9-2 a real decimal no-op still skips step-up',
    settingValueUnchanged('1.0', 1) === true && settingValueUnchanged(' 1.50 ', 1.5) === true);
  ok('§J9-2 a genuine change still demands step-up', settingValueUnchanged('2', 1) === false);
  ok('§J9-2 structural (JSON) comparison unaffected',
    settingValueUnchanged('[]', '[]') === true && settingValueUnchanged('["a"]', '[]') === false);

  // §J9-4 — isNaN() is not a finiteness check; parseFloat('Infinity') and parseFloat('1e400')
  // are both +Inf. min_withdrawal = Infinity froze every payout rail, survived restart, and
  // rendered as an EMPTY field in the panel (JSON.stringify(Infinity) === 'null').
  const throws = (fn) => { try { fn(); return false; } catch (e) { return true; } };
  const V = PoolSettings.validators;
  ok('§J9-4 min_withdrawal rejects Infinity', throws(() => V.payout.min_withdrawal('Infinity')));
  ok('§J9-4 min_withdrawal rejects 1e400 (parseFloat → +Inf)', throws(() => V.payout.min_withdrawal('1e400')));
  ok('§J9-4 join_bonus_amount rejects Infinity', throws(() => V.incentives.join_bonus_amount('Infinity')));
  ok('§J9-4 jackpot_amount rejects Infinity', throws(() => V.incentives.jackpot_amount('Infinity')));
  ok('§J9-4 CONTROL: ordinary finite amounts still validate',
    V.payout.min_withdrawal('25') === 25 && V.incentives.jackpot_amount('0.5') === 0.5);

  // §J1-6 / §J7-8, fixed in §J9 — the section and key gates walked Object.prototype, so
  // `constructor` passed the section check and `toString` passed the key check.
  for (const proto of ['constructor', 'toString', '__proto__', 'valueOf', 'hasOwnProperty']) {
    ok(`§J9-5 section '${proto}' is refused`, throws(() => ps.getSection(proto)) &&
      throws(() => ps.updateSection(proto, {})) && throws(() => ps.resetSection(proto)));
    ok(`§J9-5 key '${proto}' is refused`, throws(() => ps.updateSection('pool_info', { [proto]: 'x' })));
  }
  ok('§J9-5 CONTROL: a real section and key still work',
    ps.getSection('pool_info').pool_name !== undefined &&
    ps.updateSection('pool_info', { pool_tagline: 'ok' }, 7).pool_tagline === 'ok');

  // §J9-3 — custom_theme is a CSS sink, not a JSON blob: a url() in a value consumed by a
  // `background:` shorthand is an outbound request from every page that renders it.
  ok('§J9-3 custom_theme rejects url()', throws(() => V.branding.custom_theme('{"bg":"url(https://e.example/p)"}')));
  ok('§J9-3 custom_theme rejects a non-object', throws(() => V.branding.custom_theme('[1,2]')));
  ok('§J9-3 custom_theme refuses a vendor-prefixed key (applyTheme passes those through raw)',
    throws(() => V.branding.custom_theme('{"-webkit-user-select":"none"}')));
  ok('§J9-3 custom_theme normalises an imported -- key to the builder shape',
    V.branding.custom_theme('{"--accent":"#ff0000"}') === '{"accent":"#ff0000"}');
  ok('§J9-3 CONTROL: the admin theme builder round-trips unchanged',
    V.branding.custom_theme('{"accent":"#ff0000","bg-card":"#111111"}')
      === '{"accent":"#ff0000","bg-card":"#111111"}');


  console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed\n`);
  cleanup();
  process.exit(fail === 0 ? 0 : 1);
} catch (err) {
  console.error('\nHARNESS ERROR:', err && err.message);
  cleanup();
  process.exit(1);
}
