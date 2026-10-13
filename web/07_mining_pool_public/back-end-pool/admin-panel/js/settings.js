// settings.html page script.
// Classic script (no defer/module) loaded after the <script src> tags before it, whose globals it uses.
  // Settings is one file per section. Preserve any
  // legacy deep-link: /admin/settings.html#access → /admin/settings-access.html.
  (function () {
    var TABS = ['pool-info','branding','seo','analytics','announcements',
                'payout','incentives','access','database'];  // 'alerts' removed — audit §J8-3
    var tab = (location.hash || '').replace(/^#/, '');
    // Pages is a standalone CMS CRUD page (not a settings section).
    if (tab === 'pages') { location.replace('/admin/pages.html'); return; }
    var target = (TABS.indexOf(tab) >= 0) ? tab : 'pool-info';
    location.replace('/admin/settings-' + target + '.html');
  })();
