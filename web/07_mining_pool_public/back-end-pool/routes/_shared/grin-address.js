// The bech32 Grin address shape. Moved VERBATIM from routes/index.js (code-layout refactor P6):
// used by the /api/account shape gate (routes/index.js), the operator revenue address check
// (routes/admin/payouts.js) and the admin donor :addr routes.
// No `g`/`y` flag, so .test() keeps no lastIndex state — one shared instance is safe (I7).

const GRIN_ADDR_RE = /^t?grin1[ac-hj-np-z02-9]{58}$/;

module.exports = { GRIN_ADDR_RE };
