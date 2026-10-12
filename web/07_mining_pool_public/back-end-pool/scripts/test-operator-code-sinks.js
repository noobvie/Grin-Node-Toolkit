// Operator-code sinks — design §19.17 D22 (Option B, Part C1) and threat note #22 (§19.13).
//
// D22: no operator-authored code runs on the pool origin. The `code` ad type and the
// analytics custom_head_html / custom_body_html sinks were DELETED, not filtered (`<img
// onerror>` runs code, so a sanitiser would be a second thing to get right forever).
// Analytics stays as provider-ID loaders only. C7 closed D22-4, the one sink D22's text missed
// (the CMS page/post bodies), by sandboxing them (js/cms-frame.js). This file pins all of it:
//
//   [1] STATIC — every place in public_html + play/shell that creates a <script> (or an
//       <iframe>) is on an explicit allowlist, keyed by the function it sits in, and each
//       allowlisted function still carries the guard that makes it safe. A NEW script creator
//       anywhere fails here until someone reviews it and lists it. C7 listed three: the
//       chat-bubble loader (branding.js), the bubble's own dependency loader (games tree) and
//       the CMS body frame (cms-frame.js, srcdoc with NO allow-scripts).
//   [2] STATIC — the idioms that turn a string into code (document.write, srcdoc,
//       insertAdjacentHTML, outerHTML=, new Function, eval, createContextualFragment, an
//       on* attribute set from script) appear nowhere — srcdoc once, in the sandboxed CMS
//       frame, with its sandbox pinned token by token — and the deleted sinks' names are gone
//       from the code. Plus an innerHTML RATCHET: the count per file is pinned, so a new
//       innerHTML assignment fails until it is reviewed and the table updated.
//   [3] BEHAVIOUR — lib/ads.js against a throwaway DB: a code ad cannot be created or edited,
//       a legacy one is never served or counted and never leaves the module, and an ad URL
//       must be a site path or http(s).
//   [4] BEHAVIOUR — lib/pool-settings.js: the custom-HTML keys refuse writes, a legacy stored
//       row never comes back out (admin GET or public payload), and every analytics value that
//       reaches a <script> is pattern-checked on write AND on publish.
//   [5] BEHAVIOUR — public_html/js/ads.js in a DOM shim: a code ad, a javascript: link and a
//       '/\host' link draw nothing executable or off-site; real banners and text cards render.
//   [6] BEHAVIOUR — public_html/js/branding.js in a DOM shim: the chat-bubble loader appends
//       /play/version.js then /play/js/chat-bubble.js?v=<stamp> ONLY for games chat on + mode on
//       (or preview with this browser's grin_play_preview flag), never on an exempt or login
//       page, never in maintenance; a bad stamp is never spliced into the URL.
//
// Run: node scripts/test-operator-code-sinks.js
const path = require('path');
const fs = require('fs');
const os = require('os');
const vm = require('vm');
const { readPageSource } = require('./lib/page-source');

const APP = path.resolve(__dirname, '..');
const WEB = path.resolve(APP, '..');
const PUB = path.join(WEB, 'public_html');
const SHELL = path.join(WEB, 'play', 'shell');

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name} ${extra}`); }
};

// ── helpers ────────────────────────────────────────────────────────────────
// Strip JS comments without eating strings or regex literals (ads.js has /"/g, branding.js
// has URLs with '//'). A '/' opens a regex when the previous significant character cannot
// end an expression — good enough for this codebase, and a mis-read only makes the scan
// STRICTER (a regex read as code), never laxer.
function stripComments(src) {
  let out = '', i = 0, prev = '';
  const n = src.length;
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (c === '/' && d === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; out += ' '; continue; }
    if (c === '/' && d === '/') { const e = src.indexOf('\n', i); i = e < 0 ? n : e; continue; }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < n && src[j] !== c) { if (src[j] === '\\') j++; j++; }
      out += src.slice(i, j + 1); i = j + 1; prev = c; continue;
    }
    if (c === '/' && (prev === '' || /[(,=:[!&|?{};+\-*%<>~^]/.test(prev) ||
        /\b(return|typeof|case|in|of)\s*$/.test(out.slice(-8)))) {
      let j = i + 1, cls = false;
      while (j < n && src[j] !== '\n') {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === '[') cls = true; else if (src[j] === ']') cls = false;
        else if (src[j] === '/' && !cls) break;
        j++;
      }
      out += src.slice(i, j + 1); i = j + 1; prev = '/'; continue;
    }
    out += c;
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return out;
}

// Every JS unit a browser runs from these trees: .js files, and the inline <script> blocks
// (no src) of .html files. Vendored code is excluded with its reason; see [1].
function collectUnits() {
  const units = [];
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      const rel = path.relative(WEB, p).split(path.sep).join('/');
      if (ent.isDirectory()) {
        if (rel === 'public_html/js/vendor') continue; // Quill: admin CMS editor only — asserted below
        walk(p);
      } else if (ent.name.endsWith('.js')) {
        units.push({ file: rel, code: stripComments(fs.readFileSync(p, 'utf8')) });
      } else if (ent.name.endsWith('.html')) {
        const html = fs.readFileSync(p, 'utf8');
        const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
        let m, k = 0;
        while ((m = re.exec(html)) !== null) {
          if (/type=["']application\/ld\+json/i.test(m[0])) continue; // data block, never run
          units.push({ file: `${rel}#inline${k++}`, code: stripComments(m[1]) });
        }
      }
    }
  };
  walk(PUB);
  walk(SHELL);
  return units;
}

// The named function enclosing offset `at`: the nearest preceding `function NAME(`.
function enclosingFn(code, at) {
  const re = /function\s+([A-Za-z0-9_$]+)\s*\(/g;
  let m, name = '(top level)';
  while ((m = re.exec(code)) !== null && m.index < at) name = m[1];
  return name;
}
// The body of `function NAME(` up to the next function declaration at the same file level.
function fnBody(code, name) {
  const at = code.search(new RegExp(`function\\s+${name}\\s*\\(`));
  if (at < 0) return '';
  const rest = code.slice(at + 1);
  const next = rest.search(/\n\s{0,4}function\s+[A-Za-z0-9_$]+\s*\(/);
  return next < 0 ? code.slice(at) : code.slice(at, at + 1 + next);
}

const units = collectUnits();

// ═══ [1] script / iframe creators — explicit allowlist ═══════════════════════
console.log('\n[1] every <script>/<iframe> creator is allowlisted, by function, with its guard');
// file → function → { n: occurrences, guard: regex the function body must still match, why }
const SCRIPT_CREATORS = {
  'public_html/js/branding.js': {
    injectStructuredData: { n: 1, guard: /s\.type = 'application\/ld\+json';[\s\S]*s\.textContent = JSON\.stringify\(ld\)/,
      why: 'JSON-LD data block — a non-executing type, filled with textContent' },
    loadGa4: { n: 1, guard: /if \(typeof id !== 'string' \|\| !GA_ID_RE\.test\(id\)\) return;/,
      why: 'GA4 loader only (F6: the init is direct JS, no inline script) — id must match GA_ID_RE first' },
    loadPlausible: { n: 1, guard: /httpsScriptUrl\(a\.plausible_src\)[\s\S]*PLAUSIBLE_DOMAIN_RE\.test/,
      why: 'Plausible loader — https URL + domain pattern' },
    loadUmami: { n: 1, guard: /httpsScriptUrl\(a\.umami_src\)[\s\S]*UMAMI_ID_RE\.test/,
      why: 'Umami loader — https URL + id pattern' },
    loadMatomo: { n: 1, guard: /httpsScriptUrl\(a\.matomo_url\)[\s\S]*MATOMO_SITE_RE\.test/,
      why: 'Matomo loader — https URL + numeric site id' },
  },
  'public_html/js/public-shell.js': {
    mount: { n: 1, guard: /s\.src = '\/js\/ads\.js';/, why: 'the ads renderer, a fixed same-origin path' },
  },
};
// C7 (design §19.17.7): the chat-bubble loader. It lives in branding.js, where the payload
// lands — not public-shell.js as this file once guessed: the decision needs cfg.games.
SCRIPT_CREATORS['public_html/js/branding.js'].loadChatBubble = {
  n: 2, guard: /isCredentialPage\(\) \|\| !chatBubbleWanted\(cfg\)\) return;[\s\S]*v\.src = PLAY_VERSION_SRC;[\s\S]*s\.src = CHAT_BUBBLE_SRC \+ \(typeof ver === 'string' && PLAY_VERSION_RE\.test\(ver\) \? '\?v=' \+ ver : ''\);/,
  why: 'the chat-bubble loader — two FIXED same-origin paths (/play/version.js, /play/js/chat-bubble.js), the stamp pattern-checked, never on a credential/exempt page',
};
// The bubble itself (games tree) fetches its two dependencies, from a fixed list, lazily.
SCRIPT_CREATORS['play/shell/js/chat-bubble.js'] = {
  loadDeps: { n: 1, guard: /need\.push\('play-api\.js'\);[\s\S]*need\.push\('play-chat-core\.js'\);[\s\S]*s\.src = '\/play\/js\/' \+ name \+ QS;/,
    why: 'the bubble\'s two dependencies — fixed names under /play/js/, the stamp the bubble itself was loaded with' },
};
const IFRAME_CREATORS = {
  'play/shell/js/frame-host.js': {
    create: { n: 1, guard: /setAttribute\('sandbox', 'allow-scripts'\)/,
      why: 'the game frame — sandboxed without allow-same-origin, src is /play/games/<id>/frame/' },
  },
  // D22-4, closed in C7 (operator's choice: sandbox, not sanitise): a CMS page / post body.
  'public_html/js/cms-frame.js': {
    mount: { n: 1, guard: /f\.setAttribute\('sandbox', SANDBOX\);[\s\S]*f\.srcdoc = /,
      why: 'a CMS body — srcdoc in a frame sandboxed WITHOUT allow-scripts (the sandbox is set before srcdoc)' },
  },
};

function checkCreators(tagRe, table, label) {
  const found = {};
  for (const u of units) {
    let m;
    const re = new RegExp(`createElement\\(\\s*['"]${tagRe}['"]\\s*\\)`, 'gi');
    while ((m = re.exec(u.code)) !== null) {
      const fn = enclosingFn(u.code, m.index);
      const key = `${u.file} :: ${fn}`;
      found[key] = (found[key] || 0) + 1;
    }
  }
  const expected = {};
  for (const [file, fns] of Object.entries(table)) {
    for (const [fn, spec] of Object.entries(fns)) expected[`${file} :: ${fn}`] = spec.n;
  }
  const unlisted = Object.keys(found).filter((k) => !(k in expected));
  ok(`no unlisted ${label} creator anywhere in public_html or play/shell`, unlisted.length === 0,
    '\n      ' + unlisted.map((k) => `${k} ×${found[k]}`).join('\n      '));
  for (const [key, n] of Object.entries(expected)) {
    ok(`${label} creator ${key} — exactly ${n}`, found[key] === n, `found ${found[key] || 0}`);
  }
  for (const [file, fns] of Object.entries(table)) {
    const unit = units.find((u) => u.file === file);
    for (const [fn, spec] of Object.entries(fns)) {
      const body = unit ? fnBody(unit.code, fn) : '';
      ok(`${file} ${fn}() keeps its guard (${spec.why})`, spec.guard.test(body));
    }
  }
}
checkCreators('script', SCRIPT_CREATORS, '<script>');
checkCreators('iframe', IFRAME_CREATORS, '<iframe>');

// The vendored editor is excluded from the scan ONLY because no public page loads it.
const publicPages = fs.readdirSync(PUB).filter((f) => f.endsWith('.html'));
const quillUsers = publicPages.filter((f) => /vendor\/quill/.test(fs.readFileSync(path.join(PUB, f), 'utf8')));
ok('vendored Quill (excluded from the scan) is loaded by no public page', quillUsers.length === 0, quillUsers.join(','));

// ═══ [2] string-to-code idioms + the innerHTML ratchet ═════════════════════════
console.log('\n[2] no string-to-code idiom, no trace of the deleted sinks, innerHTML pinned per file');
const FORBIDDEN = [
  [/document\.write(ln)?\s*\(/, 'document.write'],
  [/\.insertAdjacentHTML\s*\(/, 'insertAdjacentHTML'],
  [/\.outerHTML\s*\+?=(?!=)/, 'outerHTML assignment'],
  [/\bsrcdoc\b/, 'srcdoc'],
  [/createContextualFragment\s*\(/, 'createContextualFragment'],
  [/\bnew\s+Function\s*\(/, 'new Function'],
  [/(^|[^.\w])eval\s*\(/, 'eval('],
  [/setAttribute\(\s*['"]on[a-z]+['"]/i, 'setAttribute("on…")'],
  [/set(Timeout|Interval)\(\s*['"`]/, 'setTimeout/setInterval with a string'],
  // The deleted sinks (D22) — their names must not come back as code.
  [/\bcloneScript\b/, 'cloneScript'],
  [/\bactivateScripts\b/, 'activateScripts'],
  [/\bcustom_head_html\b/, 'custom_head_html'],
  [/\bcustom_body_html\b/, 'custom_body_html'],
  [/\bhtml_code\b/, 'html_code'],
];
// ONE reviewed exception: srcdoc in js/cms-frame.js, the CMS body frame (D22-4). Its safety is
// the sandbox, pinned below — not the string.
const SRCDOC_OK = 'public_html/js/cms-frame.js';
for (const [re, label] of FORBIDDEN) {
  const hits = units.filter((u) => re.test(u.code) && !(label === 'srcdoc' && u.file === SRCDOC_OK)).map((u) => u.file);
  ok(`no ${label} in public_html / play/shell code${label === 'srcdoc' ? ' (but the sandboxed CMS frame)' : ''}`, hits.length === 0, hits.join(', '));
}
{
  const cf = units.find((u) => u.file === SRCDOC_OK);
  const code = cf ? cf.code : '';
  const sb = /var SANDBOX = '([^']*)';/.exec(code);
  const tokens = sb ? sb[1].split(/\s+/).sort() : [];
  ok('cms-frame: the sandbox is EXACTLY allow-same-origin + popups(+escape) + top-navigation-by-user-activation',
    JSON.stringify(tokens) === JSON.stringify(['allow-popups', 'allow-popups-to-escape-sandbox', 'allow-same-origin', 'allow-top-navigation-by-user-activation']), sb && sb[1]);
  ok('cms-frame: "allow-scripts" appears nowhere in its code (with allow-same-origin it would undo the sandbox)',
    code.length > 0 && !/allow-scripts/.test(code));
  ok('cms-frame: no allow-forms / allow-modals / allow-downloads / allow-top-navigation (unconditional)',
    !/allow-(forms|modals|downloads|top-navigation(?!-by-user-activation))/.test(code));
  ok('cms-frame: exactly one srcdoc, one sandbox attribute, and the sandbox is set before srcdoc',
    (code.match(/\bsrcdoc\b/g) || []).length === 1 && (code.match(/setAttribute\('sandbox'/g) || []).length === 1
    && code.indexOf("setAttribute('sandbox'") < code.indexOf('srcdoc'));
  ok('cms-frame: no innerHTML — the body reaches the DOM only through the sandboxed srcdoc',
    !/\.innerHTML\b/.test(code));
}

// innerHTML assignments per file. EXACT, not "at most": any change to this table means
// someone looked at the line. All are fixed markup or escaped data (esc()/attr()/escapeText).
//
// CLOSED in C7 — D22-4, the CMS bodies (found in Part C1, confirmed by R1). They were
//   page.html → `page-body`.innerHTML = json.data.html   (lib/pages.js, operator HTML, raw)
//   post.html → `post-body`.innerHTML = p.body_html      (lib/posts.js, Quill HTML, raw)
// i.e. an `<img onerror>` in a body ran on the origin. The operator chose (2026-10-04) to
// SANDBOX them: both now go through js/cms-frame.js (srcdoc, no allow-scripts) — pinned below
// and in the srcdoc block above. page.html 3 → 2, post.html 4 → 3.
//
// blocks.html 4 → 7 (P-05 heatmap, 4ec39d3; reviewed 2026-10-10): `wrap.innerHTML = ''` (empty
// state), `wrap.innerHTML = html` (the weekday × hour table) and `summary.innerHTML` (busiest /
// quietest hour). No API text reaches any of them: labels are the HEAT_DAYS constants, every count
// goes through Number() || 0, hours are loop indexes, `expected` goes through fmtExpected().
//
// account-settings 20 (code-layout F1, 2026-10-10): the page's inline block moved byte-for-byte to
// js/pages/account-settings.js, so its row is re-keyed from `…html#inline0` — same 20 lines.
const INNER_HTML = {
  'public_html/js/pages/api-docs.js': 4,
  'public_html/js/pages/blocks.js': 7,
  'public_html/js/pages/blog.js': 3,
  'public_html/js/pages/donate.js': 5,
  'public_html/js/pages/fortune-board.js': 5,
  'public_html/js/ads.js': 1,
  'public_html/js/api.js': 1,
  'public_html/js/branding.js': 7,
  'public_html/js/network-map.js': 7,
  'public_html/js/pages/account-settings.js': 20,
  'public_html/js/payout-goblin.js': 3,
  'public_html/js/public-shell.js': 2,
  'public_html/js/public-theme.js': 4,
  'public_html/js/reactor-dashboard.js': 2,
  'public_html/js/stepup.js': 1,
  'public_html/js/pages/login.js': 6,
  'public_html/js/pages/miners-stats.js': 4,
  'public_html/js/pages/page.js': 2,
  'public_html/js/pages/payment-history.js': 7,
  'public_html/js/pages/post.js': 3,
};
const innerCount = {};
for (const u of units) {
  const n = (u.code.match(/\.innerHTML\s*\+?=(?!=)/g) || []).length;
  if (n) innerCount[u.file] = n;
}
const files = new Set([...Object.keys(INNER_HTML), ...Object.keys(innerCount)]);
const drift = [...files].filter((f) => (INNER_HTML[f] || 0) !== (innerCount[f] || 0))
  .map((f) => `${f}: pinned ${INNER_HTML[f] || 0}, found ${innerCount[f] || 0}`);
ok('innerHTML assignments match the pinned table exactly (review the line, then update it)',
  drift.length === 0, '\n      ' + drift.join('\n      '));
ok('play/shell assigns no innerHTML at all (Part 6 rule)',
  !Object.keys(innerCount).some((f) => f.startsWith('play/shell/')));
// D22-4 closed: each CMS body reaches the page only through CmsFrame.mount, and a missing
// cms-frame.js shows a sentence — never an innerHTML fallback.
const unitCode = (f) => (units.find((u) => u.file === f) || {}).code || '';
for (const [page, payload, wrap] of [['page.html', 'json.data.html', 'content'], ['post.html', 'p.body_html', 'post-body']]) {
  // F2: the page's script moved to js/pages/<page>.js (its key was `…html#inline0`). unitCode() answers ''
  // for a missing unit, which would make every "never assigns" check below pass on nothing — so require code.
  const code = unitCode(`public_html/js/pages/${page.replace(/\.html$/, '.js')}`);
  ok(`D22-4: ${page}'s script unit is found and non-empty (the checks below are not vacuous)`, code.length > 200);
  const html = readPageSource(path.join(PUB, page));
  ok(`D22-4 closed: ${page} never assigns the body (${payload}) as markup`,
    !new RegExp(`innerHTML\\s*=\\s*${payload.replace(/\./g, '\\.')}`).test(code) && !/\.body_html\s*;|data\.html\s*;/.test(code.replace(/showBody\([^)]*\)/g, '')));
  ok(`D22-4 closed: ${page} hands the body to the sandboxed frame (showBody → CmsFrame.mount)`,
    new RegExp(`showBody\\(document\\.getElementById\\('(page|post)-body'\\), ${payload.replace(/\./g, '\\.')}, '${wrap}',`).test(code)
    && /window\.CmsFrame\.mount\(host, html, \{ wrapClass: wrapClass, title: title \}\); return;/.test(code));
  const sbAt = code.indexOf('function showBody(host, html, wrapClass, title) {');
  const sbBody = sbAt < 0 ? '' : code.slice(sbAt, code.indexOf('\n      }', sbAt));
  ok(`D22-4 closed: ${page}'s fallback (no cms-frame.js) is a textContent sentence, not innerHTML`,
    /textContent = 'This (page|post) could not be shown\. Reload to try again\.';\s*host\.appendChild\([a-z]\);/.test(sbBody) && !/innerHTML/.test(sbBody), sbBody.slice(0, 200));
  ok(`D22-4 closed: ${page} loads /js/cms-frame.js before its own script`,
    /<script src="\/js\/cms-frame\.js"><\/script>\s*<script>/.test(html));
}

// ═══ [3] lib/ads.js behaviour ═══════════════════════════════════════════════
console.log('\n[3] lib/ads.js — the code type is gone end to end; ad URLs are site paths or http(s)');
const dbFile = path.join(os.tmpdir(), `pool-codesinks-${Date.now()}.sqlite`);
const { initDb, getDb, createSchema, closeDb } = require(path.join(APP, 'lib/db.js'));
initDb(dbFile);
const db = getDb();
createSchema();
const cleanup = () => {
  try { closeDb(); } catch (_) {}
  for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(dbFile + s); } catch (_) {} }
};

const throws = (fn, re) => { try { fn(); return false; } catch (e) { return re ? re.test(e.message) : true; } };

try {
  const AdsManager = require(path.join(APP, 'lib/ads.js'));
  const ads = new AdsManager({});

  // Control first: a plain banner must work, or every refusal below is vacuous.
  // is_active given explicitly: _clean() reads an omitted flag as 0 (off).
  const good = ads.create({ name: 'ok', placement: 'header', ad_type: 'banner', is_active: 1,
    image_url: '/promo/x.svg', link_url: '/donate.html', html_code: '<script>x</script>' });
  ok('CONTROL: a banner ad is created', good && good.id > 0 && good.ad_type === 'banner');
  const raw = db.prepare('SELECT html_code FROM ads WHERE id = ?').get(good.id);
  ok('html_code in a create body is ignored, not stored', raw && raw.html_code === null, JSON.stringify(raw));
  ok('the admin row carries no html_code key and removed=false',
    !('html_code' in good) && good.removed === false, JSON.stringify(good));

  ok('create ad_type "code" → refused, naming D22',
    throws(() => ads.create({ name: 'c', placement: 'header', ad_type: 'code', html_code: '<b>x</b>' }), /D22/));
  ok('update an ordinary ad TO "code" → refused, naming D22',
    throws(() => ads.update(good.id, { ad_type: 'code' }), /D22/));

  for (const [field, v] of [
    ['link_url', 'javascript:alert(1)'], ['link_url', ' JaVaScRiPt:alert(1)'], ['link_url', 'data:text/html,x'],
    ['link_url', '//evil.example/x'], ['link_url', '/\\evil.example'], ['link_url', 'https://u:p@evil.example/'],
    ['link_url', 'https://x.example/"onmouseover="y'], ['image_url', 'javascript:x'], ['image_url', 'data:image/svg+xml,<svg onload=x>'],
  ]) {
    ok(`${field} ${JSON.stringify(v)} → refused`,
      throws(() => ads.create({ name: 'u', placement: 'header', ad_type: 'banner', image_url: '/promo/x.svg', [field]: v })));
  }
  for (const v of ['', '#', '/fortune-board.html', 'https://grin.money/#why-grin', 'http://example.org/a?b=1']) {
    ok(`CONTROL: link_url ${JSON.stringify(v)} accepted`,
      !throws(() => ads.create({ name: 'u', placement: 'footer', ad_type: 'banner', image_url: '/promo/x.svg', link_url: v })));
  }

  // A legacy code row, as a pre-C1 pool would hold it: active, in window, in a placement.
  const legacyId = db.prepare(`INSERT INTO ads (name, placement, ad_type, html_code, is_active, weight)
    VALUES ('legacy', 'header', 'code', '<script>window.__PWNED_AD=1</script>', 1, 999)`).run().lastInsertRowid;
  const pub = ads.publicAll();
  const pubJson = JSON.stringify(pub);
  ok('a legacy code ad is never served (not in publicAll)', !pub.header.some((r) => r.id === legacyId), pubJson.slice(0, 200));
  ok('CONTROL: the banner beside it IS served', pub.header.some((r) => r.id === good.id));
  ok('no public row carries html_code, and the payload has no snippet', !/html_code|__PWNED_AD/.test(pubJson));
  ok('a legacy code ad accrues no impressions; CONTROL the banner does',
    ads.recordEvents({ impressions: [legacyId] }).impressions === 0 &&
    ads.recordEvents({ impressions: [good.id] }).impressions === 1);
  const listed = ads.list().find((r) => r.id === legacyId);
  ok('admin list shows it as removed, without its html_code',
    listed && listed.removed === true && !('html_code' in listed), JSON.stringify(listed));
  ok('admin list JSON never carries the snippet', !/__PWNED_AD/.test(JSON.stringify(ads.list())));
  ok('a legacy code ad cannot be edited, not even switched off',
    throws(() => ads.update(legacyId, { is_active: 0 }), /only be deleted/));
  ok('…but it can be deleted', ads.remove(legacyId) === true && ads.get(legacyId) === null);

  // The shipped seeds go through create(), so the URL rule must not break a fresh install.
  db.prepare('DELETE FROM ads').run();
  let seeded = false, seedErr = '';
  try { seeded = ads.seedSelfPromo(); } catch (e) { seedErr = e.message; }
  ok('CONTROL: the self-promo seed still inserts under the URL rule', seeded && ads.list().length > 0, seedErr);

  // ═══ [4] lib/pool-settings.js behaviour ═════════════════════════════════════
  console.log('\n[4] pool-settings — custom HTML refused + hidden; analytics values pattern-checked twice');
  const PoolSettings = require(path.join(APP, 'lib/pool-settings.js'));
  const ps = new PoolSettings(db);

  for (const key of ['custom_head_html', 'custom_body_html']) {
    ok(`updateSection refuses ${key}, naming D22`,
      throws(() => ps.updateSection('analytics', { [key]: '<b>x</b>' }, null), /D22/));
  }
  // Legacy rows exactly as a pre-C1 pool stored them.
  const putRow = db.prepare(`INSERT INTO pool_config (section, key, value, value_type) VALUES (?, ?, ?, 'string')
    ON CONFLICT(section, key) DO UPDATE SET value = excluded.value`);
  putRow.run('analytics', 'custom_head_html', '<script>window.__PWNED_CFG=1</script>');
  putRow.run('analytics', 'custom_body_html', '<img src=x onerror="window.__PWNED_CFG=2">');
  const sec = ps.getSection('analytics');
  ok('a stored legacy value never comes back out of getSection (the admin GET)',
    !('custom_head_html' in sec) && !('custom_body_html' in sec), Object.keys(sec).join(','));
  ok('…nor out of getAll()', !/__PWNED_CFG/.test(JSON.stringify(ps.getAll())));
  const cfg = ps.buildPublicConfig();
  ok('…nor into the public branding payload',
    !('custom_head_html' in cfg.analytics) && !/__PWNED_CFG/.test(JSON.stringify(cfg)), Object.keys(cfg.analytics).join(','));
  // A full-form save (the harvester posts every field) must still work beside the legacy rows.
  ok('CONTROL: an ordinary analytics save still succeeds with the legacy rows present',
    !throws(() => ps.updateSection('analytics', { provider: 'ga4', ga_tracking_id: 'G-ABC123' }, null)));

  const bad = [
    ['ga_tracking_id', "G-X',alert(1),'"], ['ga_tracking_id', 'G-ABC\\'], ['ga_tracking_id', 'UA-1234'],
    ['plausible_src', 'javascript:alert(1)'], ['plausible_src', 'data:text/javascript,x'], ['plausible_src', 'http://plausible.io/js/script.js'],
    ['umami_src', 'javascript:alert(1)'], ['matomo_url', 'javascript:alert(1)//'], ['matomo_url', 'https://u:p@stats.example/'],
    ['plausible_domain', 'a" onload="x'], ['umami_website_id', 'x" onload="y'], ['matomo_site_id', '1;x'],
  ];
  for (const [k, v] of bad) {
    ok(`write ${k}=${JSON.stringify(v)} → refused`, throws(() => ps.updateSection('analytics', { [k]: v }, null)));
  }
  const goodVals = { ga_tracking_id: 'G-ABC123', plausible_domain: 'pool.example,www.pool.example',
    plausible_src: 'https://plausible.io/js/script.js', umami_website_id: '1b2c3d4e-0000-1111-2222-333344445555',
    umami_src: 'https://cloud.umami.is/script.js', matomo_url: 'https://stats.pool.example/', matomo_site_id: '3' };
  ok('CONTROL: valid values for every analytics field are accepted',
    !throws(() => ps.updateSection('analytics', goodVals, null)));
  const pubGood = ps.buildPublicConfig().analytics;
  ok('CONTROL: valid stored values publish unchanged',
    Object.entries(goodVals).every(([k, v]) => pubGood[k] === v), JSON.stringify(pubGood));

  // Values stored BEFORE the validators were tightened (written straight to the table) must
  // publish as '' — the browser re-checks too, but the server must not hand them out.
  putRow.run('analytics', 'ga_tracking_id', "G-X',alert(1),'");
  putRow.run('analytics', 'plausible_src', 'javascript:window.__PWNED_SRC=1');
  putRow.run('analytics', 'umami_src', 'data:text/javascript,x');
  putRow.run('analytics', 'matomo_url', 'http://stats.pool.example/');
  putRow.run('analytics', 'plausible_domain', 'a" onload="x');
  putRow.run('seo', 'ga_tracking_id', 'G-ABC\\');   // the legacy seo fallback has no validator at all
  const pubBad = ps.buildPublicConfig().analytics;
  ok('legacy invalid analytics values publish as empty strings',
    pubBad.ga_tracking_id === '' && pubBad.plausible_src === '' && pubBad.umami_src === '' &&
    pubBad.matomo_url === '' && pubBad.plausible_domain === '', JSON.stringify(pubBad));
  putRow.run('seo', 'ga_tracking_id', 'G-LEGACY9');
  ok('CONTROL: a valid legacy seo.ga_tracking_id still publishes as the fallback',
    ps.buildPublicConfig().analytics.ga_tracking_id === 'G-LEGACY9');
} catch (e) {
  fail++;
  console.log(`  FAIL  harness error: ${e && e.stack}`);
} finally {
  cleanup();
}

// ═══ [5] public_html/js/ads.js renderer ═════════════════════════════════════
console.log('\n[5] js/ads.js — nothing executable or off-site comes out of an ad payload');
async function renderAds(list) {
  const slot = {
    _html: '', style: {}, classList: { add() {}, remove() {}, contains: () => false },
    set innerHTML(v) { this._html = String(v); }, get innerHTML() { return this._html; },
    getAttribute: (k) => (k === 'data-ad-slot' ? 'in-content' : null),
    querySelector: () => null, querySelectorAll: () => [], addEventListener() {},
  };
  const sandbox = {
    document: { querySelectorAll: (s) => (s === '[data-ad-slot]' ? [slot] : []), hidden: false },
    window: null,
    matchMedia: () => ({ matches: true }),
    sessionStorage: { getItem: () => null, setItem() {} },
    navigator: {}, Blob: function () {}, console, setTimeout, clearTimeout, setInterval, clearInterval,
    fetch: (url) => Promise.resolve({ ok: true, json: () => Promise.resolve(
      url === '/api/public/ads' ? { ads: { 'in-content': list }, rotate_ms: 8000 } : {}) }),
  };
  sandbox.window = sandbox;
  sandbox.window.matchMedia = sandbox.matchMedia;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(PUB, 'js/ads.js'), 'utf8'), sandbox, { filename: 'ads.js' });
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
  return slot.innerHTML;
}

// Run the real branding.js against a payload in a permissive DOM shim and report the src of
// every <script> it appends, in order. Every section of apply() is in its own try/catch, so
// a shim gap there is swallowed — only the loader's own appends are observed. version.js is
// "loaded" by firing its load (or error) listener after setting window.GRIN_PLAY_VERSION.
async function runLoader(payload, o, okVer) {
  const appended = [];
  const byId = {};
  const noop = () => {};
  const mkEl = (tag) => {
    const listeners = {};
    const e = {
      tagName: String(tag).toUpperCase(), style: { setProperty: noop, removeProperty: noop }, dataset: {},
      classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
      children: [], childNodes: [], attributes: {},
      setAttribute(k, v) { this.attributes[k] = String(v); if (k === 'id') byId[v] = this; },
      getAttribute(k) { return k in this.attributes ? this.attributes[k] : null; },
      removeAttribute(k) { delete this.attributes[k]; },
      addEventListener(t, fn) { (listeners[t] = listeners[t] || []).push(fn); },
      removeEventListener: noop, appendChild(c) { this.children.push(c); return c; },
      insertBefore(c) { return c; }, remove: noop, querySelector: () => null, querySelectorAll: () => [],
      closest: () => null, _fire(t) { (listeners[t] || []).forEach((fn) => fn({ type: t })); },
    };
    Object.defineProperty(e, 'id', { get() { return this.attributes.id || ''; }, set(v) { this.setAttribute('id', v); } });
    return e;
  };
  const html = mkEl('html');
  if (o.exempt) html.setAttribute('data-untrusted-html', 'exempt');
  if (o.page) html.setAttribute('data-page', o.page);
  const body = mkEl('body');
  body.appendChild = (c) => { if (c.tagName === 'SCRIPT') appended.push(c); return c; };
  body.insertBefore = (c) => c;
  const head = mkEl('head');
  const store = Object.assign({}, o.storage || {});
  const storage = o.storageThrows
    ? { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); }, removeItem() { throw new Error('denied'); } }
    : { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } };
  const document = {
    documentElement: html, body, head, readyState: 'complete', title: '',
    createElement: mkEl, createTextNode: () => mkEl('#text'),
    getElementById: (id) => byId[id] || null,
    querySelector: () => null, querySelectorAll: () => [], getElementsByTagName: (t) => (t === 'head' ? [head] : []),
    addEventListener: noop, removeEventListener: noop,
  };
  const sb = {
    document, console, setTimeout, clearTimeout, setInterval, clearInterval, URL, URLSearchParams,
    location: { pathname: o.page === 'login' ? '/login.html' : '/index.html', search: '', hash: '', origin: 'https://pool.example', href: 'https://pool.example/index.html', hostname: 'pool.example' },
    localStorage: storage, sessionStorage: storage,
    navigator: { userAgent: 'test' }, MutationObserver: function () { return { observe: noop, disconnect: noop }; },
    matchMedia: () => ({ matches: false, addEventListener: noop, addListener: noop }),
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    fetch: (url) => Promise.resolve({ ok: true, json: () => Promise.resolve(url === '/api/public/branding' ? { data: payload } : {}) }),
    addEventListener: noop, removeEventListener: noop,
  };
  sb.window = sb;
  vm.createContext(sb);
  vm.runInContext(fs.readFileSync(path.join(PUB, 'js/branding.js'), 'utf8'), sb, { filename: 'branding.js' });
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
  const v = appended.find((s) => s.src === '/play/version.js');
  if (v) {
    if (!o.versionError) sb.GRIN_PLAY_VERSION = o.version !== undefined ? o.version : okVer;
    v._fire(o.versionError ? 'error' : 'load');
  }
  return appended.map((s) => s.src);
}

(async () => {
  try {
    const html = await renderAds([
      { id: 1, ad_type: 'code', html_code: '<script>window.__PWNED_R=1</script><img src=x onerror="window.__PWNED_R=2">' },
      { id: 2, ad_type: 'banner', image_url: '/promo/ok.svg', link_url: 'javascript:window.__PWNED_R=3' },
      { id: 3, ad_type: 'text', headline: 'Hi', link_url: '/\\evil.example' },
      { id: 4, ad_type: 'banner', image_url: 'javascript:window.__PWNED_R=4', link_url: '/donate.html' },
      { id: 5, ad_type: 'text', headline: 'Grin', cta_label: 'Go', link_url: '//evil.example/' },
      // Controls.
      { id: 6, ad_type: 'banner', image_url: '/promo/good.svg', link_url: '/fortune-board.html', alt_text: 'a"b' },
      { id: 7, ad_type: 'text', headline: 'WHY GRIN?', link_url: 'https://grin.money/' },
    ]);
    ok('CONTROL: a site-path banner renders as a linked image',
      /<img src="\/promo\/good\.svg"/.test(html) && /href="\/fortune-board\.html"/.test(html), html.slice(0, 300));
    ok('CONTROL: an https text card renders as a link', /href="https:\/\/grin\.money\/"/.test(html));
    ok('a code ad renders nothing: no snippet, no <script>, no onerror',
      !/__PWNED_R=1|__PWNED_R=2|<script|onerror/i.test(html) && !/data-ad-id="1"/.test(html), html.slice(0, 300));
    ok('a javascript: link_url becomes no link (the banner still shows, unlinked)',
      !/javascript:/i.test(html) && /data-ad-id="2"/.test(html));
    ok("'/\\host' and '//host' links become no link", !/evil\.example/.test(html));
    ok('a javascript: image_url draws no banner', !/data-ad-id="4"/.test(html));
    ok('alt text is attribute-escaped', /alt="a&quot;b"/.test(html));
  } catch (e) {
    fail++;
    console.log(`  FAIL  ads.js harness error: ${e && e.stack}`);
  }

  // ═══ [6] the chat-bubble loader (design §19.17.7, Part C7) ═══════════════════
  console.log('\n[6] branding.js loadChatBubble — the bubble loads only under the right flags, never on exempt pages');
  try {
    const OK_VER = 'abcdef012345';
    const cases = [
      ['games on + chat on → version.js, then the stamped bubble', { games: { mode: 'on', chat: true } }, {}, ['/play/version.js', `/play/js/chat-bubble.js?v=${OK_VER}`]],
      ['games on + chat OFF → nothing', { games: { mode: 'on', chat: false } }, {}, []],
      ['games off → nothing (the payload while the service is down)', { games: { mode: 'off', chat: false } }, {}, []],
      ['a payload with no games block → nothing', {}, {}, []],
      ['chat "true" as a string → nothing (exact boolean only)', { games: { mode: 'on', chat: 'true' } }, {}, []],
      ['preview, this browser never opened /play/ → nothing', { games: { mode: 'preview', chat: true } }, {}, []],
      ['preview + grin_play_preview=1 → loads', { games: { mode: 'preview', chat: true } }, { storage: { grin_play_preview: '1' } }, ['/play/version.js', `/play/js/chat-bubble.js?v=${OK_VER}`]],
      ['preview + a flag that is not "1" → nothing', { games: { mode: 'preview', chat: true } }, { storage: { grin_play_preview: 'yes' } }, []],
      ['preview + storage THROWS → nothing (a throw reads as "not set")', { games: { mode: 'preview', chat: true } }, { storageThrows: true }, []],
      ['on + storage throws → still loads (the flag is only for preview)', { games: { mode: 'on', chat: true } }, { storageThrows: true }, ['/play/version.js', `/play/js/chat-bubble.js?v=${OK_VER}`]],
      ['data-untrusted-html="exempt" (login.html, /play/) → nothing', { games: { mode: 'on', chat: true } }, { exempt: true }, []],
      ['page key "login" without the attribute → nothing', { games: { mode: 'on', chat: true } }, { page: 'login' }, []],
      ['maintenance mode → nothing', { games: { mode: 'on', chat: true }, maintenance: { enabled: true } }, {}, []],
      ['version.js fails to load → the bubble still loads, unstamped', { games: { mode: 'on', chat: true } }, { versionError: true }, ['/play/version.js', '/play/js/chat-bubble.js']],
      ['a version that is not 12 hex → unstamped (never spliced into the URL)', { games: { mode: 'on', chat: true } }, { version: '../x"><b' }, ['/play/version.js', '/play/js/chat-bubble.js']],
    ];
    for (const [label, payload, o, want] of cases) {
      const got = await runLoader(payload, o, OK_VER);
      ok(`loader: ${label}`, JSON.stringify(got) === JSON.stringify(want), JSON.stringify(got));
    }
  } catch (e) {
    fail++;
    console.log(`  FAIL  loader harness error: ${e && e.stack}`);
  }
  console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
})();
