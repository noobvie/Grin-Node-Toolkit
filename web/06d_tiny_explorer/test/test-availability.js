'use strict';

// Public availability routes — what /api/availability[/history] will and will
// not hand to a visitor.
//
// The recorder's public directory also holds a lock, scan state and the raw
// chain file, so the claims worth testing are negative ones: only the two
// published names are ever opened, a missing / symlinked / oversize / malformed
// file or one with an unpublished key answers 404 JSON (never a 500), and the
// history is served byte-for-byte. The route block is lifted out of the server
// source and run against an in-memory fs and a stub app, so this file opens no
// socket and writes nothing.
//
// Run: node test/test-availability.js

const assert = require('node:assert');
const fs     = require('node:fs');
const path   = require('node:path');

const APP = path.resolve(__dirname, '..');
const serverJs = fs.readFileSync(path.join(APP, 'tiny-explorer-server.js'), 'utf8');

let pass = 0, fail = 0;
const ok = (name, fn) => {
  try { fn(); pass++; console.log('  PASS  ' + name); }
  catch (e) { fail++; console.log('  FAIL  ' + name + '\n        ' + (e && e.message)); }
};

const DIR = '/fixture/public';

// In-memory fs: files = { name: string | { symlink: true } | { size, text } }.
// Every path handed to lstatSync / readFileSync is recorded.
function loadRoutes(files, config) {
  const touched = [];
  const key = p => path.basename(p);
  const fakeFs = {
    lstatSync(p) {
      touched.push(p);
      const f = files[key(p)];
      if (f === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      const text = typeof f === 'string' ? f : (f.text || '');
      return { isFile: () => !(f && f.symlink), size: (f && f.size) || Buffer.byteLength(text) };
    },
    readFileSync(p) {
      touched.push(p);
      const f = files[key(p)];
      return typeof f === 'string' ? f : f.text;
    },
  };
  const t0 = serverJs.indexOf('function makeTtlCache');
  const t1 = serverJs.indexOf('// Last good value past its TTL');
  const from = serverJs.indexOf('const AVAIL_DIR');
  const to   = serverJs.indexOf("app.get('/api/sync'");
  assert.ok(t0 > -1 && t1 > t0 && from > -1 && to > from, 'could not locate the availability block');
  const routes = {};
  const app = { get: (p, h) => { routes[p] = h; } };
  const { availPublished } = new Function('app', 'fs', 'path', 'config',
    serverJs.slice(t0, t1) + serverJs.slice(from, to) + '\nreturn { availPublished };')
    (app, fakeFs, path, config || { availability_dir: DIR });
  return { routes, touched, availPublished };
}

function fakeRes() {
  const r = {
    code: 200, headers: {}, body: null,
    status(c) { r.code = c; return r; },
    setHeader(k, v) { r.headers[k] = v; },
    json(o) { r.headers['Content-Type'] = 'application/json'; r.body = JSON.stringify(o); return r; },
    send(b) { r.body = b; return r; },
  };
  return r;
}
const get = (routes, p) => { const res = fakeRes(); routes[p]({}, res); return res; };

const LINES = [
  '{"v":1,"seq":0,"type":"chain_start","date":"2026-10-20","prev":null}',
  '{"v":1,"seq":1,"type":"outage","date":"2026-10-21","duration_min":95,"kind":"hung","error":"thread panic","src":"0123456789abcdef","prev":"' + 'a'.repeat(64) + '"}',
];
const HISTORY = JSON.stringify({ v: 1, net: 'mainnet', lines: LINES });
const AVAIL = JSON.stringify({
  v: 1, net: 'mainnet', generated: '2026-10-26T14:05Z', state: 'up', up_days: 12,
  windows: { '7': { pct: 100, observed_d: 7, planned_min: 0, outages: 0 } },
  outages: [{ date: '2026-10-20', duration_min: 95, kind: 'hung', error: 'thread panic' }],
  planned: [], compactions: { logged: false }, chain: { lines: 2, head: 'b'.repeat(64) },
  check: { method: 'get_tip' },
});

console.log('\n[1] routes — served bytes, headers, 404 instead of a failure');

ok('both routes are registered under /api/', () => {
  const { routes } = loadRoutes({});
  assert.ok(routes['/api/availability'] && routes['/api/availability/history']);
});

ok('availability.json and history.json are served byte-for-byte', () => {
  const { routes } = loadRoutes({ 'availability.json': AVAIL, 'history.json': HISTORY });
  const a = get(routes, '/api/availability'), h = get(routes, '/api/availability/history');
  assert.strictEqual(a.code, 200); assert.strictEqual(a.body, AVAIL);
  assert.strictEqual(h.code, 200); assert.strictEqual(h.body, HISTORY);
  assert.ok(/application\/json/.test(h.headers['Content-Type']));
  assert.strictEqual(h.headers['Cache-Control'], 'public, max-age=30');
});

ok('a visitor can re-derive the chain from the served history', () => {
  const { routes } = loadRoutes({ 'history.json': HISTORY });
  const lines = JSON.parse(get(routes, '/api/availability/history').body).lines;
  assert.deepStrictEqual(lines, LINES);
});

ok('a missing file answers 404 JSON', () => {
  const { routes } = loadRoutes({});
  for (const p of ['/api/availability', '/api/availability/history']) {
    const r = get(routes, p);
    assert.strictEqual(r.code, 404);
    assert.deepStrictEqual(JSON.parse(r.body), { error: 'not published' });
  }
});

ok('malformed, empty, array, wrong-version and oversize files answer 404', () => {
  const bad = ['{"v":1,', '', '[]', 'null', '{"v":2,"net":"mainnet","lines":[]}',
    { size: 9 * 1024 * 1024, text: HISTORY }];
  for (const b of bad) {
    const { routes } = loadRoutes({ 'history.json': b });
    assert.strictEqual(get(routes, '/api/availability/history').code, 404,
      'served: ' + JSON.stringify(b).slice(0, 40));
  }
});

ok('a symlinked file is refused', () => {
  const { routes } = loadRoutes({ 'availability.json': { symlink: true, text: AVAIL } });
  assert.strictEqual(get(routes, '/api/availability').code, 404);
});

ok('an unreadable file (read throws) is a 404, not a 500', () => {
  const { routes } = loadRoutes({ 'availability.json': { size: 5 } });   // text undefined, so JSON.parse throws
  assert.strictEqual(get(routes, '/api/availability').code, 404);
});

console.log('\n[2] privacy — nothing outside the published contract');

ok('a file carrying an unpublished top-level key is not served', () => {
  for (const k of ['started_at', 'since', 'first_fail_ts', 'reason', 'pid', 'boot_id', 'node_dir',
                   'grin_version', 'evidence', 'by']) {
    const a = JSON.stringify(Object.assign(JSON.parse(AVAIL), { [k]: 'x' }));
    const { routes } = loadRoutes({ 'availability.json': a });
    assert.strictEqual(get(routes, '/api/availability').code, 404, k + ' was served');
  }
});

ok('the served fixtures hold none of the section 2 keys', () => {
  const { routes } = loadRoutes({ 'availability.json': AVAIL, 'history.json': HISTORY });
  const body = get(routes, '/api/availability').body + get(routes, '/api/availability/history').body;
  assert.ok(!/"(started_at|since|first_fail_ts|reason|pid|boot_id|node_dir|grin_version|evidence|by)"/.test(body));
});

ok('only the two published names are ever opened', () => {
  const dirty = { 'availability.json': AVAIL, 'history.json': HISTORY, '.lock': 'x',
    'history.jsonl': 'raw', '.last_publish': '1', '.compact_scan': 's' };
  const { routes, touched } = loadRoutes(dirty);
  get(routes, '/api/availability'); get(routes, '/api/availability/history');
  assert.ok(touched.length > 0);
  for (const p of touched) {
    assert.ok([DIR + '/availability.json', DIR + '/history.json'].includes(p.replace(/\\/g, '/')),
      'opened ' + p);
  }
});

ok('the file name is never taken from the request', () => {
  const body = serverJs.slice(serverJs.indexOf('const AVAIL_DIR'), serverJs.indexOf("app.get('/api/sync'"));
  assert.ok(!/req\.(params|query|url|path)/.test(body), 'a request value reaches the file path');
  assert.ok(/hasOwnProperty\.call\(AVAIL_KEYS, name\)/.test(body), 'the name allow-list check is gone');
});

console.log('\n[3] cache, config, page');

ok('a repeat request inside the TTL does not touch the disk again', () => {
  const { routes, touched } = loadRoutes({ 'availability.json': AVAIL });
  get(routes, '/api/availability'); const n = touched.length;
  get(routes, '/api/availability');
  assert.strictEqual(touched.length, n);
});

ok('availability_dir comes from config, with the recorder default', () => {
  assert.ok(serverJs.includes("config.availability_dir || '/opt/grin/node-events/mainnet/public'"));
  const { routes, touched } = loadRoutes({ 'availability.json': AVAIL }, { availability_dir: '/other' });
  get(routes, '/api/availability');
  assert.ok(touched[0].replace(/\\/g, '/').startsWith('/other/'));
});

ok('the page is routed, in the sitemap, and renders file data as text only', () => {
  assert.ok(serverJs.includes("app.get('/availability'"));
  assert.ok(serverJs.includes("file: 'availability.html'"));
  const js = fs.readFileSync(path.join(APP, 'public/js/availability.js'), 'utf8');
  const html = fs.readFileSync(path.join(APP, 'public/availability.html'), 'utf8');
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(js), 'availability.js writes HTML');
  assert.ok(!/<script(?![^>]*\bsrc=)/i.test(html), 'availability.html has an inline script');
});

ok('published (sitemap, index, footer link) exactly when /api/availability answers 200', () => {
  const cases = [[{ 'availability.json': AVAIL }, true], [{}, false], [{ 'availability.json': '{"v":1,' }, false],
    [{ 'availability.json': { symlink: true, text: AVAIL } }, false],
    [{ 'availability.json': JSON.stringify(Object.assign(JSON.parse(AVAIL), { reason: 'x' })) }, false],
    [{ 'history.json': HISTORY }, false]];
  for (const [files, want] of cases) {
    const { routes, availPublished } = loadRoutes(files);
    assert.strictEqual(availPublished(), want, 'availPublished wrong for ' + (Object.keys(files).join(',') || 'none'));
    assert.strictEqual(get(routes, '/api/availability').code === 200, want, 'the page switch and the API disagree');
  }
});

ok('the sitemap row and the robots rule both ask availPublished', () => {
  assert.ok(/\{ path: '\/availability', file: 'availability\.html', listed: availPublished \}/.test(serverJs),
    'the /availability sitemap row is not conditional');
  assert.ok(/pageKey === 'availability' && !published/.test(serverJs), 'the unpublished page is not noindex');
});

ok('the static twin /availability.html is redirected, not served without canonical and globals', () => {
  assert.ok(/'\/availability\.html':\s*'\/availability'/.test(serverJs), 'HTML_TWINS lacks /availability.html');
});

console.log('\n' + '─'.repeat(72));
console.log('availability: ' + pass + ' passed, ' + fail + ' failed');

module.exports = { report: () => ({ pass, fail }) };
