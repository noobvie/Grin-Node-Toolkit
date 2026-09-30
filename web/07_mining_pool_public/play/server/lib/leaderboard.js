'use strict';

// Leaderboards (design §19.9).
//
//   GET /play/api/leaderboard?board=&game=&mode=&period=
//
//   board=points (no game)        points held, all time          players       idx_players_points
//   board=rating&game=G           Elo, PvP, ≥ 5 rated games      ratings       idx_ratings_board
//   board=wins|points&game=G&mode=M&period=day|week|month|all
//                                 wins / match points in a UTC period
//                                                                results_daily idx_results_board
//
// Rules:
//   - No read here touches `matches` or `ledger`: every board is one indexed read of a
//     rollup (results_daily, ratings) or of the balance column. test-events.js EXPLAINs them.
//   - Names are the pool's mask only (D19, mask.js). No response here carries a full
//     address; the caller's own row is flagged `own`, and `you` gives their rank — neither
//     needs the address.
//   - Ranking is deterministic: value DESC, then games DESC (rating board), then the full
//     address ASC. The rank is the position, so two equal values never share a rank.
//   - A zero value is not ranked (a wins board of people with no wins is noise), and a
//     banned address is not ranked.
//   - A computed board is cached for 60 s. The key space is closed (a known game × a fixed
//     board/mode/period enum), so the cache cannot be grown by requests.
//   - Periods are the CURRENT UTC day, ISO week (Monday–Sunday) and calendar month. There is
//     no arbitrary date parameter: past periods live on in events, not here.

const { HttpError } = require('./http');
const { MASK_ONLY } = require('./names');
const { utcDay } = require('./plays');

const CACHE_MS = 60 * 1000;
const CACHE_MAX = 256;
const TOP = 50;
const RANK_MAX = 10000;           // a computed board keeps at most this many ranks
const RATING_MIN_GAMES = 5;       // §19.9: provisional until 5 rated games
const BOARDS = ['points', 'rating', 'wins'];
const MODES = ['bot', 'pvp'];
const PERIODS = ['day', 'week', 'month', 'all'];
const PARAMS = ['board', 'game', 'mode', 'period'];

// → { from, to } as UTC days (inclusive), or null for 'all'.
function periodRange(period, t) {
  if (period === 'all') return null;
  const d = new Date(t * 1000);
  const y = d.getUTCFullYear(), m = d.getUTCMonth(), day = d.getUTCDate();
  if (period === 'day') { const s = utcDay(t); return { from: s, to: s }; }
  if (period === 'week') {
    const dow = (d.getUTCDay() + 6) % 7;                       // Monday = 0 (ISO)
    const mon = Date.UTC(y, m, day - dow) / 1000;
    return { from: utcDay(mon), to: utcDay(mon + 6 * 86400) };
  }
  const first = Date.UTC(y, m, 1) / 1000;
  const last = Date.UTC(y, m + 1, 0) / 1000;
  return { from: utcDay(first), to: utcDay(last) };
}

// Sort + rank. rows: [{ address, value, games? }]. Mutates nothing it was given.
function rank(rows, { byGames = false } = {}) {
  const out = rows.filter((r) => Number.isSafeInteger(r.value) && r.value > 0).slice();
  out.sort((a, b) => (b.value - a.value)
    || (byGames ? (b.games || 0) - (a.games || 0) : 0)
    || (a.address < b.address ? -1 : a.address > b.address ? 1 : 0));
  return out.slice(0, RANK_MAX).map((r, i) => ({ ...r, rank: i + 1 }));
}

function createLeaderboard({ db, registry, sessions, names = MASK_ONLY, now = () => Math.floor(Date.now() / 1000), clock = () => Date.now() }) {
  const raw = db.raw;
  const stmts = {
    points: raw.prepare(`SELECT address, points AS value FROM players WHERE points > 0 ORDER BY points DESC LIMIT ${RANK_MAX * 2}`),
    rating: raw.prepare(
      'SELECT address, rating AS value, games FROM ratings WHERE game_id = ? AND games >= ? ORDER BY rating DESC LIMIT ?'),
    results: raw.prepare(
      'SELECT address, SUM(wins) AS wins, SUM(points) AS points, SUM(games) AS games FROM results_daily ' +
      'WHERE game_id = ? AND mode = ? AND day BETWEEN ? AND ? GROUP BY address'),
    banned: raw.prepare('SELECT banned_until FROM players WHERE address = ?'),
  };
  const cache = new Map();

  function notBanned(t) {
    return (r) => {
      const p = stmts.banned.get(r.address);
      return !(p && p.banned_until !== null && p.banned_until > t);
    };
  }

  // One query parameter: absent → undefined; repeated or outside `values` → 400.
  function param(ctx, name, values) {
    const all = ctx.query.getAll(name);
    if (all.length === 0) return undefined;
    if (all.length > 1 || !values.includes(all[0])) throw new HttpError(400, 'bad_request', { field: name });
    return all[0];
  }

  // → the normalised request { board, game, mode, period } or a 400.
  function parse(ctx) {
    for (const k of ctx.query.keys()) if (!PARAMS.includes(k)) throw new HttpError(400, 'bad_request', { field: k });
    const board = param(ctx, 'board', BOARDS) || 'points';
    const gameIds = registry.list().map((g) => g.id);
    const gameId = ctx.query.getAll('game').length ? param(ctx, 'game', gameIds) : undefined;
    let mode = param(ctx, 'mode', MODES);
    let period = param(ctx, 'period', PERIODS);
    if (board === 'points' && gameId === undefined) {
      if (mode !== undefined) throw new HttpError(400, 'bad_request', { field: 'mode' });
      if (period !== undefined && period !== 'all') throw new HttpError(400, 'bad_request', { field: 'period' });
      return { board, game: null, mode: null, period: 'all' };
    }
    if (gameId === undefined) throw new HttpError(400, 'bad_request', { field: 'game' });
    const game = registry.get(gameId);
    if (board === 'rating') {
      if (mode !== undefined && mode !== 'pvp') throw new HttpError(400, 'bad_request', { field: 'mode' });
      if (period !== undefined && period !== 'all') throw new HttpError(400, 'bad_request', { field: 'period' });
      if (!game.manifest.modes.includes('pvp')) throw new HttpError(400, 'bad_request', { field: 'board' });
      return { board, game: gameId, mode: 'pvp', period: 'all' };
    }
    if (mode === undefined || !game.manifest.modes.includes(mode)) throw new HttpError(400, 'bad_request', { field: 'mode' });
    return { board, game: gameId, mode, period: period || 'all' };
  }

  // → { rows: ranked [{ address, value, games?, rank }], range, computed_at }
  function compute(q, t) {
    const keep = notBanned(t);
    if (q.board === 'points' && q.game === null) {
      return { rows: rank(stmts.points.all().filter(keep)), range: null };
    }
    if (q.board === 'rating') {
      return { rows: rank(stmts.rating.all(q.game, RATING_MIN_GAMES, RANK_MAX * 2).filter(keep), { byGames: true }), range: null };
    }
    const range = periodRange(q.period, t);
    const from = range ? range.from : '0000-01-01';
    const to = range ? range.to : '9999-12-31';
    const col = q.board === 'wins' ? 'wins' : 'points';
    const rows = stmts.results.all(q.game, q.mode, from, to)
      .map((r) => ({ address: r.address, value: r[col], games: r.games }))
      .filter(keep);
    return { rows: rank(rows), range };
  }

  function board(q) {
    const t = now();
    const key = `${q.board}|${q.game}|${q.mode}|${q.period}`;
    const hit = cache.get(key);
    // A day/week/month board also expires when its period rolls over.
    if (hit && clock() - hit.at < CACHE_MS && utcDay(hit.t) === utcDay(t)) return hit;
    if (cache.size >= CACHE_MAX) cache.clear();
    const c = { ...compute(q, t), at: clock(), t };
    cache.set(key, c);
    return c;
  }

  function getBoard(ctx) {
    const q = parse(ctx);
    const b = board(q);
    const s = sessions.lookup(ctx.cookies.grin_play);
    const me = s ? s.address : null;
    const row = (r) => {
      const o = { rank: r.rank, name: names.label(r.address), value: r.value };   // per request, never cached (§19.16)
      if (q.board !== 'points' || q.game !== null) o.games = r.games;
      if (me !== null && r.address === me) o.own = true;
      return o;
    };
    let you = null;
    if (me !== null) {
      const mine = b.rows.find((r) => r.address === me);
      you = mine ? { rank: mine.rank, value: mine.value } : { rank: null, value: null };
    }
    return {
      ok: true,
      board: q.board,
      game: q.game,
      mode: q.mode,
      period: q.period,
      from: b.range ? b.range.from : null,
      to: b.range ? b.range.to : null,
      unit: q.board === 'rating' ? 'rating' : q.board,
      computed_at: b.t,
      total: b.rows.length,
      rows: b.rows.slice(0, TOP).map(row),
      you,
    };
  }

  return {
    routes: [['GET', '/play/api/leaderboard', getBoard]],
    _internal: { compute, parse, board, cache },
  };
}

module.exports = { createLeaderboard, periodRange, rank, RATING_MIN_GAMES, TOP, CACHE_MS };
