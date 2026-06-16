/* ============================================================================
   public-shell.js — shared PUBLIC chrome (header + footer)   [added 2026-06]
   ----------------------------------------------------------------------------
   Single source of truth for the public site header and footer, mirroring what
   admin-shell.js does for the admin panel. Each public page now ships ONLY its
   own content (the <div class="wrap"> body); this script injects the <header>
   (brand + nav + theme switcher + "Start Mining") and the <footer> SYNCHRONOUSLY
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
    { href: 'miners-stats.html',     label: 'Miners' },
    { href: 'payment-history.html',  label: 'Payouts' },
    { href: 'fortune-board.html',    label: 'Fortune Board' },
    { href: 'account-settings.html', label: 'Account' }
  ];

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
      '<a class="btn primary sm" href="index.html#connect">Start Mining</a>' +
    '</div>';

  var footer = document.createElement('footer');
  footer.innerHTML =
    '<p data-brand="footer_text">GRINIUM — Grin Mining Pool | Professional • Reliable • Secure</p>' +
    '<div data-brand="page-links"></div>' +
    '<p style="opacity:0.7;font-size:0.95em;margin-top:6px;">' +
      '<span data-brand="attribution">Powered by the ' +
        '<a href="https://github.com/noobvie/Grin-Node-Toolkit" target="_blank" rel="noopener noreferrer">Grin Node Toolkit</a>' +
      '</span>' +
      '<span class="footer-donate" style="margin-left:1rem;">' +
        '<a href="donate.html">Donate — support us via mining</a>' +
      '</span>' +
    '</p>';

  function mount() {
    // Remove any legacy hardcoded chrome a page might still carry (defensive —
    // converted pages ship none), then inject the canonical header/footer.
    document.querySelectorAll('body > header, body > footer').forEach(function (el) { el.remove(); });
    document.body.insertBefore(header, document.body.firstChild);
    document.body.appendChild(footer);
  }

  if (document.body) {
    mount();
  } else {
    document.addEventListener('DOMContentLoaded', mount);
  }
})();
