// The ORDERED list of admin route files (code-layout refactor P9). Order is the order Express
// matches them in — it is the order the routes had in the former single file, and the T2 manifest
// (scripts/test-route-manifest.js) fails if two overlapping routes ever swap. Each file writes
// FULL paths and is mounted without a prefix; nothing here adds a guard (plan I8) — every route
// keeps its own secureAdmin / freshAdmin chain. noAutoOptions: see routes/_shared/no-auto-options.js.

const createAdminNodeRoutes = require('./node');
const createAdminPayoutsRoutes = require('./payouts');
const createAdminStratumRoutes = require('./stratum');
const createAdminCmsRoutes = require('./cms');
const createAdminBlocksRoutes = require('./blocks');
const createAdminSecurityRoutes = require('./security');
const createAdminRegionsRoutes = require('./regions');
const createAdminMinersRoutes = require('./miners');
const createAdminDonorsRoutes = require('./donors');
const createAdminIncentivesRoutes = require('./incentives');
const createAdminSettingsRoutes = require('./settings');
const noAutoOptions = require('../_shared/no-auto-options');

module.exports = function registerAdminRoutes(app, ctx, guards) {
  app.use(noAutoOptions(createAdminNodeRoutes(ctx, guards)));
  app.use(noAutoOptions(createAdminPayoutsRoutes(ctx, guards)));
  app.use(noAutoOptions(createAdminStratumRoutes(ctx, guards)));
  app.use(noAutoOptions(createAdminCmsRoutes(ctx, guards)));
  app.use(noAutoOptions(createAdminBlocksRoutes(ctx, guards)));
  app.use(noAutoOptions(createAdminSecurityRoutes(ctx, guards)));
  app.use(noAutoOptions(createAdminRegionsRoutes(ctx, guards)));
  app.use(noAutoOptions(createAdminMinersRoutes(ctx, guards)));
  app.use(noAutoOptions(createAdminDonorsRoutes(ctx, guards)));
  app.use(noAutoOptions(createAdminIncentivesRoutes(ctx, guards)));
  app.use(noAutoOptions(createAdminSettingsRoutes(ctx, guards)));
};
