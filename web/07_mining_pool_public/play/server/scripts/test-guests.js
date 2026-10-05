'use strict';

// Guest accounts (design §19.17.3/§19.17.4, D24–D26/D32, Part C5; threat notes #26–#29).
//
//   [a] the pieces: ids + tags, the proof-of-work (replay, expiry, another IP, forgery, the floor,
//       a restart, the used-set bound, its cost), the scrypt cap, passwords
//   [b] sign-up: every refusal in the §19.17.3 order, the per-IP limits, the success response
//   [c] guest login: one wording + the dummy scrypt, the ban after the password, the limiters
//       (a stranger cannot lock the owner out)
//   [d] the account: password change, delete (by the guest, an admin, the idle job)
//   [e] tickets: the daily SET, both directions, the 0-delta day, miners untouched, the ledger
//   [f] chat + names: the age gate (live), the switch, rates, links held, reports not counted,
//       renames without a login-name oracle
//   [g] identity fences: pool link, activity sync, moderators, mining events, labels, login_name
//   [h] query plans
//
// Loopback server with a stubbed pool; the DB is in memory. Nothing is left running.
// Run: node scripts/test-guests.js

const crypto = require('node:crypto');
const http = require('node:http');
const path = require('node:path');

const { openDb } = require('../lib/db.js');
const { createLogger } = require('../lib/log.js');
const { loadGames } = require('../lib/registry.js');
const { buildApp, createServer, listen } = require('../lib/app.js');
const G = require('../lib/guests.js');
const { guestTag, isGuestId, maskAddr, playerParam } = require('../lib/mask.js');
const { createPoolLink, PoolLinkError } = require('../lib/pool-link.js');
const { CHAT_MIN_AGE_FLOOR } = require('../lib/sessions.js');
const { SPEC } = require('../lib/settings.js');
const miningMinutes = require('../lib/events/mining_minutes.js');
const activeDays = require('../lib/events/active_days.js');

let pass = 0, fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else      { fail++; console.error(`  FAIL  ${name}${extra ? ' — ' + extra : ''}`); }
}

const SERVER = path.join(__dirname, '..');
const GAMES = path.join(SERVER, '..', 'games');
const log = createLogger(() => {});
const DAY = 86400;
const GUEST_ID_RE_G = /g:[a-z2-7]{16}/;
const FULL_ADDR_RE = /t?grin1[ac-hj-np-z02-9]{58}/;
const CS = 'acdefghjklmnpqrstuvwxyz023456789';
function addr(n, prefix = 'grin1') {
  let x = (n * 7919 + 13) >>> 0;
  let s = '';
  for (let i = 0; i < 58; i++) { x = (Math.imul(x, 1103515245) + 12345) >>> 0; s += CS[(x >>> 16) % 32]; }
  return prefix + s;
}
const utcDay = (t) => new Date(t * 1000).toISOString().slice(0, 10);

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

function solve(challenge, bits) {
  for (let n = 0; ; n++) {
    const h = crypto.createHash('sha256').update(`${challenge}:${n}`, 'utf8').digest();
    if (G.leadingZeroBits(h) >= bits) return String(n);
  }
}
async function throwsHttp(p, status, code) {
  try { await p; return false; } catch (e) { return e.status === status && e.code === code; }
}

async function main() {
  // ── [a] the pieces ──────────────────────────────────────────────────────────────────
  console.log('\n[a] ids, tags, the proof-of-work, the scrypt cap, passwords\n');
  const ids = new Set(Array.from({ length: 2000 }, () => G.newGuestId()));
  ok('a. a guest id is g: + 16 base32, and 2000 of them are distinct', ids.size === 2000 && [...ids].every((i) => /^g:[a-z2-7]{16}$/.test(i) && isGuestId(i)));
  const gid = [...ids][0];
  ok('a. Guest-XXXX: 4 base32 characters, stable, derived from a HASH of the id (not its characters)',
    /^Guest-[A-Z2-7]{4}$/.test(guestTag(gid)) && guestTag(gid) === guestTag(gid) && maskAddr(gid) === guestTag(gid)
      && !gid.slice(2).toUpperCase().includes(guestTag(gid).slice(6)));
  ok('a. the pool mask is unchanged for an address', maskAddr(addr(1)) === `${addr(1).slice(0, 9)}…${addr(1).slice(-4)}`);
  ok('a. playerParam: g.<16> and g:<16> → the id; a miner address of THIS net; nothing else',
    playerParam(`g.${gid.slice(2)}`, 'grin1') === gid && playerParam(gid, 'grin1') === gid && playerParam(addr(1), 'grin1') === addr(1)
      && playerParam(addr(1, 'tgrin1'), 'grin1') === null && playerParam('g.short', 'grin1') === null && playerParam('g.' + 'A'.repeat(16), 'grin1') === null
      && playerParam(undefined, 'grin1') === null);
  ok('a. leadingZeroBits', G.leadingZeroBits(Buffer.from([0, 0, 0x10, 0xff])) === 19 && G.leadingZeroBits(Buffer.from([0x80])) === 0
    && G.leadingZeroBits(Buffer.from([0, 1])) === 15);

  let PT = 1_000_000_000_000;
  const pow = G.createPow({ clock: () => PT });
  const C1 = '203.0.113.0/24';
  let ch = pow.issue(C1, 14);
  ok('a. a challenge: v1.<b64 ip>.<exp>.<bits>.<rand>.<mac>, 5 min, the ip is wrapped (an IPv4 /24 is full of dots)',
    ch.challenge.split('.').length === 6 && ch.bits === 14 && ch.expires_at === PT / 1000 + G.POW_TTL_S && !ch.challenge.includes(C1));
  let nonce = solve(ch.challenge, 14);
  ok('a. a solved challenge verifies', pow.verify(ch.challenge, nonce, C1) === null);
  ok('a. …and only ONCE (replay → used)', pow.verify(ch.challenge, nonce, C1) === 'used');
  ch = pow.issue(C1, 14); nonce = solve(ch.challenge, 14);
  ok('a. from another /24 → ip_changed', pow.verify(ch.challenge, nonce, '198.51.100.0/24') === 'ip_changed');
  ok('a. …and the refusal did not spend it', pow.verify(ch.challenge, nonce, C1) === null);
  ch = pow.issue(C1, 14); nonce = solve(ch.challenge, 14);
  PT += (G.POW_TTL_S + 1) * 1000;
  ok('a. after 5 min → expired', pow.verify(ch.challenge, nonce, C1) === 'expired');
  ch = pow.issue(C1, 14);
  let bad = 0;
  for (let n = 0; n < 5000 && bad === 0; n++) {
    const h = crypto.createHash('sha256').update(`${ch.challenge}:${n}`).digest();
    if (G.leadingZeroBits(h) < 14) { bad = 1; ok('a. a nonce that does not reach the bits → insufficient', pow.verify(ch.challenge, String(n), C1) === 'insufficient'); }
  }
  const parts = ch.challenge.split('.');
  const forged = [...parts.slice(0, 3), '1', ...parts.slice(4)].join('.');
  ok('a. lowering the bits in the token breaks the HMAC → invalid', pow.verify(forged, solve(forged, 1), C1) === 'invalid');
  const otherIp = [parts[0], Buffer.from('198.51.100.0/24').toString('base64url'), ...parts.slice(2)].join('.');
  ok('a. rewriting the IP in the token breaks the HMAC → invalid', pow.verify(otherIp, '1', '198.51.100.0/24') === 'invalid');
  const weakCh = pow.issue(C1, 10);
  ok('a. a token signed with bits under the floor (14) is refused even though the HMAC is good',
    pow.verify(weakCh.challenge, solve(weakCh.challenge, 10), C1) === 'invalid' && G.POW_BITS_FLOOR === 14);
  const pow2 = G.createPow({ clock: () => PT });
  ch = pow.issue(C1, 14); nonce = solve(ch.challenge, 14);
  ok('a. a token from before a restart (another key) → invalid: precomputing across restarts is useless',
    pow2.verify(ch.challenge, nonce, C1) === 'invalid');
  ok('a. malformed tokens and nonces → invalid', ['', 'v1', 'v2.a.b.c.d.e', 'x'.repeat(300)].every((t) => pow.verify(t, '1', C1) === 'invalid')
    && pow.verify(ch.challenge, 'bad nonce', C1) === 'invalid' && pow.verify(ch.challenge, '1'.repeat(33), C1) === 'invalid' && pow.verify(ch.challenge, 5, C1) === 'invalid');
  const small = G.createPow({ clock: () => PT, usedMax: 2 });
  const spend = () => { const c = small.issue(C1, 14); return small.verify(c.challenge, solve(c.challenge, 14), C1); };
  ok('a. a full used set → busy (fail closed: it never forgets a use to make room)', spend() === null && spend() === null && spend() === 'busy');
  PT += (G.POW_TTL_S + 1) * 1000;
  ok('a. …and expired uses are pruned, so it frees itself', spend() === null);
  // Cost: one HMAC + one SHA-256 per verify, whatever the client sends.
  const counts = { hash: 0, hmac: 0 };
  const realHash = crypto.createHash;
  const realHmac = crypto.createHmac;
  ch = pow.issue(C1, 14); nonce = solve(ch.challenge, 14);
  crypto.createHash = (...a) => { counts.hash++; return realHash(...a); };
  crypto.createHmac = (...a) => { counts.hmac++; return realHmac(...a); };
  pow.verify(ch.challenge, nonce, C1);
  crypto.createHash = realHash;
  crypto.createHmac = realHmac;
  ok('a. verifying costs exactly one HMAC + one SHA-256', counts.hash === 1 && counts.hmac === 1, JSON.stringify(counts));

  // The scrypt cap.
  const cap = G.createScryptCap({ inFlight: 2, queueMax: 3 });
  const gates = [];
  const started = [];
  const job = (i) => () => new Promise((r) => { started.push(i); gates.push(r); });
  const runs = [0, 1, 2, 3, 4].map((i) => cap.run(job(i)));
  await new Promise((r) => setImmediate(r));
  ok('a. scrypt cap: 2 in flight, 3 waiting', started.length === 2 && cap.stats().active === 2 && cap.stats().queued === 3);
  ok('a. …the next one is refused at once: 429 busy', await throwsHttp(cap.run(job(9)), 429, 'busy'));
  while (gates.length) { gates.shift()(); await new Promise((r) => setImmediate(r)); }
  await Promise.all(runs);
  ok('a. …and the queue drains in order', started.join() === '0,1,2,3,4' && cap.stats().active === 0 && cap.stats().queued === 0);
  ok('a. the real cap is 4 in flight + 64 waiting (§19.17.3 step 7)', G.SCRYPT_IN_FLIGHT === 4 && G.SCRYPT_QUEUE_MAX === 64);

  const h1 = await G.hashPassword('correct horse battery');
  const hp = h1.split('$');
  ok("a. the hash is the pool's v1$salt$hash with a 16-byte salt and a 32-byte key", hp.length === 3 && hp[0] === 'v1'
    && Buffer.from(hp[1], 'base64').length === 16 && Buffer.from(hp[2], 'base64').length === 32
    && G.SCRYPT_OPTS.N === 16384 && G.SCRYPT_OPTS.r === 8 && G.SCRYPT_OPTS.p === 1);
  ok('a. verify: right → true, wrong → false, malformed → false', await G.verifyPassword('correct horse battery', h1)
    && !(await G.verifyPassword('correct horse batterz', h1)) && !(await G.verifyPassword('x', 'v2$abc')) && !(await G.verifyPassword('x', 'v1$a$b')));
  ok('a. password rule: length 10–128 code points', G.passwordProblem('short', 'alice') === 'too_short'
    && G.passwordProblem('x'.repeat(129) + 'Y', 'alice') === 'too_long' && G.passwordProblem('🐉🦊🐉🦊🐉🦊🐉🦊🐉🦊', 'alice') === null);
  ok('a. password rule: not the name, not common, not one repeated character, no control characters',
    G.passwordProblem('AliceAlice', 'alicealice') === 'same_as_name' && G.passwordProblem('Password123', 'bob') === 'common'
      && G.passwordProblem('aaaaaaaaaaaa', 'bob') === 'common' && G.passwordProblem(`abc${String.fromCharCode(0)}defghijk`, 'bob') === 'charset'
      && G.passwordProblem(`abcdefghij${String.fromCodePoint(0x200B)}`, 'bob') === 'charset' && G.passwordProblem('a long random phrase', 'bob') === null);

  // ── setup ───────────────────────────────────────────────────────────────────────────
  let T = Date.UTC(2026, 9, 7, 12, 0, 0);
  const nowS = () => Math.floor(T / 1000);
  const SECRET = 'k'.repeat(20) + 'Q7'.repeat(22);
  const cfg = { net: 'mainnet', poolInternalUrl: 'http://127.0.0.1:9', linkSecretFile: '/nonexistent' };
  const db = openDb(':memory:', { net: 'mainnet', log });
  const poolCalls = [];
  const fakeLink = {
    secretConfigured: () => true,
    checkSecret: (g) => (g === SECRET ? 'ok' : 'bad'),
    async verifyProof(address, proof) {
      poolCalls.push(address);
      if (proof === 'pw') return { ok: true, method: 'password', slot: 'set', age_seconds: null };
      return { ok: false, reason: 'no_match' };
    },
    async activity() { return { rows: [], dropped: 0 }; },
    async config() { return { mode: 'on', chat_enabled: true }; },
  };
  const modeState = { mode: 'on', chat_enabled: true };
  const fakeMode = { get: () => modeState, isOff: () => modeState.mode === 'off', start() {}, stop() {} };
  const registry = loadGames({ gamesDir: GAMES, log });
  const app = buildApp({ config: cfg, db, log, clock: () => T, poolLink: fakeLink, mode: fakeMode, registry });
  const { settings, ledger, names, guests, activity, events, leaderboard, sessions } = app.services;
  settings.set('signup_pow_bits', 14);       // the floor: fast to solve in a test
  const srv = createServer(app.handler);
  const { port } = await listen(srv, 0, '127.0.0.1');
  const HOST = 'pool.example';
  const publicTexts = [];
  const sql = (s, ...a) => db.raw.prepare(s).run(...a);
  const one = (s, ...a) => db.raw.prepare(s).get(...a);
  const isPublic = (p) => !p.startsWith('/play/api/me') && !p.startsWith('/play/api/signup') && !p.startsWith('/play/api/login') && !p.startsWith('/play/api/account');
  const get = async (p, { cookie, ip = '203.0.113.9' } = {}) => {
    const r = await request(port, { path: p, headers: { Host: HOST, 'X-Real-IP': ip, ...(cookie ? { Cookie: cookie } : {}) } });
    if (isPublic(p)) publicTexts.push(`GET ${p} ${r.text}`);
    return r;
  };
  const post = async (p, body, { cookie, ip = '203.0.113.9', raw } = {}) => {
    const r = await request(port, { method: 'POST', path: p, body: raw !== undefined ? raw : JSON.stringify(body),
      headers: { 'Content-Type': 'application/json', Host: HOST, 'X-Real-IP': ip, ...(cookie ? { Cookie: cookie } : {}) } });
    if (isPublic(p)) publicTexts.push(`POST ${p} ${r.text}`);
    return r;
  };
  const cookieOf = (res) => { const sc = res.headers['set-cookie']; return sc ? (Array.isArray(sc) ? sc[0] : sc).split(';')[0] : null; };
  function adm(method, rel, body, { stepup = true } = {}) {
    const h = { 'X-Games-Link': SECRET, 'X-Admin-User': 'alice', 'X-Admin-Stepup': stepup ? '1' : '0' };
    let payload;
    if (body !== undefined) { payload = JSON.stringify(body); h['Content-Type'] = 'application/json'; }
    return request(port, { method, path: `/internal/admin/${rel}`, headers: h, body: payload });
  }
  let net24 = 0;
  const freshIp = () => { net24++; return `198.18.${net24}.7`; };
  async function challengeFor(ip) { return (await get('/play/api/signup/challenge', { ip })).json; }
  async function signup(name, password, { ip = freshIp(), mutate } = {}) {
    const c = await challengeFor(ip);
    // A refused challenge (sign-up closed, the bucket) still lets the POST show its own refusal.
    const body = c.ok ? { name, password, challenge: c.challenge, nonce: solve(c.challenge, c.bits) } : { name, password, challenge: 'v1.x', nonce: '1' };
    if (mutate) mutate(body);
    const res = await post('/play/api/signup', body, { ip });
    return { res, cookie: cookieOf(res), ip, body };
  }
  const guestLogin = (name, password, ip = '203.0.113.50') => post('/play/api/login/guest', { name, password }, { ip });
  const me = async (cookie) => (await get('/play/api/me', { cookie })).json;
  const idOf = (name) => one('SELECT id FROM guests WHERE login_norm = ?', name.toLowerCase()).id;
  const urlOf = (id) => `g.${id.slice(2)}`;

  // Miners, for the comparisons.
  const MA = addr(1), MB = addr(2), MC = addr(3), MD = addr(4);
  // Chat needs RECENT mining (7 days); the clock moves a lot in this suite, so re-plant before chat.
  const mineNow = () => { for (const m of [MA, MB, MC, MD]) sql('INSERT INTO activity_daily (address, day, seconds) VALUES (?, ?, 7200) ON CONFLICT(address, day) DO NOTHING', m, utcDay(nowS())); };
  mineNow();
  const minerLogin = async (a) => cookieOf(await post('/play/api/login', { address: a, proof: 'pw' }, { ip: '192.0.2.10' }));

  try {
    // ── [b] sign-up ───────────────────────────────────────────────────────────────────
    console.log('\n[b] sign-up\n');
    let c = await challengeFor('203.0.113.20');
    ok('b. GET challenge → {challenge, bits ≥ floor, expires_at, algorithm}', c.ok === true && c.bits === 14 && typeof c.challenge === 'string' && c.algorithm === 'sha256');
    settings.set('signup_pow_bits', 16);
    ok('b. the bits follow signup_pow_bits', (await challengeFor('203.0.113.20')).bits === 16);
    settings.set('signup_pow_bits', 14);
    ok('b. signup_pow_bits cannot go under 14 (SPEC min = the floor constant)', SPEC.signup_pow_bits.min === G.POW_BITS_FLOOR && SPEC.signup_pow_bits.def === 18);

    const mineA = await signup('Wanda', 'a long random phrase');
    let res = mineA.res;
    ok('b. a good sign-up → 200 + a session cookie', res.status === 200 && res.json.ok === true && mineA.cookie && mineA.cookie.startsWith('grin_play='), res.text);
    const cMiner = await minerLogin(MA);
    const attrs = (r) => String(Array.isArray(r) ? r[0] : r).split(';').slice(1).map((x) => x.trim()).sort().join(';');
    const minerRes = await post('/play/api/login', { address: MA, proof: 'pw' }, { ip: '192.0.2.10' });
    ok('b. …the cookie is exactly the miner cookie (Path=/play/, HttpOnly, Secure, SameSite=Strict, 14 d)',
      attrs(res.headers['set-cookie']) === attrs(minerRes.headers['set-cookie']) && /Max-Age=1209600/.test(attrs(res.headers['set-cookie'])));
    const W = idOf('Wanda');
    let m = res.json.me;
    ok('b. …me: kind guest, its own id, Guest-XXXX, 5 tickets, the login name (to its owner), the nickname live',
      m.kind === 'guest' && m.address === W && m.address_masked === guestTag(W) && m.plays === 5 && m.guest.login_name === 'Wanda'
        && m.guest.daily_tickets === 5 && m.nickname.live === 'Wanda' && m.nickname.shown_as === 'Wanda · guest', JSON.stringify(m));
    ok('b. …chat: not before the account is 24 h old (account_too_new, with the time)',
      m.chat.can_post === false && m.chat.reason === 'account_too_new' && m.chat.available_at === nowS() + DAY && m.guest.chat_from === nowS() + DAY);
    ok('b. …resets_at is the next 00:00 UTC', m.guest.resets_at === (Math.floor(nowS() / DAY) + 1) * DAY);
    const gr = one('SELECT * FROM guests WHERE id = ?', W);
    ok('b. …the guests row: login name as typed, its matching form, a v1 scrypt hash, no IP column',
      gr.login_name === 'Wanda' && gr.login_norm === 'wanda' && /^v1\$/.test(gr.pass_hash) && !('created_ip_coarse' in gr) && gr.created_at === nowS());
    ok('b. …the players row is a guest; the sign-up log holds the /24 and nothing about the account',
      one('SELECT kind FROM players WHERE address = ?', W).kind === 'guest'
        && one('SELECT COUNT(*) AS n FROM guest_signups WHERE ip_coarse = ?', mineA.ip.replace(/\.7$/, '.0/24')).n === 1
        && Object.keys(one('SELECT * FROM guest_signups LIMIT 1')).join() === 'id,ip_coarse,created_at');
    const ses = one('SELECT proof_kind, proof_slot, chat_ok_after FROM sessions WHERE address = ?', W);
    ok('b. …the session: proof_kind guest, chat_ok_after = sign-up + the age gate', ses.proof_kind === 'guest' && ses.proof_slot === 'set' && ses.chat_ok_after === nowS() + DAY);
    ok('b. …the pool was never called for it (D32)', !poolCalls.some((a) => isGuestId(a)));

    // Refusals, in order.
    settings.set('guest_signup_enabled', false);
    res = (await signup('Xavier', 'a long random phrase')).res;
    ok('b. 1. sign-up switched off → 403 signup_closed', res.status === 403 && res.json.error === 'signup_closed');
    ok('b. …the challenge route says so as well', (await get('/play/api/signup/challenge', { ip: freshIp() })).json.error === 'signup_closed');
    ok('b. …while it is off, an existing guest still signs in', (await guestLogin('Wanda', 'a long random phrase', '203.0.113.9')).status === 200);
    settings.set('guest_signup_enabled', true);
    res = (await signup('Xavier', 'a long random phrase', { mutate: (b) => { b.email = 'x@example.com'; } })).res;
    ok('b. 2. an unknown key → 400 body', res.status === 400 && res.json.field === 'body');
    res = (await signup('Xavier', 'a long random phrase', { mutate: (b) => { delete b.nonce; } })).res;
    ok('b. 2. a missing key → 400 nonce', res.status === 400 && res.json.field === 'nonce');
    res = await post('/play/api/signup', null, { raw: JSON.stringify({ name: 'x'.repeat(5000) }), ip: freshIp() });
    ok('b. 2. a body over 4 KB → 413', res.status === 413);
    res = (await signup('Xavier', 'a long random phrase', { mutate: (b) => { b.nonce = 'z'; } })).res;
    ok('b. 3. a wrong nonce → 400 pow_failed insufficient', res.status === 400 && res.json.error === 'pow_failed' && res.json.reason === 'insufficient', res.text);
    const replay = await signup('Yvonne', 'a long random phrase');
    res = await post('/play/api/signup', { ...replay.body, name: 'Yolanda' }, { ip: replay.ip });
    ok('b. 3. replaying a spent challenge → 400 pow_failed used', res.json.error === 'pow_failed' && res.json.reason === 'used');
    let cc = await challengeFor('198.51.100.77');
    res = await post('/play/api/signup', { name: 'Zack', password: 'a long random phrase', challenge: cc.challenge, nonce: solve(cc.challenge, cc.bits) }, { ip: '203.0.113.99' });
    ok('b. 3. a challenge fetched from another /24 → ip_changed', res.json.reason === 'ip_changed');
    cc = await challengeFor('198.51.100.78');
    const n78 = solve(cc.challenge, cc.bits);
    T += (G.POW_TTL_S + 1) * 1000;
    res = await post('/play/api/signup', { name: 'Zack', password: 'a long random phrase', challenge: cc.challenge, nonce: n78 }, { ip: '198.51.100.78' });
    ok('b. 3. after 5 minutes → expired', res.json.reason === 'expired');
    // 4. the per-/24 success limit: 3 per 24 h, counted from the sign-up log.
    const ipL = '198.51.100.30';
    const okL = [];
    for (const n of ['Lima', 'Lena', 'Lars']) okL.push((await signup(n, 'a long random phrase', { ip: ipL })).res.status);
    res = (await signup('Lola', 'a long random phrase', { ip: '198.51.100.31' })).res;   // same /24, another host
    ok('b. 4. three sign-ups from one /24 succeed; the fourth (another host in it) → 429 signup_limit',
      okL.join() === '200,200,200' && res.status === 429 && res.json.reason === 'signup_limit' && res.json.retry_after > 0, `${okL} ${res.text}`);
    // A delete does not free the slot.
    const lima = cookieOf(await guestLogin('Lima', 'a long random phrase', ipL));
    await post('/play/api/account/delete', { password: 'a long random phrase', confirm: 'DELETE' }, { cookie: lima, ip: ipL });
    res = (await signup('Lola', 'a long random phrase', { ip: ipL })).res;
    ok('b. 4. …deleting one of them does not hand the /24 a fresh slot', res.status === 429 && res.json.reason === 'signup_limit');
    T += (DAY + 60) * 1000;
    res = (await signup('Lola', 'a long random phrase', { ip: ipL })).res;
    ok('b. 4. …24 h later the /24 may sign up again', res.status === 200, res.text);
    settings.set('guest_signups_per_ip', 10);
    // 4. the attempt bucket (6 per hour per /24), tighter than the success limit.
    const ipA = '198.19.77.130';   // a /24 no other case used
    const st6 = [];
    for (let i = 0; i < 7; i++) st6.push((await signup('Abc', 'x', { ip: ipA })).res.status);
    ok('b. 4. the attempt bucket: 6 attempts an hour per /24, then 429 — refusals count too', st6.slice(0, 6).every((s) => s === 400) && st6[6] === 429, st6.join());
    settings.set('guest_signups_per_ip', 3);
    // 5. the name.
    const nameCase = async (n) => (await signup(n, 'a long random phrase')).res;
    res = await nameCase('Big Miner');
    ok('b. 5. a shape refusal explains itself (name_charset + the rule)', res.status === 400 && res.json.error === 'name_charset' && /letters A–Z/.test(res.json.hint));
    res = await nameCase('grin1abcdef');
    ok('b. 5. address-like → name_address', res.json.error === 'name_address');
    ok('b. 5. reserved / blocked → name_not_allowed, nothing more', (await nameCase('Admin')).json.error === 'name_not_allowed'
      && (await nameCase('Guest42')).json.error === 'name_not_allowed' && !('list' in (await nameCase('Admin')).json));
    ok('b. 5. a live nickname (any case, leet) → 409 name_unavailable', (await nameCase('WANDA')).status === 409 && (await nameCase('W4nda')).json.error === 'name_unavailable');
    await adm('POST', 'banned-names', { name: 'Voldemort' });
    ok('b. 5. a banned name → the same 409 name_unavailable', (await nameCase('Voldemort')).json.error === 'name_unavailable');
    // 6. the password.
    const pwCase = async (p) => (await signup('Quentin', p)).res;
    res = await pwCase('short');
    ok('b. 6. too short → 400 password_weak too_short with a hint', res.status === 400 && res.json.error === 'password_weak' && res.json.reason === 'too_short' && /10/.test(res.json.hint));
    ok('b. 6. the name as the password (any case) → same_as_name', (await signup('Archibaldo', 'ARCHIBALDO')).res.json.reason === 'same_as_name');
    ok('b. 6. a common one → common', (await pwCase('password123')).json.reason === 'common' && (await pwCase('qwertyuiop')).json.reason === 'common');
    ok('b. 6. nothing was created by any refusal', one("SELECT COUNT(*) AS n FROM guests WHERE login_norm IN ('quentin','archibaldo','xavier','zack','abc')").n === 0);

    // ── [c] guest login ───────────────────────────────────────────────────────────────
    console.log('\n[c] guest login\n');
    res = await guestLogin('Wanda', 'a long random phrase');
    ok('c. right name + password → 200, a new session, me', res.status === 200 && cookieOf(res) && res.json.me.kind === 'guest' && res.json.me.address === W);
    ok('c. …name case and leet fold to the login form', (await guestLogin('WANDA', 'a long random phrase')).status === 200 && (await guestLogin('w4nda', 'a long random phrase')).status === 200);
    ok('c. …last_login_at moves', one('SELECT last_login_at FROM guests WHERE id = ?', W).last_login_at === nowS());
    const wrong = await guestLogin('Wanda', 'not the password', '203.0.113.60');
    const nobody = await guestLogin('Nobody', 'not the password', '203.0.113.61');
    ok('c. a wrong password and an unknown name get the SAME status and body (no enumeration by wording)',
      wrong.status === 401 && wrong.text === nobody.text && wrong.json.error === 'login_failed', `${wrong.text} | ${nobody.text}`);
    // Timing: an unknown name runs a scrypt too — counted, not timed (a timer is flaky; the call is the guard).
    let scrypts = 0;
    const realScrypt = crypto.scrypt;
    crypto.scrypt = (...a) => { scrypts++; return realScrypt(...a); };
    await guestLogin('Nobody2', 'not the password', '203.0.113.62');
    const unknownScrypts = scrypts; scrypts = 0;
    await guestLogin('Wanda', 'not the password', '203.0.113.63');
    const wrongScrypts = scrypts;
    crypto.scrypt = realScrypt;
    ok('c. …an unknown name costs one scrypt, exactly like a wrong password (the dummy hash)', unknownScrypts === 1 && wrongScrypts === 1, `${unknownScrypts}/${wrongScrypts}`);
    ok('c. the MINER login keeps its exact schema: a guest body there → 400 body', (await post('/play/api/login', { name: 'Wanda', password: 'x' }, { ip: '203.0.113.64' })).json.field === 'body');
    ok('c. an extra key on the guest route → 400 body', (await post('/play/api/login/guest', { name: 'Wanda', password: 'x', kind: 'guest' }, { ip: '203.0.113.65' })).json.field === 'body');
    // The ban: only after the password.
    await adm('POST', `players/${urlOf(W)}/ban`, { days: 1 });
    ok('c. a banned guest + a WRONG password → the plain login_failed (a ban answer would prove the name exists)',
      (await guestLogin('Wanda', 'not the password', '203.0.113.66')).text === nobody.text);
    ok('c. a banned guest + the right password → 403 banned', (await guestLogin('Wanda', 'a long random phrase', '203.0.113.67')).json.error === 'banned');
    ok('c. …and the ban revoked its sessions', (await get('/play/api/me', { cookie: mineA.cookie })).status === 401);
    await adm('POST', `players/${urlOf(W)}/unban`, {});
    const cW = cookieOf(await guestLogin('Wanda', 'a long random phrase', '203.0.113.9'));
    // The per-name failure budget: strangers from 21 different /24s spend it…
    for (let i = 0; i < 20; i++) await guestLogin('Wanda', 'stranger guess ' + i, `100.64.${i}.1`);
    res = await guestLogin('Wanda', 'a long random phrase', '100.64.200.1');
    ok('c. after 20 failed guesses the name is limited — a first-time IP (even with the right password) waits: 429', res.status === 429, res.text);
    res = await guestLogin('Wanda', 'a long random phrase', '203.0.113.200');   // same /24 as a past session
    ok('c. …but the OWNER from a /24 it signed in from in 30 days gets through: a stranger cannot lock them out', res.status === 200, res.text);
    ok('c. …an unknown name with a spent budget is limited the same way (no oracle there either)', await (async () => {
      for (let i = 0; i < 20; i++) await guestLogin('Ghostname', 'guess ' + i, `100.65.${i}.1`);
      return (await guestLogin('Ghostname', 'guess', '100.65.200.1')).status === 429;
    })());
    ok('c. successes do not spend the budget', await (async () => {
      for (let i = 0; i < 25; i++) if ((await guestLogin('Lars', 'a long random phrase', `100.66.${i}.1`)).status !== 200) return false;
      return true;
    })());
    const ipF = '100.67.0.1';
    const fs10 = [];
    for (let i = 0; i < 11; i++) fs10.push((await guestLogin(`Name${i}x`, 'guess', ipF)).status);
    ok('c. one IP failing 10 times (any names) is locked: 429', fs10.slice(0, 10).every((s) => s === 401) && fs10[10] === 429, fs10.join());
    // R2-1: the budget must hold under a PARALLEL burst too. With peek-then-take-after-scrypt every
    // request of a burst passed on the same token (R2 measured 60 of 60 evaluated against 20).
    await signup('Petra', 'a long random phrase');
    const burst = async (n, base) => Promise.all(Array.from({ length: n }, (_, i) => guestLogin('Petra', 'burst guess ' + base + i, `100.${68 + ((base + i) >> 8)}.${(base + i) & 255}.1`)));
    let rs = await burst(40, 0);
    ok('c. R2-1: 40 PARALLEL wrong guesses from 40 /24s — exactly 20 are evaluated, the rest wait (429)',
      rs.filter((r) => r.status === 401).length === 20 && rs.filter((r) => r.status === 429).length === 20, rs.map((r) => r.status).join());
    T += 181 * 1000;
    rs = await burst(40, 40);
    ok('c. R2-1: …and once ONE token has refilled, a second burst gets exactly one guess', rs.filter((r) => r.status === 401).length === 1, rs.map((r) => r.status).join());
    // A token is held only while its scrypt runs (so > 20 SIMULTANEOUS attempts on one name wait,
    // right password or not), and a success gives it back: the full budget is there afterwards.
    ok('c. R2-1: a right password does not keep the reserved token (failures only)', await (async () => {
      await signup('Quentin', 'a long random phrase');
      const good = await Promise.all(Array.from({ length: 15 }, (_, i) => guestLogin('Quentin', 'a long random phrase', `100.80.${i}.1`)));
      const bad = await Promise.all(Array.from({ length: 20 }, (_, i) => guestLogin('Quentin', 'wrong guess ' + i, `100.82.${i}.1`)));
      return good.every((r) => r.status === 200) && bad.every((r) => r.status === 401);
    })());

    // ── [d] the account ───────────────────────────────────────────────────────────────
    console.log('\n[d] password change, delete, idle\n');
    const cW2 = cookieOf(await guestLogin('Wanda', 'a long random phrase', '203.0.113.9'));
    ok('d. a miner session cannot use the guest account routes → 403 not_guest',
      (await post('/play/api/account/password', { current: 'x', next: 'y' }, { cookie: cMiner })).json.error === 'not_guest');
    ok('d. no session → 401', (await post('/play/api/account/password', { current: 'x', next: 'y' })).status === 401);
    res = await post('/play/api/account/password', { current: 'wrong wrong wrong', next: 'a brand new phrase' }, { cookie: cW });
    ok('d. a wrong current password → 401 wrong_password', res.status === 401 && res.json.error === 'wrong_password');
    ok('d. the new password is checked: unchanged / weak',
      (await post('/play/api/account/password', { current: 'a long random phrase', next: 'a long random phrase' }, { cookie: cW })).json.reason === 'unchanged'
        && (await post('/play/api/account/password', { current: 'a long random phrase', next: 'wanda' }, { cookie: cW })).json.reason === 'too_short');
    res = await post('/play/api/account/password', { current: 'a long random phrase', next: 'a brand new phrase' }, { cookie: cW });
    ok('d. a good change → 200, the OTHER sessions revoked, this one kept', res.status === 200 && res.json.revoked >= 1
      && (await get('/play/api/me', { cookie: cW })).status === 200 && (await get('/play/api/me', { cookie: cW2 })).status === 401);
    ok('d. …the old password no longer signs in, the new one does', (await guestLogin('Wanda', 'a long random phrase', '203.0.113.9')).status === 401
      && (await guestLogin('Wanda', 'a brand new phrase', '203.0.113.9')).status === 200);
    const st5 = [];
    for (let i = 0; i < 6; i++) st5.push((await post('/play/api/account/password', { current: 'guess ' + i + ' xxxxxx', next: 'another phrase here' }, { cookie: cW })).status);
    ok('d. a stolen cookie is not an unlimited guesser: 5 wrong current passwords, then 429', st5.slice(0, 5).every((s) => s === 401) && st5[5] === 429, st5.join());
    T += 7 * 3600 * 1000;    // past the account lockout ladder's first steps
    // R2-1: the per-account lockout records a failure only after scrypt, so it must not be raced.
    const par = await Promise.all(Array.from({ length: 8 }, (_, i) =>
      post('/play/api/account/password', { current: 'parallel guess ' + i, next: 'another phrase here' }, { cookie: cW })));
    ok('d. R2-1: 8 PARALLEL wrong current passwords on one account — one is evaluated, the rest 429',
      par.filter((r) => r.status === 401).length === 1 && par.filter((r) => r.status === 429).length === 7, par.map((r) => r.status).join());
    T += 7 * 3600 * 1000;

    // Delete by the guest — with an open seek, a message and a live name.
    const del = await signup('Dorothy', 'a long random phrase');
    const D = idOf('Dorothy');
    sql('UPDATE guests SET created_at = created_at - ? WHERE id = ?', 2 * DAY, D);
    await post('/play/api/chat', { body: 'hello from Dorothy' }, { cookie: del.cookie });
    const seek = await post('/play/api/matches', { game_id: 'chess', mode: 'pvp', colour: 'seat1' }, { cookie: del.cookie });
    ok('d. (setup) the guest posted and opened a seek (1 ticket spent)', seek.status === 200 && one('SELECT plays FROM players WHERE address = ?', D).plays === 4, seek.text);
    res = await post('/play/api/account/delete', { password: 'a long random phrase' }, { cookie: del.cookie });
    ok('d. delete without confirm:"DELETE" → 400 confirm', res.json.field === 'confirm');
    res = await post('/play/api/account/delete', { password: 'wrong wrong wrong', confirm: 'DELETE' }, { cookie: del.cookie });
    ok('d. delete with a wrong password → 401 wrong_password', res.json.error === 'wrong_password');
    res = await post('/play/api/account/delete', { password: 'a long random phrase', confirm: 'DELETE' }, { cookie: del.cookie });
    ok('d. delete → 200 and the cookie is cleared', res.status === 200 && res.json.deleted === true && /Max-Age=0/.test(String(res.headers['set-cookie'])));
    ok('d. …the session is dead', (await get('/play/api/me', { cookie: del.cookie })).status === 401);
    ok('d. …the guests row is gone; the players row stays, marked deleted', !one('SELECT 1 AS x FROM guests WHERE id = ?', D)
      && one('SELECT deleted_at FROM players WHERE address = ?', D).deleted_at === nowS());
    ok('d. …the nickname is removed (account_deleted)', one("SELECT reason FROM nicknames WHERE address = ? AND state = 'removed'", D).reason === 'account_deleted');
    ok('d. …the open seek is cancelled and refunded (the ledger stays whole)', one('SELECT state FROM matches WHERE id = ?', seek.json.match.id).state === 'aborted'
      && one('SELECT plays FROM players WHERE address = ?', D).plays === 5);
    const chatNow = (await get('/play/api/chat')).json.messages;
    ok('d. …its old messages read "deleted guest"', chatNow.some((x) => x.body === 'hello from Dorothy' && x.name === 'deleted guest'));
    ok('d. …and the login name is free at once', (await signup('Dorothy', 'a long random phrase')).res.status === 200);
    ok('d. …a login with the old credentials fails like any other', (await guestLogin('Dorothy', 'wrong password!!', '203.0.113.70')).text === nobody.text);
    ok('d. …a deleted guest is never topped up and is not on the boards', app.services.tickets.topUp(D) === 0);

    // Delete by an admin (step-up).
    const vic = await signup('Victor', 'a long random phrase');
    const V = idOf('Victor');
    res = await adm('POST', `guests/${urlOf(V)}/delete`, { reason: 'spam' }, { stepup: false });
    ok('d. admin delete without step-up → 403 step_up_required', res.status === 403 && res.json.error === 'step_up_required');
    res = await adm('POST', `guests/${urlOf(V)}/delete`, { reason: 'spam' });
    ok('d. admin delete → 200 + an audit row', res.status === 200 && res.json.deleted === true
      && one("SELECT target FROM mod_actions WHERE action = 'guest_delete'").target === V && (await get('/play/api/me', { cookie: vic.cookie })).status === 401);
    ok('d. …again → 404; an unknown or malformed id → 404', (await adm('POST', `guests/${urlOf(V)}/delete`, {})).status === 404
      && (await adm('POST', 'guests/g.aaaaaaaaaaaaaaaa/delete', {})).status === 404 && (await adm('POST', `guests/${MA}/delete`, {})).status === 404);

    // The idle job.
    const idleA = await signup('Idlewild', 'a long random phrase');
    const IA = idOf('Idlewild');
    const idleB = await signup('Idlebusy', 'a long random phrase');
    const IB = idOf('Idlebusy');
    sql('UPDATE guests SET last_login_at = ? WHERE id IN (?, ?)', nowS() - 181 * DAY, IA, IB);
    sql('UPDATE sessions SET revoked_at = ? WHERE address = ?', nowS(), IA);
    const before = one('SELECT COUNT(*) AS n FROM guest_signups').n;
    let r = guests.idleSweep();
    ok('d. idle: no login for 180 days and no live session → deleted; one with a live session is kept',
      r.deleted === 1 && !one('SELECT 1 AS x FROM guests WHERE id = ?', IA) && !!one('SELECT 1 AS x FROM guests WHERE id = ?', IB), JSON.stringify(r));
    T += (DAY + 10) * 1000;
    r = guests.idleSweep();
    ok('d. idle: sign-up log rows older than 24 h are pruned (all of them, a day later)', before > 0 && r.pruned > 0 && one('SELECT COUNT(*) AS n FROM guest_signups').n === 0, JSON.stringify(r));
    ok('d. the idle threshold is the setting (default 180, 30–3650)', SPEC.guest_idle_days.def === 180 && SPEC.guest_idle_days.min === 30 && SPEC.guest_idle_days.max === 3650);
    void idleA; void idleB;

    // ── [e] tickets ───────────────────────────────────────────────────────────────────
    console.log('\n[e] tickets\n');
    T = (Math.floor(T / 86400000) + 1) * 86400000 + 8 * 3600 * 1000;   // a fresh UTC day, 08:00
    const tk = await signup('Tamsin', 'a long random phrase');
    const TK = idOf('Tamsin');
    const gd = () => db.raw.prepare("SELECT delta, ref FROM ledger WHERE address = ? AND reason = 'guest_daily' ORDER BY id").all(TK);
    ok('e. the first /me of the day sets 5 tickets: one ledger row +5, ref gd:<day>', one('SELECT plays FROM players WHERE address = ?', TK).plays === 5
      && gd().length === 1 && gd()[0].delta === 5 && gd()[0].ref === `gd:${utcDay(nowS())}`);
    const bot = (cookie) => post('/play/api/matches', { game_id: 'chess', mode: 'bot', bot_level: 1, colour: 'seat1' }, { cookie });
    res = await bot(tk.cookie);
    ok('e. a bot game spends one', res.status === 200 && one('SELECT plays FROM players WHERE address = ?', TK).plays === 4);
    await post(`/play/api/matches/${res.json.match.id}/resign`, {}, { cookie: tk.cookie });
    ok('e. a second /me the same day changes nothing', (await me(tk.cookie)).plays === 4 && gd().length === 1);
    T += DAY * 1000;
    res = await bot(tk.cookie);     // no /me first: the SPEND tops up, inside its own transaction
    ok('e. the next day, the first SPEND tops up first (4 → 5 → 4): a +1 row, ref of the new day', res.status === 200
      && one('SELECT plays FROM players WHERE address = ?', TK).plays === 4 && gd().length === 2 && gd()[1].delta === 1 && gd()[1].ref === `gd:${utcDay(nowS())}`);
    await post(`/play/api/matches/${res.json.match.id}/resign`, {}, { cookie: tk.cookie });
    await adm('POST', `players/${urlOf(TK)}/adjust`, { kind: 'plays', delta: 10 });
    ok('e. (an admin gives 10 extra)', one('SELECT plays FROM players WHERE address = ?', TK).plays === 14);
    T += DAY * 1000;
    ok('e. never saved up: the next day goes back DOWN to 5 (a −9 row)', (await me(tk.cookie)).plays === 5 && gd()[2].delta === -9);
    T += DAY * 1000;
    ok('e. a day that starts at 5 writes no ledger row (delta 0) but is marked done',
      (await me(tk.cookie)).plays === 5 && gd().length === 3 && one('SELECT guest_day FROM players WHERE address = ?', TK).guest_day === utcDay(nowS()));
    ok('e. …so a later spend that day does not top up again', await (async () => {
      const g1 = await bot(tk.cookie);
      await post(`/play/api/matches/${g1.json.match.id}/resign`, {}, { cookie: tk.cookie });
      return one('SELECT plays FROM players WHERE address = ?', TK).plays === 4 && gd().length === 3;
    })());
    settings.set('guest_daily_plays', 0);
    T += DAY * 1000;
    res = await bot(tk.cookie);
    ok('e. guest_daily_plays 0: the day starts at 0 and a game → 409 no_plays (and the top-up rolled back with it)', res.status === 409 && res.json.error === 'no_plays'
      && one('SELECT plays FROM players WHERE address = ?', TK).plays === 4);
    ok('e. …the /me that follows applies it', (await me(tk.cookie)).plays === 0);
    settings.set('guest_daily_plays', 5);
    T += DAY * 1000;
    await adm('POST', `players/${urlOf(TK)}/adjust`, { kind: 'plays', delta: 10 });   // before the guest's first /me
    ok('e. an admin grant made before the first /me of the day is not wiped: top-up 0 → 5 first, then +10 = 15',
      one('SELECT plays FROM players WHERE address = ?', TK).plays === 15 && gd().at(-1).delta === 5 && gd().at(-1).ref === `gd:${utcDay(nowS())}`);
    ok('e. …and the /me that follows keeps it (no second top-up)', (await me(tk.cookie)).plays === 15 && gd().at(-1).ref === `gd:${utcDay(nowS())}` && gd().filter((r) => r.ref === `gd:${utcDay(nowS())}`).length === 1);
    const cMB = await minerLogin(MB);
    const mbBefore = one('SELECT plays FROM players WHERE address = ?', MB).plays;
    T += DAY * 1000;
    ok('e. a miner is never topped up', (await me(cMB)).plays === mbBefore && !one("SELECT 1 AS x FROM ledger WHERE address = ? AND reason = 'guest_daily'", MB));
    ok('e. plays_balance_cap defaults to 999 (D25)', SPEC.plays_balance_cap.def === 999 && settings.get('plays_balance_cap') === 999);
    ok('e. Σ ledger = plays everywhere (ledger.verify)', ledger.verify().length === 0, JSON.stringify(ledger.verify().slice(0, 3)));

    // ── [f] chat + names ──────────────────────────────────────────────────────────────
    console.log('\n[f] chat and names\n');
    mineNow();
    const fresh = await signup('Felicity', 'a long random phrase');
    res = await post('/play/api/chat', { body: 'hi all' }, { cookie: fresh.cookie });
    ok('f. a guest under 24 h → 403 chat_refused account_too_new + when', res.status === 403 && res.json.reason === 'account_too_new' && res.json.available_at === nowS() + DAY);
    T += (DAY + 1) * 1000;
    res = await post('/play/api/chat', { body: 'hi all' }, { cookie: fresh.cookie });
    ok('f. at 24 h it may post', res.status === 200 && res.json.held === false, res.text);
    settings.set('guest_chat_min_age', 3 * DAY);
    res = await post('/play/api/chat', { body: 'still here' }, { cookie: fresh.cookie });
    ok('f. raising guest_chat_min_age closes an OPEN session too (the gate is read live)', res.status === 403 && res.json.reason === 'account_too_new');
    settings.set('guest_chat_min_age', DAY);
    ok('f. guest_chat_min_age can never go under the 1 h floor', SPEC.guest_chat_min_age.min >= CHAT_MIN_AGE_FLOOR);
    settings.set('chat_guests_enabled', false);
    res = await post('/play/api/chat', { body: 'still here' }, { cookie: fresh.cookie });
    ok('f. chat_guests_enabled off → guests_off; a miner still posts', res.json.reason === 'guests_off'
      && (await post('/play/api/chat', { body: 'miner here' }, { cookie: cMB })).status === 200);
    settings.set('chat_guests_enabled', true);
    T += 20 * 1000;
    ok('f. a guest needs 15 s between posts (a miner 5)', (await post('/play/api/chat', { body: 'one' }, { cookie: fresh.cookie })).status === 200
      && (await post('/play/api/chat', { body: 'two' }, { cookie: fresh.cookie })).status === 429);
    let n10 = 0;
    for (let i = 0; i < 12; i++) { T += 16 * 1000; if ((await post('/play/api/chat', { body: `n${i}` }, { cookie: fresh.cookie })).status === 200) n10++; }
    ok('f. …and at most 10 in an hour', n10 === 8, String(n10));    // 'hi all' + 'one' + 8 = 10
    T += 3700 * 1000;
    settings.set('chat_hold_links', false);
    res = await post('/play/api/chat', { body: 'see example.com for free grin' }, { cookie: fresh.cookie });
    const mlink = await post('/play/api/chat', { body: 'see example.org for docs' }, { cookie: cMB });
    ok('f. a guest link is ALWAYS held, even with chat_hold_links off; a miner\'s is not', res.json.held === true && mlink.json.held === false);
    settings.set('chat_hold_links', true);
    // Reports: three aged guests report a miner's message — it stays visible; three miners hide it.
    mineNow();
    T += 10 * 1000;     // the miner just posted: past its 5 s gap
    const target = (await post('/play/api/chat', { body: 'a perfectly fine message' }, { cookie: cMB })).json.message.id;
    const reporters = [];
    for (const n of ['Rhea', 'Rufus', 'Rosalind']) reporters.push(await signup(n, 'a long random phrase'));
    T += (DAY + 1) * 1000;
    mineNow();
    for (const g of reporters) await post(`/play/api/chat/${target}/report`, { reason: 'test' }, { cookie: g.cookie });
    ok('f. three guest reports do NOT hold a message (D26)', one('SELECT state FROM chat_messages WHERE id = ?', target).state === 'visible');
    const rq = (await adm('GET', 'chat/reports')).json;
    ok('f. …but they reach the moderation queue', JSON.stringify(rq).includes(String(target)) && one('SELECT COUNT(*) AS n FROM chat_reports WHERE message_id = ?', target).n === 3);
    for (const a of [MA, MC, MD]) await post(`/play/api/chat/${target}/report`, {}, { cookie: await minerLogin(a) });
    ok('f. …three miner reports do', one('SELECT state FROM chat_messages WHERE id = ?', target).state === 'held');
    // Names.
    ok('f. a guest\'s chat name is `Nick · guest`', (await get('/play/api/chat')).json.messages.some((x) => x.name === 'Felicity · guest'));
    res = await post('/play/api/nickname', { name: 'Felix' }, { cookie: fresh.cookie });
    ok('f. a rename within 7 days of sign-up → cooldown (sign-up counts as a change)', res.status === 403 && res.json.reason === 'cooldown');
    settings.set('nickname_change_days', 0);
    const newbie = await signup('Newbie', 'a long random phrase');
    res = await post('/play/api/nickname', { name: 'Neville' }, { cookie: newbie.cookie });
    ok('f. a guest renames with no account-age wait (only a session)', res.status === 200 && res.json.nickname.live === 'Neville', res.text);
    res = await post('/play/api/nickname', { name: 'Newbie' }, { cookie: fresh.cookie });
    ok('f. a rename to another guest\'s LOGIN name (no longer a live nickname) is allowed — a rename is no login-name oracle',
      res.status === 200 && res.json.nickname.live === 'Newbie', res.text);
    ok('f. …while sign-up with that login name is refused', (await signup('Newbie', 'a long random phrase')).res.json.error === 'name_unavailable');
    await post('/play/api/nickname/remove', {}, { cookie: newbie.cookie });
    ok('f. with no nickname a guest shows Guest-XXXX', names.label(idOf('Newbie')) === guestTag(idOf('Newbie')));
    settings.set('nicknames_enabled', false);
    ok('f. nicknames off → Guest-XXXX for a named guest too', names.label(idOf('Felicity')) === guestTag(idOf('Felicity')));
    settings.set('nicknames_enabled', true);
    settings.set('nickname_change_days', 7);

    // ── [g] identity fences ───────────────────────────────────────────────────────────
    console.log('\n[g] identity fences (D32, §19.13 #29)\n');
    const realLink = createPoolLink({ config: { net: 'mainnet', poolInternalUrl: 'http://127.0.0.1:9', linkSecretFile: __filename } });
    let linkErr = null;
    try { await realLink.verifyProof(W, 'pw', '203.0.113.9'); } catch (e) { linkErr = e; }
    ok('g. pool-link refuses to send a guest id: not_pool_address, before any connection (not link_down)',
      linkErr instanceof PoolLinkError && linkErr.code === 'not_pool_address');
    ok('g. no guest id ever reached the (stub) pool in this whole suite', poolCalls.length > 0 && !poolCalls.some(isGuestId));
    const winFrom = Math.floor(nowS() / 3600) * 3600 - 3600;
    const cr = activity.creditWindow(winFrom, winFrom + 3600, [{ address: W, seconds: 3600, minutes: 60 }, { address: MD, seconds: 3600, minutes: 60 }]);
    ok('g. the activity sync never credits a guest (a planted row is skipped; the miner beside it is credited)',
      cr.credited === 1 && !one('SELECT 1 AS x FROM activity_daily WHERE address = ?', W) && !one("SELECT 1 AS x FROM ledger WHERE address = ? AND reason = 'mining_minutes'", W));
    res = await adm('POST', `moderators/${urlOf(W)}`, {});
    ok('g. a guest can never be appointed moderator → 400 address', res.status === 400 && res.json.field === 'address' && !one('SELECT 1 AS x FROM moderators WHERE address = ?', W));
    sql('INSERT INTO activity_daily (address, day, seconds) VALUES (?, ?, 36000)', W, utcDay(nowS()));
    const ev = { rules: { min_minutes: 1 } };
    const days = { fromDay: utcDay(nowS() - DAY), toDay: utcDay(nowS()) };
    ok('g. mining_* event kinds skip guests, even with a planted activity row', !miningMinutes.compute(db, ev, days).some((x) => isGuestId(x.address))
      && !activeDays.compute(db, ev, days).some((x) => isGuestId(x.address)) && miningMinutes.compute(db, ev, days).length > 0);
    sql('DELETE FROM activity_daily WHERE address = ?', W);
    ok('g. the admin player view of a guest: kind, dates — never the login name', await (async () => {
      // Felicity renamed herself to Newbie in [f]: her login name must appear nowhere in the view.
      const v = (await adm('GET', `players/${urlOf(idOf('Felicity'))}`)).json;
      return v.kind === 'guest' && v.guest && v.guest.created_at > 0 && Object.keys(v.guest).sort().join() === 'created_at,last_login_at'
        && !JSON.stringify(v).includes('Felicity') && !JSON.stringify(v).includes('login_name') && JSON.stringify(v).includes('Newbie');
    })());
    ok('g. an admin write on a guest id nobody holds → 404, and no players row is created', (await adm('POST', 'players/g.zzzzzzzzzzzzzzzz/adjust', { kind: 'plays', delta: 5 })).status === 404
      && (await adm('POST', 'players/g.zzzzzzzzzzzzzzzz/nick-block', {})).status === 404 && (await adm('GET', 'players/g.zzzzzzzzzzzzzzzz')).status === 404
      && !one("SELECT 1 AS x FROM players WHERE address = 'g:zzzzzzzzzzzzzzzz'"));
    ok('g. the admin can mute a guest by its URL form; the id itself in a path is refused (no ":" in a param)',
      (await adm('POST', `players/${urlOf(TK)}/mute`, { minutes: 5 })).status === 200 && (await adm('POST', `players/${TK}/mute`, { minutes: 5 })).status === 404);
    // Boards + events with guests and a deleted guest.
    await adm('POST', `players/${urlOf(TK)}/adjust`, { kind: 'points', delta: 50 });
    const DG = idOf('Dorothy');
    await adm('POST', `players/${urlOf(DG)}/adjust`, { kind: 'points', delta: 60 });
    await adm('POST', `guests/${urlOf(DG)}/delete`, {});
    T += 120 * 1000;
    const board = (await get('/play/api/leaderboard?board=points')).json;
    ok('g. boards: a guest is ranked under its label; a deleted guest is not ranked', board.rows.some((x) => x.name === 'Tamsin · guest')
      && !board.rows.some((x) => x.name === 'deleted guest' || x.value === 60), JSON.stringify(board.rows));
    void events; void leaderboard; void sessions;

    // Every public response, and the login names.
    await get('/play/api/rules');
    await get('/play/api/lobby');
    const all = publicTexts.join('\n');
    ok('g. no public response carries a guest id', !GUEST_ID_RE_G.test(all), (all.match(GUEST_ID_RE_G) || [])[0]);
    ok('g. no public response carries a full address', !FULL_ADDR_RE.test(all));
    ok('g. no public response carries a login_name field', !/login_name/.test(all));
    ok('g. a guest nickname is only ever shown as `Nick · guest`', ((all.match(/"Felicity[^"]*"/g) || []).every((h) => h === '"Felicity · guest"'))
      && (all.match(/"Felicity · guest"/g) || []).length > 0);
    ok('g. /me returns the login name to its owner', (await me(tk.cookie)).guest.login_name === 'Tamsin');
    ok('g. the rules carry the guest numbers (for the C6 fold)', await (async () => {
      const g = (await get('/play/api/rules')).json.guests;
      return g.daily_tickets === 5 && g.chat_min_age_s === DAY && g.chat_min_interval_s === 15 && g.chat_posts_per_hour === 10 && g.signup_enabled === true;
    })());

    // ── [h] query plans ───────────────────────────────────────────────────────────────
    console.log('\n[h] query plans\n');
    const plan = (s) => db.raw.prepare(`EXPLAIN QUERY PLAN ${s}`).all().map((x) => x.detail).join(' | ');
    const plans = [
      plan("SELECT id FROM guests WHERE login_norm = 'x'"),
      plan("SELECT id FROM guests WHERE id = 'g:x'"),
      plan("SELECT COUNT(*) AS n, MIN(created_at) FROM guest_signups WHERE ip_coarse = 'x' AND created_at > 1"),
      plan('SELECT id FROM guests WHERE last_login_at < 1 ORDER BY last_login_at ASC LIMIT 500'),
      plan("SELECT COUNT(*) AS n FROM chat_reports WHERE message_id = 1 AND resolved_at IS NULL AND reporter NOT LIKE 'g:%'"),
      plan("SELECT 1 FROM sessions WHERE address = 'g:x' AND revoked_at IS NULL AND expires_at > 1 LIMIT 1"),
    ];
    ok('h. every guest read is an index SEARCH, never a table SCAN', plans.every((p) => /SEARCH/.test(p) && !/SCAN (guests|guest_signups|chat_reports|sessions)\b/.test(p)), plans.join(' || '));
    ok('h. the ledger balances at the end', ledger.verify().length === 0);
  } finally {
    srv.close();
    db.close();
  }

  console.log(`\nRESULT pass=${pass} fail=${fail}`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); console.log(`\nRESULT pass=${pass} fail=${fail + 1}`); process.exit(1); });
