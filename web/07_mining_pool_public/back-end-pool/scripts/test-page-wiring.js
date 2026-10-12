#!/usr/bin/env node
'use strict';

// Page wiring + script order (code-layout R3 L6).
//
// F2–F5 turned every inline on*= handler into TWO strings in two places — a data-action value in
// the markup (or in markup a script builds) and a `case` in a delegated document listener — plus
// an event-type choice and, for a non-bubbling event, a capture flag. Nothing executed that pairing:
// R3 planted 21 wiring / script-order defects and the suite caught 3. This test is the static half
// of that review, run on every page (the jsdom old-vs-new smoke in the plan tooling is the dynamic
// half, and A2 is the live one):
//
//   [1] every data-action on a page has a handler in a document listener of a script that page loads
//   [2] every handler `case` is used by at least one page that loads its script (no dead case)
//   [3] the handler sits under the RIGHT event: a <form> → submit; <select> / file / checkbox / radio
//       → change; a text field → input|change; anything else → click. An action is in ONE event type.
//   [4] every action listener resolves the element with closest('[data-action]') (a bare e.target
//       makes a click on a button's emoji/span child do nothing), and a delegated listener for a
//       non-bubbling event (error, load, focus, …) passes capture `true`
//   [5] script tags: no local <script src> carries defer / async / type (the extraction kept classic
//       blocking order); every page-specific script loads AFTER the page's other shared scripts
//       (Chart.js, api.js, settings-common.js …) and BEFORE the public shell trio (public-shell.js,
//       public-theme.js, branding.js) — except payments-redirect.js, which must be the FIRST script
//       in payments.html's <head>, ahead of every stylesheet
//   [6] settings-*.html: exactly one settings-common.js tag each, its data-section pinned below; and
//       settings-common.js still opens with the prelude that reads it
//
// What this CANNOT see: a wrong ARGUMENT inside a case (el.parentElement vs el.closest(sel), a string
// passed for a number) — the jsdom smoke and A2 cover those.
//
// Run: node scripts/test-page-wiring.js

const fs = require('fs');
const path = require('path');
const { resolveSrc, isPageSpecific, PUBLIC_ROOT, ADMIN_ROOT } = require('./lib/page-source');

let passed = 0, failed = 0;
const ok = (name, cond, extra) => {
  if (cond) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}${extra ? `\n      ${extra}` : ''}`); }
};

// ─── pure helpers (the controls at the bottom run them on planted input) ──────────────────────────

const ACTION_RE = /^[a-z0-9][a-z0-9-]*$/;
// Events that do not bubble: a listener on document only sees them in the capture phase.
const NON_BUBBLING = new Set(['error', 'load', 'abort', 'focus', 'blur', 'mouseenter', 'mouseleave',
  'pointerenter', 'pointerleave', 'scroll', 'invalid', 'toggle', 'loadstart', 'loadend', 'progress']);

// HTML with comments removed and every <script>…</script> BODY blanked (open tags kept, so [5] can
// read their attributes) — prose and code inside a page must not read as markup.
function stripHtml(html) {
  return html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/(<script\b[^>]*>)[\s\S]*?(<\/script>)/gi, '$1$2');
}

const attrOf = (attrs, name) => {
  const m = attrs.match(new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  return m ? (m[1] ?? m[2] ?? m[3]) : null;
};
const hasAttr = (attrs, name) => new RegExp(`(?:^|\\s)${name}(?:\\s*=|\\s|$)`, 'i').test(attrs);

// Elements in markup carrying a data-action: [{ action, tag, type }]
function markupActions(html) {
  const out = [];
  for (const m of stripHtml(html).matchAll(/<([a-zA-Z][a-zA-Z0-9-]*)\b([^>]*)>/g)) {
    const action = attrOf(m[2], 'data-action');
    if (action !== null) out.push({ action, tag: m[1].toLowerCase(), type: (attrOf(m[2], 'type') || '').toLowerCase() });
  }
  return out;
}

// data-action values inside markup a SCRIPT builds (string / template literals). The element is the
// nearest `<tag` before the attribute; its type= is read from the same stretch.
function jsActions(src) {
  const out = [];
  for (const m of src.matchAll(/data-action=\\?["']([^"'\\]*)\\?["']/g)) {
    const before = src.slice(Math.max(0, m.index - 600), m.index);
    const tags = [...before.matchAll(/<([a-zA-Z][a-zA-Z0-9]*)\b/g)];
    const last = tags[tags.length - 1];
    const tag = last ? last[1].toLowerCase() : '?';
    const stretch = last ? before.slice(last.index) : '';
    const tm = stretch.match(/\stype=\\?["']([a-z]+)/i);
    out.push({ action: m[1], tag, type: tm ? tm[1].toLowerCase() : '' });
  }
  return out;
}

// The argument list of the call whose `(` is at src[open]: returns the text up to the matching `)`.
// Strings, template literals and comments are skipped so a ')' or '}' inside them does not count.
function callArgs(src, open) {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { i = src.indexOf('\n', i); if (i < 0) break; continue; }
    if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i + 2) + 1; if (i <= 0) break; continue; }
    if (c === '"' || c === "'" || c === '`') {
      for (i++; i < src.length && src[i] !== c; i++) if (src[i] === '\\') i++;
      continue;
    }
    if (c === '(' || c === '{' || c === '[') depth++;
    else if (c === ')' || c === '}' || c === ']') { depth--; if (depth === 0) return src.slice(open + 1, i); }
  }
  return null;
}

// document.addEventListener('<evt>', handler[, capture]) → [{ event, capture, actions, closest, body }]
function documentListeners(src) {
  const out = [];
  for (const m of src.matchAll(/\bdocument\.addEventListener\(/g)) {
    const open = m.index + m[0].length - 1;
    const args = callArgs(src, open);
    if (args === null) { out.push({ event: '?', capture: false, actions: [], closest: false, body: '', broken: true }); continue; }
    const ev = args.match(/^\s*(['"])([^'"]+)\1\s*,/);
    const actions = [
      ...[...args.matchAll(/\bcase\s+'([^']*)'\s*:/g)].map((x) => x[1]),
      ...[...args.matchAll(/(?:\.dataset\.action|getAttribute\('data-action'\))\s*===\s*'([^']*)'/g)].map((x) => x[1]),
    ];
    out.push({
      event: ev ? ev[2] : '?',
      capture: /[)}]\s*,\s*(?:true|\{[^{}]*\bcapture\s*:\s*true\b[^{}]*\})\s*$/.test(args),
      actions,
      readsAction: /dataset\.action|getAttribute\('data-action'\)/.test(args),
      closest: /\.closest\(\s*'\[data-action\]'\s*\)/.test(args),
      body: args,
    });
  }
  return out;
}

function allowedEvents(tag, type) {
  if (tag === 'form') return ['submit'];
  if (tag === 'select') return ['change'];
  if (tag === 'input' && ['file', 'checkbox', 'radio'].includes(type)) return ['change'];
  if (tag === 'input' || tag === 'textarea') return ['input', 'change'];
  return ['click'];
}

// Local <script> tags of a page, in document order: [{ src, file, attrs, inline, at }]
function scriptTags(htmlPath, html) {
  const out = [];
  for (const m of stripHtml(html).matchAll(/<script\b([^>]*)>/gi)) {
    const src = attrOf(m[1], 'src');
    out.push({ src, file: src ? resolveSrc(htmlPath, src) : null, attrs: m[1], inline: src === null, at: m.index });
  }
  return out;
}

// One page: its actions vs the listeners of the scripts it loads. → { problems[], actions[], used Map(file→Set) }
function checkPage(label, html, scripts) {
  const problems = [];
  const actions = markupActions(html).map((a) => ({ ...a, from: 'html' }));
  for (const s of scripts) for (const a of jsActions(s.src)) actions.push({ ...a, from: s.name });
  const listeners = [];
  for (const s of scripts) for (const l of documentListeners(s.src)) listeners.push({ ...l, file: s.name });

  for (const l of listeners) {
    if (l.broken) problems.push(`${l.file}: unparseable document.addEventListener call`);
    if (NON_BUBBLING.has(l.event) && !l.capture) {
      problems.push(`${l.file}: document '${l.event}' listener without capture — '${l.event}' does not bubble, it never fires`);
    }
    if (l.readsAction && !l.closest) {
      problems.push(`${l.file}: '${l.event}' action listener does not resolve closest('[data-action]')`);
    }
  }
  // action → event types that handle it, across this page's scripts
  const handledBy = new Map();
  for (const l of listeners) for (const a of l.actions) {
    if (!handledBy.has(a)) handledBy.set(a, new Set());
    handledBy.get(a).add(l.event);
  }
  for (const a of actions) {
    if (!ACTION_RE.test(a.action)) { problems.push(`${a.from}: malformed data-action ${JSON.stringify(a.action)} on <${a.tag}>`); continue; }
    const evs = handledBy.get(a.action);
    if (!evs) { problems.push(`${a.from}: data-action "${a.action}" on <${a.tag}> has NO handler in any script this page loads`); continue; }
    const allowed = allowedEvents(a.tag, a.type);
    const wrong = [...evs].filter((e) => !allowed.includes(e));
    if (wrong.length || evs.size !== 1) {
      problems.push(`${a.from}: data-action "${a.action}" on <${a.tag}${a.type ? ` type=${a.type}` : ''}> is handled under [${[...evs]}] — want exactly one of [${allowed}]`);
    }
  }
  const used = new Map();
  const onPage = new Set(actions.map((a) => a.action));
  for (const l of listeners) for (const a of l.actions) {
    if (!used.has(l.file)) used.set(l.file, new Map());
    const m = used.get(l.file);
    m.set(a, (m.get(a) || false) || onPage.has(a));
  }
  return { problems, actions, listeners, used };
}

// [5] on one page's tag list. pageSpecific(file) decides which tags are the page's own; isTrailer
// marks the public shell scripts that run AFTER the page's own code (they did before F2 too).
function checkOrder(label, html, tags, pageSpecific, isRedirect, isTrailer = () => false) {
  const problems = [];
  for (const t of tags) {
    if (t.inline) continue; // inline blocks are T5's business (only JSON-LD is left)
    if (!t.file) continue;  // a remote src — none today; the CSP owns those
    for (const a of ['defer', 'async', 'type', 'nomodule']) {
      if (hasAttr(t.attrs, a)) problems.push(`${t.src}: carries ${a} — the extraction kept classic blocking order`);
    }
  }
  const local = tags.filter((t) => !t.inline && t.file);
  const own = local.filter((t) => pageSpecific(t.file) && !isRedirect(t.file));
  const deps = local.filter((t) => !pageSpecific(t.file) && !isTrailer(t.file));
  const trailers = local.filter((t) => !pageSpecific(t.file) && isTrailer(t.file));
  for (const t of own) {
    const early = deps.filter((s) => s.at > t.at).map((s) => s.src);
    if (early.length) problems.push(`${t.src}: page script loads BEFORE shared script(s) ${early.join(', ')}`);
    const late = trailers.filter((s) => s.at < t.at).map((s) => s.src);
    if (late.length) problems.push(`${t.src}: page script loads AFTER shell script(s) ${late.join(', ')} (they run last)`);
  }
  const redirects = local.filter((t) => isRedirect(t.file));
  if (redirects.length) {
    const firstSheet = stripHtml(html).search(/<link\b[^>]*\brel\s*=\s*["']?stylesheet/i);
    const headEnd = stripHtml(html).search(/<\/head>/i);
    const r = redirects[0];
    if (redirects.length !== 1) problems.push(`payments-redirect.js loaded ${redirects.length} times`);
    if (local[0] !== r) problems.push('payments-redirect.js is not the first script');
    if (!(r.at < headEnd)) problems.push('payments-redirect.js is not in <head>');
    if (firstSheet >= 0 && !(r.at < firstSheet)) problems.push('payments-redirect.js loads after a stylesheet (the old page paints before the redirect)');
  }
  return problems;
}

// ─── the tree ─────────────────────────────────────────────────────────────────────────────────────

const norm = (p) => p.replace(/\\/g, '/');
const rel = (f) => norm(path.relative(path.join(PUBLIC_ROOT, '..'), f));
const walkHtml = (d, out = []) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'vendor') continue;
    const f = path.join(d, e.name);
    if (e.isDirectory()) walkHtml(f, out); else if (e.name.endsWith('.html')) out.push(f);
  }
  return out;
};
const pages = [...walkHtml(PUBLIC_ROOT), ...walkHtml(ADMIN_ROOT)];
const isRedirect = (f) => norm(f).endsWith('/admin-panel/js/payments-redirect.js');
// The public shell: injected nav/footer, theme, branding. Every public page loads them AFTER its
// own code, exactly where they sat when that code was an inline block.
const TRAILERS = ['public_html/js/public-shell.js', 'public_html/js/public-theme.js', 'public_html/js/branding.js'];
const isTrailer = (f) => TRAILERS.some((t) => norm(f).endsWith('/' + t));
const srcCache = new Map();
const readJs = (f) => { if (!srcCache.has(f)) srcCache.set(f, fs.readFileSync(f, 'utf8')); return srcCache.get(f); };

console.log('\n[1]–[4] data-action ↔ document listeners, per page');
const usedAcross = new Map(); // script → Map(action → used on some page that loads it)
let totalActions = 0, actionListeners = 0, pagesWithActions = 0;
const listenerFiles = new Set();
for (const p of pages) {
  const html = fs.readFileSync(p, 'utf8');
  const tags = scriptTags(p, html);
  const scripts = tags.filter((t) => t.file && fs.existsSync(t.file) && !/[\\/]vendor[\\/]/.test(t.file))
    .map((t) => ({ name: rel(t.file), src: readJs(t.file) }));
  const r = checkPage(rel(p), html, scripts);
  ok(`${rel(p)}: every action wired, right event, closest(), capture`, r.problems.length === 0, r.problems.join('\n      '));
  totalActions += r.actions.length;
  if (r.actions.length) pagesWithActions++;
  for (const [file, m] of r.used) {
    listenerFiles.add(file);
    if (!usedAcross.has(file)) usedAcross.set(file, new Map());
    const u = usedAcross.get(file);
    for (const [a, yes] of m) u.set(a, (u.get(a) || false) || yes);
  }
}
for (const [, m] of usedAcross) actionListeners += m.size;

console.log('\n[2] no dead case — every handler action is used by some page that loads its script');
for (const [file, m] of [...usedAcross].sort()) {
  const dead = [...m].filter(([, yes]) => !yes).map(([a]) => a);
  ok(`${file}: every case is used`, dead.length === 0, `unused: ${dead.join(', ')}`);
}
// Non-vacuity: today 181 converted handlers → ~200 data-action occurrences on 28 pages, ~150 distinct
// (file, action) cases in 19 scripts. Floors well under, so a parser that stops matching fails here.
ok(`non-vacuity: ≥ 44 pages walked (${pages.length})`, pages.length >= 44);
ok(`non-vacuity: ≥ 150 data-action occurrences found (${totalActions})`, totalActions >= 150);
ok(`non-vacuity: ≥ 20 pages carry an action (${pagesWithActions})`, pagesWithActions >= 20);
ok(`non-vacuity: ≥ 120 handler cases in ≥ 15 scripts (${actionListeners} in ${usedAcross.size})`,
  actionListeners >= 120 && usedAcross.size >= 15);

console.log('\n[5] script tags + order');
let ownSeen = 0;
for (const p of pages) {
  const html = fs.readFileSync(p, 'utf8');
  const tags = scriptTags(p, html);
  ownSeen += tags.filter((t) => t.file && isPageSpecific(t.file)).length;
  const probs = checkOrder(rel(p), html, tags, isPageSpecific, isRedirect, isTrailer);
  ok(`${rel(p)}: classic order, page script after its libraries and before the public shell`,
    probs.length === 0, probs.join('\n      '));
}
ok(`non-vacuity: ≥ 30 page-specific script tags seen (${ownSeen})`, ownSeen >= 30);
ok('non-vacuity: the three public shell scripts exist (else the trailer rule reads nothing)',
  TRAILERS.every((t) => fs.existsSync(path.join(PUBLIC_ROOT, '..', t))));
{
  const pay = path.join(ADMIN_ROOT, 'payments.html');
  const t = scriptTags(pay, fs.readFileSync(pay, 'utf8')).filter((x) => x.file);
  ok('payments.html: payments-redirect.js present (the [5] redirect checks are not vacuous)',
    t.length > 0 && isRedirect(t[0].file), t.map((x) => x.src).join(', '));
}

console.log('\n[6] settings-*.html → settings-common.js data-section');
{
  // Pinned: page → the section it opens. A blank/wrong tab is the only symptom of a wrong value.
  const SECTIONS = {
    'settings-access.html': 'access', 'settings-analytics.html': 'analytics',
    'settings-announcements.html': 'notices', 'settings-branding.html': 'branding',
    'settings-database.html': 'database', 'settings-games.html': 'games',
    'settings-incentives.html': 'incentives', 'settings-names.html': 'names',
    'settings-payout.html': 'payout', 'settings-pool-info.html': 'pool_info', 'settings-seo.html': 'seo',
  };
  const onDisk = fs.readdirSync(ADMIN_ROOT).filter((f) => /^settings-.+\.html$/.test(f)).sort();
  ok('the settings-*.html set on disk == the pinned table (a new settings page needs a row)',
    JSON.stringify(onDisk) === JSON.stringify(Object.keys(SECTIONS).sort()), onDisk.join(','));
  for (const [page, want] of Object.entries(SECTIONS)) {
    const f = path.join(ADMIN_ROOT, page);
    if (!fs.existsSync(f)) { ok(`${page}: exists`, false); continue; }
    const html = fs.readFileSync(f, 'utf8');
    const common = scriptTags(f, html).filter((t) => t.file && norm(t.file).endsWith('/admin-panel/settings-common.js'));
    const got = common.map((t) => attrOf(t.attrs, 'data-section'));
    ok(`${page}: one settings-common.js tag, data-section="${want}"`, common.length === 1 && got[0] === want,
      JSON.stringify(got));
    // the section's container must exist on the page, or switchTab() opens nothing
    ok(`${page}: holds the #${want} section switchTab() reveals`, new RegExp(`\\sid=["']${want}["']`).test(stripHtml(html)));
  }
  const common = fs.readFileSync(path.join(ADMIN_ROOT, 'settings-common.js'), 'utf8');
  const code = common.replace(/^\s*(?:\/\*[\s\S]*?\*\/|\/\/[^\n]*\n|\s)*/, '');
  ok('settings-common.js: the data-section prelude is its FIRST statement (document.currentScript is null later)',
    /^if \(document\.currentScript && document\.currentScript\.getAttribute\('data-section'\)\) \{\s*window\.SETTINGS_SECTION = document\.currentScript\.getAttribute\('data-section'\);\s*\}/.test(code),
    code.slice(0, 120));
}

// ─── controls: each defect class, planted in synthetic input, must be reported ────────────────────
console.log('\n[controls] the checker reports what it claims to');
{
  const W = (evt, body, tail = '') => `document.addEventListener('${evt}', function (e) {\n  var el = e.target.closest('[data-action]');\n  if (!el) return;\n  switch (el.dataset.action) {\n${body}\n  }\n}${tail});\n`;
  const good = { name: 'p.js', src: W('click', "    case 'go': go(); break;") + W('change', "    case 'pick': pick(); break;") };
  const html = '<button data-action="go">Go</button><select data-action="pick"></select>';
  const base = checkPage('ctl', html, [good]);
  ok('control: a correct page has no problem', base.problems.length === 0, base.problems.join(' | '));
  const has = (r, re) => r.problems.some((x) => re.test(x));
  ok('control: orphan action (no case) → reported',
    has(checkPage('ctl', html + '<button data-action="gone">', [good]), /"gone".*NO handler/));
  ok('control: action written by a script, no case → reported',
    has(checkPage('ctl', html, [good, { name: 'q.js', src: "x.innerHTML = '<a href=\"#\" data-action=\"ghost\">';" }]), /"ghost".*NO handler/));
  ok('control: <select> action under click → reported',
    has(checkPage('ctl', html, [{ name: 'p.js', src: W('click', "    case 'go': go(); break;\n    case 'pick': pick(); break;") }]), /"pick".*want exactly one of \[change\]/));
  ok('control: <form> action under click → reported',
    has(checkPage('ctl', '<form data-action="sub"></form>', [{ name: 'p.js', src: W('click', "    case 'sub': s(e); break;") }]), /"sub".*\[submit\]/));
  ok('control: file input in a JS string, handled under click → reported',
    has(checkPage('ctl', '', [{ name: 'p.js', src: "h = '<input type=\"file\" data-action=\"up\">';\n" + W('click', "    case 'up': u(); break;") }]), /"up".*\[change\]/));
  ok('control: one action under two event types → reported',
    has(checkPage('ctl', '<button data-action="go">', [{ name: 'p.js', src: W('click', "    case 'go': go(); break;") + W('input', "    case 'go': go(); break;") }]), /"go".*\[click,input\]/));
  ok('control: e.target without closest() → reported',
    has(checkPage('ctl', '<button data-action="go">', [{ name: 'p.js', src: "document.addEventListener('click', function (e) {\n  var el = e.target;\n  switch (el.dataset.action) { case 'go': go(); break; }\n});" }]), /closest/));
  ok('control: `=== ` form is read as a handler',
    checkPage('ctl', '<input data-action="sync">', [{ name: 'p.js', src: "document.addEventListener('input', (e) => {\n  const el = e.target.closest('[data-action]');\n  if (el && el.dataset.action === 'sync') s();\n});" }]).problems.length === 0);
  ok('control: non-bubbling error listener without capture → reported',
    has(checkPage('ctl', '', [{ name: 'p.js', src: "document.addEventListener('error', function (e) { f(e.target); });" }]), /'error'.*capture/));
  ok('control: …and with capture `true` it is accepted',
    checkPage('ctl', '', [{ name: 'p.js', src: "document.addEventListener('error', function (e) { f(e.target); }, true);" }]).problems.length === 0);
  ok('control: a `)` / `}` inside a string does not end the handler early',
    checkPage('ctl', '<button data-action="go">', [{ name: 'p.js', src: W('click', "    case 'go': t(')}'); go(); break;") }]).problems.length === 0);
  const dead = checkPage('ctl', '<button data-action="go">', [good]).used.get('p.js');
  ok('control: a case no markup uses is marked unused', dead && dead.get('pick') === false && dead.get('go') === true);

  const page = (body) => `<html><head>${body}</head><body></body></html>`;
  const tagsOf = (h) => scriptTags('/x/admin-panel/x.html', h).map((t) => ({ ...t, file: t.src }));
  const own = (f) => /^\/admin\/js\/|^\/js\/pages\//.test(f);
  const redir = (f) => /payments-redirect/.test(f);
  const trail = (f) => /public-shell/.test(f);
  const order = (h) => checkOrder('ctl', h, tagsOf(h), own, redir, trail);
  ok('control: public page script before the shell is accepted',
    order(page('<script src="/js/auth.js"></script><script src="/js/pages/x.js"></script><script src="/js/public-shell.js"></script>')).length === 0);
  ok('control: public page script moved below the shell → reported',
    order(page('<script src="/js/public-shell.js"></script><script src="/js/pages/x.js"></script>')).some((x) => /AFTER shell/.test(x)));
  ok('control: classic order is accepted', order(page('<script src="/admin/api.js"></script><script src="/admin/js/x.js"></script>')).length === 0);
  ok('control: defer → reported', order(page('<script src="/admin/js/x.js" defer></script>')).some((x) => /defer/.test(x)));
  ok('control: type="module" → reported', order(page('<script type="module" src="/admin/js/x.js"></script>')).some((x) => /type/.test(x)));
  ok('control: async → reported', order(page('<script async src="/admin/settings-common.js"></script>')).some((x) => /async/.test(x)));
  ok('control: page script above a library → reported',
    order(page('<script src="/admin/js/x.js"></script><script src="/js/vendor/chart.js"></script>')).some((x) => /BEFORE shared/.test(x)));
  ok('control: redirect after a stylesheet → reported',
    order(page('<link rel="stylesheet" href="/a.css"><script src="/admin/js/payments-redirect.js"></script>')).some((x) => /after a stylesheet/.test(x)));
  ok('control: redirect first in <head> is accepted',
    order(page('<script src="/admin/js/payments-redirect.js"></script><link rel="stylesheet" href="/a.css">')).length === 0);
}

console.log(`\n${failed === 0 ? 'ALL PASS' : 'FAILURES'} — ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
