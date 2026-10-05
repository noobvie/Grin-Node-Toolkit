'use strict';

// Nicknames v2 (design §19.17.5, Part C3; Part 12's §19.16 for the display rule).
//
//   [a] the rule: every case of the SHARED fixture (scripts/fixtures/name-rule.json — the pool's
//       copy runs the same file, §19.13 #24), the innocent and adversarial lists (#25), entry
//       parsing and its * / = overrides
//   [b] the player side: every gate, live at once, the cooldown, the generic refusals, the
//       refused-attempt cap, self-removal
//   [c] the operator side: lists + search, step-up on every write, remove, ban name (every
//       spelling, the holder), unban, block / unblock, the hint on a live row, the audit rows
//   [d] the pool's half of the lists: applied, persisted, kept across a rebuild, the config
//       route parsed (a real loopback "pool")
//   [e] moderators: remove a message author's name; never the operator's, another moderator's,
//       or their own
//   [f] display + uniqueness: `Nick (mask)` everywhere, never the nickname alone; two submits for
//       one name; the unique index; a ban
//   [g] retention, query plans, and the invariants over every public response
//
// Loopback servers with a stubbed pool; the DB is in memory. Nothing is left running.
// Run: node scripts/test-names.js

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const { openDb } = require('../lib/db.js');
const { createLogger } = require('../lib/log.js');
const { loadGames } = require('../lib/registry.js');
const { buildApp, createServer, listen } = require('../lib/app.js');
const { REFUSED_PER_DAY, KEEP_DECIDED_S, POOL_LISTS_KEY } = require('../lib/names.js');
const R = require('../lib/name-rule.js');
const { createPoolLink } = require('../lib/pool-link.js');
const { requiresStepUp } = require('../lib/admin.js');

let pass = 0, fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else      { fail++; console.error(`  FAIL  ${name}${extra ? ' — ' + extra : ''}`); }
}

const SERVER = path.join(__dirname, '..');
const GAMES = path.join(SERVER, '..', 'games');
const FIXTURE = path.join(__dirname, 'fixtures', 'name-rule.json');
const log = createLogger(() => {});
const DAY = 86400;
const FULL_ADDR_RE = /t?grin1[ac-hj-np-z02-9]{58}/;

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
  // ── [a] the rule ────────────────────────────────────────────────────────────────────
  console.log('\n[a] the rule: the shared fixture, Scunthorpe, entry parsing\n');
  const F = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  const ctxOf = (c = {}, shape) => ({ shape, poolName: c.pool_name, blocked: R.compileList(c.blocked), words: R.compileList(c.words) });
  const caseFails = [];
  for (const k of F.cases) {
    const r = R.check(k.name, ctxOf(F.contexts[k.ctx || 'default'], k.shape));
    const got = r.ok ? 'ok' : r.code;
    if (got !== k.expect || (k.list && r.list !== k.list)) caseFails.push(`${JSON.stringify(k.name)} → ${got}/${r.list} (want ${k.expect}/${k.list || '-'})`);
  }
  ok(`a. every fixture case (${F.cases.length}) gives its expected verdict`, F.cases.length >= 60 && caseFails.length === 0, caseFails.slice(0, 4).join('; '));
  const innocentFails = F.innocent.filter((n) => !R.check(n, ctxOf(F.contexts.default)).ok);
  ok(`a. every innocent name (${F.innocent.length}) passes — incl. Modern, Pooler, Abbott, Bottle, Classic, Bassist, Cassandra, Badminton, Scunthorpe, Staffy`,
    ['Modern', 'Pooler', 'Abbott', 'Bottle', 'Classic', 'Bassist', 'Cassandra', 'Badminton', 'Scunthorpe', 'Staffy'].every((n) => F.innocent.includes(n))
      && innocentFails.length === 0, innocentFails.join(', '));
  const advFails = F.adversarial.filter((n) => R.check(n, ctxOf(F.contexts.default)).ok);
  ok(`a. every adversarial name (${F.adversarial.length}) is refused`, F.adversarial.length >= 30 && advFails.length === 0, advFails.join(', '));
  // The pool's donor shape (Part C4): never used by the games, but this copy is the same code.
  const donorCtx = ctxOf(F.contexts.donor, 'donor');
  const dInnocent = F.donor_innocent.filter((n) => !R.check(n, donorCtx).ok);
  ok(`a. every donor-shape innocent name (${F.donor_innocent.length}) passes`, F.donor_innocent.length >= 20 && dInnocent.length === 0, dInnocent.join(', '));
  const dAdv = F.donor_adversarial.filter((n) => R.check(n, donorCtx).ok);
  ok(`a. every donor-shape adversarial name (${F.donor_adversarial.length}) is refused`, F.donor_adversarial.length >= 20 && dAdv.length === 0, dAdv.join(', '));
  ok('a. an unknown shape throws (never a silent fallback)', (() => { try { R.check('Alice', { shape: 'donr' }); return false; } catch (_) { return true; } })());
  ok('a. matchForm: lower-case, separators out, leet back', R.matchForm('N1-ck') === 'nick' && R.matchForm("B o_b's") === 'bobs' && R.matchForm('0per4tor') === 'operator');
  ok('a. wholeForms: digits stripped at the ends, AND the unstripped fold', JSON.stringify(R.wholeForms('Mod1')) === '["mod","modi"]' && R.wholeForms('A55').includes('ass'));
  ok('a. parseEntry: ≤ 4 chars → whole, ≥ 5 → substring', R.parseEntry('moon').whole === true && R.parseEntry('rugpull').whole === false);
  ok('a. parseEntry: * forces substring, = forces whole, the entry is folded', R.parseEntry('*cr4p').whole === false && R.parseEntry('*cr4p').norm === 'crap'
    && R.parseEntry('=scammer').whole === true);
  ok('a. parseEntry: an entry that cannot match an ASCII name is dropped', R.parseEntry('café') === null && R.parseEntry('') === null && R.parseEntry('*') === null
    && R.parseEntry('x'.repeat(41)) === null && R.parseEntry(5) === null);
  ok('a. compileList drops duplicates (same mode + form)', R.compileList(['moon', 'MOON', 'm00n', '*moon']).length === 2);
  ok('a. a pool name folding to < 3 characters is not reserved', R.poolNameEntry('GP') === null && R.poolNameEntry('Zap').whole === true);
  ok('a. the seed holds every word of the pool\'s starter list, and forces two to substring',
    R.SEED.includes('*fuck') && R.SEED.includes('*jizz') && R.SEED.includes('ass') && R.SEED.length >= 50);
  ok('a. a reserved / blocked refusal names its list for the admin', (() => {
    const r = R.check('Admin', ctxOf(F.contexts.default));
    return r.code === 'name_reserved' && r.list === 'reserved' && r.entry === 'admin';
  })());

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
  const registry = loadGames({ gamesDir: GAMES, log });
  const app = buildApp({ config: cfg, db, log, clock: () => T, poolLink: fakeLink, mode: fakeMode, registry });
  const { settings, ledger, names } = app.services;
  const srv = createServer(app.handler);
  const { port } = await listen(srv, 0, '127.0.0.1');
  let poolSrv = null;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'names-'));
  const HOST = 'pool.example';
  const publicTexts = [];
  let ipN = 1;
  const nextIp = () => `198.51.100.${ipN++ % 250}`;
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
  const nextDay = () => { T = (Math.floor(T / 86400000) + 1) * 86400000 + 12 * 3600 * 1000; };

  const P = Array.from({ length: 14 }, (_, i) => addr(i + 1));
  const [A, B, C, D, E, F2, G, H, I, J, K, M, M2, N] = P;
  for (const x of P) mine(x, 120);

  try {
    // ── [b] the player side ─────────────────────────────────────────────────────────────
    console.log('\n[b] the player side\n');
    ok('b. no session → 401', (await nick(null, 'Alice')).status === 401);
    const ca = await login(A);
    let m = await me(ca);
    ok('b. /me nickname: {enabled, live:null, shown_as: the mask, can_submit, can_remove:false, rule, change_days:7}',
      m.nickname && m.nickname.enabled === true && m.nickname.live === null && m.nickname.can_submit === true
        && m.nickname.can_remove === false && m.nickname.shown_as === mask(A) && m.nickname.rule === R.NAME_RULE
        && m.nickname.change_days === 7 && !('pending' in m.nickname), JSON.stringify(m.nickname));
    let res = await nick(ca, 'Big Miner');
    ok('b. a shape refusal → 400 with its code and the rule as a hint', res.status === 400 && res.json.error === 'name_charset' && /letters A–Z and digits/.test(res.json.hint), res.text);
    ok('b. too short → 400 name_length', (await nick(ca, 'Al')).json.error === 'name_length');
    res = await nick(ca, 'grin1abc');
    ok('b. address-like → 400 name_address, explained', res.status === 400 && res.json.error === 'name_address' && /address/.test(res.json.hint));
    ok('b. an unknown body key → 400', (await post('/play/api/nickname', { name: 'Alice', role: 'operator' }, { cookie: ca })).json.field === 'body');

    const cFresh = await login(B, 'pw-fresh');
    res = await nick(cFresh, 'Bobby');
    ok('b. a fresh proof → 403 nickname_refused proof_too_new, with available_at',
      res.status === 403 && res.json.error === 'nickname_refused' && res.json.reason === 'proof_too_new' && res.json.available_at > nowS(), res.text);
    const cAnchor = await login(C, 'anchor');
    ok('b. an anchor proof → refused (anchor_proof)', (await nick(cAnchor, 'Carol')).json.reason === 'anchor_proof');
    const X = addr(77);                                   // never mined
    ok('b. no recent mining → refused (no_recent_mining)', (await nick(await login(X), 'Gus')).json.reason === 'no_recent_mining');

    modeState.chat_enabled = false;
    res = await nick(ca, 'Alice');
    ok('b. the pool\'s CHAT switch off does not block a nickname, and it is LIVE AT ONCE', res.status === 200
      && res.json.nickname.live === 'Alice' && res.json.nickname.shown_as === `Alice (${mask(A)})`, res.text);
    modeState.chat_enabled = true;
    ok('b. …one approved row, decided by self, and the change time stamped',
      one("SELECT state, decided_by FROM nicknames WHERE address = ?", A).state === 'approved'
        && one("SELECT decided_by FROM nicknames WHERE address = ?", A).decided_by === 'self'
        && one('SELECT nick_changed_at AS t FROM players WHERE address = ?', A).t === nowS());
    m = await me(ca);
    ok('b. …and now the cooldown applies: can_submit false, reason cooldown, available_at = +7 days',
      m.nickname.can_submit === false && m.nickname.reason === 'cooldown' && m.nickname.available_at === nowS() + 7 * DAY && m.nickname.can_remove === true);
    res = await nick(ca, 'Alicia');
    ok('b. a change inside the cooldown → 403 nickname_refused cooldown', res.status === 403 && res.json.reason === 'cooldown' && res.json.available_at === nowS() + 7 * DAY, res.text);
    ok('b. the same name again inside the cooldown → still the gate first (403)', (await nick(ca, 'Alice')).status === 403);
    settings.set('nickname_change_days', 0);
    ok('b. the same name again → 409 unchanged', (await nick(ca, 'Alice')).json.error === 'unchanged');
    res = await nick(ca, 'ALICE');
    ok('b. a case change of your own name is a change (no one else holds that form)', res.status === 200 && res.json.nickname.live === 'ALICE', res.text);
    ok('b. …the old row is replaced (one live per address)', one("SELECT COUNT(*) AS n FROM nicknames WHERE address = ? AND state = 'approved'", A).n === 1
      && one("SELECT state FROM nicknames WHERE address = ? AND name = 'Alice'", A).state === 'replaced');
    await nick(ca, 'Alice');

    // The generic refusals: a word hit says only "not allowed", and never which word.
    const reservedRes = await nick(ca, 'PoolAdmin');
    ok('b. a reserved word → 400 name_not_allowed, no hint, no list, no word', reservedRes.status === 400 && reservedRes.json.error === 'name_not_allowed'
      && !('hint' in reservedRes.json) && !/admin|reserved|list|seed/i.test(JSON.stringify(reservedRes.json).replace('name_not_allowed', '')), reservedRes.text);
    res = await nick(ca, 'FuckThis');
    ok('b. a seed word → the same answer, byte for byte', res.status === 400 && res.text === reservedRes.text, res.text);
    await adm('POST', 'chat/words', { add: ['airdrop'] });
    ok('b. a chat word-list entry applies to names too', (await nick(ca, 'AirdropKing')).json.error === 'name_not_allowed');

    // Refused attempts are capped, so the lists cannot be probed. Shape refusals do not count.
    const cd = await login(D);
    for (let i = 0; i < 3; i++) await nick(cd, 'x');                       // shape: not counted
    for (let i = 0; i < REFUSED_PER_DAY; i++) await nick(cd, `Admin${i}`);  // each counted
    ok(`b. ${REFUSED_PER_DAY} refused attempts are counted on the players row (shape refusals are not)`,
      one('SELECT nick_refused_n AS n, nick_refused_day AS d FROM players WHERE address = ?', D).n === REFUSED_PER_DAY
        && one('SELECT nick_refused_day AS d FROM players WHERE address = ?', D).d === utcDay(nowS()));
    res = await nick(cd, 'Dora');
    ok('b. …then 429 too_many_refusals — even for a good name — until the next UTC day', res.status === 429 && res.json.error === 'too_many_refusals'
      && Number(res.headers['retry-after']) > 0 && Number(res.headers['retry-after']) <= DAY, res.text);
    ok('b. …and a refused name is never stored', one("SELECT COUNT(*) AS n FROM nicknames WHERE address = ?", D).n === 0
      && one("SELECT COUNT(*) AS n FROM mod_actions WHERE details_json LIKE '%Admin1%'").n === 0);
    nextDay();
    for (const x of P) mine(x, 120);
    ok('b. …the next UTC day it works again', (await nick(cd, 'Dora')).status === 200);
    settings.set('nickname_change_days', 7);

    // Taken.
    const cb = await login(B);          // an old proof this time
    res = await nick(cb, '4lice');
    ok('b. a name reading as another player\'s live one (4lice = alice) → 409 name_unavailable', res.status === 409 && res.json.error === 'name_unavailable', res.text);
    ok('b. …which counts as a refused attempt', one('SELECT nick_refused_n AS n FROM players WHERE address = ?', B).n === 1);

    const cm = await login(E);
    sql('UPDATE players SET muted_until = ? WHERE address = ?', nowS() + 3600, E);
    ok('b. a muted player cannot set a name (muted)', (await nick(cm, 'Erin')).json.reason === 'muted');
    sql('UPDATE players SET muted_until = NULL WHERE address = ?', E);

    settings.set('nicknames_enabled', false);
    ok('b. the nicknames switch off → 403 nicknames_off', (await nick(cm, 'Erin')).json.error === 'nicknames_off');
    ok('b. …and /me says so', (await me(cm)).nickname.enabled === false && (await me(cm)).nickname.reason === 'nicknames_off');
    settings.set('nicknames_enabled', true);
    modeState.mode = 'off';
    ok('b. games mode off → 404', (await nick(cm, 'Erin')).status === 404);
    modeState.mode = 'preview';

    // Self-removal: always allowed (even muted), and not a refusal.
    sql('UPDATE players SET muted_until = ? WHERE address = ?', nowS() + 3600, D);
    res = await post('/play/api/nickname/remove', {}, { cookie: cd });
    ok('b. removing your own name works even while muted, and is not shown as a refusal',
      res.json.changed === true && res.json.nickname.live === null && res.json.nickname.refused === null, res.text);
    sql('UPDATE players SET muted_until = NULL WHERE address = ?', D);
    ok('b. …removal does not reset the cooldown', (await nick(cd, 'Dorothy')).json.reason === 'cooldown');
    ok('b. remove with no live name → 200 changed:false', (await post('/play/api/nickname/remove', {}, { cookie: cd })).json.changed === false);
    ok('b. the old withdraw route is gone (404)', (await post('/play/api/nickname/withdraw', {}, { cookie: cd })).status === 404);

    // ── [c] the operator side ───────────────────────────────────────────────────────────
    console.log('\n[c] the operator side\n');
    const cf = await login(F2);
    await nick(cf, 'Rover');
    const cg = await login(G);
    await nick(cg, 'Sparky');
    res = await adm('GET', 'nicknames', undefined, { stepup: false });
    ok('c. GET nicknames (no step-up for a read) → the live list, newest first, full addresses, counts',
      res.status === 200 && res.json.state === 'live' && res.json.nicknames[0].address === G && res.json.nicknames[0].name === 'Sparky'
        && res.json.counts.live === 3 && typeof res.json.counts.banned === 'number' && typeof res.json.counts.blocked === 'number', res.text);
    ok('c. a live row says how it shows, and has no rule hit', res.json.nicknames[0].shown_as === `Sparky (${mask(G)})` && res.json.nicknames[0].hit === null);
    res = await adm('GET', 'nicknames?q=R0V', undefined, { stepup: false });
    ok('c. search by name folds case + leet (R0V finds Rover)', res.json.nicknames.length === 1 && res.json.nicknames[0].address === F2, res.text);
    res = await adm('GET', `nicknames?q=${G.slice(0, 14)}`, undefined, { stepup: false });
    ok('c. search by an address prefix', res.json.nicknames.length === 1 && res.json.nicknames[0].address === G);
    ok('c. search text with % or _ is literal, not a wildcard', (await adm('GET', 'nicknames?q=%25', undefined, { stepup: false })).json.nicknames.length === 0
      && (await adm('GET', 'nicknames?q=a_', undefined, { stepup: false })).json.nicknames.every((r) => /a/i.test(r.name)));
    ok('c. a bad state / extra param / over-long q → 400', (await adm('GET', 'nicknames?state=pending', undefined, { stepup: false })).status === 400
      && (await adm('GET', 'nicknames?x=1', undefined, { stepup: false })).status === 400
      && (await adm('GET', `nicknames?q=${'a'.repeat(65)}`, undefined, { stepup: false })).status === 400);
    const writes = ['nicknames/1/remove', 'banned-names', 'banned-names/abc/unban', `players/${A}/nick-block`, `players/${A}/nick-unblock`];
    ok('c. every write is STEP-UP (none is in FAST_WRITES), games side', writes.every((p) => requiresStepUp('POST', p)));
    // The POOL (the enforcer) agreeing is checked in back-end-pool scripts/test-admin-panel.js [15].
    const idRover = one("SELECT id FROM nicknames WHERE address = ? AND state = 'approved'", F2).id;
    ok('c. remove without step-up → 403 step_up_required', (await adm('POST', `nicknames/${idRover}/remove`, {}, { stepup: false })).json.error === 'step_up_required');
    res = await adm('POST', `nicknames/${idRover}/remove`, { reason: 'Please pick another' });
    ok('c. remove → removed, audited', res.status === 200 && res.json.nickname.state === 'removed'
      && one("SELECT COUNT(*) AS n FROM mod_actions WHERE action = 'nickname_remove' AND admin_user = 'alice' AND target = ?", F2).n === 1, res.text);
    m = await me(cf);
    ok('c. …the owner sees it, the reason, and that the POOL did it', m.nickname.refused && m.nickname.refused.name === 'Rover'
      && m.nickname.refused.reason === 'Please pick another' && m.nickname.refused.by === 'pool' && m.nickname.live === null);
    ok('c. remove on a non-live row → 409 not_live; unknown id → 404', (await adm('POST', `nicknames/${idRover}/remove`, {})).json.error === 'not_live'
      && (await adm('POST', 'nicknames/99999/remove', {})).status === 404 && (await adm('POST', 'nicknames/1e3/remove', {})).status === 404);
    ok('c. GET nicknames?state=removed lists it', (await adm('GET', 'nicknames?state=removed', undefined, { stepup: false })).json.nicknames.some((r) => r.id === idRover));

    // Ban a name: its holder loses it, and no spelling of it can be taken again.
    res = await adm('POST', 'banned-names', { name: 'Sparky', reason: 'Impersonates a known scammer' });
    ok('c. ban name → banned, the holder\'s live name removed in the same call', res.status === 200 && res.json.changed === true
      && res.json.removed && res.json.removed.address === G && res.json.banned.some((b) => b.norm === 'sparky' && b.banned_by === 'alice'), res.text);
    ok('c. …audited once, with the removed holder', JSON.parse(one("SELECT details_json FROM mod_actions WHERE action = 'nickname_ban_name' AND target = 'sparky'").details_json).removed.address === G);
    ok('c. …the holder sees the reason', (await me(cg)).nickname.refused.reason === 'Impersonates a known scammer');
    settings.set('nickname_change_days', 0);
    const ch = await login(H);
    const spellings = ['Sparky', 'SPARKY', 'Sp4rky', '5parky'];
    const sp = [];
    for (const s of spellings) sp.push((await nick(ch, s)).json.error);
    ok('c. …every spelling with that matching form → 409 name_unavailable (the SAME answer as taken)', sp.every((e) => e === 'name_unavailable'), sp.join());
    ok('c. ban again → 200 changed:false (idempotent)', (await adm('POST', 'banned-names', { name: 'sp4rky' })).json.changed === false);
    ok('c. a name that cannot be a matching form → 400 field name', (await adm('POST', 'banned-names', { name: '!!' })).json.field === 'name'
      && (await adm('POST', 'banned-names', { name: 5 })).json.field === 'name' && (await adm('POST', 'banned-names', {})).json.field === 'name');
    ok('c. GET banned-names lists it (no step-up for a read)', (await adm('GET', 'banned-names', undefined, { stepup: false })).json.banned.some((b) => b.norm === 'sparky'));
    res = await adm('POST', 'banned-names/sparky/unban', {});
    ok('c. unban → deleted, audited; nothing is restored', res.json.changed === true && !res.json.banned.some((b) => b.norm === 'sparky')
      && one("SELECT COUNT(*) AS n FROM mod_actions WHERE action = 'nickname_unban_name'").n === 1
      && one("SELECT COUNT(*) AS n FROM nicknames WHERE address = ? AND state = 'approved'", G).n === 0);
    ok('c. …the name can be taken again', (await nick(ch, 'Sparky')).status === 200);
    ok('c. unban of an unknown / malformed form → 200 changed:false / 404', (await adm('POST', 'banned-names/nobody/unban', {})).json.changed === false
      && (await adm('POST', 'banned-names/NOT-A-FORM/unban', {})).status === 404);

    // Block a player from nicknames.
    res = await adm('POST', `players/${H}/nick-block`, { reason: 'Repeated abuse' });
    ok('c. block player → blocked, their live name removed, audited', res.status === 200 && res.json.changed === true && res.json.removed === 'Sparky'
      && res.json.nickname.blocked === true && one("SELECT COUNT(*) AS n FROM mod_actions WHERE action = 'nickname_block' AND target = ?", H).n === 1, res.text);
    res = await nick(ch, 'Henry');
    ok('c. …a blocked player cannot set a name (403 nick_blocked) and /me says so', res.json.reason === 'nick_blocked' && (await me(ch)).nickname.reason === 'nick_blocked');
    ok('c. GET nick-blocked lists them', (await adm('GET', 'nick-blocked', undefined, { stepup: false })).json.blocked.some((b) => b.address === H));
    ok('c. block again → changed:false; a bad address → 400', (await adm('POST', `players/${H}/nick-block`, {})).json.changed === false
      && (await adm('POST', 'players/grin1nope/nick-block', {})).json.field === 'address'
      && (await adm('POST', `players/${addr(1, 'tgrin1')}/nick-block`, {})).json.field === 'address');
    res = await adm('POST', `players/${H}/nick-unblock`, {});
    ok('c. unblock → can set a name again', res.json.changed === true && res.json.nickname.blocked === false && (await nick(ch, 'Henry')).status === 200);
    ok('c. block an address that never played → the player row is created and blocked', (await adm('POST', `players/${addr(200)}/nick-block`, {})).json.nickname.blocked === true);
    res = await adm('GET', `players/${A}`, undefined, { stepup: false });
    ok('c. the Players view carries {live, blocked, changed_at}', res.json.nickname && res.json.nickname.live && res.json.nickname.live.name === 'Alice'
      && res.json.nickname.blocked === false && typeof res.json.nickname.changed_at === 'number', JSON.stringify(res.json.nickname));

    // ── [d] the pool's half of the lists ─────────────────────────────────────────────────
    console.log('\n[d] the pool\'s half of the lists\n');
    ok('d. no pool answer yet → no pool list, the seed still applies', names.poolLists().blocked.length === 0 && (await nick(ch, 'Shit')).json.error === 'name_not_allowed');
    ok('d. a config answer without the name fields (a pool before C3) changes nothing', names.updatePoolLists({ mode: 'on', chat_enabled: true }) === false);
    ok('d. a config answer with them is applied', names.updatePoolLists({ blocked_words: ['=henry', '*whale', 'moon'], pool_name: 'Night Owl Mining' }) === true);
    ok('d. …the same answer again is a no-op', names.updatePoolLists({ blocked_words: ['=henry', '*whale', 'moon'], pool_name: 'Night Owl Mining' }) === false);
    const ci = await login(I);
    ok('d. …a pool blocked word refuses a name (generic answer)', (await nick(ci, 'BigWhale')).json.error === 'name_not_allowed');
    ok('d. …the pool name is reserved', (await nick(ci, 'NightOwlMining')).json.error === 'name_not_allowed');
    res = await adm('GET', 'nicknames?q=henry', undefined, { stepup: false });
    ok('d. …a live name the new list hits is HINTED to the admin (not removed by itself)', res.json.nicknames[0].hit
      && res.json.nicknames[0].hit.list === 'operator' && res.json.nicknames[0].hit.entry === '=henry'
      && one("SELECT state FROM nicknames WHERE address = ? AND name = 'Henry'", H).state === 'approved', JSON.stringify(res.json.nicknames[0]));
    const stored = JSON.parse(one('SELECT value FROM settings WHERE key = ?', POOL_LISTS_KEY).value);
    ok('d. …persisted in the settings table', stored.pool_name === 'Night Owl Mining' && stored.blocked.join() === '=henry,*whale,moon');
    ok('d. …which the settings reader ignores (not a SPEC key)', !('pool_name_lists' in settings.all()));
    const app2 = buildApp({ config: cfg, db, log, clock: () => T, poolLink: fakeLink, mode: fakeMode, registry });
    ok('d. a rebuilt app (a restart with the pool down) keeps the last list', app2.services.names.poolLists().blocked.join() === '=henry,*whale,moon');
    ok('d. malformed entries are dropped, a malformed list is ignored', names.updatePoolLists({ blocked_words: ['ok', 'BAD CASE', '', 7, '**x'] }) === true
      && names.poolLists().blocked.join() === 'ok' && names.updatePoolLists({ blocked_words: Array(501).fill('x') }) === true
      && names.poolLists().blocked.length === 0);
    names.updatePoolLists({ blocked_words: ['*whale'], pool_name: 'Night Owl Mining' });

    // The config route parsed by the real pool-link client, against a loopback "pool".
    const secFile = path.join(tmpDir, 'link');
    fs.writeFileSync(secFile, SECRET);
    let answer = null;
    poolSrv = http.createServer((req, rs) => { rs.setHeader('Content-Type', 'application/json'); rs.end(JSON.stringify(answer)); });
    await new Promise((r) => poolSrv.listen(0, '127.0.0.1', r));
    const link = createPoolLink({ config: { net: 'mainnet', poolInternalUrl: `http://127.0.0.1:${poolSrv.address().port}`, linkSecretFile: secFile } });
    answer = { ok: true, mode: 'on', chat_enabled: true, net: 'mainnet', blocked_words: ['*whale', 'Bad', 'moon', 9], pool_name: 'Night Owl' };
    let c = await link.config();
    ok('d. pool-link config(): the name fields are passed on, bad entries dropped', c.mode === 'on' && c.blocked_words.join() === '*whale,moon' && c.pool_name === 'Night Owl');
    answer = { ok: true, mode: 'on', chat_enabled: true, net: 'mainnet' };
    c = await link.config();
    ok('d. …a pool without them: the fields are absent (keep the last copy), the mode still reads', c.mode === 'on' && !('blocked_words' in c) && !('pool_name' in c));
    answer = { ok: true, mode: 'on', chat_enabled: true, net: 'mainnet', blocked_words: 'moon', pool_name: 'x'.repeat(65) };
    c = await link.config();
    ok('d. …malformed fields are dropped, never fatal to the mode fetch', c.mode === 'on' && !('blocked_words' in c) && !('pool_name' in c));

    // ── [e] moderators ──────────────────────────────────────────────────────────────────
    console.log('\n[e] moderators\n');
    const cj = await login(J);
    await nick(cj, 'Jasper');
    await post('/play/api/chat', { body: 'hello from J' }, { cookie: cj });
    T += 6000;
    await adm('POST', `moderators/${M}`, { note: 'helper' });
    await adm('POST', `moderators/${M2}`, {});
    const cmod = await login(M, 'pw');
    const cmod2 = await login(M2, 'pw');
    await nick(cmod, 'Marvin');
    await nick(cmod2, 'Mabel');
    await post('/play/api/chat', { body: 'mod one here' }, { cookie: cmod });
    T += 6000;
    await post('/play/api/chat', { body: 'mod two here' }, { cookie: cmod2 });
    T += 6000;
    await adm('POST', 'chat/post', { body: 'Operator here' });
    T += 1000;
    const msgs = (await get('/play/api/chat')).json.messages;
    const idOf = (body) => (msgs.find((x) => x.body === body) || {}).id;
    const modName = (cookie, id, body = {}) => post(`/play/api/mod/messages/${id}/remove-name`, body, { cookie });
    ok('e. a non-moderator → 403 not_moderator', (await modName(cj, idOf('mod one here'))).json.error === 'not_moderator');
    res = await modName(cmod, idOf('hello from J'), { reason: 'Not a nice name' });
    ok('e. a moderator removes a message author\'s name', res.status === 200 && res.json.changed === true
      && one("SELECT state, decided_by FROM nicknames WHERE address = ? AND name = 'Jasper'", J).decided_by === `mod:${M}`, res.text);
    ok('e. …one mod_actions row as mod:<address>', one("SELECT COUNT(*) AS n FROM mod_actions WHERE admin_user = ? AND action = 'nickname_remove' AND target = ?", `mod:${M}`, J).n === 1);
    m = await me(cj);
    ok('e. …the owner sees a MODERATOR did it, and why', m.nickname.refused.by === 'moderator' && m.nickname.refused.reason === 'Not a nice name');
    ok('e. …again → 200 changed:false (no live name), no second row', (await modName(cmod, idOf('hello from J'))).json.changed === false
      && one("SELECT COUNT(*) AS n FROM mod_actions WHERE action = 'nickname_remove' AND admin_user = ?", `mod:${M}`).n === 1);
    ok('e. refused on another moderator\'s name', (await modName(cmod, idOf('mod two here'))).json.reason === 'moderator_message');
    ok('e. refused on their own name', (await modName(cmod, idOf('mod one here'))).json.reason === 'own_message');
    ok('e. refused on the operator', (await modName(cmod, idOf('Operator here'))).json.reason === 'operator_message');
    ok('e. an unknown message → 404; an unknown body key → 400', (await modName(cmod, 999999)).status === 404
      && (await modName(cmod, idOf('hello from J'), { reason: 'x', ban: true })).json.field === 'body');
    ok('e. a moderator has no name ban and no block (the admin routes need the link secret)',
      (await post('/internal/admin/banned-names', { name: 'x' }, { cookie: cmod })).status === 404);

    // ── [f] display + uniqueness ────────────────────────────────────────────────────────
    console.log('\n[f] display + uniqueness\n');
    const NICK_A = `Alice (${mask(A)})`;
    await post('/play/api/chat', { body: 'hello from A' }, { cookie: ca });
    T += 6000;
    ok('f. chat: a live name shows as `Alice (mask)` at once', (await chatNames()).some((n) => n === NICK_A), JSON.stringify(await chatNames()));
    ledger.credit(A, 'points', 50, 'admin_adjust', null);
    res = await get('/play/api/leaderboard?board=points');
    ok('f. the points board shows `Nick (mask)`', res.json.rows.some((r) => r.name === NICK_A), res.text);
    ledger.credit(A, 'plays', 5, 'mining_minutes', 'w:test-a');
    res = await post('/play/api/matches', { game_id: 'chess', mode: 'pvp', colour: 'seat1' }, { cookie: ca });
    const seekId = res.json.match && res.json.match.id;
    ok('f. the lobby and a match view show `Alice (mask)`', (await get('/play/api/lobby')).json.seeks.some((s) => s.id === seekId && s.name === NICK_A)
      && (await get(`/play/api/matches/${seekId}`)).json.match.labels['1'] === NICK_A);
    settings.set('nicknames_enabled', false);
    ok('f. the switch off → the bare mask everywhere', (await chatNames()).every((n) => !/\(/.test(n))
      && (await get('/play/api/leaderboard?board=points')).json.rows.every((r) => !/\(/.test(r.name)));
    settings.set('nicknames_enabled', true);
    ok('f. …and on → the names come back (nothing was deleted)', (await chatNames()).some((n) => n === NICK_A));

    // Two players asking for the same new name at once: exactly one gets it.
    const ck = await login(K);
    const cn = await login(N);
    const both = await Promise.all([nick(ck, 'Zephyr'), nick(cn, 'ZEPHYR')]);
    ok('f. two submits for one matching form at once → exactly one 200, one 409 name_unavailable',
      both.filter((r) => r.status === 200).length === 1 && both.filter((r) => r.json.error === 'name_unavailable').length === 1, both.map((r) => r.text).join(' | '));
    ok('f. …and the database itself refuses two live look-alikes (uq_nick_norm), not only the check', (() => {
      try { sql("INSERT INTO nicknames (address, name, norm, state, submitted_at) VALUES (?, 'zephyr', 'zephyr', 'approved', 1)", addr(300)); return false; }
      catch (e) { return /UNIQUE|FOREIGN/i.test(e.message); }
    })());
    ok('f. …uniqueness covers banned forms too: a ban of a LIVE form removes it, then nobody holds it', (() => true)()
      && (await adm('POST', 'banned-names', { name: 'z3phyr' })).json.removed !== null
      && one("SELECT COUNT(*) AS n FROM nicknames WHERE norm = 'zephyr' AND state = 'approved'").n === 0);

    // A ban ends the nickname; an unban does not restore it.
    res = await adm('POST', `players/${A}/ban`, { days: 1 });
    ok('f. a player ban removes the live nickname (named in its audit row)', res.status === 200
      && one("SELECT COUNT(*) AS n FROM nicknames WHERE address = ? AND state = 'approved'", A).n === 0
      && JSON.parse(one("SELECT details_json FROM mod_actions WHERE action = 'ban' AND target = ?", A).details_json).nickname_removed === 'Alice');
    await adm('POST', `players/${A}/unban`, {});
    ok('f. an unban does not bring it back', names.label(A) === mask(A));

    // ── [g] retention, plans, invariants ────────────────────────────────────────────────
    console.log('\n[g] retention, plans, invariants\n');
    const liveBefore = one("SELECT COUNT(*) AS n FROM nicknames WHERE state = 'approved'").n;
    const decidedBefore = one("SELECT COUNT(*) AS n FROM nicknames WHERE state != 'approved'").n;
    ok('g. the purge keeps everything younger than 180 days', names.purge() === 0);
    T += (KEEP_DECIDED_S + DAY) * 1000;
    const purged = names.purge();
    ok('g. past 180 days the decided rows go, live rows stay', purged === decidedBefore
      && one("SELECT COUNT(*) AS n FROM nicknames").n === liveBefore, `purged=${purged} decided=${decidedBefore}`);
    ok('g. …and a live name still shows after the purge', names.label(H) === `Henry (${mask(H)})`);

    const plan = (s) => db.raw.prepare(`EXPLAIN QUERY PLAN ${s}`).all().map((r) => r.detail).join(' | ');
    const plans = [
      plan("SELECT address FROM nicknames WHERE norm = 'x' AND state = 'approved' AND address != 'y'"),
      plan("SELECT id FROM nicknames WHERE norm = 'x' AND state = 'approved'"),
      plan("SELECT id FROM nicknames WHERE address = 'x' AND state = 'approved'"),
      plan("SELECT id FROM nicknames WHERE address = 'x' ORDER BY id DESC LIMIT 1"),
      plan("SELECT id FROM nicknames WHERE state = 'approved' ORDER BY id DESC LIMIT 200"),
      plan("SELECT id FROM nicknames WHERE state = 'approved' AND norm LIKE '%x%' ESCAPE '\\' ORDER BY id DESC LIMIT 200"),
      plan("SELECT address FROM players WHERE nick_blocked = 1 ORDER BY address LIMIT 200"),
      plan("SELECT 1 FROM banned_names WHERE norm = 'x'"),
    ];
    ok('g. every names read is an index SEARCH, never a table SCAN', plans.every((p) => /SEARCH/.test(p) && !/SCAN (nicknames|players|banned_names)\b/.test(p)), plans.join(' || '));

    // A guest in the scan (Part C5, §19.13 #29): planted directly (sign-up's PoW is test-guests'
    // business), aged past the chat gate, named, posting — its id must reach no public response,
    // its nickname only as `Nick · guest`.
    const GW = 'g:wandawandawandaw';
    const tG = nowS() - 2 * DAY;
    sql("INSERT INTO players (address, first_seen, last_seen, kind) VALUES (?, ?, ?, 'guest')", GW, tG, tG);
    sql("INSERT INTO guests (id, login_name, login_norm, pass_hash, created_at, last_login_at) VALUES (?, 'Wilhelmina', 'wilhelmina', 'v1$x$y', ?, ?)", GW, tG, tG);
    names.setSignupName(GW, 'Wanda', 'wanda', tG);
    names.invalidate();
    const gTok = app.services.sessions.create(GW, { method: 'guest', slot: 'set', created_at: tG }, { ip: '203.0.113.9' }).token;
    T += 60 * 1000;
    const gPost = await post('/play/api/chat', { body: 'hello from a guest' }, { cookie: `grin_play=${gTok}` });
    ok('g. (a guest posts, for the scan)', gPost.status === 200, gPost.text);
    await get('/play/api/chat');
    await get('/play/api/leaderboard?board=points');
    const allG = publicTexts.join('\n');
    ok('g. no public response carries a guest id', !/g:[a-z2-7]{16}/.test(allG));
    ok('g. a guest nickname appears only as `Nick · guest`, and never its login name',
      /"Wanda · guest"/.test(allG) && (allG.match(/"Wanda[^"]*"/g) || []).every((h) => h === '"Wanda · guest"') && !allG.includes('Wilhelmina'));

    const all = publicTexts.join('\n');
    ok('g. no public response carries a full address', !FULL_ADDR_RE.test(all), (all.match(FULL_ADDR_RE) || [])[0]);
    const shown = ['Alice', 'Jasper', 'Marvin', 'Mabel', 'Henry', 'Zephyr', 'ZEPHYR'];
    const bare = [];
    for (const n of shown) {
      const re = new RegExp(`"${n}[^"]*"`, 'g');
      for (const hit of all.match(re) || []) if (!/ \(t?grin1[^)]*…[^)]{4}\)"$/.test(hit)) bare.push(hit);
    }
    ok('g. no public response carries a nickname WITHOUT its mask', bare.length === 0, bare.slice(0, 3).join(' '));
    ok('g. no public response carries a refused name', !/PoolAdmin|FuckThis|AirdropKing|BigWhale/.test(all));
    ok('g. the ledger balances', ledger.verify().length === 0);
  } finally {
    srv.close();
    if (poolSrv) poolSrv.close();
    db.close();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  }

  console.log(`\nRESULT pass=${pass} fail=${fail}`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); console.log(`\nRESULT pass=${pass} fail=${fail + 1}`); process.exit(1); });
