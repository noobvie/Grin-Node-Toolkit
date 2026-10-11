// OPTIONS must fall through every route-file Router to the final 404, exactly as it did when all
// routes sat on the app's own router (code-layout refactor, R2 finding). An Express Router answers
// OPTIONS itself — `200 Allow: GET,HEAD` — when a request runs off its stack and some route in it
// matched the path; mounted without routes/_shared/no-auto-options.js that turned every admin and
// auth path's 404 into a method listing served ahead of the IP filter and the rate limiter. The
// route manifest (T2) records into a stub and never sees it, and no other test sends OPTIONS to the
// real app.
//
// Real express + the real registerRoutes() on a stub ctx (no handler or middleware runs: OPTIONS
// never reaches a route). Binds 127.0.0.1 on an ephemeral port and closes it before exiting.
// Run: node scripts/test-router-options.js
const path = require('path');
const os = require('os');
const http = require('http');
const express = require('express');

const APP = path.resolve(__dirname, '..');
const noAutoOptions = require(path.join(APP, 'routes/_shared/no-auto-options.js'));

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${extra ? ' — ' + extra : ''}`); }
};

// A stub is a callable Proxy: any property is another stub, any call returns a stub, never a
// thenable. Registration only builds middleware chains from ctx; nothing here runs them.
function mkStub(p) {
  const assigned = new Map();
  return new Proxy(function () {}, {
    get(t, k) {
      if (assigned.has(k)) return assigned.get(k);
      if (k === 'then' || k === 'catch' || k === Symbol.asyncIterator) return undefined;
      if (k === Symbol.toPrimitive) return (hint) => (hint === 'number' ? 0 : `\0stub:${p}`);
      if (k === Symbol.iterator) return function* () {};
      if (k === 'length') return 0;
      if (k === 'prototype') return t.prototype;
      if (typeof k === 'symbol') return undefined;
      return mkStub(`${p}.${String(k)}`);
    },
    set(t, k, v) { assigned.set(k, v); return true; },
    apply() { return mkStub(`${p}()`); },
    construct() { return mkStub(`new ${p}`); },
  });
}

const listen = (app) => new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const send = (port, method, p) => new Promise((resolve) => {
  const rq = http.request({ host: '127.0.0.1', port, path: p, method, timeout: 3000 }, (rs) => {
    let body = ''; rs.on('data', (d) => (body += d));
    rs.on('end', () => resolve({ status: rs.statusCode, allow: rs.headers.allow, body }));
  });
  rq.on('timeout', () => { rq.destroy(); resolve({ status: 'timeout' }); });
  rq.on('error', (e) => resolve({ status: `error ${e.code}` }));
  rq.end();
});
const notFound = (req, res) => res.status(404).json({ error: 'Not found' });

(async () => {
  // ── a. the hazard is real in this Express, and the wrapper removes it ──────────────────────
  {
    const bare = express(); const r = express.Router();
    r.get('/x', (req, res) => res.status(200).end('x'));
    bare.use(r); bare.use(notFound);
    const s = await listen(bare); const port = s.address().port;
    const o = await send(port, 'OPTIONS', '/x');
    ok('a. control: a bare mounted Router answers OPTIONS itself (Express behaviour this guards)',
      o.status === 200 && /GET/.test(o.allow || ''), JSON.stringify(o));
    await new Promise((d) => s.close(d));

    const wrapped = express(); const w = express.Router();
    w.get('/x', (req, res) => res.status(200).end('x'));
    w.post('/x', (req, res, next) => next());       // a handler that passes on must still reach the 404
    const same = noAutoOptions(w);
    wrapped.use(same); wrapped.use(notFound);
    const s2 = await listen(wrapped); const p2 = s2.address().port;
    const o2 = await send(p2, 'OPTIONS', '/x');
    const g2 = await send(p2, 'GET', '/x');
    const h2 = await send(p2, 'HEAD', '/x');
    const n2 = await send(p2, 'POST', '/x');
    ok('a. noAutoOptions returns the SAME Router (endpoints walker + T2 recognise it)', same === w);
    ok('a. wrapped: OPTIONS falls through to the 404', o2.status === 404 && !o2.allow, JSON.stringify(o2));
    ok('a. wrapped: GET and HEAD still reach the route', g2.status === 200 && g2.body === 'x' && h2.status === 200, JSON.stringify([g2, h2]));
    ok('a. wrapped: next() from a route still reaches the 404', n2.status === 404, JSON.stringify(n2));
    await new Promise((d) => s2.close(d));
  }

  // ── b. the real app ──────────────────────────────────────────────────────────────────────────
  const realGames = require(path.join(APP, 'lib/games-link')).createGamesLink();
  const gamesLink = new Proxy(realGames, {
    get(t, k) {
      if (k === 'attach') return () => {};                 // no 60 s health-probe timer
      if (k === 'mountAdmin') return t.mountAdmin;
      if (typeof t[k] === 'function') return mkStub(`gamesLink.${String(k)}`);
      return t[k];
    },
  });
  const VALUES = { uploadsDir: path.join(os.tmpdir(), `router-options-nonexistent-${process.pid}`), gamesLink };
  const ctx = new Proxy({}, { get(t, k) { if (typeof k === 'symbol') return undefined; return k in VALUES ? VALUES[k] : mkStub(k); } });
  const app = express();
  require(path.join(APP, 'routes'))(app, ctx);

  const mounted = app._router.stack.filter((l) => l.name === 'router' && l.handle && l.handle.stack);
  const unwrapped = mounted.filter((l) => !(l.handle.handle && l.handle.handle.name === 'noAutoOptionsHandle'));
  ok('b. every Router mounted on the app goes through noAutoOptions', mounted.length >= 16 && unwrapped.length === 0,
    `${mounted.length} mounted, unwrapped: ${unwrapped.map((l) => (l.handle.stack.find((x) => x.route) || { route: { path: '?' } }).route.path).join(', ')}`);

  // Skipping a Router for OPTIONS is exact only while none of its routes handles OPTIONS.
  const walk = (stack, acc = []) => { for (const l of stack) { if (l.route) acc.push(l.route); else if (l.name === 'router' && l.handle && l.handle.stack) walk(l.handle.stack, acc); } return acc; };
  const inRouters = mounted.flatMap((l) => walk(l.handle.stack));
  const handlesOptions = inRouters.filter((r) => r.methods._all || r.methods.options);
  ok('b. no route inside a Router handles OPTIONS (ALL/OPTIONS) — the skip would drop it',
    inRouters.length > 150 && handlesOptions.length === 0,
    `${inRouters.length} routes; offenders: ${handlesOptions.map((r) => r.path).join(', ')}`);

  const GADDR = 'grin1' + 'q'.repeat(58);
  const targets = new Set();
  for (const r of inRouters) {
    for (const p of (Array.isArray(r.path) ? r.path : [r.path])) {
      if (typeof p !== 'string') continue;
      targets.add(p.replace(/:addr\b/g, GADDR).replace(/:[A-Za-z_]+\??/g, 'x1').replace(/\*/g, 'a/b'));
    }
  }
  const s = await listen(app); const port = s.address().port;
  const wrong = [];
  for (const t of targets) {
    const o = await send(port, 'OPTIONS', t);
    let body = null; try { body = JSON.parse(o.body); } catch (e) { /* not JSON */ }
    if (!(o.status === 404 && !o.allow && body && body.error === 'Not found')) wrong.push(`${t} → ${o.status} allow=${o.allow || '-'}`);
  }
  await new Promise((d) => s.close(d));
  ok(`b. OPTIONS on every Router route path (${targets.size}) is the catch-all 404, with no Allow header`,
    targets.size > 100 && wrong.length === 0, wrong.slice(0, 5).join('; '));

  console.log(fail ? `\nFAILURES — ${pass} passed, ${fail} failed` : `\nALL PASS — ${pass} passed, 0 failed`);
  process.exit(fail ? 1 : 0);
})();
