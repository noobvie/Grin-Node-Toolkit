'use strict';

// Part 12 (design §19.16): approved nicknames.
//
//   [a] units: the name rule (length, charset, homoglyphs, bidi, address-like, role words),
//       the matching form
//   [b] the player side: every gate (session, proof age, anchor, mining, mute, the switch,
//       mode off), submit / replace / unchanged / withdraw, the daily limit, /me
//   [c] the operator side: the queue + flags, step-up on every write, approve / reject /
//       remove, taken names (the check AND the unique index), the audit rows
//   [d] display: chat, the boards, the lobby and a match show `Nick (mask)` — never the
//       nickname alone, never before approval; the switch; a ban; self-removal
//   [e] retention, query plans, and the invariants over every public response
//
// Loopback server with a stubbed pool; the DB is in memory. Nothing is left running.
// Run: node scripts/test-names.js

const path = require('node:path');
const http = require('node:http');

const { openDb } = require('../lib/db.js');
const { createLogger } = require('../lib/log.js');
const { loadGames } = require('../lib/registry.js');
const { buildApp, createServer, listen } = require('../lib/app.js');
const { validateName, matchForm, NAME_MAX, SUBMITS_PER_DAY, KEEP_DECIDED_S } = require('../lib/names.js');
const { requiresStepUp } = require('../lib/admin.js');

let pass = 0, fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else      { fail++; console.error(`  FAIL  ${name}${extra ? ' — ' + extra : ''}`); }
}

const SERVER = path.join(__dirname, '..');
const GAMES = path.join(SERVER, '..', 'games');
const log = createLogger(() => {});
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
  console.log('\n[a] units: the name rule and the matching form\n');
  const v = (s) => validateName(s);
  ok('a. a plain name passes, whitespace collapsed + trimmed, case kept', v('  Big   Miner ').ok && v('  Big   Miner ').name === 'Big Miner');
  ok(`a. 2–${NAME_MAX} characters`, v('ab').ok && !v('a').ok && v('a'.repeat(NAME_MAX)).ok && v('a'.repeat(NAME_MAX + 1)).code === 'name_length');
  ok('a. - _ & \' and digits are allowed', v("Rig-01_A&B's").ok);
  ok('a. a dot is refused (no domain as a name beside chat)', v('free-grin.io').code === 'name_charset');
  ok('a. a Cyrillic homoglyph is refused, not folded', v('B' + cp(0x0430) + 'b').code === 'name_charset');
  ok('a. bidi override, zero-width, NBSP are refused', v('ab' + cp(0x202E) + 'c').code === 'name_charset'
    && v('ab' + cp(0x200B) + 'c').code === 'name_charset' && v('ab' + cp(0xA0) + 'c').code === 'name_charset');
  ok('a. <, >, ", / are refused (the charset, not an escape, is the control)', ['<b>', 'a"b', 'a/b'].every((s) => v(s).code === 'name_charset'));
  ok('a. at least one letter', v('1234').code === 'name_no_letter' && v('-_-').code === 'name_no_letter');
  ok('a. an address-like name is refused (grin1 / tgrin1, separators ignored)', v('grin1abc').code === 'name_address'
    && v('tGrin1 x').code === 'name_address' && v('g-r-i-n-1').code === 'name_address');
  ok('a. role words refused, leet + separators folded', ['Operator', '0per4tor', 'A d m i n', 'the_moderator'].every((s) => v(s).code === 'name_role'));
  ok('a. a non-string is refused', v(5).code === 'name_invalid' && v(null).code === 'name_invalid' && v(['ab']).code === 'name_invalid');
  ok('a. matchForm: lower-case, separators out, leet back', matchForm('N1-ck') === 'nick' && matchForm("B o_b's") === 'bobs');

  // ── setup ───────────────────────────────────────────────────────────────────────────
  let T = Date.UTC(2026, 9, 7, 12, 0, 0);
  const nowS = () => Math.floor(T / 1000);
  const SECRET = 'k'.repeat(20) + 'Q7'.repeat(22);
  const cfg = { net: 'mainnet', poolInternalUrl: 'http://127.0.0.1:9', linkSecretFile: '/nonexistent' };
  const db = openDb(':memory:', { net: 'mainnet', log });
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
  const { settings, ledger } = app.services;
  const srv = createServer(app.handler);
  const { port } = await listen(srv, 0, '127.0.0.1');
  const HOST = 'pool.example';
  const publicTexts = [];
  let ipN = 1;
  const nextIp = () => `198.51.100.${ipN++}`;
  const get = async (p, { cookie } = {}) => {
    const r = await request(port, { path: p, headers: { Host: HOST, 'X-Real-IP': '203.0.113.9', ...(cookie ? { Cookie: cookie } : {}) } });
    if (!p.startsWith('/play/api/me')) publicTexts.push(`GET ${p} ${r.text}`);
    return r;
  };
  const post = async (p, body, { cookie } = {}) => {
    const r = await request(port, { method: 'POST', path: p, body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json', Host: HOST, 'X-Real-IP': nextIp(), ...(cookie ? { Cookie: cookie } : {}) } });
    if (!p.startsWith('/play/api/login') && !p.startsWith('/play/api/nickname')) publicTexts.push(`POST ${p} ${r.text}`);
    return r;
  };
  async function login(address, proof = 'ip') {
    const res = await post('/play/api/login', { address, proof });
    const sc = res.headers['set-cookie'];
    return sc ? (Array.isArray(sc) ? sc[0] : sc).split(';')[0] : null;
  }
  function adm(method, rel, body, { stepup = true, user = 'alice' } = {}) {
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
  const nick = (cookie, name) => post('/play/api/nickname', { name }, { cookie });
  const me = async (cookie) => (await get('/play/api/me', { cookie })).json;
  const chatNames = async () => (await get('/play/api/chat')).json.messages.map((m) => m.name);

  const A = addr(1), B = addr(2), C = addr(3), D = addr(4), E = addr(5), F = addr(6);
  for (const x of [A, B, C, D, E, F]) mine(x, 120);

  try {
    // ── [b] the player side ─────────────────────────────────────────────────────────────
    console.log('\n[b] the player side\n');
    ok('b. no session → 401', (await nick(null, 'Alice')).status === 401);
    const ca = await login(A);
    let m = await me(ca);
    ok('b. /me carries nickname {enabled, live:null, pending:null, can_submit:true, shown_as: the mask}',
      m.nickname && m.nickname.enabled === true && m.nickname.live === null && m.nickname.pending === null
        && m.nickname.can_submit === true && m.nickname.shown_as === mask(A), JSON.stringify(m.nickname));
    let res = await nick(ca, 'free-grin.io');
    ok('b. a bad name → 400 with its code and the rule as a hint', res.status === 400 && res.json.error === 'name_charset' && /letters, digits/.test(res.json.hint), res.text);
    ok('b. an unknown body key → 400', (await post('/play/api/nickname', { name: 'Alice', role: 'operator' }, { cookie: ca })).json.field === 'body');

    const cFresh = await login(B, 'pw-fresh');
    res = await nick(cFresh, 'Bobby');
    ok('b. a fresh proof → 403 nickname_refused proof_too_new, with available_at',
      res.status === 403 && res.json.error === 'nickname_refused' && res.json.reason === 'proof_too_new' && res.json.available_at > nowS(), res.text);
    const cAnchor = await login(C, 'anchor');
    ok('b. an anchor proof → refused (anchor_proof)', (await nick(cAnchor, 'Carol')).json.reason === 'anchor_proof');
    const G = addr(7);                                   // never mined
    const cG = await login(G);
    ok('b. no recent mining → refused (no_recent_mining)', (await nick(cG, 'Gus')).json.reason === 'no_recent_mining');
    modeState.chat_enabled = false;
    ok('b. the pool\'s CHAT switch off does not block a nickname (they show on the boards too)', (await nick(ca, 'Alice')).status === 200);
    modeState.chat_enabled = true;
    m = await me(ca);
    ok('b. submitted → pending, shown to its author on /me, not live', m.nickname.pending && m.nickname.pending.name === 'Alice' && m.nickname.live === null);
    ok('b. …and the row is pending', one("SELECT state FROM nicknames WHERE address = ?", A).state === 'pending');
    ok('b. the same name again → 409 unchanged', (await nick(ca, 'Alice')).json.error === 'unchanged');
    res = await nick(ca, 'Alice2');
    ok('b. a new name REPLACES the pending one (one pending per address)', res.status === 200
      && one("SELECT COUNT(*) AS n FROM nicknames WHERE address = ? AND state = 'pending'", A).n === 1
      && one("SELECT state FROM nicknames WHERE address = ? AND name = 'Alice'", A).state === 'replaced');
    res = await post('/play/api/nickname/withdraw', {}, { cookie: ca });
    ok('b. withdraw → the pending one is withdrawn', res.json.changed === true && res.json.nickname.pending === null
      && one("SELECT state FROM nicknames WHERE name = 'Alice2'").state === 'withdrawn');
    ok('b. withdraw with nothing pending → 200 changed:false', (await post('/play/api/nickname/withdraw', {}, { cookie: ca })).json.changed === false);
    for (let i = 0; i < SUBMITS_PER_DAY - 2; i++) await nick(ca, `Alice x${i}`);
    res = await nick(ca, 'Alice last');
    ok(`b. ${SUBMITS_PER_DAY} submissions a day, then 429 (counted in the DB: a restart does not reset it)`, res.status === 429, res.text);
    T += DAY * 1000 + 1000;
    for (const x of [A, B, C, D, E, F]) mine(x, 120);
    res = await nick(ca, 'Alice');
    ok('b. …a day later it submits again', res.status === 200, res.text);

    const cd = await login(D);
    sql('UPDATE players SET muted_until = ? WHERE address = ?', nowS() + 3600, D);
    ok('b. a muted player cannot submit (muted)', (await nick(cd, 'Dora')).json.reason === 'muted');
    sql('UPDATE players SET muted_until = NULL WHERE address = ?', D);

    settings.set('nicknames_enabled', false);
    ok('b. the nicknames switch off → 403 nicknames_off', (await nick(cd, 'Dora')).json.error === 'nicknames_off');
    ok('b. …and /me says so', (await me(cd)).nickname.enabled === false && (await me(cd)).nickname.reason === 'nicknames_off');
    settings.set('nicknames_enabled', true);
    modeState.mode = 'off';
    ok('b. games mode off → 404', (await nick(cd, 'Dora')).status === 404);
    modeState.mode = 'preview';

    // ── [c] the operator side ───────────────────────────────────────────────────────────
    console.log('\n[c] the operator side\n');
    // Chat so there is something to display, BEFORE any approval.
    await post('/play/api/chat', { body: 'hello from A' }, { cookie: ca });
    T += 6000;
    ok('d. BEFORE approval, chat shows the bare mask (pre-moderated)', (await chatNames()).every((n) => n === mask(A)));

    res = await adm('GET', 'nicknames', undefined, { stepup: false });
    ok('c. GET nicknames (no step-up for a read) → the pending queue, oldest first, full addresses',
      res.status === 200 && res.json.state === 'pending' && res.json.nicknames.length === 1 && res.json.nicknames[0].address === A
        && res.json.nicknames[0].name === 'Alice' && Array.isArray(res.json.nicknames[0].flags) && res.json.counts.pending === 1, res.text);
    const idA = res.json.nicknames[0].id;
    ok('c. the queue row says how it will show: `Alice (mask)`', res.json.nicknames[0].shown_as === `Alice (${mask(A)})`);
    ok('c. every write is STEP-UP (none is in FAST_WRITES), games side',
      ['nicknames/1/approve', 'nicknames/1/reject', 'nicknames/1/remove'].every((p) => requiresStepUp('POST', p)));
    // The POOL (the enforcer) agreeing is checked on the pool side, in back-end-pool
    // scripts/test-admin-panel.js [15] — this service may not load pool code (D5).
    ok('c. approve without step-up → 403 step_up_required', (await adm('POST', `nicknames/${idA}/approve`, {}, { stepup: false })).json.error === 'step_up_required');
    res = await adm('POST', `nicknames/${idA}/approve`, {});
    ok('c. approve → approved', res.status === 200 && res.json.nickname.state === 'approved' && res.json.nickname.decided_by === 'alice', res.text);
    ok('c. …one mod_actions row, by the admin', one("SELECT COUNT(*) AS n FROM mod_actions WHERE action = 'nickname_approve' AND admin_user = 'alice' AND target = ?", A).n === 1);
    ok('c. approve again → 409 not_pending', (await adm('POST', `nicknames/${idA}/approve`, {})).json.error === 'not_pending');
    ok('c. an unknown id → 404; a non-integer id → 404', (await adm('POST', 'nicknames/99999/approve', {})).status === 404
      && (await adm('POST', 'nicknames/1e3/approve', {})).status === 404);

    // Taken names: B asks for A's name in another spelling.
    const cb = await login(B);          // an old proof this time
    res = await nick(cb, 'ALICE');
    ok('c. a name matching another LIVE nickname → 409 nickname_taken at submit', res.status === 409 && res.json.error === 'nickname_taken', res.text);
    res = await nick(cb, '4lice');
    ok('c. …leet spellings match too (4lice = alice)', res.json.error === 'nickname_taken');
    // Two pending look-alikes: flagged, and only the first approval wins.
    await nick(cb, 'Rover');
    const ce = await login(E);
    await nick(ce, 'R0ver');
    res = await adm('GET', 'nicknames', undefined, { stepup: false });
    const rowB = res.json.nicknames.find((r) => r.address === B);
    const rowE = res.json.nicknames.find((r) => r.address === E);
    ok('c. look-alike pendings are flagged pending_same on both', rowB.flags.some((f) => f.type === 'pending_same' && f.addresses.includes(E))
      && rowE.flags.some((f) => f.type === 'pending_same' && f.addresses.includes(B)));
    await adm('POST', `nicknames/${rowB.id}/approve`, {});
    res = await adm('POST', `nicknames/${rowE.id}/approve`, {});
    ok('c. approving the second look-alike → 409 nickname_taken', res.status === 409 && res.json.error === 'nickname_taken', res.text);
    ok('c. …and the database itself refuses two live look-alikes (uq_nick_norm)', (() => {
      try { sql("UPDATE nicknames SET state = 'approved' WHERE id = ?", rowE.id); return false; } catch (e) { return /UNIQUE/i.test(e.message); }
    })());
    res = await adm('POST', `nicknames/${rowE.id}/reject`, { reason: 'Too close to another player\'s name' });
    ok('c. reject with a reason → rejected', res.json.nickname.state === 'rejected' && res.json.nickname.reason === 'Too close to another player\'s name');
    m = await me(ce);
    ok('c. …the player sees the refusal and its reason on /me', m.nickname.refused && m.nickname.refused.state === 'rejected'
      && m.nickname.refused.reason === 'Too close to another player\'s name' && m.nickname.refused.name === 'R0ver');
    ok('c. a reason that is not text → 400 field reason', (await adm('POST', `nicknames/${rowE.id}/reject`, { reason: 5 })).json.field === 'reason');

    // Flags: reserved words and the chat word list.
    await adm('POST', 'chat/words', { add: ['scam'] });
    const cf = await login(F);
    await nick(cf, 'Pool Scam Bob');
    res = await adm('GET', 'nicknames', undefined, { stepup: false });
    const rowF = res.json.nicknames.find((r) => r.address === F);
    ok('c. flags: a reserved word (pool) and a chat word-list hit (scam)', rowF.flags.some((f) => f.type === 'reserved' && f.word === 'pool')
      && rowF.flags.some((f) => f.type === 'word' && f.word === 'scam'), JSON.stringify(rowF.flags));
    ok('c. GET nicknames?state=approved lists the live ones, newest first', (await adm('GET', 'nicknames?state=approved', undefined, { stepup: false })).json.nicknames.map((r) => r.address).join() === [B, A].join());
    ok('c. a bad state / extra param → 400', (await adm('GET', 'nicknames?state=deleted', undefined, { stepup: false })).status === 400
      && (await adm('GET', 'nicknames?x=1', undefined, { stepup: false })).status === 400);
    res = await adm('GET', `players/${A}`, undefined, { stepup: false });
    ok('c. the Players view carries the nickname (live + pending)', res.json.nickname && res.json.nickname.live && res.json.nickname.live.name === 'Alice' && res.json.nickname.pending === null);

    // ── [d] display ─────────────────────────────────────────────────────────────────────
    console.log('\n[d] display\n');
    const NICK_A = `Alice (${mask(A)})`;
    ok('d. chat: the approved name shows as `Alice (mask)` — on old messages too', (await chatNames()).every((n) => n === NICK_A), JSON.stringify(await chatNames()));
    ok('d. /me shown_as says the same', (await me(ca)).nickname.shown_as === NICK_A && (await me(ca)).nickname.live === 'Alice');
    ledger.credit(A, 'points', 50, 'admin_adjust', null);
    ledger.credit(B, 'points', 20, 'admin_adjust', null);
    res = await get('/play/api/leaderboard?board=points');
    ok('d. the points board shows `Nick (mask)` for both named players', res.json.rows.some((r) => r.name === NICK_A)
      && res.json.rows.some((r) => r.name === `Rover (${mask(B)})`), res.text);
    ledger.credit(A, 'plays', 5, 'mining_minutes', 'w:test-a');
    res = await post('/play/api/matches', { game_id: 'chess', mode: 'pvp', colour: 'seat1' }, { cookie: ca });
    ok('d. (a PvP seek to look at)', res.status === 200, res.text);
    const seekId = res.json.match && res.json.match.id;
    res = await get('/play/api/lobby');
    ok('d. the lobby shows the seek as `Alice (mask)`', res.json.seeks.some((s) => s.id === seekId && s.name === NICK_A), res.text);
    res = await get(`/play/api/matches/${seekId}`);
    ok('d. a match view labels the seat `Alice (mask)`', res.json.match && res.json.match.labels['1'] === NICK_A, res.text);

    settings.set('nicknames_enabled', false);
    ok('d. the switch off → every surface shows the bare mask again', (await chatNames()).every((n) => n === mask(A))
      && (await get('/play/api/leaderboard?board=points')).json.rows.every((r) => !/\(/.test(r.name)));
    settings.set('nicknames_enabled', true);
    ok('d. …and on → the names come back (nothing was deleted)', (await chatNames()).every((n) => n === NICK_A));

    res = await adm('POST', `nicknames/${rowB.id}/remove`, { reason: 'Please pick another' });
    ok('d. admin remove → removed, the board shows B\'s mask again', res.json.nickname.state === 'removed'
      && (await get('/play/api/leaderboard?board=points')).json.rows.some((r) => r.name === mask(B)));
    ok('d. …B sees why', (await me(cb)).nickname.refused.state === 'removed' && (await me(cb)).nickname.refused.reason === 'Please pick another');
    ok('d. remove on a non-live row → 409 not_live', (await adm('POST', `nicknames/${rowB.id}/remove`, {})).json.error === 'not_live');

    // A ban ends the nickname and refuses a pending one; an unban does not restore it.
    const cf2 = cf;
    ok('d. (F has a pending name)', one("SELECT COUNT(*) AS n FROM nicknames WHERE address = ? AND state = 'pending'", F).n === 1);
    res = await adm('POST', `players/${A}/ban`, { days: 1 });
    ok('d. a ban removes the live nickname (in the ban\'s own transaction, named in its audit row)', res.status === 200
      && one("SELECT state FROM nicknames WHERE id = ?", idA).state === 'removed'
      && JSON.parse(one("SELECT details_json FROM mod_actions WHERE action = 'ban' AND target = ?", A).details_json).nickname_removed === 'Alice');
    await adm('POST', `players/${F}/ban`, { days: 1 });
    ok('d. a ban refuses a pending one', one("SELECT state, reason FROM nicknames WHERE address = ? ORDER BY id DESC LIMIT 1", F).state === 'rejected');
    await adm('POST', `players/${A}/unban`, {});
    ok('d. an unban does not bring the nickname back', (await chatNames()).every((n) => n === mask(A)));
    void cf2;

    // Self-removal.
    const cb2 = await login(B);
    await nick(cb2, 'Rex');
    const idRex = one("SELECT id FROM nicknames WHERE address = ? AND state = 'pending'", B).id;
    await adm('POST', `nicknames/${idRex}/approve`, {});
    ok('d. (B is Rex now)', (await get('/play/api/leaderboard?board=points')).json.rows.some((r) => r.name === `Rex (${mask(B)})`));
    res = await post('/play/api/nickname/remove', {}, { cookie: cb2 });
    ok('d. the player removes their own → mask again, and it is not shown as a refusal',
      res.json.changed === true && res.json.nickname.live === null && res.json.nickname.refused === null
        && (await get('/play/api/leaderboard?board=points')).json.rows.some((r) => r.name === mask(B)));

    // ── [e] retention, plans, invariants ────────────────────────────────────────────────
    console.log('\n[e] retention, plans, invariants\n');
    const cA2 = await login(A);
    await nick(cA2, 'Alicia');
    const idAlicia = one("SELECT id FROM nicknames WHERE address = ? AND state = 'pending'", A).id;
    await adm('POST', `nicknames/${idAlicia}/approve`, {});
    const liveBefore = one("SELECT COUNT(*) AS n FROM nicknames WHERE state IN ('approved','pending')").n;
    const decidedBefore = one("SELECT COUNT(*) AS n FROM nicknames WHERE state NOT IN ('approved','pending')").n;
    ok('e. the purge keeps everything younger than 180 days', app.services.names.purge() === 0);
    T += (KEEP_DECIDED_S + DAY) * 1000;
    const purged = app.services.names.purge();
    ok('e. past 180 days the decided rows go, live + pending stay', purged === decidedBefore
      && one("SELECT COUNT(*) AS n FROM nicknames").n === liveBefore, `purged=${purged} decided=${decidedBefore}`);
    ok('e. …and a live name still shows after the purge', app.services.names.label(A) === `Alicia (${mask(A)})`);

    const plan = (s) => db.raw.prepare(`EXPLAIN QUERY PLAN ${s}`).all().map((r) => r.detail).join(' | ');
    const plans = [
      plan("SELECT address FROM nicknames WHERE norm = 'x' AND state = 'approved' AND address != 'y'"),
      plan("SELECT address FROM nicknames WHERE norm = 'x' AND state = 'pending' AND address != 'y' LIMIT 5"),
      plan("SELECT COUNT(*) AS n FROM nicknames WHERE address = 'x' AND submitted_at > 1"),
      plan("SELECT id FROM nicknames WHERE address = 'x' AND state = 'approved'"),
      plan("SELECT id FROM nicknames WHERE state = 'pending' ORDER BY id ASC LIMIT 200"),
    ];
    ok('e. every nickname read is an index SEARCH, never a table SCAN', plans.every((p) => /SEARCH/.test(p) && !/SCAN nicknames\b/.test(p)), plans.join(' || '));

    // The two invariants, over every public response this suite collected.
    const all = publicTexts.join('\n');
    ok('e. no public response carries a full address', !FULL_ADDR_RE.test(all), (all.match(FULL_ADDR_RE) || [])[0]);
    const names = ['Alice', 'Rover', 'Rex', 'Alicia'];
    const bare = [];
    for (const n of names) {
      const re = new RegExp(`"${n}[^"]*"`, 'g');
      for (const hit of all.match(re) || []) if (!/ \(t?grin1[^)]*…[^)]{4}\)"$/.test(hit)) bare.push(hit);
    }
    ok('e. no public response carries a nickname WITHOUT its mask', bare.length === 0, bare.slice(0, 3).join(' '));
    ok('e. no public response carries a pending or rejected name', !/Pool Scam Bob|R0ver|Alice2/.test(all));
    ok('e. the ledger balances', ledger.verify().length === 0);
  } finally {
    srv.close();
    db.close();
  }

  console.log(`\nRESULT pass=${pass} fail=${fail}`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); console.log(`\nRESULT pass=${pass} fail=${fail + 1}`); process.exit(1); });
