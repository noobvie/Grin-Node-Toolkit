'use strict';

// Games service skeleton (design §19, Part 1): config validation, grinium-games.db
// migrations + pragmas + the §19.4 schema contract, transactions, the HTTP layer (body
// cap, content type, exact routing, client IP, cookies, uniform errors), /play/api/health,
// the maintenance scheduler, graceful shutdown, and the zero-dependency rule.
//
// Servers here listen on 127.0.0.1:0 and are closed before the suite ends; temp DB files
// live under os.tmpdir() and are removed. Nothing is left running.
// Run: node scripts/test-skeleton.js

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { PassThrough } = require('node:stream');
const { spawn, spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const SERVER = path.resolve(__dirname, '..');
const { loadConfig, ConfigError, CODE_DIR } = require(path.join(SERVER, 'lib/config.js'));
const { openDb, LATEST_VERSION } = require(path.join(SERVER, 'lib/db.js'));
const H = require(path.join(SERVER, 'lib/http.js'));
const { buildApp, createServer, listen, shutdown } = require(path.join(SERVER, 'lib/app.js'));
const { createMaintenance } = require(path.join(SERVER, 'lib/maintenance.js'));
const { createLogger } = require(path.join(SERVER, 'lib/log.js'));

let pass = 0, fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else      { fail++; console.error(`  FAIL  ${name}${extra ? ' — ' + extra : ''}`); }
}
function throwsLike(fn, re) {
  try { fn(); return false; } catch (e) { return re.test(e.message); }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'grin-games-test-'));
const tmpDb = (name) => path.join(TMP, name);
// A full config for buildApp. The link secret file does not exist, so nothing here can reach
// a pool (port 9 is discard, never a pool), and the mode stays 'off' — public routes 404.
const appConfig = (net) => ({ net, poolInternalUrl: 'http://127.0.0.1:9', linkSecretFile: path.join(TMP, 'no-link-secret') });
const lines = [];
const log = createLogger((level, line) => lines.push(`${level} ${line}`));

// ── helpers ───────────────────────────────────────────────────────────────────────────
function request(port, { method = 'GET', path: p, headers = {}, body, chunks } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers, agent: false }, (res) => {
      const parts = [];
      res.on('data', (c) => parts.push(c));
      res.on('end', () => {
        settled = true;
        const text = Buffer.concat(parts).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', (e) => { if (!settled) reject(e); });
    if (chunks) { for (const c of chunks) req.write(c); req.end(); }
    else if (body !== undefined) req.end(body);
    else req.end();
  });
}

function fakeReq(headers, bodyBuf) {
  const r = new PassThrough();
  r.headers = headers;
  if (bodyBuf !== undefined) r.end(bodyBuf); else r.end();
  return r;
}

async function rejectsWith(promise, status, code) {
  try { await promise; return false; } catch (e) { return e instanceof H.HttpError && e.status === status && e.code === code; }
}

// Normalise a CREATE statement for comparison with the design doc's copy: comments,
// whitespace and spacing around punctuation are not part of the contract.
function normSql(sql) {
  return sql.replace(/--[^\n]*/g, '').replace(/\s+/g, ' ').replace(/\s*([(),;])\s*/g, '$1').trim().toLowerCase();
}
function schemaObjects(raw) {
  return raw.prepare("SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY type, name").all()
    .map((r) => `${r.type} ${r.name} ${normSql(r.sql)}`);
}

async function main() {
  // ── [a] config ──────────────────────────────────────────────────────────────────────
  console.log('\n[a] config: env-driven, every value validated, one-line reasons\n');
  const base = { GAMES_NET: 'mainnet', GAMES_DB: tmpDb('cfg.db') };
  const c1 = loadConfig({ GAMES_NET: 'mainnet' });
  ok('a. mainnet defaults: 127.0.0.1:8081, pool :8080, data outside the code dir',
    c1.host === '127.0.0.1' && c1.port === 8081 && c1.poolInternalUrl === 'http://127.0.0.1:8080'
    && c1.dbPath === path.resolve('/opt/grin/pubgames-data/mainnet/grinium-games.db')
    && c1.linkSecretFile === path.resolve('/opt/grin/conf/grin_pubgames_link_mainnet')
    && c1.gamesDir === path.join(CODE_DIR, 'games'));
  const c2 = loadConfig({ GAMES_NET: 'testnet' });
  ok('a. testnet defaults: 8091, pool :8090, testnet paths',
    c2.port === 8091 && c2.poolInternalUrl === 'http://127.0.0.1:8090'
    && c2.dbPath === path.resolve('/opt/grin/pubgames-data/testnet/grinium-games.db'));
  ok('a. config object is frozen', Object.isFrozen(c1));
  const bad = (env) => { try { loadConfig(env); return null; } catch (e) { return e; } };
  const reasonOk = (e) => e instanceof ConfigError && !/[\r\n]/.test(e.message) && e.message.length < 300;
  ok('a. GAMES_NET missing → refused', reasonOk(bad({})));
  ok('a. GAMES_NET=floonet → refused', reasonOk(bad({ GAMES_NET: 'floonet' })));
  ok('a. GAMES_NET=__proto__ → refused', reasonOk(bad({ GAMES_NET: '__proto__' })));
  for (const p of ['8081abc', '80', '1023', '65536', '70000', '', ' 8081', '1e4', '0x1f91', '-8081', '08081', '8081.0']) {
    ok(`a. GAMES_PORT=${JSON.stringify(p)} → refused`, reasonOk(bad({ ...base, GAMES_PORT: p })));
  }
  ok('a. GAMES_PORT=9001 accepted', loadConfig({ ...base, GAMES_PORT: '9001' }).port === 9001);
  ok('a. GAMES_PORT equal to the pool port → refused', reasonOk(bad({ ...base, GAMES_PORT: '8080' })));
  for (const u of ['http://10.0.0.1:8080', 'https://127.0.0.1:8080', 'http://localhost:8080', 'http://127.0.0.1:8080/api',
    'http://127.0.0.1:8080/?x=1', 'http://u:p@127.0.0.1:8080', 'http://127.0.0.1', 'http://example.com:8080', 'not a url',
    'http://127.0.0.1.nip.io:8080']) {
    ok(`a. POOL_INTERNAL_URL=${JSON.stringify(u)} → refused`, reasonOk(bad({ ...base, POOL_INTERNAL_URL: u })));
  }
  ok('a. POOL_INTERNAL_URL=http://[::1]:8080 accepted',
    loadConfig({ ...base, POOL_INTERNAL_URL: 'http://[::1]:8080' }).poolInternalUrl === 'http://[::1]:8080');
  ok('a. GAMES_DB relative → refused', reasonOk(bad({ ...base, GAMES_DB: 'data/games.db' })));
  ok('a. GAMES_DB not *.db → refused', reasonOk(bad({ ...base, GAMES_DB: tmpDb('games.sqlite') })));
  ok('a. GAMES_DB with a NUL byte → refused', reasonOk(bad({ ...base, GAMES_DB: tmpDb('a\0.db') })));
  ok('a. GAMES_DB inside the code dir → refused (deploy rsync --delete)',
    reasonOk(bad({ ...base, GAMES_DB: path.join(CODE_DIR, 'data', 'grinium-games.db') })));
  ok('a. GAMES_DB escaping via .. back into the code dir → refused',
    reasonOk(bad({ ...base, GAMES_DB: [CODE_DIR, 'lib', '..', 'x.db'].join(path.sep) })));
  ok('a. GAMES_DB inside GAMES_GAMES_DIR → refused',
    reasonOk(bad({ ...base, GAMES_GAMES_DIR: TMP, GAMES_DB: tmpDb('inside.db') })));
  ok('a. GAMES_LINK_SECRET_FILE relative → refused', reasonOk(bad({ ...base, GAMES_LINK_SECRET_FILE: 'link' })));
  ok('a. unknown GAMES_* variable (typo) → refused', reasonOk(bad({ ...base, GAMES_PROT: '9000' })));
  ok('a. an over-long value is truncated in the reason',
    (() => { const e = bad({ ...base, GAMES_PORT: 'x'.repeat(5000) }); return reasonOk(e) && e.message.length < 200; })());

  // ── [b] db: migrations, pragmas, the §19.4 contract ─────────────────────────────────
  console.log('\n[b] grinium-games.db: schema v1, idempotent migrations, pragmas\n');
  const mem = openDb(':memory:', { net: 'mainnet', log });
  ok('b. :memory: opens at the latest version (3)', mem.schemaVersion() === LATEST_VERSION && LATEST_VERSION === 3);
  const memSchema = schemaObjects(mem.raw);
  const again = mem.migrate();
  ok('b. :memory: migrate again = no-op, same schema, still latest',
    again.from === LATEST_VERSION && again.to === LATEST_VERSION && JSON.stringify(schemaObjects(mem.raw)) === JSON.stringify(memSchema));

  const f1 = tmpDb('games.db');
  lines.length = 0;
  const d1 = openDb(f1, { net: 'mainnet', log });
  ok('b. file DB: first open migrates v0 → latest and says so', d1.schemaVersion() === LATEST_VERSION && lines.some((l) => l.includes('migrated schema v0 → v' + LATEST_VERSION)));
  const fileSchema = schemaObjects(d1.raw);
  d1.close();
  lines.length = 0;
  const d2 = openDb(f1, { net: 'mainnet', log });
  ok('b. file DB reopened: no migration, same schema, still latest',
    d2.schemaVersion() === LATEST_VERSION && !lines.some((l) => /migrated/.test(l)) && JSON.stringify(schemaObjects(d2.raw)) === JSON.stringify(fileSchema));
  ok('b. file schema == :memory: schema', JSON.stringify(fileSchema) === JSON.stringify(memSchema));
  const pv = (name) => { const r = d2.raw.prepare(`PRAGMA ${name}`).get(); return r[Object.keys(r)[0]]; };
  ok('b. pragmas: WAL, synchronous=NORMAL, busy_timeout=2000, foreign_keys=ON (D3)',
    pv('journal_mode') === 'wal' && pv('synchronous') === 1 && pv('busy_timeout') === 2000 && pv('foreign_keys') === 1,
    `${pv('journal_mode')} ${pv('synchronous')} ${pv('busy_timeout')} ${pv('foreign_keys')}`);
  const meta = Object.fromEntries(d2.raw.prepare('SELECT key, value FROM meta').all().map((r) => [r.key, r.value]));
  ok('b. meta has schema_version, created_at and net', meta.schema_version === String(LATEST_VERSION) && /^[0-9]+$/.test(meta.created_at) && meta.net === 'mainnet');
  if (process.platform === 'win32') {
    console.log('  SKIP  b. file mode 0600 — chmod is a no-op on Windows (verified on the VPS)');
  } else {
    const modes = [f1, `${f1}-wal`, `${f1}-shm`].filter((f) => fs.existsSync(f)).map((f) => fs.statSync(f).mode & 0o777);
    ok('b. DB file and its WAL siblings are 0600', modes.length >= 1 && modes.every((m) => m === 0o600), modes.map((m) => m.toString(8)).join(','));
  }

  // The contract: the design doc's §19.4 SQL, executed on its own, must produce exactly
  // the schema the migration produces. Only runs from a repo checkout (the doc is not
  // deployed to the box).
  const DOC = path.resolve(SERVER, '../../../../docs/generated/script07_design.md');
  if (fs.existsSync(DOC)) {
    const doc = fs.readFileSync(DOC, 'utf8');
    const sec = doc.indexOf('### 19.4');
    const block = sec === -1 ? null : /```sql\n([\s\S]*?)```/.exec(doc.slice(sec));
    if (!block) ok('b. design §19.4 SQL block found', false);
    else {
      const ref = new DatabaseSync(':memory:');
      ref.exec(block[1]);
      const refSchema = schemaObjects(ref);
      ref.close();
      const mine = new Set(memSchema);
      const theirs = new Set(refSchema);
      const missing = refSchema.filter((x) => !mine.has(x)).map((x) => x.split(' ').slice(0, 2).join(' '));
      const extra = memSchema.filter((x) => !theirs.has(x)).map((x) => x.split(' ').slice(0, 2).join(' '));
      ok(`b. schema (latest) == design §19.4 exactly (${refSchema.length} tables + indexes)`,
        missing.length === 0 && extra.length === 0, `differs: ${[...missing, ...extra].join(', ')}`);
    }
  } else {
    console.log('  SKIP  b. §19.4 contract check — design doc not present (not a repo checkout)');
  }

  ok('b. CHECK: players.plays can never go below 0',
    throwsLike(() => mem.raw.prepare("INSERT INTO players (address, first_seen, last_seen, plays) VALUES ('a', 1, 1, -1)").run(), /CHECK/i));
  ok('b. foreign keys enforced: a session for an unknown player is refused',
    throwsLike(() => mem.raw.prepare("INSERT INTO sessions (token_hash, address, created_at, expires_at, last_seen, proof_kind, proof_slot) VALUES ('h', 'nobody', 1, 2, 1, 'ip', 'set')").run(), /FOREIGN KEY/i));
  const insMatch = mem.raw.prepare("INSERT INTO matches (game_id, game_version, mode, state, seat1, seat2, created_by, params_json, position, created_at) VALUES ('chess', '1', 'bot', ?, 'grin1x', 'bot:1', 'grin1x', '{}', 'fen', 1)");
  insMatch.run('finished');
  insMatch.run('active');
  ok('b. uq_matches_one_bot: a second ACTIVE bot game for one address is refused, a finished one is not',
    throwsLike(() => insMatch.run('active'), /UNIQUE/i));

  d2.close();
  ok('b. reopening a mainnet DB as testnet is refused', throwsLike(() => openDb(f1, { net: 'testnet', log }), /belongs to "mainnet"/));
  ok('b. openDb refuses a bad net argument', throwsLike(() => openDb(':memory:', { net: 'floonet' }), /net must be/));

  const f2 = tmpDb('newer.db');
  openDb(f2, { net: 'mainnet' }).close();
  { const r = new DatabaseSync(f2); r.exec("UPDATE meta SET value = '" + (LATEST_VERSION + 1) + "' WHERE key = 'schema_version'"); r.close(); }
  ok('b. a DB from a NEWER build is refused, not downgraded', throwsLike(() => openDb(f2, { net: 'mainnet' }), /newer than this build/));
  { const r = new DatabaseSync(f2); r.exec("UPDATE meta SET value = 'one' WHERE key = 'schema_version'"); r.close(); }
  ok('b. a non-integer schema_version is refused', throwsLike(() => openDb(f2, { net: 'mainnet' }), /not an integer/));

  // A DB made by the v1 build (Parts 1–7) upgrades in place: v2 and v3 add tables only.
  const fv1 = tmpDb('v1.db');
  { const r = new DatabaseSync(fv1);
    const { MIGRATIONS } = require(path.join(SERVER, 'lib/db.js'));
    r.exec(MIGRATIONS[0].sql);
    r.exec("INSERT INTO meta (key, value) VALUES ('schema_version', '1'), ('created_at', '1'), ('net', 'mainnet')");
    r.exec("INSERT INTO players (address, first_seen, last_seen, plays) VALUES ('grin1keep', 1, 1, 7)");
    r.close(); }
  lines.length = 0;
  const dv1 = openDb(fv1, { net: 'mainnet', log });
  const v1tables = dv1.raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('moderators','chat_words','nicknames')").all().map((x) => x.name).sort();
  ok('b. a v1 DB migrates v1 → v3: moderators + chat_words + nicknames added, data kept',
    dv1.schemaVersion() === 3 && v1tables.join() === 'chat_words,moderators,nicknames'
      && dv1.raw.prepare("SELECT plays FROM players WHERE address = 'grin1keep'").get().plays === 7
      && lines.some((l) => l.includes('migrated schema v1 → v3')), v1tables.join());
  ok('b. …and the upgraded schema equals a fresh one', JSON.stringify(schemaObjects(dv1.raw)) === JSON.stringify(memSchema));
  dv1.close();

  // A DB made by the v2 build (Parts 8–11) upgrades in place: v3 adds the nicknames table only.
  const fv2 = tmpDb('v2.db');
  { const r = new DatabaseSync(fv2);
    const { MIGRATIONS } = require(path.join(SERVER, 'lib/db.js'));
    r.exec(MIGRATIONS[0].sql);
    r.exec(MIGRATIONS[1].sql);
    r.exec("INSERT INTO meta (key, value) VALUES ('schema_version', '2'), ('created_at', '1'), ('net', 'mainnet')");
    r.exec("INSERT INTO players (address, first_seen, last_seen, plays) VALUES ('grin1keep', 1, 1, 7)");
    r.exec("INSERT INTO moderators (address, added_by, added_at) VALUES ('grin1keep', 'op', 1)");
    r.close(); }
  lines.length = 0;
  const dv2 = openDb(fv2, { net: 'mainnet', log });
  ok('b. a v2 DB migrates v2 → v3: nicknames added, players + moderators kept',
    dv2.schemaVersion() === 3 && lines.some((l) => l.includes('migrated schema v2 → v3'))
      && dv2.raw.prepare("SELECT COUNT(*) AS n FROM moderators").get().n === 1
      && dv2.raw.prepare("SELECT COUNT(*) AS n FROM nicknames").get().n === 0);
  ok('b. …and equals a fresh schema', JSON.stringify(schemaObjects(dv2.raw)) === JSON.stringify(memSchema));
  dv2.close();

  const f3 = tmpDb('garbage.db');
  fs.writeFileSync(f3, 'this is not a sqlite database, just some bytes '.repeat(10));
  ok('b. a non-SQLite file is refused', throwsLike(() => openDb(f3, { net: 'mainnet' }), /not a database/i));

  const f4 = tmpDb('half.db');
  { const r = new DatabaseSync(f4); r.exec("CREATE TABLE players (address TEXT PRIMARY KEY)"); r.close(); }
  ok('b. a leftover table fails the migration loudly (plain CREATE, not IF NOT EXISTS)',
    throwsLike(() => openDb(f4, { net: 'mainnet' }), /already exists/));
  { const r = new DatabaseSync(f4); const t = r.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((x) => x.name); r.close();
    ok('b. …and the failed migration left nothing behind (one transaction)', t.length === 1 && t[0] === 'players', t.join(',')); }

  // ── [c] transactions ────────────────────────────────────────────────────────────────
  console.log('\n[c] transaction(): BEGIN IMMEDIATE, savepoint nesting, sync-only\n');
  const tdb = openDb(tmpDb('tx.db'), { net: 'mainnet' });
  const put = tdb.raw.prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, 'v', 1)");
  const has = (k) => !!tdb.raw.prepare('SELECT 1 AS x FROM settings WHERE key = ?').get(k);
  tdb.transaction(() => put.run('c1'));
  ok('c. commit', has('c1'));
  try { tdb.transaction(() => { put.run('c2'); throw new Error('stop'); }); } catch { /* expected */ }
  ok('c. a throw rolls back', !has('c2'));
  tdb.transaction(() => {
    put.run('outer');
    try { tdb.transaction(() => { put.run('inner'); throw new Error('inner stop'); }); } catch { /* expected */ }
  });
  ok('c. a nested throw rolls back only the savepoint', has('outer') && !has('inner'));
  let asyncErr = null;
  try { tdb.transaction(async () => { put.run('c3'); }); } catch (e) { asyncErr = e; }
  ok('c. an async callback is refused and rolled back', asyncErr && /synchronous/.test(asyncErr.message) && !has('c3'));
  tdb.transaction(() => put.run('c4'));
  ok('c. the helper is usable again after a failure', has('c4'));
  const other = new DatabaseSync(tdb.file);
  other.exec('PRAGMA busy_timeout = 0');
  let lockedOut = false;
  tdb.transaction(() => {
    // No write yet: only BEGIN IMMEDIATE (not a deferred BEGIN) holds the write lock here.
    try { other.exec('BEGIN IMMEDIATE'); other.exec('ROLLBACK'); } catch (e) { lockedOut = /locked|busy/i.test(e.message); }
  });
  other.close();
  ok('c. the outer transaction takes the write lock at BEGIN (IMMEDIATE)', lockedOut);
  tdb.close();

  // ── [d] http units ──────────────────────────────────────────────────────────────────
  console.log('\n[d] http: numbers, client IP, cookies, JSON body\n');
  const P = H.parseIntStrict;
  ok('d. parseIntStrict accepts digits in range', P('10', { min: 1, max: 100 }) === 10 && P('0') === 0 && P(7) === 7);
  const rejects = ['NaN', 'Infinity', '-Infinity', '1e3', '1.5', '', ' 1', '1 ', '0x10', '12abc', '010', '+1', '9007199254740993'];
  ok(`d. parseIntStrict rejects ${rejects.length} malformed inputs`, rejects.every((v) => P(v) === null), rejects.filter((v) => P(v) !== null).join(','));
  ok('d. parseIntStrict rejects NaN/Infinity/floats/non-strings', [NaN, Infinity, 1.5, null, undefined, {}, [], true].every((v) => P(v) === null));
  ok('d. parseIntStrict enforces min/max (a negative LIMIT never gets through)', P('-1') === null && P('-1', { min: -5 }) === -1 && P('101', { max: 100 }) === null);

  const ipOf = (peer, xri) => H.clientIp({ socket: { remoteAddress: peer }, headers: xri === undefined ? {} : { 'x-real-ip': xri } });
  ok('d. X-Real-IP IGNORED from a non-loopback peer', ipOf('203.0.113.5', '1.2.3.4') === '203.0.113.5' && ipOf('10.0.0.1', '1.2.3.4') === '10.0.0.1');
  ok('d. X-Real-IP used from 127.0.0.1, ::1 and ::ffff:127.0.0.1',
    ipOf('127.0.0.1', '1.2.3.4') === '1.2.3.4' && ipOf('::1', '2001:db8::1') === '2001:db8::1' && ipOf('::ffff:127.0.0.1', '1.2.3.4') === '1.2.3.4');
  ok('d. a mapped peer is normalised', ipOf('::ffff:203.0.113.9') === '203.0.113.9');
  ok('d. loopback with no / a malformed X-Real-IP → the peer', ipOf('127.0.0.1') === '127.0.0.1'
    && ipOf('127.0.0.1', 'foo') === '127.0.0.1' && ipOf('127.0.0.1', '1.2.3.4, 5.6.7.8') === '127.0.0.1');
  ok('d. X-Real-IP from a non-loopback 127.x peer is not trusted', ipOf('127.0.0.2', '1.2.3.4') === '127.0.0.2');

  const ck = H.parseCookies('a=1; grin_play=abc_DEF-123; b="quoted"; bad name=x; =novalue');
  ok('d. cookies parse (quoted value, junk skipped)', ck.a === '1' && ck.grin_play === 'abc_DEF-123' && ck.b === 'quoted' && Object.keys(ck).length === 3);
  ok('d. a cookie name sent twice is AMBIGUOUS → null (cookie tossing)', H.parseCookies('grin_play=mine; grin_play=tossed').grin_play === null);
  ok('d. cookie map has no prototype (no __proto__ games)', Object.getPrototypeOf(H.parseCookies('__proto__=x')) === null);
  ok('d. serializeCookie writes the §19.5 attributes exactly',
    H.serializeCookie('grin_play', 'tok', { path: '/play/', maxAge: 1209600 }) === 'grin_play=tok; Path=/play/; Max-Age=1209600; HttpOnly; Secure; SameSite=Strict');
  ok('d. serializeCookie refuses a value with ; or a newline',
    throwsLike(() => H.serializeCookie('a', 'x; Path=/'), /bad value/) && throwsLike(() => H.serializeCookie('a', 'x\ny'), /bad value/));

  const J = { 'content-type': 'application/json' };
  const cap = 16 * 1024;
  ok('d. body ≤ cap parses', (await H.readJson(fakeReq(J, Buffer.from(JSON.stringify({ s: 'x'.repeat(cap - 20) }))))).s.length === cap - 20);
  ok('d. body of 17 KB (streamed, no Content-Length) → 413',
    await rejectsWith(H.readJson(fakeReq(J, Buffer.from(JSON.stringify({ s: 'x'.repeat(17 * 1024) })))), 413, 'payload_too_large'));
  ok('d. Content-Length over the cap → 413 before a byte is read',
    await rejectsWith(H.readJson(fakeReq({ ...J, 'content-length': String(17 * 1024) })), 413, 'payload_too_large'));
  ok('d. a per-route limit applies', await rejectsWith(H.readJson(fakeReq(J, Buffer.from('{"a":"xxxxxxxx"}')), { limit: 8 }), 413, 'payload_too_large'));
  ok('d. malformed Content-Length → 400', await rejectsWith(H.readJson(fakeReq({ ...J, 'content-length': '12x' })), 400, 'bad_request'));
  for (const t of [undefined, 'text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data', 'application/json; charset=latin1', 'application/jsonx']) {
    ok(`d. Content-Type ${JSON.stringify(t)} → 415`, await rejectsWith(H.readJson(fakeReq(t ? { 'content-type': t } : {}, Buffer.from('{}'))), 415, 'unsupported_media_type'));
  }
  ok('d. Content-Type application/json; charset=utf-8 accepted',
    (await H.readJson(fakeReq({ 'content-type': 'Application/JSON; charset=UTF-8' }, Buffer.from('{"a":1}')))).a === 1);
  ok('d. invalid JSON → 400 bad_json', await rejectsWith(H.readJson(fakeReq(J, Buffer.from('{"a":'))), 400, 'bad_json'));
  ok('d. empty body → 400 bad_json', await rejectsWith(H.readJson(fakeReq(J, Buffer.alloc(0))), 400, 'bad_json'));
  ok('d. invalid UTF-8 → 400 bad_json', await rejectsWith(H.readJson(fakeReq(J, Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x7d]))), 400, 'bad_json'));

  // ── [e] routing, errors and health over a real loopback server ──────────────────────
  console.log('\n[e] router + errors + /play/api/health (127.0.0.1:0, closed after)\n');
  const hdb = openDb(':memory:', { net: 'testnet', log });
  let t = 1000000;
  const app = buildApp({ config: appConfig('testnet'), db: hdb, log, startedAt: 1000000 - 42500, clock: () => t });
  app.router.add('GET', '/play/api/test/ip', (ctx) => ({ ip: ctx.ip }));
  app.router.add('GET', '/play/api/test/things/:id', (ctx) => ({ id: ctx.params.id }));
  app.router.add('POST', '/play/api/test/echo', (ctx) => ({ ok: true, len: JSON.stringify(ctx.body).length }));
  app.router.add('GET', '/play/api/test/throw', () => { throw new Error('boom <secret-value>'); });
  app.router.add('GET', '/play/api/test/nothing', () => undefined);
  const server = createServer(app.handler);
  const addr = await listen(server, 0, '127.0.0.1');
  const port = addr.port;
  ok('e. the server is bound to 127.0.0.1', addr.address === '127.0.0.1');

  const hr = await request(port, { path: '/play/api/health' });
  ok('e. health → 200 {ok, net, schema, uptime_s} and nothing else',
    hr.status === 200 && JSON.stringify(Object.keys(hr.json).sort()) === JSON.stringify(['net', 'ok', 'schema', 'uptime_s'])
    && hr.json.ok === true && hr.json.net === 'testnet' && hr.json.schema === LATEST_VERSION && hr.json.uptime_s === 42, hr.text);
  ok('e. JSON responses: nosniff, no-store, application/json, inert CSP, a request id',
    hr.headers['x-content-type-options'] === 'nosniff' && hr.headers['cache-control'] === 'no-store'
    && /^application\/json; charset=utf-8$/.test(hr.headers['content-type']) && /default-src 'none'/.test(hr.headers['content-security-policy'] || '')
    && /^[0-9a-f]{16}$/.test(hr.headers['x-request-id'] || ''));
  const hh = await request(port, { method: 'HEAD', path: '/play/api/health' });
  ok('e. HEAD /play/api/health → 200, no body (curl -sI in the Part 3 checks)', hh.status === 200 && hh.text === '');
  ok('e. a query string does not change the route', (await request(port, { path: '/play/api/health?x=1' })).status === 200);
  const rid = await request(port, { path: '/play/api/health', headers: { 'X-Request-Id': 'pool-abc-12345' } });
  ok('e. a well-formed incoming X-Request-Id is kept (the admin proxy sends one)', rid.headers['x-request-id'] === 'pool-abc-12345');
  const rid2 = await request(port, { path: '/play/api/health', headers: { 'X-Request-Id': '<script>' } });
  ok('e. a malformed incoming X-Request-Id is replaced', /^[0-9a-f]{16}$/.test(rid2.headers['x-request-id']));

  for (const p of ['/play/api/health/', '/play/api/Health', '/play/api/%68ealth', '/play/api/x/../health', '/play/api/x/%2e%2e/health',
    '/play//api/health', '/play/api/nope', '/internal/admin/x', '/']) {
    const r = await request(port, { path: p });
    ok(`e. ${p} → 404 JSON (exact match, no decoding, no dot segments)`, r.status === 404 && r.json && r.json.error === 'not_found', `${r.status}`);
  }
  const m405 = await request(port, { method: 'POST', path: '/play/api/health', headers: { 'content-type': 'application/json' }, body: '{}' });
  ok('e. POST on a GET route → 405 with Allow: GET, HEAD', m405.status === 405 && m405.json.error === 'method_not_allowed' && m405.headers.allow === 'GET, HEAD');
  ok('e. :param accepts a plain id', (await request(port, { path: '/play/api/test/things/abc-1_2.x' })).json.id === 'abc-1_2.x');
  for (const p of ['..', '.hidden', 'a%2Fb', 'a%2fb', '%2e%2e', 'a b']) {
    const r = await request(port, { path: `/play/api/test/things/${p.replace(' ', '%20')}` });
    ok(`e. :param ${JSON.stringify(p)} → 404`, r.status === 404, `${r.status}`);
  }

  const ipR = await request(port, { path: '/play/api/test/ip', headers: { 'X-Real-IP': '198.51.100.7' } });
  ok('e. from loopback (as nginx), X-Real-IP is the client IP', ipR.json.ip === '198.51.100.7');

  const small = JSON.stringify({ s: 'x'.repeat(15 * 1024) });
  const e1 = await request(port, { method: 'POST', path: '/play/api/test/echo', headers: { 'content-type': 'application/json' }, body: small });
  ok('e. POST 15 KB JSON → 200', e1.status === 200 && e1.json.len === small.length);
  const big = JSON.stringify({ s: 'x'.repeat(17 * 1024) });
  const e2 = await request(port, { method: 'POST', path: '/play/api/test/echo', headers: { 'content-type': 'application/json' }, body: big });
  ok('e. POST 17 KB with Content-Length → 413 + Connection: close', e2.status === 413 && e2.json.error === 'payload_too_large' && e2.headers.connection === 'close');
  const pieces = []; for (let i = 0; i < 17; i++) pieces.push('x'.repeat(1024));
  const e3 = await request(port, { method: 'POST', path: '/play/api/test/echo', headers: { 'content-type': 'application/json' }, chunks: ['{"s":"', ...pieces, '"}'] });
  ok('e. POST 17 KB chunked (no Content-Length) → 413', e3.status === 413 && e3.json.error === 'payload_too_large');
  const e4 = await request(port, { method: 'POST', path: '/play/api/test/echo', headers: { 'content-type': 'text/plain' }, body: '{}' });
  ok('e. POST text/plain → 415 (CSRF layer 2)', e4.status === 415 && e4.json.error === 'unsupported_media_type');
  const e5 = await request(port, { method: 'POST', path: '/play/api/test/echo', headers: { 'content-type': 'application/json' }, body: '{"<script>alert(1)</script>":' });
  ok('e. bad JSON → 400, and the error never echoes the input', e5.status === 400 && e5.json.error === 'bad_json' && !/script|alert/.test(e5.text));

  lines.length = 0;
  const th = await request(port, { path: '/play/api/test/throw' });
  ok('e. a throwing handler → 500 {ok:false, error:"internal"}, no message or stack leaked',
    th.status === 500 && th.json.ok === false && th.json.error === 'internal' && !/boom|secret|at /.test(th.text));
  ok('e. …the failure is logged with the request id, on ONE line',
    lines.some((l) => /^error .*\[http\] GET \/play\/api\/test\/throw id=[0-9a-f]{16} failed: Error: boom/.test(l)) && lines.every((l) => !/\n/.test(l)));
  ok('e. …and the process still serves the next request', (await request(port, { path: '/play/api/health' })).status === 200);
  ok('e. a handler that returns nothing → 500 (never a hung request)', (await request(port, { path: '/play/api/test/nothing' })).status === 500);

  hdb.close();
  const down = await request(port, { path: '/play/api/health' });
  ok('e. health with the DB closed → 503 db_unavailable (the pool probe sees unhealthy)', down.status === 503 && down.json.error === 'db_unavailable');

  app.markShuttingDown();
  const sd = await request(port, { path: '/play/api/health' });
  ok('e. during shutdown a request gets 503 shutting_down + Connection: close', sd.status === 503 && sd.json.error === 'shutting_down' && sd.headers.connection === 'close');
  await new Promise((r) => server.close(r));

  ok('e. listen() refuses a non-loopback bind', await listen(createServer(() => {}), 0, '0.0.0.0').then(() => false, (e) => /non-loopback/.test(e.message)));
  ok('e. router refuses a duplicate route', throwsLike(() => app.router.add('GET', '/play/api/health', () => ({})), /duplicate/));

  // ── [f] maintenance ─────────────────────────────────────────────────────────────────
  console.log('\n[f] maintenance: named jobs, serial, coalesced, unref\'d timers\n');
  lines.length = 0;
  const order = [];
  const mt = createMaintenance({ log });
  mt.register('first_job', () => { order.push('first'); }, { tier: '5m' });
  mt.register('broken_job', () => { throw new Error('kaput'); }, { tier: '5m' });
  mt.register('slow_job', () => new Promise((r) => setTimeout(() => { order.push('slow'); r(); }, 25)), { tier: '5m', budgetMs: 5 });
  mt.register('hourly_job', () => { order.push('hourly'); }, { tier: '1h' });
  const r1 = mt.runTier('5m');
  const r2 = mt.runTier('5m');          // coalesced into r1
  const r3 = mt.runTier('1h');          // queued behind the 5m run
  await Promise.all([r1, r2, r3]);
  ok('f. jobs run in order, a throwing job does not stop the next, tiers run serially, a due tier coalesces',
    JSON.stringify(order) === JSON.stringify(['first', 'slow', 'hourly']), order.join(','));
  ok('f. each job logs one line with its elapsed time', lines.some((l) => /\[maint\] 5m first_job ok \d+ms/.test(l)));
  ok('f. a failure is logged', lines.some((l) => /^error .*\[maint\] 5m broken_job FAILED/.test(l)));
  ok('f. a job over budget logs a warning', lines.some((l) => /^warn .*slow_job ok \d+ms \(over budget 5ms\)/.test(l)));
  ok('f. bad name / unknown tier / duplicate refused',
    throwsLike(() => mt.register('Bad Name', () => {}), /bad job name/) && throwsLike(() => mt.register('x', () => {}, { tier: '1d' }), /unknown tier/)
    && throwsLike(() => mt.register('first_job', () => {}), /duplicate/));
  mt.start();
  ok('f. timers are unref\'d (never hold the process open)', mt._timers.length === 2 && mt._timers.every((x) => x.hasRef() === false));
  await mt.stop();
  ok('f. stop() clears every timer', mt._timers.length === 0);
  order.length = 0;
  await mt.runTier('5m');
  ok('f. nothing runs after stop()', order.length === 0);

  // ── [g] graceful shutdown ───────────────────────────────────────────────────────────
  console.log('\n[g] shutdown: drain in-flight, force after the grace period, close the DB\n');
  {
    const gdb = openDb(':memory:', { net: 'mainnet' });
    const gapp = buildApp({ config: appConfig('mainnet'), db: gdb, log });
    let release;
    gapp.router.add('GET', '/play/api/test/slow', () => new Promise((r) => { release = r; }).then(() => ({ ok: true })));
    const gs = createServer(gapp.handler);
    const { port: gp } = await listen(gs, 0, '127.0.0.1');
    const inflight = request(gp, { path: '/play/api/test/slow' });
    await new Promise((r) => setTimeout(r, 50));
    const done = shutdown({ server: gs, app: gapp, maintenance: createMaintenance({ log }), db: gdb, log, graceMs: 2000 });
    const refused = await new Promise((resolve) => {
      const s = net.connect(gp, '127.0.0.1');
      s.on('connect', () => { s.destroy(); resolve(false); });
      s.on('error', () => resolve(true));
    });
    ok('g. after shutdown starts, new connections are refused', refused);
    release();
    const res = await inflight;
    const { forced } = await done;
    ok('g. the in-flight request finishes normally', res.status === 200 && res.json.ok === true);
    ok('g. shutdown resolves unforced and closes the DB', forced === false && gdb.raw.isOpen === false);
  }
  {
    const gdb = openDb(':memory:', { net: 'mainnet' });
    const gapp = buildApp({ config: appConfig('mainnet'), db: gdb, log });
    gapp.router.add('GET', '/play/api/test/hang', () => new Promise(() => {}));
    const gs = createServer(gapp.handler);
    const { port: gp } = await listen(gs, 0, '127.0.0.1');
    const hung = request(gp, { path: '/play/api/test/hang' }).then(() => 'answered', () => 'cut');
    await new Promise((r) => setTimeout(r, 50));
    lines.length = 0;
    const t0 = Date.now();
    const { forced } = await shutdown({ server: gs, app: gapp, maintenance: null, db: gdb, log, graceMs: 200 });
    ok('g. a request that never finishes is cut after the grace period', forced === true && Date.now() - t0 < 2000 && (await hung) === 'cut');
    ok('g. …with a warning, and the DB still closes', lines.some((l) => /still open after 200ms/.test(l)) && gdb.raw.isOpen === false);
  }

  // ── [h] zero dependencies, no pool imports ──────────────────────────────────────────
  console.log('\n[h] zero npm dependencies; nothing imported from back-end-pool\n');
  const pkg = JSON.parse(fs.readFileSync(path.join(SERVER, 'package.json'), 'utf8'));
  ok('h. package.json declares no dependencies of any kind (D2)',
    ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'bundledDependencies'].every((k) => !pkg[k] || Object.keys(pkg[k]).length === 0));
  ok('h. package.json: private, engines node >=24', pkg.private === true && pkg.engines && pkg.engines.node === '>=24.0.0');
  ok('h. no node_modules directory', !fs.existsSync(path.join(SERVER, 'node_modules')));
  const jsFiles = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const f = path.join(d, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(f); } else if (e.name.endsWith('.js')) jsFiles.push(f);
  } };
  walk(SERVER);
  const badRequires = [];
  // Line by line: comment-only lines are prose, and this suite's own messages about
  // require calls opt out with the marker below. Every other line of every file is scanned.
  const SCAN_IGNORE = '// scan:ignore';
  const isComment = (l) => /^\s*(\/\/|\/\*|\*)/.test(l);
  for (const f of jsFiles) {
    const rel = path.relative(SERVER, f).replace(/\\/g, '/');
    const src = fs.readFileSync(f, 'utf8').split('\n')
      .filter((l) => !isComment(l) && !l.trimEnd().endsWith(SCAN_IGNORE)).join('\n');
    for (const m of src.matchAll(/\brequire\s*\(\s*([^)]*)\)/g)) {
      const arg = m[1].trim();
      const lit = /^'([^']*)'$/.exec(arg) || /^"([^"]*)"$/.exec(arg);
      // This suite loads lib/ via path.join(SERVER, …) — allowed only here. A later part
      // that needs a computed require (the game registry loading rules.js) adds its own
      // reviewed exception, with the path-containment check it relies on.
      if (!lit) {
        if (!(rel === 'scripts/test-skeleton.js' && /^path\.join\(SERVER, '[a-z/.-]+'$/.test(arg))) {
          badRequires.push(`${rel}: computed require (${arg.slice(0, 40)})`); // scan:ignore
        }
        continue;
      }
      const spec = lit[1];
      if (spec.startsWith('node:')) continue;
      if (spec.startsWith('.')) {
        const target = path.resolve(path.dirname(f), spec);
        if (path.relative(SERVER, target).startsWith('..')) badRequires.push(`${rel}: ${spec} (outside server/)`);
        continue;
      }
      badRequires.push(`${rel}: ${spec} (a package or un-prefixed builtin)`);
    }
  }
  ok(`h. every require is node:* or relative inside server/ (${jsFiles.length} files)`, badRequires.length === 0, badRequires.join('; '));
  ok('h. no file names back-end-pool in a require call — D5: never import the pool',
    jsFiles.every((f) => !/require\s*\([^)]*back-end-pool/.test(fs.readFileSync(f, 'utf8')))); // scan:ignore
  ok('h. the scanner is live: it flags a planted package require', (() => { // scan:ignore
    const probe = "const x = require('express');"; // scan:ignore
    return [...probe.matchAll(/\brequire\s*\(\s*([^)]*)\)/g)].length === 1; // scan:ignore
  })());

  // ── [i] the real boot path (index.js as a child process) ────────────────────────────
  console.log('\n[i] index.js: exit codes, a live boot, health, stop\n');
  const INDEX = path.join(SERVER, 'index.js');
  const childEnv = (extra) => {
    const env = { ...process.env, ...extra };
    for (const k of Object.keys(env)) if (k.startsWith('GAMES_') && !(k in extra)) delete env[k];
    return env;
  };
  const NODE_ARGS = ['--disable-warning=ExperimentalWarning', INDEX];
  const r78 = spawnSync(process.execPath, NODE_ARGS, { env: childEnv({ GAMES_NET: 'floonet' }), encoding: 'utf8', timeout: 20000 });
  ok('i. a bad config exits 78 (EX_CONFIG) with one [boot] config line',
    r78.status === 78 && /\[boot\] config: GAMES_NET="floonet": must be mainnet or testnet/.test(r78.stderr) && r78.stderr.trim().split('\n').length === 1,
    `${r78.status} ${r78.stderr.trim()}`);
  const netDb = tmpDb('boot-mainnet.db');
  openDb(netDb, { net: 'mainnet' }).close();
  const rNet = spawnSync(process.execPath, NODE_ARGS, { env: childEnv({ GAMES_NET: 'testnet', GAMES_DB: netDb }), encoding: 'utf8', timeout: 20000 });
  ok('i. a DB of the other network exits 1 with a [boot] database line',
    rNet.status === 1 && /\[boot\] database .*belongs to "mainnet"/.test(rNet.stderr), `${rNet.status} ${rNet.stderr.trim()}`);

  const freePort = await new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
  const bootDb = path.join(TMP, 'boot-data', 'grinium-games.db');   // dir does not exist yet
  const child = spawn(process.execPath, NODE_ARGS, {
    env: childEnv({ GAMES_NET: 'testnet', GAMES_DB: bootDb, GAMES_PORT: String(freePort) }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { out += c; });
  const exited = new Promise((r) => child.once('exit', (code, sig) => r({ code, sig })));
  try {
    const t0 = Date.now();
    while (!/listening on/.test(out) && Date.now() - t0 < 15000 && child.exitCode === null) await new Promise((r) => setTimeout(r, 50));
    ok('i. boots: migrates, then listens on 127.0.0.1:<GAMES_PORT>',
      new RegExp(`listening on 127\\.0\\.0\\.1:${freePort} · schema v${LATEST_VERSION}`).test(out) && out.includes(`migrated schema v0 → v${LATEST_VERSION}`), out.trim());
    const live = await request(freePort, { path: '/play/api/health' });
    ok('i. the live service answers /play/api/health', live.status === 200 && live.json.net === 'testnet' && live.json.schema === LATEST_VERSION);
    ok('i. the DB was created in the configured data dir', fs.existsSync(bootDb));
    if (process.platform === 'win32') {
      child.kill();
      await exited;
      console.log('  SKIP  i. SIGTERM → drain → exit 0 — Windows has no catchable SIGTERM (covered by [g]; checked on the VPS)');
    } else {
      child.kill('SIGTERM');
      const { code } = await exited;
      ok('i. SIGTERM drains and exits 0', code === 0 && /\[shutdown\] done/.test(out), `${code} ${out.trim()}`);
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
}

main().catch((e) => {
  fail++;
  console.error(`  FAIL  suite crashed: ${e && e.stack ? e.stack : e}`);
}).finally(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { console.error(`  (could not remove ${TMP}: ${e.message})`); }
  console.log(`\nRESULT pass=${pass} fail=${fail}`);
  process.exitCode = fail ? 1 : 0;
});
