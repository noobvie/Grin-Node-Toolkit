'use strict';

// Ratings (design §19.8, §19.9) — Elo for RATED PvP matches, one table per game.
//
// `ratings` is DERIVED: every row can be rebuilt from the finished, rated, non-void matches
// of its game. Two writers, one rule:
//   - apply()      after one rated match settles (matches.js settle, inside its transaction);
//   - recompute()  after an admin void of a finished rated match — the voided match drops
//                  out and every later result is replayed from 1200.
// Both walk the same arithmetic, so a recompute lands on what the incremental updates built,
// with one recorded exception: recompute orders by (finished_at, id), and apply() runs in
// settle order. Two rated matches of ONE game that share a player and settle in the SAME
// second, the later-settled one having the smaller id, are replayed in the other order.
// The difference is a point or two for those players, and nothing reads ratings as money.
//
// Elo, K = 24, start 1200, integers. The change is computed once, for seat 1, and seat 2
// gets its negation, so a match never creates or destroys rating (rounding included).

const START = 1200;
const K = 24;

function expected(ra, rb) { return 1 / (1 + Math.pow(10, (rb - ra) / 400)); }

// → the integer rating change for seat 1; seat 2 moves by the negation.
// score1: 1 win, 0.5 draw, 0 loss. `+ 0` turns Math.round's -0 into 0.
function eloDelta(r1, r2, score1) { return Math.round(K * (score1 - expected(r1, r2))) + 0; }

const score1Of = (result) => (result === 'seat1' ? 1 : result === 'draw' ? 0.5 : 0);

function createRatings({ db }) {
  const raw = db.raw;
  const stmts = {
    get: raw.prepare('SELECT rating, games, wins, draws, losses FROM ratings WHERE game_id = ? AND address = ?'),
    upsert: raw.prepare(
      'INSERT INTO ratings (game_id, address, rating, games, wins, draws, losses, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ' +
      'ON CONFLICT(game_id, address) DO UPDATE SET rating = excluded.rating, games = excluded.games, wins = excluded.wins, ' +
      'draws = excluded.draws, losses = excluded.losses, updated_at = excluded.updated_at'),
    clear: raw.prepare('DELETE FROM ratings WHERE game_id = ?'),
    // Admin-only (a void), O(rated matches of the game) — §19.8 accepts this well past the
    // community's size. Not a hot read.
    history: raw.prepare(
      "SELECT seat1, seat2, result, finished_at FROM matches WHERE game_id = ? AND mode = 'pvp' AND state = 'finished' " +
      'AND rated = 1 ORDER BY finished_at, id'),
  };

  const fresh = () => ({ rating: START, games: 0, wins: 0, draws: 0, losses: 0 });

  // Moves both rows of one result. `get(address)` → the current row; `put(address, row)`.
  function step(get, put, a1, a2, result, t) {
    const r1 = get(a1);
    const r2 = get(a2);
    const d = eloDelta(r1.rating, r2.rating, score1Of(result));
    const w1 = result === 'seat1' ? 1 : 0;
    const w2 = result === 'seat2' ? 1 : 0;
    const dr = result === 'draw' ? 1 : 0;
    put(a1, { rating: r1.rating + d, games: r1.games + 1, wins: r1.wins + w1, draws: r1.draws + dr, losses: r1.losses + w2, updated_at: t });
    put(a2, { rating: r2.rating - d, games: r2.games + 1, wins: r2.wins + w2, draws: r2.draws + dr, losses: r2.losses + w1, updated_at: t });
    return d;
  }

  const write = (gameId) => (address, r) => stmts.upsert.run(gameId, address, r.rating, r.games, r.wins, r.draws, r.losses, r.updated_at);

  // One rated match's result. Must run inside the settling transaction. → seat 1's change.
  function apply(gameId, a1, a2, result, t) {
    return step((a) => stmts.get.get(gameId, a) || fresh(), write(gameId), a1, a2, result, t);
  }

  // Rebuilds one game's ratings from its match history. Must run inside the caller's
  // transaction (the void), so a failure leaves the old table. → { matches, players }.
  function recompute(gameId) {
    const table = new Map();
    let n = 0;
    for (const m of stmts.history.all(gameId)) {
      step((a) => table.get(a) || fresh(), (a, r) => table.set(a, r), m.seat1, m.seat2, m.result, m.finished_at);
      n++;
    }
    stmts.clear.run(gameId);
    const put = write(gameId);
    for (const [address, r] of table) put(address, r);
    return { matches: n, players: table.size };
  }

  return { apply, recompute };
}

module.exports = { createRatings, eloDelta, expected, START, K };
