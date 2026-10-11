#!/usr/bin/env node
'use strict';

// T5 — inline-script ratchet for the strict-CSP front-end work (plan H9–H14, H21).
//
// A strict `script-src` (no 'unsafe-inline') blocks four things, and this counts all four:
//   1. executable inline <script> blocks              (JSON-LD / other data types are NOT executable)
//   2. inline event-handler attributes  on*="…"       (in HTML, and built inside JS strings)
//   3. javascript: URLs
//   4. setAttribute('on…', …)
//
// Counts may only go DOWN against scripts/fixtures/inline-baseline.json; a count above its baseline
// (or a non-zero count in a file the baseline does not list) fails. A count below baseline passes
// and says so — lowering the baseline is a deliberate edit (`--write`), not something a test does
// to itself. `--zero` demands every count be zero: that is the gate F7 needs before 'unsafe-inline'
// can come out of script-src.
//
// COMMENTS ARE STRIPPED FIRST (H21). public_html/js/cms-frame.js names `onclick=` in its header
// comment to explain why CMS bodies are sandboxed; counting it would ratchet a comment forever and
// make "all zero" unreachable. CMS bodies render in a sandboxed srcdoc iframe with no allow-scripts,
// so they never needed 'unsafe-inline' and are not front-end work.
//
// Scanned: public_html/*.html, admin-panel/*.html (all four counts) and public_html/js/**/*.js (not
// vendor/), admin-panel/**/*.js (counts 2–4, string literals only). Within an HTML page the on*=
// scan also covers the inline script bodies: a row template built in a page's inline JS becomes a
// JS-file hit once the block is extracted, so the page's number must not drop merely by moving it.
//
//   node scripts/test-inline-script.js            check against the baseline
//   node scripts/test-inline-script.js --zero     F7 gate: everything must be zero
//   node scripts/test-inline-script.js --write    rewrite the baseline from the current tree

const fs = require('fs');
const path = require('path');

const APP = path.join(__dirname, '..');
const PUB = path.join(APP, '..', 'public_html');
const PANEL = path.join(APP, 'admin-panel');
const BASELINE = path.join(__dirname, 'fixtures', 'inline-baseline.json');

// ── counting ────────────────────────────────────────────────────────────────

const JS_TYPES = /^(text\/javascript|application\/javascript|module)$/;

// Block + line comments out of JS, leaving strings alone. A `//` only starts a comment outside a
// string/template/regex-free context; the scanner tracks quotes so `"https://x"` survives.
function stripJsComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '*') {
      const e = src.indexOf('*/', i + 2);
      i = e < 0 ? n : e + 2;
      out += ' ';
    } else if (c === '/' && d === '/') {
      const e = src.indexOf('\n', i);
      i = e < 0 ? n : e;
    } else if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < n && src[j] !== c) {
        if (src[j] === '\\') j++;
        else if (c !== '`' && src[j] === '\n') break;   // unterminated: a regex literal or stray quote
        j++;
      }
      out += src.slice(i, j + 1);
      i = j + 1;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

const stripHtmlComments = (h) => h.replace(/<!--[\s\S]*?-->/g, '');

// on*= with a quote after it: an attribute in HTML, `onclick="…"` / `onclick=\"…\"` in a JS string.
const ON_ATTR = /[\s'"`>]on[a-z]{3,}\s*=\s*\\?["']/gi;
const JS_URL = /\bjavascript\s*:/gi;
const SET_ATTR_ON = /setAttribute\(\s*(['"`])on[a-z]/gi;

const count = (re, s) => (s.match(re) || []).length;

function countHtml(html) {
  const src = stripHtmlComments(html);
  let inlineScripts = 0;
  let scriptBodies = '';
  for (const m of src.matchAll(/<script(?![^>]*\ssrc=)([^>]*)>([\s\S]*?)<\/script>/gi)) {
    if (!m[2].trim()) continue;
    const t = /\stype\s*=\s*["']?([^"'\s>]+)/i.exec(m[1]);
    const type = t ? t[1].toLowerCase() : '';
    if (type && !JS_TYPES.test(type)) continue;   // JSON-LD etc. is data (H12)
    inlineScripts++;
    scriptBodies += stripJsComments(m[2]) + '\n';
  }
  // Markup outside the script bodies + the (comment-stripped) bodies themselves.
  const markup = src.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ');
  const text = markup + '\n' + scriptBodies;
  return {
    inlineScripts,
    onAttrs: count(ON_ATTR, text),
    jsUrls: count(JS_URL, text),
    setAttr: count(SET_ATTR_ON, text),
  };
}

function countJs(js) {
  const src = stripJsComments(js);
  return {
    onAttrs: count(ON_ATTR, src),
    jsUrls: count(JS_URL, src),
    setAttr: count(SET_ATTR_ON, src),
  };
}

// ── tree walk ───────────────────────────────────────────────────────────────

function walkJs(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'vendor' && e.name !== 'node_modules') walkJs(full, out); }
    else if (e.name.endsWith('.js')) out.push(full);
  }
  return out;
}

function scanTree() {
  const result = {};
  const put = (rel, c) => { if (Object.values(c).some((v) => v > 0)) result[rel] = c; };
  for (const [root, label] of [[PUB, 'public_html'], [PANEL, 'admin-panel']]) {
    for (const name of fs.readdirSync(root).filter((f) => f.endsWith('.html')).sort()) {
      put(`${label}/${name}`, countHtml(fs.readFileSync(path.join(root, name), 'utf8')));
    }
  }
  for (const [root, label] of [[path.join(PUB, 'js'), 'public_html/js'], [PANEL, 'admin-panel']]) {
    for (const f of walkJs(root).sort()) {
      const rel = `${label}/${path.relative(root, f).replace(/\\/g, '/')}`;
      put(rel, countJs(fs.readFileSync(f, 'utf8')));
    }
  }
  return result;
}

const KEYS = ['inlineScripts', 'onAttrs', 'jsUrls', 'setAttr'];
const get = (o, k) => (o && o[k]) || 0;

// ── main ────────────────────────────────────────────────────────────────────

if (require.main !== module) {
  module.exports = { countHtml, countJs, stripJsComments, scanTree };
  return;
}

const args = new Set(process.argv.slice(2));
let passed = 0;
let failed = 0;
const ok = (name, cond, extra) => {
  if (cond) { passed++; return; }
  failed++;
  console.error(`FAIL  ${name}${extra ? `\n      ${extra}` : ''}`);
};

// Controls: the counter must see what it claims to and ignore what it claims to ignore. A counter
// that always returns 0 would make the ratchet — and F7's gate — pass forever.
{
  const h = (s) => countHtml(s);
  ok('control: <script> block counted', h('<script>var a=1</script>').inlineScripts === 1);
  ok('control: <script src> not counted', h('<script src="/x.js"></script>').inlineScripts === 0);
  ok('control: JSON-LD not counted', h('<script type="application/ld+json">{"a":1}</script>').inlineScripts === 0);
  ok('control: empty <script> not counted', h('<script>  </script>').inlineScripts === 0);
  ok('control: on*= attribute counted', h('<button onclick="go()">x</button>').onAttrs === 1);
  ok('control: two attributes on one tag', h('<a onclick="a()" onmouseover="b()">x</a>').onAttrs === 2);
  ok('control: on*= in an HTML comment ignored', h('<!-- <b onclick="x"> --><p>x</p>').onAttrs === 0);
  ok('control: on*= in a JS comment ignored', h('<script>// <b onclick="x">\n/* onload="y" */var a;</script>').onAttrs === 0);
  ok('control: on*= built in an inline script string counted', h(`<script>el.innerHTML='<b onclick="go()">'</script>`).onAttrs === 1);
  ok('control: href javascript: counted', h('<a href="javascript:void(0)">x</a>').jsUrls === 1);
  ok('control: a // inside a string is not a comment', countJs(`var u="https://x"; var h='<i onclick="a()">';`).onAttrs === 1);
  ok('control: .onclick = property assignment not counted', countJs('el.onclick = go; el.onload = go;').onAttrs === 0);
  ok('control: setAttribute(on…) counted', countJs(`el.setAttribute('onclick', 'x()')`).setAttr === 1);
  ok('control: escaped-quote handler in a JS string counted', countJs(`s = "<b onclick=\\"x()\\">"`).onAttrs === 1);
  ok('control: header comment naming onclick= ignored (cms-frame.js, H21)',
     countJs('/* CMS bodies: no onclick="…" survives */\nvar a = 1;').onAttrs === 0);
}

const current = scanTree();

if (args.has('--write')) {
  fs.mkdirSync(path.dirname(BASELINE), { recursive: true });
  fs.writeFileSync(BASELINE, JSON.stringify(current, null, 2) + '\n');
  console.log(`baseline written: ${Object.keys(current).length} files, ${tally(current)}`);
  process.exit(0);
}

function tally(m) {
  const t = {};
  for (const k of KEYS) t[k] = Object.values(m).reduce((a, c) => a + get(c, k), 0);
  return KEYS.map((k) => `${k}=${t[k]}`).join(' ');
}

if (args.has('--zero')) {
  for (const [f, c] of Object.entries(current)) ok(`zero: ${f}`, false, JSON.stringify(c));
  if (!failed) ok('zero: tree is clean', true);
} else {
  const baseline = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
  const names = new Set([...Object.keys(baseline), ...Object.keys(current)]);
  const lowered = [];
  for (const f of [...names].sort()) {
    for (const k of KEYS) {
      const was = get(baseline[f], k);
      const now = get(current[f], k);
      ok(`ratchet: ${f} ${k} ${now} <= ${was}`, now <= was, now > was ? 'count went UP — new inline script / handler (or move it out)' : '');
      if (now < was) lowered.push(`${f} ${k} ${was} -> ${now}`);
    }
  }
  if (lowered.length) {
    console.log(`note: ${lowered.length} count(s) below baseline — lower it with --write when the drop is intended:`);
    for (const l of lowered) console.log(`  ${l}`);
  }
  ok('baseline lists only files that exist', Object.keys(baseline).every((f) => {
    const p = f.startsWith('public_html/') ? path.join(PUB, f.slice('public_html/'.length)) : path.join(PANEL, f.slice('admin-panel/'.length));
    return fs.existsSync(p);
  }));
}

console.log(`\n${passed} passed, ${failed} failed  [${tally(current)}]`);
process.exit(failed ? 1 : 0);
