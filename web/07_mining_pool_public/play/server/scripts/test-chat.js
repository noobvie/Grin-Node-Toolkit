'use strict';

// Part 8 (design §19.10, §19.11, D9, D12, D21): chat + moderation.
//
//   [a] units: body normalisation, the hold rules, word normalisation
//   [b] reading: chat switch, mode off, page shape, masking, own held messages, params
//   [c] posting: every gate (session, mute, anchor, password-only, proof age, recent mining),
//       the rate limits (5 s floor, per hour, slow mode, per IP), duplicates, the body cap,
//       holds, and that `role` can never be sent
//   [d] reports: needs a chat-capable session, dedupe, own/operator refused, the threshold
//   [e] the change feed: delete / hold / approve reach a page that already drew the message;
//       epoch + revision resets
//   [f] operator (admin proxy): delete / approve / keep / restore / operator post (the badge),
//       word list, mute / unmute, ban (revokes sessions) / unban, purge, adjust, settings,
//       mod log, and which routes need step-up
//   [g] moderators (D21): appoint, the password rule, the queue (masked), delete / approve /
//       mute and every limit on them, the audit identity, removal, the badge
//   [h] retention, and invariants: no public response carries a full address; every read is
//       an indexed range read; the ledger balances
//
// Loopback server with a stubbed pool; the DB is in memory. Nothing is left running.
// Run: node scripts/test-chat.js

const path = require('node:path');
const http = require('node:http');

const { openDb } = require('../lib/db.js');
const { createLogger } = require('../lib/log.js');
const { loadGames } = require('../lib/registry.js');
const { buildApp, createServer, listen } = require('../lib/app.js');
const { normaliseBody, normaliseWord, holdReason, BODY_MAX, CHANGE_LOG_MAX } = require('../lib/chat.js');
const { FOREVER } = require('../lib/moderation.js');

let pass = 0, fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else      { fail++; console.error(`  FAIL  ${name}${extra ? ' — ' + extra : ''}`); }
}

const SERVER = path.join(__dirname, '..');
const GAMES = path.join(SERVER, '..', 'games');
const lines = [];
const log = createLogger((level, line) => lines.push(`${level} ${line}`));
const DAY = 86400;
const FULL_ADDR_RE = /t?grin1[ac-hj-np-z02-9]{58}/;
const cp = (...c) => String.fromCodePoint(...c);

const CS = 'acdefghjklmnpqrstuvwxyz023456789';
function addr(n, prefix = 'grin1') {
  let x = (n * 7919 + 13) >>> 0;
  let s = '';
  for (let i = 0; i < 58; i++) { x = (Math.imul(x, 1103515245) + 12345) >>> 0; s += CS[(x >>> 16) % 32]; }
  return prefix + s;
}
const mask = (a) => `${a.slice(0, 9)}…${a.slice(-4)}`;
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

async function main() {
  // ── [a] units ───────────────────────────────────────────────────────────────────────
  console.log('\n[a] units: normalisation, holds, words\n');
  ok('a. NFC: a decomposed é becomes one code point', normaliseBody('cafe' + cp(0x301)) === 'caf' + cp(0xE9));
  ok('a. newlines, tabs and CR become spaces, then collapse', normaliseBody('a\r\n\n\tb   c') === 'a b c');
  ok('a. a control between two words cannot glue them', normaliseBody('ab' + cp(0x07) + 'cd') === 'ab cd');
  ok('a. NUL and C1 controls are gone', normaliseBody('x' + cp(0) + cp(0x85) + 'y') === 'x y');
  ok('a. line/paragraph separators become spaces', normaliseBody('a' + cp(0x2028) + 'b' + cp(0x2029) + 'c') === 'a b c');
  ok('a. bidi overrides + isolates removed', normaliseBody('pay' + cp(0x202E) + 'lap' + cp(0x2066) + 'x' + cp(0x2069)) === 'paylapx');
  ok('a. zero-width space/joiners, word joiner, BOM, LRM removed',
    normaliseBody('a' + cp(0x200B) + 'b' + cp(0x200C) + 'c' + cp(0x200D) + 'd' + cp(0x2060) + 'e' + cp(0xFEFF) + 'f' + cp(0x200E) + 'g') === 'abcdefg');
  ok('a. Hangul fillers (the "invisible message") removed', normaliseBody(cp(0x3164) + cp(0x115F) + cp(0xFFA0)) === null);
  ok('a. a combining-mark run is cut to 3', [...normaliseBody('a' + cp(0x300).repeat(40))].length === 4);
  ok('a. empty / whitespace-only / non-string → null', normaliseBody('') === null && normaliseBody('   \n ') === null && normaliseBody(5) === null && normaliseBody(null) === null);
  ok(`a. ${BODY_MAX} code points pass, ${BODY_MAX + 1} do not`, normaliseBody('x'.repeat(BODY_MAX)) !== null && normaliseBody('x'.repeat(BODY_MAX + 1)) === null);
  ok('a. the limit counts code points, not UTF-16 units', normaliseBody(cp(0x1F600).repeat(BODY_MAX)) !== null);
  ok('a. HTML is stored as the text it is (rendering is the client\'s job)', normaliseBody('<img src=x onerror=alert(1)>') === '<img src=x onerror=alert(1)>');
  const hr = (b, o = {}) => holdReason(b, { words: [], holdLinks: true, ...o });
  ok('a. hold: scheme, www., name.tld', hr('see https://x') === 'link' && hr('go to www.example') === 'link' && hr('visit evil.com now') === 'link');
  ok('a. hold: fullwidth ｗｗｗ．evil．com is caught (NFKC fold)', hr(cp(0xFF57, 0xFF57, 0xFF57, 0xFF0E) + 'evil' + cp(0xFF0E) + 'com') === 'link');
  ok('a. hold: a Grin address ("send to grin1…") is held with links', hr(`send 5 to ${addr(9)}`) === 'link');
  ok('a. not held: plain text, numbers, "e.g.", versions', hr('gg well played, 3.14 e.g. v5.5') === null);
  ok('a. hold_links off → links pass', hr('https://x.org', { holdLinks: false }) === null);
  ok('a. word list: a folded substring hit, case-insensitive', hr('you are a SCAMMER', { words: ['scam'] }) === 'word');
  ok('a. normaliseWord: folds, trims, refuses empty / > 40 / controls-only',
    normaliseWord('  ScAm  ') === 'scam' && normaliseWord('') === null && normaliseWord('x'.repeat(41)) === null && normaliseWord(cp(0x200B)) === null);

  // ── setup ───────────────────────────────────────────────────────────────────────────
  let T = Date.UTC(2026, 9, 7, 12, 0, 0);
  const nowS = () => Math.floor(T / 1000);
  const SECRET = 'k'.repeat(20) + 'Q7'.repeat(22);
  const cfg = { net: 'mainnet', poolInternalUrl: 'http://127.0.0.1:9', linkSecretFile: '/nonexistent' };
  const db = openDb(':memory:', { net: 'mainnet', log });
  // Proofs: 'ip' / 'pw' (old), 'pw-fresh' (600 s old), 'anchor'.
  const fakeLink = {
    secretConfigured: () => true,
    checkSecret: (g) => (g === SECRET ? 'ok' : 'bad'),
    async verifyProof(address, proof) {
      if (proof === 'ip') return { ok: true, method: 'ip', slot: 'set', age_seconds: null };
      if (proof === 'pw') return { ok: true, method: 'password', slot: 'set', age_seconds: null };
      if (proof === 'pw-fresh') return { ok: true, method: 'password', slot: 'set', age_seconds: 600 };
      if (proof === 'anchor') return { ok: true, method: 'ip', slot: 'anchor', age_seconds: null };
      return { ok: false, reason: 'no_match' };
    },
    async activity() { return { rows: [], dropped: 0 }; },
    async config() { return { mode: 'preview', chat_enabled: true }; },
  };
  const modeState = { mode: 'preview', chat_enabled: true };
  const fakeMode = { get: () => modeState, isOff: () => modeState.mode === 'off', start() {}, stop() {} };
  const app = buildApp({ config: cfg, db, log, clock: () => T, poolLink: fakeLink, mode: fakeMode, registry: loadGames({ gamesDir: GAMES, log }) });
  const { settings, ledger, chat } = app.services;
  const srv = createServer(app.handler);
  const { port } = await listen(srv, 0, '127.0.0.1');
  const HOST = 'pool.example';
  const publicTexts = [];
  let ipN = 1;
  const nextIp = () => `198.51.100.${ipN++}`;
  const get = async (p, { cookie, ip = '203.0.113.9' } = {}) => {
    const r = await request(port, { path: p, headers: { Host: HOST, 'X-Real-IP': ip, ...(cookie ? { Cookie: cookie } : {}) } });
    if (!p.startsWith('/play/api/me')) publicTexts.push(`GET ${p} ${r.text}`);
    return r;
  };
  const post = async (p, body, { cookie, ip = '203.0.113.9', headers = {}, raw } = {}) => {
    const r = await request(port, { method: 'POST', path: p, body: raw !== undefined ? raw : JSON.stringify(body),
      headers: { 'Content-Type': 'application/json', Host: HOST, 'X-Real-IP': ip, ...(cookie ? { Cookie: cookie } : {}), ...headers } });
    if (!p.startsWith('/play/api/login')) publicTexts.push(`POST ${p} ${r.text}`);
    return r;
  };
  async function login(address, proof = 'ip') {
    const res = await post('/play/api/login', { address, proof }, { ip: nextIp() });
    const sc = res.headers['set-cookie'];
    if (!sc) return null;
    return (Array.isArray(sc) ? sc[0] : sc).split(';')[0];
  }
  function adm(method, rel, body, { stepup = false, user = 'alice' } = {}) {
    const h = { 'X-Games-Link': SECRET, 'X-Admin-User': user, 'X-Admin-Stepup': stepup ? '1' : '0' };
    let payload;
    if (body !== undefined) { payload = JSON.stringify(body); h['Content-Type'] = 'application/json'; }
    return request(port, { method, path: `/internal/admin/${rel}`, headers: h, body: payload });
  }
  const sql = (s, ...a) => db.raw.prepare(s).run(...a);
  const one = (s, ...a) => db.raw.prepare(s).get(...a);
  const mine = (a, minutes, t = nowS()) => sql(
    'INSERT INTO activity_daily (address, day, seconds) VALUES (?, ?, ?) ON CONFLICT(address, day) DO UPDATE SET seconds = seconds + excluded.seconds',
    a, utcDay(t), minutes * 60);
  const say = (cookie, body, ip) => post('/play/api/chat', { body }, { cookie, ip });
  const step = (s = 6) => { T += s * 1000; };

  try {
    // ── [b] reading ─────────────────────────────────────────────────────────────────────
    console.log('\n[b] reading\n');
    let res = await get('/play/api/chat');
    ok('b. an empty room → 200 {enabled, room, epoch, rev, messages:[]}', res.status === 200 && res.json.enabled === true
      && res.json.room === 'global' && /^[0-9a-f]{16}$/.test(res.json.epoch) && res.json.rev === 0 && res.json.messages.length === 0, res.text);
    modeState.chat_enabled = false;
    res = await get('/play/api/chat');
    ok('b. pool chat switch off → enabled:false and no messages (not an error)', res.status === 200 && res.json.enabled === false && res.json.messages.length === 0);
    modeState.chat_enabled = true;
    modeState.mode = 'off';
    ok('b. games mode off → 404 (every public route)', (await get('/play/api/chat')).status === 404);
    modeState.mode = 'preview';
    ok('b. an unknown room → 400', (await get('/play/api/chat?room=lobby')).json.field === 'room');
    ok('b. an unknown or repeated param → 400', (await get('/play/api/chat?x=1')).status === 400 && (await get('/play/api/chat?after=1&after=2')).status === 400);
    ok('b. after must be a plain integer', (await get('/play/api/chat?after=1e3')).json.field === 'after' && (await get('/play/api/chat?after=-1')).status === 400);

    // ── [c] posting ─────────────────────────────────────────────────────────────────────
    console.log('\n[c] posting: gates, limits, holds\n');
    const A = addr(1), B = addr(2), C = addr(3), D = addr(4), E = addr(5);
    for (const a of [A, B, C, D, E]) mine(a, 120);
    const ca = await login(A);
    ok('c. no session → 401', (await say(null, 'hi')).status === 401);
    res = await say(ca, 'hello world');
    ok('c. a chat-capable session posts → 200 with its own view', res.status === 200 && res.json.message.body === 'hello world'
      && res.json.message.own === true && res.json.message.role === 'player' && res.json.message.name === mask(A) && res.json.held === false, res.text);
    const firstId = res.json.message.id;
    res = await say(ca, 'too soon');
    ok('c. a second post inside 5 s → 429 + Retry-After', res.status === 429 && Number(res.headers['retry-after']) >= 1 && Number(res.headers['retry-after']) <= 5, res.text);
    step();
    ok('c. the same body again inside 10 min → 409 duplicate', (await say(ca, 'hello world')).json.error === 'duplicate');
    step();
    ok('c. `role` in the body is refused (400 body) — role is never an input', (await post('/play/api/chat', { body: 'x', role: 'operator' }, { cookie: ca })).json.field === 'body');
    ok('c. an empty / whitespace-only body → 400 body', (await say(ca, ' \n ')).json.field === 'body');
    ok('c. a 281-code-point body → 400 body', (await say(ca, 'y'.repeat(281))).json.field === 'body');
    res = await post('/play/api/chat', null, { cookie: ca, raw: JSON.stringify({ body: 'z'.repeat(5000) }) });
    ok('c. a request over 4 KB → 413', res.status === 413);
    res = await post('/play/api/chat', null, { cookie: ca, raw: 'body=x', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    ok('c. a form post → 415 (CSRF layer 2)', res.status === 415);
    ok('c. a foreign Origin → 403 (CSRF layer 3)', (await post('/play/api/chat', { body: 'x' }, { cookie: ca, headers: { Origin: 'https://evil.example' } })).status === 403);

    // gates
    settings.set('chat_min_minutes', 60, 't');
    const Fm = addr(6);
    mine(Fm, 30);
    const cf = await login(Fm);
    res = await say(cf, 'can I talk?');
    ok('c. 30 of 60 recent mining minutes → 403 chat_refused, no_recent_mining + have/need',
      res.status === 403 && res.json.reason === 'no_recent_mining' && res.json.mining.have_minutes === 30 && res.json.mining.need_minutes === 60 && res.json.mining.days === 7, res.text);
    mine(Fm, 30, nowS() - 6 * DAY);
    ok('c. minutes 6 days ago count (window = today + 6 days back)', (await say(cf, 'now?')).status === 200);
    step();
    const Old = addr(7);
    mine(Old, 500, nowS() - 7 * DAY);
    const cOld = await login(Old);
    ok('c. minutes 7 days ago do NOT count', (await say(cOld, 'old miner')).json.reason === 'no_recent_mining');
    settings.set('chat_min_minutes', 0, 't');
    ok('c. chat_min_minutes 0 → no mining gate', (await say(cOld, 'old miner')).status === 200);
    settings.set('chat_min_minutes', 60, 't');
    step();
    const cAnchor = await login(B, 'anchor');
    ok('c. an anchor-proof session → chat_refused anchor_proof', (await say(cAnchor, 'x')).json.reason === 'anchor_proof');
    const cFresh = await login(C, 'pw-fresh');
    res = await say(cFresh, 'fresh');
    ok('c. a fresh proof → chat_refused proof_too_new + available_at', res.json.reason === 'proof_too_new' && res.json.available_at === nowS() + DAY - 600, res.text);
    settings.set('chat_requires_password', true, 't');
    const cbLocked = await login(B, 'ip');
    ok('c. password-only chat + an IP proof → password_required', (await say(cbLocked, 'x')).json.reason === 'password_required');
    settings.set('chat_requires_password', false, 't');
    ok('c. …a session OPENED under the switch stays closed after it is turned off (chat_ok_after is fixed at login, D9)',
      (await say(cbLocked, 'x')).json.reason === 'password_required');
    const cbIp = await login(B, 'ip');
    ok('c. …and a new IP-proof session posts', (await say(cbIp, 'b here')).status === 200);
    step();
    modeState.chat_enabled = false;
    ok('c. pool chat switch off → 403 chat_off', (await say(ca, 'x')).json.error === 'chat_off');
    modeState.chat_enabled = true;

    // rate limits
    settings.set('chat_posts_per_hour', 3, 't');
    const cd = await login(D);
    for (let i = 0; i < 3; i++) { await say(cd, `d${i}`); step(); }
    res = await say(cd, 'd3');
    ok('c. the per-hour limit (setting 3) → 429 on the 4th', res.status === 429, res.text);
    const cd2 = await login(D);
    ok('c. …and a SECOND session of the same address shares it', (await say(cd2, 'd4')).status === 429);
    T += 3600 * 1000;
    ok('c. …and an hour later it posts again', (await say(cd2, 'd5')).status === 200);
    settings.set('chat_posts_per_hour', 30, 't');
    settings.set('chat_slow_seconds', 60, 't');
    step(10);
    ok('c. slow mode 60 s: a post 10 s after the last → 429', (await say(cd2, 'slow')).status === 429);
    step(50);
    ok('c. …and 60 s after → 200', (await say(cd2, 'slow ok')).status === 200);
    settings.set('chat_slow_seconds', 0, 't');
    // per IP: 60 an hour across addresses
    const ipAddrs = [addr(20), addr(21), addr(22)];
    const ipCookies = [];
    for (const a of ipAddrs) { mine(a, 90); ipCookies.push(await login(a)); }
    let accepted = 0, refused = null;
    for (let i = 0; i < 61; i++) {
      const r = await say(ipCookies[i % 3], `ip msg ${i}`, '192.0.2.77');
      if (r.status === 200) accepted++; else { refused = r; break; }
      if (i % 3 === 2) step(6);
    }
    ok('c. 60 posts an hour per IP across addresses, the 61st → 429', accepted === 60 && refused && refused.status === 429, `${accepted} ${refused && refused.text}`);
    step();

    // holds
    res = await say(ca, 'check www.free-grin.example');
    ok('c. a link is HELD: 200, held:true, the author sees it flagged', res.status === 200 && res.json.held === true && res.json.message.held === true);
    const heldId = res.json.message.id;
    res = await get('/play/api/chat');
    ok('c. …it is NOT in the public page', !res.json.messages.some((m) => m.id === heldId));
    res = await get('/play/api/chat', { cookie: ca });
    ok('c. …it IS in the author\'s page, flagged held', res.json.messages.some((m) => m.id === heldId && m.held === true && m.own === true));
    res = await get('/play/api/chat', { cookie: cbIp });
    ok('c. …and not in another player\'s page', !res.json.messages.some((m) => m.id === heldId));

    // ── [d] reports ─────────────────────────────────────────────────────────────────────
    console.log('\n[d] reports\n');
    step();
    res = await say(cf, 'rude message');
    const rudeId = res.json.message.id;
    ok('d. report without a session → 401', (await post(`/play/api/chat/${rudeId}/report`, {})).status === 401);
    ok('d. report from a session that cannot post → 403', (await post(`/play/api/chat/${rudeId}/report`, {}, { cookie: cAnchor })).json.error === 'chat_refused');
    ok('d. reporting your own message → 400 not_reportable', (await post(`/play/api/chat/${rudeId}/report`, {}, { cookie: cf })).json.error === 'not_reportable');
    ok('d. an unknown message → 404', (await post('/play/api/chat/999999/report', {}, { cookie: ca })).status === 404);
    res = await post(`/play/api/chat/${rudeId}/report`, { reason: 'insult' }, { cookie: ca });
    ok('d. first report → ok, not a duplicate, not held', res.status === 200 && res.json.duplicate === false && res.json.held === false, res.text);
    res = await post(`/play/api/chat/${rudeId}/report`, { reason: 'again' }, { cookie: ca });
    ok('d. the same reporter again → duplicate (UNIQUE message, reporter)', res.json.duplicate === true);
    ok('d. …a second session of the same address is still the same reporter',
      (await post(`/play/api/chat/${rudeId}/report`, {}, { cookie: await login(A) })).json.duplicate === true);
    await post(`/play/api/chat/${rudeId}/report`, {}, { cookie: cbIp });
    const r3 = await login(E);
    res = await post(`/play/api/chat/${rudeId}/report`, {}, { cookie: r3 });
    ok('d. the 3rd DISTINCT reporter → held (hold_reason reports)', res.json.held === true
      && one('SELECT state, hold_reason FROM chat_messages WHERE id = ?', rudeId).hold_reason === 'reports');
    ok('d. a reason with a control char is normalised, not refused',
      (await post(`/play/api/chat/${firstId}/report`, { reason: 'spam' + cp(0x202E) }, { cookie: cbIp })).status === 200
      && one('SELECT reason FROM chat_reports WHERE message_id = ? AND reporter = ?', firstId, B).reason === 'spam');

    // ── [e] the change feed ─────────────────────────────────────────────────────────────
    console.log('\n[e] the change feed\n');
    let page = await get('/play/api/chat');
    const { epoch } = page.json;
    let rev = page.json.rev;
    let after = page.json.messages[page.json.messages.length - 1].id;
    ok('e. a page carries epoch + rev; rev counts state changes', rev >= 1 && page.json.messages.every((m) => m.id !== rudeId));
    res = await get(`/play/api/chat?after=${after}&rev=${rev}&epoch=${epoch}`);
    ok('e. a poll with nothing new → no messages, empty changes', res.json.messages.length === 0 && res.json.changes.removed.length === 0 && res.json.reset === undefined);
    res = await adm('POST', `chat/messages/${firstId}/delete`, { reason: 'test' });
    ok('e. operator deletes a message already on screen (FAST: no step-up) → 200', res.status === 200 && res.json.changed === true, res.text);
    res = await get(`/play/api/chat?after=${after}&rev=${rev}&epoch=${epoch}`);
    ok('e. …the next poll lists it in changes.removed', res.json.changes.removed.includes(firstId) && res.json.rev === rev + 1, res.text);
    rev = res.json.rev;
    res = await adm('POST', `chat/held/${rudeId}/approve`, {});
    ok('e. operator approves the report-held message → visible, reports resolved', res.json.message.state === 'visible'
      && one('SELECT COUNT(*) AS n FROM chat_reports WHERE message_id = ? AND resolved_at IS NULL', rudeId).n === 0);
    res = await get(`/play/api/chat?after=${after}&rev=${rev}&epoch=${epoch}`);
    // rudeId is newer than this page's `after` (it was held when the page was drawn), so it
    // arrives as a new message; one OLDER than `after` arrives in changes.shown (next check).
    ok('e. …the next poll delivers it once (newer than after → messages, not a change)',
      res.json.messages.some((m) => m.id === rudeId && m.body === 'rude message') && !res.json.changes.shown.some((m) => m.id === rudeId));
    rev = res.json.rev;
    await adm('POST', `chat/messages/${firstId}/delete`, {});
    res = await get(`/play/api/chat?after=${after}&rev=${rev}&epoch=${epoch}`);
    rev = res.json.rev;
    await adm('POST', `chat/messages/${firstId}/restore`, {}, { stepup: true });
    res = await get(`/play/api/chat?after=${after}&rev=${rev}&epoch=${epoch}`);
    ok('e. a message OLDER than after that comes back (restore) → changes.shown with its body',
      res.json.changes.shown.some((m) => m.id === firstId && m.body === 'hello world'), JSON.stringify(res.json.changes));
    rev = res.json.rev;
    res = await get(`/play/api/chat?after=${after}&rev=${rev}&epoch=deadbeefdeadbeef`);
    ok('e. a different epoch (the service restarted) → reset:true + a fresh page', res.json.reset === true && Array.isArray(res.json.messages) && res.json.messages.length > 0);
    ok('e. a revision from the future → reset', (await get(`/play/api/chat?after=${after}&rev=${rev + 5}&epoch=${epoch}`)).json.reset === true);
    ok('e. after without rev → reset (never a silent gap)', (await get(`/play/api/chat?after=${after}`)).json.reset === true);
    ok('e. a malformed rev → 400', (await get(`/play/api/chat?after=${after}&rev=x&epoch=${epoch}`)).json.field === 'rev');
    step();
    res = await say(ca, 'a new one');
    const newId = res.json.message.id;
    res = await get(`/play/api/chat?after=${after}&rev=${rev}&epoch=${epoch}`);
    ok('e. a new message arrives by id, not as a change', res.json.messages.some((m) => m.id === newId) && res.json.changes.shown.length === 0);
    after = newId;
    // the author's view of a message that gets held by reports
    sql('UPDATE chat_messages SET state = ? WHERE id = ?', 'visible', newId);
    for (const c of [cbIp, r3, cf]) await post(`/play/api/chat/${newId}/report`, {}, { cookie: c });
    res = await get(`/play/api/chat?after=${after}&rev=${rev}&epoch=${epoch}`, { cookie: ca });
    ok('e. a message held by reports → changes.held (the author\'s page flags it, others drop it)', res.json.changes.held.includes(newId));
    const logLen = chat._internal.changeLog.length;
    ok(`e. the change log is bounded (${CHANGE_LOG_MAX})`, logLen <= CHANGE_LOG_MAX);

    // ── [f] operator ────────────────────────────────────────────────────────────────────
    console.log('\n[f] operator: messages, players, words, settings, mod log\n');
    ok('f. admin without the secret → 401', (await request(port, { path: '/internal/admin/chat/messages', headers: { 'X-Admin-User': 'a' } })).status === 401);
    res = await adm('GET', 'chat/messages?state=held');
    ok('f. list by state: held — full addresses (admin only), open report counts', res.status === 200 && res.json.messages.some((m) => m.id === heldId && m.address === A));
    ok('f. list bad state → 400', (await adm('GET', 'chat/messages?state=nope')).json.field === 'state');
    res = await adm('GET', `chat/messages?address=${A}`);
    ok('f. list by address', res.json.messages.length > 0 && res.json.messages.every((m) => m.address === A));
    res = await adm('GET', 'chat/reports');
    ok('f. the report queue groups per message, with reporters', res.json.reports.some((g) => g.message.id === newId && g.count === 3 && g.reports.length === 3));
    res = await adm('POST', `chat/messages/${firstId}/restore`, {});
    ok('f. restore without step-up → 403 step_up_required', res.status === 403 && res.json.error === 'step_up_required');
    await adm('POST', `chat/messages/${firstId}/delete`, {});
    res = await adm('POST', `chat/messages/${firstId}/restore`, {}, { stepup: true });
    ok('f. restore with step-up → visible again', res.json.changed === true && res.json.message.state === 'visible');
    res = await adm('POST', 'chat/post', { body: 'Welcome to GRINIUM chat!' });
    ok('f. operator post (FAST) → role operator, no address', res.status === 200 && res.json.message.role === 'operator' && res.json.message.address === null);
    const opId = res.json.message.id;
    page = await get('/play/api/chat');
    const opView = page.json.messages.find((m) => m.id === opId);
    ok('f. the public view: name "Operator", role operator — the admin\'s name never leaks',
      opView && opView.name === 'Operator' && opView.role === 'operator' && !page.text.includes('alice'));
    ok('f. an operator message cannot be reported', (await post(`/play/api/chat/${opId}/report`, {}, { cookie: ca })).json.error === 'not_reportable');
    ok('f. operator post body rules apply (empty → 400)', (await adm('POST', 'chat/post', { body: cp(0x200B) })).json.field === 'body');

    // word list
    ok('f. word list edit without step-up → 403', (await adm('POST', 'chat/words', { add: ['scam'] })).status === 403);
    res = await adm('POST', 'chat/words', { add: ['  SCAM ', 'rugpull', 'scam'] }, { stepup: true });
    ok('f. word list add (step-up): normalised + deduped', res.json.added === 2 && res.json.words.map((w) => w.word).join() === 'rugpull,scam', res.text);
    ok('f. a bad word → 400, nothing written', (await adm('POST', 'chat/words', { add: ['ok', cp(0x200B)] }, { stepup: true })).status === 400
      && one('SELECT COUNT(*) AS n FROM chat_words').n === 2);
    step();
    res = await say(cf, 'this is a total Scam');
    ok('f. …a post hitting the word list is held (hold_reason word)', res.json.held === true && one('SELECT hold_reason FROM chat_messages WHERE id = ?', res.json.message.id).hold_reason === 'word');
    res = await adm('POST', 'chat/words', { remove: ['rugpull'] }, { stepup: true });
    ok('f. word list remove', res.json.removed === 1 && res.json.words.length === 1);

    // mute / unmute
    res = await adm('POST', `players/${A}/mute`, { minutes: 10, reason: 'cool down' });
    ok('f. mute (FAST) → muted_until = now + 10 min', res.status === 200 && res.json.player.muted_until === nowS() + 600 && res.json.player.muted === true, res.text);
    step();
    res = await say(ca, 'am I muted');
    ok('f. a muted player → 403 chat_refused muted + available_at', res.json.reason === 'muted' && res.json.available_at === nowS() + 600 - 6);
    ok('f. …/me says so too', (await get('/play/api/me', { cookie: ca })).json.chat.reason === 'muted');
    T += 600 * 1000;
    ok('f. the mute EXPIRES by itself', (await say(ca, 'back again')).status === 200);
    await adm('POST', `players/${A}/mute`, { minutes: 60 });
    ok('f. unmute without step-up → 403', (await adm('POST', `players/${A}/unmute`, {})).status === 403);
    res = await adm('POST', `players/${A}/unmute`, {}, { stepup: true });
    ok('f. unmute with step-up', res.json.player.muted_until === null);
    ok('f. mute > 30 days → 400; 0 → 400; a string → 400', (await adm('POST', `players/${A}/mute`, { minutes: 43201 })).json.field === 'minutes'
      && (await adm('POST', `players/${A}/mute`, { minutes: 0 })).status === 400 && (await adm('POST', `players/${A}/mute`, { minutes: '5' })).status === 400);
    ok('f. a testnet address on a mainnet service → 400 address', (await adm('POST', `players/${addr(1, 'tgrin1')}/mute`, { minutes: 5 })).json.field === 'address');

    // ban / unban
    const Bn = addr(30);
    mine(Bn, 100);
    const cBn = await login(Bn);
    const cBn2 = await login(Bn);
    ok('f. ban without step-up → 403', (await adm('POST', `players/${Bn}/ban`, { days: 7 })).status === 403);
    ok('f. ban needs exactly one of days / forever', (await adm('POST', `players/${Bn}/ban`, { days: 7, forever: true }, { stepup: true })).status === 400
      && (await adm('POST', `players/${Bn}/ban`, {}, { stepup: true })).status === 400);
    res = await adm('POST', `players/${Bn}/ban`, { days: 7, reason: 'spam' }, { stepup: true });
    ok('f. ban (step-up) → revokes EVERY session at once', res.json.sessions_revoked === 2 && res.json.player.banned === true, res.text);
    ok('f. …the banned session is dead (401), both of them', (await say(cBn, 'x')).status === 401 && (await get('/play/api/me', { cookie: cBn2 })).status === 401);
    ok('f. …and login is refused before the pool call (403 banned)', (await post('/play/api/login', { address: Bn, proof: 'ip' }, { ip: nextIp() })).status === 403);
    res = await adm('POST', `players/${Bn}/unban`, {}, { stepup: true });
    ok('f. unban → can log in again', res.json.player.banned_until === null && (await login(Bn)) !== null);
    res = await adm('POST', `players/${Bn}/ban`, { forever: true }, { stepup: true });
    ok('f. ban forever = 253402300799', res.json.player.banned_until === FOREVER);
    await adm('POST', `players/${Bn}/unban`, {}, { stepup: true });

    // purge
    const Pg = addr(31);
    mine(Pg, 100);
    const cPg = await login(Pg);
    const pgIds = [];
    for (let i = 0; i < 3; i++) { pgIds.push((await say(cPg, `spam ${i}`)).json.message.id); step(); }
    page = await get('/play/api/chat');
    const pRev = page.json.rev;
    res = await adm('POST', `players/${Pg}/purge`, { days: 1 }, { stepup: true });
    ok('f. purge (step-up): every recent message of the address deleted', res.json.deleted === 3
      && pgIds.every((id) => one('SELECT state FROM chat_messages WHERE id = ?', id).state === 'deleted'));
    res = await get(`/play/api/chat?after=${pgIds[2]}&rev=${pRev}&epoch=${epoch}`);
    ok('f. …and every open page is told (changes.removed)', pgIds.every((id) => res.json.changes.removed.includes(id)));

    // adjust
    ok('f. adjust without step-up → 403', (await adm('POST', `players/${A}/adjust`, { kind: 'points', delta: 5 })).status === 403);
    res = await adm('POST', `players/${A}/adjust`, { kind: 'points', delta: 25, note: 'bug bounty' }, { stepup: true });
    ok('f. adjust +25 points (admin_adjust ledger row)', res.json.player.points === 25
      && one("SELECT COUNT(*) AS n FROM ledger WHERE address = ? AND reason = 'admin_adjust'", A).n === 1);
    res = await adm('POST', `players/${A}/adjust`, { kind: 'plays', delta: -5 }, { stepup: true });
    ok('f. an adjust below zero → 409 no_plays, nothing written', res.status === 409 && res.json.error === 'no_plays');
    ok('f. adjust 0 / a float / a bad kind → 400', (await adm('POST', `players/${A}/adjust`, { kind: 'points', delta: 0 }, { stepup: true })).status === 400
      && (await adm('POST', `players/${A}/adjust`, { kind: 'points', delta: 1.5 }, { stepup: true })).status === 400
      && (await adm('POST', `players/${A}/adjust`, { kind: 'grin', delta: 1 }, { stepup: true })).json.field === 'kind');

    // player view + lists
    res = await adm('GET', `players/${A}`);
    ok('f. player view: row, sessions by proof kind, activity, matches, messages', res.json.known === true && res.json.sessions.ip >= 1
      && Array.isArray(res.json.activity) && Array.isArray(res.json.matches) && res.json.messages.length > 0);
    res = await adm('GET', `players/${addr(99)}`);
    ok('f. an address never seen → known:false, no error', res.status === 200 && res.json.known === false && res.json.player === null);
    await adm('POST', `players/${B}/mute`, { minutes: 30 });
    ok('f. players?filter=muted', (await adm('GET', 'players?filter=muted')).json.players.some((p) => p.address === B));
    ok('f. players?filter=bogus → 400', (await adm('GET', 'players?filter=bogus')).status === 400);
    await adm('POST', `players/${B}/unmute`, {}, { stepup: true });

    // settings
    res = await adm('GET', 'settings');
    ok('f. settings: values + spec + the FLOORS the page must show (1 h proof-age floor)', res.json.values.chat_min_minutes === 60
      && res.json.spec.some((s) => s.key === 'chat_slow_seconds' && s.max === 3600) && res.json.floors.chat_min_proof_age === 3600, res.text);
    ok('f. settings save without step-up → 403', (await adm('POST', 'settings', { values: { chat_slow_seconds: 5 } })).status === 403);
    res = await adm('POST', 'settings', { values: { chat_slow_seconds: 5, chat_hold_links: 'false' } }, { stepup: true });
    ok('f. a QUOTED "false" for a bool → 400 field, and NOTHING written (not even the valid key)',
      res.status === 400 && res.json.field === 'chat_hold_links' && settings.get('chat_slow_seconds') === 0);
    ok('f. an unknown key → 400', (await adm('POST', 'settings', { values: { chat_everything: 1 } }, { stepup: true })).json.field === 'chat_everything');
    res = await adm('POST', 'settings', { values: { chat_slow_seconds: 5, chat_report_threshold: 3 } }, { stepup: true });
    ok('f. a valid save: only CHANGED keys reported, updated_by recorded', res.json.changed.join() === 'chat_slow_seconds'
      && res.json.meta.chat_slow_seconds.updated_by === 'alice');
    await adm('POST', 'settings', { values: { chat_slow_seconds: 0 } }, { stepup: true });
    res = await get('/play/api/rules');
    ok('f. /play/api/rules shows the LIVE settings (Part 6 #10), nothing per player',
      res.json.plays.minutes_per_play === 10 && res.json.chat.min_minutes === 60 && res.json.chat.min_proof_age_s === DAY && !FULL_ADDR_RE.test(res.text));

    // mod log
    res = await adm('GET', 'mod-log?limit=500');
    ok('f. mod-log limit > 200 → 400', res.status === 400);
    res = await adm('GET', 'mod-log?limit=200');
    const acts = res.json.actions.map((a) => a.action);
    ok('f. mod-log: every write above is there, with the admin\'s name', ['chat_delete', 'chat_approve', 'chat_restore', 'chat_operator_post', 'chat_words',
      'mute', 'unmute', 'ban', 'unban', 'purge', 'adjust', 'settings'].every((a) => acts.includes(a)) && res.json.actions.every((a) => a.actor === 'alice'), acts.join());
    ok('f. a refused write left no mod_actions row (no "adjust" for the 409)',
      one("SELECT COUNT(*) AS n FROM mod_actions WHERE action = 'adjust'").n === 1);

    // ── [g] moderators ──────────────────────────────────────────────────────────────────
    console.log('\n[g] moderators (D21)\n');
    const M = addr(40), M2 = addr(41);
    for (const a of [M, M2]) mine(a, 200);
    const cmIp = await login(M, 'ip');
    ok('g. a non-moderator → 403 not_moderator', (await get('/play/api/mod/queue', { cookie: cmIp })).json.error === 'not_moderator');
    ok('g. /me: moderator null for a player', (await get('/play/api/me', { cookie: cmIp })).json.moderator === null);
    ok('g. appoint without step-up → 403', (await adm('POST', `moderators/${M}`, { note: 'helper' })).status === 403);
    res = await adm('POST', `moderators/${M}`, { note: 'Helps with chat' }, { stepup: true });
    ok('g. appoint (step-up) → listed with added_by', res.json.moderators.some((m) => m.address === M && m.added_by === 'alice' && m.note === 'Helps with chat'));
    await adm('POST', `moderators/${M2}`, {}, { stepup: true });
    res = await get('/play/api/me', { cookie: cmIp });
    ok('g. an IP-proof moderator session → moderator {can_act:false, mod_password_required}',
      res.json.moderator && res.json.moderator.can_act === false && res.json.moderator.reason === 'mod_password_required', res.text);
    ok('g. …and its actions are refused (403 mod_refused)', (await get('/play/api/mod/queue', { cookie: cmIp })).json.error === 'mod_refused');
    const cm = await login(M, 'pw');
    ok('g. a PASSWORD-proof session can act', (await get('/play/api/me', { cookie: cm })).json.moderator.can_act === true);
    settings.set('mod_requires_password', false, 't');
    ok('g. with mod_requires_password off, the IP session can act too', (await get('/play/api/me', { cookie: cmIp })).json.moderator.can_act === true);
    settings.set('mod_requires_password', true, 't');
    const cm2 = await login(M2, 'pw');

    // the badge
    step();
    res = await say(cm, 'hi all, I help moderate');
    const modMsgId = res.json.message.id;
    ok('g. a moderator\'s message carries role "moderator" (computed, not sent)', res.json.message.role === 'moderator');
    ok('g. …in the public page too', (await get('/play/api/chat')).json.messages.some((m) => m.id === modMsgId && m.role === 'moderator'));

    // queue
    res = await get('/play/api/mod/queue', { cookie: cm });
    ok('g. the queue: held messages + reported ones, MASKED names only', res.status === 200 && res.json.held.some((m) => m.id === heldId && m.name === mask(A))
      && !FULL_ADDR_RE.test(res.text), res.text.slice(0, 300));
    // act
    step();
    const Pl = addr(50);
    mine(Pl, 100);
    const cPl = await login(Pl);
    const plMsg = (await say(cPl, 'buy my stuff')).json.message.id;
    page = await get('/play/api/chat');
    const mRev = page.json.rev;
    res = await post(`/play/api/mod/messages/${plMsg}/delete`, { reason: 'ad' }, { cookie: cm });
    ok('g. moderator deletes a player message', res.status === 200 && res.json.changed === true
      && one('SELECT deleted_by FROM chat_messages WHERE id = ?', plMsg).deleted_by === `mod:${M}`);
    res = await get(`/play/api/chat?after=${plMsg}&rev=${mRev}&epoch=${epoch}`);
    ok('g. …every open page is told', res.json.changes.removed.includes(plMsg));
    res = await post(`/play/api/mod/messages/${heldId}/approve`, {}, { cookie: cm });
    ok('g. moderator approves a held message', res.json.changed === true && one('SELECT state FROM chat_messages WHERE id = ?', heldId).state === 'visible');
    ok('g. moderator cannot delete an OPERATOR message', (await post(`/play/api/mod/messages/${opId}/delete`, {}, { cookie: cm })).json.reason === 'operator_message');
    ok('g. …nor another MODERATOR\'s message', (await post(`/play/api/mod/messages/${modMsgId}/delete`, {}, { cookie: cm2 })).json.reason === 'moderator_message');
    ok('g. …nor mute another moderator', (await post(`/play/api/mod/messages/${modMsgId}/mute`, { minutes: 5 }, { cookie: cm2 })).json.reason === 'moderator_message');
    ok('g. …nor mute themselves / approve their own message',
      (await post(`/play/api/mod/messages/${modMsgId}/mute`, { minutes: 5 }, { cookie: cm })).json.reason === 'own_message'
      && (await post(`/play/api/mod/messages/${modMsgId}/approve`, {}, { cookie: cm })).json.reason === 'own_message');
    ok('g. …but may delete their own message', (await post(`/play/api/mod/messages/${modMsgId}/delete`, {}, { cookie: cm })).json.changed === true);
    step();
    const plMsg2 = (await say(cPl, 'more spam')).json.message.id;
    ok('g. moderator mute > 24 h → 400 minutes', (await post(`/play/api/mod/messages/${plMsg2}/mute`, { minutes: 1441 }, { cookie: cm })).json.field === 'minutes');
    res = await post(`/play/api/mod/messages/${plMsg2}/mute`, { minutes: 30 }, { cookie: cm });
    ok('g. moderator mutes the AUTHOR of a message for 30 min', res.json.muted_until === nowS() + 1800
      && one('SELECT muted_until FROM players WHERE address = ?', Pl).muted_until === nowS() + 1800);
    await adm('POST', `players/${Pl}/mute`, { minutes: 3 * 1440 });
    res = await post(`/play/api/mod/messages/${plMsg2}/mute`, { minutes: 10 }, { cookie: cm });
    ok('g. a moderator can NOT shorten a longer mute (the operator\'s 3 days stays)', res.json.muted_until === nowS() + 3 * DAY);
    const modRows = db.raw.prepare("SELECT admin_user, action FROM mod_actions WHERE admin_user LIKE 'mod:%'").all();
    ok('g. moderator actions are logged as mod:<full address>', modRows.length >= 4 && modRows.every((r) => r.admin_user === `mod:${M}`), JSON.stringify(modRows));
    ok('g. a moderator cannot reach any /internal/admin route (no link secret)',
      (await request(port, { path: '/internal/admin/chat/messages', headers: { Cookie: cm } })).status === 401);
    // a muted moderator
    await adm('POST', `players/${M2}/mute`, { minutes: 10 });
    ok('g. a muted moderator cannot act', (await get('/play/api/mod/queue', { cookie: cm2 })).json.reason === 'muted');
    await adm('POST', `players/${M2}/unmute`, {}, { stepup: true });
    // removal + ban
    res = await adm('POST', `moderators/${M2}/remove`, {}, { stepup: true });
    ok('g. remove a moderator → takes effect on the next request', res.json.changed === true
      && (await get('/play/api/mod/queue', { cookie: cm2 })).json.error === 'not_moderator');
    res = await adm('POST', `players/${M}/ban`, { days: 1 }, { stepup: true });
    ok('g. banning a moderator also removes the appointment', res.json.moderator_removed === true && one('SELECT COUNT(*) AS n FROM moderators').n === 0);
    ok('g. appointing a banned address → 409 banned', (await adm('POST', `moderators/${M}`, {}, { stepup: true })).json.error === 'banned');
    await adm('POST', `players/${M}/unban`, {}, { stepup: true });
    ok('g. the moderator actions are in the operator\'s mod log', (await adm('GET', 'mod-log')).json.actions.some((a) => a.actor === `mod:${M}` && a.action === 'mute'));

    // ── [h] retention + invariants ──────────────────────────────────────────────────────
    console.log('\n[h] retention, invariants\n');
    const before = one('SELECT COUNT(*) AS n FROM chat_messages').n;
    const oldT = nowS() - 8 * DAY;
    const oldId = Number(sql("INSERT INTO chat_messages (room, role, address, body, state, created_at) VALUES ('global', 'player', ?, 'ancient', 'visible', ?)", A, oldT).lastInsertRowid);
    sql('INSERT INTO chat_reports (message_id, reporter, created_at) VALUES (?, ?, ?)', oldId, B, oldT);
    const removed = chat.purgeRetention();
    ok('h. retention: a message older than 7 days is hard-deleted with its reports', removed === 1
      && !one('SELECT 1 AS x FROM chat_messages WHERE id = ?', oldId) && !one('SELECT 1 AS x FROM chat_reports WHERE message_id = ?', oldId));
    ok('h. …and nothing newer', one('SELECT COUNT(*) AS n FROM chat_messages').n === before);
    settings.set('chat_retention_max', 100, 't');
    const ins = db.raw.prepare("INSERT INTO chat_messages (room, role, address, body, state, created_at) VALUES ('global', 'player', ?, ?, 'visible', ?)");
    db.transaction(() => { for (let i = 0; i < 150; i++) ins.run(C, `bulk ${i}`, nowS()); });
    chat.purgeRetention();
    ok('h. retention: the room keeps its newest chat_retention_max (100)', one("SELECT COUNT(*) AS n FROM chat_messages WHERE room = 'global'").n === 100
      && one("SELECT body FROM chat_messages ORDER BY id DESC LIMIT 1").body === 'bulk 149');

    const leaks = publicTexts.filter((t) => FULL_ADDR_RE.test(t.slice(t.indexOf(' ', 5))));
    ok(`h. no public response carries a full address (${publicTexts.length} checked)`, leaks.length === 0, leaks.slice(0, 2).join(' | ').slice(0, 300));
    const plan = (sqlText, ...args) => db.raw.prepare(`EXPLAIN QUERY PLAN ${sqlText}`).all(...args).map((r) => r.detail).join(' | ');
    const st = chat._internal.stmts;
    const checks = [
      ['latest page', st.latest, ['global', 100], /SEARCH chat_messages USING (COVERING )?INDEX idx_chat_room/],
      ['poll after id', st.after, ['global', 1, 100], /SEARCH chat_messages USING (COVERING )?INDEX idx_chat_room/],
      // Either index is a bounded range: the author's messages in retention, or the room's held ones.
      ['own held', st.ownHeld, [A, 1, 'global', 0, 100], /SEARCH chat_messages USING (COVERING )?INDEX idx_chat_(address|room)/],
      ['last post', st.lastPost, [A], /SEARCH chat_messages USING (COVERING )?INDEX idx_chat_address/],
      ['posts per hour', st.postsSince, [A, 1], /SEARCH chat_messages USING (COVERING )?INDEX idx_chat_address/],
      ['duplicate', st.dup, [A, 1, 'x'], /SEARCH chat_messages USING INDEX idx_chat_address/],
      ['open reports', st.openReports, [1], /SEARCH chat_reports USING (COVERING )?INDEX/],
    ];
    for (const [name, stmt, args, re] of checks) {
      const p = plan(stmt.sourceSQL, ...args);
      ok(`h. EXPLAIN ${name}: an index range read, no table scan`, re.test(p) && !/SCAN chat_messages\b(?! USING)/.test(p), p);
    }
    const pm = plan('SELECT COALESCE(SUM(seconds), 0) AS s FROM activity_daily WHERE address = ? AND day >= ?', A, '2026-10-01');
    ok('h. EXPLAIN recent-mining gate: activity_daily PK range', /SEARCH activity_daily USING (COVERING )?INDEX sqlite_autoindex_activity_daily_1/.test(pm), pm);
    const drift = ledger.verify();
    ok('h. the ledger balances (admin_adjust included)', drift.length === 0, JSON.stringify(drift));
  } finally {
    await new Promise((r) => srv.close(r));
    db.close();
  }

  console.log(`\nRESULT pass=${pass} fail=${fail}`);
  if (fail) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
