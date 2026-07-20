/* ============================================================================
   public-shell.js — shared PUBLIC chrome (header + footer)   [added 2026-06]
   ----------------------------------------------------------------------------
   Single source of truth for the public site header and footer, mirroring what
   admin-shell.js does for the admin panel. Each public page now ships ONLY its
   own content (the <div class="wrap"> body); this script injects the <header>
   (brand + nav + theme switcher) and the <footer> SYNCHRONOUSLY
   at body-end, so the chrome is byte-identical on every page and there is no
   flash of a drifting hardcoded nav before the async config load.

   Why this replaced the old approach: every page used to hand-ship a full
   <header>/<footer>, and branding.js's buildNav() rewrote the nav links from a
   NAV_LINKS list only AFTER /api/config resolved — so until that fetch returned
   you saw each page's (inconsistent) hardcoded fallback nav, and maintaining the
   markup meant editing 7 files. Now the nav lives HERE, once, and renders before
   any fetch. branding.js still ENHANCES this injected DOM (logo/slogan via
   .brand, [data-brand] hooks, and the incentives-gated 🎁 Rewards link); it no
   longer owns the base nav.

   Load order at the end of <body>:  public-shell.js → public-theme.js → branding.js
   (public-shell first so .theme-switcher / .header-nav exist before the other two
   run). Runs immediately — no DOMContentLoaded needed.

   To add/rename/reorder a public nav item, edit NAV here, once.
   ========================================================================== */
(function () {
  'use strict';

  // ── Canonical public navigation (single source of truth) ────────────────
  // Fortune Board is a permanent nav item (it replaced the redundant "Info"
  // link, whose target index.html#info is already on the dashboard). Because
  // fortune-board.html is now always present here, branding.js injectRewardsLink
  // detects it and no longer adds the separate "🎁 Rewards" link.
  // Each item carries an icon: on narrow screens the header collapses to icons-only
  // (the .nav-label is hidden via CSS) so the mobile header stays tidy; desktop shows
  // icon + label. The footer "Pool" column reuses the labels only (always text).
  // An item is either a leaf link ({href,label,icon}) or a GROUP
  // ({label,icon,children:[…leaf links…]}). A group has NO href of its own — it
  // only opens a dropdown of its children (Pool Stats → Miners Stats / Network Map).
  var NAV = [
    { href: 'index.html',            label: 'Dashboard',     icon: '🏠' },
    { label: 'Pool Stats', icon: '📊', children: [
      { href: 'miners-stats.html',   label: 'Miners Stats',  icon: '📈' },
      { href: 'network-map.html',    label: 'Network Map',   icon: '🛰️' }
    ] },
    { href: 'account-settings.html', label: 'My Stats',      icon: '👤' },
    { href: 'blocks.html',           label: 'Blocks',        icon: '🧱' },
    { href: 'payment-history.html',  label: 'Payouts',       icon: '💸' },
    { href: 'fortune-board.html',    label: 'Fortune Board', icon: '🎁' }
  ];
  // Blog is intentionally NOT in NAV (header) — it lives in the footer "Resources"
  // column only, to keep the header focused on critical mining/stats links.

  function currentFile() {
    var f = (location.pathname || '/').split('/').pop();
    return f ? f.replace(/[?#].*$/, '') : 'index.html';
  }
  // The href's file part (strip any #anchor) for active-link comparison.
  function fileOf(href) { return String(href).replace(/[?#].*$/, ''); }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  var here = currentFile();

  // Render one leaf link (also used for the items inside a group dropdown).
  function leafLink(l) {
    var active = fileOf(l.href) === here ? ' active' : '';
    return '<a href="' + l.href + '" class="nav-link' + active + '" title="' + esc(l.label) + '">' +
      '<span class="nav-ico" aria-hidden="true">' + (l.icon || '') + '</span>' +
      '<span class="nav-label">' + esc(l.label) + '</span>' +
    '</a>';
  }

  var navLinks = NAV.map(function (l) {
    if (!l.children) return leafLink(l);
    // Group: a caret trigger (no href) + a dropdown of children. The trigger carries
    // .active when the current page is one of the children so the parent stays lit.
    var childActive = l.children.some(function (c) { return fileOf(c.href) === here; });
    return '<div class="nav-group' + (childActive ? ' active' : '') + '">' +
      '<button type="button" class="nav-link nav-group-trigger" aria-haspopup="true" ' +
        'aria-expanded="false" title="' + esc(l.label) + '">' +
        '<span class="nav-ico" aria-hidden="true">' + (l.icon || '') + '</span>' +
        '<span class="nav-label">' + esc(l.label) + '</span>' +
        '<span class="nav-caret" aria-hidden="true">▾</span>' +
      '</button>' +
      '<div class="nav-dropdown" role="menu">' +
        l.children.map(leafLink).join('') +
      '</div>' +
    '</div>';
  }).join('');

  // ── Header: byte-identical to the old per-page markup so existing CSS and
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
      '<div class="theme-switcher"></div>' +
    '</div>';

  // ── Footer columns ────────────────────────────────────────────────────────
  // Four columns + a live mini-stats bar + a legal/copyright bottom row. The "Pool"
  // column reuses the NAV above; the "Legal" column is filled from the CMS pages by
  // branding.js ([data-brand="page-links"]); brand/social/copyright/security hooks are
  // also enhanced by branding.js once /api/public/branding resolves. The mini-stats bar
  // (network/fee/min/price/stratum) is filled by this script's own light fetches below.

  // Pool column reuses the canonical NAV (no anchor stays active in the footer), minus
  // Blog — it lives in the Resources column below to avoid a duplicate link. Groups have
  // no page of their own, so they're flattened to their child links here.
  var poolLeaves = [];
  NAV.forEach(function (l) {
    if (l.children) { l.children.forEach(function (c) { poolLeaves.push(c); }); }
    else poolLeaves.push(l);
  });
  // Excluded from the Pool column: Blog (Resources col), Dashboard (redundant — the
  // brand logo links home) and Fortune Board (surfaced under Donate in the brand col).
  var POOL_COL_SKIP = { 'blog.html': 1, 'index.html': 1, 'fortune-board.html': 1 };
  var poolCol = poolLeaves.filter(function (l) { return !POOL_COL_SKIP[fileOf(l.href)]; })
    .map(function (l) {
      return '<a href="' + l.href + '">' + esc(l.label) + '</a>';
    }).join('');

  var GITHUB = 'https://github.com/noobvie/Grin-Node-Toolkit';

  var footer = document.createElement('footer');
  footer.innerHTML =
    '<div class="footer-cols">' +
      // Brand + tagline + social
      '<div class="footer-col footer-brand">' +
        // No logo image here on purpose — the header already carries the swinging
        // brand logo; a second one in the footer just duplicates that animation.
        '<div class="brand">' +
          '<span data-brand="pool_name">GRINIUM</span>' +
        '</div>' +
        '<p class="footer-tagline" data-brand="pool_tagline">Mine Grin, anywhere</p>' +
        '<div class="footer-social">' +
          '<a data-brand="social-twitter" href="#" target="_blank" rel="noopener" style="display:none">Twitter / X</a>' +
          '<a data-brand="social-discord" href="#" target="_blank" rel="noopener" style="display:none">Discord</a>' +
          '<a data-brand="social-telegram" href="#" target="_blank" rel="noopener" style="display:none">Telegram</a>' +
          '<a data-brand="social-nostr" href="#" target="_blank" rel="noopener" style="display:none">Nostr</a>' +
        '</div>' +
        // Donate lives in the brand column, highlighted with a heart, as the primary
        // community call-to-action (moved out of the Legal column). Fortune Board sits
        // right below it (moved out of the Pool column to keep the columns balanced).
        '<a class="footer-donate" href="donate.html">' +
          '<span class="footer-donate-ico" aria-hidden="true">❤</span> Donate' +
        '</a>' +
        '<a class="footer-fortune" href="fortune-board.html">' +
          '<span class="footer-fortune-ico" aria-hidden="true">🎁</span> Fortune Board' +
        '</a>' +
      '</div>' +
      // Pool navigation
      '<div class="footer-col">' +
        '<h4>Pool</h4>' + poolCol +
      '</div>' +
      // Resources
      '<div class="footer-col">' +
        '<h4>Resources</h4>' +
        '<a href="index.html#connect">Get Started</a>' +
        '<a href="blog.html">Blog</a>' +
        '<a href="api-docs.html">API Docs</a>' +
        '<a href="' + GITHUB + '" target="_blank" rel="noopener noreferrer">Grin Node Toolkit ↗</a>' +
      '</div>' +
      // Legal + contact (page-links injected by branding.js from the CMS)
      '<div class="footer-col footer-legal">' +
        '<h4>Legal</h4>' +
        // page-links (About / Terms / Privacy / FAQ …) are appended by branding.js; the CSS
        // makes this container a flex column so each lands on its own line. Forum/Donate moved out.
        '<div data-brand="page-links"></div>' +
        '<a class="footer-contact" data-brand="contact-link" href="#" style="display:none">Contact</a>' +
      '</div>' +
    '</div>' +
    // Live mini-stats bar (filled by this script's fetches; rows hide until populated).
    '<div class="footer-stats">' +
      '<span class="footer-stat footer-net" hidden></span>' +
      '<span class="footer-stat footer-fee" hidden></span>' +
      '<span class="footer-stat footer-min" hidden></span>' +
      '<span class="footer-stat footer-price" hidden></span>' +
      '<span class="footer-stat footer-stratum" hidden>stratum: ' +
        '<code data-brand="stratum_url"></code> ' +
        '<button type="button" class="footer-copy" aria-label="Copy stratum address">copy</button>' +
      '</span>' +
    '</div>' +
    // Bottom row: copyright + attribution + security contact.
    '<div class="footer-bottom">' +
      // Copyright + Saigon signature share one line. The signature is hardcoded
      // (matches GrinScan / Tiny Explorer) — not a branding hook — so it stays put.
      // Yellow flag with three red stripes = Saigon.
      '<p class="footer-copyright" data-brand="copyright">Since 2026</p>' +
      '<span class="footer-sep" aria-hidden="true">·</span>' +
      '<span class="footer-saigon">Made with &#10084;&#65039; from Saigon ' +
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

  // Fill the footer mini-stats bar from light public endpoints and wire the stratum
  // copy button. Independent of branding.js (which owns the brand/social/legal hooks).
  function enhanceFooter() {
    // Network / fee / min withdrawal — /api/config/pool-info is unauthenticated + cheap.
    fetch('/api/config/pool-info', { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (!d) return;
        if (d.network) showStat('.footer-net', (d.network === 'testnet' ? 'Testnet' : 'Mainnet'));
        if (d.network === 'testnet') showTestnetBanner();
        if (d.pool_fee_percent != null) showStat('.footer-fee', 'Fee ' + d.pool_fee_percent + '%');
        if (d.min_withdrawal != null) showStat('.footer-min', 'Min payout ' + d.min_withdrawal + ' GRIN');
      })
      .catch(function () {});

    // GRIN price (cached server-side). Footer ticker only — hidden when unavailable.
    fetch('/api/public/price', { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        var d = j && j.data;
        if (!d || !d.available) return;
        var parts = [];
        if (typeof d.usd === 'number') parts.push('$' + d.usd.toFixed(4));
        if (typeof d.btc === 'number') parts.push(d.btc.toFixed(8) + ' BTC');
        if (parts.length) showStat('.footer-price', 'GRIN ' + parts.join(' / '));
      })
      .catch(function () {});

    // Copy the stratum address (branding.js fills the <code> text).
    var copyBtn = footer.querySelector('.footer-copy');
    if (copyBtn) {
      copyBtn.addEventListener('click', function () {
        var code = footer.querySelector('[data-brand="stratum_url"]');
        var val = code && code.textContent.trim();
        if (!val) return;
        var done = function () {
          var prev = copyBtn.textContent;
          copyBtn.textContent = 'copied';
          setTimeout(function () { copyBtn.textContent = prev; }, 1500);
        };
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(val).then(done, done);
        } else { done(); }
      });
    }
  }

  function showStat(sel, text) {
    var el = footer.querySelector(sel);
    if (!el) return;
    el.textContent = text;
    el.hidden = false;
  }

  // Sticky TESTNET banner so visitors never mistake test tGRIN for real coins. Idempotent;
  // uses the existing .testnet-banner CSS (css/pool.css). Pushes the header down via the
  // body.has-testnet-banner rule.
  function showTestnetBanner() {
    if (document.querySelector('.testnet-banner')) return;
    var b = document.createElement('div');
    b.className = 'testnet-banner';
    b.setAttribute('role', 'status');
    b.textContent = '⚠ TESTNET — coins here are test tGRIN with no real value.';
    document.body.insertBefore(b, document.body.firstChild);
    document.body.classList.add('has-testnet-banner');
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

  function mount() {
    // Remove any legacy hardcoded chrome a page might still carry (defensive —
    // converted pages ship none), then inject the canonical header/footer.
    document.querySelectorAll('body > header, body > footer').forEach(function (el) { el.remove(); });
    document.body.insertBefore(header, document.body.firstChild);
    // Header ad slot directly after the header.
    header.insertAdjacentElement('afterend', adSlot('header'));
    // Footer ad slot directly before the footer.
    document.body.appendChild(adSlot('footer'));
    document.body.appendChild(footer);
    startBrandSwing();
    wireNavGroups();
    enhanceFooter();

    // Load the ad renderer once (it fills every [data-ad-slot] on the page).
    if (!document.getElementById('ads-js')) {
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
