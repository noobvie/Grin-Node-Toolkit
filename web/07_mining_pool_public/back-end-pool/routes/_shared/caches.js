// Process-wide route caches that more than one route file touches (H4 / I7).
//
// A `let` exported from a module cannot be reassigned by an importer, so the reassigned caches
// live on this HOLDER object and every site writes `caches.topology = …` / reads
// `caches.branding.get(…)`. Same cached module everywhere => ONE home per cache.
//
//   topology  GET /api/network/topology (routes/pool.js) is read here; the admin location
//             upsert/delete (routes/admin/regions.js) drop it.
//   branding  GET /api/public/branding (routes/public.js) memoises per hostname; the settings
//             and asset writes (admin/settings.js, admin/cms.js), the stratum-pause onChange and
//             the games-link health callback call invalidateBranding().
//
// Caches read by ONE area (price, pool status, effort, health) stay in that route file.
const caches = {
  topology: { at: 0, body: null },
  branding: new Map(),          // hostname -> { at, payload }
};
caches.invalidateBranding = () => { caches.branding = new Map(); };

module.exports = caches;
