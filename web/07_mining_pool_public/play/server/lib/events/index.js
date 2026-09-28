'use strict';

// The event kinds this build offers (design §19.9, D17). Adding a kind = one module in this
// folder + one line here; lib/events.js (the platform) is not touched. The list is written
// out, not read from the directory, because the service never require()s a computed path
// (test-skeleton.js [h]): what runs is exactly what a reviewer can see listed.

module.exports = [
  require('./game_results'),
  require('./mining_minutes'),
  require('./active_days'),
];
