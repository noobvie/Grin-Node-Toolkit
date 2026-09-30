'use strict';

// Part 7 (design §19.9, §19.11, D15, D17, D19): leaderboards, events, the admin API.
//
//   [a] units: UTC periods, ranking, kind rule validation
//   [b] leaderboards over HTTP: boards, periods, tie-breaks, masking, own rank, cache, params
//   [c] /internal/admin guard: forwarding headers, the link secret, the admin user, step-up,
//       the FAST list identical to the pool's, mod_actions, works while games are off
//   [d] events: validation, lifecycle, finalise exactly once, rewards + badges idempotent,
//       cancel pays nothing, finalise-now, banned + min_games, public views
//   [e] invariants: no public response carries a full address; every board/kind read is an
//       indexed rollup read (never matches or ledger); the ledger balances
//
// Loopback server with a stubbed pool; the DB is in memory; temp files under os.tmpdir(),
// removed at the end. Nothing is left running.
// Run: node scripts/test-events.js

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const { openDb } = require('../lib/db.js');
const { createLogger } = require('../lib/log.js');
const { loadGames } = require('../lib/registry.js');
const { buildApp, createServer, listen } = require('../lib/app.js');
const { createPoolLink } = require('../lib/pool-link.js');
const { periodRange, rank } = require('../lib/leaderboard.js');
const { FAST_WRITES } = require('../lib/admin.js');
const { loadKinds } = require('../lib/events.js');
const { RulesError } = require('../lib/events/_rules.js');

let pass = 0, fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else      { fail++; console.error(`  FAIL  ${name}${extra ? ' — ' + extra : ''}`); }
}

const SERVER = path.join(__dirname, '..');
const GAMES = path.join(SERVER, '..', 'games');
const POOL_LINK_SRC = path.join(SERVER, '..', '..', 'back-end-pool', 'lib', 'games-link.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'grin-games-events-'));
const lines = [];
const log = createLogger((level, line) => lines.push(`${level} ${line}`));
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
  // ── [a] units ───────────────────────────────────────────────────────────────────────
  console.log('\n[a] units: periods, ranking, kind rules\n');
  const wed = Date.UTC(2026, 9, 7, 12, 0, 0) / 1000;     // Wednesday 2026-10-07
  const pr = (p, t) => JSON.stringify(periodRange(p, t));
  ok('a. day = the current UTC day', pr('day', wed) === '{"from":"2026-10-07","to":"2026-10-07"}');
  ok('a. week = ISO Monday–Sunday', pr('week', wed) === '{"from":"2026-10-05","to":"2026-10-11"}');
  ok('a. week on a Sunday is still that week', pr('week', Date.UTC(2026, 9, 11, 23, 59) / 1000) === '{"from":"2026-10-05","to":"2026-10-11"}');
  ok('a. week on a Monday starts that day', pr('week', Date.UTC(2026, 9, 12, 0, 0) / 1000) === '{"from":"2026-10-12","to":"2026-10-18"}');
  ok('a. week across a year boundary', pr('week', Date.UTC(2027, 0, 1, 5) / 1000) === '{"from":"2026-12-28","to":"2027-01-03"}');
  ok('a. month = the calendar month', pr('month', wed) === '{"from":"2026-10-01","to":"2026-10-31"}'
    && pr('month', Date.UTC(2028, 1, 10) / 1000) === '{"from":"2028-02-01","to":"2028-02-29"}');
  ok('a. all = no range', periodRange('all', wed) === null);

  const X = addr(101), Y = addr(102), Z = addr(103);
  const [lo, hi] = [X, Y].sort();
  const r1 = rank([{ address: hi, value: 5 }, { address: Z, value: 9 }, { address: lo, value: 5 }, { address: X + 'q', value: 0 }]);
  ok('a. rank: value DESC, then address ASC; a zero is not ranked',
    r1.map((r) => r.address).join() === [Z, lo, hi].join() && r1.map((r) => r.rank).join() === '1,2,3');
  const r2 = rank([{ address: lo, value: 7, games: 3 }, { address: hi, value: 7, games: 9 }], { byGames: true });
  ok('a. rank (rating): equal value → more games first', r2[0].address === hi);
  ok('a. rank is deterministic whatever the input order', JSON.stringify(rank([{ address: hi, value: 5 }, { address: lo, value: 5 }]))
    === JSON.stringify(rank([{ address: lo, value: 5 }, { address: hi, value: 5 }])));
  ok('a. rank refuses NaN / Infinity / fractional values', rank([{ address: X, value: NaN }, { address: Y, value: Infinity }, { address: Z, value: 1.5 }]).length === 0);

  const reg = loadGames({ gamesDir: GAMES, log });
  const kinds = loadKinds();
  ok('a. the three v1 kinds are loaded', [...kinds.keys()].sort().join() === 'active_days,game_results,mining_minutes');
  const rulesErr = (kind, rules) => { try { kinds.get(kind).validate(rules, { registry: reg }); return null; } catch (e) { return e instanceof RulesError ? e.field : 'other'; } };
  ok('a. game_results: valid rules normalise (min_games default 1)',
    JSON.stringify(kinds.get('game_results').validate({ game_id: 'chess', mode: 'bot', metric: 'wins' }, { registry: reg }))
      === '{"game_id":"chess","mode":"bot","metric":"wins","min_games":1}');
  ok('a. game_results: unknown game / mode / metric / key refused',
    rulesErr('game_results', { game_id: 'nope', mode: 'bot', metric: 'wins' }) === 'game_id'
    && rulesErr('game_results', { game_id: 'chess', mode: 'team', metric: 'wins' }) === 'mode'
    && rulesErr('game_results', { game_id: 'chess', mode: 'bot', metric: 'score' }) === 'metric'
    && rulesErr('game_results', { game_id: 'chess', mode: 'bot', metric: 'wins', min_game: 2 }) === 'min_game');
  ok('a. a quoted number is refused, not coerced', rulesErr('game_results', { game_id: 'chess', mode: 'bot', metric: 'wins', min_games: '3' }) === 'min_games');
  ok('a. active_days: default min_minutes 10, bounds enforced',
    kinds.get('active_days').validate({}, {}).min_minutes === 10 && rulesErr('active_days', { min_minutes: 0 }) === 'min_minutes'
    && rulesErr('active_days', { min_minutes: 1441 }) === 'min_minutes');
  ok('a. mining_minutes takes no rules at all', rulesErr('mining_minutes', { x: 1 }) === 'x' && rulesErr('mining_minutes', []) === 'rules');

  // ── setup ───────────────────────────────────────────────────────────────────────────
  let T = Date.UTC(2026, 9, 7, 12, 0, 0);          // ms — Wednesday 2026-10-07 12:00 UTC
  const nowS = () => Math.floor(T / 1000);
  const D0 = Date.UTC(2026, 9, 7) / 1000;
  const SECRET = 'k'.repeat(20) + 'Q7'.repeat(22);  // 64 chars
  const linkFile = path.join(TMP, 'link');
  fs.writeFileSync(linkFile, SECRET + '\n');
  const cfg = { net: 'mainnet', poolInternalUrl: 'http://127.0.0.1:9', linkSecretFile: linkFile };
  const realLink = createPoolLink({ config: cfg, clock: () => T });
  const db = openDb(':memory:', { net: 'mainnet', log });
  const fakeLink = {
    secretConfigured: () => true,
    checkSecret: realLink.checkSecret,
    async verifyProof() { return { ok: true, method: 'ip', slot: 'set', age_seconds: null }; },
    async activity() { return { rows: [], dropped: 0 }; },
    async config() { return { mode: 'preview', chat_enabled: false }; },
  };
  const modeState = { mode: 'preview', chat_enabled: false };
  const fakeMode = { get: () => modeState, isOff: () => modeState.mode === 'off', start() {}, stop() {} };
  const app = buildApp({ config: cfg, db, log, clock: () => T, poolLink: fakeLink, mode: fakeMode, registry: reg });
  const { ledger, events } = app.services;
  const srv = createServer(app.handler);
  const { port } = await listen(srv, 0, '127.0.0.1');
  const HOST = 'pool.example';
  const publicTexts = [];                            // every public response, for [e]
  const get = async (p, { cookie } = {}) => {
    const r = await request(port, { path: p, headers: { Host: HOST, 'X-Real-IP': '203.0.113.9', ...(cookie ? { Cookie: cookie } : {}) } });
    if (!p.startsWith('/play/api/me')) publicTexts.push(`${p} ${r.text}`);
    return r;
  };
  let ipN = 1;
  async function login(address) {
    const res = await request(port, { method: 'POST', path: '/play/api/login', body: JSON.stringify({ address, proof: 'ip-ok' }),
      headers: { 'Content-Type': 'application/json', Host: HOST, 'X-Real-IP': `198.51.100.${ipN++}` } });
    const sc = res.headers['set-cookie'];
    return (Array.isArray(sc) ? sc[0] : sc).split(';')[0];
  }
  function adm(method, rel, body, { stepup = false, user = 'alice', secret = SECRET, headers = {}, rawBody } = {}) {
    const h = { ...headers };
    if (secret !== null) h['X-Games-Link'] = secret;
    if (user !== null) h['X-Admin-User'] = user;
    h['X-Admin-Stepup'] = stepup ? '1' : '0';
    let payload;
    if (rawBody !== undefined) { payload = rawBody; h['Content-Type'] = 'application/json'; }
    else if (body !== undefined) { payload = JSON.stringify(body); h['Content-Type'] = 'application/json'; }
    return request(port, { method, path: `/internal/admin/${rel}`, headers: h, body: payload });
  }
  const sql = (s, ...a) => db.raw.prepare(s).run(...a);
  const all = (s, ...a) => db.raw.prepare(s).all(...a);
  const one = (s, ...a) => db.raw.prepare(s).get(...a);
  const modActions = () => one('SELECT COUNT(*) AS n FROM mod_actions').n;
  const player = (a) => { ledger.ensurePlayer(a); return one('SELECT plays, points, badges_json, banned_until FROM players WHERE address = ?', a); };

  const A = addr(1), B = addr(2), C = addr(3), Dd = addr(4), E = addr(5), F = addr(6), G = addr(7);

  // ── [b] leaderboards ────────────────────────────────────────────────────────────────
  console.log('\n[b] leaderboards over a loopback server\n');
  let wref = 0;
  const givePoints = (a, n) => ledger.credit(a, 'points', n, 'admin_adjust', `t:${++wref}`);
  givePoints(A, 50); givePoints(B, 50); givePoints(C, 10); player(Dd); givePoints(E, 100);
  sql('UPDATE players SET banned_until = ? WHERE address = ?', 253402300799, E);   // forever: the clock moves days ahead below
  const [ab1, ab2] = [A, B].sort();

  let res = await get('/play/api/leaderboard');
  ok('b. default board = points held, all time', res.status === 200 && res.json.board === 'points' && res.json.game === null && res.json.period === 'all');
  ok('b. points: 50/50 tie ordered by full address, then 10; 0 and banned not ranked',
    res.json.rows.map((r) => r.name).join() === [mask(ab1), mask(ab2), mask(C)].join() && res.json.rows.map((r) => r.rank).join() === '1,2,3'
    && res.json.total === 3, JSON.stringify(res.json.rows));
  ok('b. names are the pool mask (9 + … + 4), no full address anywhere', res.json.rows.every((r) => /^grin1[a-z0-9]{4}…[a-z0-9]{4}$/.test(r.name)) && !FULL_ADDR_RE.test(res.text));
  ok('b. signed out → you = null, no row is flagged own', res.json.you === null && res.json.rows.every((r) => !('own' in r)));
  const ca = await login(A);
  res = await get('/play/api/leaderboard?board=points', { cookie: ca });
  const ownRow = res.json.rows.find((r) => r.own);
  ok('b. signed in → own row flagged and you.rank given, still no full address',
    ownRow && ownRow.name === mask(A) && res.json.you.rank === ownRow.rank && !FULL_ADDR_RE.test(res.text));

  // results_daily: today, earlier this week, last month.
  const rd = (a, mode, day, wins, games, points) => sql(
    'INSERT INTO results_daily (address, game_id, mode, day, games, wins, draws, losses, points) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)',
    a, 'chess', mode, day, games, wins, games - wins, points);
  rd(A, 'bot', '2026-10-07', 3, 5, 6); rd(B, 'bot', '2026-10-07', 3, 4, 9);
  rd(C, 'bot', '2026-10-05', 5, 5, 5); rd(F, 'bot', '2026-09-15', 9, 9, 18); rd(G, 'bot', '2026-10-07', 0, 4, 0);
  rd(Dd, 'pvp', '2026-10-07', 7, 7, 70);
  const names = (r) => r.json.rows.map((x) => x.name).join();
  res = await get('/play/api/leaderboard?board=wins&game=chess&mode=bot&period=day');
  ok('b. wins/day: the A/B tie by address; a 0-win player is not ranked', names(res) === [mask(ab1), mask(ab2)].join() && res.json.from === '2026-10-07', res.text);
  res = await get('/play/api/leaderboard?board=wins&game=chess&mode=bot&period=week');
  ok('b. wins/week adds Monday\'s results', names(res) === [mask(C), mask(ab1), mask(ab2)].join() && res.json.from === '2026-10-05' && res.json.to === '2026-10-11');
  res = await get('/play/api/leaderboard?board=wins&game=chess&mode=bot&period=month');
  ok('b. wins/month = the week here, last month excluded', names(res) === [mask(C), mask(ab1), mask(ab2)].join());
  res = await get('/play/api/leaderboard?board=wins&game=chess&mode=bot&period=all');
  ok('b. wins/all includes last month; games reported per row', res.json.rows[0].name === mask(F) && res.json.rows[0].games === 9 && res.json.rows.length === 4);
  res = await get('/play/api/leaderboard?board=points&game=chess&mode=bot&period=day');
  ok('b. points board per game+mode reads results_daily.points', names(res) === [mask(B), mask(A)].join() && res.json.rows[0].value === 9);
  res = await get('/play/api/leaderboard?board=wins&game=chess&mode=pvp');
  ok('b. modes are separate boards (pvp ≠ bot)', names(res) === mask(Dd));

  sql('INSERT INTO ratings (game_id, address, rating, games, wins, draws, losses, updated_at) VALUES (?, ?, ?, ?, 0, 0, 0, 0)', 'chess', A, 1300, 5);
  sql('INSERT INTO ratings (game_id, address, rating, games, wins, draws, losses, updated_at) VALUES (?, ?, ?, ?, 0, 0, 0, 0)', 'chess', B, 1300, 7);
  sql('INSERT INTO ratings (game_id, address, rating, games, wins, draws, losses, updated_at) VALUES (?, ?, ?, ?, 0, 0, 0, 0)', 'chess', C, 1500, 4);
  res = await get('/play/api/leaderboard?board=rating&game=chess');
  ok('b. rating: < 5 games hidden (provisional); equal rating → more games first',
    names(res) === [mask(B), mask(A)].join() && res.json.mode === 'pvp' && res.json.unit === 'rating', res.text);

  const bad = async (q, field) => { const r = await get(`/play/api/leaderboard${q}`); return r.status === 400 && r.json.field === field; };
  ok('b. params: unknown key, repeated key, bad enum, game needed, mode needed, period on the all-time board',
    await bad('?sort=x', 'sort') && await bad('?board=wins&board=points', 'board') && await bad('?board=best', 'board')
    && await bad('?board=wins', 'game') && await bad('?board=wins&game=chess', 'mode') && await bad('?period=day', 'period')
    && await bad('?board=wins&game=nope&mode=bot', 'game') && await bad('?board=rating&game=chess&mode=bot', 'mode')
    && await bad('?board=points&mode=bot', 'mode'));

  givePoints(C, 1000);
  res = await get('/play/api/leaderboard');
  ok('b. the board is cached: a change inside 60 s is not seen yet', res.json.rows[0].name !== mask(C));
  T += 61 * 1000;
  res = await get('/play/api/leaderboard');
  ok('b. …and is seen after 60 s', res.json.rows[0].name === mask(C));
  ok('b. the cache key space is closed (only validated combinations are cached)',
    [...app.services.leaderboard._internal.cache.keys()].every((k) => /^(points|wins|rating)\|(null|chess)\|(null|bot|pvp)\|(day|week|month|all)$/.test(k)));
  modeState.mode = 'off';
  ok('b. mode off → 404 (leaderboard and events)', (await get('/play/api/leaderboard')).status === 404 && (await get('/play/api/events')).status === 404);
  modeState.mode = 'preview';

  // ── [c] admin guard ─────────────────────────────────────────────────────────────────
  console.log('\n[c] /internal/admin guard\n');
  res = await adm('GET', 'event-kinds');
  ok('c. with the secret + an admin user → 200 (kinds, badges, games)',
    res.status === 200 && res.json.kinds.length === 3 && res.json.badges.some((b) => b.id === 'gold') && res.json.games[0].id === 'chess');
  ok('c. X-Forwarded-For → 404 before the secret is looked at', (await adm('GET', 'event-kinds', undefined, { headers: { 'X-Forwarded-For': '1.2.3.4' } })).status === 404);
  ok('c. X-Real-IP → 404', (await adm('GET', 'event-kinds', undefined, { headers: { 'X-Real-IP': '1.2.3.4' } })).status === 404);
  ok('c. missing secret → 401, wrong secret → 401, same code',
    (await adm('GET', 'events', undefined, { secret: null })).json.error === 'unauthorised'
    && (await adm('GET', 'events', undefined, { secret: SECRET.slice(0, -1) + 'x' })).json.error === 'unauthorised'
    && (await adm('GET', 'events', undefined, { secret: 'short' })).status === 401);
  ok('c. the guard runs before the body is read (bad JSON without the secret → 401, not 400)',
    (await adm('POST', 'events', undefined, { secret: null, rawBody: '{not json' })).status === 401);
  ok('c. admin user missing / non-ASCII / too long → 400 admin_user',
    (await adm('GET', 'events', undefined, { user: null })).json.field === 'admin_user'
    && (await adm('GET', 'events', undefined, { user: 'x'.repeat(65) })).json.field === 'admin_user'
    && (await adm('GET', 'events', undefined, { user: '   ' })).json.field === 'admin_user');
  fs.renameSync(linkFile, linkFile + '.off');
  T += 2000;                                         // pool-link re-stats at most once a second
  ok('c. no link file on this side → 503 link_not_configured', (await adm('GET', 'events')).json.error === 'link_not_configured');
  fs.renameSync(linkFile + '.off', linkFile);
  T += 2000;
  ok('c. …and back once it returns', (await adm('GET', 'events')).status === 200);

  const poolSrc = fs.readFileSync(POOL_LINK_SRC, 'utf8');
  const listOf = (src) => ((src.match(/const FAST_WRITES = \[([\s\S]*?)\n\];/) || [])[1] || '')
    .split('\n').map((l) => l.replace(/\/\/.*$/, '').trim()).filter(Boolean).join('\n');
  const ourSrc = fs.readFileSync(path.join(SERVER, 'lib', 'admin.js'), 'utf8');
  ok('c. FAST_WRITES is identical to the pool\'s (the pool enforces, games re-checks)',
    listOf(poolSrc) !== '' && listOf(poolSrc) === listOf(ourSrc) && FAST_WRITES.length === 6, `\n${listOf(poolSrc)}\n---\n${listOf(ourSrc)}`);

  // ── [d] events ──────────────────────────────────────────────────────────────────────
  console.log('\n[d] events\n');
  const REWARD = {
    tiers: [{ rank_from: 1, rank_to: 1, points: 100, badge: 'gold' }, { rank_from: 2, rank_to: 3, points: 50, badge: 'silver' }],
    participation: { min_value: 10, points: 5, badge: 'took_part' },
  };
  const ev = (over) => ({ kind: 'mining_minutes', title: 'October sprint', starts_at: D0, ends_at: D0 + 2 * DAY, rules: {}, reward: REWARD, ...over });
  const createE = async (over, opts) => adm('POST', 'events', ev(over), opts);
  const badField = async (over) => { const r = await createE(over); return r.status === 400 ? r.json.field : `${r.status}`; };
  ok('d. window: not a midnight / backdated / too far ahead / end ≤ start / > 366 days',
    await badField({ starts_at: D0 + 3600 }) === 'starts_at' && await badField({ starts_at: D0 - DAY }) === 'starts_at'
    && await badField({ starts_at: D0 + 400 * DAY, ends_at: D0 + 401 * DAY }) === 'starts_at'
    && await badField({ ends_at: D0 }) === 'ends_at' && await badField({ ends_at: D0 + 367 * DAY }) === 'ends_at'
    && await badField({ ends_at: D0 + DAY + 5 }) === 'ends_at');
  ok('d. title: empty, > 60 chars, a bidi override, a control char, a zero-width char',
    await badField({ title: '  ' }) === 'title' && await badField({ title: 'x'.repeat(61) }) === 'title'
    && await badField({ title: 'Win ‮gold' }) === 'title' && await badField({ title: 'a\u0007b' }) === 'title'
    && await badField({ title: 'a​b' }) === 'title');
  ok('d. body: unknown key, unknown kind, bad rules',
    await badField({ state: 'done' }) === 'body' && await badField({ kind: 'lottery' }) === 'kind'
    && await badField({ kind: 'game_results', rules: { game_id: 'chess', mode: 'bot' } }) === 'rules.metric');
  ok('d. reward: free-text badge, overlapping tiers, out-of-order tiers, string points, unknown key',
    await badField({ reward: { tiers: [{ rank_from: 1, rank_to: 1, points: 5, badge: '<b>' }] } }) === 'reward.tiers.badge'
    && await badField({ reward: { tiers: [{ rank_from: 1, rank_to: 3, points: 5 }, { rank_from: 3, rank_to: 4, points: 1 }] } }) === 'reward.tiers.rank_from'
    && await badField({ reward: { tiers: [{ rank_from: 5, rank_to: 6, points: 5 }, { rank_from: 1, rank_to: 1, points: 1 }] } }) === 'reward.tiers.rank_from'
    && await badField({ reward: { tiers: [{ rank_from: 1, rank_to: 1, points: '5' }] } }) === 'reward.tiers.points'
    && await badField({ reward: { tiers: [], bonus: 1 } }) === 'reward'
    && await badField({ reward: { participation: { min_value: 0, points: 1 } } }) === 'reward.participation.min_value');
  ok('d. nothing was created by any refused request', one('SELECT COUNT(*) AS n FROM events').n === 0);

  const ma0 = modActions();
  res = await createE({});
  const E1 = res.json.event;
  ok('d. create (fast write, no step-up) → running at once (it starts today)', res.status === 200 && E1.state === 'running' && E1.created_by === 'alice'
    && E1.first_day === '2026-10-07' && E1.last_day === '2026-10-08' && E1.finalises_at === D0 + 2 * DAY + 600, res.text);
  ok('d. …one mod_actions row naming the admin', modActions() === ma0 + 1 && one('SELECT admin_user, action, target FROM mod_actions ORDER BY id DESC').action === 'event_create');
  res = await createE({ kind: 'active_days', title: 'Every day counts', starts_at: D0 + DAY, ends_at: D0 + 3 * DAY, rules: { min_minutes: 10 },
    reward: { tiers: [{ rank_from: 1, rank_to: 1, points: 20, badge: 'regular' }] } });
  const E2 = res.json.event;
  ok('d. an event starting tomorrow is scheduled', E2.state === 'scheduled');
  ok('d. GETs add no mod_actions row', (await adm('GET', `events/${E1.id}`)).status === 200 && modActions() === ma0 + 2);

  // Activity: in-window days D0, D0+1; out-of-window D0-1 and D0+2.
  const days = [D0 - DAY, D0, D0 + DAY, D0 + 2 * DAY].map(utcDay);
  const addrs = [A, B, C, Dd, E, F, G, addr(8), addr(9), addr(10)];
  let seed = 7;
  const rnd = (n) => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return (seed >>> 8) % n; };
  const secs = {};
  for (const a of addrs) for (const d of days) {
    const s = rnd(5) === 0 ? 0 : rnd(4000) + (a === G ? 0 : 30);
    if (s === 0) continue;
    sql('INSERT INTO activity_daily (address, day, seconds) VALUES (?, ?, ?)', a, d, s);
    secs[`${a}|${d}`] = s;
  }
  sql('INSERT OR REPLACE INTO activity_daily (address, day, seconds) VALUES (?, ?, ?)', G, days[1], 59);   // < 1 minute in the window
  sql('DELETE FROM activity_daily WHERE address = ? AND day = ?', G, days[2]);
  secs[`${G}|${days[1]}`] = 59; delete secs[`${G}|${days[2]}`];
  const expMinutes = (a) => Math.floor(((secs[`${a}|${days[1]}`] || 0) + (secs[`${a}|${days[2]}`] || 0)) / 60);

  const std = app.services.events._internal.standings;
  const full = std({ ...E1, rules: {} }, nowS(), nowS() + 3 * DAY);
  ok('d. mining_minutes values equal floor(Σ activity_daily.seconds / 60) over exactly the window days',
    addrs.filter((a) => a !== E).every((a) => { const r = full.find((x) => x.address === a); return (r ? r.value : 0) === expMinutes(a); }),
    JSON.stringify(full.map((r) => [r.address.slice(-4), r.value])));
  ok('d. …the banned address is not ranked, nor a sub-minute one', !full.some((r) => r.address === E) && !full.some((r) => r.address === G));

  res = await get('/play/api/events');
  ok('d. public list: running + scheduled, masked, no full address', res.status === 200 && res.json.events.map((e) => e.id).join() === `${E1.id},${E2.id}`
    && !FULL_ADDR_RE.test(res.text) && res.json.events[0].description.startsWith('Most active mining minutes'));
  res = await get(`/play/api/events/${E1.id}`, { cookie: ca });
  const live1 = std({ ...E1, rules: {} }, nowS(), nowS());
  ok('d. running event: provisional standings (today only so far), masked, own row + you',
    res.json.standings.final === false && res.json.standings.rows.length === Math.min(50, live1.length)
    && res.json.standings.rows.every((r, i) => r.name === mask(live1[i].address) && r.value === live1[i].value)
    && (live1.some((r) => r.address === A) ? res.json.you.rank === live1.find((r) => r.address === A).rank : res.json.you.rank === null)
    && !FULL_ADDR_RE.test(res.text), JSON.stringify([res.json.standings, res.json.you, live1.map((r) => [mask(r.address), r.value])]).slice(0, 900));
  const late = addr(11);
  sql('INSERT INTO activity_daily (address, day, seconds) VALUES (?, ?, ?)', late, days[1], 90000);
  const tot0 = res.json.standings.total;
  ok('d. public standings are cached 60 s…', (await get(`/play/api/events/${E1.id}`)).json.standings.total === tot0);
  T += 61 * 1000;
  res = await get(`/play/api/events/${E1.id}`);
  ok('d. …then recomputed (the new miner leads)', res.json.standings.total === tot0 + 1 && res.json.standings.rows[0].name === mask(late));
  ok('d. a scheduled event has no standings', (await get(`/play/api/events/${E2.id}`)).json.standings === null);
  ok('d. unknown / malformed id → 404', (await get('/play/api/events/999')).status === 404 && (await get('/play/api/events/1x')).status === 404);

  // Update rules on a running event.
  const upd = (id, body, o) => adm('POST', `events/${id}`, body, o);
  ok('d. running: kind / starts_at / rules changes → 409 not_editable',
    (await upd(E1.id, { kind: 'active_days', rules: {} })).json.field === 'kind'
    && (await upd(E1.id, { starts_at: D0 + DAY })).json.field === 'starts_at'
    && (await upd(E2.id, { rules: { min_minutes: 20 } })).status === 200     // scheduled: allowed
    && (await upd(E2.id, { rules: { min_minutes: 10 } })).status === 200);
  res = await upd(E1.id, { ...ev({}), title: 'October sprint!' });
  ok('d. running: re-posting every field unchanged + a new title is fine', res.status === 200 && res.json.event.title === 'October sprint!');
  ok('d. running: shortening to a day already over → 400 ends_at', (await upd(E1.id, { ends_at: D0 })).json.field === 'ends_at');
  ok('d. finalise-now before the window ends → 409 not_ended (with step-up)',
    (await adm('POST', `events/${E1.id}/finalise`, {}, { stepup: true })).json.error === 'not_ended');
  ok('d. cancel / finalise without step-up → 403 step_up_required',
    (await adm('POST', `events/${E1.id}/cancel`, {})).json.error === 'step_up_required'
    && (await adm('POST', `events/${E1.id}/finalise`, {})).json.error === 'step_up_required');

  // Lifecycle via the tick.
  T = (D0 + DAY + 60) * 1000;
  let tk = events.tick();
  ok('d. tick at starts_at: scheduled → running', tk.started === 1 && one('SELECT state FROM events WHERE id = ?', E2.id).state === 'running');
  T = (D0 + 2 * DAY + 300) * 1000;
  tk = events.tick();
  ok('d. inside the 10-min grace nothing closes', tk.closed === 0 && one('SELECT state FROM events WHERE id = ?', E1.id).state === 'running');
  const pointsBefore = Object.fromEntries([...addrs, late].map((a) => [a, player(a).points]));
  T = (D0 + 2 * DAY + 601) * 1000;
  const finalRank = std({ ...E1, rules: {} }, nowS());
  tk = events.tick();
  ok('d. after the grace: running → finalising → done in one tick', tk.closed === 1 && tk.finalised === 1 && one('SELECT state FROM events WHERE id = ?', E1.id).state === 'done');
  const results = all('SELECT address, value, rank, reward_points, badge FROM event_results WHERE event_id = ? ORDER BY rank', E1.id);
  const expReward = (r) => (r.rank === 1 ? [100, 'gold'] : r.rank <= 3 ? [50, 'silver'] : r.value >= 10 ? [5, 'took_part'] : [0, null]);
  ok('d. event_results = the ranked standings with tier / participation rewards',
    results.length === finalRank.length && results.length >= 5
    && results.every((r, i) => r.address === finalRank[i].address && r.rank === i + 1 && r.value === finalRank[i].value
      && r.reward_points === expReward(r)[0] && r.badge === expReward(r)[1]), JSON.stringify(results.slice(0, 5)));
  const evRows = all("SELECT address, delta, ref FROM ledger WHERE reason = 'event'");
  ok('d. one ledger row per rewarded address, ref e:<id>, and balances moved by exactly that',
    evRows.length === results.filter((r) => r.reward_points > 0).length && evRows.every((r) => r.ref === `e:${E1.id}`)
    && results.every((r) => player(r.address).points === pointsBefore[r.address] + r.reward_points));
  const winner = results[0].address;
  ok('d. badges appended once (gold for the winner, event id recorded)',
    JSON.stringify(JSON.parse(player(winner).badges_json)) === JSON.stringify([{ id: 'gold', event: E1.id }]));

  // Exactly once.
  const snap = () => JSON.stringify([all('SELECT * FROM ledger ORDER BY id'), all('SELECT address, points, badges_json FROM players ORDER BY address'),
    all('SELECT * FROM event_results ORDER BY event_id, address')]);
  const s0 = snap();
  tk = events.tick();
  const again = events.finalise(E1.id);
  ok('d. a second tick and a direct finalise do nothing', tk.finalised === 0 && again.done === false && snap() === s0);
  sql("UPDATE events SET state = 'finalising' WHERE id = ?", E1.id);            // simulate a replayed transition
  let threw = false;
  try { events.finalise(E1.id); } catch { threw = true; }
  ok('d. even forced back to finalising, a re-finalise fails whole (event_results PK) and pays nothing', threw && snap() === s0
    && one('SELECT state FROM events WHERE id = ?', E1.id).state === 'finalising');
  sql("UPDATE events SET state = 'done' WHERE id = ?", E1.id);
  ok('d. and the ledger itself refuses a second e:<id> credit', ledger.post({ address: winner, kind: 'points', delta: 100, reason: 'event', ref: `e:${E1.id}` }).duplicate === true);

  res = await get(`/play/api/events/${E1.id}`, { cookie: ca });
  const aRow = results.find((r) => r.address === A);
  ok('d. done event: final standings with rewards + badge labels, masked, you from event_results',
    res.json.standings.final === true && res.json.standings.total === results.length
    && res.json.standings.rows[0].badge_label === 'Gold' && res.json.standings.rows[0].name === mask(winner)
    && (aRow ? res.json.you.rank === aRow.rank && res.json.you.reward_points === aRow.reward_points : res.json.you.rank === null)
    && !FULL_ADDR_RE.test(res.text));
  const cw = await login(winner === E ? A : winner);
  res = await get('/play/api/me', { cookie: cw });
  ok('d. /me lists the caller\'s badges with our labels', winner === E || (res.json.badges.length === 1 && res.json.badges[0].label === 'Gold' && res.json.badges[0].event_id === E1.id));
  ok('d. cancel a done event → 409 not_cancellable (nothing is clawed back)',
    (await adm('POST', `events/${E1.id}/cancel`, {}, { stepup: true })).json.error === 'not_cancellable');
  ok('d. update a done event → 409 not_editable', (await upd(E1.id, { title: 'x' })).json.error === 'not_editable');

  // Cancel pays nothing: E3 ends, is cancelled while running (after its end), then ticks.
  res = await createE({ title: 'Cancelled sprint', starts_at: D0 + 2 * DAY, ends_at: D0 + 3 * DAY });
  const E3 = res.json.event;
  T = (D0 + 3 * DAY + 60) * 1000;
  const ma1 = modActions();
  res = await adm('POST', `events/${E3.id}/cancel`, { reason: 'test' }, { stepup: true });
  ok('d. cancel with step-up → cancelled, audited with the state it left', res.status === 200 && res.json.event.state === 'cancelled'
    && modActions() === ma1 + 1 && JSON.parse(one('SELECT details_json FROM mod_actions ORDER BY id DESC').details_json).from_state === 'running');
  T = (D0 + 3 * DAY + 700) * 1000;
  events.tick();
  ok('d. a cancelled event never pays (no results, no ledger rows after ticks)',
    one('SELECT COUNT(*) AS n FROM event_results WHERE event_id = ?', E3.id).n === 0 && one('SELECT COUNT(*) AS n FROM ledger WHERE ref = ?', `e:${E3.id}`).n === 0
    && one('SELECT state FROM events WHERE id = ?', E3.id).state === 'cancelled');
  // Cancel while finalising, then finalise: nothing.
  res = await createE({ title: 'Cut short', starts_at: D0 + 3 * DAY, ends_at: D0 + 4 * DAY });
  const E4 = res.json.event;
  sql("UPDATE events SET state = 'finalising' WHERE id = ?", E4.id);
  ok('d. cancel from finalising works', (await adm('POST', `events/${E4.id}/cancel`, {}, { stepup: true })).json.event.state === 'cancelled');
  ok('d. …and finalise then does nothing', events.finalise(E4.id).done === false && one('SELECT COUNT(*) AS n FROM event_results WHERE event_id = ?', E4.id).n === 0);
  ok('d. a cancelled event that STARTED stays in the public list (players saw it run)',
    (await get('/play/api/events')).json.events.some((e) => e.id === E3.id && e.state === 'cancelled'));
  res = await createE({ title: 'Never happened', starts_at: D0 + 10 * DAY, ends_at: D0 + 11 * DAY });
  const E6 = res.json.event;
  await adm('POST', `events/${E6.id}/cancel`, {}, { stepup: true });
  ok('d. a cancelled event that never started is not public (list + detail)',
    !(await get('/play/api/events')).json.events.some((e) => e.id === E6.id) && (await get(`/play/api/events/${E6.id}`)).status === 404);

  // game_results + finalise-now: min_games, banned, metric.
  const d4 = utcDay(D0 + 3 * DAY);
  res = await createE({ kind: 'game_results', title: 'Bot bash', starts_at: D0 + 3 * DAY, ends_at: D0 + 4 * DAY,
    rules: { game_id: 'chess', mode: 'bot', metric: 'wins', min_games: 2 }, reward: { tiers: [{ rank_from: 1, rank_to: 2, points: 30, badge: 'champion' }] } });
  const E5 = res.json.event;
  ok('d. game_results event records its game_id', E5.game_id === 'chess' && E5.description === 'Most Chess wins against the bot (at least 2 games).', E5.description);
  rd(A, 'bot', d4, 2, 3, 4); rd(B, 'bot', d4, 4, 4, 8); rd(C, 'bot', d4, 1, 1, 3); rd(E, 'bot', d4, 9, 9, 9); rd(F, 'pvp', d4, 5, 5, 5);
  rd(G, 'bot', utcDay(D0 + 4 * DAY), 8, 8, 8);
  T = (D0 + 4 * DAY + 60) * 1000;                    // ended, inside the grace
  const ma2 = modActions();
  res = await adm('POST', `events/${E5.id}/finalise`, {}, { stepup: true });
  const r5 = all('SELECT address, value, rank, reward_points, badge FROM event_results WHERE event_id = ? ORDER BY rank', E5.id);
  ok('d. finalise-now (step-up) inside the grace → done, audited', res.status === 200 && res.json.event.state === 'done' && modActions() === ma2 + 1);
  ok('d. game_results: min_games filters (C: 1 game), banned E not ranked, other mode / day ignored',
    r5.map((r) => r.address).join() === [B, A].join() && r5[0].value === 4 && r5[1].value === 2 && r5.every((r) => r.reward_points === 30 && r.badge === 'champion'),
    JSON.stringify(r5));
  ok('d. finalise-now on a done event → 409', (await adm('POST', `events/${E5.id}/finalise`, {}, { stepup: true })).status === 409);

  // active_days (E2: D0+1 .. D0+2, ≥ 10 minutes).
  T = (D0 + 3 * DAY + 700) * 1000;
  events.tick();
  const r2rows = all('SELECT address, value FROM event_results WHERE event_id = ?', E2.id);
  const expDays = (a) => [days[2], days[3]].filter((d) => (secs[`${a}|${d}`] || 0) >= 600).length;
  ok('d. active_days counts the window\'s days with ≥ min_minutes',
    one('SELECT state FROM events WHERE id = ?', E2.id).state === 'done' && r2rows.length > 0
    && r2rows.every((r) => r.value === expDays(r.address)) && addrs.filter((a) => a !== E && expDays(a) > 0).length === r2rows.length,
    JSON.stringify(r2rows.map((r) => [r.address.slice(-4), r.value])));
  ok('d. a badge from a second event is appended, never replacing the first',
    r2rows.length === 0 || (() => { const w = all('SELECT address FROM event_results WHERE event_id = ? AND rank = 1', E2.id)[0].address;
      const bs = JSON.parse(player(w).badges_json); return bs.some((b) => b.id === 'regular' && b.event === E2.id) && bs.filter((b) => b.event === E2.id).length === 1; })());

  res = await adm('GET', `events/${E1.id}`);
  ok('d. admin detail carries FULL addresses (admin only) and counts', res.json.results[0].address === winner && res.json.event.results === results.length);
  res = await adm('GET', 'events?state=done');
  ok('d. admin list filters by state', res.json.events.length === 3 && res.json.events.every((e) => e.state === 'done'));
  ok('d. admin list: bad state → 400', (await adm('GET', 'events?state=gone')).json.field === 'state');

  modeState.mode = 'off';
  ok('d. admin routes keep working while the games are off', (await adm('GET', 'events')).status === 200
    && (await createE({ title: 'Prepared while off', starts_at: D0 + 20 * DAY, ends_at: D0 + 21 * DAY })).status === 200);
  modeState.mode = 'preview';

  // ── [e] invariants ──────────────────────────────────────────────────────────────────
  console.log('\n[e] invariants\n');
  const leaks = publicTexts.filter((t) => FULL_ADDR_RE.test(t.slice(t.indexOf(' ') + 1)));
  ok(`e. no public response (${publicTexts.length} checked) carries a full address`, leaks.length === 0 && publicTexts.length > 20, leaks.map((l) => l.slice(0, 80)).join(' | '));

  const plan = (s, ...a) => db.raw.prepare(`EXPLAIN QUERY PLAN ${s}`).all(...a).map((r) => r.detail).join(' | ');
  const plans = {
    points: plan('SELECT address, points AS value FROM players WHERE points > 0 ORDER BY points DESC LIMIT 20000'),
    rating: plan('SELECT address, rating AS value, games FROM ratings WHERE game_id = ? AND games >= ? ORDER BY rating DESC LIMIT ?', 'chess', 5, 10),
    results: plan('SELECT address, SUM(wins) AS wins, SUM(points) AS points, SUM(games) AS games FROM results_daily WHERE game_id = ? AND mode = ? AND day BETWEEN ? AND ? GROUP BY address', 'chess', 'bot', 'a', 'b'),
    minutes: plan('SELECT address, SUM(seconds) AS s FROM activity_daily WHERE day BETWEEN ? AND ? GROUP BY address', 'a', 'b'),
    days: plan('SELECT address, COUNT(*) AS n FROM activity_daily WHERE day BETWEEN ? AND ? AND seconds >= ? GROUP BY address', 'a', 'b', 1),
    events: plan("SELECT id FROM events WHERE state = 'running' AND ends_at <= ?", 1),
  };
  ok('e. EXPLAIN: every board and kind read SEARCHes its index',
    /idx_players_points/.test(plans.points) && /idx_ratings_board/.test(plans.rating) && /idx_results_board/.test(plans.results)
    && /idx_activity_day/.test(plans.minutes) && /idx_activity_day/.test(plans.days) && /idx_events_state/.test(plans.events), JSON.stringify(plans));
  const srcs = ['leaderboard.js', 'events.js', 'events/game_results.js', 'events/mining_minutes.js', 'events/active_days.js']
    .map((f) => fs.readFileSync(path.join(SERVER, 'lib', f), 'utf8'));
  ok('e. no leaderboard or event query reads `matches` or `ledger`', srcs.every((s) => !/\bFROM\s+(matches|match_moves|ledger)\b/i.test(s)));
  ok('e. the ledger invariant holds after everything', ledger.verify().length === 0, JSON.stringify(ledger.verify().slice(0, 3)));
  ok('e. only the three reward-paying events wrote event ledger rows',
    all("SELECT DISTINCT ref FROM ledger WHERE reason = 'event' ORDER BY ref").map((r) => r.ref).join() === [`e:${E1.id}`, `e:${E2.id}`, `e:${E5.id}`].sort().join());
  sql('INSERT INTO mod_actions (admin_user, action, target, details_json, created_at) VALUES (?, ?, ?, ?, ?)', 'old', 'x', null, null, nowS() - 366 * DAY);
  const jobs = [];
  app.registerJobs({ register: (name, fn, o) => jobs.push({ name, fn, o }) });
  const purge = jobs.find((j) => j.name === 'mod_actions_purge');
  purge.fn();
  ok('e. mod_actions keeps 365 days (hourly purge)', purge.o.tier === '1h' && one("SELECT COUNT(*) AS n FROM mod_actions WHERE admin_user = 'old'").n === 0 && modActions() > 0);
  ok('e. event_transitions runs on the 5-min tier, after activity_sync',
    jobs.findIndex((j) => j.name === 'event_transitions') > jobs.findIndex((j) => j.name === 'activity_sync') && jobs.find((j) => j.name === 'event_transitions').o.tier === '5m');

  await new Promise((r) => srv.close(r));
  db.close();
}

main().catch((e) => {
  fail++;
  console.error(`  FAIL  suite crashed: ${e && e.stack ? e.stack : e}`);
}).finally(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }
  console.log(`\nRESULT pass=${pass} fail=${fail}`);
  process.exitCode = fail ? 1 : 0;
});
