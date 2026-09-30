'use strict';

// Part 4 (design §19.3, §19.5, §19.6): the pool-link client, the limiters, the plays/points
// ledger, the activity sync, login + sessions + /me, the CSRF layers and the mode gate.
//
// The pool is a STUB: an http server on 127.0.0.1:0 for the real pool-link client ([a]), and
// in-process fakes everywhere else. Servers are closed before the suite ends, temp files
// live under os.tmpdir() and are removed. Nothing is left running.
// Run: node scripts/test-auth.js

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');

const { openDb } = require('../lib/db.js');
const { createLogger } = require('../lib/log.js');
const { createPoolLink, PoolLinkError } = require('../lib/pool-link.js');
const { createTokenBuckets, createFailureBackoff } = require('../lib/ratelimit.js');
const { createLedger, LedgerError } = require('../lib/ledger.js');
const { createSettings } = require('../lib/settings.js');
const { createActivitySync, LAG_S } = require('../lib/plays.js');
const { createModeCache } = require('../lib/mode.js');
const { LOGIN_REASONS } = require('../lib/auth.js');
const { buildApp, createServer, listen } = require('../lib/app.js');
const { maskAddr } = require('../lib/mask.js');

let pass = 0, fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else      { fail++; console.error(`  FAIL  ${name}${extra ? ' — ' + extra : ''}`); }
}
async function rejectsCode(p, code, check) {
  try { await p; return false; } catch (e) { return e instanceof PoolLinkError && e.code === code && (!check || check(e)); }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'grin-games-auth-'));
const lines = [];
const log = createLogger((level, line) => lines.push(`${level} ${line}`));

// Deterministic, well-formed addresses (bech32 charset, 58 chars after the prefix).
const CS = 'acdefghjklmnpqrstuvwxyz023456789';
function addr(n, prefix = 'grin1') {
  let x = (n * 7919 + 13) >>> 0;
  let s = '';
  for (let i = 0; i < 58; i++) { x = (Math.imul(x, 1103515245) + 12345) >>> 0; s += CS[(x >>> 16) % 32]; }
  return prefix + s;
}
// Seeded PRNG (mulberry32) — tests must be reproducible.
function prng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

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
  // ── [a] pool-link against a stub pool ───────────────────────────────────────────────
  console.log('\n[a] pool-link client: secret file, headers, shapes, error codes (stub pool on 127.0.0.1:0)\n');
  const seen = [];
  let answer = null;                    // (req, body) → [status, bodyString] | 'hang'
  const stub = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      const a = answer(req, body);
      if (a === 'hang') return;         // never answers; the client's timeout must fire
      res.statusCode = a[0];
      res.setHeader('Content-Type', 'application/json');
      res.end(a[1]);
    });
  });
  const stubAddr = await listen(stub, 0, '127.0.0.1');
  const SECRET = crypto.randomBytes(48).toString('base64');
  const secretFile = path.join(TMP, 'link');
  fs.writeFileSync(secretFile, `  ${SECRET}\n`);
  let lt = 1_000_000;
  const linkCfg = { net: 'mainnet', poolInternalUrl: `http://127.0.0.1:${stubAddr.port}`, linkSecretFile: secretFile };
  const link = createPoolLink({ config: linkCfg, clock: () => lt, timeoutMs: 300 });
  const A1 = addr(1);

  answer = () => [200, JSON.stringify({ ok: true, method: 'password', slot: 'set', age_seconds: 42 })];
  let r = await link.verifyProof(A1, 'hunter2hunter2', '203.0.113.7');
  const last = () => seen[seen.length - 1];
  ok('a. verify ok → {ok, method, slot, age_seconds}', r.ok === true && r.method === 'password' && r.slot === 'set' && r.age_seconds === 42);
  ok('a. secret sent TRIMMED in X-Games-Link', last().headers['x-games-link'] === SECRET);
  ok('a. NO X-Forwarded-For and NO X-Real-IP sent to the pool (§19.15 Part 2 #3)',
    last().headers['x-forwarded-for'] === undefined && last().headers['x-real-ip'] === undefined);
  ok('a. verify body = {address, proof, client_ip} exactly, client_ip = the player IP', (() => {
    const b = JSON.parse(last().body); return Object.keys(b).sort().join() === 'address,client_ip,proof' && b.client_ip === '203.0.113.7';
  })());
  ok('a. POST path + JSON content type', last().method === 'POST' && last().url === '/internal/games/verify-proof'
    && /^application\/json/.test(last().headers['content-type']));
  answer = () => [200, JSON.stringify({ ok: false, reason: 'no_match' })];
  r = await link.verifyProof(A1, 'x', '203.0.113.7');
  ok('a. verify refused → {ok:false, reason} (a proof RESULT, not an error)', r.ok === false && r.reason === 'no_match');
  answer = () => [200, JSON.stringify({ ok: true, method: 'sms', slot: 'set', age_seconds: null })];
  ok('a. verify with an unknown method → bad_response', await rejectsCode(link.verifyProof(A1, 'x', '203.0.113.7'), 'bad_response'));
  answer = () => [200, JSON.stringify({ ok: true, method: 'ip', slot: 'set', age_seconds: -5 })];
  ok('a. verify with a negative age → bad_response', await rejectsCode(link.verifyProof(A1, 'x', '203.0.113.7'), 'bad_response'));
  answer = () => [200, JSON.stringify({ ok: false, reason: '<script>' })];
  ok('a. verify with a non-code reason → bad_response', await rejectsCode(link.verifyProof(A1, 'x', '203.0.113.7'), 'bad_response'));
  answer = () => [401, JSON.stringify({ ok: false, error: 'unauthorised' })];
  ok('a. 401 → link_unauthorised', await rejectsCode(link.verifyProof(A1, 'x', '203.0.113.7'), 'link_unauthorised'));
  answer = () => [503, JSON.stringify({ ok: false, error: 'link_not_configured' })];
  ok('a. pool 503 link_not_configured → link_not_configured', await rejectsCode(link.verifyProof(A1, 'x', '203.0.113.7'), 'link_not_configured'));
  answer = () => [400, JSON.stringify({ ok: false, error: 'bad_request', field: 'client_ip' })];
  ok('a. 400 → link_rejected with field', await rejectsCode(link.verifyProof(A1, 'x', '203.0.113.7'), 'link_rejected', (e) => e.field === 'client_ip'));
  answer = () => [500, JSON.stringify({ ok: false, error: 'internal' })];
  ok('a. 500 → pool_error', await rejectsCode(link.verifyProof(A1, 'x', '203.0.113.7'), 'pool_error'));
  answer = () => [200, '<html>proxy error</html>'];
  ok('a. non-JSON 200 → bad_response', await rejectsCode(link.verifyProof(A1, 'x', '203.0.113.7'), 'bad_response'));
  answer = () => 'hang';
  const t0 = Date.now();
  ok('a. no answer → link_down (timeout bounds the whole exchange)', await rejectsCode(link.config(), 'link_down', (e) => e.why === 'timeout'));
  ok('a. …within the timeout', Date.now() - t0 < 2000);

  // Error messages never carry the secret or the proof.
  answer = () => [401, '{}'];
  try { await link.verifyProof(A1, 'my-secret-proof-value', '203.0.113.7'); } catch (e) {
    ok('a. an error carries neither the secret nor the proof', !JSON.stringify({ m: e.message, ...e }).includes(SECRET) && !JSON.stringify({ m: e.message, ...e }).includes('my-secret-proof-value'));
  }

  // activity
  const A2 = addr(2);
  answer = (req) => {
    const q = new URLSearchParams(req.url.split('?')[1]);
    return [200, JSON.stringify({ ok: true, from: Number(q.get('from')), to: Number(q.get('to')), rows: [
      { address: A1, minutes: 60, seconds: 3600 },
      { address: A2, minutes: 3, seconds: 180 },
      { address: A2, minutes: 3, seconds: 180 },                        // duplicate
      { address: addr(3, 'tgrin1'), minutes: 1, seconds: 60 },          // other network
      { address: 'grin1short', minutes: 1, seconds: 60 },                // malformed
      { address: addr(4), minutes: 1, seconds: -60 },                    // negative
      { address: addr(5), minutes: 1, seconds: 1.5 },                    // not an integer
    ] })];
  };
  const act = await link.activity(7200, 10800);
  ok('a. activity GET with exact from/to query', last().method === 'GET' && last().url === '/internal/games/activity?from=7200&to=10800');
  ok('a. activity keeps good rows, drops dup/other-net/malformed/negative/non-integer',
    act.rows.length === 2 && act.dropped === 5 && act.rows[0].address === A1 && act.rows[1].seconds === 180);
  answer = () => [200, JSON.stringify({ ok: true, from: 1, to: 10800, rows: [] })];
  ok('a. activity echoing a different window → bad_response', await rejectsCode(link.activity(7200, 10800), 'bad_response'));

  // config
  answer = () => [200, JSON.stringify({ ok: true, mode: 'preview', chat_enabled: false, net: 'mainnet' })];
  const cfgR = await link.config();
  ok('a. config → {mode, chat_enabled}', cfgR.mode === 'preview' && cfgR.chat_enabled === false);
  answer = () => [200, JSON.stringify({ ok: true, mode: 'on', chat_enabled: 'false', net: 'mainnet' })];
  ok('a. config with a QUOTED "false" → bad_response (typed, never truthy)', await rejectsCode(link.config(), 'bad_response'));
  answer = () => [200, JSON.stringify({ ok: true, mode: 'on', chat_enabled: true, net: 'testnet' })];
  ok('a. config from the other network → bad_response', await rejectsCode(link.config(), 'bad_response', (e) => e.why === 'wrong_network'));
  answer = () => [200, JSON.stringify({ ok: true, mode: 'ON', chat_enabled: true, net: 'mainnet' })];
  ok('a. config with an unknown mode → bad_response', await rejectsCode(link.config(), 'bad_response'));

  // Secret file lifecycle.
  answer = () => [200, JSON.stringify({ ok: true, mode: 'on', chat_enabled: true, net: 'mainnet' })];
  const SECRET2 = crypto.randomBytes(48).toString('base64url');
  fs.writeFileSync(secretFile, `${SECRET2}\n\n`);
  lt += 1001;                                              // past the 1 s stat memo
  await link.config();
  ok('a. rotation: a new file content is picked up after the stat memo, no restart', last().headers['x-games-link'] === SECRET2);
  fs.writeFileSync(secretFile, 'short-secret');
  lt += 1001;
  let before = seen.length;
  ok('a. secret < 32 bytes → link_not_configured, no request sent',
    await rejectsCode(link.config(), 'link_not_configured') && seen.length === before);
  fs.unlinkSync(secretFile);
  lt += 1001;
  before = seen.length;
  ok('a. missing secret file → link_not_configured, no request sent',
    await rejectsCode(link.config(), 'link_not_configured') && seen.length === before && link.secretConfigured() === false);
  fs.writeFileSync(secretFile, 'x'.repeat(5000));
  lt += 1001;
  ok('a. secret file > 4 KB → link_not_configured', await rejectsCode(link.config(), 'link_not_configured'));
  await new Promise((res) => stub.close(res));
  fs.writeFileSync(secretFile, SECRET);
  lt += 1001;
  ok('a. pool not listening → link_down', await rejectsCode(link.config(), 'link_down'));

  // ── [b] limiters ────────────────────────────────────────────────────────────────────
  console.log('\n[b] token buckets + failure backoff\n');
  let bt = 0;
  const tb = createTokenBuckets({ capacity: 3, refillPerSec: 1 / 60, maxKeys: 4, clock: () => bt });
  ok('b. bucket: capacity takes succeed', tb.take('k').ok && tb.take('k').ok && tb.take('k').ok);
  const refused = tb.take('k');
  ok('b. bucket: next is refused with retryAfter ≈ 60 s', !refused.ok && refused.retryAfter === 60);
  bt += 60_000;
  ok('b. bucket: one token back after 60 s', tb.take('k').ok && !tb.take('k').ok);
  for (let i = 0; i < 10; i++) tb.take(`other${i}`);
  ok('b. bucket map is LRU-bounded (maxKeys 4)', tb.size() === 4);

  let ft = 0;
  const fb = createFailureBackoff({ threshold: 3, baseLockSec: 60, maxLockSec: 600, memorySec: 3600, maxKeys: 3, clock: () => ft });
  fb.fail('ip'); fb.fail('ip');
  ok('b. backoff: under threshold → not locked', !fb.check('ip').locked);
  const l1 = fb.fail('ip');
  ok('b. backoff: threshold → locked for the base 60 s', l1.locked && l1.retryAfter === 60 && fb.check('ip').locked);
  ft += 61_000;
  ok('b. backoff: lock expires', !fb.check('ip').locked);
  ok('b. backoff: the record SURVIVES the expiry (memory reference_express_throttle_traps #3)', fb._peek('ip') && fb._peek('ip').lockCount === 1);
  fb.fail('ip'); fb.fail('ip');
  const l2 = fb.fail('ip');
  ok('b. backoff: the NEXT lockout is longer (120 s — escalation reachable)', l2.locked && l2.retryAfter === 120);
  ft += 121_000;
  fb.success('ip');
  fb.fail('ip'); fb.fail('ip');
  const l3 = fb.fail('ip');
  ok('b. backoff: a success resets the count, not the escalation (240 s)', l3.retryAfter === 240);
  ok('b. backoff: capped at maxLockSec', (() => {
    for (let k = 0; k < 10; k++) { ft += 700_000; fb.fail('ip'); fb.fail('ip'); fb.fail('ip'); }
    return fb.check('ip').retryAfter <= 600;
  })());
  // Overflow: every slot a live lockout → new keys are not recorded, live locks are kept.
  const fo = createFailureBackoff({ threshold: 1, baseLockSec: 60, maxLockSec: 60, memorySec: 3600, maxKeys: 2, clock: () => ft });
  fo.fail('a'); fo.fail('b');
  const fc = fo.fail('c');
  ok('b. backoff overflow never evicts a LIVE lockout', fc.unrecorded === true && fo.check('a').locked && fo.check('b').locked);
  ft += 61_000;
  fo.fail('c');
  ok('b. backoff overflow evicts an UNLOCKED record instead', fo.size() === 2 && fo.check('c').locked);
  ft += 3601_000 + 61_000;
  ok('b. sweep drops a record only once unlocked AND past the memory window', fo.sweep() === 2 && fo.size() === 0);

  // ── [c] ledger ──────────────────────────────────────────────────────────────────────
  console.log('\n[c] ledger: balance = Σ ledger, no overdraft, exactly-once refs\n');
  const ldb = openDb(':memory:', { net: 'mainnet', log });
  const ledger = createLedger({ db: ldb, now: () => 1_700_000_000 });
  const P = addr(10);
  ledger.credit(P, 'plays', 5, 'mining_minutes', 'w:100');
  ok('c. credit creates the player row and the balance', ldb.raw.prepare('SELECT plays FROM players WHERE address = ?').get(P).plays === 5);
  const dup = ledger.credit(P, 'plays', 5, 'mining_minutes', 'w:100');
  ok('c. the same ref twice is a no-op (duplicate:true)', dup.duplicate === true && ledger.verify().length === 0
    && ldb.raw.prepare('SELECT plays FROM players WHERE address = ?').get(P).plays === 5);
  let lerr = null;
  try { ledger.debit(P, 'plays', 6, 'match_cost', 'm:1:1'); } catch (e) { lerr = e; }
  ok('c. an overdraft is refused with LedgerError no_plays', lerr instanceof LedgerError && lerr.code === 'no_plays');
  ok('c. …and writes nothing', ldb.raw.prepare('SELECT COUNT(*) AS c FROM ledger').get().c === 1);
  ledger.debit(P, 'plays', 5, 'match_cost', 'm:1:1');
  ok('c. a debit to exactly 0 is allowed', ldb.raw.prepare('SELECT plays FROM players WHERE address = ?').get(P).plays === 0);
  for (const [name, fn] of [
    ['delta 0', () => ledger.post({ address: P, kind: 'plays', delta: 0, reason: 'admin_adjust' })],
    ['delta NaN', () => ledger.post({ address: P, kind: 'plays', delta: NaN, reason: 'admin_adjust' })],
    ['delta Infinity', () => ledger.post({ address: P, kind: 'plays', delta: Infinity, reason: 'admin_adjust' })],
    ['delta 1.5', () => ledger.post({ address: P, kind: 'plays', delta: 1.5, reason: 'admin_adjust' })],
    ['delta 2^53', () => ledger.post({ address: P, kind: 'plays', delta: 2 ** 53, reason: 'admin_adjust' })],
    ['unknown reason', () => ledger.post({ address: P, kind: 'plays', delta: 1, reason: 'gift' })],
    ['unknown kind', () => ledger.post({ address: P, kind: 'grin', delta: 1, reason: 'admin_adjust' })],
    ['bad ref', () => ledger.post({ address: P, kind: 'plays', delta: 1, reason: 'admin_adjust', ref: 'x y' })],
  ]) {
    let threw = false;
    try { fn(); } catch { threw = true; }
    ok(`c. ${name} → refused`, threw);
  }
  // A credit inside a transaction that later fails is rolled back with it.
  try { ldb.transaction(() => { ledger.credit(P, 'points', 3, 'admin_adjust', 'x:1'); throw new Error('later step failed'); }); } catch { /* expected */ }
  ok('c. a credit inside a failed outer transaction rolls back with it',
    ldb.raw.prepare('SELECT points FROM players WHERE address = ?').get(P).points === 0 && ledger.verify().length === 0);
  // 1000 random ops.
  const rnd = prng(424242);
  const who = [addr(11), addr(12), addr(13), addr(14)];
  let refusedOps = 0, dupOps = 0;
  for (let i = 0; i < 1000; i++) {
    const a = who[Math.floor(rnd() * who.length)];
    const kind = rnd() < 0.5 ? 'plays' : 'points';
    const amount = 1 + Math.floor(rnd() * 5);
    const ref = rnd() < 0.2 ? `r:${Math.floor(rnd() * 50)}` : null;   // some refs repeat
    try {
      const res = rnd() < 0.55
        ? ledger.credit(a, kind, amount, 'admin_adjust', ref)
        : ledger.debit(a, kind, amount, 'match_cost', ref);
      if (res.duplicate) dupOps++;
    } catch (e) {
      if (e instanceof LedgerError) refusedOps++; else throw e;
    }
  }
  ok(`c. 1000 random ops (${refusedOps} refused overdrafts, ${dupOps} duplicate refs): invariant holds`, ledger.verify().length === 0);
  ok('c. no balance ever went negative', ldb.raw.prepare('SELECT COUNT(*) AS c FROM players WHERE plays < 0 OR points < 0').get().c === 0);
  ldb.raw.prepare('UPDATE players SET plays = plays + 7 WHERE address = ?').run(who[0]);
  const drift = ledger.verify();
  ok('c. verify() REPORTS a tampered balance', drift.length === 1 && drift[0].address === who[0] && drift[0].kind === 'plays');
  ok('c. …and does not fix it', ledger.verify().length === 1);
  ldb.close();

  // ── [d] activity sync ───────────────────────────────────────────────────────────────
  console.log('\n[d] activity sync: hour windows, idempotent, caps, catch-up bound, lookback\n');
  const DAY = 86400;
  const D0 = 1_767_225_600;                    // 2026-01-01T00:00:00Z
  function syncHarness({ rowsFor, secretOk = true, fail: failFn } = {}) {
    const db = openDb(':memory:', { net: 'mainnet', log });
    let now = D0;
    const calls = [];
    const fake = {
      secretConfigured: () => secretOk,
      async activity(from, to) {
        calls.push([from, to]);
        await new Promise((res) => setImmediate(res));   // async, like the real one
        if (failFn) { const e = failFn(from, to); if (e) throw e; }
        return { from, to, rows: rowsFor ? rowsFor(from, to) : [], dropped: 0 };
      },
    };
    const settings = createSettings({ db, log, clock: () => now * 1000 });
    const lg = createLedger({ db, now: () => now });
    const sync = createActivitySync({ db, poolLink: fake, ledger: lg, settings, log, now: () => now });
    return { db, sync, lg, settings, calls, setNow: (t) => { now = t; }, getNow: () => now,
      plays: (a) => (db.raw.prepare('SELECT plays FROM players WHERE address = ?').get(a) || { plays: null }).plays };
  }
  const M = addr(20);
  // M mines every second of every window.
  const always = (from, to) => [{ address: M, minutes: Math.round((to - from) / 60), seconds: to - from }];

  let h = syncHarness({ rowsFor: always });
  h.setNow(D0 + 5 * 3600 + 30 * 60);           // 05:30 UTC
  let sres = await h.sync.syncOnce();
  const end = D0 + 5 * 3600 + 30 * 60 - LAG_S;
  ok('d. first sync starts at the UTC day\'s midnight', h.calls[0][0] === D0);
  ok('d. windows are contiguous, hour-aligned, ≤ 3600 s, end at now − 120 s', (() => {
    for (let i = 0; i < h.calls.length; i++) {
      const [f, t] = h.calls[i];
      if (t - f <= 0 || t - f > 3600) return false;
      if (Math.floor(f / 3600) !== Math.floor((t - 1) / 3600)) return false;   // never crosses an hour
      if (i && h.calls[i - 1][1] !== f) return false;
    }
    return h.calls[h.calls.length - 1][1] === end;
  })(), JSON.stringify(h.calls));
  ok('d. 5 h 28 min at 10 min/play → 32 plays, capped at 24/day', h.plays(M) === 24 && sres.windows === 6);
  ok('d. a miner who never logged in gets a players row', h.plays(M) !== null);
  const callsBefore = h.calls.length;
  sres = await h.sync.syncOnce();
  ok('d. a second sync at the same time makes no pool call and credits nothing', h.calls.length === callsBefore && h.plays(M) === 24);
  ok('d. creditWindow for an already-synced window is a no-op', h.sync.creditWindow(D0, D0 + 3600, always(D0, D0 + 3600)).duplicate === true && h.plays(M) === 24);
  ok('d. ledger invariant after sync', h.lg.verify().length === 0);

  // Concurrent syncs of the same window: exactly one credits.
  h = syncHarness({ rowsFor: always });
  h.setNow(D0 + 30 * 60);                      // 00:30 → one window 00:00–00:28
  await Promise.all([h.sync.syncOnce(), h.sync.syncOnce()]);
  ok('d. two concurrent syncs of one window → one credit (UNIQUE window_from)',
    h.plays(M) === 2 && h.db.raw.prepare("SELECT COUNT(*) AS c FROM ledger WHERE reason = 'mining_minutes'").get().c === 1,
    `plays=${h.plays(M)}`);

  // The day boundary: the cap resets at UTC midnight, minutes land on their own day.
  h = syncHarness({ rowsFor: always });
  h.setNow(D0 + DAY - 3600);                   // 23:00 day 0
  await h.sync.syncOnce();
  const day0 = h.plays(M);
  h.setNow(D0 + DAY + 10 * 60);                // 00:10 day 1
  await h.sync.syncOnce();
  const daily = h.db.raw.prepare('SELECT day, seconds, plays_awarded FROM activity_daily WHERE address = ? ORDER BY day').all(M);
  ok('d. cap reached on day 0, then new plays on day 1 (cap resets at UTC midnight)',
    day0 === 24 && daily.length === 2 && daily[0].day === '2026-01-01' && daily[1].day === '2026-01-02' && daily[1].plays_awarded === 0 && h.plays(M) === 24,
    JSON.stringify(daily));
  h.setNow(D0 + DAY + 40 * 60);
  await h.sync.syncOnce();
  ok('d. …and day 1 earns from its own minutes (00:00–00:38 → 3 plays)', h.plays(M) === 27, `plays=${h.plays(M)}`);
  ok('d. day 0 got exactly 24 h of seconds', daily[0].seconds === DAY);

  // Clamp: the pool claims more seconds than the window has.
  h = syncHarness({ rowsFor: (from, to) => [{ address: M, minutes: 999, seconds: 999999 }] });
  h.setNow(D0 + 3600 + LAG_S);                 // exactly one full window 00:00–01:00
  await h.sync.syncOnce();
  ok('d. seconds are clamped to the window length (3600 s → 6 plays)', h.plays(M) === 6, `plays=${h.plays(M)}`);

  // Balance cap: lost, not deferred.
  h = syncHarness({ rowsFor: always });
  h.settings.set('plays_balance_cap', 4, 'test');
  h.setNow(D0 + 3600 + LAG_S);
  await h.sync.syncOnce();
  const aw = h.db.raw.prepare('SELECT plays_awarded FROM activity_daily WHERE address = ?').get(M).plays_awarded;
  ok('d. balance cap: 6 due, 4 credited, and plays_awarded = 6 (the 2 are lost, not deferred)', h.plays(M) === 4 && aw === 6);
  h.lg.debit(M, 'plays', 4, 'match_cost', 'm:9:1');
  h.setNow(D0 + 2 * 3600 + LAG_S);
  await h.sync.syncOnce();
  ok('d. …after spending, only NEW minutes earn (6 more, capped at 4)', h.plays(M) === 4 && h.lg.verify().length === 0);

  // Lowering the daily cap mid-day never claws back.
  h = syncHarness({ rowsFor: always });
  h.setNow(D0 + 3 * 3600 + LAG_S);
  await h.sync.syncOnce();
  h.settings.set('plays_daily_cap', 5, 'test');
  h.setNow(D0 + 4 * 3600 + LAG_S);
  await h.sync.syncOnce();
  ok('d. lowering the daily cap mid-day: no claw-back, no further credit', h.plays(M) === 18 && h.lg.verify().length === 0, `plays=${h.plays(M)}`);

  // Catch-up bound and lookback.
  h = syncHarness({ rowsFor: always });
  h.setNow(D0 + 3600);
  await h.sync.syncOnce();                       // watermark ≈ 00:58
  h.setNow(D0 + 3600 + 30 * 3600);               // 30 h later
  h.calls.length = 0;
  await h.sync.syncOnce();
  ok('d. catch-up is bounded: ≤ 24 pool calls per tick', h.calls.length === 24);
  h.calls.length = 0;
  await h.sync.syncOnce();
  ok('d. …the next tick finishes it', h.calls.length > 0 && h.calls.length <= 24 && h.calls[h.calls.length - 1][1] === h.getNow() - LAG_S);

  h = syncHarness({ rowsFor: always });
  h.setNow(D0 + 3600);
  await h.sync.syncOnce();
  h.setNow(D0 + 40 * DAY);                       // 39 days of outage
  h.calls.length = 0;
  sres = await h.sync.syncOnce();
  const skipped = h.db.raw.prepare('SELECT window_from, window_to, rows FROM activity_sync WHERE rows = -1').all();
  ok('d. > 7 days behind: ONE skipped row (rows = −1), no pool call for it', skipped.length === 1 && sres.skipped === 1);
  ok('d. …every pool call is inside the 7-day lookback', h.calls.every(([f]) => f >= h.getNow() - 7 * DAY));
  ok('d. …and windows stay contiguous across the skip', (() => {
    const rows = h.db.raw.prepare('SELECT window_from, window_to FROM activity_sync ORDER BY window_from').all();
    for (let i = 1; i < rows.length; i++) if (rows[i].window_from !== rows[i - 1].window_to) return false;
    return true;
  })());

  // Link failures.
  let failing = true;
  h = syncHarness({ rowsFor: always, fail: () => (failing ? new PoolLinkError('link_down') : null) });
  h.setNow(D0 + 2 * 3600);
  sres = await h.sync.syncOnce();
  ok('d. pool down → the tick stops, nothing is marked', sres.stopped === 'link_down' && h.db.raw.prepare('SELECT COUNT(*) AS c FROM activity_sync').get().c === 0);
  failing = false;
  await h.sync.syncOnce();
  ok('d. …and the next tick catches up from the same watermark', h.calls[h.calls.length - 1][1] === h.getNow() - LAG_S && h.plays(M) === 11);
  h = syncHarness({ rowsFor: always, fail: (f) => (f === D0 ? new PoolLinkError('link_rejected', { field: 'from' }) : null) });
  h.setNow(D0 + 2 * 3600);
  await h.sync.syncOnce();
  ok('d. the pool refusing a window as too old → that window is skipped, not retried forever',
    h.db.raw.prepare('SELECT rows FROM activity_sync WHERE window_from = ?').get(D0).rows === -1 && h.calls.length === 2);
  h = syncHarness({ rowsFor: always, secretOk: false });
  h.setNow(D0 + 2 * 3600);
  sres = await h.sync.syncOnce();
  ok('d. no link secret → no-op (no pool call)', sres.stopped === 'link_not_configured' && h.calls.length === 0);

  // ── [e] login + sessions + /me over a loopback server ──────────────────────────────
  console.log('\n[e] login, sessions, /me, CSRF, mode gate (stub pool, 127.0.0.1:0)\n');
  let T = 1_780_000_000_000;                     // ms
  const nowS = () => Math.floor(T / 1000);
  const edb = openDb(':memory:', { net: 'mainnet', log });
  const verifyCalls = [];
  const proofs = {
    'ip-ok': { ok: true, method: 'ip', slot: 'set', age_seconds: null },
    'pw-fresh-600': { ok: true, method: 'password', slot: 'set', age_seconds: 600 },
    'anchor-proof': { ok: true, method: 'ip', slot: 'anchor', age_seconds: null },
    'wrong-guess': { ok: false, reason: 'no_match' },
    'trivial-pw': { ok: false, reason: 'trivial_password' },
    'weird-reason': { ok: false, reason: 'something_new' },
    'pool-lookup': { ok: false, reason: 'lookup_failed' },
    'pool-toomany': { ok: false, reason: 'too_many_attempts' },
  };
  const fakeLink = {
    secretConfigured: () => true,
    async verifyProof(address, proof, ip) {
      verifyCalls.push({ address, proof, ip });
      if (proof === 'pool-down') throw new PoolLinkError('link_down');
      return proofs[proof] || { ok: false, reason: 'no_match' };
    },
    async activity() { return { rows: [], dropped: 0 }; },
    async config() { return { mode: 'preview', chat_enabled: true }; },
  };
  const modeState = { mode: 'off', chat_enabled: false };
  const fakeMode = { get: () => modeState, isOff: () => modeState.mode === 'off', start() {}, stop() {} };
  const cfg = { net: 'mainnet', poolInternalUrl: 'http://127.0.0.1:9', linkSecretFile: path.join(TMP, 'none') };
  const app = buildApp({ config: cfg, db: edb, log, clock: () => T, poolLink: fakeLink, mode: fakeMode });
  const srv = createServer(app.handler);
  const { port } = await listen(srv, 0, '127.0.0.1');
  const HOST = 'pool.example';
  const J = { 'Content-Type': 'application/json', Host: HOST };
  const post = (p, body, { ip = '203.0.113.5', cookie, headers = {} } = {}) => request(port, {
    method: 'POST', path: p, body: JSON.stringify(body),
    headers: { ...J, ...(ip ? { 'X-Real-IP': ip } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
  });
  const get = (p, { cookie, ip = '203.0.113.5' } = {}) => request(port, {
    path: p, headers: { Host: HOST, 'X-Real-IP': ip, ...(cookie ? { Cookie: cookie } : {}) },
  });
  const cookieOf = (res) => {
    const sc = res.headers['set-cookie'];
    const c = Array.isArray(sc) ? sc[0] : sc;
    return c ? c.split(';')[0] : null;
  };
  const U = addr(30);

  // Mode gate.
  let res = await post('/play/api/login', { address: U, proof: 'ip-ok' });
  ok('e. mode off → login 404 (D12: every public route except health)', res.status === 404 && verifyCalls.length === 0);
  ok('e. mode off → /me 404', (await get('/play/api/me')).status === 404);
  ok('e. mode off → health still 200', (await get('/play/api/health')).status === 200);
  modeState.mode = 'preview';

  // Shape checks — before any limiter or pool call.
  for (const [name, body, field] of [
    ['testnet address on mainnet', { address: addr(31, 'tgrin1'), proof: 'ip-ok' }, 'address'],
    ['malformed address', { address: 'grin1abc', proof: 'ip-ok' }, 'address'],
    ['empty proof', { address: U, proof: '   ' }, 'proof'],
    ['proof > 256 chars', { address: U, proof: 'x'.repeat(257) }, 'proof'],
    ['non-string proof', { address: U, proof: 12345678 }, 'proof'],
    ['unknown key', { address: U, proof: 'ip-ok', admin: true }, 'body'],
  ]) {
    res = await post('/play/api/login', body);
    ok(`e. ${name} → 400 field=${field}`, res.status === 400 && res.json && res.json.field === field);
  }
  ok('e. …none of them reached the pool', verifyCalls.length === 0);
  res = await post('/play/api/login', { address: U, proof: 'ip-ok' }, { ip: null });
  ok('e. no X-Real-IP (loopback peer) → 400 client_ip, pool not called', res.status === 400 && res.json.field === 'client_ip' && verifyCalls.length === 0);

  // CSRF.
  res = await request(port, { method: 'POST', path: '/play/api/login', body: 'address=x', headers: { Host: HOST, 'X-Real-IP': '203.0.113.5', 'Content-Type': 'application/x-www-form-urlencoded' } });
  ok('e. CSRF: a form POST (non-JSON) → 415', res.status === 415);
  res = await post('/play/api/login', { address: U, proof: 'ip-ok' }, { headers: { Origin: 'https://evil.example' } });
  ok('e. CSRF: a foreign Origin → 403 cross_origin, pool not called', res.status === 403 && res.json.error === 'cross_origin' && verifyCalls.length === 0);
  res = await post('/play/api/login', { address: U, proof: 'ip-ok' }, { headers: { Origin: 'null' } });
  ok('e. CSRF: Origin "null" → 403', res.status === 403);
  res = await post('/play/api/login', { address: U, proof: 'ip-ok' }, { headers: { 'Sec-Fetch-Site': 'cross-site' } });
  ok('e. CSRF: Sec-Fetch-Site cross-site → 403', res.status === 403);
  res = await post('/play/api/login', { address: U, proof: 'ip-ok' }, { headers: { Origin: 'http://pool.example' } });
  ok('e. CSRF: same host but http:// (no X-Forwarded-Proto) → 403', res.status === 403);

  // A good login.
  res = await post('/play/api/login', { address: U, proof: 'ip-ok' }, { headers: { Origin: `https://${HOST}`, 'Sec-Fetch-Site': 'same-origin', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0) Gecko/20100101 Firefox/130.0' } });
  const setCookie = [].concat(res.headers['set-cookie'] || [])[0] || '';
  ok('e. login ok → 200 with me', res.status === 200 && res.json.ok === true && res.json.me.address === U);
  ok('e. the pool got the player\'s real IP (X-Real-IP), not 127.0.0.1', verifyCalls[verifyCalls.length - 1].ip === '203.0.113.5');
  ok('e. cookie attributes exact: Path=/play/; Max-Age=1209600; HttpOnly; Secure; SameSite=Strict',
    /^grin_play=[A-Za-z0-9_-]{43}; Path=\/play\/; Max-Age=1209600; HttpOnly; Secure; SameSite=Strict$/.test(setCookie), setCookie);
  const c1 = cookieOf(res);
  const token1 = c1.split('=')[1];
  const srow = edb.raw.prepare('SELECT * FROM sessions').get();
  ok('e. the token is stored ONLY as sha256 hex', srow.token_hash === crypto.createHash('sha256').update(token1).digest('hex')
    && !JSON.stringify(edb.raw.prepare('SELECT * FROM sessions').all()).includes(token1));
  ok('e. session row: 14 d hard expiry, ip /24, coarse UA, proof kind + slot',
    srow.expires_at - srow.created_at === 14 * 86400 && srow.ip_coarse === '203.0.113.0/24'
    && srow.ua_hint === 'Firefox on Windows' && srow.proof_kind === 'ip' && srow.proof_slot === 'set', JSON.stringify(srow));
  ok('e. the response carries no token hash', !res.text.includes(srow.token_hash));

  // /me
  res = await get('/play/api/me', { cookie: c1 });
  ok('e. /me: own full address, the pool mask, plays, points, sessions',
    res.status === 200 && res.json.address === U && res.json.address_masked === maskAddr(U)
    && res.json.plays === 0 && res.json.points === 0 && res.json.sessions === 1, res.text);
  ok('e. /me mask = the pool\'s 9…4', maskAddr(U) === `${U.slice(0, 9)}…${U.slice(-4)}`);
  modeState.chat_enabled = true;
  // These tests isolate the PROOF gate (D9); the recent-mining gate (§19.10, Part 8) has its
  // own tests in test-chat.js.
  app.services.settings.set('chat_min_minutes', 0, 'test');
  res = await get('/play/api/me', { cookie: c1 });
  ok('e. chat on + an OLD proof (age null) → can_post true, no wait', res.json.chat.can_post === true && res.json.chat.available_at === null);
  modeState.chat_enabled = false;
  res = await get('/play/api/me', { cookie: c1 });
  ok('e. pool chat switch off → can_post false, reason chat_off', res.json.chat.can_post === false && res.json.chat.reason === 'chat_off');
  modeState.chat_enabled = true;
  ok('e. /me without a cookie → 401', (await get('/play/api/me')).status === 401);
  ok('e. /me with a forged token → 401', (await get('/play/api/me', { cookie: `grin_play=${'A'.repeat(43)}` })).status === 401);
  ok('e. /me with a DUPLICATED cookie name → 401 (cookie tossing)', (await get('/play/api/me', { cookie: `${c1}; ${c1}` })).status === 401);

  // D9 chat gate variants.
  res = await post('/play/api/login', { address: U, proof: 'pw-fresh-600' });
  const cFresh = cookieOf(res);
  res = await get('/play/api/me', { cookie: cFresh });
  ok('e. fresh password proof (600 s old) → proof_too_new, available at now + 86400 − 600',
    res.json.chat.can_post === false && res.json.chat.reason === 'proof_too_new' && res.json.chat.available_at === nowS() + 86400 - 600, res.text);
  T += (86400 - 600) * 1000;
  res = await get('/play/api/me', { cookie: cFresh });
  ok('e. …and can post once that proof would have aged', res.json.chat.can_post === true);
  res = await post('/play/api/login', { address: U, proof: 'anchor-proof' });
  const cAnchor = cookieOf(res);
  T += 365 * 86400 * 1000 / 100;             // ~3.6 days later
  res = await get('/play/api/me', { cookie: cAnchor });
  ok('e. an ANCHOR proof never gets chat', res.json.chat.can_post === false && res.json.chat.reason === 'anchor_proof' && res.json.chat.available_at === null);
  app.services.settings.set('chat_min_proof_age', 0, 'test');
  res = await post('/play/api/login', { address: U, proof: 'pw-fresh-600' });
  res = await get('/play/api/me', { cookie: cookieOf(res) });
  ok('e. chat_min_proof_age = 0 cannot remove the 1 h FLOOR (available at now + 3600 − 600)',
    res.json.chat.available_at === nowS() + 3600 - 600, res.text);
  const cIpOpen = cookieOf(await post('/play/api/login', { address: U, proof: 'ip-ok' }));
  ok('e. (an IP-proof session opened while password-only chat is off can post)',
    (await get('/play/api/me', { cookie: cIpOpen })).json.chat.can_post === true);
  app.services.settings.set('chat_requires_password', true, 'test');
  res = await post('/play/api/login', { address: U, proof: 'ip-ok' });
  res = await get('/play/api/me', { cookie: cookieOf(res) });
  ok('e. password-only chat + an IP proof → password_required', res.json.chat.reason === 'password_required' && res.json.chat.can_post === false);
  res = await get('/play/api/me', { cookie: cIpOpen });
  ok('e. turning password-only chat ON closes chat to IP-proof sessions ALREADY open', res.json.chat.reason === 'password_required' && res.json.chat.can_post === false);
  app.services.settings.set('chat_requires_password', false, 'test');
  app.services.settings.set('chat_min_proof_age', 86400, 'test');

  // Failures: wording, statuses, what counts.
  const V = addr(40);
  res = await post('/play/api/login', { address: V, proof: 'wrong-guess' }, { ip: '198.51.100.200' });
  ok('e. wrong proof → 401 login_failed with reason + the account page\'s wording',
    res.status === 401 && res.json.error === 'login_failed' && res.json.reason === 'no_match' && res.json.hint === LOGIN_REASONS.no_match);
  res = await post('/play/api/login', { address: V, proof: 'weird-reason' }, { ip: '198.51.100.200' });
  ok('e. an unknown pool reason is shown as no_match', res.json.reason === 'no_match');
  res = await post('/play/api/login', { address: V, proof: 'trivial-pw' }, { ip: '198.51.100.201' });
  ok('e. trivial password → reason trivial_password', res.status === 401 && res.json.reason === 'trivial_password');
  res = await post('/play/api/login', { address: V, proof: 'pool-toomany' }, { ip: '198.51.100.202' });
  ok('e. pool too_many_attempts → 429', res.status === 429 && res.json.reason === 'too_many_attempts');
  res = await post('/play/api/login', { address: V, proof: 'pool-down' }, { ip: '198.51.100.202' });
  ok('e. pool unreachable → 503 pool_unavailable', res.status === 503 && res.json.error === 'pool_unavailable');
  res = await post('/play/api/login', { address: V, proof: 'pool-lookup' }, { ip: '198.51.100.202' });
  ok('e. pool lookup_failed → 503 pool_unavailable', res.status === 503);
  ok('e. no session row was created by any failure', edb.raw.prepare('SELECT COUNT(*) AS c FROM sessions WHERE address = ?').get(V).c === 0);

  // Per-IP bucket: 10 attempts, then 429 before the pool.
  const W = addr(50);
  let n0 = verifyCalls.length;
  const codes = [];
  for (let i = 0; i < 12; i++) codes.push((await post('/play/api/login', { address: W, proof: 'trivial-pw' }, { ip: '192.0.2.77' })).status);
  ok('e. per-IP bucket: 10 attempts reach the pool, then 429', codes.slice(0, 10).every((c) => c === 401) && codes[10] === 429 && verifyCalls.length - n0 === 10, codes.join());
  res = await post('/play/api/login', { address: W, proof: 'trivial-pw' }, { ip: '192.0.2.77' });
  ok('e. 429 carries Retry-After', res.status === 429 && /^[0-9]+$/.test(res.headers['retry-after'] || ''));
  ok('e. trivial-password refusals did not count toward a lockout', !app.services.auth._limiters.ipFail.check('192.0.2.77').locked);

  // Per-(address, IP) failure lockout: 5 wrong guesses, then 429 before the pool.
  n0 = verifyCalls.length;
  const pc = [];
  for (let i = 0; i < 7; i++) pc.push((await post('/play/api/login', { address: W, proof: 'wrong-guess' }, { ip: '192.0.2.88' })).status);
  ok('e. pair lockout after 5 wrong guesses, before the pool', pc.slice(0, 5).every((c) => c === 401) && pc[5] === 429 && verifyCalls.length - n0 === 5, pc.join());
  res = await post('/play/api/login', { address: U, proof: 'ip-ok' }, { ip: '192.0.2.88' });
  ok('e. the same IP can still log in to ANOTHER address (the pair is locked, not the IP)', res.status === 200);

  // Per-address failure budget: strangers cannot lock the owner out.
  const X = addr(60);
  res = await post('/play/api/login', { address: X, proof: 'ip-ok' }, { ip: '203.0.113.99' });
  ok('e. the owner of X logs in once from 203.0.113.99', res.status === 200);
  for (let i = 1; i <= 20; i++) await post('/play/api/login', { address: X, proof: 'wrong-guess' }, { ip: `198.18.0.${i}` });
  n0 = verifyCalls.length;
  res = await post('/play/api/login', { address: X, proof: 'wrong-guess' }, { ip: '198.18.0.21' });
  ok('e. 20 failures from 20 IPs spend X\'s budget → a new IP gets 429 before the pool', res.status === 429 && verifyCalls.length === n0);
  res = await post('/play/api/login', { address: X, proof: 'ip-ok' }, { ip: '203.0.113.42' });
  ok('e. …but the owner, from a /24 they logged in from, still gets through', res.status === 200 && verifyCalls.length === n0 + 1);
  // The known-IP window is 30 days even when those sessions are long dead: purge must not
  // shorten it (it reads the same rows).
  const svc = app.services.sessions;
  const X2 = addr(61);
  const cx2 = cookieOf(await post('/play/api/login', { address: X2, proof: 'ip-ok' }, { ip: '203.0.114.9' }));
  await post('/play/api/logout-all', {}, { cookie: cx2 });
  T += 20 * 86400 * 1000;
  svc.purge();
  ok('e. a session revoked 20 days ago still makes its /24 a known IP (purge keeps dead rows 30 d)', svc.knownIp(X2, '203.0.114.200'));
  T += 11 * 86400 * 1000;
  svc.purge();
  ok('e. …and at 31 days it is purged and no longer known', !svc.knownIp(X2, '203.0.114.200'));

  // Ban.
  const B = addr(70);
  edb.raw.prepare('INSERT INTO players (address, first_seen, last_seen, banned_until) VALUES (?, ?, ?, ?)').run(B, nowS(), nowS(), 253402300799);
  n0 = verifyCalls.length;
  res = await post('/play/api/login', { address: B, proof: 'ip-ok' }, { ip: '203.0.113.150' });
  ok('e. a banned address → 403 banned, before the pool', res.status === 403 && res.json.error === 'banned' && verifyCalls.length === n0);

  // Sessions list, logout, logout-all.
  const Y = addr(80);
  const cy1 = cookieOf(await post('/play/api/login', { address: Y, proof: 'ip-ok' }, { ip: '203.0.113.10' }));
  const cy2 = cookieOf(await post('/play/api/login', { address: Y, proof: 'ip-ok' }, { ip: '2001:db8:1234:5678::1', headers: { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit Safari/604.1' } }));
  res = await get('/play/api/sessions', { cookie: cy1 });
  ok('e. /sessions lists both, flags the current one, carries no token hash',
    res.status === 200 && res.json.sessions.length === 2 && res.json.sessions.filter((s) => s.current).length === 1
    && !/token|hash/.test(res.text), res.text);
  ok('e. IPv6 is coarsened to /48, UA to a hint', res.json.sessions.some((s) => s.ip_coarse === '2001:db8:1234::/48' && s.ua_hint === 'Safari on iOS'), res.text);
  res = await post('/play/api/logout', {}, { cookie: cy1 });
  ok('e. logout → 200 and clears the cookie (Max-Age=0)', res.status === 200 && /^grin_play=; Path=\/play\/; Max-Age=0;/.test([].concat(res.headers['set-cookie'])[0]));
  ok('e. …that session is dead', (await get('/play/api/me', { cookie: cy1 })).status === 401);
  ok('e. …the other one is not', (await get('/play/api/me', { cookie: cy2 })).status === 200);
  res = await request(port, { method: 'POST', path: '/play/api/logout', headers: { Host: HOST, 'X-Real-IP': '203.0.113.10', Cookie: cy2 } });
  ok('e. logout without a JSON body → 415 (every write needs the JSON content type)', res.status === 415);
  const cy3 = cookieOf(await post('/play/api/login', { address: Y, proof: 'ip-ok' }, { ip: '203.0.113.11' }));
  res = await post('/play/api/logout-all', {}, { cookie: cy2 });
  ok('e. logout-all revokes every session of the address', res.status === 200 && res.json.revoked === 2
    && (await get('/play/api/me', { cookie: cy2 })).status === 401 && (await get('/play/api/me', { cookie: cy3 })).status === 401);
  ok('e. logout-all without a session → 401', (await post('/play/api/logout-all', {})).status === 401);

  // Session cap, touch, expiry, ban after login.
  const Z = addr(90);
  const zc = [];
  for (let i = 0; i < 21; i++) {
    T += 1000;
    zc.push(cookieOf(await post('/play/api/login', { address: Z, proof: 'ip-ok' }, { ip: `203.0.113.${100 + (i % 5)}` })));
    if (i % 5 === 4) T += 70_000;             // keep the per-IP bucket fed
  }
  ok('e. 21 logins → 20 live sessions, the OLDEST revoked', (await get('/play/api/me', { cookie: zc[0] })).status === 401
    && (await get('/play/api/me', { cookie: zc[1] })).status === 200
    && edb.raw.prepare('SELECT COUNT(*) AS c FROM sessions WHERE address = ? AND revoked_at IS NULL').get(Z).c === 20);
  const zh = crypto.createHash('sha256').update(zc[20].split('=')[1]).digest('hex');
  const seen0 = edb.raw.prepare('SELECT last_seen FROM sessions WHERE token_hash = ?').get(zh).last_seen;
  T += 60_000;
  await get('/play/api/me', { cookie: zc[20] });
  const seen1 = edb.raw.prepare('SELECT last_seen FROM sessions WHERE token_hash = ?').get(zh).last_seen;
  T += 5 * 60_000;
  await get('/play/api/me', { cookie: zc[20] });
  const seen2 = edb.raw.prepare('SELECT last_seen FROM sessions WHERE token_hash = ?').get(zh).last_seen;
  ok('e. last_seen is written at most once per 5 min', seen1 === seen0 && seen2 === nowS());
  edb.raw.prepare('UPDATE players SET banned_until = ? WHERE address = ?').run(nowS() + 3600, Z);
  ok('e. a ban applied after login kills the session at once', (await get('/play/api/me', { cookie: zc[20] })).status === 401);
  edb.raw.prepare('UPDATE players SET banned_until = NULL WHERE address = ?').run(Z);
  T += 14 * 86400 * 1000;
  ok('e. hard expiry at 14 d, activity does not extend it', (await get('/play/api/me', { cookie: zc[20] })).status === 401);
  ok('e. purge drops expired + old revoked sessions', app.services.sessions.purge() > 0);

  // /me shows plays from the ledger.
  const cu = cookieOf(await post('/play/api/login', { address: U, proof: 'ip-ok' }, { ip: '203.0.113.5' }));
  app.services.ledger.credit(U, 'plays', 3, 'mining_minutes', 'w:1');
  res = await get('/play/api/me', { cookie: cu });
  ok('e. /me plays = the ledger balance', res.json.plays === 3);

  // Nothing in any response is another player's full address.
  ok('e. mode back off → login and /me 404 again', await (async () => {
    modeState.mode = 'off';
    const a = await get('/play/api/me', { cookie: cu });
    const b = await post('/play/api/login', { address: U, proof: 'ip-ok' });
    modeState.mode = 'preview';
    return a.status === 404 && b.status === 404;
  })());
  ok('e. every limiter-refused or shape-refused call left the ledger consistent', app.services.ledger.verify().length === 0);
  await new Promise((r2) => srv.close(r2));
  edb.close();

  // ── [f] mode cache ──────────────────────────────────────────────────────────────────
  console.log('\n[f] mode cache: off until the pool answers, last known ≤ 10 min, single-flight\n');
  let mt = 0;
  let cfgAnswer = { mode: 'preview', chat_enabled: true };
  let cfgCalls = 0;
  let cfgFail = false;
  const mlines = [];
  const mlog = createLogger((level, line) => mlines.push(line));
  const mc = createModeCache({
    poolLink: { async config() { cfgCalls++; await new Promise((r2) => setImmediate(r2)); if (cfgFail) throw new PoolLinkError('link_down'); return cfgAnswer; } },
    log: mlog, clock: () => mt,
  });
  ok('f. before the pool has answered: off', mc.get().mode === 'off' && mc.isOff());
  await Promise.all([mc.refresh(), mc.refresh(), mc.refresh()]);
  ok('f. refresh is single-flight (3 concurrent → 1 call)', cfgCalls === 1);
  ok('f. after the first answer: preview + chat', mc.get().mode === 'preview' && mc.get().chat_enabled === true);
  cfgFail = true;
  mt += 9 * 60_000;
  await mc.refresh();
  ok('f. pool unreachable for 9 min → last known mode kept', mc.get().mode === 'preview');
  mt += 2 * 60_000;
  ok('f. …past 10 min → off', mc.get().mode === 'off');
  const warnCount = mlines.filter((l) => l.includes('cannot read the games mode')).length;
  await mc.refresh(); await mc.refresh();
  ok('f. a pool that stays down is logged once, not per refresh', mlines.filter((l) => l.includes('cannot read the games mode')).length === warnCount && warnCount === 1);
  cfgFail = false;
  cfgAnswer = { mode: 'on', chat_enabled: false };
  await mc.refresh();
  ok('f. recovery → the new mode, logged', mc.get().mode === 'on' && mlines.some((l) => l.includes('recovered')));

  // ── [g] log hygiene ─────────────────────────────────────────────────────────────────
  console.log('\n[g] log hygiene\n');
  const all = lines.join('\n');
  ok('g. no proof value, token or link secret in any log line',
    !all.includes('wrong-guess') && !all.includes('pw-fresh-600') && !all.includes(SECRET) && !all.includes(SECRET2) && !all.includes(token1));
}

main().catch((e) => {
  fail++;
  console.error(`  FAIL  suite crashed: ${e && e.stack ? e.stack : e}`);
}).finally(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }
  console.log(`\nRESULT pass=${pass} fail=${fail}`);
  process.exitCode = fail ? 1 : 0;
});
