'use strict';

// Source readers for tests that assert on the pool's ROUTE code.
//
// The routes used to live in ONE file (index.js, inside setupRoutes). They are moving into
// routes/**/*.js, and a test that does `fs.readFileSync('index.js')` then either FAILS after a
// move or — worse — PASSES VACUOUSLY: a "this must not appear" check over a file that no longer
// holds the code asserts nothing. Every test that asserts on route code reads it through here.
//
//   readAppSource()          index.js, then routes/**/*.js, as one string
//   routeSource(verb, path)  the source of ONE route registration, cut out for a harness to run
//
// Order of readAppSource(): index.js first (verbatim, no header — while routes/ is empty the
// result is byte-identical to the file, which the P0 conversion relies on), then every file under
// routes/ in REGISTRATION order: start at routes/index.js and follow its relative require()s
// depth-first, in the order they appear, each file once. Any file under routes/ the walk did not
// reach is appended last, sorted — a route file is never silently dropped from the read. Each
// appended file is preceded by `// ==== FILE: routes/x.js`.

const fs = require('fs');
const path = require('path');

const APP = path.join(__dirname, '..', '..');
const ROUTES = path.join(APP, 'routes');

function listJs(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listJs(full));
    else if (e.name.endsWith('.js')) out.push(full);
  }
  return out;
}

// './x' → routes/x.js | routes/x/index.js. Only files inside routes/ count.
function resolveRequire(fromFile, spec) {
  const base = path.resolve(path.dirname(fromFile), spec);
  for (const c of [base, base + '.js', path.join(base, 'index.js')]) {
    if (fs.existsSync(c) && fs.statSync(c).isFile() && c.startsWith(ROUTES + path.sep)) return c;
  }
  return null;
}

// Requires that appear as code, not inside a comment. Order of appearance = registration order.
function requiresOf(file, src) {
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const out = [];
  for (const m of code.matchAll(/require\(\s*(['"])(\.{1,2}\/[^'"]*)\1\s*\)/g)) {
    const r = resolveRequire(file, m[2]);
    if (r) out.push(r);
  }
  return out;
}

function routeFilesInOrder() {
  const seen = new Set();
  const order = [];
  const visit = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    order.push(file);
    for (const dep of requiresOf(file, fs.readFileSync(file, 'utf8'))) visit(dep);
  };
  const entry = path.join(ROUTES, 'index.js');
  if (fs.existsSync(entry)) visit(entry);
  for (const f of listJs(ROUTES).sort()) if (!seen.has(f)) { seen.add(f); order.push(f); }
  return order;
}

function readAppSource() {
  let out = fs.readFileSync(path.join(APP, 'index.js'), 'utf8');
  for (const f of routeFilesInOrder()) {
    const rel = path.relative(APP, f).replace(/\\/g, '/');
    out += `${out.endsWith('\n') ? '' : '\n'}// ==== FILE: ${rel}\n${fs.readFileSync(f, 'utf8')}`;
  }
  return out;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// The registration `(app|router).<verb>('<path>' …` up to and including its close at two-space
// indent: "\n  });" (handler passed inline) or "\n  );" (argument list opened on its own line —
// 17 of today's ~200 routes). A route file keeps its registrations at exactly that indent, so the
// cut still lands. Whichever comes FIRST wins, and the start of the NEXT registration caps it, so
// a registration with an unfamiliar close is cut short of the following route instead of running
// on into it (a positive assertion would then be satisfied by some OTHER route's text).
// Callers run the text with `new Function('__d', 'with (__d) {…}')({ app, router: app, ...deps })`,
// so either receiver works.
//
// THROWS on zero or on more than one match. A silent '' is how a cut harness passes vacuously
// (the handler it tests is never found, the assertions all run against nothing); a second match
// means "which one did you mean" and the harness must say.
const REGISTRATION_START = /\n {0,4}(?:app|router)\.(?:get|post|put|patch|delete|all|use)\(/;
function routeSource(verb, routePath, src) {
  const text = src === undefined ? readAppSource() : src;
  const re = new RegExp(`\\b(?:app|router)\\.${escapeRe(verb)}\\(\\s*(['"\`])${escapeRe(routePath)}\\1`, 'g');
  const hits = [...text.matchAll(re)];
  if (hits.length === 0) throw new Error(`routeSource: no ${verb.toUpperCase()} ${routePath} registration found`);
  if (hits.length > 1) {
    throw new Error(`routeSource: ${hits.length} registrations of ${verb.toUpperCase()} ${routePath} — ambiguous`);
  }
  const start = hits[0].index;
  let end = -1;
  for (const close of ['\n  });', '\n  );']) {
    const i = text.indexOf(close, start);
    if (i >= 0 && (end < 0 || i + close.length < end)) end = i + close.length;
  }
  const rest = text.slice(start + 1);
  const next = rest.search(REGISTRATION_START);
  if (next >= 0 && (end < 0 || start + 1 + next < end)) end = start + 1 + next;
  // R1 L6: never run past the end of the file the registration is in (readAppSource separates files with this marker).
  const sep = text.indexOf('\n// ==== FILE:', start);
  if (sep >= 0 && (end < 0 || sep + 1 < end)) end = sep + 1;
  if (end < 0) throw new Error(`routeSource: ${verb.toUpperCase()} ${routePath} has no close after it`);
  return text.slice(start, end);
}

module.exports = { readAppSource, routeSource, routeFilesInOrder, APP };
