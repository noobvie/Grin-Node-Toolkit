'use strict';

// Part C2 (design §19.17.2, D30): the launch state and the effective mode.
//
//   [a] units: effectiveMode() over the whole pool-mode × launch table, garbage in → the
//       safe side; the launch value read from meta (fresh DB, absent row, junk row)
//   [b] the effective mode reaches every consumer: public routes 404 only on effective
//       'off', chat follows it, /play/api/rules says so, health reports `launch`
//   [c] the admin routes: GET launch, POST launch — step-up required, strict body,
//       audited once per real change, idempotent, works while the games are off
//
// Loopback server with a stubbed pool; the DB is in memory. Nothing is left running.
// Run: node scripts/test-launch.js

const path = require('node:path');
const http = require('node:http');

const { openDb } = require('../lib/db.js');
const { createLogger } = require('../lib/log.js');
const { loadGames } = require('../lib/registry.js');
const { buildApp, createServer, listen } = require('../lib/app.js');
const { effectiveMode, createLaunchState, withLaunch, LAUNCH_STATES } = require('../lib/mode.js');
const { requiresStepUp, FAST_WRITES } = require('../lib/admin.js');

let pass = 0, fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else      { fail++; console.error(`  FAIL  ${name}${extra ? ' — ' + extra : ''}`); }
}

const SERVER = path.join(__dirname, '..');
const GAMES = path.join(SERVER, '..', 'games');
const log = createLogger(() => {});

function request(port, { method = 'GET', path: p, headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers, agent: false }, (res) => {
      const parts = [];
      res.on('data', (c) => parts.push(c));
      res.on('end', () => {
        const text = Buffer.concat(parts).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function main() {
  // ── [a] units ───────────────────────────────────────────────────────────────────────
  console.log('\n[a] units: the truth table and the stored value\n');
  // §19.17.2's table, row by row: pool mode ↓ × launch →.
  const TABLE = [
    ['off', 'preview', 'off'], ['off', 'on', 'off'],
    ['preview', 'preview', 'preview'], ['preview', 'on', 'preview'],
    ['on', 'preview', 'preview'], ['on', 'on', 'on'],
  ];
  for (const [p, l, want] of TABLE) {
    ok(`a. pool ${p} × launch ${l} → ${want}`, effectiveMode(p, l) === want, effectiveMode(p, l));
  }
  ok('a. an unknown pool mode reads as off, whatever the launch', ['ON', '', null, undefined, 'true', 'constructor', '__proto__'].every((m) => effectiveMode(m, 'on') === 'off'));
  ok('a. any launch value but the exact "on" reads as preview', ['ON', ' on', '', null, undefined, 'off', 'live', true].every((l) => effectiveMode('on', l) === 'preview'));
  ok('a. the launch states are exactly preview + on (off is the pool\'s switch)', JSON.stringify(LAUNCH_STATES) === '["preview","on"]');

  const fresh = openDb(':memory:', { net: 'mainnet', log });
  const meta = (d) => d.raw.prepare("SELECT value FROM meta WHERE key = 'launch'").get();
  ok('a. a fresh DB writes launch = preview', meta(fresh) && meta(fresh).value === 'preview');
  const ls = createLaunchState({ db: fresh });
  ok('a. …and reads as preview', ls.get() === 'preview');
  fresh.raw.prepare("DELETE FROM meta WHERE key = 'launch'").run();
  ok('a. an absent row (an upgraded DB) reads as preview', ls.get() === 'preview');
  fresh.raw.prepare("INSERT INTO meta (key, value) VALUES ('launch', 'ON')").run();
  ok('a. a junk row ("ON") reads as preview — no case folding', ls.get() === 'preview');
  fresh.raw.prepare("UPDATE meta SET value = 'on' WHERE key = 'launch'").run();
  ok('a. the exact "on" reads as on, live (no cache to go stale)', ls.get() === 'on');
  fresh.migrate();
  ok('a. re-running the migrations leaves the launch state alone', ls.get() === 'on');
  fresh.close();

  const pm = { mode: 'on', chat_enabled: true };
  let lv = 'preview';
  const w = withLaunch({ get: () => pm, start() {}, stop() {}, refresh() {} }, { get: () => lv });
  ok('a. wrapper: pool on + preview → preview, chat kept', w.get().mode === 'preview' && w.get().chat_enabled === true && !w.isOff());
  pm.mode = 'off';
  ok('a. wrapper: pool off → off, and chat reads false even with the pool\'s chat on', w.get().mode === 'off' && w.get().chat_enabled === false && w.isOff());
  pm.mode = 'on'; lv = 'on';
  ok('a. wrapper: pool on + on → on', w.get().mode === 'on' && w.pool().mode === 'on' && w.launch() === 'on');
  pm.chat_enabled = 'true';
  ok('a. wrapper: chat is on only for a real boolean true', w.get().chat_enabled === false);

  // ── setup ───────────────────────────────────────────────────────────────────────────
  let T = Date.UTC(2026, 9, 7, 12, 0, 0);
  const SECRET = 'k'.repeat(20) + 'Q7'.repeat(22);
  const cfg = { net: 'mainnet', poolInternalUrl: 'http://127.0.0.1:9', linkSecretFile: '/nonexistent' };
  const db = openDb(':memory:', { net: 'mainnet', log });
  const fakeLink = {
    secretConfigured: () => true,
    checkSecret: (g) => (g === SECRET ? 'ok' : 'bad'),
    async verifyProof() { return { ok: false, reason: 'no_match' }; },
    async activity() { return { rows: [], dropped: 0 }; },
    async config() { return { ...poolState }; },
  };
  const poolState = { mode: 'on', chat_enabled: true };
  const fakeMode = { get: () => poolState, isOff: () => poolState.mode === 'off', start() {}, stop() {} };
  const app = buildApp({ config: cfg, db, log, clock: () => T, poolLink: fakeLink, mode: fakeMode, registry: loadGames({ gamesDir: GAMES, log }) });
  const srv = createServer(app.handler);
  const { port } = await listen(srv, 0, '127.0.0.1');
  const get = (p) => request(port, { path: p, headers: { Host: 'pool.example', 'X-Real-IP': '203.0.113.9' } });
  function adm(method, rel, body, { stepup = true, user = 'alice', raw } = {}) {
    const h = { 'X-Games-Link': SECRET, 'X-Admin-User': user, 'X-Admin-Stepup': stepup ? '1' : '0' };
    let payload;
    if (raw !== undefined) { payload = raw; h['Content-Type'] = 'application/json'; }
    else if (body !== undefined) { payload = JSON.stringify(body); h['Content-Type'] = 'application/json'; }
    return request(port, { method, path: `/internal/admin/${rel}`, headers: h, body: payload });
  }
  const modRows = () => db.raw.prepare("SELECT admin_user, action, target, details_json FROM mod_actions WHERE action = 'launch' ORDER BY id").all();

  try {
    // ── [b] the effective mode reaches every consumer ─────────────────────────────────
    console.log('\n[b] the effective mode: public routes, chat, rules, health\n');
    ok('b. app.services.mode is the effective view (pool on + fresh DB → preview)', app.services.mode.get().mode === 'preview');
    let r = await get('/play/api/rules');
    ok('b. pool on + launch preview → public routes answer (preview is not off)', r.status === 200 && r.json.ok === true, r.text);
    ok('b. …and chat follows the pool\'s chat switch', r.json.chat && r.json.chat.enabled === true);
    ok('b. …and rules carry the EFFECTIVE mode (preview) — the shell\'s bubble hint reads it (C7)', r.json.mode === 'preview', r.text);
    let h = await get('/play/api/health');
    ok('b. health carries launch: preview', h.status === 200 && h.json.launch === 'preview', h.text);
    ok('b. health is exactly {ok, net, schema, launch, uptime_s}', JSON.stringify(Object.keys(h.json).sort()) === '["launch","net","ok","schema","uptime_s"]', h.text);

    poolState.mode = 'off';
    r = await get('/play/api/rules');
    ok('b. pool off → every public route 404s (launch cannot raise it)', r.status === 404, `${r.status}`);
    r = await get('/play/api/chat?room=lobby');
    ok('b. …chat included', r.status === 404, `${r.status}`);
    h = await get('/play/api/health');
    ok('b. …while health still answers (the probe target is never gated)', h.status === 200 && h.json.launch === 'preview');
    const rAdm = await adm('GET', 'launch');
    ok('b. …and so do the admin routes (the operator prepares while off)', rAdm.status === 200 && rAdm.json.launch === 'preview' && rAdm.json.effective === 'off', rAdm.text);

    poolState.mode = 'preview';
    r = await get('/play/api/rules');
    ok('b. pool preview → public routes answer', r.status === 200);
    ok('b. …rules mode preview', r.json.mode === 'preview');
    poolState.chat_enabled = false;
    r = await get('/play/api/rules');
    ok('b. pool chat off → rules say chat disabled', r.status === 200 && r.json.chat.enabled === false);
    poolState.chat_enabled = true;
    poolState.mode = 'on';

    // ── [c] the admin routes ─────────────────────────────────────────────────────────
    console.log('\n[c] GET / POST /internal/admin/launch\n');
    ok('c. POST launch is a step-up path (not one of the six FAST writes)', requiresStepUp('POST', 'launch') === true
      && !FAST_WRITES.some(([m, re]) => m === 'POST' && re.test('launch')));
    r = await adm('GET', 'launch');
    ok('c. GET launch → both inputs + the result', r.status === 200 && r.json.ok === true && r.json.launch === 'preview'
      && r.json.pool_mode === 'on' && r.json.pool_chat === true && r.json.effective === 'preview', r.text);
    r = await request(port, { path: '/internal/admin/launch', headers: { 'X-Admin-User': 'alice' } });
    ok('c. without the link secret → 401', r.status === 401, `${r.status}`);
    r = await adm('POST', 'launch', { state: 'on' }, { stepup: false });
    ok('c. POST without step-up → 403 step_up_required, nothing changed', r.status === 403 && r.json.error === 'step_up_required'
      && app.services.launch.get() === 'preview' && modRows().length === 0, r.text);
    for (const [label, body] of [
      ['an empty object', {}], ['an array', ['on']], ['state "ON"', { state: 'ON' }], ['state "off" (the pool\'s switch)', { state: 'off' }],
      ['state true', { state: true }], ['an extra key', { state: 'on', note: 'x' }], ['state " on"', { state: ' on' }],
    ]) {
      r = await adm('POST', 'launch', body);
      ok(`c. ${label} → 400`, r.status === 400 && r.json.error === 'bad_request', `${r.status} ${r.text}`);
    }
    ok('c. …and none of them changed anything or wrote a row', app.services.launch.get() === 'preview' && modRows().length === 0);

    r = await adm('POST', 'launch', { state: 'on' });
    ok('c. Go live → 200 {launch:on, effective:on, changed:true}', r.status === 200 && r.json.launch === 'on' && r.json.effective === 'on' && r.json.changed === true, r.text);
    const rRules = await get('/play/api/rules');
    ok('c. …and rules now say mode on (the shell drops the bubble\'s preview hint)', rRules.status === 200 && rRules.json.mode === 'on', rRules.text);
    let rows = modRows();
    ok('c. …one mod_actions row: who, and from → to', rows.length === 1 && rows[0].admin_user === 'alice'
      && JSON.stringify(JSON.parse(rows[0].details_json)) === '{"from":"preview","to":"on"}', JSON.stringify(rows));
    ok('c. …the service follows at once (effective on, health launch on)', app.services.mode.get().mode === 'on'
      && (await get('/play/api/health')).json.launch === 'on');
    r = await adm('POST', 'launch', { state: 'on' }, { user: 'bob' });
    ok('c. Go live again → 200, changed:false, NO second row (idempotent)', r.status === 200 && r.json.changed === false && modRows().length === 1, r.text);
    poolState.mode = 'preview';
    r = await adm('GET', 'launch');
    ok('c. launch on + pool preview → effective preview (the lower of the two)', r.json.effective === 'preview' && r.json.launch === 'on');
    poolState.mode = 'on';
    r = await adm('POST', 'launch', { state: 'preview' }, { user: 'bob' });
    rows = modRows();
    ok('c. Back to preview → 200, a second row by bob', r.status === 200 && r.json.launch === 'preview' && r.json.changed === true
      && rows.length === 2 && rows[1].admin_user === 'bob' && JSON.parse(rows[1].details_json).to === 'preview', r.text);
    ok('c. the stored value is the exact string', db.raw.prepare("SELECT value FROM meta WHERE key = 'launch'").get().value === 'preview');
    r = await adm('POST', 'launch', null, { raw: '{"state":"on"' });
    ok('c. malformed JSON → 400, not a 500', r.status === 400, `${r.status}`);
  } finally {
    await new Promise((res) => srv.close(res));
    db.close();
  }

  console.log(`\nRESULT pass=${pass} fail=${fail}`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); console.log(`\nRESULT pass=${pass} fail=${fail + 1}`); process.exit(1); });
