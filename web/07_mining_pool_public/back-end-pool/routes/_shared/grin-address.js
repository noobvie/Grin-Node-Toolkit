// The bech32 Grin address shape, used by the /api/account shape gate (routes/index.js), the operator revenue address check
// (routes/admin/payouts.js) and the admin donor :addr routes.
// No `g`/`y` flag, so .test() keeps no lastIndex state — one shared instance is safe.

const GRIN_ADDR_RE = /^t?grin1[ac-hj-np-z02-9]{58}$/;

module.exports = { GRIN_ADDR_RE };
