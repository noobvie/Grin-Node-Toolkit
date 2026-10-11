#!/usr/bin/env node
'use strict';

// Controls for scripts/lib/page-source.js. Every page-reading test goes through readPageSource(),
// so a bug here would make them all pass (or all fail) together — prove it does what it says.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { readPageSource, resolveSrc, isPageSpecific, PUBLIC_ROOT, ADMIN_ROOT } = require('./lib/page-source');

let passed = 0, failed = 0;
const ok = (name, cond, extra) => { if (cond) passed++; else { failed++; console.error(`FAIL  ${name}${extra ? `\n      ${extra}` : ''}`); } };

// A page that loads no page-specific script reads back byte for byte. An EXTRACTED page (F1–F5:
// it loads a js/pages/ or admin-panel/js/ src) legitimately differs, so instead it must come back
// with every one of its own scripts inlined in place — one FILE marker each, no own src left.
// (F1 fix: this regex had been written with its backslashes collapsed — a literal BACKSPACE byte
// for \b and a bare `s` for \s — so it never matched, no page was ever classed as extracted, and
// the first extraction failed the byte-identity check instead of being checked for what it is.)
const SRC_RE = /<script\b[^>]*\ssrc=["']([^"']+)["']/gi;
const ownSrcs = (p, html) => [...html.matchAll(SRC_RE)].map((m) => resolveSrc(p, m[1])).filter((f) => f && isPageSpecific(f));
let compared = 0, extracted = 0;
for (const root of [PUBLIC_ROOT, ADMIN_ROOT]) {
  for (const n of fs.readdirSync(root).filter((f) => f.endsWith('.html'))) {
    const p = path.join(root, n);
    const raw = fs.readFileSync(p, 'utf8');
    const own = ownSrcs(p, raw);
    const got = readPageSource(p);
    if (own.length) {
      extracted++;
      const markers = (got.match(/\/\* ==== FILE: [^*]+ \*\//g) || []).length;
      const left = ownSrcs(p, got).length;
      ok(`extracted page inlines its ${own.length} own script(s) in place: ${path.basename(root)}/${n}`,
        markers === own.length && left === 0, `markers=${markers} own srcs left=${left}`);
      continue;
    }
    compared++;
    ok(`page-specific-free page is byte-identical: ${path.basename(root)}/${n}`, got === raw);
  }
}
ok('walked at least 40 pages (the loop is not vacuous)', compared + extracted >= 40, `${compared} + ${extracted}`);
ok('the src regex sees a real tag (control: a pattern that never matches would skip nothing)',
  ownSrcs(path.join(PUBLIC_ROOT, 'a.html'), '<script src="/js/pages/x.js"></script>').length === 1);

ok('/admin/js/x.js → admin-panel/js/x.js', resolveSrc(path.join(ADMIN_ROOT, 'a.html'), '/admin/js/x.js') === path.join(ADMIN_ROOT, 'js', 'x.js'));
ok('/js/pages/x.js → public_html/js/pages/x.js', resolveSrc(path.join(PUBLIC_ROOT, 'a.html'), '/js/pages/x.js') === path.join(PUBLIC_ROOT, 'js', 'pages', 'x.js'));
ok('query string stripped', resolveSrc(path.join(PUBLIC_ROOT, 'a.html'), '/js/pages/x.js?v=3') === path.join(PUBLIC_ROOT, 'js', 'pages', 'x.js'));
ok('https:// and //host are not local', resolveSrc('/a.html', 'https://cdn.x/y.js') === null && resolveSrc('/a.html', '//cdn.x/y.js') === null);
ok('page-specific: public js/pages/', isPageSpecific(path.join(PUBLIC_ROOT, 'js', 'pages', 'x.js')));
ok('page-specific: admin-panel/js/', isPageSpecific(path.join(ADMIN_ROOT, 'js', 'x.js')));
ok('shared scripts are not page-specific', !isPageSpecific(path.join(PUBLIC_ROOT, 'js', 'api.js')) && !isPageSpecific(path.join(ADMIN_ROOT, 'admin-shell.js')));

// In-place inlining, via {all:true} against a temp dir (the repo's js/pages/ is not ours to write into).
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pagesrc-'));
try {
  fs.writeFileSync(path.join(dir, 'a.js'), 'var A = 1;');
  fs.writeFileSync(path.join(dir, 'b.js'), 'var B = 2;');
  const page = path.join(dir, 'p.html');
  fs.writeFileSync(page, '<head><script src="a.js"></script></head><body><script src="https://x/y.js"></script><script>var I=0;</script><script defer src="b.js"></script></body>');
  const def = readPageSource(page);
  ok('default: a non-page-specific local script is left as a tag', /<script src="a\.js"><\/script>/.test(def));
  const all = readPageSource(page, { all: true });
  ok('all: replaced IN PLACE, order kept', all.indexOf('var A = 1;') < all.indexOf('var I=0;') && all.indexOf('var I=0;') < all.indexOf('var B = 2;'));
  ok('all: result is an inline <script> (no src left for local files)', !/src="[ab]\.js"/.test(all) && /<script>\/\* ==== FILE: .*a\.js \*\/\nvar A = 1;<\/script>/.test(all));
  ok('all: remote script untouched', /<script src="https:\/\/x\/y\.js"><\/script>/.test(all));
  ok('all: other attributes (defer) survive', /<script defer>\/\* ==== FILE: .*b\.js/.test(all));
  fs.unlinkSync(path.join(dir, 'b.js'));
  let threw = false;
  try { readPageSource(page, { all: true }); } catch (e) { threw = /does not exist/.test(e.message); }
  ok('a missing local script THROWS (no silent skip)', threw);
} finally { fs.rmSync(dir, { recursive: true, force: true }); }

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
