'use strict';

// Part 10 (design §19.6, §19.8, §19.9, D20): PvP correspondence chess over a real loopback
// server — seeks, challenges, accept / decline / cancel, draw / abort / resign / timeout,
// the rated pair cap, Elo + the recompute after an admin void, the lobby and turns reads.
//
// The pool is a stub; the chess game is the real one from play/games/. Servers are closed
// before the suite ends; temp files live under os.tmpdir() and are removed.
// Run: node scripts/test-pvp.js

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const { openDb } = require('../lib/db.js');
const { createLogger } = require('../lib/log.js');
const { loadGames } = require('../lib/registry.js');
const { createPoolLink } = require('../lib/pool-link.js');
const { buildApp, createServer, listen } = require('../lib/app.js');
const { OPEN_TTL_S, LOBBY_MAX } = require('../lib/matches.js');
const { eloDelta, expected, START, K } = require('../lib/ratings.js');

let pass = 0, fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else      { fail++; console.error(`  FAIL  ${name}${extra ? ' — ' + extra : ''}`); }
}

const SERVER = path.join(__dirname, '..');
const GAMES = path.join(SERVER, '..', 'games');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'grin-games-pvp-'));
const lines = [];
let srv = null;
let db = null;
const log = createLogger((level, line) => lines.push(`${level} ${line}`));

const CS = 'acdefghjklmnpqrstuvwxyz023456789';
function addr(n, prefix = 'grin1') {
  let x = (n * 7919 + 13) >>> 0;
  let s = '';
  for (let i = 0; i < 58; i++) { x = (Math.imul(x, 1103515245) + 12345) >>> 0; s += CS[(x >>> 16) % 32]; }
  return prefix + s;
}
const FULL_ADDR_RE = /t?grin1[ac-hj-np-z02-9]{58}/;

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
  // ── [a] Elo arithmetic ──────────────────────────────────────────────────────────────
  console.log('\n[a] Elo: K = 24, start 1200, integers, zero-sum\n');
  ok('a. constants are §19.8\'s', START === 1200 && K === 24);
  ok('a. equal ratings: a win moves 12, a draw moves 0', eloDelta(1200, 1200, 1) === 12 && eloDelta(1200, 1200, 0) === -12
    && Object.is(eloDelta(1200, 1200, 0.5), 0));
  ok('a. 1400 beats 1200 → +6 (24 × (1 − 0.7597), rounded)', eloDelta(1400, 1200, 1) === Math.round(24 * (1 - expected(1400, 1200))) && eloDelta(1400, 1200, 1) === 6);
  ok('a. 1200 upsets 1400 → +18', eloDelta(1200, 1400, 1) === 18);
  let intOk = true;
  for (let r1 = 800; r1 <= 2400; r1 += 37) for (let r2 = 800; r2 <= 2400; r2 += 53) for (const sc of [0, 0.5, 1]) {
    const d = eloDelta(r1, r2, sc);
    if (!Number.isSafeInteger(d) || Object.is(d, -0) || Math.abs(d) > K) intOk = false;
  }
  ok('a. every change is an integer within ±K, never -0', intOk);

  // ── setup ───────────────────────────────────────────────────────────────────────────
  console.log('\n[b] seeks, challenges, accept / decline / cancel\n');
  let T = Date.UTC(2026, 9, 7, 9, 0, 0);            // ms — 2026-10-07 09:00 UTC
  const nowS = () => Math.floor(T / 1000);
  const SECRET = 'p'.repeat(20) + 'V3'.repeat(22);
  const linkFile = path.join(TMP, 'link');
  fs.writeFileSync(linkFile, SECRET + '\n');
  const cfg = { net: 'mainnet', poolInternalUrl: 'http://127.0.0.1:9', linkSecretFile: linkFile };
  const realLink = createPoolLink({ config: cfg, clock: () => T });
  const reg = loadGames({ gamesDir: GAMES, log });
  db = openDb(':memory:', { net: 'mainnet', log });
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
  const { ledger, settings, matches } = app.services;
  srv = createServer(app.handler);
  const { port } = await listen(srv, 0, '127.0.0.1');
  const HOST = 'pool.example';
  const J = { 'Content-Type': 'application/json', Host: HOST };
  const publicTexts = [];                            // every spectator / lobby answer, for the leak check
  const post = (p, body, { cookie } = {}) => request(port, {
    method: 'POST', path: p, body: JSON.stringify(body),
    headers: { ...J, 'X-Real-IP': '203.0.113.9', ...(cookie ? { Cookie: cookie } : {}) },
  });
  const get = async (p, { cookie } = {}) => {
    const r = await request(port, { path: p, headers: { Host: HOST, 'X-Real-IP': '203.0.113.9', ...(cookie ? { Cookie: cookie } : {}) } });
    if (!cookie) publicTexts.push(`${p} ${r.text}`);
    return r;
  };
  let ipN = 1;
  async function login(address) {
    const res = await request(port, { method: 'POST', path: '/play/api/login', body: JSON.stringify({ address, proof: 'ip-ok' }),
      headers: { ...J, 'X-Real-IP': `198.51.100.${ipN++}` } });
    const sc = res.headers['set-cookie'];
    return (Array.isArray(sc) ? sc[0] : sc).split(';')[0];
  }
  function adm(method, rel, body, { stepup = false } = {}) {
    const h = { 'X-Games-Link': SECRET, 'X-Admin-User': 'alice', 'X-Admin-Stepup': stepup ? '1' : '0' };
    let payload;
    if (body !== undefined) { payload = JSON.stringify(body); h['Content-Type'] = 'application/json'; }
    return request(port, { method, path: `/internal/admin/${rel}`, headers: h, body: payload });
  }
  let wref = 0;
  const givePlays = (a, n) => ledger.credit(a, 'plays', n, 'mining_minutes', `w:${++wref}`);
  const bal = (a) => db.raw.prepare('SELECT plays, points FROM players WHERE address = ?').get(a);
  const row = (id) => db.raw.prepare('SELECT * FROM matches WHERE id = ?').get(id);
  const one = (s, ...a) => db.raw.prepare(s).get(...a);
  const all = (s, ...a) => db.raw.prepare(s).all(...a);
  const refs = (a, reason, id) => one('SELECT COUNT(*) AS n FROM ledger WHERE address = ? AND reason = ? AND ref LIKE ?', a, reason, `m:${id}:%`).n;
  const tick = (s = 5) => { T += s * 1000; };      // refills the per-address move bucket
  const rating = (a) => one("SELECT rating, games, wins, draws, losses FROM ratings WHERE game_id = 'chess' AND address = ?", a);

  const A = addr(11), B = addr(12), C = addr(13), D = addr(14), E = addr(15);
  const ca = await login(A), cb = await login(B), cc = await login(C), cd = await login(D), ce = await login(E);
  for (const x of [A, B, C, D]) givePlays(x, 60);

  const create = (cookie, extra = {}) => post('/play/api/matches', { game_id: 'chess', mode: 'pvp', colour: 'seat1', ...extra }, { cookie });
  const act = (cookie, id, what, body = {}) => post(`/play/api/matches/${id}/${what}`, body, { cookie });
  const view = async (cookie, id) => (await get(`/play/api/matches/${id}`, { cookie })).json.match;
  async function mv(cookie, id, move) {
    tick();
    const v = await view(cookie, id);
    return act(cookie, id, 'move', { ply: v.ply, move });
  }
  async function game(whiteCookie, blackCookie) {
    const r = await create(whiteCookie, { colour: 'seat1' });
    if (r.status !== 200) throw new Error(`create failed: ${r.text}`);
    const id = r.json.match.id;
    const a = await act(blackCookie, id, 'accept');
    if (a.status !== 200) throw new Error(`accept failed: ${a.text}`);
    return id;
  }
  // Fool's mate: black (seat 2) mates in 2.
  async function foolsMate(id, wc, bc) {
    for (const [c, m] of [[wc, 'f2f3'], [bc, 'e7e5'], [wc, 'g2g4'], [bc, 'd8h4']]) {
      const r = await mv(c, id, m);
      if (r.status !== 200) throw new Error(`move ${m} failed: ${r.text}`);
    }
  }

  // Validation.
  let res = await create(null);
  ok('b. create without a session → 401', res.status === 401);
  ok('b. a malformed / other-network / self target → 400 (target / self_match), nothing created',
    (await create(ca, { target: 'grin1short' })).json.field === 'target'
    && (await create(ca, { target: addr(99, 'tgrin1') })).json.field === 'target'
    && (await create(ca, { target: 42 })).json.field === 'target'
    && (await create(ca, { target: A })).json.error === 'self_match'
    && one('SELECT COUNT(*) AS n FROM matches').n === 0);
  ok('b. a forged position / result on a pvp create → 400 body',
    (await create(ca, { position: '8/8/8/8/8/8/8/k6K w - - 0 1' })).json.field === 'body'
    && (await create(ca, { result: 'seat1' })).json.field === 'body');
  ok('b. a move time off the manifest → 400 move_seconds', (await create(ca, { move_seconds: 60 })).json.field === 'move_seconds');

  // A seek.
  res = await create(ca, { colour: 'seat2', move_seconds: 86400 });
  const s1 = res.json.match;
  ok('b. a seek: 200, state seek, creator in seat 2, seat 1 open, expiry = created + 72 h',
    res.status === 200 && s1.state === 'seek' && s1.you === 2 && s1.open_seat === 1 && s1.labels[1] === null
    && s1.expires_at === nowS() + OPEN_TTL_S && s1.move_seconds === 86400 && s1.actions.join() === 'cancel', res.text);
  ok('b. …the creator paid one play (ref m:<id>:2) and the view carries no seed and no target',
    bal(A).plays === 59 && refs(A, 'match_cost', s1.id) === 1 && !('seed' in s1) && s1.target_label === null);

  let lob = await get('/play/api/lobby');
  ok('b. the public lobby lists it: masked name, the seat an acceptor takes, no full address',
    lob.status === 200 && lob.json.seeks.length === 1 && lob.json.seeks[0].id === s1.id && lob.json.seeks[0].you_play === 1
    && lob.json.seeks[0].name === `${A.slice(0, 9)}…${A.slice(-4)}` && lob.json.seeks[0].own === false
    && lob.json.challenges.length === 0 && !FULL_ADDR_RE.test(lob.text), lob.text);
  lob = await get('/play/api/lobby', { cookie: ca });
  ok('b. …flagged own for its creator; a query parameter is refused',
    lob.json.seeks[0].own === true && (await get('/play/api/lobby?x=1')).status === 400);
  ok('b. accepting your own seek → 400 self_match', (await act(ca, s1.id, 'accept')).json.error === 'self_match');
  ok('b. a stranger cannot cancel it → 403', (await act(cb, s1.id, 'cancel')).status === 403);

  // The race: two acceptors at once — exactly one seat is taken.
  const [r1, r2] = await Promise.all([act(cb, s1.id, 'accept'), act(cc, s1.id, 'accept')]);
  const winner = r1.status === 200 ? 'B' : r2.status === 200 ? 'C' : null;
  const loser = winner === 'B' ? r2 : r1;
  ok('b. two racing accepts → exactly one 200, the other 409 not_open',
    [r1.status, r2.status].sort().join() === '200,409' && loser.json.error === 'not_open', `${r1.text} ## ${r2.text}`);
  const s1row = row(s1.id);
  const acceptor = winner === 'B' ? B : C;
  const bystander = winner === 'B' ? C : B;
  ok('b. …the winner holds seat 1, the match is active with a move deadline, the loser paid nothing',
    s1row.state === 'active' && s1row.seat1 === acceptor && s1row.seat2 === A && s1row.started_at === nowS()
    && s1row.turn_deadline === nowS() + 86400 && bal(acceptor).plays === 59 && bal(bystander).plays === 60
    && refs(acceptor, 'match_cost', s1.id) === 1 && refs(bystander, 'match_cost', s1.id) === 0);
  ok('b. a taken seek leaves the lobby', (await get('/play/api/lobby')).json.seeks.length === 0);

  // A direct challenge A → D.
  res = await create(ca, { target: D, colour: 'random' });
  const ch = res.json.match;
  ok('b. a challenge: state challenge, target shown masked to the challenger only',
    res.status === 200 && ch.state === 'challenge' && ch.target_label === `${D.slice(0, 9)}…${D.slice(-4)}`
    && (ch.you === 1 || ch.you === 2) && ch.open_seat === (ch.you === 1 ? 2 : 1), res.text);
  const chPublic = await view(null, ch.id);
  const chTarget = await view(cd, ch.id);
  ok('b. …a spectator sees no target; the target sees invited + accept/decline',
    chPublic.target_label === null && chPublic.invited === false && chPublic.actions.length === 0
    && chTarget.invited === true && chTarget.actions.join() === 'accept,decline' && chTarget.target_label !== null);
  lob = await get('/play/api/lobby', { cookie: cd });
  ok('b. …it is in the target\'s lobby as a challenge, never in the public seeks',
    lob.json.challenges.length === 1 && lob.json.challenges[0].id === ch.id && lob.json.seeks.length === 0
    && (await get('/play/api/lobby')).json.challenges.length === 0);
  ok('b. someone else cannot accept or decline it → 403 not_invited',
    (await act(cc, ch.id, 'accept')).json.error === 'not_invited' && (await act(cc, ch.id, 'decline')).json.error === 'not_invited');
  res = await act(cd, ch.id, 'decline');
  ok('b. the target declines → declined, the challenger refunded exactly once',
    res.status === 200 && row(ch.id).state === 'declined' && refs(A, 'match_refund', ch.id) === 1 && bal(A).plays === 59);
  ok('b. declining / accepting again → 409 not_open, no second refund',
    (await act(cd, ch.id, 'decline')).json.error === 'not_open' && (await act(cd, ch.id, 'accept')).json.error === 'not_open'
    && refs(A, 'match_refund', ch.id) === 1);

  // Cancel.
  res = await create(cc);
  const s2 = res.json.match;
  res = await act(cc, s2.id, 'cancel');
  ok('b. the creator cancels a seek → aborted (reason cancelled), refunded once',
    res.status === 200 && row(s2.id).state === 'aborted' && row(s2.id).reason === 'cancelled' && refs(C, 'match_refund', s2.id) === 1
    && (await act(cc, s2.id, 'cancel')).json.error === 'not_open' && refs(C, 'match_refund', s2.id) === 1);

  // Expiry: 72 h.
  res = await create(cc);
  const s3 = res.json.match;
  res = await create(cc, { target: D });
  const s4 = res.json.match;
  T += (OPEN_TTL_S + 1) * 1000;
  ok('b. past 72 h a seek leaves the lobby before any sweep (read-only filter)',
    !(await get('/play/api/lobby')).json.seeks.some((x) => x.id === s3.id) && row(s3.id).state === 'seek');
  res = await act(cd, s4.id, 'accept');
  ok('b. accepting an expired challenge → 409 expired, and THAT request refunded it',
    res.status === 409 && res.json.error === 'expired' && row(s4.id).state === 'expired' && refs(C, 'match_refund', s4.id) === 1
    && bal(D).plays === 60);
  let sw = matches.sweepTimeouts();
  ok('b. the sweep expires the seek and refunds it once', row(s3.id).state === 'expired' && refs(C, 'match_refund', s3.id) === 1 && sw.errors === 0);
  sw = matches.sweepTimeouts();
  ok('b. …a second sweep does nothing', refs(C, 'match_refund', s3.id) === 1 && refs(C, 'match_refund', s4.id) === 1);
  // The active match s1 (1-day moves) timed out too, at ply 0 → aborted, both refunded.
  ok('b. the active match past its move deadline at ply 0 → aborted by the sweep, BOTH sides refunded',
    row(s1.id).state === 'aborted' && refs(A, 'match_refund', s1.id) === 1 && refs(acceptor, 'match_refund', s1.id) === 1);

  // Caps.
  settings.set('pvp_open_max', 2);
  const aPlays = bal(A).plays;
  const capA = await create(ca), capB = await create(ca), capC = await create(ca);
  ok('b. the open cap: a third open seek → 409 too_many_open, and only two plays were taken',
    capA.status === 200 && capB.status === 200 && capC.json.error === 'too_many_open' && bal(A).plays === aPlays - 2);
  ok('b. an address with no plays → 409 no_plays and no match row', (await create(ce)).json.error === 'no_plays'
    && one("SELECT COUNT(*) AS n FROM matches WHERE created_by = ?", E).n === 0);
  await act(ca, capA.json.match.id, 'cancel');
  await act(ca, capB.json.match.id, 'cancel');
  settings.set('pvp_open_max', 5);
  settings.set('pvp_active_max', 1);
  const g1 = await game(ca, cb);                    // A and B are now full
  const busy = await create(cc);                    // C's seek, opened while C is not full
  ok('b. the active cap: a full acceptor → 409 too_many_matches', (await act(ca, busy.json.match.id, 'accept')).json.error === 'too_many_matches');
  ok('b. …a full address cannot open a seek either', (await create(ca)).json.error === 'too_many_matches'
    && (await create(cb)).json.error === 'too_many_matches');
  const sd = await create(cd);
  res = await act(cc, sd.json.match.id, 'accept');  // C is now full (C vs D)
  ok('b. …a full CREATOR → 409 opponent_busy for whoever accepts their older seek', res.status === 200
    && (await act(ce, busy.json.match.id, 'accept')).json.error === 'opponent_busy' && row(busy.json.match.id).state === 'seek');
  settings.set('pvp_active_max', 10);
  await act(cc, busy.json.match.id, 'cancel');

  // ── [c] play: moves, turns, draw, abort, resign, timeout ────────────────────────────
  console.log('\n[c] moves, turns, draw / abort / resign / timeout\n');
  // g1: A white vs B black, active.
  let v = await view(cb, g1);
  ok('c. black cannot move first → 403 not_your_turn', (await act(cb, g1, 'move', { ply: 0, move: 'e7e5' })).json.error === 'not_your_turn');
  let t1 = (await get('/play/api/matches/turns', { cookie: ca })).json;
  ok('c. turns (white): your_turn 1, active ≥ 1', t1.your_turn >= 1 && t1.active >= 1 && t1.challenges === 0, JSON.stringify(t1));
  ok('c. turns needs a session and takes no query', (await get('/play/api/matches/turns')).status === 401
    && (await get('/play/api/matches/turns?x=1', { cookie: ca })).status === 400);
  res = await mv(ca, g1, 'e2e4');
  ok('c. white moves; before each side has moved once the view offers abort, not resign', res.status === 200 && res.json.match.ply === 1
    && res.json.match.your_turn === false && res.json.match.actions.includes('abort') && !res.json.match.actions.includes('resign'));
  ok('c. a stale ply → 409 stale', (await act(cb, g1, 'move', { ply: 0, move: 'e7e5' })).json.error === 'stale');
  ok('c. an illegal move → 400', (await act(cb, g1, 'move', { ply: 1, move: 'e7e4' })).status === 400);
  const spec = await get(`/play/api/matches/${g1}`);
  ok('c. a spectator: you null, no legal list, masked labels, no full address anywhere',
    spec.json.match.you === null && spec.json.match.legal === null && spec.json.match.actions.length === 0
    && !FULL_ADDR_RE.test(spec.text) && spec.json.match.labels[1] === `${A.slice(0, 9)}…${A.slice(-4)}`);
  res = await act(cb, g1, 'abort');
  ok('c. abort at ply 1 → aborted, both refunded once', res.status === 200 && row(g1).state === 'aborted'
    && refs(A, 'match_refund', g1) === 1 && refs(B, 'match_refund', g1) === 1);

  const g2 = await game(ca, cb);
  await mv(ca, g2, 'e2e4');
  res = await act(ca, g2, 'resign');
  ok('c. a PvP resign at ply 1 is an ABORT (both refunded, no result)', res.status === 200 && row(g2).state === 'aborted'
    && row(g2).result === null && refs(A, 'match_refund', g2) === 1 && refs(B, 'match_refund', g2) === 1);

  const g3 = await game(ca, cb);
  await mv(ca, g3, 'e2e4');
  await mv(cb, g3, 'e7e5');
  ok('c. abort at ply 2 → 409 too_late', (await act(ca, g3, 'abort')).json.error === 'too_late');
  tick();
  res = await act(ca, g3, 'draw', { action: 'offer' });
  ok('c. white offers a draw → draw_offer_by 1; black sees draw_accept + draw_decline',
    res.status === 200 && row(g3).draw_offer_by === 1 && (await view(cb, g3)).actions.join() === 'resign,draw_accept,draw_decline');
  ok('c. the offerer cannot accept their own offer → 409 no_draw_offer', (await act(ca, g3, 'draw', { action: 'accept' })).json.error === 'no_draw_offer');
  ok('c. an unknown action → 400', (await act(ca, g3, 'draw', { action: 'claim' })).json.field === 'action');
  ok('c. …a refused move by the other side leaves the offer standing',
    (await act(cb, g3, 'move', { ply: 2, move: 'b8c6' })).json.error === 'not_your_turn' && row(g3).draw_offer_by === 1);
  await mv(ca, g3, 'g1f3');
  ok('c. a move clears the offer (§19.8 step 5)', row(g3).draw_offer_by === null && row(g3).ply === 3);
  tick();
  await act(cb, g3, 'draw', { action: 'offer' });
  tick();
  res = await act(ca, g3, 'draw', { action: 'decline' });
  ok('c. an explicit decline clears it', res.status === 200 && row(g3).draw_offer_by === null);
  tick();
  await act(ca, g3, 'draw', { action: 'offer' });
  tick();
  res = await act(cb, g3, 'draw', { action: 'offer' });      // an offer meeting theirs = accept
  ok('c. offering while the other side\'s offer stands → draw by agreement', res.status === 200 && row(g3).state === 'finished'
    && row(g3).result === 'draw' && row(g3).reason === 'agreement');
  ok('c. …rated (first of the day for this pair): 5 points each, ratings move 0, results_daily has a draw each',
    row(g3).rated === 1 && refs(A, 'match_result', g3) === 1 && refs(B, 'match_result', g3) === 1
    && bal(A).points === 5 && bal(B).points === 5 && rating(A).rating === 1200 && rating(A).draws === 1 && rating(B).games === 1
    && one("SELECT draws FROM results_daily WHERE address = ? AND mode = 'pvp'", A).draws === 1);
  ok('c. a settled match refuses further actions → 409 not_active', (await act(ca, g3, 'resign')).json.error === 'not_active'
    && (await act(ca, g3, 'draw', { action: 'offer' })).json.error === 'not_active');
  ok('c. draw/abort on a bot match → 400 mode_unavailable', await (async () => {
    const bm = await post('/play/api/matches', { game_id: 'chess', mode: 'bot', bot_level: 1, colour: 'seat1' }, { cookie: cc });
    const x = await act(cc, bm.json.match.id, 'draw', { action: 'offer' });
    const y = await act(cc, bm.json.match.id, 'abort');
    await act(cc, bm.json.match.id, 'resign');
    return x.json.error === 'mode_unavailable' && y.json.error === 'mode_unavailable';
  })());

  // Checkmate + rated win (2nd of the day for A–B), seats swapped: B white.
  const g4 = await game(cb, ca);
  await foolsMate(g4, cb, ca);     // A (black) mates
  ok('c. fool\'s mate → finished, seat2 (A) wins by checkmate, rated',
    row(g4).state === 'finished' && row(g4).result === 'seat2' && row(g4).reason === 'checkmate' && row(g4).rated === 1);
  ok('c. …the winner gets pvp_win (10), the loser nothing; Elo ±12 from equal ratings',
    bal(A).points === 15 && bal(B).points === 5 && refs(B, 'match_result', g4) === 0
    && rating(A).rating === 1212 && rating(B).rating === 1188 && rating(A).wins === 1 && rating(B).losses === 1);

  // Timeout at ply ≥ 2: the side to move loses (3rd rated of the day, both seat orders counted).
  const g5 = await game(ca, cb);
  await mv(ca, g5, 'd2d4');
  await mv(cb, g5, 'd7d5');
  T += (259200 + 1) * 1000;        // the default move time, 3 days
  res = await act(ca, g5, 'move', { ply: 2, move: 'c2c4' });   // no read first: a read would finalise it
  ok('c. a move after the deadline → 409 timeout, and the match is settled then (white loses)',
    res.status === 409 && res.json.error === 'timeout' && row(g5).result === 'seat2' && row(g5).reason === 'timeout');
  ok('c. …a second move → 409 not_active; points paid once', (await mv(ca, g5, 'c2c4')).json.error === 'not_active'
    && refs(B, 'match_result', g5) === 1);
  ok('c. the day rolled over (3 days later): this one is rated again', row(g5).rated === 1);

  // ── [d] the pair cap, in both seat orders ───────────────────────────────────────────
  console.log('\n[d] rated pair cap per UTC day\n');
  T = (Math.floor(T / 86400000) + 1) * 86400000 + 8 * 3600000;   // the next UTC day, 08:00 (the clock never goes back)
  const pts0 = { a: bal(A).points, b: bal(B).points };
  const gamesA0 = rating(A).games;
  const dayD = new Date(T).toISOString().slice(0, 10);
  const ids = [];
  for (let i = 0; i < 4; i++) {
    const wc = i % 2 === 0 ? ca : cb, bc = i % 2 === 0 ? cb : ca;
    const id = await game(wc, bc);
    await foolsMate(id, wc, bc);          // black wins each time
    ids.push(id);
  }
  ok('d. 3 rated, the 4th between the same pair (either seat order) unrated',
    ids.map((i) => row(i).rated).join() === '1,1,1,0', ids.map((i) => row(i).rated).join());
  const d4 = ids[3];   // B black won
  ok('d. …the unrated one pays no points, moves no rating, writes no results_daily',
    refs(A, 'match_result', d4) === 0 && rating(A).games === gamesA0 + 3
    && one("SELECT SUM(games) AS g FROM results_daily WHERE address = ? AND mode = 'pvp' AND day = ?", A, dayD).g === 3);
  ok('d. the three rated ones paid: B won two (+20), A one (+10)', bal(A).points - pts0.a === 10 && bal(B).points - pts0.b === 20,
    `${bal(A).points - pts0.a} ${bal(B).points - pts0.b}`);
  const unratedRating = rating(A).rating;
  T += 86400 * 1000;
  const dNext = await game(ca, cb);
  await foolsMate(dNext, ca, cb);
  ok('d. the next UTC day the pair is rated again', row(dNext).rated === 1 && rating(A).rating !== unratedRating);
  settings.set('pair_rated_daily', 0);
  const dOff = await game(cc, cd);
  ok('d. pair_rated_daily 0 → no PvP match is rated', await (async () => { await foolsMate(dOff, cc, cd); return row(dOff).rated === 0 && refs(D, 'match_result', dOff) === 0; })());
  settings.set('pair_rated_daily', 3);

  // ── [e] ratings recompute + admin void ──────────────────────────────────────────────
  console.log('\n[e] recompute == incremental; admin void\n');
  // A few more rated games across three players, one per pair per day.
  for (const [wc, bc] of [[cc, ca], [ca, cc], [cb, cc]]) {
    T += 86400 * 1000;
    const id = await game(wc, bc);
    await foolsMate(id, wc, bc);
  }
  const snap = all("SELECT address, rating, games, wins, draws, losses, updated_at FROM ratings WHERE game_id = 'chess' ORDER BY address");
  const rc = db.transaction(() => matches.ratings.recompute('chess'));
  const again = all("SELECT address, rating, games, wins, draws, losses, updated_at FROM ratings WHERE game_id = 'chess' ORDER BY address");
  ok('e. a recompute from the match history equals what the incremental updates built',
    JSON.stringify(snap) === JSON.stringify(again) && rc.players === snap.length, `${JSON.stringify(snap)} ## ${JSON.stringify(again)}`);
  ok('e. ratings are zero-sum: Σ(rating − 1200) = 0', snap.reduce((s, r) => s + r.rating - 1200, 0) === 0);

  // Independent replay (the test's own arithmetic) of every rated finished match.
  function replayRatings(excludeId) {
    const tab = new Map();
    const g = (a) => tab.get(a) || 1200;
    for (const m of all("SELECT id, seat1, seat2, result FROM matches WHERE game_id = 'chess' AND mode = 'pvp' AND state = 'finished' AND rated = 1 ORDER BY finished_at, id")) {
      if (m.id === excludeId) continue;
      const d = eloDelta(g(m.seat1), g(m.seat2), m.result === 'seat1' ? 1 : m.result === 'draw' ? 0.5 : 0);
      const r1 = g(m.seat1), r2 = g(m.seat2);
      tab.set(m.seat1, r1 + d); tab.set(m.seat2, r2 - d);
    }
    return tab;
  }
  const exp0 = replayRatings(null);
  ok('e. …and equals the test\'s own Elo replay', snap.every((r) => exp0.get(r.address) === r.rating));

  // Void g4 (A won by checkmate, rated, 10 points).
  const aPts = bal(A).points;
  const aWinsDay = one("SELECT wins, points, games FROM results_daily WHERE address = ? AND mode = 'pvp' AND day = ?", A, new Date(row(g4).finished_at * 1000).toISOString().slice(0, 10));
  res = await adm('POST', `matches/${g4}/void`, { reason: 'test void' });
  ok('e. void without step-up → 403 step_up_required, nothing changed', res.status === 403 && res.json.error === 'step_up_required' && row(g4).state === 'finished');
  res = await adm('POST', `matches/${g4}/void`, { reason: 'test void' }, { stepup: true });
  ok('e. void a finished rated match: state void, result kept for the record', res.status === 200 && row(g4).state === 'void'
    && row(g4).result === 'seat2' && res.json.voided.from === 'finished', res.text);
  ok('e. …its 10 points reversed with ONE admin_void row, results_daily loses the win',
    bal(A).points === aPts - 10 && refs(A, 'admin_void', g4) === 1
    && one("SELECT wins, points, games FROM results_daily WHERE address = ? AND mode = 'pvp' AND day = ?", A, new Date(row(g4).finished_at * 1000).toISOString().slice(0, 10)).wins === aWinsDay.wins - 1);
  const exp1 = replayRatings(g4);
  const after = all("SELECT address, rating FROM ratings WHERE game_id = 'chess'");
  ok('e. …ratings recomputed without it (= the independent replay excluding it)', after.every((r) => exp1.get(r.address) === r.rating)
    && res.json.voided.ratings && res.json.voided.ratings.matches === all("SELECT id FROM matches WHERE mode = 'pvp' AND state = 'finished' AND rated = 1").length);
  ok('e. …and one mod_actions row names the admin and the match', one("SELECT COUNT(*) AS n FROM mod_actions WHERE action = 'match_void' AND target = ? AND admin_user = 'alice'", `m:${g4}`).n === 1);
  res = await adm('POST', `matches/${g4}/void`, {}, { stepup: true });
  ok('e. voiding it again → 409 not_voidable, no second reversal', res.json.error === 'not_voidable' && refs(A, 'admin_void', g4) === 1);
  ok('e. an aborted match → 409 not_voidable; an unknown id → 404',
    (await adm('POST', `matches/${g1}/void`, {}, { stepup: true })).json.error === 'not_voidable'
    && (await adm('POST', 'matches/999999/void', {}, { stepup: true })).status === 404);
  const gv = await game(ca, cb);
  await mv(ca, gv, 'e2e4');
  await mv(cb, gv, 'e7e5');
  res = await adm('POST', `matches/${gv}/void`, {}, { stepup: true });
  ok('e. void an ACTIVE match → void, no result, both sides refunded once', res.status === 200 && row(gv).state === 'void'
    && row(gv).result === null && refs(A, 'match_refund', gv) === 1 && refs(B, 'match_refund', gv) === 1);
  const so = await create(cd);
  res = await adm('POST', `matches/${so.json.match.id}/void`, {}, { stepup: true });
  ok('e. void an open seek → void, the creator refunded', res.status === 200 && row(so.json.match.id).state === 'void'
    && refs(D, 'match_refund', so.json.match.id) === 1);
  ok('e. a bad void reason → 400', (await adm('POST', `matches/${g5}/void`, { reason: '' + 'x'.repeat(201) }, { stepup: true })).json.field === 'reason');
  // A FREE match (pvp_play_cost 0) enters no results_daily row, and voiding one takes nothing
  // off a paid match's row of the same day (§19.15 Part 11 review).
  T += 86400 * 1000;
  const gp = await game(ca, cb);
  await foolsMate(gp, ca, cb);
  const rdDay = new Date(row(gp).finished_at * 1000).toISOString().slice(0, 10);
  const rdOf = (a) => JSON.stringify(one("SELECT games, wins, draws, losses, points FROM results_daily WHERE address = ? AND game_id = 'chess' AND mode = 'pvp' AND day = ?", a, rdDay));
  const paidA = rdOf(A), paidB = rdOf(B);
  settings.set('pvp_play_cost', 0);
  const gf = await game(ca, cb);
  await foolsMate(gf, ca, cb);
  ok('e. a free rated match moves no results_daily row', row(gf).rated === 1 && row(gf).state === 'finished' && rdOf(A) === paidA && rdOf(B) === paidB);
  res = await adm('POST', `matches/${gf}/void`, {}, { stepup: true });
  ok('e. …and voiding it leaves the paid match\'s row of that day intact', res.status === 200 && rdOf(A) === paidA && rdOf(B) === paidB, res.text);
  settings.set('pvp_play_cost', 1);
  ok('e. the admin player view lists matches with rated + ply (for the Players page)', await (async () => {
    const p = await adm('GET', `players/${A}`);
    return p.status === 200 && p.json.matches.length > 0 && p.json.matches.every((m) => typeof m.rated === 'boolean' && Number.isInteger(m.ply));
  })());

  // ── [f] boards, invariants, leak check, query plans ─────────────────────────────────
  console.log('\n[f] rating board, invariants, public leak check, EXPLAIN\n');
  const lb = await get('/play/api/leaderboard?board=rating&game=chess');
  ok('f. the rating board shows players with ≥ 5 rated games, masked', lb.status === 200 && lb.json.unit === 'rating'
    && lb.json.rows.every((r) => !FULL_ADDR_RE.test(r.name)) && lb.json.rows.length >= 1, lb.text);
  const pvpWins = await get('/play/api/leaderboard?board=wins&game=chess&mode=pvp&period=all');
  ok('f. the PvP wins board reads results_daily (rated only)', pvpWins.status === 200 && pvpWins.json.rows.length >= 1);

  ok('f. the plays/points ledger invariant holds', ledger.verify().length === 0, JSON.stringify(ledger.verify().slice(0, 3)));
  ok('f. no balance ever below 0', one('SELECT COUNT(*) AS n FROM players WHERE plays < 0 OR points < 0').n === 0);
  ok('f. no match has both a refund and points for one seat', one(
    "SELECT COUNT(*) AS n FROM ledger a JOIN ledger b ON a.ref = b.ref AND a.address = b.address WHERE a.reason = 'match_refund' AND b.reason = 'match_result'").n === 0);
  ok('f. no seat refunded more than it paid', one(
    "SELECT COUNT(*) AS n FROM (SELECT address, ref, SUM(CASE WHEN reason = 'match_refund' THEN 1 ELSE 0 END) AS r, SUM(CASE WHEN reason = 'match_cost' THEN 1 ELSE 0 END) AS c " +
    "FROM ledger WHERE ref LIKE 'm:%' GROUP BY address, ref) WHERE r > c").n === 0);
  ok('f. no self-match exists', one('SELECT COUNT(*) AS n FROM matches WHERE seat1 = seat2').n === 0);
  ok('f. every public answer (lobby, spectator views, boards) is free of full addresses',
    publicTexts.length > 5 && publicTexts.every((x) => !FULL_ADDR_RE.test(x.replace(/^\S+ /, ''))),
    (publicTexts.find((x) => FULL_ADDR_RE.test(x.replace(/^\S+ /, ''))) || '').slice(0, 200));
  ok('f. the lobby is capped at 50', LOBBY_MAX === 50);

  const plan = (sql, ...a) => db.raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...a).map((r) => r.detail).join(' | ');
  const pLobby = plan("SELECT id FROM matches WHERE state = 'seek' AND turn_deadline > ? ORDER BY turn_deadline DESC LIMIT 50", 1);
  const pIncoming = plan("SELECT id FROM matches INDEXED BY idx_matches_target WHERE target = ? AND state = 'challenge' AND turn_deadline > ? ORDER BY id DESC LIMIT 50", A, 1);
  const pPair = plan("SELECT (SELECT COUNT(*) FROM matches WHERE game_id = ? AND seat1 = ? AND seat2 = ? AND finished_at >= ? AND state = 'finished' AND rated = 1) + " +
    "(SELECT COUNT(*) FROM matches WHERE game_id = ? AND seat1 = ? AND seat2 = ? AND finished_at >= ? AND state = 'finished' AND rated = 1) AS n", 'chess', A, B, 1, 'chess', B, A, 1);
  const pTurns = plan("SELECT id FROM matches WHERE seat1 = ? AND state = 'active' UNION ALL SELECT id FROM matches WHERE seat2 = ? AND state = 'active'", A, A);
  const pOpen = plan("SELECT (SELECT COUNT(*) FROM matches WHERE seat1 = ? AND state IN ('seek', 'challenge')) + (SELECT COUNT(*) FROM matches WHERE seat2 = ? AND state IN ('seek', 'challenge')) AS n", A, A);
  const pSweep = plan('SELECT id FROM matches WHERE state = ? AND turn_deadline <= ? ORDER BY turn_deadline LIMIT ?', 'seek', 1, 1);
  ok('f. EXPLAIN: lobby + sweep on idx_matches_state with no sort, incoming on idx_matches_target, pair cap on idx_matches_pair, turns/open cap on both seat indexes',
    /idx_matches_state/.test(pLobby) && !/TEMP B-TREE/.test(pLobby) && /idx_matches_state/.test(pSweep) && !/TEMP B-TREE/.test(pSweep)
    && /idx_matches_target/.test(pIncoming) && !/TEMP B-TREE/.test(pIncoming) && /idx_matches_pair/.test(pPair)
    && /idx_matches_seat1/.test(pTurns) && /idx_matches_seat2/.test(pTurns) && /idx_matches_seat1/.test(pOpen) && /idx_matches_seat2/.test(pOpen)
    && !/SCAN matches/.test([pLobby, pIncoming, pPair, pTurns, pOpen, pSweep].join(' ')),
    [pLobby, pIncoming, pPair, pTurns, pOpen, pSweep].join(' ## '));
  ok('f. no error was logged by the matches module', !lines.some((l) => /^error .*\[matches\]/.test(l)), lines.filter((l) => /\[matches\]/.test(l)).slice(0, 3).join(' | '));

}

main().catch((e) => {
  fail++;
  console.error(`  FAIL  suite crashed: ${e && e.stack ? e.stack : e}`);
}).finally(async () => {
  if (srv) await new Promise((r) => srv.close(r));
  try { if (db) db.close(); } catch { /* already closed */ }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }
  console.log(`\nRESULT pass=${pass} fail=${fail}`);
  process.exitCode = fail ? 1 : 0;
});
