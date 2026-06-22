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
  // A flat list rendered against a single vertical rail (no section headers). A
  // `children` array (each `{file,title}`) turns an entry into an always-expanded
  // group of real sub-pages, nested one level deeper on their own rail; the parent
  // is active whenever you're on it OR any child file. Edit NAV here, once.
  var NAV = [
    // Dashboard is the overview group: all the live data pages + System Health hang off it.
    { file: 'index.html', title: 'Dashboard', ico: '📊', children: [
        { file: 'miners.html',   title: 'Miners' },
        { file: 'payments.html', title: 'Payouts' },
        { file: 'blocks.html',   title: 'Blocks' },
        { file: 'users.html',    title: 'Users' },
        { file: 'regions.html',  title: 'Regions' },
        { file: 'health.html',   title: 'System Health' }
      ] },
    // Settings was split into one file per section (2026-06). A `children` array with `file`
    // entries renders an always-expanded group of real pages (no more #hash tabs); the parent
    // is active whenever you're on the parent OR any child page. Ads lives here too (it's
    // operator config — a content/monetization surface alongside Pages/Announcements).
    { file: 'settings-pool-info.html', title: 'Settings', ico: '⚙', children: [
        { file: 'settings-pool-info.html',     title: 'Pool Info' },
        { file: 'settings-branding.html',      title: 'Branding' },
        { file: 'settings-seo.html',           title: 'SEO' },
        { file: 'settings-analytics.html',     title: 'Analytics' },
        { file: 'pages.html',                  title: 'Pages' },
        { file: 'posts.html',                  title: 'Blog' },
        { file: 'settings-announcements.html', title: 'Announcements' },
        { file: 'ads.html',                    title: 'Ads' },
        { file: 'settings-payout.html',        title: 'Payout' },
        { file: 'settings-incentives.html',    title: 'Incentives' },
        { file: 'settings-access.html',        title: 'Access Control' },
        { file: 'settings-alerts.html',        title: 'Alerts' },
        { file: 'settings-database.html',      title: 'Database' }
      ] }
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

  // Is `here` the parent or any child file of a group entry?
  function onGroup(n) {
    if (n.file === here) return true;
    return !!(n.children && n.children.some(function (c) { return c.file === here; }));
  }

  // Resolve the topbar title: a matching child's title takes precedence (so a settings
  // sub-page shows e.g. "Access Control"), else the matching top-level entry, else Dashboard.
  function resolveActive() {
    for (var i = 0; i < NAV.length; i++) {
      var n = NAV[i];
      if (n.children) {
        for (var j = 0; j < n.children.length; j++) {
          if (n.children[j].file === here) return { title: n.children[j].title };
        }
      }
      if (n.file === here) return n;
    }
    return NAV[0];
  }
  var active = resolveActive();

  function navHtmlFor() {
    return NAV.map(function (n) {
      var onPage = n.file === here;
      if (!n.children) {
        return '<a href="' + n.file + '"' + (onPage ? ' class="active"' : '') + '>' +
                 '<span class="nav-ico">' + n.ico + '</span>' + esc(n.title) +
               '</a>';
      }
      // Group of real sub-pages, ALWAYS expanded (not collapsible) — the children stay
      // visible and indented so the hierarchy is obvious. The parent is active when you're
      // on it or any child page.
      var grpOpen = onGroup(n);
      var sub = n.children.map(function (c) {
        var act = (c.file === here) ? ' class="active"' : '';
        return '<a href="' + c.file + '"' + act + '>' + esc(c.title) + '</a>';
      }).join('');
      return '<div class="admin-nav-group open">' +
               '<a href="' + n.file + '" class="admin-nav-parent' + (grpOpen ? ' active' : '') + '">' +
                 '<span class="nav-ico">' + n.ico + '</span>' + esc(n.title) +
               '</a>' +
               '<div class="admin-subnav">' + sub + '</div>' +
             '</div>';
    }).join('');
  }
  var navHtml = navHtmlFor();

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
    '<button type="button" class="admin-refresh" id="admin-refresh" title="Reload this page">' +
      '<span class="ico">↻</span> Refresh</button>' +
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

    // Persist the sidebar scroll position across full-page navigations. Each admin page
    // is its own HTML file, so the sidebar is rebuilt on every load and would otherwise
    // jump back to the top — annoying when clicking a deep item (e.g. Settings → Database).
    // The nav is identical on every page, so restoring scrollTop keeps it visually stable.
    var navEl = sidebar.querySelector('.admin-nav');
    if (navEl) {
      try {
        var saved = sessionStorage.getItem('admin-nav-scroll');
        if (saved != null) navEl.scrollTop = parseInt(saved, 10) || 0;
      } catch (e) {}
      var ticking = false;
      navEl.addEventListener('scroll', function () {
        if (ticking) return;
        ticking = true;
        requestAnimationFrame(function () {
          try { sessionStorage.setItem('admin-nav-scroll', String(navEl.scrollTop)); } catch (e) {}
          ticking = false;
        });
      });
    }

    // Remove any leftover legacy chrome a page might still carry.
    document.querySelectorAll('body > header:not(.admin-topbar), body > footer, .testnet-banner')
      .forEach(function (el) { if (!el.closest('.admin-main')) el.remove(); });

    applyTheme(getTheme());

    // Wire interactions
    document.getElementById('admin-theme-toggle').addEventListener('click', function () {
      applyTheme(getTheme() === 'dark' ? 'light' : 'dark');
    });
    var refreshBtn = document.getElementById('admin-refresh');
    if (refreshBtn) refreshBtn.addEventListener('click', function () { location.reload(); });
    var burger = topbar.querySelector('.admin-burger');
    function closeDrawer() { document.body.classList.remove('admin-drawer-open'); }
    burger.addEventListener('click', function () {
      document.body.classList.toggle('admin-drawer-open');
    });
    scrim.addEventListener('click', closeDrawer);
    sidebar.querySelectorAll('.admin-nav a').forEach(function (a) {
      a.addEventListener('click', closeDrawer);
    });

    // Nav groups are always expanded (non-collapsible), so there's no caret to wire.

    // Settings sub-links are now real pages (not hash tabs), so the active sub-link is
    // baked in at render time — no hashchange sync needed.

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
