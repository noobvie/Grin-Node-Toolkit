/* ============================================================================
   admin-shell.js — shared admin chrome (sidebar + topbar)  [rebuilt 2026-06]
   ----------------------------------------------------------------------------
   Single source of truth for the admin navigation. Each admin page ships only
   its <main> content; this script injects the left sidebar, the top bar, the
   theme toggle (Dark/Light only), the testnet banner, and the username/Logout
   slot (#nav-user, populated by API.guardAdminPage in the page's own script).

   Load order on every page:  api.js  →  admin-shell.js  →  <page inline script>
   so #nav-user exists before guardAdminPage() runs. Runs immediately (the script
   tag sits at the end of <body>, so <main> already exists) — no DOMContentLoaded.

   To add/rename/reorder a nav item, edit NAV here, once.
   ========================================================================== */
(function () {
  'use strict';

  // ── Canonical admin navigation ──────────────────────────────────────────
  var NAV = [
    { file: 'index.html',    title: 'Dashboard',     ico: '📊' },
    { file: 'miners.html',   title: 'Miners',        ico: '⛏'  },
    { file: 'payments.html', title: 'Payouts',       ico: '💸' },
    { file: 'users.html',    title: 'Users',         ico: '👥' },
    { file: 'health.html',   title: 'System Health', ico: '🩺' },
    { file: 'settings.html', title: 'Settings',      ico: '⚙'  }
  ];

  function currentFile() {
    var f = (location.pathname || '/').split('/').pop();
    if (!f || f === '' ) return 'index.html';
    return f.replace(/[?#].*$/, '');
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // ── Theme (Dark default, Light) ─────────────────────────────────────────
  // Own key — must NOT be 'admin-theme': branding.js writes the operator's public
  // default_theme (e.g. "atomic") to that key on every public page, which would
  // clobber this Dark/Light toggle and silently reset it to Dark.
  var THEME_KEY = 'admin-ui-mode';
  function getTheme() {
    var t = null;
    try { t = localStorage.getItem(THEME_KEY); } catch (e) {}
    return (t === 'light' || t === 'dark') ? t : 'dark';
  }
  function applyTheme(t) {
    document.documentElement.setAttribute('data-theme', t);
    try { localStorage.setItem(THEME_KEY, t); } catch (e) {}
    var btn = document.getElementById('admin-theme-toggle');
    if (btn) btn.innerHTML = (t === 'dark')
      ? '<span class="nav-ico">☀️</span> Light mode'
      : '<span class="nav-ico">🌙</span> Dark mode';
  }
  // Apply early so there's no flash of the wrong theme.
  applyTheme(getTheme());

  // ── Build the chrome ────────────────────────────────────────────────────
  var here = currentFile();
  var active = NAV.filter(function (n) { return n.file === here; })[0] || NAV[0];

  var navHtml = NAV.map(function (n) {
    return '<a href="' + n.file + '"' + (n.file === here ? ' class="active"' : '') + '>' +
             '<span class="nav-ico">' + n.ico + '</span>' + esc(n.title) +
           '</a>';
  }).join('');

  var sidebar = document.createElement('aside');
  sidebar.className = 'admin-sidebar';
  sidebar.innerHTML =
    '<a class="admin-brand" href="index.html">' +
      '<span class="brand-mark">⛏</span>' +
      '<span><span class="brand-name">Grin Pool</span><br>' +
      '<span class="brand-sub">Admin</span></span>' +
    '</a>' +
    '<nav class="admin-nav">' + navHtml + '</nav>' +
    '<div class="admin-sidebar-foot">' +
      '<a href="/" target="_blank" rel="noopener"><span class="nav-ico">↗</span> Public site</a>' +
      '<button type="button" id="admin-theme-toggle"></button>' +
    '</div>';

  var topbar = document.createElement('header');
  topbar.className = 'admin-topbar';
  topbar.innerHTML =
    '<button type="button" class="admin-burger" aria-label="Menu">☰</button>' +
    '<div class="admin-page-title">' + esc(active.title) + '</div>' +
    '<div class="spacer"></div>' +
    '<span class="admin-pill testnet" id="admin-testnet-pill" style="display:none">TESTNET</span>' +
    '<div class="admin-user"><span id="nav-user"></span></div>';

  var scrim = document.createElement('div');
  scrim.className = 'admin-scrim';

  // ── Mount: wrap the existing <main> in .admin-main, prepend the topbar ───
  function mount() {
    var main = document.querySelector('main');
    var wrap = document.createElement('div');
    wrap.className = 'admin-main';

    if (main && main.parentNode) {
      main.parentNode.insertBefore(wrap, main);
      wrap.appendChild(topbar);
      wrap.appendChild(main);
    } else {
      // No <main> (shouldn't happen) — still render the chrome with an empty body.
      wrap.appendChild(topbar);
      document.body.appendChild(wrap);
    }
    document.body.insertBefore(sidebar, document.body.firstChild);
    document.body.appendChild(scrim);

    // Remove any leftover legacy chrome a page might still carry.
    document.querySelectorAll('body > header:not(.admin-topbar), body > footer, .testnet-banner')
      .forEach(function (el) { if (!el.closest('.admin-main')) el.remove(); });

    applyTheme(getTheme());

    // Wire interactions
    document.getElementById('admin-theme-toggle').addEventListener('click', function () {
      applyTheme(getTheme() === 'dark' ? 'light' : 'dark');
    });
    var burger = topbar.querySelector('.admin-burger');
    function closeDrawer() { document.body.classList.remove('admin-drawer-open'); }
    burger.addEventListener('click', function () {
      document.body.classList.toggle('admin-drawer-open');
    });
    scrim.addEventListener('click', closeDrawer);
    sidebar.querySelectorAll('.admin-nav a').forEach(function (a) {
      a.addEventListener('click', closeDrawer);
    });

    // Page title in the browser tab + topbar pool name
    decoratePoolIdentity();
  }

  // ── Pool name + testnet detection (was duplicated in every page's IIFE) ──
  function decoratePoolIdentity() {
    fetch('/api/pool/stats').then(function (r) { return r.json(); }).then(function (d) {
      if (!d) return;
      if (d.pool_name) {
        var bn = sidebar.querySelector('.brand-name');
        if (bn) bn.textContent = d.pool_name;
      }
      if (d.network === 'testnet') {
        var pill = document.getElementById('admin-testnet-pill');
        if (pill) pill.style.display = '';
        if (!/^\[TESTNET\]/.test(document.title)) document.title = '[TESTNET] ' + document.title;
      }
    }).catch(function () {});
  }

  // Body already parsed up to this script (end of <body>), so mount now.
  if (document.querySelector('main')) {
    mount();
  } else {
    document.addEventListener('DOMContentLoaded', mount);
  }
})();
