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
  var NAV = [
    { href: 'index.html',            label: 'Dashboard' },
    { href: 'miners-stats.html',     label: 'Pool Stats' },
    { href: 'account-settings.html', label: 'My Stats' },
    { href: 'blocks.html',           label: 'Blocks' },
    { href: 'payment-history.html',  label: 'Payouts' },
    { href: 'fortune-board.html',    label: 'Fortune Board' }
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

  var navLinks = NAV.map(function (l) {
    var active = fileOf(l.href) === here ? ' active' : '';
    return '<a href="' + l.href + '" class="nav-link' + active + '">' + esc(l.label) + '</a>';
  }).join('');

  // ── Header: byte-identical to the old per-page markup so existing CSS and
  //    branding.js hooks (.brand / [data-brand="pool_name"] / .header-nav /
  //    .theme-switcher) keep working unchanged. ──────────────────────────────
  var header = document.createElement('header');
  header.innerHTML =
    '<div class="brand">' +
      '<img class="brand-logo" src="/images/logo.svg" alt="" aria-hidden="true">' +
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
  var YEAR = new Date().getFullYear();

  // Pool column reuses the canonical NAV (no anchor stays active in the footer), minus
  // Blog — it lives in the Resources column below to avoid a duplicate link.
  var poolCol = NAV.filter(function (l) { return fileOf(l.href) !== 'blog.html'; })
    .map(function (l) {
      return '<a href="' + l.href + '">' + esc(l.label) + '</a>';
    }).join('');

  var GITHUB = 'https://github.com/noobvie/Grin-Node-Toolkit';

  var footer = document.createElement('footer');
  footer.innerHTML =
    '<div class="footer-cols">' +
      // Brand + tagline + social
      '<div class="footer-col footer-brand">' +
        '<div class="brand">' +
          '<img class="brand-logo" src="/images/logo.svg" alt="" aria-hidden="true">' +
          '<span data-brand="pool_name">GRINIUM</span>' +
        '</div>' +
        '<p class="footer-tagline" data-brand="pool_tagline">Mine Grin, anywhere</p>' +
        '<div class="footer-social">' +
          '<a data-brand="social-twitter" href="#" target="_blank" rel="noopener" style="display:none">Twitter / X</a>' +
          '<a data-brand="social-discord" href="#" target="_blank" rel="noopener" style="display:none">Discord</a>' +
          '<a data-brand="social-telegram" href="#" target="_blank" rel="noopener" style="display:none">Telegram</a>' +
          '<a data-brand="social-website" href="#" target="_blank" rel="noopener" style="display:none">Website</a>' +
        '</div>' +
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
        '<div data-brand="page-links"></div>' +
        '<a class="footer-contact" data-brand="contact-link" href="#" style="display:none">Contact</a>' +
        '<a class="footer-forum" data-brand="forum-link" href="#" target="_blank" rel="noopener nofollow" style="display:none">Community (Grin forum)</a>' +
        '<a href="donate.html">Donate</a>' +
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
      '<p class="footer-copyright" data-brand="copyright">© ' + YEAR + ' GRINIUM</p>' +
      '<p data-brand="footer_text">Grin Mining Pool — Professional • Reliable • Secure</p>' +
      '<p class="footer-meta">' +
        '<span data-brand="attribution">Powered by the ' +
          '<a href="' + GITHUB + '" target="_blank" rel="noopener noreferrer">Grin Node Toolkit</a>' +
        '</span>' +
        '<span class="footer-security" data-brand-show="security" style="display:none">' +
          ' · Security: <a data-brand="security-link" href="#"></a>' +
          '<a class="footer-pgp" data-brand="pgp-link" href="#" target="_blank" rel="noopener" style="display:none"> (PGP)</a>' +
        '</span>' +
      '</p>' +
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
