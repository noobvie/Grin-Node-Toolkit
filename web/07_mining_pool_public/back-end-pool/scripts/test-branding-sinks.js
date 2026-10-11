// Credential-page sink test — audit §J1-1, plus design §19.17 D22 (Option B, Part C1).
//
// public_html/js/branding.js injects operator-authored content into every public page.
// Until Part C1, applyAnalytics() re-created <script> nodes out of custom_head_html /
// custom_body_html via cloneScript() SO THAT THEY EXECUTED; login.html loads branding.js and
// carries the admin password and TOTP fields, which turned "write the analytics settings
// section" into "keylog the admin login form". §J1-1 kept those sinks off credential pages;
// D22 then DELETED them, because with a sign-in form on every page no page is left to exempt.
//
// What this file pins now:
//   [1]–[3] the CSS sinks and the provider loader stay off credential pages (§J1-1);
//   [6]     a payload that still carries custom_head_html / custom_body_html (an old server,
//           a stale cache) injects NOTHING on ANY page — the render path is gone;
//   [7]     each provider loader builds its <script> only from a value that matches its
//           strict pattern — a GA id that could break out of the init text, or a javascript:,
//           data: or http: script URL, loads nothing.
// The static half (no new script creator anywhere in public_html) is
// test-operator-code-sinks.js.
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
    // LEGACY keys (design §19.17 D22): the server no longer sends them, but a stale payload
    // might. branding.js must ignore them on every page — [6] asserts it.
    custom_head_html: '<script>window.__PWNED_HEAD=1;</script><img src=x onerror="window.__PWNED_IMG=1">',
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
async function runFor(pageKey, attrExempt, cfgOverride, nav) {
  const { document, head, body, documentElement } = makeDom(pageKey, attrExempt);
  // nav = { href, referrer } — only the GA4 scrub assertions ([8]) need a non-default URL.
  const href = (nav && nav.href) || `https://pool.example/${pageKey}.html`;
  document.referrer = (nav && nav.referrer) || '';
  let fetched = false;
  const sandbox = {
    document,
    window: null,
    location: { pathname: `/${pageKey}.html`, href, search: new URL(href).search, origin: new URL(href).origin },
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
    // GA4's init (F6: direct JS, no inline script) — what gtag.js reads once it loads.
    dataLayer: sandbox.dataLayer, gtag: sandbox.gtag,
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
  // Since D22 the only script sink left is the provider loader, so it is the control: GA4 with
  // a valid id must reach a normal page, or every "no SCRIPT" assertion below is vacuous.
  const homeHasScript = home.headTags.includes('SCRIPT') || home.bodyTags.includes('SCRIPT');
  ok('CONTROL: the GA4 provider loader reaches the page as a SCRIPT node', homeHasScript &&
    /googletagmanager\.com\/gtag\/js\?id=G-PWNED/.test(home.headText),
    `head=${home.headTags} ${home.headText.slice(0, 200)}`);
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

  console.log('');
  console.log('[6] D22 - a legacy custom_head_html / custom_body_html payload injects nothing, on ANY page');
  // Before Part C1 the home page got these as live SCRIPT nodes (that WAS the control in [1]).
  // Now the render path is deleted, so the NORMAL page is the one that matters — the credential
  // page was already covered by [2]. home.deep walks every node under <head> and <body>.
  for (const page of ['home', 'blog', 'account-settings']) {
    const r = await runFor(page);
    ok(`${page}: no node carries the legacy head/body HTML markers`,
      !/__PWNED_HEAD|__PWNED_BODY|__PWNED_IMG/.test(r.deep), r.deep.slice(0, 300));
    // Exactly ONE GA4 node (the gtag.js loader) and nothing else may be a SCRIPT — since F6 the
    // init runs as direct JS, not an injected inline script. Counting is what catches a
    // half-revert that re-adds the head sink but keeps the markers out of text.
    const scripts = r.deep.split('~').filter((n) => n.startsWith('SCRIPT|'));
    ok(`${page}: the only SCRIPT node is the GA4 loader`, scripts.length === 1 &&
      scripts.every((n) => /G-PWNED/.test(n)), scripts.join(' ~ '));
  }

  console.log('');
  console.log('[7] D22 - provider loaders build a <script> only from a strict-pattern value');
  // Each case is run on the home page (where analytics DOES load) with a CONTROL first: the
  // same provider with a valid value must produce its script, or the refusals prove nothing.
  const withAnalytics = (a) => Object.assign({}, CFG, { analytics: a, announcements: [] });
  const providerScripts = (r) => r.deep.split('~').filter((n) => n.startsWith('SCRIPT|'));
  const cases = [
    { name: 'GA4', good: { provider: 'ga4', ga_tracking_id: 'G-ABC123' }, goodRe: /gtag\/js\?id=G-ABC123/,
      bad: [
        // The old `id.replace(/'/g,'')` kept a trailing backslash, which escapes the closing
        // quote of the init text. Neither form may reach a script now.
        { provider: 'ga4', ga_tracking_id: "G-X',alert(1),'" },
        { provider: 'ga4', ga_tracking_id: 'G-ABC\\' },
        { provider: 'ga4', ga_tracking_id: 'g-lowercase' },
      ] },
    { name: 'Plausible', good: { provider: 'plausible', plausible_domain: 'pool.example', plausible_src: 'https://plausible.io/js/script.js' },
      goodRe: /https:\/\/plausible\.io\/js\/script\.js/,
      bad: [
        { provider: 'plausible', plausible_domain: 'pool.example', plausible_src: 'javascript:window.__PWNED_P=1' },
        { provider: 'plausible', plausible_domain: 'pool.example', plausible_src: 'data:text/javascript,window.__PWNED_P=1' },
        { provider: 'plausible', plausible_domain: 'pool.example', plausible_src: 'http://plausible.io/js/script.js' },
        { provider: 'plausible', plausible_domain: 'pool.example', plausible_src: 'https://user:pw@plausible.io/js/script.js' },
        { provider: 'plausible', plausible_domain: 'a" onload="x', plausible_src: 'https://plausible.io/js/script.js' },
      ] },
    { name: 'Umami', good: { provider: 'umami', umami_website_id: '1b2c3d4e-0000-1111-2222-333344445555', umami_src: 'https://cloud.umami.is/script.js' },
      goodRe: /cloud\.umami\.is\/script\.js/,
      bad: [
        { provider: 'umami', umami_website_id: 'abc', umami_src: 'javascript:window.__PWNED_U=1' },
        { provider: 'umami', umami_website_id: 'x" onload="y', umami_src: 'https://cloud.umami.is/script.js' },
      ] },
    { name: 'Matomo', good: { provider: 'matomo', matomo_url: 'https://stats.pool.example/', matomo_site_id: '3' },
      goodRe: /https:\/\/stats\.pool\.example\/matomo\.js/,
      bad: [
        { provider: 'matomo', matomo_url: 'javascript:window.__PWNED_M=1//', matomo_site_id: '3' },
        { provider: 'matomo', matomo_url: 'https://stats.pool.example/', matomo_site_id: '3;x' },
      ] },
  ];
  for (const c of cases) {
    const good = await runFor('home', false, withAnalytics(c.good));
    const gs = providerScripts(good);
    ok(`CONTROL: ${c.name} with a valid value loads its script`, gs.some((n) => c.goodRe.test(n)), gs.join(' ~ '));
    for (const b of c.bad) {
      const r = await runFor('home', false, withAnalytics(b));
      const s = providerScripts(r);
      ok(`${c.name}: refuses ${JSON.stringify(b).slice(0, 110)}`, s.length === 0, s.join(' ~ '));
    }
  }

  console.log('');
  console.log('[8] F6 - GA4 init is direct JS: dataLayer gets the same pushes the inline snippet made');
  // The init used to be an injected inline <script> (blocked by a strict script-src). The
  // shim above never EXECUTES an inline script, so these pushes can only come from direct JS.
  const ga = await runFor('account-settings', false,
    withAnalytics({ provider: 'ga4', ga_tracking_id: 'G-ABC123' }),
    { href: 'https://pool.example/account-settings.html?addr=grin1secretaddr&utm_source=x',
      referrer: 'https://pool.example/account-settings.html?addr=grin1prevaddr&x=1' });
  const dl = Array.isArray(ga.dataLayer) ? ga.dataLayer : [];
  const kind = (v) => Object.prototype.toString.call(v);
  ok('GA4: window.gtag is a function', typeof ga.gtag === 'function', typeof ga.gtag);
  ok('GA4: exactly two init pushes, in order js → config', dl.length === 2 &&
    dl[0][0] === 'js' && dl[1][0] === 'config', JSON.stringify(dl.map((e) => Array.from(e))));
  // gtag.js acts only on Arguments entries — an array push is silently ignored by it.
  ok('GA4: every push is an Arguments object (not an array)',
    dl.length > 0 && dl.every((e) => kind(e) === '[object Arguments]'), dl.map(kind).join(','));
  ok("GA4: gtag('js', <Date>)", dl[0] && dl[0].length === 2 && kind(dl[0][1]) === '[object Date]');
  const conf = (dl[1] && dl[1][2]) || {};
  ok("GA4: gtag('config', id, …) carries the validated id", dl[1] && dl[1][1] === 'G-ABC123');
  ok('GA4: page_location is scrubbed of addr, keeps the rest',
    conf.page_location === 'https://pool.example/account-settings.html?utm_source=x', conf.page_location);
  ok('GA4: page_referrer is scrubbed of addr, keeps the rest',
    conf.page_referrer === 'https://pool.example/account-settings.html?x=1', conf.page_referrer);
  ok('GA4: config carries ONLY the two pinned keys',
    JSON.stringify(Object.keys(conf)) === '["page_location","page_referrer"]', JSON.stringify(conf));
  if (ga.gtag) ga.gtag('event', 'probe');
  ok('GA4: a later gtag() call still pushes to the same dataLayer', dl.length === 3 &&
    kind(dl[2]) === '[object Arguments]' && dl[2][0] === 'event', String(dl.length));
  const bad = await runFor('home', false, withAnalytics({ provider: 'ga4', ga_tracking_id: 'G-ABC\\' }));
  ok('GA4: a refused id defines no gtag and pushes nothing',
    bad.gtag === undefined && bad.dataLayer === undefined, typeof bad.gtag);

  console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('\nHARNESS ERROR:', err && err.stack);
  process.exit(1);
});
