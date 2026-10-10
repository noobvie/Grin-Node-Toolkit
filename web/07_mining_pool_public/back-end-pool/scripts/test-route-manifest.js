'use strict';

// T2 — the route manifest (code-layout refactor, plan §5). Registers every route WITHOUT booting
// anything: routes/index.js's registerRoutes(app, ctx) is called with a RECORDER for `app` and a
// stub `ctx`, and the recorded list is checked four ways:
//
//   1. Golden  — the set of {method, path, chain, handler} equals scripts/fixtures/route-manifest.json.
//   2. Order   — every pair of entries that can match ONE request keeps the golden's relative order
//                (Express takes the first match). With --exact (refactor parts P1–P2) the WHOLE
//                sequence must equal the golden.
//   3. Guard   — every /api/admin/* route has requireAdmin() or requireFreshAuth(…) in its chain,
//                except the ADMIN_GUARD_ALLOWLIST below (one reason per entry).
//   4. Smoke   — every handler is invoked once with stub req/res. Fails ONLY on a ReferenceError,
//                or a TypeError "x is not a function" naming a bare identifier, thrown from route
//                code — INCLUDING one the handler's own try/catch swallows into a 500 (an in-thread
//                inspector pauses on caught exceptions). This is the request-time failure of a
//                missing identifier (plan H2) — secondary to the eslint no-undef pass (T3).
//
// Plus: the keys registerRoutes reads from ctx == the keys index.js passes (a key index.js forgets
// is `undefined` at request time, which neither T3 nor the golden can see); every name a route file
// destructures from a require() (or a required factory) exists on that module (same blind spot);
// and the recorder's own express.Router() support is self-tested before the later parts rely on it.
//
// Middleware names: a factory TAG for requireAdmin()/requireFreshAuth(<maxAge>) and multer.<fn>(…)
// (require.cache is seeded with wrappers BEFORE routes/ is loaded — requireAdmin() returns an
// anonymous arrow, so fn.name cannot identify it, plan H16); a stub-ctx function is named by its
// access path, literal args included (`rateLimiter.middleware('admin')`); else fn.name; else
// `anon#<sha1 of the function's source>` — never '' (two different anonymous middlewares must not
// compare equal), and stable when a route is MOVED verbatim between files, which a file:line name
// would not be (failure messages print the file:line). A middleware ARRAY expands to its members.
//
// gamesLink (plan H15): the REAL lib's mountAdmin() registers its two routes (so their chain is the
// true one), but attach() — which starts a 60 s setInterval probe — is a no-op here.
//
//   node scripts/test-route-manifest.js [--exact] [--write-golden] [--print]
//
// --write-golden rewrites the fixture. That is a REVIEWED act: the commit that changes the fixture
// must say why (plan §8). Nothing is left running: no server, no timer, no network (fetch is stubbed
// during the smoke pass, which runs in a throwaway cwd), and the process exits explicitly.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const inspector = require('inspector');
const { readAppSource, routeFilesInOrder, APP } = require('./lib/app-source');

const argv = process.argv.slice(2);
const EXACT = argv.includes('--exact');
const WRITE = argv.includes('--write-golden');
const PRINT = argv.includes('--print');
const GOLDEN = path.join(__dirname, 'fixtures', 'route-manifest.json');

let pass = 0, fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else      { fail++; console.error(`  FAIL  ${name}${extra ? ' — ' + extra : ''}`); }
}

// /api/admin/* routes that legitimately carry NEITHER requireAdmin() nor requireFreshAuth(…),
// keyed 'METHOD path' with a one-line reason each. R1 audits every line; adding one is a reviewed
// act like a golden edit. EMPTY as derived from the code at P1 (2026-10-10): everything reachable
// before an admin session exists lives under /api/auth/ (captcha, register, login, login/totp,
// refresh, logout), and /api/admin/_authcheck, /reauth and /2fa/* each carry requireAdmin() or
// requireFreshAuth(300) themselves.
const ADMIN_GUARD_ALLOWLIST = {};

// ─── names ──────────────────────────────────────────────────────────────────────────────────────
const TAGS = new WeakMap();                // fn → name given by a factory wrapper
const STUB = Symbol('stub-path');
const tag = (fn, name) => { TAGS.set(fn, name); return fn; };
const fmtArg = (a) => {
  if (typeof a === 'string') return `'${a}'`;
  if (typeof a === 'number' || typeof a === 'boolean' || a === null || a === undefined) return String(a);
  if (typeof a === 'function' && a[STUB]) return a[STUB];
  if (typeof a === 'function') return 'fn';
  if (a instanceof RegExp) return String(a);
  if (Array.isArray(a)) return '[…]';
  return '{…}';
};
const fmtArgs = (args) => args.map(fmtArg).join(', ');
const srcHash = (fn) => crypto.createHash('sha1').update(Function.prototype.toString.call(fn)).digest('hex').slice(0, 8);
function nameOf(fn) {
  if (TAGS.has(fn)) return TAGS.get(fn);
  if (fn[STUB]) return fn[STUB];
  if (fn.name) return fn.name;
  return `anon#${srcHash(fn)}`;
}

// ─── stub values ────────────────────────────────────────────────────────────────────────────────
// A stub is a callable Proxy: any property is another stub, any call/construct returns a stub, it is
// not a thenable, iterates as empty, and coerces to 0 / a string holding a NUL byte — so a path built
// from it is REFUSED by fs and child_process (ERR_INVALID_ARG_VALUE) instead of touching the disk.
// Assignments are remembered (`stratumPause.onChange = invalidateBranding` reads back).
function mkStub(p) {
  const assigned = new Map();
  return new Proxy(function () {}, {
    get(t, k) {
      if (k === STUB) return p;
      if (assigned.has(k)) return assigned.get(k);
      if (k === 'then' || k === 'catch' || k === Symbol.asyncIterator) return undefined;
      if (k === Symbol.toPrimitive) return (hint) => (hint === 'number' ? 0 : `\0stub:${p}`);
      if (k === Symbol.iterator) return function* () {};
      if (k === 'toJSON') return () => `stub:${p}`;
      if (k === 'length') return 0;
      if (k === 'prototype') return t.prototype;
      if (typeof k === 'symbol') return undefined;
      return mkStub(`${p}.${k}`);
    },
    set(t, k, v) { assigned.set(k, v); return true; },
    apply(t, self, args) { return mkStub(`${p}(${fmtArgs(args)})`); },
    construct(t, args) { return mkStub(`new ${p}(${fmtArgs(args)})`); },
  });
}

// ─── require.cache seeding (BEFORE routes/ is loaded) ───────────────────────────────────────────
function seed(spec, exportsValue) {
  const id = require.resolve(spec, { paths: [APP] });
  const m = new module.constructor(id, module);
  m.filename = id; m.loaded = true; m.exports = exportsValue;
  require.cache[id] = m;
}
const realAuth = require(path.join(APP, 'lib/auth-middleware'));
seed(path.join(APP, 'lib/auth-middleware.js'), {
  ...realAuth,
  requireAdmin: (...a) => tag(realAuth.requireAdmin(...a), 'requireAdmin()'),
  requireFreshAuth: (am, maxAge) => tag(realAuth.requireFreshAuth(am, maxAge), `requireFreshAuth(${maxAge === undefined ? '' : fmtArg(maxAge)})`),
});
const realMulter = require(require.resolve('multer', { paths: [APP] }));
const MULTER_FNS = new Set(['single', 'array', 'fields', 'none', 'any']);
seed('multer', Object.assign((opts) => {
  const inst = realMulter(opts);
  return new Proxy(inst, {
    get(t, k) {
      if (MULTER_FNS.has(k)) return (...a) => tag(t[k](...a), `multer.${k}(${fmtArgs(a)})`);
      return t[k];
    },
  });
}, realMulter));

// ─── the recorder ───────────────────────────────────────────────────────────────────────────────
const VERBS = ['get', 'post', 'put', 'patch', 'delete', 'all'];
const ROUTE_FILE_RE = /[\\/](routes[\\/].+?\.js|lib[\\/]games-link\.js):(\d+):\d+/;
function callSite() {
  const st = new Error().stack.split('\n');
  for (const l of st) { const m = ROUTE_FILE_RE.exec(l); if (m) return { file: m[1].replace(/\\/g, '/'), line: Number(m[2]) }; }
  return { file: '?', line: 0 };
}
const routers = new Set();
const RECORDERS = new WeakSet();   // not a property probe: a stub answers ANY property
function makeRecorder(kind) {
  const list = [];
  const rec = function recorderRouter() { throw new Error('the recorder is not a request handler'); };
  RECORDERS.add(rec);
  rec.__list = list;
  rec.__kind = kind;
  rec.__mounted = 0;
  const flatten = (fns) => fns.flat(Infinity);
  const add = (method, args) => {
    const site = callSite();
    let p = null;
    if (typeof args[0] === 'string' || Array.isArray(args[0]) || args[0] instanceof RegExp) p = args.shift();
    const fns = flatten(args);
    if (method === 'use') {
      // A mounted recorder Router: splice its routes in HERE (registration order = match order).
      const sub = fns.filter((f) => RECORDERS.has(f));
      if (sub.length) {
        if (p !== null) throw new Error(`${site.file}:${site.line}: a Router mounted with a prefix ('${p}') — route files write FULL paths (plan §2)`);
        if (sub.length !== fns.length) throw new Error(`${site.file}:${site.line}: app.use() mixes a Router with middleware`);
        for (const r of sub) { r.__mounted++; list.push(...r.__list); }
        return rec;
      }
      if (p === null) p = '/';
    }
    if (p instanceof RegExp) p = String(p);
    if (!fns.length || fns.some((f) => typeof f !== 'function')) {
      throw new Error(`${site.file}:${site.line}: ${method} ${JSON.stringify(p)} registered with a non-function`);
    }
    const handler = fns[fns.length - 1];
    list.push({
      method, path: p,
      chain: fns.slice(0, -1).map(nameOf),
      handler: TAGS.has(handler) || handler[STUB] || handler.name ? nameOf(handler) : 'anon',
      file: site.file, line: site.line, fn: handler,
    });
    return rec;
  };
  for (const v of VERBS) rec[v] = (...a) => add(v, a);
  rec.use = (...a) => add('use', a);
  rec.param = (name) => { throw new Error(`app.param('${name}') — not modelled by the recorder; extend T2 first`); };
  if (kind === 'router') routers.add(rec);
  return rec;
}
const realExpress = require(require.resolve('express', { paths: [APP] }));
seed('express', Object.assign(function express() { return realExpress(); }, realExpress, {
  Router: () => makeRecorder('router'),
}));

// ─── stub ctx — every key read is recorded ──────────────────────────────────────────────────────
const UPLOADS_DIR = path.join(os.tmpdir(), `route-manifest-nonexistent-${process.pid}`);
const ctxReads = new Set();
const realGames = require(path.join(APP, 'lib/games-link')).createGamesLink();
const gamesLink = new Proxy(realGames, {
  get(t, k) {
    if (k === 'attach') return () => {};                  // H15: no 60 s probe timer
    if (k === 'mountAdmin') return t.mountAdmin;          // the REAL two routes, on the recorder
    if (typeof t[k] === 'function') return mkStub(`gamesLink.${String(k)}`);
    return t[k];
  },
});
const CTX_VALUES = {
  uploadsDir: UPLOADS_DIR,          // truthy, so the /uploads anchor is registered (H15)
  gamesLink,
};
const stubCtx = new Proxy({}, {
  get(t, k) {
    if (typeof k === 'symbol') return undefined;
    ctxReads.add(k);
    return Object.prototype.hasOwnProperty.call(CTX_VALUES, k) ? CTX_VALUES[k] : mkStub(k);
  },
});

// ─── register ───────────────────────────────────────────────────────────────────────────────────
const app = makeRecorder('app');
const registerRoutes = require(path.join(APP, 'routes'));
registerRoutes(app, stubCtx);
const entries = app.__list;
const strip = (e) => ({ method: e.method, path: e.path, chain: e.chain, handler: e.handler });
const keyOf = (e) => JSON.stringify(strip(e));
const where = (e) => `${e.file}:${e.line}`;

if (PRINT) for (const e of entries) console.log(`${e.method.toUpperCase().padEnd(6)} ${JSON.stringify(e.path)}  [${e.chain.join(', ')}] → ${e.handler}  (${where(e)})`);

console.log(`\nT2 route manifest — ${entries.length} entries recorded${EXACT ? ' (--exact)' : ''}\n`);

// ─── 0. the recorder itself ─────────────────────────────────────────────────────────────────────
{
  const exp = require('express');
  const a = makeRecorder('app');
  const r = exp.Router();
  a.get('/x/first', function first(q, s) {});
  r.get('/x/:id', function viaRouter(q, s) {});
  a.use(r);
  a.get('/x/last', function last(q, s) {});
  ok('0. a Router mounted without prefix is spliced in at its mount point',
    a.__list.map((e) => e.handler).join(',') === 'first,viaRouter,last' && r.__mounted === 1);
  let threw = false;
  try { a.use('/pre', exp.Router()); } catch (e) { threw = /prefix/.test(e.message); }
  ok('0. a Router mounted WITH a prefix is refused (route files write full paths)', threw);
  routers.clear();
  const tagged = require(path.join(APP, 'lib/auth-middleware'));
  ok('0. requireAdmin()/requireFreshAuth() are tagged (H16)',
    nameOf(tagged.requireAdmin(mkStub('am'))) === 'requireAdmin()' &&
    nameOf(tagged.requireFreshAuth(mkStub('am'), 120)) === 'requireFreshAuth(120)');
  ok('0. two different anonymous functions never share a name',
    nameOf((q, s) => s.a()) !== nameOf((q, s) => s.b()) && !/^$/.test(nameOf(() => {})));
}

// ─── sanity: what was recorded vs what the source registers ─────────────────────────────────────
{
  const src = readAppSource();
  const literal = [...src.matchAll(/\b(?:app|router)\.(get|post|put|patch|delete|all)\(\s*(?:'([^']*)'|(\[[^\]]*\]))/g)];
  const recordedRoutes = entries.filter((e) => e.method !== 'use');
  const fromLib = recordedRoutes.filter((e) => !e.file.startsWith('routes/'));
  ok('sanity: every (app|router).<verb>( registration in the source was recorded, plus the 2 games-link routes',
    recordedRoutes.length === literal.length + 2 && fromLib.length === 2,
    `source ${literal.length}, recorded ${recordedRoutes.length} (from lib ${fromLib.length})`);
  const seq = literal.map((m) => `${m[1]} ${m[2] !== undefined ? m[2] : m[3].replace(/\s+/g, '')}`);
  const recSeq = recordedRoutes.filter((e) => e.file.startsWith('routes/'))
    .map((e) => `${e.method} ${Array.isArray(e.path) ? JSON.stringify(e.path).replace(/"/g, "'") : e.path}`);
  // From P3 on the routes live in several files, so registration order is no longer the order
  // readAppSource() concatenates them in — compare as a multiset; ORDER is asserted against the golden (2.).
  const norm = (arr) => arr.map((x) => x.replace(/\s+/g, '')).sort();
  const ns = norm(seq), nr = norm(recSeq);
  const firstDiff = ns.length !== nr.length ? 0 : ns.findIndex((v, i) => v !== nr[i]);
  ok('sanity: the recorded (method, path) multiset equals the source registrations', ns.length === nr.length && firstDiff === -1,
    firstDiff === -1 ? '' : `${ns.length} vs ${nr.length}; first diff "${ns[firstDiff]}" vs "${nr[firstDiff]}"`);
  ok('sanity: the app.use anchors are present (/api/account gate, /uploads static, final 404)',
    entries.some((e) => e.method === 'use' && e.path === '/api/account') &&
    entries.some((e) => e.method === 'use' && e.path === '/uploads' && e.handler === 'serveStatic') &&
    entries[entries.length - 1].method === 'use' && entries[entries.length - 1].path === '/');
  const unmounted = [...routers].filter((r) => r.__mounted !== 1);
  ok('sanity: every Router created is mounted exactly once', unmounted.length === 0,
    `${unmounted.length} router(s) mounted ${unmounted.map((r) => r.__mounted).join('/')} times`);
}

// ─── ctx: what registerRoutes reads == what index.js passes ─────────────────────────────────────
{
  const idx = fs.readFileSync(path.join(APP, 'index.js'), 'utf8');
  const m = /registerRoutes\(app,\s*\{([\s\S]*?)\}\);/.exec(idx);
  const passed = new Set(m ? m[1].replace(/\/\/.*$/gm, '').split(/[\s,]+/).filter(Boolean) : []);
  const missing = [...ctxReads].filter((k) => !passed.has(k));
  const unused = [...passed].filter((k) => !ctxReads.has(k));
  ok('ctx: index.js calls registerRoutes(app, { … }) with a shorthand object literal', !!m && passed.size > 0);
  ok('ctx: every key the routes read is passed by index.js', missing.length === 0, `missing: ${missing.join(', ')}`);
  ok('ctx: index.js passes no key the routes never read', unused.length === 0, `unused: ${unused.join(', ')}`);
}

// ─── requires: every name a route file destructures from a module exists on it ─────────────────
// T3 (no-undef) cannot see this: `const { x } = require('../lib/y')` DEFINES x, so a name y does
// not export is `undefined` until a request calls it — a 500 on one button (plan H2), and the smoke
// only notices if a stub request happens to reach the call (R1 2026-10-10: `hubRttMs` taken from the
// wrong lib passed T3, the smoke and the golden). Every route file writes its own require list (H17),
// so this is checked for all of them. Also covers `const { … } = createX(ctx)` where createX is a
// required factory (guards/csv: called again with the stub ctx, its result checked) and
// `const { … } = caches` where caches is a required module binding.
{
  const bad = [];
  let checked = 0;
  const DESTRUCTURE = /(?:const|let|var)\s*\{([^}]*)\}\s*=\s*(require\(\s*(['"])([^'"]+)\3\s*\)|([A-Za-z_$][\w$]*)\s*(\(\s*ctx\s*\))?(?![\w$.(]))/g;
  const keysOf = (list) => list.split(',').map((p) => p.split(':')[0].split('=')[0].trim()).filter((k) => k && !k.startsWith('...'));
  for (const file of routeFilesInOrder()) {
    const code = fs.readFileSync(file, 'utf8').replace(/^\s*\/\/.*$/gm, '');
    const rel = path.relative(APP, file).replace(/\\/g, '/');
    const load = (spec) => require(spec.startsWith('.') ? path.resolve(path.dirname(file), spec) : require.resolve(spec, { paths: [APP] }));
    const factories = new Map();   // local name → spec, for `const createX = require('./_shared/x')`
    for (const m of code.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\(\s*(['"])([^'"]+)\2\s*\)/g)) factories.set(m[1], m[3]);
    for (const m of code.matchAll(DESTRUCTURE)) {
      let source, from;
      if (m[4] !== undefined) { from = `require('${m[4]}')`; source = load(m[4]); }
      else {
        const name = m[5];
        if (name === 'guards' && /module\.exports\s*=\s*function\s+\w+\(\s*ctx\s*,\s*guards\s*\)/.test(code)) {
          // The hand-off parameter (P3+): routes/index.js passes ITS createGuards(ctx) result. Check the names
          // against a fresh createGuards(stubCtx) — a typo'd `stepUpRefusd` is otherwise `undefined` until a request.
          from = 'the `guards` hand-off'; source = require(path.join(APP, 'routes/_shared/guards'))(stubCtx);
        } else {
          if (!factories.has(name)) continue;                  // not a required binding — ctx check / T3 territory
          const mod = load(factories.get(name));
          if (m[6]) { from = `${name}(ctx)`; source = mod(stubCtx); }
          else { from = name; source = mod; }
        }
      }
      for (const k of keysOf(m[1])) {
        checked++;
        if (source == null || source[k] === undefined) bad.push(`${rel}: '${k}' from ${from}`);
      }
    }
  }
  ok(`requires: every name destructured from a require() or a required factory in routes/ exists on it (${checked} names)`,
    checked > 0 && bad.length === 0, bad.join('; '));
}

// ─── 1. golden ──────────────────────────────────────────────────────────────────────────────────
let golden = null;
if (WRITE) {
  fs.mkdirSync(path.dirname(GOLDEN), { recursive: true });
  fs.writeFileSync(GOLDEN, JSON.stringify(entries.map(strip), null, 1) + '\n');
  console.log(`  wrote ${path.relative(APP, GOLDEN)} (${entries.length} entries) — a REVIEWED change: say why in the commit`);
}
try { golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8')); } catch (e) { golden = null; }
ok('1. golden fixture exists', Array.isArray(golden), `${path.relative(APP, GOLDEN)} missing — run once with --write-golden`);
if (golden) {
  const count = (list) => list.reduce((m, k) => m.set(k, (m.get(k) || 0) + 1), new Map());
  const g = count(golden.map((e) => JSON.stringify(e)));
  const c = count(entries.map(keyOf));
  const onlyGolden = [...g].filter(([k, n]) => (c.get(k) || 0) < n).map(([k]) => k);
  const onlyNow = [...c].filter(([k, n]) => (g.get(k) || 0) < n).map(([k]) => k);
  ok('1. the route set equals the golden (method, path, middleware chain, handler)',
    onlyGolden.length === 0 && onlyNow.length === 0,
    `\n      missing (in golden, not registered): ${onlyGolden.slice(0, 8).join('\n        ') || '—'}` +
    `\n      extra   (registered, not in golden): ${onlyNow.slice(0, 8).join('\n        ') || '—'}`);

  // ─── 2. order ────────────────────────────────────────────────────────────────────────────────
  if (EXACT) {
    const i = golden.findIndex((e, n) => !entries[n] || JSON.stringify(e) !== keyOf(entries[n]));
    ok('2. --exact: the registration sequence equals the golden, entry for entry',
      i === -1 && golden.length === entries.length,
      i === -1 ? `length ${entries.length} vs ${golden.length}` : `first difference at #${i}: golden ${JSON.stringify(golden[i])} vs now ${entries[i] ? keyOf(entries[i]) + ' (' + where(entries[i]) + ')' : '—'}`);
  }
  // Pairs that can match one request keep their relative order (always checked; implied by --exact).
  const occ = (list, kf) => { const seen = new Map(); return list.map((e) => { const k = kf(e); const n = seen.get(k) || 0; seen.set(k, n + 1); return `${k}#${n}`; }); };
  const gIds = occ(golden, (e) => JSON.stringify(e));
  const posNow = new Map(occ(entries, keyOf).map((id, n) => [id, n]));
  const bad = [];
  for (let a = 0; a < golden.length; a++) {
    for (let b = a + 1; b < golden.length; b++) {
      if (!canOverlap(golden[a], golden[b])) continue;
      const pa = posNow.get(gIds[a]), pb = posNow.get(gIds[b]);
      if (pa === undefined || pb === undefined) continue;   // reported by the golden check
      if (pa > pb) bad.push(`${golden[a].method} ${JSON.stringify(golden[a].path)} must precede ${golden[b].method} ${JSON.stringify(golden[b].path)}`);
    }
  }
  ok('2. every pair that can match one request keeps its golden order', bad.length === 0, bad.slice(0, 8).join('; '));
}

// Path-pattern overlap, Express 4 / path-to-regexp 0.1 semantics: ':x' = one segment, ':x?' = an
// optional segment, '*' = anything (including nothing) from there on; a `use` entry matches by
// segment PREFIX. Errs toward "overlaps" — a false pair only costs an extra order constraint.
function segsOf(p) {
  return String(p).split('/').filter(Boolean).map((s) => (s === '*' || s.endsWith('*') ? { star: true }
    : s.startsWith(':') ? { param: true, optional: s.endsWith('?') } : { lit: s }));
}
function segMatch(A, B, i, j, prefixA, prefixB) {
  if (i === A.length && j === B.length) return true;
  if ((i < A.length && A[i].star) || (j < B.length && B[j].star)) return true;
  if (i === A.length) return prefixA || B.slice(j).every((s) => s.optional);
  if (j === B.length) return prefixB || A.slice(i).every((s) => s.optional);
  const a = A[i], b = B[j];
  if (a.optional && segMatch(A, B, i + 1, j, prefixA, prefixB)) return true;
  if (b.optional && segMatch(A, B, i, j + 1, prefixA, prefixB)) return true;
  if (a.lit !== undefined && b.lit !== undefined && a.lit !== b.lit) return false;
  return segMatch(A, B, i + 1, j + 1, prefixA, prefixB);
}
function canOverlap(x, y) {
  const mx = x.method, my = y.method;
  const methodsMeet = mx === my || mx === 'all' || my === 'all' || mx === 'use' || my === 'use';
  if (!methodsMeet) return false;
  const px = Array.isArray(x.path) ? x.path : [x.path];
  const py = Array.isArray(y.path) ? y.path : [y.path];
  return px.some((a) => py.some((b) => {
    if (String(a).startsWith('/') === false || String(b).startsWith('/') === false) return true; // a RegExp path
    return segMatch(segsOf(a), segsOf(b), 0, 0, mx === 'use', my === 'use');
  }));
}

// ─── 3. guard ───────────────────────────────────────────────────────────────────────────────────
{
  const isAdminPath = (p) => (Array.isArray(p) ? p : [p]).some((s) => /^\/api\/admin(\/|$)/.test(String(s)));
  const guarded = (e) => e.chain.some((n) => n === 'requireAdmin()' || n.startsWith('requireFreshAuth('));
  const admin = entries.filter((e) => isAdminPath(e.path));
  const unguarded = admin.filter((e) => !guarded(e));
  const key = (e) => `${e.method.toUpperCase()} ${e.path}`;
  const notAllowed = unguarded.filter((e) => !ADMIN_GUARD_ALLOWLIST[key(e)]);
  ok(`3. every /api/admin/* route (${admin.length}) carries requireAdmin() or requireFreshAuth(…), or is allowlisted`,
    notAllowed.length === 0, notAllowed.map((e) => `${key(e)} (${where(e)}) chain [${e.chain.join(', ')}]`).join('; '));
  const stale = Object.keys(ADMIN_GUARD_ALLOWLIST).filter((k) => !unguarded.some((e) => key(e) === k));
  ok('3. every allowlist entry still names an unguarded /api/admin route (no stale exemptions)', stale.length === 0, stale.join('; '));
  ok('3. no use() entry sits under /api/admin (a router-level guard is plan I8 territory)',
    !entries.some((e) => e.method === 'use' && isAdminPath(e.path)));
}

// ─── 4. smoke ───────────────────────────────────────────────────────────────────────────────────
(async () => {
  const session = new inspector.Session();
  session.connect();
  const scripts = new Map();
  const hits = [];
  let current = null;
  const ROUTE_URL = /[\\/]routes[\\/]/;
  session.on('Debugger.scriptParsed', (m) => scripts.set(m.params.scriptId, m.params.url));
  session.on('Debugger.paused', (m) => {
    try {
      const p = m.params;
      if (p.reason === 'exception' || p.reason === 'promiseRejection') {
        const f = p.callFrames[0];
        const url = f ? (scripts.get(f.location.scriptId) || f.url || '') : '';
        const desc = String((p.data && p.data.description) || '').split('\n')[0];
        const cls = p.data && p.data.className;
        const bareNotFn = cls === 'TypeError' && /^TypeError: [A-Za-z_$][\w$]* is not a (function|constructor)\b/.test(desc);
        if (ROUTE_URL.test(decodeURIComponent(url)) && (cls === 'ReferenceError' || bareNotFn)) {
          hits.push(`${desc} at ${path.basename(url)}:${f.location.lineNumber + 1} (while running ${current})`);
        }
      }
    } finally {
      session.post('Debugger.resume');
    }
  });
  session.post('Debugger.enable');
  session.post('Debugger.setPauseOnExceptions', { state: 'all' });

  const saved = { log: console.log, error: console.error, warn: console.warn, info: console.info, fetch: globalThis.fetch, cwd: process.cwd() };
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'route-manifest-smoke-'));
  const swallow = () => {};
  process.on('unhandledRejection', swallow);
  globalThis.fetch = async () => { throw new Error('route-manifest smoke: network disabled'); };
  process.chdir(sandbox);
  console.log = console.error = console.warn = console.info = () => {};
  let invoked = 0;
  try {
    for (const e of entries) {
      const fn = e.fn;
      if (RECORDERS.has(fn) || e.handler === 'serveStatic') continue;   // express internals / mounted routers
      current = `${e.method.toUpperCase()} ${JSON.stringify(e.path)} (${where(e)})`;
      invoked++;
      try {
        const r = fn(mkStub('req'), mkStub('res'), () => {});
        if (r && typeof r.then === 'function') {
          await Promise.race([r.catch(() => {}), new Promise((res) => setTimeout(res, 200))]);
        }
      } catch (err) { /* classified by the inspector, not here */ }
    }
    await new Promise((res) => setTimeout(res, 50));   // let stray continuations land
  } finally {
    Object.assign(console, { log: saved.log, error: saved.error, warn: saved.warn, info: saved.info });
    globalThis.fetch = saved.fetch;
    process.chdir(saved.cwd);
    session.post('Debugger.setPauseOnExceptions', { state: 'none' });
    session.disconnect();
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch (e) { /* best effort */ }
  }
  ok(`4. smoke: ${invoked} handlers invoked, no ReferenceError / bare "x is not a function" from route code`,
    hits.length === 0, [...new Set(hits)].slice(0, 10).join('\n      '));
  ok('4. smoke: nothing was written to the uploads dir stand-in', !fs.existsSync(UPLOADS_DIR));

  console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nALL PASS — ${pass} passed, 0 failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
