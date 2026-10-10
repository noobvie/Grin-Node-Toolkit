// The explorer key this pool's links use — shared by routes/pool.js (stats, pool-info) and the
// admin blocks route. Stateless: each caller builds its own copy from the same ctx, so there is
// no cache and nothing to keep to one home (I7).
const explorers = require('../../lib/explorers');

module.exports = function createCurrentExplorerKey(ctx) {
  const { config, poolSettings } = ctx;

  // The explorer key this pool's links use (lib/explorers.js), resolved from the network + the
  // `branding.explorer_mainnet` setting. Published RESOLVED beside `network` on the three routes
  // that prime a page's sessionStorage network cache (branding, /api/pool/stats, pool-info), so
  // no client has to get the fallback rule right. A failed settings read is the default, never
  // an error: a links preference must not 500 a stats route.
  const currentExplorerKey = () => {
    let stored;
    try { stored = poolSettings.getSection('branding').explorer_mainnet; } catch (e) { stored = undefined; }
    return explorers.resolveExplorerKey(config.network, stored);
  };
  return currentExplorerKey;
};
