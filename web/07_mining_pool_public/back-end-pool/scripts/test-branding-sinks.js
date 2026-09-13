// Credential-page sink test — audit §J1-1.
//
// public_html/js/branding.js injects operator-authored content into every public page, and
// applyAnalytics() deliberately re-creates <script> nodes out of custom_head_html via
// cloneScript() SO THAT THEY EXECUTE. login.html loads branding.js and carries the admin
// password and TOTP fields, so that combination turned "write the analytics settings section"
// into "keylog the admin login form" — a route from a secureAdmin session to freshAdmin.
//
// The settings route is now step-up gated for those keys (test-admin-guards.js), and
// branding.js additionally refuses to apply the sinks on a credential page. This test pins the
// second half.
//
// No jsdom in this project and none is worth adding, so the harness runs branding.js against a
// minimal DOM shim. That is only trustworthy WITH A CONTROL: every negative assertion below is
// paired with the same injection on a non-credential page, which MUST succeed. If the control
// fails, the shim is too thin and the negative result means nothing — so the control failing is
// itself a test failure, not a skip.
//
// Run: node scripts/test-branding-sinks.js
const path = require('path');
const fs = require('fs');
const vm = require('vm');

const SRC = path.resolve(__dirname, '../../public_html/js/branding.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name} ${extra}`); }
};

// ── minimal DOM shim ─────────────────────────────────────────────────────────
function makeEl(tag) {
  const el = {   // NB `el` is referenced by style.setProperty below — declared before use at call time
    tagName: String(tag).toUpperCase(),
    children: [], childNodes: [], attrs: {}, _vars: {},
    style: { setProperty(k, v) { el._vars[k] = v; }, cssText: '' },
    classList: { add() {}, remove() {}, contains: () => false },
    textContent: '', _html: '',
    set innerHTML(v) { this._html = v; this.childNodes = parseNodes(v); },
    get innerHTML() { return this._html; },
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; },
    appendChild(c) { this.children.push(c); this.childNodes.push(c); return c; },
    insertBefore(c) { this.children.unshift(c); return c; },
    removeChild() {}, remove() {}, addEventListener() {},
    querySelector: () => null, querySelectorAll: () => [],
    focus() {}, blur() {},
  };
  return el;
}
// Enough parsing to turn "<script>x</script>" into a SCRIPT node — that is the sink under test.
function parseNodes(html) {
  const out = [];
  const re = /<(\w+)[^>]*>([\s\S]*?)<\/\1>|<(\w+)[^>]*\/?>/g;
  let m;
  while ((m = re.exec(String(html))) !== null) {
    const tag = m[1] || m[3];
    const el = makeEl(tag);
    if (m[2]) el.textContent = m[2];
    out.push(el);
  }
  return out;
}

function makeDom(pageKey, attrExempt) {
  const head = makeEl('head');
  const body = makeEl('body');
  const documentElement = makeEl('html');
  documentElement.setAttribute('data-page', pageKey);
  if (attrExempt) documentElement.setAttribute('data-untrusted-html', 'exempt');
  const document = {
    documentElement, head, body, readyState: 'complete',
    createElement: makeEl,
    createTextNode: (t) => ({ textContent: t }),
    getElementsByTagName: (t) => (t === 'head' ? [head] : []),
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
  };
  return { document, head, body, documentElement };
}

// Injected settings: one of every sink §J1-1 identified.
const CFG = {
  connection: { network: 'testnet' },
  branding: {
    custom_css: '.pwned{color:red}',
    font_url: 'https://attacker.example/f.css',
    font_family: 'x;}body:after{content:"pwned"}',
    // Passes pool-settings.js's custom_theme validator (no url(), no <>, ≤200 chars) and is
    // still a working attack on a login form: paint the ink the same colour as the ground and
    // the 2FA prompt is gone. That is why it belongs behind isCredentialPage() (audit §J15-5).
    custom_theme: { text: '#101010', bg: '#101010', 'pwned-marker': '#123456' },
    accent_color: '#00ff00',
  },
  analytics: {
    provider: 'ga4',
    ga_tracking_id: 'G-PWNED',
    custom_head_html: '<script>window.__PWNED_HEAD=1;</script>',
    custom_body_html: '<script>window.__PWNED_BODY=1;</script>',
  },
  maintenance: { enabled: false },
  // Banners render on EVERY page (renderBanners appends straight to <body>, it needs no page
  // hook), so this is the operator sink that reaches login.html even after J1-1.
  announcements: [
    { id: 'b1', type: 'news', message: 'hello', link: 'javascript:window.__PWNED_LINK=1', link_text: 'click' },
    { id: 'b2', type: 'news', message: 'ok', link: 'https://good.example/notice', link_text: 'real' },
    { id: 'b3', type: 'news', message: 'mixed', link: 'JaVaScRiPt:alert(1)', link_text: 'case' },
    { id: 'b4', type: 'news', message: 'tab', link: 'java	script:alert(1)', link_text: 'tab' },
  ],
  incentives: {},
  seo: {}, pages: [],
};

// Run branding.js in a fresh context for one page key, and report what reached head/body.
//
// branding.js is an IIFE that exposes nothing, so it is driven through its REAL entry point:
// load() fetches /api/public/branding and hands the payload to apply(). Serving the config from
// the stubbed fetch exercises the actual path rather than a hook added for the test.
async function runFor(pageKey, attrExempt, cfgOverride) {
  const { document, head, body, documentElement } = makeDom(pageKey, attrExempt);
  let fetched = false;
  const sandbox = {
    document,
    window: null,
    location: { pathname: `/${pageKey}.html`, href: `https://pool.example/${pageKey}.html`, search: '' },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    navigator: { userAgent: 'test' },
    console,
    setTimeout, clearTimeout, Promise,
    fetch: () => { fetched = true; return Promise.resolve({ ok: true, json: () => Promise.resolve({ data: cfgOverride || CFG }) }); },
    matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
    // A fresh vm context carries ECMAScript intrinsics only - URL is a Node global, not
    // one of them. safeHref() parses with it, so without this every link would be
    // rejected by the catch and the J1-9 negatives would pass for the wrong reason.
    URL,
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(SRC, 'utf8'), sandbox, { filename: 'branding.js' });

  // Let the fetch .then chain settle.
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
  if (!fetched) return { unreachable: true, head, body };

  const tagsIn = (el) => el.children.map((c) => c.tagName);
  // Banner anchors sit at body > stack > bar > a, so a top-level scan would miss them and
  // every J1-9 assertion below would pass vacuously.
  const walk = (el, out = []) => {
    (el.children || []).forEach((c) => {
      out.push([c.tagName, c.textContent || '', (c.attrs && c.attrs.href) || '', c.href || '', c.src || ''].join('|'));
      walk(c, out);
    });
    return out;
  };
  // href can arrive either way: setLinkRel() uses setAttribute, the font <link> assigns the
  // .href PROPERTY. Read both — reading only attrs made the font_url control silently miss.
  const textIn = (el) => el.children
    .map((c) => [c.textContent || '', (c.attrs && c.attrs.href) || '', c.href || '', c.src || ''].join('|'))
    .join('~');
  return {
    unreachable: false,
    headTags: tagsIn(head), bodyTags: tagsIn(body),
    headText: textIn(head), bodyText: textIn(body),
    deep: walk(head).concat(walk(body)).join('~'),
    // applyTheme() writes every custom_theme entry with style.setProperty() onto BOTH
    // <html> and <body>, so both are read — checking only one would let a half-fix pass.
    cssVars: Object.assign({}, documentElement._vars, body._vars),
    // Raw innerHTML of everything under <body>, for the maintenance-overlay assertion.
    bodyHtml: body.children.map((c) => c.innerHTML || '').join('~'),
  };
}

async function main() {
  console.log('\n[1] CONTROL — a non-credential page still gets every sink');
  const home = await runFor('home');
  if (home.unreachable) {
    console.log('  FAIL  CONTROL: branding.js exposes no callable apply() — shim cannot drive it');
    console.log('\nFAILURES — the control could not run, so no negative result below is meaningful.\n');
    process.exit(1);
  }
  const homeHasScript = home.headTags.includes('SCRIPT') || home.bodyTags.includes('SCRIPT');
  ok('CONTROL: custom_head/body_html reaches the page as a SCRIPT node', homeHasScript,
    `head=${home.headTags} body=${home.bodyTags}`);
  ok('CONTROL: custom_css reaches the page as a STYLE node', home.headTags.includes('STYLE'),
    `head=${home.headTags}`);
  ok('CONTROL: font_url reaches the page as a LINK node', /attacker\.example/.test(home.headText),
    home.headText);
  ok('CONTROL: custom_theme reaches the page as CSS custom properties',
    home.cssVars['--pwned-marker'] === '#123456', JSON.stringify(home.cssVars));

  if (!homeHasScript || !home.headTags.includes('STYLE')) {
    console.log('\nFAILURES — the control did not inject, so the shim is too thin and the');
    console.log('negative assertions below would pass for the wrong reason.\n');
    process.exit(1);
  }

  console.log('\n[2] §J1-1 — the credential page gets NONE of them');
  const login = await runFor('login');
  ok('login: NO script node from custom_head_html/custom_body_html',
    !login.headTags.includes('SCRIPT') && !login.bodyTags.includes('SCRIPT'),
    `head=${login.headTags} body=${login.bodyTags}`);
  ok('login: no injected marker anywhere', !/__PWNED/.test(login.headText + login.bodyText));
  ok('login: NO operator custom_css style node', !/pwned/.test(login.headText), login.headText);
  ok('login: NO font_url stylesheet to an operator-chosen origin',
    !/attacker\.example/.test(login.headText), login.headText);
  ok('login: NO font_family style injection', !/content:"pwned"/.test(login.headText));
  ok('login: no analytics provider script (G-PWNED)', !/G-PWNED/.test(login.headText + login.bodyText));
  // audit J15-5 / J9-3's handed-over half. The custom_theme loop used to sit ABOVE the guard,
  // so this was the one operator-authored CSS sink still reaching the credential page.
  ok('login: NO custom_theme CSS custom properties (audit J15-5)',
    login.cssVars['--pwned-marker'] === undefined, JSON.stringify(login.cssVars));
  // accent_color travels through the same setVar() and is deliberately NOT gated - it is
  // regex-bound to /^#[0-9a-f]{6}$/, so it is a colour and nothing else. Pinned so a future
  // change that widens accent_color's validator has to come back and read this line.
  ok('CONTROL: accent_color still applies on the credential page (it is a colour, not a sink)',
    login.cssVars['--accent'] === '#00ff00', JSON.stringify(login.cssVars));

  console.log('\n[3] §J1-1 — the data-untrusted-html attribute exempts a page on its own');
  // Belt-and-braces for the CREDENTIAL_PAGES list: a future login-like page under a page key
  // branding.js does not know about is still protected if it declares the attribute.
  const attrOn = await runFor('some-new-signin-page', true);
  ok('attribute alone blocks the script sink',
    !attrOn.headTags.includes('SCRIPT') && !attrOn.bodyTags.includes('SCRIPT'),
    `head=${attrOn.headTags} body=${attrOn.bodyTags}`);
  ok('attribute alone blocks the CSS sinks',
    !/pwned|attacker\.example/.test(attrOn.headText), attrOn.headText);
  // ...and the SAME page without the attribute must inject, or the two above are vacuous.
  const attrOff = await runFor('some-new-signin-page', false);
  ok('CONTROL: the same page without the attribute DOES inject',
    attrOff.headTags.includes('SCRIPT') || attrOff.bodyTags.includes('SCRIPT'),
    `head=${attrOff.headTags} body=${attrOff.bodyTags}`);

  console.log('');
  console.log('[4] J1-9 - an operator banner link may only be http(s)');
  // Banners are NOT gated by isCredentialPage: a maintenance notice is exactly the thing an
  // operator wants on the login page. So the guard has to be the scheme check, on every page.
  for (const page of ['home', 'login']) {
    const r = await runFor(page);
    // Control first: without a legitimate link surviving, the rejections below prove nothing.
    ok(`${page}: CONTROL an https banner link DOES render as an anchor`,
      /good\.example/.test(r.deep), r.deep);
    ok(`${page}: javascript: banner link rejected`, !/javascript:/i.test(r.deep), r.deep);
    ok(`${page}: mixed-case + tab-split javascript: rejected`,
      !/alert\(1\)/.test(r.deep) && !/__PWNED_LINK/.test(r.deep), r.deep);
  }
  console.log('');
  console.log('[5] J15-1 - the maintenance overlay message is TEXT, not markup');
  // notices.maintenance_message has no validator and is not in STEP_UP_SETTINGS_KEYS, and
  // `notices` is not a step-up SECTION - so it was the last operator-authored raw-HTML sink
  // still at plain secureAdmin. It renders on the eleven public pages that are not
  // data-maintenance="exempt", i.e. every page except login and account-settings.
  const MAINT_CFG = Object.assign({}, CFG, {
    maintenance: {
      enabled: true,
      title: 'Back soon',
      message: 'Back at 14:00 <img src=x onerror="window.__PWNED_MAINT=1"> UTC',
    },
  });
  const maint = await runFor('home', false, MAINT_CFG);
  // Control FIRST: if the overlay did not render at all, the negatives below are vacuous.
  ok('CONTROL: the maintenance overlay rendered', /Back at 14:00/.test(maint.bodyHtml),
    maint.bodyHtml.slice(0, 200));
  ok('maintenance message is escaped - no live <img> tag',
    !/<img/i.test(maint.bodyHtml), maint.bodyHtml.slice(0, 200));
  // The literal string "onerror=" survives as TEXT, which is the point - what must not exist
  // is a TAG carrying it. Match the tag, not the substring, or this assertion can only pass by
  // the message being dropped rather than escaped.
  ok('maintenance message is escaped - no tag carries the onerror handler',
    !/<[a-z][^>]*onerror/i.test(maint.bodyHtml), maint.bodyHtml.slice(0, 240));
  ok('CONTROL: the escaped form is present (proves it was escaped, not dropped)',
    /&lt;img/.test(maint.bodyHtml), maint.bodyHtml.slice(0, 200));

  console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('\nHARNESS ERROR:', err && err.stack);
  process.exit(1);
});
