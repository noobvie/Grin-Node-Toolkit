'use strict';

// Matches — the v1 `match` kind (design §19.8): BOT mode (Part 5) and PvP correspondence
// between two addresses (Part 10), on one engine.
//
//   GET  /play/api/games                          the loaded games (public)
//   POST /play/api/matches                        bot:  { game_id, mode:'bot', bot_level, colour?, move_seconds? }
//                                                 pvp:  { game_id, mode:'pvp', colour?, move_seconds?, target? }
//                                                       no target = an open SEEK; a target = a direct CHALLENGE
//   GET  /play/api/lobby                          open seeks (public) + the caller's incoming challenges
//   GET  /play/api/matches/mine?state=&before=    the caller's matches, 20 per page, newest first
//   GET  /play/api/matches/turns                  the cheap poll: whose move, incoming challenges
//   GET  /play/api/matches/:id?since_ply=         one match (public while mode ≠ off; seats masked)
//   POST /play/api/matches/:id/move               { ply, move }
//   POST /play/api/matches/:id/resign             {}
//   POST /play/api/matches/:id/accept             {}            seek: anyone else · challenge: its target
//   POST /play/api/matches/:id/decline            {}            challenge target
//   POST /play/api/matches/:id/cancel             {}            the creator, before anyone accepts
//   POST /play/api/matches/:id/draw               { action:'offer'|'accept'|'decline' }   PvP
//   POST /play/api/matches/:id/abort              {}            PvP, while ply < 2
//   POST /internal/admin/matches/:id/void         { reason? }   admin, step-up (§19.11)
//
// The server holds the ONLY game state. The client sends a move and the ply it believes is
// current — never a position, a result, a score or points — and every move goes through
// rules.apply() on the server. A bot game is played move by move here too, with the bot's
// reply computed in the same request (D20): a bot running in the browser would let a player
// try lines and take them back.
//
// Every state change is ONE `BEGIN IMMEDIATE` transaction (db.transaction), so two racing
// requests serialise: the second re-reads the match and fails the ply check (409 stale),
// finds it finished (409 not_active), finds the seat taken (409 not_open), or finds its bot
// slot taken (409 active_match). Exactly-once plays/points effects rest on two guards, not
// one: every state transition is an `UPDATE … WHERE state = <expected>` that must change
// exactly one row, and every ledger row carries a unique ref `m:<id>:<seat>` (uq_ledger_ref),
// so a match can neither settle twice, nor refund twice, nor be both settled and refunded.
//
// PvP (§19.6, §19.8):
//   - Each side pays the play cost recorded in the match at creation: the creator at create,
//     the acceptor at accept. Refunds (match_refund, ref m:<id>:<seat>): the creator when a
//     seek/challenge is declined, expires (72 h) or is cancelled; both sides when a match is
//     aborted (or times out, or is resigned) before each side has moved once (ply < 2).
//   - A seek/challenge's `turn_deadline` is its EXPIRY, so the timeout sweep and the lazy
//     checks cover it on the same index as an active match's move deadline.
//   - RATED is decided when the match settles, inside that transaction: fewer than
//     `pair_rated_daily` rated matches between the two addresses this UTC day, counted on
//     idx_matches_pair in both seat orders. Only a rated match moves `ratings`, pays PvP
//     points, and enters results_daily — so the pair cap also bounds every board and event
//     built on results_daily, not just the points.
//
// rules.js is game code: every call goes through call(), which turns a throw or a malformed
// return into 500 `game_error`. Because the call happens inside the transaction, the throw
// also rolls the match back — a broken rules.js leaves the match exactly as it was, and
// the service up (§19.7).
//
// The match's seed is never sent to a client. The bot is deterministic given (position,
// level, seed, ply); with the seed a player could replay the bot's tie-breaks offline.

const crypto = require('node:crypto');
const { HttpError, parseIntStrict } = require('./http');
const { LedgerError } = require('./ledger');
const { MASK_ONLY } = require('./names');
const { createTokenBuckets } = require('./ratelimit');
const { utcDay } = require('./plays');
const { GRIN_ADDR_RE } = require('./pool-link');
const { NO_TICKETS } = require('./tickets');
const { createRatings } = require('./ratings');
const { normaliseBody } = require('./chat');

const MATCH_BODY_LIMIT = 1024;
const PAGE = 20;
const POSITION_MAX = 512;
const MOVE_MAX = 16;
const REASON_RE = /^[a-z_]{1,16}$/;
const RESULTS = new Set(['seat1', 'seat2', 'draw']);
const STATES = new Set(['seek', 'challenge', 'active', 'finished', 'aborted', 'declined', 'expired', 'void']);
const OPEN_STATES = new Set(['seek', 'challenge']);
const COLOURS = new Set(['seat1', 'seat2', 'random']);
const DRAW_ACTIONS = new Set(['offer', 'accept', 'decline']);
// ≤ 1 move/s per ADDRESS (§19.8 says per session; an address with 20 sessions would get 20),
// with a burst of 3 so a double-click answers 409 stale, not 429. Draw actions share it.
const MOVE_RATE = Object.freeze({ capacity: 3, refillPerSec: 1 });
const SLOW_BOT_MS = 250;
// Timeout sweep: at most this many matches per state per 5-min tick, oldest deadline first.
const SWEEP_BATCH = 200;
const SWEEP_STATES = ['active', 'seek', 'challenge'];
// §19.8: an unaccepted seek or challenge expires after 72 h (with a refund).
const OPEN_TTL_S = 72 * 3600;
const LOBBY_MAX = 50;
const INCOMING_MAX = 50;
const VOID_REASON_MAX = 200;
// Retention (§19.8): finished bot matches lose their move list after 60 days; the match row
// stays. The purge walks match ids in order from a watermark kept in meta.
const BOT_MOVES_KEEP_S = 60 * 86400;
const PURGE_BATCH = 500;
const PURGE_META_KEY = 'bot_moves_purged_through';

const isHuman = (s) => typeof s === 'string' && s !== '' && !s.startsWith('bot:');
const seatAddr = (m, seat) => (seat === 1 ? m.seat1 : m.seat2);
const other = (seat) => (seat === 1 ? 2 : 1);
function seatOf(m, address) {
  if (typeof address !== 'string') return 0;
  if (m.seat1 === address) return 1;
  if (m.seat2 === address) return 2;
  return 0;
}
// The empty seat of a seek/challenge (the creator holds the other one).
const openSeat = (m) => (m.seat1 === null ? 1 : m.seat2 === null ? 2 : 0);
// Public labels (D19, §19.16): "Bot level N", or names.label — the mask, or `Nick (mask)` —
// never a full address.
function label(seat, names = MASK_ONLY) {
  if (seat === null || seat === undefined) return null;
  if (seat.startsWith('bot:')) return `Bot level ${seat.slice(4)}`;
  return names.label(seat);
}
// A passed deadline: an active match's move clock, or a seek/challenge's 72 h expiry.
const expired = (m, t) => (m.state === 'active' || OPEN_STATES.has(m.state)) && m.turn_deadline !== null && t >= m.turn_deadline;
const dayStart = (t) => Math.floor(t / 86400) * 86400;

// Return-value checks for rules.js calls.
const isPos = (v) => typeof v === 'string' && v.length > 0 && v.length <= POSITION_MAX;
const isPosOrNull = (v) => v === null || isPos(v);
const isSeatNum = (v) => v === 1 || v === 2;
const isMoveList = (v) => Array.isArray(v) && v.length <= 1000 && v.every((x) => typeof x === 'string' && x.length <= MOVE_MAX);
const isStatus = (v) => v !== null && typeof v === 'object' && (v.over === false
  || (v.over === true && RESULTS.has(v.result) && typeof v.reason === 'string' && REASON_RE.test(v.reason)));

function createMatches({ db, registry, ledger, settings, sessions, auth, admin, config, log, names = MASK_ONLY, tickets = NO_TICKETS, now = () => Math.floor(Date.now() / 1000) }) {
  const raw = db.raw;
  const prefix = config && config.net === 'testnet' ? 'tgrin1' : 'grin1';
  const ratings = createRatings({ db });
  const moveLimit = createTokenBuckets({ ...MOVE_RATE, clock: () => now() * 1000 });
  const cols = 'id, game_id, game_version, mode, state, seat1, seat2, created_by, target, params_json, seed, position, ply, ' +
    'turn_deadline, draw_offer_by, result, reason, rated, created_at, started_at, finished_at, last_move_at';
  const stmts = {
    get: raw.prepare(`SELECT ${cols} FROM matches WHERE id = ?`),
    activeBot: raw.prepare(`SELECT ${cols} FROM matches WHERE game_id = ? AND created_by = ? AND mode = 'bot' AND state = 'active'`),
    insert: raw.prepare(
      'INSERT INTO matches (game_id, game_version, mode, state, seat1, seat2, created_by, target, params_json, seed, position, ply, ' +
      'turn_deadline, created_at, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)'),
    moves: raw.prepare('SELECT ply, move FROM match_moves WHERE match_id = ? ORDER BY ply'),
    movesSince: raw.prepare('SELECT move FROM match_moves WHERE match_id = ? AND ply >= ? ORDER BY ply'),
    lastMove: raw.prepare('SELECT move FROM match_moves WHERE match_id = ? AND ply = ?'),
    insertMove: raw.prepare('INSERT INTO match_moves (match_id, ply, seat, move, at) VALUES (?, ?, ?, ?, ?)'),
    updatePos: raw.prepare(
      'UPDATE matches SET position = ?, ply = ?, last_move_at = ?, turn_deadline = ?, draw_offer_by = NULL ' +
      "WHERE id = ? AND state = 'active' AND ply = ?"),
    finish: raw.prepare(
      "UPDATE matches SET state = 'finished', result = ?, reason = ?, finished_at = ?, turn_deadline = NULL, draw_offer_by = NULL " +
      "WHERE id = ? AND state = 'active'"),
    // An active match ending without a result: 'aborted' (ply < 2, timeouts included) or
    // 'void' (the admin).
    endActive: raw.prepare(
      'UPDATE matches SET state = ?, reason = ?, finished_at = ?, turn_deadline = NULL, draw_offer_by = NULL ' +
      "WHERE id = ? AND state = 'active'"),
    // A seek/challenge ending before anyone accepted: declined | expired | aborted (cancel) | void.
    endOpen: raw.prepare(
      "UPDATE matches SET state = ?, reason = ?, finished_at = ?, turn_deadline = NULL WHERE id = ? AND state IN ('seek', 'challenge')"),
    // Voiding a FINISHED match keeps its result and reason for the record; the state says void.
    voidFinished: raw.prepare("UPDATE matches SET state = 'void' WHERE id = ? AND state = 'finished'"),
    accept1: raw.prepare(
      "UPDATE matches SET state = 'active', seat1 = ?, started_at = ?, turn_deadline = ? WHERE id = ? AND state IN ('seek', 'challenge') AND seat1 IS NULL"),
    accept2: raw.prepare(
      "UPDATE matches SET state = 'active', seat2 = ?, started_at = ?, turn_deadline = ? WHERE id = ? AND state IN ('seek', 'challenge') AND seat2 IS NULL"),
    setDraw: raw.prepare("UPDATE matches SET draw_offer_by = ? WHERE id = ? AND state = 'active'"),
    setRated: raw.prepare('UPDATE matches SET rated = 1 WHERE id = ?'),
    playerDay: raw.prepare('SELECT points_day, points_today FROM players WHERE address = ?'),
    setPointsDay: raw.prepare('UPDATE players SET points_day = ?, points_today = ? WHERE address = ?'),
    points: raw.prepare('SELECT points FROM players WHERE address = ?'),
    results: raw.prepare(
      'INSERT INTO results_daily (address, game_id, mode, day, games, wins, draws, losses, points) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?) ' +
      'ON CONFLICT(address, game_id, mode, day) DO UPDATE SET games = games + 1, wins = wins + excluded.wins, ' +
      'draws = draws + excluded.draws, losses = losses + excluded.losses, points = points + excluded.points'),
    unresults: raw.prepare(
      'UPDATE results_daily SET games = games - 1, wins = wins - ?, draws = draws - ?, losses = losses - ?, points = points - ? ' +
      'WHERE address = ? AND game_id = ? AND mode = ? AND day = ? AND games >= 1 AND wins >= ? AND draws >= ? AND losses >= ? AND points >= ?'),
    credited: raw.prepare("SELECT delta FROM ledger WHERE address = ? AND kind = 'points' AND reason = 'match_result' AND ref = ?"),
    // idx_matches_pair (game_id, seat1, seat2, finished_at), once per seat order.
    pairRated: raw.prepare(
      "SELECT (SELECT COUNT(*) FROM matches WHERE game_id = ? AND seat1 = ? AND seat2 = ? AND finished_at >= ? AND state = 'finished' AND rated = 1) + " +
      "(SELECT COUNT(*) FROM matches WHERE game_id = ? AND seat1 = ? AND seat2 = ? AND finished_at >= ? AND state = 'finished' AND rated = 1) AS n"),
    // idx_matches_seat1 / idx_matches_seat2 (seat, state)
    activePvp: raw.prepare(
      "SELECT (SELECT COUNT(*) FROM matches WHERE seat1 = ? AND state = 'active' AND mode = 'pvp') + " +
      "(SELECT COUNT(*) FROM matches WHERE seat2 = ? AND state = 'active' AND mode = 'pvp') AS n"),
    openOf: raw.prepare(
      `SELECT ${cols} FROM matches WHERE seat1 = ? AND state IN ('seek', 'challenge') UNION ALL ` +
      `SELECT ${cols} FROM matches WHERE seat2 = ? AND state IN ('seek', 'challenge')`),
    openMine: raw.prepare(
      "SELECT (SELECT COUNT(*) FROM matches WHERE seat1 = ? AND state IN ('seek', 'challenge')) + " +
      "(SELECT COUNT(*) FROM matches WHERE seat2 = ? AND state IN ('seek', 'challenge')) AS n"),
    // idx_matches_state (state, turn_deadline). A seek's deadline is created_at + 72 h, so
    // the deadline order IS newest first, with no sort.
    lobby: raw.prepare(`SELECT ${cols} FROM matches WHERE state = 'seek' AND turn_deadline > ? ORDER BY turn_deadline DESC LIMIT ${LOBBY_MAX}`),
    // idx_matches_target (target, state), NAMED: with no table statistics the planner picks
    // idx_matches_state instead, which walks every open challenge in the pool to find one
    // address's. INDEXED BY also fails the prepare loudly if the index is ever dropped. Rows
    // of one index key are in rowid order, so ORDER BY id needs no sort.
    incoming: raw.prepare(
      `SELECT ${cols} FROM matches INDEXED BY idx_matches_target WHERE target = ? AND state = 'challenge' AND turn_deadline > ? ` +
      `ORDER BY id DESC LIMIT ${INCOMING_MAX}`),
    incomingCount: raw.prepare(
      "SELECT COUNT(*) AS n FROM matches INDEXED BY idx_matches_target WHERE target = ? AND state = 'challenge' AND turn_deadline > ?"),
    myActive: raw.prepare(
      "SELECT id, game_id, position, draw_offer_by, seat1, seat2, last_move_at, turn_deadline FROM matches WHERE seat1 = ? AND state = 'active' " +
      "UNION ALL SELECT id, game_id, position, draw_offer_by, seat1, seat2, last_move_at, turn_deadline FROM matches WHERE seat2 = ? AND state = 'active'"),
    expiredIn: raw.prepare('SELECT id FROM matches WHERE state = ? AND turn_deadline <= ? ORDER BY turn_deadline LIMIT ?'),
    myExpired: raw.prepare(
      "SELECT id FROM matches WHERE seat1 = ? AND state IN ('active', 'seek', 'challenge') AND turn_deadline <= ? " +
      "UNION ALL SELECT id FROM matches WHERE seat2 = ? AND state IN ('active', 'seek', 'challenge') AND turn_deadline <= ?"),
    mine: raw.prepare(
      `SELECT ${cols} FROM (SELECT ${cols} FROM matches WHERE seat1 = ? AND id < ? ` +
      `UNION ALL SELECT ${cols} FROM matches WHERE seat2 = ? AND id < ?) ORDER BY id DESC LIMIT ${PAGE}`),
    mineState: raw.prepare(
      `SELECT ${cols} FROM (SELECT ${cols} FROM matches WHERE seat1 = ? AND state = ? AND id < ? ` +
      `UNION ALL SELECT ${cols} FROM matches WHERE seat2 = ? AND state = ? AND id < ?) ORDER BY id DESC LIMIT ${PAGE}`),
    purgeScan: raw.prepare('SELECT id, mode, state, finished_at FROM matches WHERE id > ? ORDER BY id LIMIT ?'),
    purgeMoves: raw.prepare('DELETE FROM match_moves WHERE match_id = ?'),
    metaGet: raw.prepare('SELECT value FROM meta WHERE key = ?'),
    metaSet: raw.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
  };

  function parseParams(m) {
    try {
      const p = JSON.parse(m.params_json);
      if (p && typeof p === 'object') return p;
    } catch { /* fall through */ }
    log.error(`[matches] match ${m.id} has unreadable params_json`);
    throw new HttpError(500, 'game_error');
  }

  // One rules.js call. A throw or a malformed return → 500 game_error (and, inside a
  // transaction, a rollback). The log names the game and the function, never request data.
  function call(game, fn, args, valid, matchId) {
    let v;
    try {
      v = game.rules[fn](...args);
    } catch (e) {
      log.error(`[matches] ${game.id} rules.${fn} threw${matchId ? ` (match ${matchId})` : ''}: ${e && e.message ? String(e.message).slice(0, 200) : 'error'}`);
      throw new HttpError(500, 'game_error');
    }
    if (!valid(v)) {
      log.error(`[matches] ${game.id} rules.${fn} returned an invalid value${matchId ? ` (match ${matchId})` : ''}`);
      throw new HttpError(500, 'game_error');
    }
    return v;
  }

  const isMoveFor = (game) => (v) => typeof v === 'string' && v.length <= MOVE_MAX && game.moveRe.test(v);

  function corrupt(m, why) {
    log.error(`[matches] match ${m.id} does not replay (${why}) — left unchanged`);
    throw new HttpError(500, 'game_error');
  }

  // Rebuilds every position of the match from its move list: [initial, …, current]. The
  // history feeds rules.status (repetition), and the replay doubles as an integrity check —
  // it must land exactly on the stored position. Cost: one apply() per ply, ≤ max_plies.
  function replay(game, m) {
    const rows = stmts.moves.all(m.id);
    if (rows.length !== m.ply) corrupt(m, `${rows.length} moves for ply ${m.ply}`);
    const params = parseParams(m);
    let pos = call(game, 'initial', [{ ...params }], isPos, m.id);
    const positions = [pos];
    for (const r of rows) {
      pos = call(game, 'apply', [pos, r.move], isPosOrNull, m.id);
      if (pos === null) corrupt(m, `stored move at ply ${r.ply} is illegal`);
      positions.push(pos);
    }
    if (pos !== m.position) corrupt(m, 'replay does not reach the stored position');
    return positions;
  }

  // → { result, reason } when the game is over, else null. max_plies is enforced here for
  // every game, whatever its rules.js does (§19.7 manifest field).
  function outcome(game, positions, m) {
    const pos = positions[positions.length - 1];
    const st = call(game, 'status', [pos, positions.slice(0, -1)], isStatus, m.id);
    if (st.over) return { result: st.result, reason: st.reason };
    if (positions.length - 1 >= game.manifest.max_plies) return { result: 'draw', reason: 'max_plies' };
    return null;
  }

  // Applies one move for `seat`. → false when rules.apply says it is illegal (nothing written).
  function playOne(m, game, positions, seat, move, t) {
    const next = call(game, 'apply', [positions[positions.length - 1], move], isPosOrNull, m.id);
    if (next === null) return false;
    const params = parseParams(m);
    stmts.insertMove.run(m.id, m.ply, seat, move, t);
    const r = stmts.updatePos.run(next, m.ply + 1, t, t + params.move_seconds, m.id, m.ply);
    if (r.changes !== 1) throw new Error(`match ${m.id} changed under a held write lock`);
    m.ply += 1;
    m.position = next;
    m.last_move_at = t;
    m.turn_deadline = t + params.move_seconds;
    m.draw_offer_by = null;          // a move declines a pending draw offer (§19.8 step 5)
    positions.push(next);
    return true;
  }

  // After any move: settle if the game is over, else let every bot seat that is to move
  // play, until a human is to move or the game ends. Bounded by max_plies (outcome()).
  function advance(m, game, positions, t) {
    for (;;) {
      const over = outcome(game, positions, m);
      if (over) { settle(m, game, over.result, over.reason, t); return; }
      const seat = call(game, 'toMove', [m.position], isSeatNum, m.id);
      const who = seatAddr(m, seat);
      if (isHuman(who)) return;
      const level = Number(String(who).slice(4));
      const t0 = Date.now();
      const move = call(game, 'bot', [m.position, level, m.seed, m.ply], isMoveFor(game), m.id);
      const ms = Date.now() - t0;
      if (ms > SLOW_BOT_MS) log.warn(`[matches] slow bot move ${ms}ms (${game.id} level ${level}, match ${m.id})`);
      if (!playOne(m, game, positions, seat, move, t)) {
        log.error(`[matches] ${game.id} rules.bot returned an illegal move (match ${m.id})`);
        throw new HttpError(500, 'game_error');
      }
    }
  }

  // Points for one human seat (§19.6). A match pays points only out of a SPENT play: a free
  // game (cost 0) pays nothing — plays come from mining (D10), and a free game would be a
  // points tap that needs no mining at all (§19.15 Part 5 #2). PvP pays only when rated.
  function pointsFor(game, m, params, res) {
    if (!(params.cost > 0)) return 0;
    const pts = game.manifest.points;
    if (m.mode === 'pvp') {
      if (m.rated !== 1) return 0;
      return res === 'win' ? pts.pvp_win : res === 'draw' ? pts.pvp_draw : 0;
    }
    const base = pts.bot[String(params.bot_level)] || 0;
    if (res === 'win') return base;
    if (res === 'draw') return Math.floor(base / 2);
    return 0;
  }

  // Credits points under the per-address daily cap. → the points actually credited.
  function award(address, pts, ref, t, day) {
    const row = stmts.playerDay.get(address);
    const today = row && row.points_day === day ? row.points_today : 0;
    const got = Math.min(pts, Math.max(0, settings.get('points_daily_cap') - today));
    if (got <= 0) return 0;
    const r = ledger.post({ address, kind: 'points', delta: got, reason: 'match_result', ref });
    if (r.duplicate) return 0;
    stmts.setPointsDay.run(day, today + got, address);
    return got;
  }

  // §19.8 rated rule, evaluated at settle (inside its transaction, so two settles of one pair
  // serialise and cannot both see "one left"). Both seats are addresses: a self-match is
  // refused at creation.
  function isRated(m, t) {
    const cap = settings.get('pair_rated_daily');
    if (cap <= 0) return false;
    const from = dayStart(t);
    const n = stmts.pairRated.get(m.game_id, m.seat1, m.seat2, from, m.game_id, m.seat2, m.seat1, from).n;
    return n < cap;
  }

  // Ends an active match with a result. Must run inside the caller's transaction.
  function settle(m, game, result, reason, t) {
    if (stmts.finish.run(result, reason, t, m.id).changes !== 1) throw new Error(`settle: match ${m.id} is not active`);
    Object.assign(m, { state: 'finished', result, reason, finished_at: t, turn_deadline: null, draw_offer_by: null });
    const params = parseParams(m);
    if (m.mode === 'pvp' && isRated(m, t)) {
      stmts.setRated.run(m.id);
      m.rated = 1;
      ratings.apply(m.game_id, m.seat1, m.seat2, result, t);
    }
    const day = utcDay(t);
    for (const seat of [1, 2]) {
      const who = seatAddr(m, seat);
      if (!isHuman(who)) continue;
      // An unrated PvP result counts nowhere: not in points, not in results_daily, so it
      // cannot feed a board or an event past the pair cap.
      if (m.mode === 'pvp' && m.rated !== 1) continue;
      // Nor does a FREE match (cost 0): results_daily feeds the wins boards and game_results
      // events, whose rewards skip the daily points cap, so a free level-1 bot would be the
      // same no-mining tap pointsFor() closes (§19.15 Part 11 review).
      if (!(params.cost > 0)) continue;
      const res = result === 'draw' ? 'draw' : result === `seat${seat}` ? 'win' : 'loss';
      const pts = pointsFor(game, m, params, res);
      const got = pts > 0 ? award(who, pts, `m:${m.id}:${seat}`, t, day) : 0;
      stmts.results.run(who, m.game_id, m.mode, day, res === 'win' ? 1 : 0, res === 'draw' ? 1 : 0, res === 'loss' ? 1 : 0, got);
    }
  }

  // Refunds the play each listed seat paid (§19.6). Must run inside the caller's transaction.
  // → the number of seats refunded.
  function refund(m, seats) {
    const params = parseParams(m);
    if (!(params.cost > 0)) return 0;
    let n = 0;
    for (const seat of seats) {
      const who = seatAddr(m, seat);
      if (!isHuman(who)) continue;
      const r = ledger.post({ address: who, kind: 'plays', delta: params.cost, reason: 'match_refund', ref: `m:${m.id}:${seat}` });
      if (!r.duplicate) n++;
    }
    return n;
  }

  // Ends an active match WITHOUT a result and refunds every human seat's play (§19.6).
  // state 'aborted' (ply < 2, and timeouts before it) or 'void' (the admin). Must run inside
  // the caller's transaction.
  function abort(m, reason, t, state = 'aborted') {
    if (stmts.endActive.run(state, reason, t, m.id).changes !== 1) throw new Error(`abort: match ${m.id} is not active`);
    Object.assign(m, { state, reason, finished_at: t, turn_deadline: null, draw_offer_by: null });
    return refund(m, [1, 2]);
  }

  // Ends a seek/challenge before anyone accepted, refunding its creator (the only seat
  // taken). Must run inside the caller's transaction.
  function closeOpen(m, state, reason, t) {
    if (stmts.endOpen.run(state, reason, t, m.id).changes !== 1) throw new Error(`closeOpen: match ${m.id} is not open`);
    const seat = seatOf(m, m.created_by);
    Object.assign(m, { state, reason, finished_at: t, turn_deadline: null });
    return seat ? refund(m, [seat]) : 0;
  }

  // §19.8 timeouts: the side to move loses; before each side has moved once (ply < 2) the
  // match is aborted and refunded instead. A match whose game is no longer loaded cannot
  // say who was to move, so it is aborted and refunded too. An open seek/challenge past its
  // 72 h is expired and refunded.
  function finalizeTimeout(m, game, t) {
    if (OPEN_STATES.has(m.state)) { closeOpen(m, 'expired', 'expired', t); return; }
    if (m.ply < 2 || !game) { abort(m, 'timeout', t); return; }
    const seat = call(game, 'toMove', [m.position], isSeatNum, m.id);
    settle(m, game, seat === 1 ? 'seat2' : 'seat1', 'timeout', t);
  }

  // Lazily applies a passed deadline (every read and move of a match, and the sweep).
  // → true when this call finalised it.
  function finalizeIfExpired(id, t = now()) {
    return db.transaction(() => {
      const m = stmts.get.get(id);
      if (!m || !expired(m, t)) return false;
      finalizeTimeout(m, registry.get(m.game_id), t);
      return true;
    });
  }

  // The caller's own passed deadlines (active or open), each its own transaction. Bounded:
  // ≤ one bot game per game + pvp_active_max + pvp_open_max.
  // A deleted guest's open seeks and challenges are cancelled (and refunded, which keeps the
  // ledger whole) inside the delete's transaction (guests.js). Its ACTIVE games are left to their
  // move clocks: the side that stopped moving loses on time, as for anyone who walks away.
  function closeOpenOf(address, t) {
    let n = 0;
    for (const r of stmts.openOf.all(address, address)) {
      if (r.created_by !== address) continue;
      closeOpen(r, 'aborted', 'cancelled', t);
      n++;
    }
    return n;
  }

  function expireMine(address, t) {
    for (const r of stmts.myExpired.all(address, t, address, t)) finalizeIfExpired(r.id, t);
  }

  // ── Views ───────────────────────────────────────────────────────────────────────────
  // What the caller may do next — computed here so the shell never re-derives the rules.
  function actionsFor(m, you, caller, t) {
    const a = [];
    if (OPEN_STATES.has(m.state) && !expired(m, t)) {
      if (m.created_by === caller) a.push('cancel');
      else if (m.state === 'seek' && typeof caller === 'string') a.push('accept');
      else if (m.state === 'challenge' && m.target === caller) a.push('accept', 'decline');
      return a;
    }
    if (m.state !== 'active' || you === null) return a;
    if (m.mode === 'pvp' && m.ply < 2) a.push('abort');
    else a.push('resign');
    if (m.mode === 'pvp') {
      if (m.draw_offer_by === other(you)) a.push('draw_accept', 'draw_decline');
      else if (m.draw_offer_by !== you) a.push('draw_offer');
    }
    return a;
  }

  // Fields both views share. `target` (the invited address) is shown MASKED and only to the
  // two people concerned: it is not the public's business who challenged whom.
  function common(m, caller, t) {
    const params = parseParams(m);
    const you = seatOf(m, caller) || null;
    const concerned = typeof caller === 'string' && (m.created_by === caller || m.target === caller);
    return {
      params,
      you,
      out: {
        id: m.id,
        game_id: m.game_id,
        mode: m.mode,
        state: m.state,
        labels: { 1: label(m.seat1, names), 2: label(m.seat2, names) },
        you,
        ply: m.ply,
        bot_level: m.mode === 'bot' ? params.bot_level : null,
        move_seconds: params.move_seconds,
        rated: m.rated === 1,
        draw_offer_by: m.state === 'active' ? m.draw_offer_by : null,
        open_seat: OPEN_STATES.has(m.state) ? openSeat(m) : null,
        invited: m.state === 'challenge' && typeof caller === 'string' && m.target === caller,
        target_label: concerned && m.target ? names.label(m.target) : null,
        expires_at: OPEN_STATES.has(m.state) ? m.turn_deadline : null,
        actions: actionsFor(m, you, caller, t),
        turn_deadline: m.turn_deadline,
        created_at: m.created_at,
        started_at: m.started_at,
        finished_at: m.finished_at,
        last_move_at: m.last_move_at,
      },
    };
  }

  function view(m, caller, sincePly = 0) {
    const game = registry.get(m.game_id);
    const { you, out } = common(m, caller, now());
    let toMove = null;
    let legal = null;
    if (m.state === 'active' && game) {
      toMove = call(game, 'toMove', [m.position], isSeatNum, m.id);
      if (you !== null && you === toMove) legal = call(game, 'legal', [m.position], isMoveList, m.id);
    }
    const last = m.ply > 0 ? stmts.lastMove.get(m.id, m.ply - 1) : null;
    return {
      ...out,
      game_version: m.game_version,
      to_move: toMove,
      your_turn: you !== null && you === toMove,
      position: m.position,
      last_move: last ? last.move : null,
      legal,
      status: m.state === 'active' || OPEN_STATES.has(m.state) ? { over: false } : { over: true, result: m.result, reason: m.reason },
      since_ply: sincePly,
      // A finished bot match older than 60 days has no move list any more (retention).
      moves: stmts.movesSince.all(m.id, sincePly).map((r) => r.move),
    };
  }

  function summary(m, caller) {
    const game = registry.get(m.game_id);
    const { you, out } = common(m, caller, now());
    const toMove = m.state === 'active' && game ? call(game, 'toMove', [m.position], isSeatNum, m.id) : null;
    return { ...out, your_turn: you !== null && you === toMove, result: m.result, reason: m.reason };
  }

  // ── Request parsing ─────────────────────────────────────────────────────────────────
  // Bodies are strict: an unknown key is refused (400 field 'body'), so a forged
  // `position`, `result`, `score` or `points` is never silently accepted-and-ignored.
  function body(ctx, allowed) {
    const b = ctx.body;
    if (!b || typeof b !== 'object' || Array.isArray(b)) throw new HttpError(400, 'bad_request', { field: 'body' });
    for (const k of Object.keys(b)) if (!allowed.includes(k)) throw new HttpError(400, 'bad_request', { field: 'body' });
    return b;
  }

  function matchId(ctx) {
    const id = parseIntStrict(ctx.params.id, { min: 1 });
    if (id === null) throw new HttpError(404, 'not_found');
    return id;
  }

  // One optional integer query parameter; repeated or malformed → 400.
  function qInt(ctx, name, opts) {
    const all = ctx.query.getAll(name);
    if (all.length === 0) return undefined;
    const v = all.length === 1 ? parseIntStrict(all[0], opts) : null;
    if (v === null) throw new HttpError(400, 'bad_request', { field: name });
    return v;
  }

  function noQuery(ctx) {
    for (const k of ctx.query.keys()) throw new HttpError(400, 'bad_request', { field: k });
  }

  function rateMove(address) {
    const lim = moveLimit.take(address);
    if (!lim.ok) throw new HttpError(429, 'too_many_requests', { retry_after: lim.retryAfter }, { 'Retry-After': String(lim.retryAfter) });
  }

  // Creator's seat for a colour choice; 'random' is drawn from the match seed.
  const seatFor = (colour, seed) => (colour === 'seat1' ? 1 : colour === 'seat2' ? 2 : ((parseInt(seed.slice(0, 2), 16) & 1) ? 2 : 1));

  // ── Handlers ────────────────────────────────────────────────────────────────────────
  function listGames() {
    return { ok: true, games: registry.list() };
  }

  function create(ctx) {
    const s = auth.requireSession(ctx);
    const b = body(ctx, ['game_id', 'mode', 'bot_level', 'colour', 'move_seconds', 'target']);
    const game = typeof b.game_id === 'string' ? registry.get(b.game_id) : null;
    if (!game) throw new HttpError(404, 'unknown_game');
    const man = game.manifest;
    if (!man.modes.includes(b.mode)) throw new HttpError(400, 'bad_request', { field: 'mode' });
    const colour = b.colour === undefined ? 'random' : b.colour;
    if (!COLOURS.has(colour)) throw new HttpError(400, 'bad_request', { field: 'colour' });
    const moveSeconds = b.move_seconds === undefined ? man.default_move_seconds : b.move_seconds;
    if (!man.move_seconds_options.includes(moveSeconds)) throw new HttpError(400, 'bad_request', { field: 'move_seconds' });
    return b.mode === 'pvp' ? createPvp(s, game, b, colour, moveSeconds) : createBot(s, game, b, colour, moveSeconds);
  }

  function createBot(s, game, b, colour, moveSeconds) {
    const man = game.manifest;
    if (b.target !== undefined) throw new HttpError(400, 'bad_request', { field: 'target' });
    if (!man.bot_levels.includes(b.bot_level)) throw new HttpError(400, 'bad_request', { field: 'bot_level' });
    // The cost is recorded in the match, so a later change of the setting never changes what
    // this match refunds or pays.
    const cost = settings.get('bot_play_cost');
    const t = now();
    let id;
    try {
      id = db.transaction(() => {
        const cur = stmts.activeBot.get(game.id, s.address);
        if (cur) {
          if (expired(cur, t)) finalizeTimeout(cur, game, t);
          else throw new HttpError(409, 'active_match', { match_id: cur.id });
        }
        const seed = crypto.randomBytes(16).toString('hex');
        const human = seatFor(colour, seed);
        const botSeat = `bot:${b.bot_level}`;
        const params = { move_seconds: moveSeconds, colour, bot_level: b.bot_level, cost };
        const pos = call(game, 'initial', [{ ...params }], isPos);
        const r = stmts.insert.run(game.id, man.version, 'bot', 'active', human === 1 ? s.address : botSeat, human === 2 ? s.address : botSeat,
          s.address, null, JSON.stringify(params), seed, pos, t + moveSeconds, t, t);
        const newId = Number(r.lastInsertRowid);
        if (cost > 0) {
          tickets.topUp(s.address, t);     // a guest's day starts with its daily tickets (§19.17.4)
          ledger.post({ address: s.address, kind: 'plays', delta: -cost, reason: 'match_cost', ref: `m:${newId}:${human}` });
        }
        advance(stmts.get.get(newId), game, [pos], t);
        return newId;
      });
    } catch (e) {
      if (e instanceof LedgerError) throw new HttpError(409, e.code);
      throw e;
    }
    return { ok: true, match: view(stmts.get.get(id), s.address) };
  }

  // A seek (no target) or a direct challenge (target = the full address the challenger typed:
  // they already know it, §19.8). The creator pays now; the match is `seek`/`challenge` with
  // the creator's seat filled and the other empty until someone accepts.
  function createPvp(s, game, b, colour, moveSeconds) {
    if (b.bot_level !== undefined) throw new HttpError(400, 'bad_request', { field: 'bot_level' });
    let target = null;
    if (b.target !== undefined && b.target !== null) {
      if (typeof b.target !== 'string' || !GRIN_ADDR_RE.test(b.target) || !b.target.startsWith(prefix)) {
        throw new HttpError(400, 'bad_request', { field: 'target' });
      }
      target = b.target;
      if (target === s.address) throw new HttpError(400, 'self_match');
    }
    const cost = settings.get('pvp_play_cost');
    const t = now();
    expireMine(s.address, t);        // a stale seek must not count against the open cap
    let id;
    try {
      id = db.transaction(() => {
        if (stmts.openMine.get(s.address, s.address).n >= settings.get('pvp_open_max')) throw new HttpError(409, 'too_many_open');
        if (stmts.activePvp.get(s.address, s.address).n >= settings.get('pvp_active_max')) throw new HttpError(409, 'too_many_matches');
        const seed = crypto.randomBytes(16).toString('hex');
        const seat = seatFor(colour, seed);
        const params = { move_seconds: moveSeconds, colour, cost };
        const pos = call(game, 'initial', [{ ...params }], isPos);
        const r = stmts.insert.run(game.id, game.manifest.version, 'pvp', target ? 'challenge' : 'seek',
          seat === 1 ? s.address : null, seat === 2 ? s.address : null, s.address, target,
          JSON.stringify(params), seed, pos, t + OPEN_TTL_S, t, null);
        const newId = Number(r.lastInsertRowid);
        if (cost > 0) {
          tickets.topUp(s.address, t);
          ledger.post({ address: s.address, kind: 'plays', delta: -cost, reason: 'match_cost', ref: `m:${newId}:${seat}` });
        }
        return newId;
      });
    } catch (e) {
      if (e instanceof LedgerError) throw new HttpError(409, e.code);
      throw e;
    }
    return { ok: true, match: view(stmts.get.get(id), s.address) };
  }

  // Runs `fn(m, seat, game)` on an ACTIVE match the caller sits in, inside one transaction,
  // after the shared checks: exists, seated, active, deadline (a passed one is finalised
  // and committed, then answered 409 timeout), game loaded. `opts.pvp` refuses bot matches.
  function onActive(ctx, s, opts, fn) {
    const id = matchId(ctx);
    const t = now();
    const out = db.transaction(() => {
      const m = stmts.get.get(id);
      if (!m) throw new HttpError(404, 'not_found');
      const seat = seatOf(m, s.address);
      if (!seat) throw new HttpError(403, 'not_your_match');
      if (m.state !== 'active') throw new HttpError(409, 'not_active');
      if (opts.pvp && m.mode !== 'pvp') throw new HttpError(400, 'mode_unavailable');
      const game = registry.get(m.game_id);
      if (expired(m, t)) { finalizeTimeout(m, game, t); return 'timeout'; }   // committed, then 409
      if (!game) throw new HttpError(503, 'unknown_game');
      fn(m, seat, game, t);
      return 'ok';
    });
    if (out === 'timeout') throw new HttpError(409, 'timeout');
    return { ok: true, match: view(stmts.get.get(id), s.address) };
  }

  function move(ctx) {
    const s = auth.requireSession(ctx);
    const b = body(ctx, ['ply', 'move']);
    const ply = typeof b.ply === 'number' ? parseIntStrict(b.ply, { min: 0, max: 100000 }) : null;
    if (ply === null) throw new HttpError(400, 'bad_request', { field: 'ply' });
    if (typeof b.move !== 'string' || b.move === '' || b.move.length > MOVE_MAX) throw new HttpError(400, 'bad_request', { field: 'move' });
    rateMove(s.address);
    return onActive(ctx, s, {}, (m, seat, game, t) => {
      if (call(game, 'toMove', [m.position], isSeatNum, m.id) !== seat) throw new HttpError(403, 'not_your_turn');
      if (ply !== m.ply) throw new HttpError(409, 'stale');
      if (!game.moveRe.test(b.move)) throw new HttpError(400, 'illegal_move');
      const positions = replay(game, m);
      if (!playOne(m, game, positions, seat, b.move, t)) throw new HttpError(400, 'illegal_move');
      advance(m, game, positions, t);
    });
  }

  // A PvP resign before each side has moved once is an ABORT (both refunded): a result at
  // ply 0 would be a rated win handed over without a game.
  function resign(ctx) {
    const s = auth.requireSession(ctx);
    body(ctx, []);
    return onActive(ctx, s, {}, (m, seat, game, t) => {
      if (m.mode === 'pvp' && m.ply < 2) abort(m, 'abort', t);
      else settle(m, game, seat === 1 ? 'seat2' : 'seat1', 'resign', t);
    });
  }

  function abortMatch(ctx) {
    const s = auth.requireSession(ctx);
    body(ctx, []);
    return onActive(ctx, s, { pvp: true }, (m, seat, game, t) => {
      if (m.ply >= 2) throw new HttpError(409, 'too_late');
      abort(m, 'abort', t);
    });
  }

  // Offer / accept / decline. Offering when the opponent's offer is pending accepts it.
  // A move clears an offer (playOne), which is how a player declines by playing on.
  function draw(ctx) {
    const s = auth.requireSession(ctx);
    const b = body(ctx, ['action']);
    if (!DRAW_ACTIONS.has(b.action)) throw new HttpError(400, 'bad_request', { field: 'action' });
    rateMove(s.address);
    return onActive(ctx, s, { pvp: true }, (m, seat, game, t) => {
      const theirs = m.draw_offer_by === other(seat);
      if (b.action === 'offer' && !theirs) {
        if (m.draw_offer_by !== seat && stmts.setDraw.run(seat, m.id).changes !== 1) throw new Error(`draw: match ${m.id} is not active`);
        return;
      }
      if (!theirs) throw new HttpError(409, 'no_draw_offer');
      if (b.action === 'decline') {
        if (stmts.setDraw.run(null, m.id).changes !== 1) throw new Error(`draw: match ${m.id} is not active`);
        return;
      }
      settle(m, game, 'draw', 'agreement', t);      // accept, or an offer meeting theirs
    });
  }

  // Runs `fn(m, t)` on a seek/challenge inside one transaction; a passed expiry is finalised
  // (refunded) and committed, then answered 409 expired.
  function onOpen(ctx, fn) {
    const id = matchId(ctx);
    const t = now();
    const out = db.transaction(() => {
      const m = stmts.get.get(id);
      if (!m) throw new HttpError(404, 'not_found');
      if (!OPEN_STATES.has(m.state)) throw new HttpError(409, 'not_open');
      if (expired(m, t)) { closeOpen(m, 'expired', 'expired', t); return 'expired'; }
      fn(m, t);
      return 'ok';
    });
    if (out === 'expired') throw new HttpError(409, 'expired');
    return id;
  }

  function accept(ctx) {
    const s = auth.requireSession(ctx);
    body(ctx, []);
    expireMine(s.address, now());      // a lapsed game must not count against the active cap
    let id;
    try {
      id = onOpen(ctx, (m, t) => {
        if (m.created_by === s.address) throw new HttpError(400, 'self_match');
        if (m.state === 'challenge' && m.target !== s.address) throw new HttpError(403, 'not_invited');
        if (!registry.get(m.game_id)) throw new HttpError(503, 'unknown_game');
        const max = settings.get('pvp_active_max');
        if (stmts.activePvp.get(s.address, s.address).n >= max) throw new HttpError(409, 'too_many_matches');
        if (stmts.activePvp.get(m.created_by, m.created_by).n >= max) throw new HttpError(409, 'opponent_busy');
        const seat = openSeat(m);
        const params = parseParams(m);
        // The acceptor pays what the creator paid (the cost recorded at creation).
        if (params.cost > 0) {
          tickets.topUp(s.address, t);
          ledger.post({ address: s.address, kind: 'plays', delta: -params.cost, reason: 'match_cost', ref: `m:${m.id}:${seat}` });
        }
        const r = (seat === 1 ? stmts.accept1 : stmts.accept2).run(s.address, t, t + params.move_seconds, m.id);
        if (r.changes !== 1) throw new Error(`accept: match ${m.id} changed under a held write lock`);
      });
    } catch (e) {
      if (e instanceof LedgerError) throw new HttpError(409, e.code);
      throw e;
    }
    return { ok: true, match: view(stmts.get.get(id), s.address) };
  }

  function decline(ctx) {
    const s = auth.requireSession(ctx);
    body(ctx, []);
    const id = onOpen(ctx, (m, t) => {
      if (m.state !== 'challenge' || m.target !== s.address) throw new HttpError(403, 'not_invited');
      closeOpen(m, 'declined', 'declined', t);
    });
    return { ok: true, match: view(stmts.get.get(id), s.address) };
  }

  function cancel(ctx) {
    const s = auth.requireSession(ctx);
    body(ctx, []);
    const id = onOpen(ctx, (m, t) => {
      if (m.created_by !== s.address) throw new HttpError(403, 'not_your_match');
      closeOpen(m, 'aborted', 'cancelled', t);
    });
    return { ok: true, match: view(stmts.get.get(id), s.address) };
  }

  function getOne(ctx) {
    const id = matchId(ctx);
    const since = qInt(ctx, 'since_ply', { min: 0, max: 100000 });
    let m = stmts.get.get(id);
    if (!m) throw new HttpError(404, 'not_found');
    if (expired(m, now())) { finalizeIfExpired(id); m = stmts.get.get(id); }
    // The session is optional here: a spectator gets the same view with you = null.
    const sess = sessions.lookup(ctx.cookies.grin_play);
    return { ok: true, match: view(m, sess ? sess.address : null, since === undefined ? 0 : since) };
  }

  function mine(ctx) {
    const s = auth.requireSession(ctx);
    const states = ctx.query.getAll('state');
    if (states.length > 1 || (states.length === 1 && !STATES.has(states[0]))) throw new HttpError(400, 'bad_request', { field: 'state' });
    const before = qInt(ctx, 'before', { min: 1 });
    const t = now();
    // Lazy timeouts for the caller's own matches whose deadline has passed.
    expireMine(s.address, t);
    const b4 = before === undefined ? Number.MAX_SAFE_INTEGER : before;
    const rows = states.length
      ? stmts.mineState.all(s.address, states[0], b4, s.address, states[0], b4)
      : stmts.mine.all(s.address, b4, s.address, b4);
    return {
      ok: true,
      matches: rows.map((m) => summary(m, s.address)),
      next_before: rows.length === PAGE ? rows[rows.length - 1].id : null,
    };
  }

  // Open seeks — public while the games are open (§19.8), newest first, never a full
  // address. A signed-in caller also gets the challenges addressed to them. READ-ONLY: a
  // seek past its expiry is filtered out here and refunded by the sweep or the next write.
  function lobby(ctx) {
    noQuery(ctx);
    const t = now();
    const sess = sessions.lookup(ctx.cookies.grin_play);
    const me = sess ? sess.address : null;
    const row = (m) => {
      const p = parseParams(m);
      return {
        id: m.id,
        game_id: m.game_id,
        name: names.label(m.created_by),
        you_play: openSeat(m),               // the seat an acceptor takes (chess: 1 = white)
        move_seconds: p.move_seconds,
        created_at: m.created_at,
        expires_at: m.turn_deadline,
        own: me !== null && m.created_by === me,
      };
    };
    return {
      ok: true,
      seeks: stmts.lobby.all(t).filter((m) => registry.get(m.game_id)).map(row),
      challenges: me === null ? [] : stmts.incoming.all(me, t).filter((m) => registry.get(m.game_id)).map(row),
    };
  }

  // The cheap poll (§19.8): how many of the caller's matches wait for their move, how many
  // challenges wait for an answer, and the newest move time — the shell reloads its lists
  // only when one of these changes. READ-ONLY: a match past its deadline is not counted as
  // anyone's move (the sweep or the next read finalises it).
  function turns(ctx) {
    const s = auth.requireSession(ctx);
    noQuery(ctx);
    const t = now();
    let yourTurn = 0;
    let active = 0;
    let drawOffers = 0;
    let last = 0;
    for (const m of stmts.myActive.all(s.address, s.address)) {
      if (m.turn_deadline !== null && t >= m.turn_deadline) continue;
      const game = registry.get(m.game_id);
      if (!game) continue;
      active++;
      const seat = seatOf(m, s.address);
      if (call(game, 'toMove', [m.position], isSeatNum, m.id) === seat) yourTurn++;
      if (m.draw_offer_by === other(seat)) drawOffers++;
      if (m.last_move_at !== null && m.last_move_at > last) last = m.last_move_at;
    }
    return {
      ok: true,
      your_turn: yourTurn,
      active,
      draw_offers: drawOffers,
      challenges: stmts.incomingCount.get(s.address, t).n,
      last_move_at: last || null,
    };
  }

  // ── Admin: void (§19.8, §19.11 — step-up, enforced pool-side and re-checked by admin.js) ──
  //   active            → void, no result, every seat's play refunded
  //   seek / challenge  → void, the creator refunded
  //   finished          → void (result kept for the record); the points it paid are reversed
  //                       with admin_void rows, its results_daily counts come off, and, if it
  //                       was rated, the game's ratings are recomputed without it
  // Anything else (aborted, declined, expired, void) → 409 not_voidable.
  function adminVoid(ctx) {
    const id = matchId(ctx);
    const b = body(ctx, ['reason']);
    let note = null;
    if (b.reason !== undefined && b.reason !== null && b.reason !== '') {
      note = normaliseBody(b.reason, VOID_REASON_MAX);       // the chat rules, as every admin reason
      if (note === null) throw new HttpError(400, 'bad_request', { field: 'reason' });
    }
    const t = now();
    const res = db.transaction(() => {
      const m = stmts.get.get(id);
      if (!m) throw new HttpError(404, 'not_found');
      const from = m.state;
      const out = { from, refunded: 0, reversed: [], ratings: null };
      if (from === 'active') {
        out.refunded = abort(m, 'void', t, 'void');
      } else if (OPEN_STATES.has(from)) {
        out.refunded = closeOpen(m, 'void', 'void', t);
      } else if (from === 'finished') {
        if (stmts.voidFinished.run(m.id).changes !== 1) throw new Error(`void: match ${m.id} is not finished`);
        // Exactly the matches settle() counted: a free one never entered results_daily, so
        // taking its counts off would eat another match's row of the same day.
        const counted = (m.mode === 'bot' || m.rated === 1) && parseParams(m).cost > 0;
        const day = utcDay(m.finished_at);
        for (const seat of [1, 2]) {
          const who = seatAddr(m, seat);
          if (!isHuman(who) || !counted) continue;
          const ref = `m:${m.id}:${seat}`;
          const c = stmts.credited.get(who, ref);
          const got = c ? c.delta : 0;
          // Points are not spendable in v1 (D1), but an admin_adjust may have lowered the
          // balance: reverse what is there, never below 0 (the ledger refuses an overdraft).
          const bal = (stmts.points.get(who) || { points: 0 }).points;
          const back = Math.min(got, bal);
          if (back > 0) ledger.post({ address: who, kind: 'points', delta: -back, reason: 'admin_void', ref });
          const res1 = m.result === 'draw' ? 'draw' : m.result === `seat${seat}` ? 'win' : 'loss';
          const w = res1 === 'win' ? 1 : 0, d = res1 === 'draw' ? 1 : 0, l = res1 === 'loss' ? 1 : 0;
          stmts.unresults.run(w, d, l, got, who, m.game_id, m.mode, day, w, d, l, got);
          out.reversed.push({ seat, points: back });
        }
        if (m.mode === 'pvp' && m.rated === 1) out.ratings = ratings.recompute(m.game_id);
      } else {
        throw new HttpError(409, 'not_voidable');
      }
      admin.audit(ctx, 'match_void', `m:${m.id}`, { ...out, reason: note });
      return out;
    });
    return { ok: true, voided: res, match: view(stmts.get.get(id), null) };
  }

  if (admin) admin.add('POST', 'matches/:id/void', adminVoid, { bodyLimit: MATCH_BODY_LIMIT });

  // ── Maintenance ─────────────────────────────────────────────────────────────────────
  // 5-min tier: finalise passed deadlines — move clocks and seek/challenge expiries — oldest
  // first, a bounded batch per state per tick. Each match is its own transaction, so one
  // broken match cannot hold back the rest.
  function sweepTimeouts() {
    const t = now();
    let finalised = 0;
    let errors = 0;
    for (const state of SWEEP_STATES) {
      for (const { id } of stmts.expiredIn.all(state, t, SWEEP_BATCH)) {
        try { if (finalizeIfExpired(id, t)) finalised++; } catch (e) {
          errors++;
          log.error(`[matches] timeout of match ${id} failed: ${e && e.code ? e.code : (e && e.message) || e}`);
        }
      }
    }
    return { finalised, errors };
  }

  // Hourly tier: drop the move lists of bot matches that ended more than 60 days ago
  // (§19.8). Walks match ids upward from a watermark; the watermark stops at the first bot
  // match that is not yet eligible (still active, or ended recently), so nothing is ever
  // skipped — a long-running match only delays the purge of the ones after it. PvP moves
  // are kept forever and never block it.
  function purgeBotMoves() {
    const t = now();
    const cutoff = t - BOT_MOVES_KEEP_S;
    const w = stmts.metaGet.get(PURGE_META_KEY);
    let mark = w && /^[0-9]{1,15}$/.test(w.value) ? Number(w.value) : 0;
    return db.transaction(() => {
      let purged = 0;
      let blocked = false;
      for (const r of stmts.purgeScan.all(mark, PURGE_BATCH)) {
        const eligible = r.mode === 'bot' && r.state !== 'active' && r.finished_at !== null && r.finished_at < cutoff;
        if (eligible) purged += stmts.purgeMoves.run(r.id).changes;
        if (r.mode === 'bot' && !eligible) blocked = true;
        if (!blocked) mark = r.id;
      }
      stmts.metaSet.run(PURGE_META_KEY, String(mark));
      return { purged, through: mark };
    });
  }

  return {
    routes: [
      ['GET', '/play/api/games', listGames],
      ['GET', '/play/api/lobby', lobby],
      ['POST', '/play/api/matches', create, { bodyLimit: MATCH_BODY_LIMIT }],
      // Before '/:id', which would otherwise take 'mine' / 'turns' as an id.
      ['GET', '/play/api/matches/mine', mine],
      ['GET', '/play/api/matches/turns', turns],
      ['GET', '/play/api/matches/:id', getOne],
      ['POST', '/play/api/matches/:id/move', move, { bodyLimit: MATCH_BODY_LIMIT }],
      ['POST', '/play/api/matches/:id/resign', resign, { bodyLimit: MATCH_BODY_LIMIT }],
      ['POST', '/play/api/matches/:id/accept', accept, { bodyLimit: MATCH_BODY_LIMIT }],
      ['POST', '/play/api/matches/:id/decline', decline, { bodyLimit: MATCH_BODY_LIMIT }],
      ['POST', '/play/api/matches/:id/cancel', cancel, { bodyLimit: MATCH_BODY_LIMIT }],
      ['POST', '/play/api/matches/:id/draw', draw, { bodyLimit: MATCH_BODY_LIMIT }],
      ['POST', '/play/api/matches/:id/abort', abortMatch, { bodyLimit: MATCH_BODY_LIMIT }],
    ],
    sweepTimeouts,
    purgeBotMoves,
    closeOpenOf,
    finalizeIfExpired,
    ratings,
    _internal: { replay, settle, abort, view },
  };
}

module.exports = { createMatches, MOVE_RATE, BOT_MOVES_KEEP_S, SWEEP_BATCH, PAGE, OPEN_TTL_S, LOBBY_MAX, label };
