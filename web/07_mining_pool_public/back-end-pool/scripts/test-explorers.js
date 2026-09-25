'use strict';

// Operator-selectable chain explorer — lib/explorers.js and the `branding.explorer_mainnet`
// setting (grincoin | tiny | grinscan, default grincoin; testnet fixed on test.grinscan.org).
// Covers: every key × kind builds the right URL (grincoin sends a block HASH to /hash/, a height
// to /block/); the value is always URL-encoded; resolveExplorerKey ignores the setting on
// testnet and maps every unknown / prototype / wrong-type value to grincoin on mainnet; the
// validator accepts exactly the three keys; the setting round-trips through PoolSettings with an
// audit row, a refused value rolls back, a corrupt DB row still publishes grincoin; and the routes
// publish the RESOLVED key and build /api/admin/blocks links through the lib.
// Browser half ([h]–[k]): the registry copies in public_html/js/branding.js and
// admin-panel/admin-shell.js EQUAL this lib (bases, styles, segments, choices); their
// window.Explorer.url() equals explorerUrl() for every network × cached key (incl. garbage,
// prototype keys, a stale mainnet key on testnet, and a sessionStorage that throws); the three
// primers (branding apply(), admin-shell decoratePoolIdentity(), blocks.html pool-info) cache the
// server's key; and the Settings → Branding select offers exactly the three choices and greys
// out on testnet.
// index.js starts a server on require, so its routes are read as text (as in test-regions.js).
// The PoolSettings part runs against a throwaway SQLite file in the OS temp dir — never the pool DB.
// Run: node scripts/test-explorers.js   (no server, nothing left running)

const fs = require('fs');
const os = require('os');
const path = require('path');
const APP = path.resolve(__dirname, '..');

const ex = require(path.join(APP, 'lib/explorers.js'));
const indexSrc = fs.readFileSync(path.join(APP, 'index.js'), 'utf8');

let pass = 0, fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else      { fail++; console.error(`  FAIL  ${name}${extra ? ' — ' + extra : ''}`); }
}
const throws = (fn) => { try { fn(); return false; } catch (e) { return true; } };

const H = '1234567';
const HASH = '0a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f9';   // 64-hex
const KERN = '08' + 'ab'.repeat(32);                                                // 66-hex excess
const OUT  = '09' + 'cd'.repeat(32);                                                // 66-hex commit

console.log('\n[a] every key × kind builds the expected URL\n');
{
  const expect = {
    grincoin: {
      height: `https://grincoin.org/block/${H}`,
      hash:   `https://grincoin.org/hash/${HASH}`,
      kernel: `https://grincoin.org/kernel/${KERN}`,
      output: `https://grincoin.org/output/${OUT}`,
    },
    tiny: {
      height: `https://scan.grin.money/block/${H}`,
      hash:   `https://scan.grin.money/block/${HASH}`,
      kernel: `https://scan.grin.money/kernel/${KERN}`,
      output: `https://scan.grin.money/output/${OUT}`,
    },
    grinscan: {
      height: `https://grinscan.org/block.html?h=${H}`,
      hash:   `https://grinscan.org/block.html?h=${HASH}`,
      kernel: `https://grinscan.org/kernel.html?ex=${KERN}`,
      output: `https://grinscan.org/output.html?c=${OUT}`,
    },
    grinscan_testnet: {
      height: `https://test.grinscan.org/block.html?h=${H}`,
      hash:   `https://test.grinscan.org/block.html?h=${HASH}`,
      kernel: `https://test.grinscan.org/kernel.html?ex=${KERN}`,
      output: `https://test.grinscan.org/output.html?c=${OUT}`,
    },
  };
  ok('a. the registry holds exactly the four known keys',
    JSON.stringify(Object.keys(ex.EXPLORERS).sort()) === JSON.stringify(Object.keys(expect).sort()));
  for (const key of Object.keys(expect)) {
    const e = expect[key];
    const got = {
      height: ex.explorerUrl(key, 'block', H),
      hash:   ex.explorerUrl(key, 'block', HASH),
      kernel: ex.explorerUrl(key, 'kernel', KERN),
      output: ex.explorerUrl(key, 'output', OUT),
    };
    for (const k of Object.keys(e)) ok(`a. ${key} ${k} → ${e[k]}`, got[k] === e[k], `got ${got[k]}`);
  }
  ok('a. a numeric height (not a string) builds the same /block/ URL',
    ex.explorerUrl('grincoin', 'block', 1234567) === `https://grincoin.org/block/${H}`);
  ok('a. testnet host is test.grinscan.org — never testnet.grinscan.org (NXDOMAIN)',
    !/testnet\.grinscan/.test(JSON.stringify(ex.EXPLORERS)) && ex.EXPLORERS[ex.TESTNET].base === 'https://test.grinscan.org');
  ok('a. an unknown kind is treated as a block', ex.explorerUrl('grinscan', 'nope', H) === `https://grinscan.org/block.html?h=${H}`);
  ok('a. an unknown key (a guard, not a path) falls back to grincoin, not a broken URL',
    ex.explorerUrl('__proto__', 'block', H) === `https://grincoin.org/block/${H}` &&
    ex.explorerUrl('constructor', 'kernel', KERN) === `https://grincoin.org/kernel/${KERN}` &&
    ex.explorerUrl(undefined, 'block', H) === `https://grincoin.org/block/${H}`);
}

console.log('\n[b] the value is always URL-encoded\n');
{
  for (const key of Object.keys(ex.EXPLORERS)) {
    const a = ex.explorerUrl(key, 'block', '1/../x');
    const b = ex.explorerUrl(key, 'kernel', '"<>');
    ok(`b. ${key}: '1/../x' stays one encoded segment`, a.endsWith('1%2F..%2Fx') && !a.includes('/../'), a);
    ok(`b. ${key}: '"<>' is encoded`, b.endsWith('%22%3C%3E') && !/["<>]/.test(b), b);
    const c = ex.explorerUrl(key, 'output', 'a?b=c#d&e');
    ok(`b. ${key}: ? # & cannot add a query or fragment`, c.endsWith('a%3Fb%3Dc%23d%26e'), c);
  }
  ok('b. grincoin: a non-numeric block ref (not just a hash) goes to /hash/, still encoded',
    ex.explorerUrl('grincoin', 'block', '12a/b') === 'https://grincoin.org/hash/12a%2Fb');
}

console.log('\n[c] resolveExplorerKey — testnet fixed, mainnet own-member-or-default\n');
{
  const R = ex.resolveExplorerKey;
  for (const k of ['grincoin', 'tiny', 'grinscan']) {
    ok(`c. mainnet + '${k}' → '${k}'`, R('mainnet', k) === k);
    ok(`c. testnet + '${k}' → grinscan_testnet (setting ignored)`, R('testnet', k) === 'grinscan_testnet');
  }
  const junk = [undefined, null, '', 'unknown', '__proto__', 'constructor', 'toString', 'hasOwnProperty',
    'valueOf', 'grinscan_testnet', ' grincoin', 'GRINCOIN', 'https://evil.example',
    ['tiny'], { toString: () => 'tiny' }, 1, true, NaN];
  for (const v of junk) {
    const label = typeof v === 'string' ? `'${v}'` : (Array.isArray(v) ? "['tiny']" : String(v && typeof v === 'object' ? '{toString:tiny}' : v));
    ok(`c. mainnet + ${label} → grincoin`, R('mainnet', v) === 'grincoin', `got ${R('mainnet', v)}`);
  }
  ok('c. testnet + junk → grinscan_testnet', R('testnet', 'evil') === 'grinscan_testnet' && R('testnet', undefined) === 'grinscan_testnet');
  ok('c. a missing network is mainnet', R(undefined, 'tiny') === 'tiny' && R('', 'bogus') === 'grincoin');
  ok('c. DEFAULT_MAINNET is grincoin and TESTNET is grinscan_testnet',
    ex.DEFAULT_MAINNET === 'grincoin' && ex.TESTNET === 'grinscan_testnet');
  ok('c. MAINNET_CHOICES is exactly grincoin, tiny, grinscan',
    JSON.stringify(ex.MAINNET_CHOICES) === JSON.stringify(['grincoin', 'tiny', 'grinscan']));
  ok('c. every choice and the testnet key is a real registry entry',
    [...ex.MAINNET_CHOICES, ex.TESTNET].every((k) => Object.prototype.hasOwnProperty.call(ex.EXPLORERS, k)));
}

console.log('\n[d] the validator accepts the three keys and nothing else\n');
{
  const V = ex.validateMainnetChoice;
  for (const k of ['grincoin', 'tiny', 'grinscan']) ok(`d. accepts '${k}'`, V(k) === k);
  const bad = [undefined, null, '', 'unknown', '__proto__', 'constructor', 'toString', 'grinscan_testnet',
    ' grincoin', 'grincoin ', 'GRINCOIN', 'Tiny', 'https://grincoin.org', 'https://evil.example',
    ['grincoin'], { k: 'grincoin' }, 0, 1, true];
  for (const v of bad) ok(`d. rejects ${JSON.stringify(v) === undefined ? 'undefined' : JSON.stringify(v)}`, throws(() => V(v)));
  let msg = '';
  try { V('evil'); } catch (e) { msg = e.message; }
  ok('d. the refusal names the key and the allowed values', /explorer_mainnet/.test(msg) && /grincoin, tiny, grinscan/.test(msg), msg);
}

console.log('\n[e] the registry is frozen\n');
{
  ok('e. EXPLORERS, each entry, STYLES, each style and MAINNET_CHOICES are frozen',
    Object.isFrozen(ex.EXPLORERS) && Object.values(ex.EXPLORERS).every(Object.isFrozen) &&
    Object.isFrozen(ex.STYLES) && Object.values(ex.STYLES).every(Object.isFrozen) &&
    Object.isFrozen(ex.MAINNET_CHOICES));
  ok('e. a caller cannot re-point an explorer (strict-mode write throws)', throws(() => { ex.EXPLORERS.grincoin.base = 'https://evil.example'; }));
  ok('e. …nor add a choice', throws(() => { ex.MAINNET_CHOICES.push('evil'); }));
  ok('e. grincoin still builds its real URL afterwards', ex.explorerUrl('grincoin', 'block', H) === `https://grincoin.org/block/${H}`);
}

console.log('\n[f] PoolSettings — default, validator wired, audit row, rollback, corrupt row\n');
{
  const dbFile = path.join(os.tmpdir(), `pool-explorers-${process.pid}-${Date.now()}.sqlite`);
  const { initDb, getDb, createSchema, closeDb } = require(path.join(APP, 'lib/db.js'));
  const cleanup = () => {
    try { closeDb(); } catch (_) {}
    for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(dbFile + s); } catch (_) {} }
  };
  try {
    initDb(dbFile);
    const db = getDb();
    createSchema();
    const PoolSettings = require(path.join(APP, 'lib/pool-settings.js'));
    const ps = new PoolSettings(db);
    db.prepare("INSERT INTO users (id, username, password_hash, is_admin) VALUES (7,'auditor','x',1)").run();
    const audits = () => db.prepare("SELECT details FROM admin_audit_log WHERE action='update_settings' ORDER BY id").all();

    ok('f. default is grincoin', PoolSettings.defaults.branding.explorer_mainnet === 'grincoin' &&
      ps.getSection('branding').explorer_mainnet === 'grincoin');
    ok('f. the branding validator IS the lib validator (one rule)',
      PoolSettings.validators.branding.explorer_mainnet === ex.validateMainnetChoice);
    ok('f. the default publishes as grincoin', ps.buildPublicConfig().branding.explorer_mainnet === 'grincoin');

    ps.updateSection('branding', { explorer_mainnet: 'tiny' }, 7);
    ok('f. a save of tiny is stored', ps.getSection('branding').explorer_mainnet === 'tiny');
    ok('f. …and published', ps.buildPublicConfig().branding.explorer_mainnet === 'tiny');
    const a1 = audits();
    const d1 = a1.length ? JSON.parse(a1[a1.length - 1].details) : {};
    ok('f. the save wrote an update_settings audit row naming explorer_mainnet',
      a1.length === 1 && d1.section === 'branding' && Array.isArray(d1.changed_keys) && d1.changed_keys.includes('explorer_mainnet'),
      JSON.stringify(a1));

    for (const bad of ['evil', 'https://evil.example', 'GRINCOIN', ' tiny', 'grinscan_testnet', '__proto__', ['grinscan']]) {
      const refused = throws(() => ps.updateSection('branding', { explorer_mainnet: bad }, 7));
      ok(`f. updateSection refuses ${JSON.stringify(bad)} and keeps tiny`,
        refused && ps.getSection('branding').explorer_mainnet === 'tiny');
    }
    // A refused key rolls back the WHOLE section write, including a valid sibling.
    const before = ps.getSection('branding').footer_text;
    throws(() => ps.updateSection('branding', { footer_text: 'changed-by-test', explorer_mainnet: 'evil' }, 7));
    ok('f. a refused explorer rolls back a valid sibling in the same save',
      ps.getSection('branding').footer_text === before);
    ok('f. no audit row for a refused save', audits().length === 1);

    // Tamper: a value written straight into the DB (import, restore, hand edit) bypasses the
    // validator. It must still publish a valid explorer.
    db.prepare("UPDATE pool_config SET value = 'evil' WHERE section = 'branding' AND key = 'explorer_mainnet'").run();
    ok('f. a corrupt DB row reads back raw…', ps.getSection('branding').explorer_mainnet === 'evil');
    ok('f. …but publishes as grincoin, never the raw value',
      ps.buildPublicConfig().branding.explorer_mainnet === 'grincoin');
    db.prepare("UPDATE pool_config SET value = '__proto__' WHERE section = 'branding' AND key = 'explorer_mainnet'").run();
    ok('f. a prototype-key DB row publishes as grincoin', ps.buildPublicConfig().branding.explorer_mainnet === 'grincoin');

    ps.resetSection('branding', 7);
    ok('f. Restore defaults puts it back to grincoin', ps.getSection('branding').explorer_mainnet === 'grincoin');
  } catch (e) {
    ok('f. PoolSettings section ran without an exception', false, e.stack);
  } finally {
    cleanup();
  }
}

console.log('\n[g] the routes publish the RESOLVED key and build links through the lib\n');
{
  // Line comments stripped — but not the `//` of a URL (`https://…`), or the hardcoded-host
  // check below would strip the very thing it looks for and always pass.
  const stripComments = (src) => src.replace(/(^|[^:])\/\/[^\n]*/gm, '$1');
  // Route source between its app.<verb>( and the next one, comments stripped.
  const routeSrc = (verb, p) => {
    const start = indexSrc.indexOf(`app.${verb}('${p}'`);
    if (start < 0) return '';
    const next = indexSrc.slice(start + 10).search(/\n\s{0,4}app\.(get|post|put|delete|patch)\(/);
    return stripComments(indexSrc.slice(start, start + 10 + next));
  };
  const code = stripComments(indexSrc);
  ok('g. index.js requires lib/explorers', /require\('\.\/lib\/explorers'\)/.test(indexSrc));

  const helper = (code.match(/const currentExplorerKey = \(\) => \{[\s\S]*?\n  \};/) || [''])[0];
  ok('g. currentExplorerKey() resolves via the lib from config.network + the stored setting',
    /explorers\.resolveExplorerKey\(config\.network,\s*stored\)/.test(helper) &&
    /getSection\('branding'\)\.explorer_mainnet/.test(helper));
  ok('g. …and a failed settings read falls back instead of throwing', /try\s*\{[^}]*getSection[^}]*\}\s*catch/.test(helper));

  const branding = routeSrc('get', '/api/public/branding');
  ok('g. /api/public/branding: connection.explorer is the resolved key',
    /explorer:\s*explorers\.resolveExplorerKey\(config\.network,\s*cfg\.branding\.explorer_mainnet\)/.test(branding));
  const info = routeSrc('get', '/api/config/pool-info');
  ok('g. /api/config/pool-info: explorer beside network', /network: config\.network,\s*explorer: currentExplorerKey\(\)/.test(info));
  const stats = routeSrc('get', '/api/pool/stats');
  ok('g. /api/pool/stats: network AND explorer (admin-shell primes from these)',
    /network: config\.network \|\| 'mainnet',\s*explorer: currentExplorerKey\(\)/.test(stats));

  const blocks = routeSrc('get', '/api/admin/blocks');
  ok('g. /api/admin/blocks builds grinscan_url through explorers.explorerUrl',
    /explorers\.explorerUrl\(explorerKey,\s*'block',\s*height\)/.test(blocks) &&
    /const explorerKey = currentExplorerKey\(\)/.test(blocks) && /grinscan_url: explorerBlockUrl\(b\.height\)/.test(blocks));
  ok('g. /api/admin/blocks keeps the grinscan_url field name (API shape)', /grinscan_url:/.test(blocks));
  ok('g. no explorer host is hardcoded in index.js code (only in comments / docs)',
    !/https?:\/\/(test\.)?(grincoin\.org|grinscan\.org|scan\.grin\.money)/.test(code.replace(/^\s*'(GET|POST|PUT|DELETE) [^\n]*$/gm, '')));

  // A branding save must drop the memoised branding payload, or the switch waits out the TTL.
  const save = routeSrc('post', '/api/admin/settings/:section');
  ok('g. a settings save invalidates the branding memo after updateSection',
    /poolSettings\.updateSection\([\s\S]*?invalidateBranding\(\)/.test(save));
  ok('g. …and so does Restore defaults', /resetSection\([\s\S]*?invalidateBranding\(\)/.test(routeSrc('post', '/api/admin/settings/:section/restore')));

  // Decided: no step-up for this enum — branding is not a step-up section, the key not a step-up key.
  const sections = (indexSrc.match(/STEP_UP_SETTINGS_SECTIONS = new Set\(\[([^\]]*)\]/) || [, ''])[1];
  const keys = (indexSrc.match(/STEP_UP_SETTINGS_KEYS = new Set\(\[([\s\S]*?)\]\)/) || [, ''])[1];
  ok('g. branding is not a step-up section and explorer_mainnet is not a step-up key',
    sections.length > 0 && !/'branding'/.test(sections) && !/explorer_mainnet/.test(keys));

  const meta = (k) => indexSrc.split('\n').find((l) => l.trimStart().startsWith(`'${k}':`)) || '';
  ok('g. API_DOC_META: branding documents connection.explorer + all four keys',
    /connection\.explorer/.test(meta('GET /api/public/branding')) &&
    ['grincoin', 'tiny', 'grinscan', 'grinscan_testnet'].every((k) => new RegExp(`\\b${k}\\b`).test(meta('GET /api/public/branding'))));
  ok('g. API_DOC_META: pool-info documents explorer', /\bexplorer\b/.test(meta('GET /api/config/pool-info')) && /grinscan_testnet/.test(meta('GET /api/config/pool-info')));
  ok('g. API_DOC_META: pool/stats documents network and explorer',
    /\bnetwork\b/.test(meta('GET /api/pool/stats')) && /\bexplorer\b/.test(meta('GET /api/pool/stats')) && /grinscan_testnet/.test(meta('GET /api/pool/stats')));
}

// ── Part 2: the two BROWSER copies (public branding.js, admin-shell.js) ─────────────────────────
// No jsdom in this project (see test-branding-sinks.js), so the browser files run in a vm context.
// branding.js runs WHOLE, driven through its real fetch → apply() path. admin-shell.js builds the
// admin chrome at top level, so its explorer block and decoratePoolIdentity() are cut out by text
// and run on their own — a missing marker is a FAIL, never a skip.

const vm = require('vm');
const PUB = path.resolve(APP, '../public_html');
const brandingSrc = fs.readFileSync(path.join(PUB, 'js/branding.js'), 'utf8');
const shellSrc = fs.readFileSync(path.join(APP, 'admin-panel/admin-shell.js'), 'utf8');
const blocksSrc = fs.readFileSync(path.join(PUB, 'blocks.html'), 'utf8');
const brandPageSrc = fs.readFileSync(path.join(APP, 'admin-panel/settings-branding.html'), 'utf8');

// Canonical JSON (sorted keys) so a registry comparison does not depend on key order.
const canon = (v) => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x))
  ? Object.keys(x).sort().reduce((o, kk) => { o[kk] = x[kk]; return o; }, {}) : x);

// A Map-backed sessionStorage; `throwing` models private mode / blocked site data.
function makeStore(init, throwing) {
  const m = new Map(Object.entries(init || {}));
  const boom = () => { throw new Error('SecurityError: storage blocked'); };
  return {
    _m: m,
    getItem: throwing ? boom : (k) => (m.has(k) ? m.get(k) : null),
    setItem: throwing ? boom : (k, v) => { m.set(k, String(v)); },
    removeItem: throwing ? boom : (k) => { m.delete(k); },
  };
}
const settle = async () => { for (let i = 0; i < 12; i++) await new Promise((r) => setImmediate(r)); };

// Minimal DOM shim — enough for branding.js to bootstrap; everything it paints goes nowhere.
function makeEl(tag) {
  const el = {
    tagName: String(tag).toUpperCase(), children: [], childNodes: [], attrs: {},
    style: { setProperty() {}, cssText: '' },
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    textContent: '', innerHTML: '', className: '',
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; },
    removeAttribute(k) { delete this.attrs[k]; },
    appendChild(c) { this.children.push(c); return c; }, insertBefore(c) { this.children.unshift(c); return c; },
    removeChild() {}, remove() {}, addEventListener() {}, querySelector: () => null, querySelectorAll: () => [],
  };
  return el;
}

// Run branding.js whole. `cfg` is what /api/public/branding returns as `data`.
async function runBranding(store, cfg) {
  const head = makeEl('head'), body = makeEl('body'), html = makeEl('html');
  html.setAttribute('data-page', 'blocks');
  const document = {
    documentElement: html, head, body, readyState: 'complete',
    createElement: makeEl, createTextNode: (t) => ({ textContent: t }),
    getElementById: () => null, getElementsByTagName: (t) => (t === 'head' ? [head] : []),
    querySelector: () => null, querySelectorAll: () => [], addEventListener() {},
  };
  const errors = [];
  const sb = {
    document, location: { pathname: '/blocks.html', href: 'https://pool.example/blocks.html', search: '', hostname: 'pool.example' },
    localStorage: makeStore(), sessionStorage: store, navigator: { userAgent: 'test' },
    console: { log() {}, warn() {}, info() {}, error: (...a) => errors.push(a.join(' ')) },
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {}, Promise, URL,
    fetch: () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ data: cfg || {} }) }),
    matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
  };
  sb.window = sb; sb.self = sb; sb.globalThis = sb;
  vm.createContext(sb);
  vm.runInContext(brandingSrc, sb, { filename: 'branding.js' });
  await settle();
  return { Explorer: sb.Explorer, errors };
}

// admin-shell.js: its explorer block (header comment → `window.Explorer = …;`) + decoratePoolIdentity().
const SHELL_BLOCK = (shellSrc.match(/  \/\/ ── Chain explorer deep-links \(window\.Explorer\)[\s\S]*?\n  window\.Explorer = [^\n]*\n/) || [''])[0];
const SHELL_DECORATE = (shellSrc.match(/  function decoratePoolIdentity\(\) \{[\s\S]*?\n  \}\n/) || [''])[0];
function runShell(store, statsBody) {
  const attrs = {}, events = [];
  const sb = {
    sessionStorage: store,
    esc: (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    sidebar: { querySelector: () => null },
    document: {
      title: 'Admin', getElementById: () => null,
      documentElement: { setAttribute: (k, v) => { attrs[k] = String(v); } },
      dispatchEvent: (e) => { events.push(e); return true; },
    },
    CustomEvent: function (type, init) { this.type = type; this.detail = init && init.detail; },
    fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve(statsBody || {}) }),
  };
  sb.window = sb;
  vm.createContext(sb);
  vm.runInContext(SHELL_BLOCK + '\n' + SHELL_DECORATE, sb, { filename: 'admin-shell.js (extract)' });
  return { Explorer: sb.Explorer, decorate: sb.decoratePoolIdentity, attrs, events };
}

// Evaluate one `var NAME = <literal>;` out of a browser file.
function literalFrom(src, name) {
  const m = src.match(new RegExp(`\\n  var ${name} = ([\\s\\S]*?);\\n`));
  if (!m) return undefined;
  try { return vm.runInNewContext('(' + m[1] + ')'); } catch (e) { return undefined; }
}

// Every (network, cached key) pair the browser can meet, and the server's answer for it.
const CASES = [];
for (const net of ['mainnet', 'testnet', null]) {
  for (const k of [...ex.MAINNET_CHOICES, 'grinscan_testnet', null, '', 'evil', '__proto__', 'constructor',
    'toString', 'hasOwnProperty', ' tiny', 'TINY', 'https://evil.example']) {
    CASES.push({ net, k });
  }
}
const REFS = { 'block height': ['block', H], 'block hash': ['block', HASH], kernel: ['kernel', KERN], output: ['output', OUT] };
const caseLabel = (c) => `network=${c.net === null ? 'unset' : c.net}, pool-explorer=${c.k === null ? 'unset' : JSON.stringify(c.k)}`;
const storeFor = (c) => {
  const init = {};
  if (c.net !== null) init['pool-network'] = c.net;
  if (c.k !== null) init['pool-explorer'] = c.k;
  return makeStore(init);
};
// The server's rule. The browser caches the server's RESOLVED key, then re-applies the same rule.
const expectedKey = (c) => ex.resolveExplorerKey(c.net === null ? 'mainnet' : c.net, c.k === null ? undefined : c.k);

(async () => {
  console.log('\n[h] registry parity — branding.js and admin-shell.js mirror lib/explorers.js\n');
  {
    ok('h. admin-shell.js explorer block + decoratePoolIdentity() were found', SHELL_BLOCK.length > 500 && SHELL_DECORATE.length > 100);
    for (const [file, src] of [['branding.js', brandingSrc], ['admin-shell.js', shellSrc]]) {
      const styles = literalFrom(src, 'EXPLORER_STYLES');
      const explorers = literalFrom(src, 'EXPLORERS');
      ok(`h. ${file}: EXPLORER_STYLES equals lib STYLES (every style and segment)`, styles !== undefined && canon(styles) === canon(ex.STYLES),
        `got ${canon(styles)}`);
      ok(`h. ${file}: EXPLORERS equals lib EXPLORERS (every key, base and style)`, explorers !== undefined && canon(explorers) === canon(ex.EXPLORERS),
        `got ${canon(explorers)}`);
      ok(`h. ${file}: MAINNET_CHOICES equals lib MAINNET_CHOICES (same order)`,
        canon(literalFrom(src, 'MAINNET_CHOICES')) === canon(ex.MAINNET_CHOICES));
      ok(`h. ${file}: DEFAULT_MAINNET / TESTNET_EXPLORER equal the lib's`,
        literalFrom(src, 'DEFAULT_MAINNET') === ex.DEFAULT_MAINNET && literalFrom(src, 'TESTNET_EXPLORER') === ex.TESTNET);
      ok(`h. ${file}: the old DEFAULT_EXPLORER "switch" is gone`, !/DEFAULT_EXPLORER/.test(src));
      ok(`h. ${file}: never tests a cached key with \`in\``, !/\bin EXPLORERS\b/.test(src));
    }
  }

  console.log('\n[i] window.Explorer.url() in both browser copies === lib explorerUrl() for every case\n');
  {
    for (const [name, load] of [
      ['branding.js', async (store) => (await runBranding(store, {})).Explorer],
      ['admin-shell.js', async (store) => runShell(store).Explorer],
    ]) {
      let mismatches = [], checked = 0, keyOk = true;
      for (const c of CASES) {
        // Branding runs apply({}) — no connection block, so it must leave pool-network alone and
        // clear pool-explorer. Seed a fresh store per case and read the key through a copy that
        // apply() cannot touch: load, THEN re-seed, THEN query.
        const store = storeFor(c);
        const X = await load(store);
        const fresh = storeFor(c);
        store._m.clear(); for (const [k, v] of fresh._m) store._m.set(k, v);
        const want = expectedKey(c);
        let gotKey; try { gotKey = X.key(); } catch (e) { gotKey = 'THREW ' + e.message; }
        if (gotKey !== want) keyOk = false;
        for (const [label, [kind, value]] of Object.entries(REFS)) {
          checked++;
          let got; try { got = X.url(kind, value); } catch (e) { got = 'THREW ' + e.message; }
          const exp = ex.explorerUrl(want, kind, value);
          if (got !== exp) mismatches.push(`${caseLabel(c)} ${label}: got ${got}, want ${exp}`);
        }
      }
      ok(`i. ${name}: Explorer.url() matches the lib for ${CASES.length} cases × 4 refs (${checked} URLs)`,
        mismatches.length === 0, mismatches.slice(0, 4).join(' | '));
      ok(`i. ${name}: Explorer.key() equals resolveExplorerKey() for every case`, keyOk);
    }

    // Spelled out, so a failure reads as the rule it broke.
    for (const [name, load] of [
      ['branding.js', async (store) => (await runBranding(store, {})).Explorer],
      ['admin-shell.js', async (store) => runShell(store).Explorer],
    ]) {
      const at = async (init, kind, value) => {
        const store = makeStore(init);
        const X = await load(store);
        store._m.clear(); for (const [k, v] of Object.entries(init)) store._m.set(k, v);
        try { return X.url(kind, value); } catch (e) { return 'THREW ' + e.message; }
      };
      ok(`i. ${name}: mainnet + tiny → scan.grin.money/block/<h>`, await at({ 'pool-network': 'mainnet', 'pool-explorer': 'tiny' }, 'block', H) === `https://scan.grin.money/block/${H}`);
      ok(`i. ${name}: mainnet + grinscan → grinscan.org/kernel.html?ex=`, await at({ 'pool-network': 'mainnet', 'pool-explorer': 'grinscan' }, 'kernel', KERN) === `https://grinscan.org/kernel.html?ex=${KERN}`);
      ok(`i. ${name}: mainnet + grincoin → a block HASH goes to /hash/`, await at({ 'pool-network': 'mainnet', 'pool-explorer': 'grincoin' }, 'block', HASH) === `https://grincoin.org/hash/${HASH}`);
      ok(`i. ${name}: unset cache → grincoin`, await at({}, 'block', H) === `https://grincoin.org/block/${H}`);
      ok(`i. ${name}: mainnet + '__proto__' → grincoin`, await at({ 'pool-network': 'mainnet', 'pool-explorer': '__proto__' }, 'block', H) === `https://grincoin.org/block/${H}`);
      ok(`i. ${name}: mainnet + garbage → grincoin`, await at({ 'pool-network': 'mainnet', 'pool-explorer': 'https://evil.example' }, 'output', OUT) === `https://grincoin.org/output/${OUT}`);
      ok(`i. ${name}: testnet + a STALE mainnet key (tiny) → test.grinscan.org`, await at({ 'pool-network': 'testnet', 'pool-explorer': 'tiny' }, 'block', H) === `https://test.grinscan.org/block.html?h=${H}`);
      ok(`i. ${name}: MAINNET + a cached testnet key → grincoin, never test.grinscan.org`, await at({ 'pool-network': 'mainnet', 'pool-explorer': 'grinscan_testnet' }, 'block', H) === `https://grincoin.org/block/${H}`);
      // Private mode: every storage call throws. Must still build a valid (mainnet default) link.
      const Xt = await load(makeStore({}, true));
      let url = null;
      try { url = Xt.url('block', H); } catch (e) { url = 'THREW ' + e.message; }
      ok(`i. ${name}: sessionStorage that THROWS → grincoin, no exception`, url === `https://grincoin.org/block/${H}`, url);
    }
  }

  console.log('\n[j] the primers cache the server-resolved key\n');
  {
    // branding.js apply(): /api/public/branding → cfg.connection.{network,explorer}.
    for (const [net, key, want] of [['mainnet', 'tiny', `https://scan.grin.money/block/${H}`],
      ['mainnet', 'grinscan', `https://grinscan.org/block.html?h=${H}`],
      ['mainnet', 'grincoin', `https://grincoin.org/block/${H}`],
      ['testnet', 'grinscan_testnet', `https://test.grinscan.org/block.html?h=${H}`]]) {
      const store = makeStore();
      const { Explorer, errors } = await runBranding(store, { connection: { network: net, explorer: key } });
      ok(`j. branding.js: a ${net} response with explorer=${key} is cached and used`,
        store._m.get('pool-network') === net && store._m.get('pool-explorer') === key && Explorer.url('block', H) === want,
        `${store._m.get('pool-explorer')} ${Explorer.url('block', H)}`);
      ok(`j. branding.js: bootstrapping for ${key} logged no console error`, errors.length === 0, errors.join(' | '));
    }
    {
      const store = makeStore({ 'pool-network': 'mainnet', 'pool-explorer': 'tiny' });
      const { Explorer } = await runBranding(store, { connection: { network: 'mainnet' } });
      ok('j. branding.js: a response WITHOUT an explorer clears a stale cached key → grincoin',
        !store._m.has('pool-explorer') && Explorer.url('block', H) === `https://grincoin.org/block/${H}`);
    }

    // admin-shell.js decoratePoolIdentity(): /api/pool/stats → network + explorer, attribute, event.
    {
      const store = makeStore();
      const S = runShell(store, { network: 'mainnet', explorer: 'grinscan', pool_name: 'P' });
      S.decorate();
      await settle();
      ok('j. admin-shell.js: /api/pool/stats network + explorer are cached',
        store._m.get('pool-network') === 'mainnet' && store._m.get('pool-explorer') === 'grinscan' &&
        S.Explorer.url('kernel', KERN) === `https://grinscan.org/kernel.html?ex=${KERN}`);
      ok('j. admin-shell.js: sets data-pool-network and fires admin:pool-network',
        S.attrs['data-pool-network'] === 'mainnet' && S.events.length === 1 &&
        S.events[0].type === 'admin:pool-network' && S.events[0].detail.network === 'mainnet');
    }
    {
      const store = makeStore({ 'pool-explorer': 'tiny' });
      const S = runShell(store, { network: 'testnet', explorer: 'grinscan_testnet' });
      S.decorate();
      await settle();
      ok('j. admin-shell.js: a testnet pool caches grinscan_testnet and links there',
        store._m.get('pool-explorer') === 'grinscan_testnet' && S.Explorer.url('block', H) === `https://test.grinscan.org/block.html?h=${H}` &&
        S.attrs['data-pool-network'] === 'testnet');
    }
    {
      const store = makeStore({ 'pool-network': 'mainnet', 'pool-explorer': 'tiny' });
      const S = runShell(store, { network: 'mainnet' });
      S.decorate();
      await settle();
      ok('j. admin-shell.js: a stats body WITHOUT an explorer clears a stale key → grincoin',
        !store._m.has('pool-explorer') && S.Explorer.url('block', H) === `https://grincoin.org/block/${H}`);
    }

    // blocks.html primes BOTH keys from /api/config/pool-info before its first render.
    const primer = (blocksSrc.match(/fetch\('\/api\/config\/pool-info'[\s\S]*?\.finally\(function \(\) \{ loadSummary\(\); loadBlocks\(\);/) || [''])[0];
    ok('j. blocks.html: the pool-info primer writes pool-network AND pool-explorer (from d.explorer)',
      /sessionStorage\.setItem\('pool-network', d\.network\)/.test(primer) &&
      /sessionStorage\.setItem\('pool-explorer', d\.explorer\)/.test(primer));
    ok('j. blocks.html: …and renders only after it settles (loadBlocks in .finally)', /\.finally\(/.test(primer));
  }

  console.log('\n[k] Settings → Branding: the explorer select\n');
  {
    const selM = brandPageSrc.match(/<select id="explorer_mainnet"[^>]*>([\s\S]*?)<\/select>/);
    const opts = selM ? [...selM[1].matchAll(/<option value="([^"]*)"[^>]*>([^<]*)<\/option>/g)].map((m) => [m[1], m[2].trim()]) : [];
    ok('k. <select id="explorer_mainnet"> exists (bound by id)', !!selM);
    ok('k. its options are exactly MAINNET_CHOICES, in order — so a harvested value is valid or blank',
      canon(opts.map((o) => o[0])) === canon(ex.MAINNET_CHOICES), canon(opts));
    ok('k. labels name the hosts; grincoin.org is marked default',
      canon(opts.map((o) => o[1])) === canon(['grincoin.org (default)', 'scan.grin.money', 'grinscan.org']));
    ok('k. no free-text explorer input on the page', !/<input[^>]*id="explorer/.test(brandPageSrc));
    const formStart = brandPageSrc.indexOf('<div class="settings-form">');
    const actions = brandPageSrc.indexOf('<div class="form-actions">');
    const selAt = brandPageSrc.indexOf('id="explorer_mainnet"');
    ok('k. the select sits inside .settings-form (so the save harvests it)', formStart > 0 && selAt > formStart && selAt < actions);
    ok('k. the select is NOT settings-skip (it is a real config key)', !/id="explorer_mainnet"[^>]*settings-skip/.test(brandPageSrc));
    ok('k. help text names test.grinscan.org and never testnet.grinscan.org',
      /id="explorer-help"[^>]*>[^<]*test\.grinscan\.org/.test(brandPageSrc) && !/testnet\.grinscan/.test(brandPageSrc));

    // Run the page's testnet script against a stub DOM: attribute path, event path, mainnet no-op.
    const scriptM = brandPageSrc.match(/<script>\s*(\/\/ Testnet pools always link[\s\S]*?)<\/script>/);
    ok('k. the testnet greying script was found', !!scriptM);
    const runPage = (attrNet) => {
      const listeners = {};
      const sel = { disabled: false, style: {} };
      const help = { className: 'helper-text', textContent: 'orig', kids: [], appendChild(c) { this.kids.push(c); return c; } };
      const document = {
        getElementById: (id) => (id === 'explorer_mainnet' ? sel : id === 'explorer-help' ? help : null),
        documentElement: { getAttribute: (k) => (k === 'data-pool-network' ? attrNet : null) },
        addEventListener: (t, fn) => { listeners[t] = fn; },
        createElement: () => ({ textContent: '' }), createTextNode: (t) => ({ textContent: t }),
      };
      vm.runInNewContext(scriptM ? scriptM[1] : '', { document });
      return { sel, help, fire: (net) => listeners['admin:pool-network'] && listeners['admin:pool-network']({ detail: { network: net } }) };
    };
    if (scriptM) {
      const t = runPage('testnet');
      ok('k. testnet already known (attribute) → select disabled + warning line',
        t.sel.disabled === true && t.help.className === 'warn-msg' && t.help.kids.map((k) => k.textContent).join('').includes('test.grinscan.org'));
      const late = runPage(null);
      ok('k. network unknown at load → select stays enabled', late.sel.disabled === false);
      late.fire('testnet');
      ok('k. …then admin:pool-network=testnet → disabled', late.sel.disabled === true && late.help.className === 'warn-msg');
      const m = runPage('mainnet');
      m.fire('mainnet');
      ok('k. mainnet → select enabled, help text untouched', m.sel.disabled === false && m.help.className === 'helper-text' && m.help.textContent === 'orig');
    }
  }

  // Part 3 review finding: a page can render its links BEFORE its primer lands — branding's
  // fetch races reactor-dashboard's loadStatus, fortune-board's winners and the account ledger;
  // decoratePoolIdentity races every admin page's own fetch. sessionStorage is per TAB, so every
  // new tab is a first visit. A testnet pool then rendered test heights on grincoin.org (MAINNET)
  // and a mainnet pool set to tiny/grinscan rendered grincoin, and nothing re-rendered the links
  // the primer arrived too late for. Fix: link() tags each anchor with its kind + ref, and the
  // primer re-points every tagged anchor it finds (Explorer.relink()).
  console.log('\n[l] a link rendered BEFORE the primer lands is re-pointed when it does\n');
  {
    // Turn link() HTML into a fake anchor carrying its attributes (entity-decoded, as a parser would).
    const unesc = (s) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    const toAnchor = (html) => {
      const attrs = {};
      for (const m of String(html).matchAll(/\s([a-z-]+)="([^"]*)"/g)) attrs[m[1]] = unesc(m[2]);
      return {
        attrs,
        getAttribute(k) { return Object.prototype.hasOwnProperty.call(attrs, k) ? attrs[k] : null; },
        setAttribute(k, v) { attrs[k] = String(v); },
      };
    };
    const selects = (sel) => /data-xp-kind/.test(String(sel));

    // branding.js, with the branding fetch held open until the page has rendered.
    const runBrandingLate = async (store, cfg) => {
      let release;
      const gate = new Promise((r) => { release = r; });
      const anchors = [];
      const head = makeEl('head'), body = makeEl('body'), html = makeEl('html');
      const document = {
        documentElement: html, head, body, readyState: 'complete',
        createElement: makeEl, createTextNode: (t) => ({ textContent: t }),
        getElementById: () => null, getElementsByTagName: (t) => (t === 'head' ? [head] : []),
        querySelector: () => null, querySelectorAll: (sel) => (selects(sel) ? anchors : []), addEventListener() {},
      };
      const errors = [];
      const sb = {
        document, location: { pathname: '/', href: 'https://pool.example/', search: '', hostname: 'pool.example' },
        localStorage: makeStore(), sessionStorage: store, navigator: { userAgent: 'test' },
        console: { log() {}, warn() {}, info() {}, error: (...a) => errors.push(a.join(' ')) },
        setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {}, Promise, URL,
        fetch: () => gate.then(() => ({ ok: true, status: 200, json: () => Promise.resolve({ data: cfg }) })),
        matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
      };
      sb.window = sb; sb.self = sb; sb.globalThis = sb;
      vm.createContext(sb);
      vm.runInContext(brandingSrc, sb, { filename: 'branding.js' });
      return { Explorer: sb.Explorer, anchors, errors, land: async () => { release(); await settle(); } };
    };

    for (const [net, key, kind, ref, want] of [
      ['testnet', 'grinscan_testnet', 'block', H, `https://test.grinscan.org/block.html?h=${H}`],
      ['mainnet', 'tiny', 'block', HASH, `https://scan.grin.money/block/${HASH}`],
      ['mainnet', 'grinscan', 'kernel', KERN, `https://grinscan.org/kernel.html?ex=${KERN}`],
    ]) {
      const R = await runBrandingLate(makeStore(), { connection: { network: net, explorer: key } });
      const a = toAnchor(R.Explorer.link(kind, ref, 'x'));
      R.anchors.push(a);
      const before = a.getAttribute('href');
      await R.land();
      ok(`l. branding.js: ${net}/${key} — a ${kind} link rendered before the primer is re-pointed to ${want.split('/')[2]}`,
        before !== want && a.getAttribute('href') === want, `${before} → ${a.getAttribute('href')}`);
      ok(`l. branding.js: ${net}/${key} — no console error`, R.errors.length === 0, R.errors.join(' | '));
    }
    {
      // The ref is read back from the attribute and re-encoded — a hostile chain string can
      // neither break out of the attribute nor move the link off the registry host.
      const R = await runBrandingLate(makeStore(), { connection: { network: 'mainnet', explorer: 'tiny' } });
      const evil = '"><img src=x onerror=alert(1)>/../../evil.example';
      const html = R.Explorer.link('block', evil, 'x');
      const a = toAnchor(html);
      R.anchors.push(a);
      await R.land();
      ok('l. branding.js: a hostile ref stays escaped in the markup (no raw quote or tag)',
        !/"><img/.test(html) && a.getAttribute('data-xp-ref') === evil);
      ok('l. branding.js: …and relinks to the registry host, fully encoded',
        a.getAttribute('href') === `https://scan.grin.money/block/${encodeURIComponent(evil)}`, a.getAttribute('href'));
    }
    {
      // Explorer.link() with no value still returns a bare label, and relink() on a page with
      // no tagged anchors is a no-op (and never throws).
      const R = await runBrandingLate(makeStore(), { connection: { network: 'mainnet', explorer: 'grincoin' } });
      ok('l. branding.js: link() with no value is still a bare label', R.Explorer.link('block', '', 'n/a') === 'n/a');
      let threw = false;
      try { R.Explorer.relink(); } catch (e) { threw = true; }
      ok('l. branding.js: Explorer.relink() exists and is a no-op on an empty page', typeof R.Explorer.relink === 'function' && !threw);
    }

    // admin-shell.js: the page rendered from its own fetch before /api/pool/stats landed.
    const runShellLate = (store, statsBody) => {
      const anchors = [];
      const S = (() => {
        const attrs = {}, events = [];
        const sb = {
          sessionStorage: store,
          esc: (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
          sidebar: { querySelector: () => null },
          document: {
            title: 'Admin', getElementById: () => null,
            documentElement: { setAttribute: (k, v) => { attrs[k] = String(v); } },
            dispatchEvent: (e) => { events.push(e); return true; },
            querySelectorAll: (sel) => (selects(sel) ? anchors : []),
          },
          CustomEvent: function (type, init) { this.type = type; this.detail = init && init.detail; },
          fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve(statsBody || {}) }),
        };
        sb.window = sb;
        vm.createContext(sb);
        vm.runInContext(SHELL_BLOCK + '\n' + SHELL_DECORATE, sb, { filename: 'admin-shell.js (extract)' });
        return { Explorer: sb.Explorer, decorate: sb.decoratePoolIdentity };
      })();
      return { ...S, anchors };
    };
    for (const [net, key, want] of [
      ['testnet', 'grinscan_testnet', `https://test.grinscan.org/block.html?h=${H}`],
      ['mainnet', 'grinscan', `https://grinscan.org/block.html?h=${H}`],
    ]) {
      const S = runShellLate(makeStore(), { network: net, explorer: key });
      const a = toAnchor(S.Explorer.link('block', H, H));
      S.anchors.push(a);
      const before = a.getAttribute('href');
      S.decorate();
      await settle();
      ok(`l. admin-shell.js: ${net}/${key} — a block link rendered before /api/pool/stats is re-pointed`,
        before !== want && a.getAttribute('href') === want, `${before} → ${a.getAttribute('href')}`);
    }
  }

  console.log(fail ? `\nFAILED — ${pass} passed, ${fail} failed` : `\nALL PASS — ${pass} passed, 0 failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
