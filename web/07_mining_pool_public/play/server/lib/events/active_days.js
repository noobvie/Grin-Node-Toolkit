'use strict';

// Event kind `active_days` (design §19.9): on how many UTC days of the window an address
// mined at least `min_minutes`. It rewards turning up every day rather than hashrate, so a
// small miner can top it. Source: activity_daily, like mining_minutes; guests excluded the same way.

const { plainRules, intField } = require('./_rules');

module.exports = {
  kind: 'active_days',
  label: 'Active days',
  unit: 'days',
  fields: [
    { key: 'min_minutes', type: 'int', min: 1, max: 1440, def: 10, label: 'Minutes of mining that make a day count' },
  ],

  validate(rules) {
    const r = plainRules(rules, ['min_minutes']);
    return { min_minutes: intField(r, 'min_minutes', { min: 1, max: 1440, def: 10 }) };
  },

  gameId() { return null; },

  // idx_activity_day (day)
  compute(db, event, { fromDay, toDay }) {
    const minSeconds = event.rules.min_minutes * 60;
    return db.raw.prepare(
      'SELECT address, COUNT(*) AS n FROM activity_daily WHERE day BETWEEN ? AND ? AND address NOT LIKE ? AND seconds >= ? GROUP BY address'
    ).all(fromDay, toDay, 'g:%', minSeconds).map((r) => ({ address: r.address, value: r.n }));
  },

  describe(rules) {
    return `Most days with at least ${rules.min_minutes} minute${rules.min_minutes === 1 ? '' : 's'} of mining.`;
  },
};
