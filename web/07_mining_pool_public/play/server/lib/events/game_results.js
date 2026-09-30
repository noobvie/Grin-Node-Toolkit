'use strict';

// Event kind `game_results` (design §19.9): wins or match points in one game and mode over
// the window. Source: results_daily, the per-day rollup that settle writes in the same
// transaction as the match result — so the value is whatever the server itself decided,
// never a number the browser sent (D14).
//
// `points` counts the points a match actually CREDITED (after the daily points cap, and 0
// for a free bot game), which is what results_daily.points records. `min_games` keeps a
// single lucky win from topping a points or wins board.

const { RulesError, plainRules, intField, enumField } = require('./_rules');

module.exports = {
  kind: 'game_results',
  label: 'Game results',
  unit: null,   // wins or points, from rules.metric
  fields: [
    { key: 'game_id', type: 'game', label: 'Game' },
    { key: 'mode', type: 'enum', values: ['bot', 'pvp'], label: 'Mode' },
    { key: 'metric', type: 'enum', values: ['wins', 'points'], label: 'Ranked by' },
    { key: 'min_games', type: 'int', min: 0, max: 1000, def: 1, label: 'Games needed to be ranked' },
  ],

  validate(rules, { registry }) {
    const r = plainRules(rules, ['game_id', 'mode', 'metric', 'min_games']);
    const game = typeof r.game_id === 'string' ? registry.get(r.game_id) : null;
    if (!game) throw new RulesError('game_id');
    const mode = enumField(r, 'mode', ['bot', 'pvp']);
    if (!game.manifest.modes.includes(mode)) throw new RulesError('mode');
    return {
      game_id: game.id,
      mode,
      metric: enumField(r, 'metric', ['wins', 'points']),
      min_games: intField(r, 'min_games', { min: 0, max: 1000, def: 1 }),
    };
  },

  gameId(rules) { return rules.game_id; },

  unitFor(rules) { return rules.metric; },

  // idx_results_board (game_id, mode, day)
  compute(db, event, { fromDay, toDay }) {
    const col = event.rules.metric === 'points' ? 'points' : 'wins';
    return db.raw.prepare(
      `SELECT address, SUM(${col}) AS v, SUM(games) AS g FROM results_daily ` +
      'WHERE game_id = ? AND mode = ? AND day BETWEEN ? AND ? GROUP BY address HAVING SUM(games) >= ?'
    ).all(event.rules.game_id, event.rules.mode, fromDay, toDay, event.rules.min_games)
      .map((r) => ({ address: r.address, value: r.v }));
  },

  describe(rules, { registry }) {
    const game = registry.get(rules.game_id);
    const title = game ? game.manifest.title : rules.game_id;
    const who = rules.mode === 'bot' ? 'against the bot' : 'against other players';
    const what = rules.metric === 'wins' ? 'wins' : 'points';
    const min = rules.min_games > 1 ? ` (at least ${rules.min_games} games)` : '';
    return `Most ${title} ${what} ${who}${min}.`;
  },
};
