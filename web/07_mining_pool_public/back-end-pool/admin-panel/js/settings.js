// settings.html page script — moved BYTE-verbatim out of the page's inline script block (code-layout F5).
// Classic script (no defer/module) loaded at the same position as the old block, after the <script src> tags before it, whose globals it uses (H14).
  // The monolithic settings page was split into one file per section (2026-06). Preserve any
  // legacy deep-link: /admin/settings.html#access → /admin/settings-access.html.
  (function () {
    var TABS = ['pool-info','branding','seo','analytics','announcements',
                'payout','incentives','access','database'];  // 'alerts' removed — audit §J8-3
    var tab = (location.hash || '').replace(/^#/, '');
    // Pages became a standalone CMS CRUD page (no longer a settings section).
    if (tab === 'pages') { location.replace('/admin/pages.html'); return; }
    var target = (TABS.indexOf(tab) >= 0) ? tab : 'pool-info';
    location.replace('/admin/settings-' + target + '.html');
  })();
