'use strict';

// Source reader for tests that assert on a PAGE's code.
//
// A page's JavaScript is moving out of inline <script> blocks into files (public_html/js/pages/,
// admin-panel/js/) so a strict script-src can drop 'unsafe-inline'. A test that does
// `fs.readFileSync('x.html')` then either FAILS after the extraction or — worse — PASSES
// VACUOUSLY: a "this must not appear" check over an HTML file that no longer holds the code asserts
// nothing. Every test that asserts on a page's script reads the page through here.
//
//   readPageSource(htmlPath)             the HTML, with each PAGE-SPECIFIC local <script src> replaced
//                                        IN PLACE by an inline <script> holding the file's content
//   readPageSource(htmlPath, {all:true}) ...and with every other local script inlined too
//
// Why in place, as an inline <script>: the result then looks exactly like the page did before the
// extraction, so a test that cuts a block out by marker (`<script>` … `</script>`), counts blocks or
// runs one in a vm keeps working unchanged, and position-sensitive assertions keep their order.
// Before any extraction the result is BYTE-IDENTICAL to the HTML file.
//
// "Page-specific" = a script under js/pages/ (public) or admin-panel/js/ (admin) — the extraction
// targets. Shared scripts (api.js, auth.js, branding.js, admin-shell.js …) are NOT inlined by
// default: tests that care read them directly, and pasting a 2,000-line shell into every page
// would change every count and make every "appears once" assertion lie. {all:true} is there for
// the rare test that needs a page plus everything it loads, in load order.
//
// Each inlined file is preceded by `/* ==== FILE: <relative path> */` so a failure points at it.
// Non-local sources (http:, https:, //host) are never read. A local src that does not exist THROWS —
// a silent skip is how a page loses its code without a test noticing.

const fs = require('fs');
const path = require('path');

const APP = path.join(__dirname, '..', '..');
const PUBLIC_ROOT = path.join(APP, '..', 'public_html');
const ADMIN_ROOT = path.join(APP, 'admin-panel');

const SCRIPT_SRC = /<script\b([^>]*?)\ssrc\s*=\s*(["'])([^"']*)\2([^>]*)>\s*<\/script>/gi;

const norm = (p) => p.replace(/\\/g, '/');

// Where a script URL lives on disk, as served: /admin/x → admin-panel/x, /x → public_html/x,
// a relative x → beside the page. Query/hash stripped. null = not a local file we serve.
function resolveSrc(htmlPath, src) {
  const clean = src.split(/[?#]/)[0];
  if (!clean || /^([a-z][a-z0-9+.-]*:|\/\/)/i.test(clean)) return null;
  if (clean.startsWith('/admin/')) return path.join(ADMIN_ROOT, clean.slice('/admin/'.length));
  if (clean.startsWith('/')) return path.join(PUBLIC_ROOT, clean.slice(1));
  return path.resolve(path.dirname(htmlPath), clean);
}

function isPageSpecific(file) {
  const f = norm(file);
  return f.startsWith(norm(path.join(PUBLIC_ROOT, 'js', 'pages')) + '/')
      || f.startsWith(norm(path.join(ADMIN_ROOT, 'js')) + '/');
}

function readPageSource(htmlPath, opts = {}) {
  const abs = path.resolve(htmlPath);
  const html = fs.readFileSync(abs, 'utf8');
  return html.replace(SCRIPT_SRC, (whole, pre, _q, src, post) => {
    const file = resolveSrc(abs, src);
    if (!file) return whole;
    if (!opts.all && !isPageSpecific(file)) return whole;
    if (!fs.existsSync(file)) {
      throw new Error(`readPageSource: ${path.basename(abs)} loads ${src} but ${norm(file)} does not exist`);
    }
    const attrs = `${pre} ${post}`.replace(/\s+/g, ' ').replace(/\s*$/, '');
    const rel = norm(path.relative(path.join(APP, '..'), file));
    return `<script${attrs}>/* ==== FILE: ${rel} */\n${fs.readFileSync(file, 'utf8')}</script>`;
  });
}

module.exports = { readPageSource, resolveSrc, isPageSpecific, PUBLIC_ROOT, ADMIN_ROOT };
