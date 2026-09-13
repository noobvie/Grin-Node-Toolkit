'use strict';

// Crawl surface — what this site tells a search engine about itself.
//
// WHY THIS FILE EXISTS. Every claim here is invisible in a browser. A wrong
// robots directive, a sitemap naming the wrong host, a JSON-LD block asserting
// an account nobody owns — none of them change a pixel, none of them throw, and
// the feedback loop is a Search Console graph weeks later. That is exactly the
// shape of bug a test suite has to carry, because nobody is going to catch it
// by looking at the page.
//
// Three things here are actually EXECUTED rather than pattern-matched: the
// sitemap handler, the robots.txt handler, and both of them with and without a
// configured base_url. They are lifted out of the server source and run against
// a stub `app`, so this file opens no socket and needs no express — 06d has
// exactly ONE npm dependency and that is not negotiable.
//
// Run: node test/test-seo.js

const assert = require('node:assert');
const fs     = require('node:fs');
const path   = require('node:path');

const APP    = path.resolve(__dirname, '..');
const WEBDIR = path.join(APP, 'public');
const read   = (rel) => fs.readFileSync(path.join(APP, rel), 'utf8');

let pass = 0, fail = 0;
const ok = (name, fn) => {
  try { fn(); pass++; console.log('  PASS  ' + name); }
  catch (e) { fail++; console.log('  FAIL  ' + name + '\n        ' + (e && e.message)); }
};

const serverJs = read('tiny-explorer-server.js');

// The seven pages that are meant to be found. Held here as a literal so that
// adding a route without listing it — or listing one without a route — fails
// here rather than passing quietly.
const STABLE = ['/', '/mining', '/slate', '/proof', '/wallet-check', '/emission', '/node-check'];
const TOOLS  = STABLE.filter(p => p !== '/');

// ── lifting the two generated-file handlers ─────────────────────────────────
// Sliced from the SITEMAP_PAGES declaration to the page-routes banner that
// follows it, then run with a stub app that records handlers by path.
function loadRoutes(baseUrl) {
  const from = serverJs.indexOf('const SITEMAP_PAGES');
  const to   = serverJs.indexOf('// ── HTML pages with injected SEO');
  assert.ok(from > -1 && to > from, 'could not locate the robots/sitemap block');
  const routes = {};
  const app = { get: (p, h) => { routes[p] = h; } };
  new Function('app', 'fs', 'path', 'baseUrl', 'webDir', serverJs.slice(from, to))
    (app, fs, path, baseUrl, WEBDIR);
  return routes;
}

// Minimal res double — records what the handler actually sent.
function fakeRes() {
  const r = {
    code: 200, headers: {}, body: null,
    status(c) { r.code = c; return r; },
    type(t) { r.headers['Content-Type'] = t; return r; },
    setHeader(k, v) { r.headers[k] = v; },
    send(b) { r.body = b; return r; },
  };
  return r;
}

const HOST = 'https://scan.example.org';

// ═══ 1. sitemap.xml ═════════════════════════════════════════════════════════
console.log('\n[1] sitemap — seven pages, absolute URLs, and nothing invented');

ok('it lists exactly the stable pages, each absolute on the configured host', () => {
  const res = fakeRes();
  loadRoutes(HOST)['/sitemap.xml']({}, res);
  assert.strictEqual(res.code, 200, 'sitemap did not return 200');
  const locs = [...res.body.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]);
  assert.deepStrictEqual(locs, STABLE.map(p => HOST + p),
    'sitemap URLs drifted from the stable page list');
});

ok('no entity page is advertised — a sitemap is not an inventory of the chain', () => {
  const res = fakeRes();
  loadRoutes(HOST)['/sitemap.xml']({}, res);
  assert.ok(!/<loc>[^<]*\/(block|kernel|output)\//.test(res.body),
    'sitemap lists a per-entity URL; those are noindex and must never be submitted');
});

ok('it is well-formed enough to submit — declaration, namespace, balanced tags', () => {
  const res = fakeRes();
  loadRoutes(HOST)['/sitemap.xml']({}, res);
  const b = res.body;
  assert.ok(b.startsWith('<?xml version="1.0" encoding="UTF-8"?>'), 'missing XML declaration');
  assert.ok(b.includes('xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"'), 'missing namespace');
  const open = (b.match(/<url>/g) || []).length, close = (b.match(/<\/url>/g) || []).length;
  assert.strictEqual(open, STABLE.length, 'wrong number of <url> entries');
  assert.strictEqual(open, close, 'unbalanced <url> tags');
  assert.ok(/application\/xml/.test(res.headers['Content-Type'] || ''), 'not served as XML');
});

ok('lastmod is a real date read off the file, never a hand-typed one', () => {
  const res = fakeRes();
  loadRoutes(HOST)['/sitemap.xml']({}, res);
  const mods = [...res.body.matchAll(/<lastmod>([^<]+)<\/lastmod>/g)].map(m => m[1]);
  assert.strictEqual(mods.length, STABLE.length, 'a page lost its lastmod');
  for (const m of mods) assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(m), 'bad lastmod format: ' + m);
  const onDisk = fs.statSync(path.join(WEBDIR, 'mining.html')).mtime.toISOString().slice(0, 10);
  assert.ok(mods.includes(onDisk), 'lastmod does not match the mtime of a shell on disk');
  const decl = serverJs.slice(serverJs.indexOf('const SITEMAP_PAGES'),
    serverJs.indexOf("app.get('/sitemap.xml'"));
  assert.ok(!/<lastmod>/.test(decl), 'a date was hard-coded into the page list');
});

ok('with no base_url there is no honest absolute URL, so it declines to publish', () => {
  const res = fakeRes();
  loadRoutes('')['/sitemap.xml']({}, res);
  assert.strictEqual(res.code, 404, 'an unconfigured box still served a sitemap');
  assert.ok(!/<loc>/.test(res.body || ''), 'it emitted URLs with no host configured');
});

// ═══ 2. robots.txt ══════════════════════════════════════════════════════════
console.log('\n[2] robots — rules from the file, host from the config');

ok('the rules still come from public/robots.txt, not a second copy in the server', () => {
  const res = fakeRes();
  loadRoutes(HOST)['/robots.txt']({}, res);
  const onDisk = read('public/robots.txt');
  for (const line of onDisk.split('\n').map(s => s.trim()).filter(Boolean)) {
    assert.ok(res.body.includes(line), 'served robots.txt dropped a rule: ' + line);
  }
});

ok('the Sitemap: line is appended, and names this host', () => {
  const res = fakeRes();
  loadRoutes(HOST)['/robots.txt']({}, res);
  assert.ok(res.body.includes('Sitemap: ' + HOST + '/sitemap.xml'), 'no Sitemap: line');
});

ok('and is omitted entirely when there is no host to name', () => {
  const res = fakeRes();
  loadRoutes('')['/robots.txt']({}, res);
  assert.ok(!/Sitemap:/.test(res.body), 'advertised a sitemap with no base_url configured');
  assert.ok(/User-agent/.test(res.body), 'lost the rules along with the Sitemap line');
});

ok('it does NOT Disallow the entity pages — that would hide their noindex', () => {
  const res = fakeRes();
  loadRoutes(HOST)['/robots.txt']({}, res);
  assert.ok(!/Disallow:\s*\/(block|kernel|output)/.test(res.body),
    'block/kernel/output are Disallowed; a crawler that cannot fetch them can never read '
    + 'their noindex, and the URLs can still be indexed as bare listings');
});

ok('both routes sit above express.static, or the plain files answer first', () => {
  const route   = serverJs.indexOf("app.get('/robots.txt'");
  const stat    = serverJs.indexOf('app.use(express.static');
  const sitemap = serverJs.indexOf("app.get('/sitemap.xml'");
  assert.ok(route > -1 && stat > -1 && sitemap > -1, 'a route or the static mount was renamed');
  assert.ok(route < stat, 'the robots.txt route is below express.static and will never run');
  assert.ok(sitemap < stat, 'the sitemap route is below express.static');
});

// ═══ 3. index / noindex ═════════════════════════════════════════════════════
console.log('\n[3] robots directive — the seven are indexable, the shells are not');

ok('block, kernel, output and the 404 are noindex, and still follow', () => {
  const m = serverJs.match(/const robots = \(([\s\S]*?)\) \? '([^']+)' : '([^']+)';/);
  assert.ok(m, 'the per-page robots directive was removed or reshaped');
  for (const key of ['block', 'kernel', 'output', 'notfound']) {
    assert.ok(m[1].includes("'" + key + "'"), key + ' is no longer noindex');
  }
  assert.strictEqual(m[2], 'noindex, follow',
    'entity pages must stay FOLLOW — the pool deep-links into /block/:ref from outside');
  assert.strictEqual(m[3], 'index, follow', 'the indexable default changed');
});

ok('no tool page is caught by it', () => {
  const m = serverJs.match(/const robots = \(([\s\S]*?)\) \?/);
  for (const key of ['index', 'slate', 'proof', 'walletcheck', 'emission', 'nodecheck', 'mining']) {
    assert.ok(!m[1].includes("'" + key + "'"), key + ' was made noindex by mistake');
  }
});

// ═══ 4. structured data ═════════════════════════════════════════════════════
console.log('\n[4] JSON-LD — only claims this deployment can back');

ok('every tool has a schema entry, and every entry is a real page key', () => {
  const from = serverJs.indexOf('const TOOL_SCHEMA');
  const body = serverJs.slice(from, serverJs.indexOf('};', from));
  const keys = [...body.matchAll(/^\s{2}(\w+):/gm)].map(m => m[1]);
  assert.deepStrictEqual(keys.slice().sort(),
    ['emission', 'mining', 'nodecheck', 'proof', 'slate', 'walletcheck'],
    'TOOL_SCHEMA no longer covers exactly the six tools');
  for (const k of keys) {
    assert.ok(serverJs.includes("pageKey === '" + k + "'"),
      k + ' has schema but no canonical path in injectGlobals');
  }
});

ok('it asserts no identity the operator does not own (pool audit J15-3)', () => {
  const from = serverJs.indexOf('const jsonLd');
  const block = serverJs.slice(from, from + 2500);
  for (const banned of ['sameAs', 'SearchAction', 'aggregateRating', 'twitter:site']) {
    assert.ok(!block.includes(banned),
      'JSON-LD contains ' + banned + ' — a claim made on the operator behalf');
  }
});

ok('url is emitted only when base_url is configured', () => {
  const from = serverJs.indexOf('const jsonLd');
  const block = serverJs.slice(from, from + 2500);
  assert.ok(/if \(baseUrl && canonPath\) obj\.url/.test(block),
    'the url field is no longer guarded by baseUrl — an unconfigured box could name a wrong host');
});

ok('noindex pages get no structured data', () => {
  const from = serverJs.indexOf('const jsonLd');
  const block = serverJs.slice(from, from + 2500);
  assert.ok(/if \(!obj\) return '';/.test(block),
    'jsonLd no longer short-circuits for pages with no schema');
});

// ═══ 5. the pages themselves ════════════════════════════════════════════════
console.log('\n[5] per-page markup — one H1 each, analytics everywhere');

const PAGE_FILES = fs.readdirSync(WEBDIR).filter(f => f.endsWith('.html')).sort();

ok('every page has exactly one H1', () => {
  // Collected rather than asserted per file: three of the entity shells carried
  // a second H1 in their loading skeleton, and a per-file assert reports one of
  // them per run, which turns one bug into three rounds of fixing.
  const bad = PAGE_FILES
    .map(f => [f, (read('public/' + f).match(/<h1[\s>]/g) || []).length])
    .filter(([, n]) => n !== 1);
  assert.deepStrictEqual(bad, [],
    'pages with the wrong number of H1 elements: ' + bad.map(([f, n]) => f + '=' + n).join(', '));
});

ok('the homepage H1 is a real heading, not the repeated header brand', () => {
  const html = read('public/index.html');
  const m = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/);
  assert.ok(m, 'index.html lost its H1');
  const text = m[1].replace(/<[^>]+>/g, '').trim();
  assert.ok(/grin/i.test(text) && /explorer/i.test(text),
    'the homepage H1 no longer says what the site is: ' + JSON.stringify(text));
  const h1At = html.indexOf('<h1'), headEnd = html.indexOf('</header>');
  assert.ok(h1At > headEnd, 'the H1 sits inside the site header, which repeats on every page');
});

ok('every page loads analytics, including the 404', () => {
  for (const f of PAGE_FILES) {
    assert.ok(read('public/' + f).includes('/js/analytics.js'),
      f + ' has no analytics tag — its traffic is invisible');
  }
});

ok('titles are unique, and every INDEXABLE page has a substantial description', () => {
  const from = serverJs.indexOf('const _pageMeta');
  const meta = serverJs.slice(from, serverJs.indexOf('\n};', from));
  const keys   = [...meta.matchAll(/^ {2}(\w+): \{/gm)].map(m => m[1]);
  const titles = [...meta.matchAll(/title:\s*`([^`]+)`/g)].map(m => m[1]);
  const descs  = [...meta.matchAll(/desc:\s+`([^`]+)`/g)].map(m => m[1]);
  assert.strictEqual(keys.length, titles.length, 'a page lost its title');
  assert.strictEqual(keys.length, descs.length, 'a page lost its description');
  assert.strictEqual(new Set(titles).size, titles.length, 'two pages share a title');
  // The 404 is exempt: it is noindex, so a search engine never shows its
  // description, and padding it out would be writing for a reader who does not
  // exist. Every page that CAN appear in a result has to earn its snippet.
  keys.forEach((k, i) => {
    if (k === 'notfound') return;
    assert.ok(descs[i].length > 80, k + ' has a description too thin to earn a snippet');
  });
});

ok('the mining description mentions payback, which the page now computes', () => {
  const from = serverJs.indexOf('  mining: {');
  const block = serverJs.slice(from, serverJs.indexOf('},', from));
  assert.ok(/pay for itself|payback/i.test(block),
    'the /mining description still predates the hardware-cost and payback card');
});

ok('each stable path has a route that serves it', () => {
  for (const p of TOOLS) {
    assert.ok(serverJs.includes("app.get('" + p + "'"), 'no route serves ' + p);
  }
  assert.ok(/app\.get\('\/',/.test(serverJs), 'no route serves /');
});

console.log('\n' + '─'.repeat(72));
console.log('seo: ' + pass + ' passed, ' + fail + ' failed');

module.exports = { report: () => ({ pass, fail }) };
