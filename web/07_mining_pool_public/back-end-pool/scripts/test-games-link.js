// Games platform link — pool side (design §19.3, plan Part 2).
//
// lib/games-link.js is the ONLY pool code the games platform adds: three internal routes the
// games service calls, the admin proxy, the health probe and the public nav flag. The pool is
// live on mainnet and its stratum server shares this process and its one synchronous DB
// connection, so what is pinned here is mostly what must NOT happen:
//   - a wrong or missing secret costs one comparison: no body read, no DB read, no scrypt;
//   - a request that came through nginx (forwarding header) is 404 even with the secret;
//   - verify-proof throttles on the forwarded client IP, never on req.ip (127.0.0.1), and
//     nothing from the proof machinery but ok/method/slot/age_seconds/reason leaves;
//   - activity is ONE bounded statement that SEARCHes idx_hashrate_time, never a scan;
//   - a quoted "false" / "ON" in pool_config never switches anything on;
//   - the admin proxy enforces step-up POOL-side before a byte reaches games;
//   - games down → the nav flag reads 'off', and a bad games config never throws at boot.
//
// Real modules, a temp pool DB, a fake games server on 127.0.0.1:0 — everything is closed at
// the end, nothing is left running. Run: node scripts/test-games-link.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readAppSource } = require('./lib/app-source');
const http = require('http');
const express = require('express');

const APP = path.resolve(__dirname, '..');
const WEB = path.resolve(APP, '..');
const dbFile = path.join(os.tmpdir(), `pool-games-link-${process.pid}-${Date.now()}.sqlite`);
const linkFile = path.join(os.tmpdir(), `grin_pubgames_link_test_${process.pid}_${Date.now()}`);

const { initDb, getDb, createSchema, closeDb } = require(path.join(APP, 'lib/db.js'));
initDb(dbFile);
const db = getDb();
createSchema();

const PoolSettings = require(path.join(APP, 'lib/pool-settings.js'));
const { auditOwnerProof } = require(path.join(APP, 'lib/owner-proof.js'));
const gl = require(path.join(APP, 'lib/games-link.js'));
const { loadConfig } = require(path.join(APP, 'lib/config.js'));

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name} ${extra}`); }
};

const SECRET = 'Q'.repeat(20) + 'x9f8e7d6c5b4a3210ZYXWVUTSRQPONMLKJIHGFEDCBA';   // 64 chars
const MAIN_A = 'grin1' + 'q'.repeat(58);
const MAIN_B = 'grin1' + 'p'.repeat(58);
const TEST_A = 'tgrin1' + 'q'.repeat(58);

// ── fixtures ─────────────────────────────────────────────────────────────────
const nowS = Math.floor(Date.now() / 1000);
let clockMs = nowS * 1000;
const settings = new PoolSettings(db);
const adminId = db.prepare("INSERT INTO users (username, password_hash, is_admin) VALUES ('operator', 'x', 1)").run().lastInsertRowid;

for (const a of [MAIN_A, MAIN_B, 'pool_fee', 'prize_pool']) {
  db.prepare('INSERT INTO miner_accounts (grin_address) VALUES (?)').run(a);
}
const hr = db.prepare('INSERT INTO hashrate_history (grin_address, hashrate_gps, window_seconds, recorded_at) VALUES (?, ?, 60, ?)');
const T0 = nowS - 1800;                       // window (T0, T0+600]
for (let i = 1; i <= 10; i++) hr.run(MAIN_A, 1.5, T0 + i * 60);   // 10 active minutes, the last AT to
for (let i = 1; i <= 3; i++) hr.run(MAIN_B, 0.7, T0 + i * 60);    // 3
hr.run(MAIN_B, 0, T0 + 240);                  // a zero-hashrate row does not count
hr.run(MAIN_A, 2.0, T0);                      // AT from: excluded (recorded_at > from)
hr.run(MAIN_A, 2.0, T0 + 601);                // after to: excluded
hr.run('pool_fee', 5.0, T0 + 120);            // reserved pseudo-addresses: excluded
hr.run('prize_pool', 5.0, T0 + 120);

// ── the app under test: exactly index.js's mount order ──────────────────────
let verifyCalls = [];
let verifyResult = { ok: true, reason: 'match', method: 'password', slot: 'set', age_seconds: 90000,
                     hash: 'deadbeef', salt: 'cafe', proof_salt: 'x', row: { id: 1 } };
let healthFlips = [];
let stepUpCalls = 0;
let stepUpFresh = false;
let secureCalls = 0;

const link = gl.createGamesLink({ now: () => clockMs });
const app = express();
app.use(link.internal);
app.use(express.json());
const fakeSecureAdmin = [(req, res, next) => { secureCalls++; req.user = { user_id: adminId, username: 'operator' }; next(); }];
const stepUpRefused = (req, res) => {
  stepUpCalls++;
  if (stepUpFresh) return false;
  res.status(403).json({ error: 'Session expired', challenge_required: true });
  return true;
};
link.mountAdmin(app, { secureAdmin: fakeSecureAdmin, stepUpRefused });
app.use((req, res) => res.status(404).json({ error: 'pool 404' }));

// Fake games service: /play/api/health + /internal/admin/*.
let gamesSeen = [];
let gamesHealth = { status: 200, body: { ok: true, net: 'mainnet', schema: 1, uptime_s: 42 } };
let gamesAdmin = (req, body, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, echo: body })); };
const gamesSrv = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8');
    gamesSeen.push({ method: req.method, url: req.url, headers: req.headers, body });
    if (req.url === '/play/api/health') {
      res.writeHead(gamesHealth.status, { 'Content-Type': 'application/json' });
      return res.end(typeof gamesHealth.body === 'string' ? gamesHealth.body : JSON.stringify(gamesHealth.body));
    }
    gamesAdmin(req, body, res);
  });
});

function call(port, { method = 'GET', p, headers = {}, body, raw }) {
  return new Promise((resolve, reject) => {
    const data = raw !== undefined ? raw : (body === undefined ? undefined : JSON.stringify(body));
    const h = { ...headers };
    if (data !== undefined && h['Content-Length'] === undefined) h['Content-Length'] = Buffer.byteLength(data);
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: h, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch (e) { /* not JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (data !== undefined) req.write(data);
    req.end();
  });
}
const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
const closePort = async () => { const s = http.createServer(); const p = await listen(s); await new Promise((r) => s.close(r)); return p; };
const writeLink = (v) => fs.writeFileSync(linkFile, v);
const J = { 'Content-Type': 'application/json' };
const L = (extra) => ({ 'X-Games-Link': SECRET, ...(extra || {}) });

(async () => {
  let srv;
  try {
    const gamesPort = await listen(gamesSrv);
    srv = app.listen(0, '127.0.0.1');
    await new Promise((r) => srv.on('listening', r));
    const port = srv.address().port;
    const config = { network: 'mainnet', port: 8080, games_port: gamesPort, games_link_secret_file: linkFile };
    link.attach({ db, config, poolSettings: settings, auditOwnerProof, startProbe: false,
      verifyOwnerProof: async (...args) => { verifyCalls.push(args); return verifyResult; },
      onHealthChange: (h) => healthFlips.push(h) });

    console.log('\n[1] link secret: missing / short / wrong / right / rotation');
    {
      let r = await call(port, { p: '/internal/games/config', headers: L() });
      ok('no link file → 503 link_not_configured', r.status === 503 && r.json && r.json.error === 'link_not_configured', r.text);
      writeLink('short-secret-31-bytes-xxxxxxxxx');   // 31 bytes
      clockMs += 1001;
      r = await call(port, { p: '/internal/games/config', headers: L() });
      ok('a < 32-byte file is "not configured" (503)', r.status === 503 && r.json.error === 'link_not_configured', r.text);
      writeLink(SECRET + '\n');                        // the trailing newline is not part of it
      clockMs += 1001;
      r = await call(port, { p: '/internal/games/config' });
      ok('no header → 401 unauthorised', r.status === 401 && r.json.error === 'unauthorised' && r.json.ok === false, r.text);
      r = await call(port, { p: '/internal/games/config', headers: { 'X-Games-Link': SECRET.slice(0, -1) + 'y' } });
      ok('wrong secret (same length) → the SAME 401', r.status === 401 && r.json.error === 'unauthorised');
      r = await call(port, { p: '/internal/games/config', headers: { 'X-Games-Link': 'short' } });
      ok('wrong secret (other length) → the SAME 401', r.status === 401 && r.json.error === 'unauthorised');
      r = await call(port, { p: '/internal/games/config', headers: L() });
      ok('right secret (file had a trailing newline) → 200', r.status === 200 && r.json.ok === true, r.text);
      ok('every internal response is Cache-Control: no-store', r.headers['cache-control'] === 'no-store');

      const NEW = 'N'.repeat(64);
      writeLink(NEW);
      fs.utimesSync(linkFile, new Date(), new Date(Date.now() + 5000));
      r = await call(port, { p: '/internal/games/config', headers: L() });
      ok('rotation inside the 1 s stat memo: old secret still accepted (bounded window)', r.status === 200);
      clockMs += 1001;
      r = await call(port, { p: '/internal/games/config', headers: L() });
      ok('after the memo: the OLD secret → 401 (rotation needs no restart)', r.status === 401);
      r = await call(port, { p: '/internal/games/config', headers: { 'X-Games-Link': NEW } });
      ok('…and the NEW one → 200', r.status === 200);
      writeLink(SECRET);
      fs.utimesSync(linkFile, new Date(), new Date(Date.now() + 10000));
      clockMs += 1001;
    }

    console.log('\n[2] guard 2: forwarded / off-box requests are 404 even with the secret');
    {
      let r = await call(port, { p: '/internal/games/config', headers: L({ 'X-Forwarded-For': '203.0.113.9' }) });
      ok('X-Forwarded-For → 404 not_found', r.status === 404 && r.json.error === 'not_found', r.text);
      r = await call(port, { p: '/internal/games/config', headers: L({ 'X-Real-IP': '203.0.113.9' }) });
      ok('X-Real-IP → 404 not_found', r.status === 404 && r.json.error === 'not_found');
      r = await call(port, { p: '/internal/games/nope', headers: L() });
      ok('unknown internal path (authenticated) → 404 JSON from the lib, not the pool', r.status === 404 && r.json.error === 'not_found');
      r = await call(port, { method: 'POST', p: '/internal/games/config', headers: L(J), body: {} });
      ok('wrong method on a known path → 404', r.status === 404);
      r = await call(port, { p: '/internal/games/config' , headers: L({ 'X-Forwarded-For': '1.2.3.4' }) });
      ok('…and the forwarding check comes before the secret check (no 401 oracle through nginx)', r.status === 404);
      r = await call(port, { p: '/api/health' });
      ok('non-/internal paths pass straight through to the pool', r.status === 404 && r.json.error === 'pool 404');
    }

    console.log('\n[3] the secret is checked before the body, the DB and the scrypt');
    {
      verifyCalls = [];
      let r = await call(port, { method: 'POST', p: '/internal/games/verify-proof',
        headers: { ...J, 'X-Games-Link': 'wrong' }, raw: 'x'.repeat(10000) });
      ok('wrong secret + a 10 KB body → 401, not 413 (the body was never read)', r.status === 401, `${r.status}`);
      ok('…and verifyOwnerProof (scrypt) was never called', verifyCalls.length === 0);
      r = await call(port, { method: 'POST', p: '/internal/games/verify-proof', headers: J,
        body: { address: MAIN_A, proof: 'hunter2hunter2', client_ip: '198.51.100.7' } });
      ok('no secret + a valid body → 401, verify not called', r.status === 401 && verifyCalls.length === 0);
    }

    console.log('\n[4] POST /internal/games/verify-proof');
    {
      const good = { address: MAIN_A, proof: 'hunter2hunter2', client_ip: '198.51.100.7' };
      verifyCalls = [];
      let r = await call(port, { method: 'POST', p: '/internal/games/verify-proof', headers: L(J), body: good });
      ok('valid → 200', r.status === 200, r.text);
      ok('client_ip is what reaches verifyOwnerProof (never req.ip)',
         verifyCalls.length === 1 && verifyCalls[0][1] === MAIN_A && verifyCalls[0][2] === 'hunter2hunter2' && verifyCalls[0][3] === '198.51.100.7',
         JSON.stringify(verifyCalls[0] && verifyCalls[0].slice(1)));
      ok('success carries exactly ok/method/slot/age_seconds',
         JSON.stringify(Object.keys(r.json).sort()) === JSON.stringify(['age_seconds', 'method', 'ok', 'slot']), r.text);
      ok('…never a hash, salt, row or the proof (the stub returned all four)',
         !/deadbeef|cafe|proof_salt|hunter2|"row"/.test(r.text), r.text);
      ok('…typed: method password, slot set, age 90000', r.json.method === 'password' && r.json.slot === 'set' && r.json.age_seconds === 90000);
      const audit = db.prepare("SELECT action, target_id, ip, details FROM admin_audit_log WHERE action LIKE 'owner_proof:games_login:%' ORDER BY id DESC LIMIT 1").get();
      ok("audited as owner_proof:games_login:ok, on the CLIENT ip (coarsened)",
         audit && audit.action === 'owner_proof:games_login:ok' && audit.target_id === MAIN_A && /^198\.51\.100\./.test(audit.ip || ''), JSON.stringify(audit));

      verifyResult = { ok: true, method: 'ip', slot: 'anchor', age_seconds: null };
      r = await call(port, { method: 'POST', p: '/internal/games/verify-proof', headers: L(J), body: good });
      ok('anchor slot + unknown age pass through as anchor / null', r.json.slot === 'anchor' && r.json.age_seconds === null && r.json.method === 'ip', r.text);

      verifyResult = { ok: false, reason: 'too_many_attempts', hash: 'deadbeef' };
      r = await call(port, { method: 'POST', p: '/internal/games/verify-proof', headers: L(J), body: good });
      ok('a failed proof → 200 {ok:false, reason} with the reason verbatim', r.status === 200 && r.json.ok === false && r.json.reason === 'too_many_attempts'
         && Object.keys(r.json).length === 2, r.text);
      const denied = db.prepare("SELECT action, details FROM admin_audit_log WHERE action = 'owner_proof:games_login:deny' ORDER BY id DESC LIMIT 1").get();
      ok('…audited as a deny with the reason', denied && /too_many_attempts/.test(denied.details), JSON.stringify(denied));
      verifyResult = { ok: true, method: 'password', slot: 'set', age_seconds: 5 };

      const bad = async (name, body, field, status = 400, headers = L(J)) => {
        verifyCalls = [];
        const x = await call(port, { method: 'POST', p: '/internal/games/verify-proof', headers, body });
        ok(name, x.status === status && (field === null || (x.json && x.json.field === field)) && verifyCalls.length === 0, `${x.status} ${x.text}`);
      };
      await bad('no client_ip → 400 client_ip (never a fallback to req.ip)', { address: MAIN_A, proof: 'hunter2hunter2' }, 'client_ip');
      await bad('client_ip 127.0.0.1 → 400 (a broken X-Real-IP chain must be loud)', { ...good, client_ip: '127.0.0.1' }, 'client_ip');
      await bad('client_ip ::1 → 400', { ...good, client_ip: '::1' }, 'client_ip');
      await bad('client_ip ::ffff:127.0.0.1 → 400', { ...good, client_ip: '::ffff:127.0.0.1' }, 'client_ip');
      await bad('client_ip 0.0.0.0 → 400', { ...good, client_ip: '0.0.0.0' }, 'client_ip');
      await bad('client_ip not an IP → 400', { ...good, client_ip: 'example.com' }, 'client_ip');
      await bad('malformed address → 400 address', { ...good, address: 'grin1xyz' }, 'address');
      await bad('a TESTNET address on a mainnet pool → 400 address', { ...good, address: TEST_A }, 'address');
      await bad('the prize_pool pseudo-account → 400 address', { ...good, address: 'prize_pool' }, 'address');
      await bad('empty proof → 400 proof', { ...good, proof: '' }, 'proof');
      await bad('257-char proof → 400 proof', { ...good, proof: 'p'.repeat(257) }, 'proof');
      await bad('non-string proof → 400 proof', { ...good, proof: 12345678 }, 'proof');
      await bad('an unknown key → 400 naming it', { ...good, extra: 1 }, 'extra');
      await bad('wrong content type → 415', good, null, 415, L({ 'Content-Type': 'text/plain' }));
      verifyCalls = [];
      let x = await call(port, { method: 'POST', p: '/internal/games/verify-proof', headers: L(J),
        body: { ...good, proof: 'p'.repeat(250), pad: 'z'.repeat(2000) } });
      ok('a body over 2 KB → 413 (declared length)', x.status === 413 && verifyCalls.length === 0, `${x.status}`);
      x = await call(port, { method: 'POST', p: '/internal/games/verify-proof', headers: L(J), raw: '[1,2]' });
      ok('a JSON array body → 400 body', x.status === 400 && x.json.field === 'body');
      x = await call(port, { method: 'POST', p: '/internal/games/verify-proof', headers: L(J), raw: '{nope' });
      ok('invalid JSON → 400 body', x.status === 400 && x.json.field === 'body');
    }

    console.log('\n[5] GET /internal/games/activity');
    {
      const from = T0, to = T0 + 600;
      let r = await call(port, { p: `/internal/games/activity?from=${from}&to=${to}`, headers: L() });
      ok('valid window → 200', r.status === 200 && r.json.ok === true && r.json.from === from && r.json.to === to, r.text);
      const rows = Object.fromEntries((r.json.rows || []).map((x) => [x.address, x]));
      ok('A: 10 minutes / 600 s (the row AT `to` counts, the row AT `from` does not)',
         rows[MAIN_A] && rows[MAIN_A].minutes === 10 && rows[MAIN_A].seconds === 600, JSON.stringify(rows[MAIN_A]));
      ok('B: 3 minutes — a hashrate_gps = 0 row is not an active minute', rows[MAIN_B] && rows[MAIN_B].minutes === 3, JSON.stringify(rows[MAIN_B]));
      ok('pool_fee / prize_pool are excluded', !rows.pool_fee && !rows.prize_pool);
      ok('rows carry exactly address/minutes/seconds', (r.json.rows || []).every((x) => JSON.stringify(Object.keys(x).sort()) === '["address","minutes","seconds"]'));

      const bad = async (q, field) => {
        const x = await call(port, { p: `/internal/games/activity?${q}`, headers: L() });
        ok(`?${q.length > 60 ? q.slice(0, 60) + '…' : q} → 400 ${field}`, x.status === 400 && x.json.field === field, `${x.status} ${x.text}`);
      };
      await bad(`from=${to}&to=${to}`, 'window');                 // 0-length
      await bad(`from=${to}&to=${from}`, 'window');               // negative
      await bad(`from=${nowS - 4000}&to=${nowS}`, 'window');      // > 3600
      await bad(`from=abc&to=${to}`, 'from');                     // NaN
      await bad(`from=${from}&to=NaN`, 'to');
      await bad(`from=-5&to=${to}`, 'from');
      await bad(`from=${from}.5&to=${to}`, 'from');
      await bad(`from=1e3&to=${to}`, 'from');
      await bad(`from=0x10&to=${to}`, 'from');
      await bad(`from=Infinity&to=${to}`, 'from');
      await bad(`to=${to}`, 'from');                               // missing
      await bad(`from=${from}&from=${from}&to=${to}`, 'from');     // repeated
      await bad(`from=${from}&to=${to}&x=1`, 'x');                 // unknown key
      await bad(`from=${nowS - 60}&to=${nowS + 60}`, 'to');        // to > now
      await bad(`from=0&to=3600`, 'from');                         // older than 7 days
      await bad(`from=${nowS - 8 * 86400}&to=${nowS - 8 * 86400 + 60}`, 'from');
    }

    console.log('\n[6] the activity query plan is an index SEARCH, never a scan');
    {
      const plan = db.prepare('EXPLAIN QUERY PLAN ' + gl.ACTIVITY_SQL).all(1, 2, 'pool_fee', 'prize_pool')
        .map((r) => r.detail).join(' | ');
      ok('plan SEARCHes idx_hashrate_time', /SEARCH hashrate_history USING (COVERING )?INDEX idx_hashrate_time/.test(plan), plan);
      ok("plan never contains 'SCAN hashrate_history'", !/SCAN hashrate_history/.test(plan), plan);
      ok('ONE statement, pinned with INDEXED BY (a dropped index fails loudly, never scans)',
         /INDEXED BY idx_hashrate_time/.test(gl.ACTIVITY_SQL) && gl.ACTIVITY_SQL.split(';').length === 1);
      ok('the reserved-address placeholders are bound from RESERVED_ADDRESSES',
         /NOT IN \(\?, \?\)/.test(gl.ACTIVITY_SQL) && !/pool_fee|prize_pool/.test(gl.ACTIVITY_SQL));
    }

    console.log('\n[7] GET /internal/games/config + the typed settings');
    {
      let r = await call(port, { p: '/internal/games/config', headers: L() });
      ok('defaults: on / chat true / mainnet (§19.17.2, D30)', r.json.mode === 'on' && r.json.chat_enabled === true && r.json.net === 'mainnet', r.text);
      ok('the shipped default is ON + chat on — the games\' launch state is what keeps a fresh install hidden (D30)',
         PoolSettings.defaults.games.mode === 'on' && PoolSettings.defaults.games.chat_enabled === true);
      settings.updateSection('games', { mode: 'off', chat_enabled: false }, adminId);
      r = await call(port, { p: '/internal/games/config', headers: L() });
      ok('a SAVED row overrides the default (the live pool may have saved off)', r.json.mode === 'off' && r.json.chat_enabled === false, r.text);

      settings.updateSection('games', { mode: 'preview', chat_enabled: true }, adminId);
      r = await call(port, { p: '/internal/games/config', headers: L() });
      ok('preview + chat round-trip through updateSection', r.json.mode === 'preview' && r.json.chat_enabled === true, r.text);
      const stored = db.prepare("SELECT value, value_type FROM pool_config WHERE section='games' AND key='chat_enabled'").get();
      ok('chat_enabled is stored as a BOOLEAN row', stored && stored.value_type === 'boolean' && stored.value === 'true', JSON.stringify(stored));

      // Hand-written rows of the wrong type — what a quoted value or an old writer leaves behind.
      const put = db.prepare("INSERT INTO pool_config (section, key, value, value_type) VALUES ('games', ?, ?, ?) ON CONFLICT(section, key) DO UPDATE SET value = excluded.value, value_type = excluded.value_type");
      put.run('chat_enabled', 'false', 'string');
      put.run('mode', 'ON', 'string');
      r = await call(port, { p: '/internal/games/config', headers: L() });
      ok('a STRING "false" chat row reads false (never truthy)', r.json.chat_enabled === false, r.text);
      ok('mode "ON" (wrong case) reads as off', r.json.mode === 'off');
      put.run('mode', 'true', 'boolean');
      put.run('chat_enabled', '1', 'string');
      r = await call(port, { p: '/internal/games/config', headers: L() });
      ok('a boolean-typed mode row reads as off; chat "1" reads false', r.json.mode === 'off' && r.json.chat_enabled === false, r.text);

      const throws = (key, val) => { try { settings.updateSection('games', { [key]: val }, adminId); return false; } catch (e) { return true; } };
      ok('validator refuses mode "ON" / " on" / true / "" / "enabled"',
         throws('mode', 'ON') && throws('mode', ' on') && throws('mode', true) && throws('mode', '') && throws('mode', 'enabled'));
      ok('validator refuses chat_enabled "yes" / 1 / "False" / null',
         throws('chat_enabled', 'yes') && throws('chat_enabled', 1) && throws('chat_enabled', 'False') && throws('chat_enabled', null));
      ok('an unknown games key is refused (the port/secret path are NOT settings)',
         throws('games_port', 9000) && throws('games_link_secret_file', '/etc/shadow'));
      settings.updateSection('games', { mode: 'on', chat_enabled: 'false' }, adminId);
      const g = settings.getSection('games');
      ok("chat_enabled 'false' (exact string) is accepted and stored as boolean false", g.chat_enabled === false && g.mode === 'on', JSON.stringify(g));
      const auditRow = db.prepare("SELECT details FROM admin_audit_log WHERE action = 'update_settings' AND target_id = 'games' ORDER BY id DESC LIMIT 1").get();
      ok('a games settings write leaves an update_settings audit row', !!auditRow);

      // The name lists ride on the same answer (§19.17.5, D28) — no second route.
      r = await call(port, { p: '/internal/games/config', headers: L() });
      ok('config carries blocked_words (empty by default — the seed is the games\' own) and pool_name',
        Array.isArray(r.json.blocked_words) && r.json.blocked_words.length === 0 && r.json.pool_name === settings.getSection('pool_info').pool_name, r.text);
      settings.updateSection('names', { blocked_words: 'Rug Pull\n*cr4p\n=Scammer\nrugpull' }, adminId);
      r = await call(port, { p: '/internal/games/config', headers: L() });
      ok('…the operator list arrives folded, prefixes kept, duplicates gone', JSON.stringify(r.json.blocked_words) === '["rugpull","*crap","=scammer"]', r.text);
      const putName = db.prepare("INSERT INTO pool_config (section, key, value, value_type) VALUES ('names', 'blocked_words', ?, 'string') ON CONFLICT(section, key) DO UPDATE SET value = excluded.value");
      putName.run('ok\nNOT FOLDED\n<script>\n**x\ngood2');
      r = await call(port, { p: '/internal/games/config', headers: L() });
      ok('…a hand-edited row is re-filtered on read (only validator-shaped entries leave the pool)', JSON.stringify(r.json.blocked_words) === '["ok","good2"]', r.text);
      putName.run(Array.from({ length: 600 }, (_, i) => `w${i}`).join('\n'));
      r = await call(port, { p: '/internal/games/config', headers: L() });
      ok('…and capped at 500 entries', r.json.blocked_words.length === 500);
      settings.updateSection('names', { blocked_words: '' }, adminId);
    }

    console.log('\n[8] health probe → the public nav flag (effective mode, §19.17.2)');
    {
      // mode is 'on' from [7]; the probe has not run (startProbe:false).
      ok("before any probe: publicFlag is off even with mode 'on'", link.publicFlag().mode === 'off');
      healthFlips = [];
      // The fake's first answer has no `launch` — an older games build, or a typo: preview.
      let p = await link.probeOnce();
      ok('healthy games service → probe healthy, schema/uptime recorded', p.healthy === true && p.schema === 1 && p.uptime_s === 42, JSON.stringify(p));
      ok('…a health answer with NO launch field reads as preview', p.launch === 'preview');
      ok("…so pool 'on' + launch preview → publicFlag 'preview' (the nav stays hidden)", link.publicFlag().mode === 'preview' && link.publicFlag().chat === false);
      ok('…and the flip fired onHealthChange (branding memo flush)', healthFlips.length === 1 && healthFlips[0] === true);
      ok('publicFlag carries exactly {mode, chat} — no port, no path, no secret, no launch',
         JSON.stringify(Object.keys(link.publicFlag()).sort()) === '["chat","mode"]');
      gamesHealth = { status: 200, body: { ok: true, net: 'mainnet', schema: 1, launch: 'on', uptime_s: 42 } };
      p = await link.probeOnce();
      ok("launch 'on' → publicFlag reports 'on'", p.launch === 'on' && link.publicFlag().mode === 'on');
      ok('…and the LAUNCH flip (healthy both times) also flushed the branding memo', healthFlips.length === 2 && healthFlips[1] === true);
      await link.probeOnce();
      ok('…an unchanged answer flushes nothing', healthFlips.length === 2);
      for (const junk of ['ON', ' on', 'live', true, 1, null]) {
        gamesHealth = { status: 200, body: { ok: true, net: 'mainnet', schema: 1, launch: junk, uptime_s: 42 } };
        await link.probeOnce();
        if (link.publicFlag().mode !== 'preview') { ok(`launch ${JSON.stringify(junk)} reads as preview`, false, link.publicFlag().mode); }
      }
      ok('any launch value but the exact "on" reads as preview (ON, " on", live, true, 1, null)', link.publicFlag().mode === 'preview');
      gamesHealth = { status: 200, body: { ok: true, net: 'mainnet', schema: 1, launch: 'on', uptime_s: 42 } };
      await link.probeOnce();

      gamesHealth = { status: 200, body: { ok: true, net: 'testnet', schema: 1, launch: 'on', uptime_s: 1 } };
      p = await link.probeOnce();
      ok('the OTHER network answering on the port → unhealthy (wrong_network), flag off, launch forgotten',
         p.healthy === false && p.reason === 'wrong_network' && p.launch === null && link.publicFlag().mode === 'off', JSON.stringify(p));
      gamesHealth = { status: 503, body: { ok: false, error: 'db_unavailable' } };
      await link.probeOnce();
      ok('games answering 503 → flag off', link.publicFlag().mode === 'off');
      gamesHealth = { status: 200, body: '<html>' };
      await link.probeOnce();
      ok('non-JSON health → flag off', link.publicFlag().mode === 'off');
      gamesHealth = { status: 200, body: { ok: true, net: 'mainnet', schema: 1, launch: 'on', uptime_s: 43 } };
      await link.probeOnce();
      ok('back to healthy → flag on again', link.publicFlag().mode === 'on');

      const dead = gl.createGamesLink();
      dead.attach({ db, config: { network: 'mainnet', port: 8080, games_port: await closePort(), games_link_secret_file: linkFile },
        poolSettings: settings, verifyOwnerProof: async () => ({}), auditOwnerProof, startProbe: false });
      p = await dead.probeOnce();
      ok("games DOWN (closed port) + mode 'on' → probe unreachable, flag off (nav hides, D12)",
         p.healthy === false && p.reason === 'unreachable' && dead.publicFlag().mode === 'off', JSON.stringify(p));

      settings.updateSection('games', { chat_enabled: true }, adminId);
      ok('healthy + on + chat → {mode:on, chat:true}', link.publicFlag().chat === true);
      settings.updateSection('games', { mode: 'off' }, adminId);
      ok('mode off → chat reported false even with chat_enabled on', link.publicFlag().mode === 'off' && link.publicFlag().chat === false);
      settings.updateSection('games', { mode: 'preview' }, adminId);
      ok("preview → the payload says 'preview' (branding.js shows the link only on 'on')", link.publicFlag().mode === 'preview' && link.publicFlag().chat === true);

      // §19.17.2's whole table, through the real publicFlag(): pool mode ↓ × launch →.
      const TABLE = [['off', 'preview', 'off'], ['off', 'on', 'off'], ['preview', 'preview', 'preview'],
        ['preview', 'on', 'preview'], ['on', 'preview', 'preview'], ['on', 'on', 'on']];
      const got = [];
      for (const [m, l, want] of TABLE) {
        settings.updateSection('games', { mode: m }, adminId);
        gamesHealth = { status: 200, body: { ok: true, net: 'mainnet', schema: 1, launch: l, uptime_s: 44 } };
        await link.probeOnce();
        const f = link.publicFlag();
        got.push(`${m}×${l}=${f.mode}`);
        if (f.mode !== want || f.chat !== (want !== 'off')) got.push('WRONG');
      }
      ok('the truth table: effective = min(pool mode, launch), chat only when not off', !got.includes('WRONG'), got.join(' '));
      // D5: the two sides keep their own copy of the rule — they must agree on every input.
      const gm = require(path.join(WEB, 'play/server/lib/mode.js'));
      const inputs = ['off', 'preview', 'on', 'ON', '', null, undefined, 'constructor', true];
      const disagree = [];
      for (const a of inputs) for (const b of inputs) {
        if (gl.effectiveMode(a, b) !== gm.effectiveMode(a, b)) disagree.push(`${a}×${b}`);
      }
      ok('the pool and the games copies of effectiveMode agree on every input (incl. junk)', disagree.length === 0, disagree.join(', '));
      settings.updateSection('games', { mode: 'preview' }, adminId);
    }

    console.log('\n[9] admin proxy: step-up, headers, transport');
    {
      const A = (p, o = {}) => call(port, { p: `/api/admin/games/${p}`, ...o });
      gamesSeen = [];
      stepUpCalls = 0;
      let r = await A('players?limit=20');
      const seen = gamesSeen[0] || { headers: {} };
      ok('GET passes on a plain admin session (no step-up asked)', r.status === 200 && stepUpCalls === 0, `${r.status} ${r.text}`);
      ok('…forwarded to /internal/admin/<path>?<query>', seen.url === '/internal/admin/players?limit=20', seen.url);
      ok('…with X-Games-Link = the secret', seen.headers['x-games-link'] === SECRET);
      ok('…X-Admin-User = the JWT username', seen.headers['x-admin-user'] === 'operator');
      ok('…X-Admin-Stepup: 0 on a non-step-up request', seen.headers['x-admin-stepup'] === '0');
      ok('…and a well-formed X-Request-Id (the games side keeps /^[A-Za-z0-9_-]{8,64}$/)', /^[A-Za-z0-9_-]{8,64}$/.test(seen.headers['x-request-id'] || ''));
      ok('secureAdmin ran for it', secureCalls > 0);
      ok('the proxied response is no-store', r.headers['cache-control'] === 'no-store');

      for (const [m, p] of [['POST', 'players/grin1abc/ban'], ['POST', 'players/grin1abc/unban'], ['POST', 'chat/purge'],
                            ['POST', 'matches/17/void'], ['POST', 'players/grin1abc/adjust'], ['POST', 'events/3/cancel'],
                            ['POST', 'settings'], ['POST', 'events/3/finalise'], ['POST', 'something/new'], ['DELETE', 'events/3']]) {
        gamesSeen = [];
        stepUpFresh = false;
        r = await A(p, { method: m, headers: J, body: { x: 1 } });
        ok(`${m} ${p} without step-up → 403 challenge, nothing sent to games`, r.status === 403 && r.json.challenge_required === true && gamesSeen.length === 0, `${r.status} ${gamesSeen.length}`);
      }
      gamesSeen = [];
      stepUpFresh = true;
      r = await A('players/grin1abc/ban', { method: 'POST', headers: J, body: { days: 3 } });
      const ban = gamesSeen[0] || { headers: {} };
      ok('…with step-up → proxied, X-Admin-Stepup: 1, body forwarded as JSON',
         r.status === 200 && ban.headers['x-admin-stepup'] === '1' && JSON.parse(ban.body || '{}').days === 3 && ban.headers['content-type'] === 'application/json', `${r.status} ${ban.body}`);
      const gaudit = db.prepare("SELECT admin_id, target_id, details FROM admin_audit_log WHERE action = 'games_admin' ORDER BY id DESC LIMIT 1").get();
      ok('…and one pool audit row games_admin (admin, method, path, status)',
         gaudit && gaudit.admin_id === adminId && gaudit.target_id === 'players/grin1abc/ban' && /"method":"POST"/.test(gaudit.details) && /"status":200/.test(gaudit.details), JSON.stringify(gaudit));
      stepUpFresh = false;

      // Go live / Back to preview (§19.17.2): step-up like every non-FAST write, and a 200
      // re-probes at once so the nav follows without waiting for the 60 s tick.
      ok('POST launch is step-up pool-side (not a FAST write)', gl.requiresStepUp('POST', 'launch') === true);
      gamesSeen = [];
      r = await A('launch', { method: 'POST', headers: J, body: { state: 'on' } });
      ok('POST launch without step-up → 403 challenge, nothing sent to games', r.status === 403 && r.json.challenge_required === true && gamesSeen.length === 0, `${r.status}`);
      gamesSeen = [];
      stepUpFresh = true;
      settings.updateSection('games', { mode: 'on' }, adminId);
      gamesHealth = { status: 200, body: { ok: true, net: 'mainnet', schema: 1, launch: 'preview', uptime_s: 45 } };
      await link.probeOnce();
      ok('(setup) pool on + launch preview → flag preview', link.publicFlag().mode === 'preview');
      gamesSeen = [];
      gamesHealth = { status: 200, body: { ok: true, net: 'mainnet', schema: 1, launch: 'on', uptime_s: 46 } };
      r = await A('launch', { method: 'POST', headers: J, body: { state: 'on' } });
      for (let i = 0; i < 40 && link.publicFlag().mode !== 'on'; i++) await new Promise((res) => setTimeout(res, 25));
      ok('…with step-up → proxied with X-Admin-Stepup: 1', r.status === 200 && gamesSeen[0] && gamesSeen[0].url === '/internal/admin/launch' && gamesSeen[0].headers['x-admin-stepup'] === '1', `${r.status}`);
      ok('…then the pool re-probes health at once and the flag follows (no 60 s wait)',
         gamesSeen.some((g) => g.url === '/play/api/health') && link.publicFlag().mode === 'on', JSON.stringify(gamesSeen.map((g) => g.url)));
      gamesSeen = [];
      r = await A('launch');
      await new Promise((res) => setTimeout(res, 50));
      ok('a GET launch re-probes nothing', r.status === 200 && !gamesSeen.some((g) => g.url === '/play/api/health'));
      gamesSeen = [];
      gamesAdmin = (req, body, res) => { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end('{"ok":false,"error":"bad_request","field":"state"}'); };
      r = await A('launch', { method: 'POST', headers: J, body: { state: 'nope' } });
      await new Promise((res) => setTimeout(res, 50));
      ok('a refused POST launch (400) re-probes nothing', r.status === 400 && !gamesSeen.some((g) => g.url === '/play/api/health'));
      gamesAdmin = (req, body, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, echo: body })); };
      stepUpFresh = false;
      settings.updateSection('games', { mode: 'preview' }, adminId);

      for (const p of ['chat/messages/991/delete', 'players/grin1abc/mute', 'chat/held/5/approve', 'chat/post', 'events', 'events/3']) {
        gamesSeen = [];
        stepUpCalls = 0;
        r = await A(p, { method: 'POST', headers: J, body: {} });
        ok(`fast write POST ${p} → secureAdmin only, Stepup: 0`, r.status === 200 && stepUpCalls === 0 && gamesSeen[0] && gamesSeen[0].headers['x-admin-stepup'] === '0', `${r.status}`);
      }
      const before = db.prepare("SELECT COUNT(*) AS c FROM admin_audit_log WHERE action = 'games_admin'").get().c;
      await A('chat/post', { method: 'POST', headers: J, body: { text: 'hi' } });
      ok('fast writes add no pool audit row (the games mod log has them)', db.prepare("SELECT COUNT(*) AS c FROM admin_audit_log WHERE action = 'games_admin'").get().c === before);

      for (const p of ['..%2Fconfig', '%2e%2e/x', 'a/../b', '.hidden', 'a//b', 'a%2Fb', 'a+b']) {
        gamesSeen = [];
        r = await A(p);
        ok(`path "${p}" → 400 bad_path, nothing sent`, r.status === 400 && r.json.error === 'bad_path' && gamesSeen.length === 0, `${r.status} ${r.text}`);
      }
      r = await A('players?q=<script>');
      ok('a query with unsafe characters → 400 bad_query', r.status === 400 && r.json.error === 'bad_query', `${r.status}`);
      r = await call(port, { p: '/api/admin/games/x', method: 'OPTIONS' });
      ok('an unsupported method → 405', r.status === 405, `${r.status}`);

      gamesAdmin = (req, body, res) => { res.writeHead(418, { 'Content-Type': 'application/json' }); res.end('{"ok":false,"error":"teapot"}'); };
      r = await A('players');
      ok('games status + JSON body pass through unchanged', r.status === 418 && r.json.error === 'teapot', `${r.status} ${r.text}`);
      gamesAdmin = (req, body, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<html>'); };
      r = await A('players');
      ok('non-JSON from games → 502 games_bad_response', r.status === 502 && r.json.error === 'games_bad_response', `${r.status}`);
      gamesAdmin = () => { /* never answers */ };
      const t0 = Date.now();
      r = await A('players');
      ok('games hangs → 503 games_offline within the 2 s budget', r.status === 503 && r.json.error === 'games_offline' && Date.now() - t0 < 3500, `${r.status} ${Date.now() - t0}ms`);
      gamesAdmin = (req, body, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}'); };

      stepUpFresh = true;
      r = await A('chat/post', { method: 'POST', headers: J, raw: JSON.stringify({ t: 'z'.repeat(70 * 1024) }) });
      ok('a body over 64 KB → 413', r.status === 413, `${r.status}`);
      stepUpFresh = false;

      const offline = gl.createGamesLink();
      const offApp = express();
      offApp.use(express.json());
      offline.attach({ db, config: { network: 'mainnet', port: 8080, games_port: await closePort(), games_link_secret_file: linkFile },
        poolSettings: settings, verifyOwnerProof: async () => ({}), auditOwnerProof, startProbe: false });
      offline.mountAdmin(offApp, { secureAdmin: fakeSecureAdmin, stepUpRefused });
      const offSrv = offApp.listen(0, '127.0.0.1');
      await new Promise((res) => offSrv.on('listening', res));
      r = await call(offSrv.address().port, { p: '/api/admin/games/players' });
      ok('games not running (closed port) → 503 games_offline', r.status === 503 && r.json.error === 'games_offline', `${r.status} ${r.text}`);
      const st = await call(offSrv.address().port, { p: '/api/admin/games-link' });
      ok('/api/admin/games-link reports the switch + probe state, never the secret',
         st.status === 200 && st.json.data && 'probe' in st.json.data && st.json.data.link_configured === true && !st.text.includes(SECRET), st.text);
      await new Promise((res) => offSrv.close(res));
    }

    console.log('\n[10] requiresStepUp — the §19.11 list, fail-closed');
    {
      const su = gl.requiresStepUp;
      ok('GET is never step-up', !su('GET', 'players/x') && !su('GET', 'settings'));
      ok('ban / unban / purge / void / adjust / event cancel / settings → step-up',
         ['players/a/ban', 'players/a/unban', 'chat/purge', 'matches/1/void', 'players/a/adjust', 'events/1/cancel', 'settings']
           .every((p) => su('POST', p)));
      ok('delete-one / mute / approve-held / operator post / event create / event update → fast',
         ['chat/messages/1/delete', 'players/a/mute', 'chat/held/1/approve', 'chat/post', 'events', 'events/1']
           .every((p) => !su('POST', p)));
      ok('an UNLISTED write defaults to step-up (a new route cannot silently skip it)', su('POST', 'players/a/unmute') && su('POST', 'brand/new'));
      ok('the fast list is POST-only: DELETE/PUT on the same paths are step-up', su('DELETE', 'events/1') && su('PUT', 'events/1'));
    }

    console.log('\n[11] a bad games config never throws at boot — it disables the link');
    {
      for (const [name, cfg] of [
        ['games_port = the pool port', { network: 'mainnet', port: 8080, games_port: 8080, games_link_secret_file: linkFile }],
        ['games_port out of range', { network: 'mainnet', port: 8080, games_port: 80, games_link_secret_file: linkFile }],
        ['games_port a string', { network: 'mainnet', port: 8080, games_port: 'x', games_link_secret_file: linkFile }],
        ['relative secret path', { network: 'mainnet', port: 8080, games_port: 8081, games_link_secret_file: 'conf/link' }],
      ]) {
        const bad = gl.createGamesLink();
        let threw = false;
        const origErr = console.error;
        console.error = () => {};
        try { bad.attach({ db, config: cfg, poolSettings: settings, verifyOwnerProof: async () => ({}), auditOwnerProof }); }
        catch (e) { threw = true; }
        finally { console.error = origErr; }
        const bApp = express();
        bApp.use(bad.internal);
        const bSrv = bApp.listen(0, '127.0.0.1');
        await new Promise((res) => bSrv.on('listening', res));
        const x = await call(bSrv.address().port, { p: '/internal/games/config', headers: L() });
        await new Promise((res) => bSrv.close(res));
        ok(`${name}: attach does not throw, internal routes 503, flag off`,
           !threw && x.status === 503 && x.json.error === 'link_not_configured' && bad.publicFlag().mode === 'off', `${threw} ${x.status}`);
        bad.stop();
      }
      const tmpConf = path.join(os.tmpdir(), `pool-games-conf-${process.pid}.json`);
      fs.writeFileSync(tmpConf, JSON.stringify({ network: 'testnet', jwt_secret: 'j'.repeat(40), db_path: './x.sqlite' }));
      const c = loadConfig(tmpConf);
      fs.writeFileSync(tmpConf, JSON.stringify({ network: 'mainnet', jwt_secret: 'j'.repeat(40), db_path: './x.sqlite' }));
      const m = loadConfig(tmpConf);
      fs.unlinkSync(tmpConf);
      ok('config.js defaults: testnet 8091 + grin_pubgames_link_testnet', c.games_port === 8091 && c.games_link_secret_file === '/opt/grin/conf/grin_pubgames_link_testnet');
      ok('config.js defaults: mainnet 8081 + grin_pubgames_link_mainnet', m.games_port === 8081 && m.games_link_secret_file === '/opt/grin/conf/grin_pubgames_link_mainnet');
    }

    console.log('\n[12] index.js wiring (static — index.js starts a server on require)');
    {
      const src = readAppSource();
      const iInternal = src.indexOf('app.use(gamesLink.internal)');
      const iJson = src.indexOf('app.use(express.json())');
      ok('the internal middleware is mounted BEFORE express.json() (secret before body)', iInternal > 0 && iJson > 0 && iInternal < iJson);
      const firstLimiter = src.indexOf("rateLimiter.middleware(");
      ok('…and before any rate limiter', iInternal < firstLimiter);
      // Either receiver (route files register on `router`) and any quote — `app.` alone would pass
      // vacuously once routes move (R1 2026-10-10); the control proves the reader sees a real one.
      const REG = (p) => new RegExp(`\\b(?:app|router)\\.(?:get|post|put|patch|delete|all|use)\\(\\s*['"\`]${p}`);
      ok('control — the registration reader sees a real route (/api/pool/stats)', REG('\\/api\\/pool\\/stats').test(src));
      ok('no pool route is registered under /internal (the lib answers the whole prefix)', !REG('\\/internal').test(src));
      ok('no /internal route is mounted under /api/', !/'\/api\/[^']*internal/.test(src));
      ok('attach gets the real verifyOwnerProof/auditOwnerProof and the branding flush',
         /gamesLink\.attach\(\{[^}]*verifyOwnerProof[^}]*auditOwnerProof[^}]*onHealthChange: invalidateBranding/.test(src));
      ok('the admin proxy is mounted with secureAdmin + stepUpRefused', /gamesLink\.mountAdmin\(app, \{ secureAdmin, stepUpRefused \}\)/.test(src));
      ok('the branding payload takes the flag from publicFlag()', /cfg\.games = gamesLink\.publicFlag\(\);/.test(src));
      ok("the 'games' settings section is step-up (every games-settings write, §19.11)", /STEP_UP_SETTINGS_SECTIONS = new Set\(\[[^\]]*'games'/.test(src));
      const lib = fs.readFileSync(path.join(APP, 'lib/games-link.js'), 'utf8');
      ok('the probe runs on an unref\'d timer', /probeTimer = setInterval\(probeOnce, PROBE_INTERVAL_MS\);\s*\n\s*if \(probeTimer\.unref\) probeTimer\.unref\(\);/.test(lib));
      ok('no request handler awaits the probe', !/await\s+probeOnce/.test(lib));
      ok('the secret is compared with timingSafeEqual', /crypto\.timingSafeEqual\(a, b\)/.test(lib));
    }

    console.log('\n[13] public nav + admin page');
    {
      const shell = fs.readFileSync(path.join(WEB, 'public_html/js/public-shell.js'), 'utf8');
      const brand = fs.readFileSync(path.join(WEB, 'public_html/js/branding.js'), 'utf8');
      // §19.17.8 (D31, Part C2): Play lives INSIDE the Community group, beside Fortune Board +
      // Contribute; each child keeps its own gate and the group follows its children.
      const navSrc = (shell.match(/var NAV = \[[\s\S]*?\n  \];/) || [''])[0];
      ok('NAV: no standalone Play item any more (it moved into the group)', !/^    \{ href: '\/play\/'/m.test(navSrc));
      ok("NAV: the group is 'Community' and carries no gate of its own", /\{ label: 'Community', icon: '[^']+', children: \[/.test(navSrc) && !/label: 'Prize Pool'/.test(navSrc));
      ok("NAV: Play is the group's third child, marked games: true", /\{ href: 'fortune-board\.html',[^\n]*incentives: true \},\s*\n\s*\{ href: 'donate\.html',[^\n]*incentives: true \},\s*\n\s*\{ href: '\/play\/',\s*label: 'Play',\s*icon: '🎮', games: true \}/.test(navSrc), navSrc);
      ok('a games item renders HIDDEN with data-games (no flash before the fetch)', /if \(l\.games\) return ' data-games="1" style="display:none"';/.test(shell));
      ok('…in the header and in the footer copy', (shell.match(/\+ gateAttrs\(l\) \+/g) || []).length === 2 && !/gamesAttrs/.test(shell));

      // Behaviour, not text: run the real NAV + gate helpers (public-shell.js) and the real
      // apply* functions (branding.js) on a tiny fake DOM, over the whole matrix.
      const fnSrc = (src, name) => (src.match(new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n  \\}`)) || [''])[0];
      const build = new Function(`${navSrc}\n${fnSrc(shell, 'gateAttrs')}\n${fnSrc(shell, 'groupAttrs')}\nreturn { NAV: NAV, gateAttrs: gateAttrs, groupAttrs: groupAttrs };`)();
      const applyFns = new Function('document', `${fnSrc(brand, 'applyIncentivesNav')}\n${fnSrc(brand, 'applyGamesNav')}\n${fnSrc(brand, 'applyNavGroups')}\n` +
        'return { applyIncentivesNav: applyIncentivesNav, applyGamesNav: applyGamesNav, applyNavGroups: applyNavGroups };');
      const initDisplay = (attrs) => (/style="display:none"/.test(attrs) ? 'none' : '');
      function fakeDom(nav) {
        const els = [];
        const groups = [];
        for (const item of nav) {
          if (!item.children) continue;
          const ga = build.groupAttrs(item);
          const g = { label: item.label, gated: /data-nav-gated/.test(ga), style: { display: initDisplay(ga) }, kids: [] };
          for (const c of item.children) {
            const a = build.gateAttrs(c);
            const el = { label: c.label, inc: /data-incentives/.test(a), games: /data-games/.test(a), style: { display: initDisplay(a) } };
            g.kids.push(el);
            els.push(el);
          }
          g.querySelectorAll = (sel) => (sel === '.nav-dropdown a' ? g.kids : []);
          groups.push(g);
        }
        const document = { querySelectorAll(sel) {
          if (sel === '[data-incentives]') return els.filter((e) => e.inc);
          if (sel === '[data-games]') return els.filter((e) => e.games);
          if (sel === '.nav-group[data-nav-gated]') return groups.filter((x) => x.gated);
          throw new Error(`unexpected selector ${sel}`);
        } };
        return { document, groups };
      }
      const shown = (g) => g.kids.filter((k) => k.style.display !== 'none').map((k) => k.label);
      {
        const { groups } = fakeDom(build.NAV);
        const c = groups.find((g) => g.label === 'Community');
        ok('before the branding fetch: Community shown with Fortune Board + Contribute, Play hidden',
           c && c.gated && c.style.display === '' && JSON.stringify(shown(c)) === '["Fortune Board","Contribute"]', c && JSON.stringify(shown(c)));
        const s = groups.find((g) => g.label === 'Stats');
        ok('…and an ungated group (Stats) is never touched by the gates', s && !s.gated);
        const onlyGames = fakeDom([{ label: 'X', children: [{ href: '/play/', label: 'Play', games: true }] }]).groups[0];
        ok('a group whose every child starts hidden starts hidden itself (no empty dropdown before the fetch)', onlyGames.style.display === 'none');
      }
      // §19.17.8's table: incentives × games (effective) → group shown?, which children.
      const MATRIX = [
        [true, 'on', true, ['Fortune Board', 'Contribute', 'Play']],
        [true, 'preview', true, ['Fortune Board', 'Contribute']],
        [true, 'off', true, ['Fortune Board', 'Contribute']],
        [false, 'on', true, ['Play']],
        [false, 'preview', false, []],
        [false, 'off', false, []],
      ];
      for (const [inc, mode, wantGroup, wantKids] of MATRIX) {
        const { document, groups } = fakeDom(build.NAV);
        const fns = applyFns(document);
        const cfg = { incentives: { enabled: inc }, games: { mode, chat: mode !== 'off' } };
        fns.applyIncentivesNav(cfg); fns.applyGamesNav(cfg); fns.applyNavGroups();
        const c = groups.find((g) => g.label === 'Community');
        ok(`incentives ${inc ? 'on' : 'off'} × games ${mode} → group ${wantGroup ? 'shown' : 'HIDDEN'}${wantKids.length ? ': ' + wantKids.join(', ') : ''}`,
           (c.style.display === '') === wantGroup && JSON.stringify(shown(c)) === JSON.stringify(wantKids), `${c.style.display} ${JSON.stringify(shown(c))}`);
      }
      {
        // Flags flip both ways on one page (the branding payload can be re-applied).
        const { document, groups } = fakeDom(build.NAV);
        const fns = applyFns(document);
        const run = (cfg) => { fns.applyIncentivesNav(cfg); fns.applyGamesNav(cfg); fns.applyNavGroups(); return groups.find((g) => g.label === 'Community'); };
        run({ incentives: { enabled: false }, games: { mode: 'off' } });
        const c = run({ incentives: { enabled: false }, games: { mode: 'on' } });
        ok('hidden → shown again when a child comes back (the gate is re-evaluated, not latched)', c.style.display === '' && JSON.stringify(shown(c)) === '["Play"]');
        const d = run({});
        ok('a payload with neither field: incentives links shown (ship ON), Play hidden (ships hidden)', d.style.display === '' && JSON.stringify(shown(d)) === '["Fortune Board","Contribute"]');
      }
      ok('applyNavGroups runs AFTER both gates', /applyIncentivesNav\(cfg\);\s*\n\s*applyGamesNav\(cfg\);\s*\n\s*applyNavGroups\(\);/.test(brand));
      ok('a group never carries data-incentives / data-games itself (one child\'s flag must not hide the others)',
         !/nav-group[^\n]*\(l\.incentives \?/.test(shell) && !/nav-group[^\n]*\(l\.games \?/.test(shell));
      ok('the group still lights as active on a child page (/play/ included — fileOf("/play/") === "/play/")',
         /var childActive = l\.children\.some\(function \(c\) \{ return fileOf\(c\.href\) === here; \}\);/.test(shell));
      // The header is mounted on /play/ and on /blog/<slug>: a relative href resolves under
      // those paths (§19.15 Part 6). Every rendered href goes through abs() or is literal '/…'.
      ok('nav + footer hrefs are rendered through abs()', (shell.match(/'<a href="' \+ abs\(l\.href\) \+ '"/g) || []).length === 2 &&
        !/'<a href="' \+ l\.href/.test(shell));
      ok('no literal relative href left in the chrome', !/href="(?!\/|#|https?:|mailto:|' \+)[^"]*"/.test(shell),
        (shell.match(/href="(?!\/|#|https?:|mailto:|' \+)[^"]*"/g) || []).join(', '));
      ok('abs() prefixes a relative href with /', (() => { const m = shell.match(/function abs\(href\) \{[^\n]*\}/); if (!m) return false;
        const abs = new Function(`${m[0]}; return abs;`)(); return abs('index.html') === '/index.html' && abs('/play/') === '/play/'; })());
      ok('no ad slots or ads.js on a data-untrusted-html="exempt" page (the games login)',
        /var noAds = document\.documentElement\.getAttribute\('data-untrusted-html'\) === 'exempt';/.test(shell) &&
        /if \(!noAds\) header\.insertAdjacentElement\('afterend', adSlot\('header'\)\);/.test(shell) &&
        /if \(!noAds\) document\.body\.appendChild\(adSlot\('footer'\)\);/.test(shell) &&
        /if \(!noAds && !document\.getElementById\('ads-js'\)\)/.test(shell));
      const fn = (brand.match(/function applyGamesNav\(cfg\) \{[\s\S]*?\n  \}/) || [''])[0];
      ok("applyGamesNav shows ONLY on mode === 'on' (off/preview/missing = hidden)", /cfg\.games && cfg\.games\.mode === 'on'/.test(fn) && /on \? '' : 'none'/.test(fn), fn);
      ok('applyGamesNav runs with the rest of the header enhancement', /applyIncentivesNav\(cfg\);\s*\n\s*applyGamesNav\(cfg\);/.test(brand));

      const PANEL = path.join(APP, 'admin-panel');
      const page = fs.readFileSync(path.join(PANEL, 'settings-games.html'), 'utf8');
      const form = (page.match(/<div id="games" class="settings-content[^"]*">([\s\S]*?)<script/) || [])[1] || '';
      const ids = [];
      for (const m of form.matchAll(/<(input|select|textarea)\b([^>]*)>/g)) {
        const id = (m[2].match(/\bid="([^"]+)"/) || [])[1];
        if (id && !/\bsettings-skip\b/.test(m[2])) ids.push(id);
      }
      const keys = Object.keys(PoolSettings.defaults.games).sort();
      ok('settings-games.html harvests exactly the games keys (an unknown id fails the save)', JSON.stringify(ids.sort()) === JSON.stringify(keys), `${ids} vs ${keys}`);
      ok('mode is a <select> with exactly off/preview/on (radios are not harvested)',
         /<select id="mode"/.test(form) && JSON.stringify([...form.matchAll(/<option value="([^"]+)"/g)].map((m) => m[1])) === JSON.stringify(PoolSettings.GAMES_MODES));
      ok('the page declares SETTINGS_SECTION games', /window\.SETTINGS_SECTION = "games"/.test(page));
      const shellAdmin = fs.readFileSync(path.join(PANEL, 'admin-shell.js'), 'utf8');
      ok('admin nav links it under Settings', /file: 'settings-games\.html',\s*title: 'Games'/.test(shellAdmin));
      const common = fs.readFileSync(path.join(PANEL, 'settings-common.js'), 'utf8');
      const status = (common.match(/async function loadGamesLinkStatus\(\) \{[\s\S]*?\n    \}/) || [''])[0];
      ok('the health line renders with textContent, never innerHTML', /box\.textContent = parts\.join/.test(status) && !/innerHTML/.test(status));
    }

    console.log('\n[14] global caps — a games process that forges client_ip cannot drive unbounded work (§19.13 #12)');
    {
      const good = { address: MAIN_A, proof: 'hunter2hunter2', client_ip: '198.51.100.7' };
      const vp = (body) => call(port, { method: 'POST', p: '/internal/games/verify-proof', headers: L(J), body });
      clockMs += 10 * 60 * 1000;                     // both buckets full
      // 4 verifies held open inside the (stubbed) scrypt; a 5th, from a DIFFERENT client_ip, is refused.
      let release;
      verifyResult = new Promise((r) => { release = () => r({ ok: true, method: 'password', slot: 'set', age_seconds: 5 }); });
      verifyCalls = [];
      const held = [1, 2, 3, 4].map((i) => vp({ ...good, client_ip: `198.51.100.${10 + i}` }));
      for (let i = 0; i < 200 && verifyCalls.length < gl.VERIFY_INFLIGHT_MAX; i++) await new Promise((r) => setTimeout(r, 5));
      let r = await vp({ ...good, client_ip: '203.0.113.99' });
      ok(`a ${gl.VERIFY_INFLIGHT_MAX + 1}th concurrent verify → 429 busy, verify never called for it`,
         r.status === 429 && r.json.error === 'busy' && verifyCalls.length === gl.VERIFY_INFLIGHT_MAX, `${r.status} ${r.text} calls=${verifyCalls.length}`);
      release();
      const done = await Promise.all(held);
      ok('…the four in flight finish normally', done.every((x) => x.status === 200 && x.json.ok === true));
      verifyResult = { ok: true, method: 'password', slot: 'set', age_seconds: 5 };
      clockMs += 2 * 60 * 1000;
      let okN = 0;
      for (let i = 0; i < gl.VERIFY_PER_MIN; i++) {
        const x = await vp({ ...good, client_ip: `10.1.${i >> 8}.${i & 255}` });
        if (x.status === 200) okN++;
      }
      r = await vp({ ...good, client_ip: '10.9.9.9' });
      ok(`${gl.VERIFY_PER_MIN} verifies a minute from ${gl.VERIFY_PER_MIN} different IPs pass; the next → 429`, okN === gl.VERIFY_PER_MIN && r.status === 429, `${okN} ${r.status}`);
      clockMs += 60 * 1000;
      r = await vp(good);
      ok('…and the bucket refills with time', r.status === 200, r.text);

      const act = () => call(port, { p: `/internal/games/activity?from=${T0}&to=${T0 + 600}`, headers: L() });
      clockMs += 10 * 60 * 1000;
      okN = 0;
      for (let i = 0; i < gl.ACTIVITY_PER_5MIN; i++) if ((await act()).status === 200) okN++;
      r = await act();
      ok(`${gl.ACTIVITY_PER_5MIN} activity calls per 5 min pass; the next → 429 busy`, okN === gl.ACTIVITY_PER_5MIN && r.status === 429 && r.json.error === 'busy', `${okN} ${r.status}`);
      ok(`…a cap far above an honest sync (≤ 24 calls per 5-min tick)`, gl.ACTIVITY_PER_5MIN >= 2 * 24);
      clockMs += 5 * 60 * 1000;
      ok('…and it refills', (await act()).status === 200);
      r = await call(port, { p: '/internal/games/activity?from=abc&to=1', headers: L() });
      ok('a malformed call is refused before it spends a token (400, not 429)', r.status === 400);
    }
  } catch (e) {
    fail++;
    console.log(`  FAIL  unexpected error: ${e && e.stack}`);
  } finally {
    link.stop();
    await new Promise((r) => (srv ? srv.close(r) : r()));
    await new Promise((r) => gamesSrv.close(r));
    try { closeDb(); } catch (_) {}
    for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(dbFile + s); } catch (_) {} }
    try { fs.unlinkSync(linkFile); } catch (_) {}
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
