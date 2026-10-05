'use strict';

// Event kind `mining_minutes` (design §19.9): the active mining minutes an address had in
// the event window. The source is activity_daily, which the activity sync fills from the
// pool's own share records — so this metric is cheat-proof in the way no game score can be:
// the pool already verified the PoW behind every minute (D14, the `mining` kind).
//
// Value = floor(Σ activity_daily.seconds / 60) over the window's days. Guests are excluded
// (§19.17.3): activity_daily never holds one, and the filter says so here. The division is on
// the SUM, not per day, so seconds that do not fill a minute on one day still count.

const { plainRules } = require('./_rules');

module.exports = {
  kind: 'mining_minutes',
  label: 'Mining minutes',
  unit: 'minutes',
  fields: [],

  validate(rules) {
    plainRules(rules, []);
    return {};
  },

  gameId() { return null; },

  // idx_activity_day (day)
  compute(db, event, { fromDay, toDay }) {
    return db.raw.prepare(
      'SELECT address, SUM(seconds) AS s FROM activity_daily WHERE day BETWEEN ? AND ? AND address NOT LIKE ? GROUP BY address'
    ).all(fromDay, toDay, 'g:%').map((r) => ({ address: r.address, value: Math.floor(r.s / 60) }));
  },

  describe() {
    return 'Most active mining minutes at this pool during the event.';
  },
};
