// GET /api/public/endpoints lists the public API by WALKING the Express route table
// (the api-docs page is built from it). Since the code-layout refactor the routes live in
// mounted Routers, which appear in app._router.stack as `router` layers with their own stack —
// a walker that only reads top-level `layer.route` silently loses every route that has moved.
// Nothing else exercises the handler against a real Express app, so this does.
//
// In-process only: a real express app, the real public.js, the handler invoked directly. No server.
// Run: node scripts/test-endpoints-directory.js
const path = require('path');
const express = require('express');

const APP = path.resolve(__dirname, '..');
const createPublicRoutes = require(path.join(APP, 'routes/public.js'));

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${extra ? ' — ' + extra : ''}`); }
};

const pass1 = (req, res, next) => next();
const ctx = {
  rateLimiter: { middleware: () => pass1, limits: { public: 1, withdraw: 1, export: 1, torcheck: 1 } },
  config: { network: 'mainnet' },
};

const app = express();
app.get('/api/pool/stats', (req, res) => {});                         // top-level (documented in API_DOC_META)
app.use(createPublicRoutes(ctx));                                     // routes inside a mounted Router
const r2 = express.Router();                                          // a second Router, as P4 will add
r2.get('/api/pool/blocks', (req, res) => {});
app.use(r2);
const outer = express.Router();                                       // a Router nested in a Router
const inner = express.Router();
inner.get('/api/pool/effort', (req, res) => {});
outer.use(inner);
app.use(outer);

const find = (stack) => {
  for (const l of stack) {
    if (l.route && l.route.path === '/api/public/endpoints') return l.route.stack[l.route.stack.length - 1].handle;
    if (l.name === 'router' && l.handle && l.handle.stack) { const h = find(l.handle.stack); if (h) return h; }
  }
  return null;
};
const handler = find(app._router.stack);
ok('the endpoints handler is reachable inside the mounted public router', typeof handler === 'function');

let body = null;
const res = { setHeader() {}, json(b) { body = b; }, status() { return res; } };
handler({ app }, res);
const keys = new Set(((body && body.data && body.data.endpoints) || []).map((e) => `${e.method} ${e.path}`));
ok('responds with success', body && body.success === true, JSON.stringify(body).slice(0, 120));
ok('lists a top-level route', keys.has('GET /api/pool/stats'));
ok('lists the routes of the router that holds the handler itself', keys.has('GET /api/public/endpoints') && keys.has('GET /api/public/branding'));
ok('lists a route of a second mounted Router', keys.has('GET /api/pool/blocks'));
ok('lists a route of a Router nested in a Router', keys.has('GET /api/pool/effort'));
ok('no route is listed twice', ((body && body.data && body.data.endpoints) || []).length === keys.size);

console.log(fail ? `\nFAILURES — ${pass} passed, ${fail} failed` : `\nALL PASS — ${pass} passed, 0 failed`);
process.exit(fail ? 1 : 0);
