// admin-nav.js — shared left-sidebar navigation for the pool admin panel.
//
// The admin pages (index/miners/blocks/payments/users/health/settings) are static HTML served by
// nginx with no server-side templating, so the sidebar is injected here once and included on
// every page instead of being duplicated into each file. This replaces the old per-page top
// nav (which had a redundant Dashboard/Admin pair and no link to Settings, so Security and
// Incentives — which live in settings.html tabs — were unreachable from the dashboard).
//
// Behaviour:
//   · injects <aside class="sidebar"> with brand + primary links + a Settings group whose
//     sub-links deep-link into settings.html tabs via the URL hash (#access, #incentives, …)
//   · keeps a #nav-user element so API.guardAdminPage() can inject the username + Logout
//   · exposes only a Dark/Light chrome toggle (data-theme buttons that theme.js auto-wires) —
//     the old 5-theme admin switcher is gone
//
// Loaded BEFORE each page's inline script. Injection is synchronous (admin scripts sit at the
// end of <body>, so document.body exists); guardAdminPage awaits a fetch before touching
// #nav-user, so the element is always present in time.

(function () {
  'use strict';

  // Primary destinations (separate pages).
  var PRIMARY = [
    { href: '/admin/',             file: 'index',    icon: '◈', label: 'Dashboard' },
    { href: '/admin/miners.html',  file: 'miners',   icon: '⛏', label: 'Miners' },
    { href: '/admin/blocks.html',  file: 'blocks',   icon: '🧱', label: 'Blocks' },
    { href: '/admin/payments.html',file: 'payments', icon: '💸', label: 'Payments' },
    { href: '/admin/users.html',   file: 'users',    icon: '👥', label: 'Users' },
    { href: '/admin/health.html',  file: 'health',   icon: '🩺', label: 'Health' }
  ];

  // Settings sub-sections — each deep-links into a settings.html tab via hash (see switchTab).
  var SETTINGS = [
    { tab: 'pool-info',     label: 'Pool Info' },
    { tab: 'branding',      label: 'Branding (Logo/Slogan)' },
    { tab: 'seo',           label: 'SEO' },
    { tab: 'analytics',     label: 'Analytics' },
    { tab: 'pages',         label: 'Pages' },
    { tab: 'announcements', label: 'Announcements' },
    { tab: 'payout',        label: 'Payout' },
    { tab: 'incentives',    label: 'Incentives' },
    { tab: 'access',        label: 'Security' },
    { tab: 'alerts',        label: 'Alerts' },
    { tab: 'database',      label: 'Database' }
  ];

  function currentFile() {
    var path = (location.pathname || '/').replace(/\/+$/, '/');
    if (path === '/admin/' || path === '/admin' || /\/admin\/index\.html$/.test(path)) return 'index';
    var m = path.match(/\/admin\/([a-z0-9_-]+)\.html$/i);
    return m ? m[1].toLowerCase() : '';
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function build() {
    if (document.getElementById('admin-sidebar')) return; // already injected
    var here = currentFile();
    var onSettings = here === 'settings';
    var activeTab = onSettings ? (location.hash.replace(/^#/, '') || 'pool-info') : '';

    var html = '';
    html += '<a class="sidebar-brand" href="/admin/" aria-label="Pool Admin home">';
    html += '<img class="brand-logo" src="/images/logo.svg" alt="" aria-hidden="true">';
    html += '<span class="sidebar-brand-text"><strong id="sidebar-pool-name">GRINIUM</strong>'
          + '<small>Admin Panel</small></span></a>';

    html += '<nav class="sidebar-nav" aria-label="Admin sections">';
    PRIMARY.forEach(function (item) {
      var cls = (here === item.file) ? ' class="active"' : '';
      html += '<a href="' + item.href + '"' + cls + '>'
            + '<span class="sidebar-icon" aria-hidden="true">' + item.icon + '</span>'
            + esc(item.label) + '</a>';
    });

    html += '<div class="sidebar-section-title">Settings</div>';
    SETTINGS.forEach(function (s) {
      var cls = (onSettings && activeTab === s.tab) ? ' class="sidebar-sub active"' : ' class="sidebar-sub"';
      html += '<a href="/admin/settings.html#' + s.tab + '"' + cls + '>' + esc(s.label) + '</a>';
    });
    html += '</nav>';

    html += '<div class="sidebar-footer">';
    html += '<div class="theme-toggle" role="group" aria-label="Admin theme">'
          + '<button type="button" data-theme="dark" title="Dark">☾ Dark</button>'
          + '<button type="button" data-theme="light" title="Light">☀ Light</button></div>';
    html += '<div class="sidebar-user"><span id="nav-user"></span></div>';
    html += '</div>';

    var aside = document.createElement('aside');
    aside.className = 'sidebar';
    aside.id = 'admin-sidebar';
    aside.innerHTML = html;
    document.body.insertBefore(aside, document.body.firstChild);
    document.body.classList.add('has-sidebar');

    // Keep the Settings sub-link highlight in sync as the operator switches tabs in-page.
    if (onSettings) {
      window.addEventListener('hashchange', function () {
        var tab = location.hash.replace(/^#/, '') || 'pool-info';
        aside.querySelectorAll('a.sidebar-sub').forEach(function (a) {
          a.classList.toggle('active', a.getAttribute('href') === '/admin/settings.html#' + tab);
        });
      });
    }

    // Best-effort: show the operator's configured pool name in the brand.
    fetch('/api/pool/stats').then(function (r) { return r.json(); }).then(function (d) {
      if (d && d.pool_name) {
        var el = document.getElementById('sidebar-pool-name');
        if (el) el.textContent = d.pool_name;
      }
    }).catch(function () {});
  }

  if (document.body) build();
  else document.addEventListener('DOMContentLoaded', build);
})();
