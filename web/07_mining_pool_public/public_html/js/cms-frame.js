/* cms-frame.js — CMS page and post bodies in a sandboxed frame (audit D22-4; design §19.15
 * Part C7). Loaded by page.html and post.html, before their own inline script.
 *
 * WHY. A page body (lib/pages.js `html`) and a post body (lib/posts.js `body_html`) are raw
 * operator HTML. They used to be set with innerHTML on the pool origin, where the page CSP
 * allows 'unsafe-inline' script — so an `<img onerror=…>` in a body ran as the pool, on the
 * pages that (since C7) carry the chat bubble's sign-in form. D22 deleted the other operator-
 * code sinks rather than filter them; these two are the blog and the pages, so they cannot be
 * deleted. The operator chose (2026-10-04, before C7) to SANDBOX them instead of sanitising:
 *
 *   <iframe sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox
 *                    allow-top-navigation-by-user-activation" srcdoc="…the body…">
 *
 *   - NO allow-scripts: nothing in a body runs — no <script>, no on* handler, no javascript:
 *     URL — whatever the markup. The browser enforces it; there is no filter to get right.
 *   - allow-same-origin: lets THIS page (not the body: it has no script) measure the body's
 *     height and copy the page's stylesheets + theme into it. allow-same-origin is dangerous
 *     only together with allow-scripts, which is never granted here (test-operator-code-sinks
 *     pins both).
 *   - no allow-forms: a <form> in a body cannot submit. No allow-modals, no allow-downloads.
 *   - links: <base target="_top"> makes a plain link navigate this tab (allowed only on a
 *     user's click); target=_blank opens a normal tab (allow-popups + escape); an in-page
 *     #anchor scrolls this page to the anchor inside the frame.
 *   - the frame inherits the page's CSP (srcdoc), so a body loads exactly what it could before.
 *
 * Operator CSS inside a body now stays inside the frame — it can no longer restyle or overlay
 * the page around it (the header, the chat bubble's sign-in).
 *
 *   CmsFrame.mount(host, html, { wrapClass, title })  → the <iframe>, appended to `host`
 */
(function () {
  'use strict';

  var SANDBOX = 'allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-top-navigation-by-user-activation';
  var CLONE = 'data-cms-clone';

  // Inside the frame: no page chrome — transparent, no margins, no theme ambience layers.
  var FRAME_CSS =
    'html,body{margin:0!important;padding:0!important;min-height:0!important;height:auto!important;' +
    'background:transparent!important;background-image:none!important;overflow:hidden!important;}' +
    'body::before,body::after{content:none!important;display:none!important;}' +
    '.cms-frame-body{display:flow-root;max-width:none!important;margin:0!important;padding:0!important;}';

  function safeClass(s) { return typeof s === 'string' && /^[A-Za-z0-9 _-]{0,80}$/.test(s) ? s : ''; }

  // The page's stylesheets and <style> blocks (its own inline CSS, the theme files, the
  // operator's branding CSS, a web font) — cloned into the frame's head, re-cloned whenever
  // the page's head changes (branding.js adds some after its fetch).
  function syncStyles(d, refit) {
    var old = d.head.querySelectorAll('[' + CLONE + ']');
    for (var i = 0; i < old.length; i++) old[i].parentNode.removeChild(old[i]);
    var src = document.head.querySelectorAll('link[rel="stylesheet"], style');
    for (var j = 0; j < src.length; j++) {
      var c = d.importNode(src[j], true);
      c.setAttribute(CLONE, '1');
      if (c.tagName === 'LINK') c.addEventListener('load', refit);
      d.head.appendChild(c);
    }
    var own = d.createElement('style');
    own.setAttribute(CLONE, '1');
    own.textContent = FRAME_CSS;              // last, so it wins
    d.head.appendChild(own);
  }

  // The theme lives on <body> (class + the custom-token inline style) and <html> (inline
  // custom tokens) — public-theme.js / branding.js applyTheme. Copied as attributes.
  function syncTheme(d) {
    d.body.className = document.body.className;
    var bs = document.body.getAttribute('style');
    if (bs) d.body.setAttribute('style', bs); else d.body.removeAttribute('style');
    var hs = document.documentElement.getAttribute('style');
    if (hs) d.documentElement.setAttribute('style', hs); else d.documentElement.removeAttribute('style');
  }

  function setup(f) {
    var d;
    try { d = f.contentDocument; } catch (e) { d = null; }
    if (!d || !d.body) return;
    var wrap = d.body.firstElementChild;
    var fit = function () {
      try {
        var h = wrap ? Math.ceil(wrap.getBoundingClientRect().height) : d.body.scrollHeight;
        f.style.height = Math.max(0, h) + 'px';
      } catch (e) { /* keep the last height */ }
    };
    syncStyles(d, fit);
    syncTheme(d);
    fit();

    // Images and fonts change the height after load.
    d.addEventListener('load', fit, true);
    if (d.fonts && d.fonts.ready) d.fonts.ready.then(fit, function () {});
    window.addEventListener('resize', fit);
    try { if (wrap && window.ResizeObserver) new ResizeObserver(fit).observe(wrap); } catch (e) { /* the events above cover it */ }
    [150, 600, 1500].forEach(function (ms) { setTimeout(fit, ms); });
    try {
      new MutationObserver(function () { syncTheme(d); fit(); })
        .observe(document.body, { attributes: true, attributeFilter: ['class', 'style'] });
      new MutationObserver(function () { syncTheme(d); fit(); })
        .observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });
      new MutationObserver(function () { syncStyles(d, fit); fit(); })
        .observe(document.head, { childList: true });
    } catch (e) { /* the first copy stays */ }

    // Links: a new tab never gets a handle on this page; an in-page #anchor scrolls THIS page.
    var links = d.querySelectorAll('a[href]');
    for (var i = 0; i < links.length; i++) {
      if (links[i].getAttribute('target') === '_blank') links[i].setAttribute('rel', 'noopener noreferrer');
    }
    d.addEventListener('click', function (e) {
      var a = e.target && e.target.closest ? e.target.closest('a[href^="#"]') : null;
      if (!a) return;
      e.preventDefault();
      var id = a.getAttribute('href').slice(1);
      var t = id ? d.getElementById(decodeURIComponent(id)) : null;
      var y = window.pageYOffset + f.getBoundingClientRect().top + (t ? t.getBoundingClientRect().top : 0) - 80;
      window.scrollTo({ top: Math.max(0, y), behavior: 'smooth' });
    });
  }

  function mount(host, html, opts) {
    opts = opts || {};
    while (host.firstChild) host.removeChild(host.firstChild);
    var f = document.createElement('iframe');
    f.setAttribute('sandbox', SANDBOX);
    f.setAttribute('title', typeof opts.title === 'string' && opts.title ? opts.title : 'Page content');
    f.className = 'cms-frame';
    f.style.cssText = 'display:block;width:100%;height:0;border:0;overflow:hidden;background:transparent;';
    f.addEventListener('load', function () { setup(f); });
    // The body goes in as it is — the sandbox, not this string, is what makes it inert.
    f.srcdoc = '<!DOCTYPE html><html><head><meta charset="utf-8"><base target="_top"></head><body>' +
      '<div class="cms-frame-body ' + safeClass(opts.wrapClass) + '">' + String(html == null ? '' : html) + '</div></body></html>';
    host.appendChild(f);
    return f;
  }

  window.CmsFrame = Object.freeze({ mount: mount, SANDBOX: SANDBOX });
})();
