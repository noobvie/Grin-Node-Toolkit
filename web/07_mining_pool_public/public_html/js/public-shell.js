/* ============================================================================
   public-shell.js — shared PUBLIC chrome (header + footer)   [added 2026-06]
   ----------------------------------------------------------------------------
   Single source of truth for the public site header and footer, mirroring what
   admin-shell.js does for the admin panel. Each public page now ships ONLY its
   own content (the <div class="wrap"> body); this script injects the <header>
   (brand + nav + theme switcher) and the <footer> SYNCHRONOUSLY
   at body-end, so the chrome is byte-identical on every page and there is no
   flash of a drifting hardcoded nav before the async config load.

   Why not per-page markup: a full <header>/<footer> hand-shipped on every page, with
   branding.js's buildNav() rewriting the nav links from a NAV_LINKS list only AFTER
   /api/config resolved, shows each page's (inconsistent) hardcoded fallback nav until that
   fetch returns, and every markup change means editing every page. So the nav lives HERE,
   once, and renders before any fetch. branding.js still ENHANCES this injected DOM (logo/slogan via
   .brand, [data-brand] hooks, and showing/hiding the gated Community links); it no
   longer owns the base nav.

   Load order at the end of <body>:  public-shell.js → public-theme.js → branding.js
   (public-shell first so .theme-switcher / .header-nav exist before the other two
   run). Runs immediately — no DOMContentLoaded needed.

   To add/rename/reorder a public nav item, edit NAV here, once.
   ========================================================================== */
(function () {
  'use strict';

  // ── Canonical public navigation (single source of truth) ────────────────
  // Grouped by what the visitor is after: the POOL's numbers under Stats,
  // the "extras" under Community — the prize pool's two halves (money out = Fortune Board,
  // money in = the donate page) and the /play/ games (script07_design_games.md §19.17.8, D31) —
  // and the visitor's OWN page — Account — split out to the right of the header (ACCOUNT
  // below), so the pool-wide "Payouts" and your own withdrawals do not sit side by
  // side as peers.
  // Each item carries an icon: on narrow screens the header collapses to icons-only
  // (the .nav-label is hidden via CSS) so the mobile header stays tidy; desktop shows
  // icon + label. The footer's Pool column reuses the labels only (always text); its
  // Community column reuses label + icon.
  // An item is either a leaf link ({href,label,icon}) or a GROUP
  // ({label,icon,children:[…leaf links…]}). A group has NO href of its own — it
  // only opens a dropdown of its children. Gates live on the CHILDREN, never on the group
  // (script07_design_games.md §19.17.8): a child marked `incentives: true` renders with data-incentives (shown by
  // default, hidden by branding.js applyIncentivesNav when the operator has incentives
  // off); one marked `games: true` renders HIDDEN with data-games (shown by applyGamesNav
  // only on an effective games mode of 'on'). A group with any gated child carries
  // data-nav-gated, and branding.js applyNavGroups shows it while at least one child is
  // shown — hidden, never an empty dropdown — so one child's flag can never hide the
  // other children's links.
  var NAV = [
    // "Home", not "Dashboard": "Dashboard" read as "my dashboard" when this is in fact the
    // POOL-wide overview. The 🏠 icon already says home, and index.html's own <h1> still
    // says "Pool Dashboard" — nav label and page identity, not the same job.
    { href: 'index.html',            label: 'Home',          icon: '🏠' },
    { label: 'Stats', icon: '📊', children: [
      { href: 'miners-stats.html',   label: 'Miners',        icon: '📈' },
      { href: 'blocks.html',         label: 'Blocks',        icon: '🧱' },
      { href: 'payment-history.html', label: 'Payouts',      icon: '💸' },
      { href: 'network-map.html',    label: 'Network Map',   icon: '🛰️' }
    ] },
    // "Community" (operator's choice, script07_design_games.md §19.17 C0 answer 1), not "Prize Pool".
    // `footerCol: 'community'` renders its children as the footer's Community column
    // instead of folding them into the Pool column.
    // Every prize-pool GRIN is paid back out to miners, never to the operator — so the
    // donate page is "Contribute" here, not "Donate" (reads as tipping the operator) and
    // not "Sponsors" (reads as companies funding the operator). Its <h1> stays
    // "Support the Prize Pool".
    // Play is the /play/ games platform (script07_design_games.md §19): `games: true` renders it HIDDEN —
    // the opposite default of `incentives`. Absolute href: /play/ is served from its own
    // docroot, not this one. On /play/ itself the group lights as active through it.
    { label: 'Community', icon: '👥', children: [
      { href: 'fortune-board.html',  label: 'Fortune Board', icon: '🏆', incentives: true },
      { href: 'donate.html',         label: 'Contribute',    icon: '💚', incentives: true },
      { href: '/play/',              label: 'Play',          icon: '🎮', games: true }
    ], footerCol: 'community' }
  ];
  // "Account", not "My Stats": the page's <title> and <h1> both say Account, and it is
  // where withdrawals happen. Rendered as a chip in .nav-right, not in NAV: it is the only
  // page about YOUR mining rather than the pool's, and "your stuff on the right, beside the
  // settings" is the convention visitors already expect.
  var ACCOUNT = { href: 'account-settings.html', label: 'Account', icon: '👤' };
  // Blog is intentionally NOT in NAV (header) — it lives in the footer "Resources"
  // column only, to keep the header focused on critical mining/stats links.

  // Every link this script renders is SITE-ABSOLUTE ('/blog.html', never 'blog.html'). The
  // header is mounted on pages that do not live at the docroot: blog permalinks are served
  // at /blog/<slug> and the games shell at /play/ (script07_design_games.md §19). A relative href resolved
  // under those paths — /blog/index.html, /play/donate.html — so a relative
  // header or footer link on a blog permalink would be a 404.
  function abs(href) { return /^\//.test(href) ? href : '/' + href; }
  function currentPath() {
    var p = location.pathname || '/';
    return p === '/' ? '/index.html' : p;
  }
  // The href's site path (strip any ?query/#anchor) for active-link comparison.
  function fileOf(href) { return abs(String(href).replace(/[?#].*$/, '')); }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  var here = currentPath();

  // A link's gate attributes. A games-gated link starts hidden (inline display:none —
  // .nav-link sets its own display in CSS, which beats the UA [hidden] rule) so it never
  // flashes before the branding fetch; an incentives-gated one starts shown (incentives ship
  // ON, and a failed fetch must not strip working links).
  function gateAttrs(l) {
    if (l.games) return ' data-games="1" style="display:none"';
    if (l.incentives) return ' data-incentives="1"';
    return '';
  }
  // A group whose children are ALL hidden at first render starts hidden too (no empty
  // dropdown before the fetch); branding.js applyNavGroups decides from then on.
  function groupAttrs(l) {
    var gated = l.children.some(function (c) { return c.games || c.incentives; });
    if (!gated) return '';
    var anyShown = l.children.some(function (c) { return !c.games; });
    return ' data-nav-gated="1"' + (anyShown ? '' : ' style="display:none"');
  }

  // Render one leaf link (also used for the items inside a group dropdown).
  function leafLink(l, extraClass) {
    var active = fileOf(l.href) === here ? ' active' : '';
    var cls = 'nav-link' + (extraClass ? ' ' + extraClass : '') + active;
    return '<a href="' + abs(l.href) + '" class="' + cls + '" title="' + esc(l.label) + '"' + gateAttrs(l) + '>' +
      '<span class="nav-ico" aria-hidden="true">' + (l.icon || '') + '</span>' +
      '<span class="nav-label">' + esc(l.label) + '</span>' +
    '</a>';
  }

  var navLinks = NAV.map(function (l) {
    if (!l.children) return leafLink(l);
    // Group: a caret trigger (no href) + a dropdown of children. The trigger carries
    // .active when the current page is one of the children so the parent stays lit.
    var childActive = l.children.some(function (c) { return fileOf(c.href) === here; });
    return '<div class="nav-group' + (childActive ? ' active' : '') + '"' + groupAttrs(l) + '>' +
      '<button type="button" class="nav-link nav-group-trigger" aria-haspopup="true" ' +
        'aria-expanded="false" title="' + esc(l.label) + '">' +
        '<span class="nav-ico" aria-hidden="true">' + (l.icon || '') + '</span>' +
        '<span class="nav-label">' + esc(l.label) + '</span>' +
        '<span class="nav-caret" aria-hidden="true">▾</span>' +
      '</button>' +
      '<div class="nav-dropdown" role="menu">' +
        l.children.map(function (c) { return leafLink(c); }).join('') +
      '</div>' +
    '</div>';
  }).join('');

  // ── Header: keeps the markup existing CSS and
  //    branding.js hooks (.brand / [data-brand="pool_name"] / .header-nav /
  //    .theme-switcher) keep working unchanged. ──────────────────────────────
  var header = document.createElement('header');
  header.innerHTML =
    '<div class="brand">' +
      '<img class="brand-logo" src="/images/grin_lime.svg" alt="" aria-hidden="true">' +
      '<span data-brand="pool_name">GRINIUM</span>' +
    '</div>' +
    '<nav class="header-nav" aria-label="Main" data-shell="1">' + navLinks + '</nav>' +
    '<div class="nav-right">' +
      leafLink(ACCOUNT, 'nav-account') +
      '<div class="theme-switcher"></div>' +
    '</div>';

  // ── Footer ────────────────────────────────────────────────────────────────
  // A one-line brand strip (name · tagline · socials), four link columns — Pool /
  // Community / Resources / Help & Legal — and a copyright row. The brand is a strip, not
  // a grid column: as a column it ran twice the height of the link columns beside it, and
  // the columns are kept to ~5 rows each so they line up on desktop and pair evenly 2×2 on
  // a phone. Pool and Community are built from NAV, so their labels, icons and gates are
  // the header's — two hand-written copies had already drifted ("Donate" ❤ vs "Contribute").
  // branding.js fills the [data-brand] hooks once /api/public/branding resolves, then
  // applyFooterCols hides a gated column left with no links and re-counts the grid.

  // Groups have no page of their own, so they're flattened to their child links. No
  // anchor stays active in the footer. Home is left out: a footer row reading just "Home"
  // is a weak link, and every page already carries the 🏠 Home item in the header.
  var poolLeaves = [];
  var communityLeaves = [];
  NAV.forEach(function (l) {
    var into = l.footerCol === 'community' ? communityLeaves : poolLeaves;
    if (l.children) { l.children.forEach(function (c) { into.push(c); }); }
    else into.push(l);
  });
  poolLeaves.push(ACCOUNT);   // lives in .nav-right, not NAV, but is still a pool page
  var POOL_COL_SKIP = { '/index.html': 1 };
  function footerLink(l, withIcon) {
    return '<a href="' + abs(l.href) + '"' + gateAttrs(l) + '>' +
      (withIcon ? '<span class="footer-ico" aria-hidden="true">' + (l.icon || '') + '</span>' : '') +
      esc(l.label) + '</a>';
  }
  var poolCol = poolLeaves.filter(function (l) { return !POOL_COL_SKIP[fileOf(l.href)]; })
    .map(function (l) { return footerLink(l, false); }).join('');
  var communityCol = communityLeaves.map(function (l) { return footerLink(l, true); }).join('');

  var footer = document.createElement('footer');
  footer.innerHTML =
    '<div class="footer-top">' +
      '<div class="footer-brand">' +
        // No logo image here on purpose — the header already carries the swinging
        // brand logo; a second one in the footer just duplicates that animation.
        '<div class="brand">' +
          '<span data-brand="pool_name">GRINIUM</span>' +
        '</div>' +
        '<p class="footer-tagline" data-brand="pool_tagline">Mine Grin, anywhere</p>' +
      '</div>' +
      '<div class="footer-social">' +
        '<a data-brand="social-twitter" href="#" target="_blank" rel="noopener" style="display:none">Twitter / X</a>' +
        '<a data-brand="social-discord" href="#" target="_blank" rel="noopener" style="display:none">Discord</a>' +
        '<a data-brand="social-telegram" href="#" target="_blank" rel="noopener" style="display:none">Telegram</a>' +
        '<a data-brand="social-nostr" href="#" target="_blank" rel="noopener" style="display:none">Nostr</a>' +
      '</div>' +
    '</div>' +
    '<div class="footer-cols">' +
      '<div class="footer-col">' +
        '<h4>Pool</h4>' + poolCol +
      '</div>' +
      // Community: the header group's children (each with its own gate) + the operator's
      // public support channel (support_forum_url). data-footer-gated: hidden when every
      // link in it is (incentives off, games not 'on', no forum link).
      '<div class="footer-col footer-community" data-footer-gated="1">' +
        '<h4>Community</h4>' + communityCol +
        '<a data-brand="forum-link" href="#" target="_blank" rel="noopener" style="display:none">' +
          '<span class="footer-ico" aria-hidden="true">💬</span>Forum</a>' +
      '</div>' +
      // Resources — Blog + API docs, plus the CMS's informational pages (Start Mining /
      // About / FAQ …), which branding.js appends here rather than under Legal. Deliberately absent:
      // "Get Started" (the CMS "Start Mining" page below is the real guide, and
      // index.html#connect is one click from the header's Home link) and the
      // "Grin Node Toolkit ↗" repo link (a link off-site to the software, not a pool
      // resource — it is the bottom row's "Powered by" attribution, an operator setting).
      '<div class="footer-col">' +
        '<h4>Resources</h4>' +
        '<a href="/blog.html">Blog</a>' +
        '<a href="/api-docs.html">API Docs</a>' +
        '<div data-brand="page-links-info"></div>' +
      '</div>' +
      // Help & Legal: the operator's contact, security contact (+ PGP key), then the legal
      // CMS pages (Terms / Privacy / Impressum …) that branding.js appends; the CSS makes
      // that container a flex column so each lands on its own line. Every link here can be
      // absent, so the column is data-footer-gated too.
      '<div class="footer-col footer-legal" data-footer-gated="1">' +
        '<h4>Help &amp; Legal</h4>' +
        '<a class="footer-contact" data-brand="contact-link" href="#" style="display:none">Contact</a>' +
        '<a data-brand="security-link" data-brand-show="security" href="#" style="display:none">Security</a>' +
        '<a data-brand="pgp-link" href="#" target="_blank" rel="noopener" style="display:none">PGP key</a>' +
        '<div data-brand="page-links"></div>' +
      '</div>' +
    '</div>' +
    // Bottom row: copyright · attribution · signature.
    '<div class="footer-bottom">' +
      // The signature is hardcoded (matches GrinScan / Tiny Explorer) — not a branding
      // hook — so it stays put. Yellow flag with three red stripes = Saigon. The
      // attribution carries its own separator so hiding it (show_attribution off) leaves
      // no dangling dot.
      '<p class="footer-copyright" data-brand="copyright">Since 2026</p>' +
      '<span class="footer-attribution" data-brand="attribution">' +
        '<span class="footer-sep" aria-hidden="true">·</span> ' +
        'Powered by <a href="https://github.com/noobvie/Grin-Node-Toolkit" target="_blank" rel="noopener">Grin Node Toolkit</a>' +
      '</span>' +
      '<span class="footer-sep" aria-hidden="true">·</span>' +
      '<span class="footer-saigon">From Saigon with &#10084;&#65039; ' +
        '<svg viewBox="0 0 27 18" width="21" height="14" role="img" aria-label="Yellow flag with three red stripes" style="vertical-align:-2px;border-radius:2px">' +
          '<rect width="27" height="18" fill="#FFCD00"/>' +
          '<rect y="4" width="27" height="2" fill="#DA251D"/>' +
          '<rect y="8" width="27" height="2" fill="#DA251D"/>' +
          '<rect y="12" width="27" height="2" fill="#DA251D"/>' +
        '</svg></span>' +
    '</div>';

  // Deterministically (re)start the brand-logo swing. The @keyframes/animation rule is
  // already present (dashboard.css is in <head>, so this script is blocked until it loads),
  // but the animation START races with two things on a fresh load: the SVG image decode, and
  // branding.js re-injecting an identical @keyframes <style> after its async /api/config fetch
  // (redefining a running keyframes name can leave the swing stuck on some engines). A reflow
  // kick after the image is ready forces a clean start, so it swings the first time, every time.
  function startBrandSwing() {
    var logo = header.querySelector('.brand-logo');
    if (!logo) return;
    var kick = function () {
      logo.style.animation = 'none';
      void logo.offsetWidth;        // force reflow so the restart takes effect
      logo.style.animation = '';    // fall back to the stylesheet rule (dashboard.css)
    };
    if (logo.complete) {
      kick();
    } else {
      logo.addEventListener('load', kick, { once: true });
      logo.addEventListener('error', kick, { once: true }); // broken src still gets a styled box
    }
  }

  // Ad slots (filled by /js/ads.js from /api/public/ads). Header sits just under the
  // nav; footer sits just above the footer — both site-wide. Sidebar / in-content slots
  // are declared per-page (currently the homepage) wherever the layout allows them.
  function adSlot(placement) {
    var d = document.createElement('div');
    d.className = 'ad-slot ad-slot--' + placement;
    d.setAttribute('data-ad-slot', placement);
    d.style.display = 'none'; // ads.js reveals it only if that placement has active ads
    return d;
  }

  // The footer carries no live mini-stats bar (network / fee / min payout / price /
  // stratum): every one of those numbers already has a home on the pages themselves. The pool-info fetch stays, purely to raise the TESTNET banner.
  function enhanceFooter() {
    // /api/config/pool-info is unauthenticated + cheap.
    fetch('/api/config/pool-info', { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (d && d.network === 'testnet') showTestnetBanner();
      })
      .catch(function () {});
  }

  // Sticky TESTNET banner so visitors never mistake test tGRIN for real coins. Idempotent;
  // styled by .testnet-banner in css/dashboard.css (NOT pool.css — that is the admin
  // stylesheet and no public page loads it, so a rule there would leave this banner as bare
  // unstyled text). Pushes the sticky header down by the banner height
  // via the body.has-testnet-banner rule.
  function showTestnetBanner() {
    if (document.querySelector('.testnet-banner')) return;
    var b = document.createElement('div');
    b.className = 'testnet-banner';
    b.setAttribute('role', 'status');
    b.textContent = '⚠ TESTNET — coins here are test tGRIN with no real value.';
    document.body.insertBefore(b, document.body.firstChild);
    document.body.classList.add('has-testnet-banner');
    // Measure rather than trust the CSS default: this line wraps to two rows under about
    // 480px, and a fixed 38px offset then let the sticky header ride up over the second
    // row — hiding the warning on exactly the phones most likely to be a first visit.
    var sync = function () {
      document.documentElement.style.setProperty(
        '--testnet-banner-h', b.offsetHeight + 'px');
    };
    sync();
    window.addEventListener('resize', sync);
  }

  // Nav dropdown groups: desktop opens on :hover / :focus-within (pure CSS); touch and
  // keyboard need an explicit toggle. Click the trigger to open/close; clicking outside
  // or pressing Escape closes. Only one group open at a time.
  function wireNavGroups() {
    var groups = header.querySelectorAll('.nav-group');
    if (!groups.length) return;
    function closeAll(except) {
      groups.forEach(function (g) {
        if (g === except) return;
        g.classList.remove('open');
        var t = g.querySelector('.nav-group-trigger');
        if (t) t.setAttribute('aria-expanded', 'false');
      });
    }
    groups.forEach(function (g) {
      var trigger = g.querySelector('.nav-group-trigger');
      if (!trigger) return;
      trigger.addEventListener('click', function (e) {
        e.preventDefault();
        var willOpen = !g.classList.contains('open');
        closeAll(g);
        g.classList.toggle('open', willOpen);
        trigger.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
      });
    });
    document.addEventListener('click', function (e) {
      if (!e.target.closest('.nav-group')) closeAll(null);
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeAll(null);
    });
  }

  // Skip-to-content link. It must be the FIRST focusable thing in the document, which is
  // why it is injected here rather than per page: the nav below it is several stops on every
  // page, and without this a keyboard or screen-reader user re-tabs the whole thing on
  // every navigation. Visually hidden until focused (see .skip-link in dashboard.css).
  // Target is #main — the <main> landmark each page now carries; it has tabindex="-1" so
  // focus actually moves there rather than only the scroll position.
  function skipLink() {
    var a = document.createElement('a');
    a.className = 'skip-link';
    a.href = '#main';
    a.textContent = 'Skip to content';
    a.addEventListener('click', function () {
      // Some browsers scroll to the anchor without focusing it; do it explicitly so the
      // next Tab continues from the content, not from the top of the document.
      var m = document.getElementById('main');
      if (m) setTimeout(function () { m.focus(); }, 0);
    });
    return a;
  }

  function mount() {
    // Remove any legacy hardcoded chrome a page might still carry (defensive —
    // converted pages ship none), then inject the canonical header/footer.
    document.querySelectorAll('body > header, body > footer').forEach(function (el) { el.remove(); });
    document.body.insertBefore(header, document.body.firstChild);
    document.body.insertBefore(skipLink(), header);
    // No ads where a credential is typed, under the same opt-out attribute branding.js uses
    // (audit §J1-1). This was first written against the `code` ad type, operator HTML/JS that
    // ads.js re-created as executing <script> nodes; that type is gone (script07_design_games.md §19.17 D22),
    // and ads are now an image or a text card only. The rule stays because it still costs
    // nothing: a banner image from an operator-chosen origin is a visit beacon to that
    // origin, and a sign-in page has no use for one. The games shell (/play/, a rig password
    // in its login card) sets the attribute, and so does login.html.
    var noAds = document.documentElement.getAttribute('data-untrusted-html') === 'exempt';
    // Header ad slot directly after the header.
    if (!noAds) header.insertAdjacentElement('afterend', adSlot('header'));
    // Footer ad slot directly before the footer.
    if (!noAds) document.body.appendChild(adSlot('footer'));
    document.body.appendChild(footer);
    startBrandSwing();
    wireNavGroups();
    enhanceFooter();

    // Load the ad renderer once (it fills every [data-ad-slot] on the page).
    if (!noAds && !document.getElementById('ads-js')) {
      var s = document.createElement('script');
      s.id = 'ads-js';
      s.src = '/js/ads.js';
      s.defer = true;
      document.body.appendChild(s);
    }
  }

  if (document.body) {
    mount();
  } else {
    document.addEventListener('DOMContentLoaded', mount);
  }
})();
