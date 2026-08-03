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
        { file: 'users.html',    title: 'Sessions' },
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

  // ── Chain explorer deep-links (window.Explorer) ─────────────────────────
  // Any block height / hash / kernel / output shown anywhere in the admin UI links out
  // to a public Grin chain explorer in a new tab.
  //
  // ONE deterministic explorer per network — deliberately NOT randomized across two. The
  // earlier 50/50 rotation assumed the two explorers shared a path scheme; they do not
  // (verified live 2026-07-25), so every link that landed on grinscan.org 404'd, and the
  // rotation is what hid it — half the clicks worked. The two schemes:
  //   scan.grin.money    /block/<h>           /kernel/<excess>          /output/<commit>
  //   *.grinscan.org     /block.html?h=<h>    /kernel.html?ex=<excess>  /output.html?c=<commit>
  // Both accept a height OR a 64-hex block hash in the block slot.
  //
  // Default: mainnet → scan.grin.money (06d Tiny Explorer), testnet → test.grinscan.org
  // (06b GrinScan's testnet sibling). NOTE the testnet host is `test.` —
  // `testnet.grinscan.org` does NOT resolve (that typo made every testnet link dead).
  // Keep this block in sync with the identical one in /js/branding.js.
  //
  // Network is resolved once by decoratePoolIdentity() (below) and cached in
  // sessionStorage; until then we assume mainnet (the common deployment).
  var NETWORK_KEY = 'pool-network';
  function explorerNetwork() {
    try { var n = sessionStorage.getItem(NETWORK_KEY); if (n) return n; } catch (e) {}
    return 'mainnet';
  }
  var EXPLORER_STYLES = {
    path:  { block: 'block/',        kernel: 'kernel/',         output: 'output/' },
    query: { block: 'block.html?h=', kernel: 'kernel.html?ex=', output: 'output.html?c=' }
  };
  var EXPLORERS = {
    tiny:             { base: 'https://scan.grin.money',  style: 'path'  }, // 06d, mainnet only
    grinscan:         { base: 'https://grinscan.org',      style: 'query' }, // 06b mainnet
    grinscan_testnet: { base: 'https://test.grinscan.org', style: 'query' }  // 06b testnet sibling
  };
  var DEFAULT_EXPLORER = { mainnet: 'tiny', testnet: 'grinscan_testnet' };
  function explorerPick() {
    var net = explorerNetwork() === 'testnet' ? 'testnet' : 'mainnet';
    return EXPLORERS[DEFAULT_EXPLORER[net]] || EXPLORERS.tiny;
  }
  function explorerUrl(kind, value) {
    var ex = explorerPick();
    var style = EXPLORER_STYLES[ex.style] || EXPLORER_STYLES.path;
    var seg = (kind === 'kernel') ? style.kernel : (kind === 'output') ? style.output : style.block;
    return ex.base.replace(/\/+$/, '') + '/' + seg + encodeURIComponent(String(value));
  }
  // Returns an <a> that opens the explorer in a new tab. `label` defaults to `value`.
  // Both URL and label are HTML-escaped — safe to embed untrusted chain strings.
  function explorerLink(kind, value, label, cls) {
    if (value == null || value === '') return esc(label == null ? '' : label);
    return '<a href="' + esc(explorerUrl(kind, value)) + '" target="_blank" rel="noopener"' +
      (cls ? ' class="' + esc(cls) + '"' : '') +
      ' title="Open on Grin chain explorer ↗">' +
      esc(label == null ? value : label) + '</a>';
  }
  window.Explorer = { url: explorerUrl, link: explorerLink, network: explorerNetwork };

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

    // In-page section navigation for the long pages (payments, ads, settings-*)
    buildSectionRail(wrap, main);

    // Page title in the browser tab + topbar pool name
    decoratePoolIdentity();
  }

  /* ── In-page section rail ─────────────────────────────────────────────────
     Several admin pages (payments, ads, health, the bigger settings pages) are
     several screens tall, so once you scroll there is nothing left on screen
     saying which part you're in. This builds a sticky strip of section chips
     directly under the topbar: scroll-spy marks the current one, clicking jumps.

     It is AUTOMATIC — no page ships a hand-written table of contents. Sections
     are detected from the two heading idioms already in use:
       • data pages     → <h2> inside <main>
       • settings pages → .section-title (the card headings)
     A heading opts out with data-nosection, and overrides its chip label with
     data-sec="Short label" (the heading itself can stay long/descriptive).
     Fewer than 2 sections → no rail at all, so the short pages stay clean. */
  var RAIL_MIN_SECTIONS = 2;

  function slugify(s) {
    var base = String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    return 'sec-' + (base.slice(0, 44) || 'section');
  }

  // Chip label: an explicit data-sec wins; otherwise the heading's own leading text,
  // skipping nested <span>/<small> (those hold live counters like "3 pending", which
  // are empty at build time and would otherwise leak into the chip once filled).
  function headingLabel(el) {
    var explicit = el.getAttribute('data-sec');
    if (explicit) return explicit;
    var t = '';
    for (var n = el.firstChild; n; n = n.nextSibling) {
      if (n.nodeType === 3) t += n.nodeValue;
      else if (n.nodeType === 1 && n.tagName !== 'SPAN' && n.tagName !== 'SMALL') t += n.textContent;
    }
    t = t.replace(/\s+/g, ' ').trim();
    return t || String(el.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function buildSectionRail(wrap, main) {
    if (!main) return;
    var heads = [].slice.call(main.querySelectorAll('h2, .section-title'))
      .filter(function (el) { return !el.hasAttribute('data-nosection') && headingLabel(el); });
    if (heads.length < RAIL_MIN_SECTIONS) return;

    var rail = document.createElement('nav');
    rail.className = 'admin-rail';
    rail.setAttribute('aria-label', 'Page sections');
    var inner = document.createElement('div');
    inner.className = 'admin-rail-inner';
    rail.appendChild(inner);

    var used = {};
    heads.forEach(function (el) {
      if (!el.id) {
        var id = slugify(headingLabel(el)), i = 2;
        while (used[id] || document.getElementById(id)) { id = slugify(headingLabel(el)) + '-' + (i++); }
        el.id = id;
      }
      used[el.id] = true;
      el.classList.add('is-section');
      var a = document.createElement('a');
      a.className = 'rail-chip';
      a.href = '#' + el.id;
      a.textContent = headingLabel(el);
      inner.appendChild(a);
    });

    // The first section opens the page — it needs no 2.5rem gap above it.
    heads[0].classList.add('sec-first');

    // Sits between the topbar and <main> so `position:sticky; top:var(--topbar-h)`
    // parks it right below the topbar without either overlapping the other.
    wrap.insertBefore(rail, main);

    var chips = [].slice.call(inner.querySelectorAll('.rail-chip'));
    var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    // Scroll/spy against the section's OUTER box where there is one: on the settings
    // pages the heading lives inside a .form-section card, and aligning the heading
    // would leave the card's top edge + padding cut off above the fold.
    var anchors = heads.map(function (el) {
      return (el.closest && el.closest('.form-section')) || el;
    });

    // Chrome height is read live: the topbar/rail can wrap or resize on narrow widths.
    function chromeOffset() { return topbar.offsetHeight + rail.offsetHeight + 14; }

    function jumpTo(i, push) {
      var y = window.pageYOffset + anchors[i].getBoundingClientRect().top - chromeOffset();
      window.scrollTo({ top: Math.max(0, y), behavior: reduceMotion ? 'auto' : 'smooth' });
      // replaceState, not a real hash jump: the browser would scroll the heading under
      // the sticky chrome, and pushState would bury the page in back-button history.
      if (push) { try { history.replaceState(null, '', '#' + heads[i].id); } catch (e) {} }
    }

    chips.forEach(function (a, i) {
      a.addEventListener('click', function (e) {
        e.preventDefault();
        jumpTo(i, true);
        // Clicking a section already in place scrolls nowhere, so no scroll event
        // fires and the highlight would stay on the previous chip — mark it here.
        spy();
      });
    });

    // Keep the active chip visible when the rail itself overflows horizontally.
    // Scrolling the rail's own container (not scrollIntoView) so the PAGE never moves.
    function revealChip(a) {
      var pad = 24;
      var left = a.offsetLeft - pad;
      var right = a.offsetLeft + a.offsetWidth + pad;
      if (left < inner.scrollLeft) inner.scrollLeft = left;
      else if (right > inner.scrollLeft + inner.clientWidth) inner.scrollLeft = right - inner.clientWidth;
    }

    var activeIdx = -1;
    function spy() {
      var line = chromeOffset() + 10;
      var idx = 0;
      for (var i = 0; i < anchors.length; i++) {
        if (anchors[i].getBoundingClientRect().top <= line) idx = i; else break;
      }
      // At the very bottom the last section may be too short to ever cross the line.
      // documentElement, not body: body's own box can be shorter than the scrollable
      // page, which would make this fire early (or never) depending on the page.
      if (window.innerHeight + window.pageYOffset >= document.documentElement.scrollHeight - 4) {
        idx = heads.length - 1;
      }
      if (idx === activeIdx) return;
      if (chips[activeIdx]) {
        chips[activeIdx].classList.remove('active');
        chips[activeIdx].removeAttribute('aria-current');
      }
      activeIdx = idx;
      chips[idx].classList.add('active');
      chips[idx].setAttribute('aria-current', 'true');
      revealChip(chips[idx]);
    }

    var ticking = false;
    function onScroll() {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(function () { spy(); toggleTopBtn(); ticking = false; });
    }
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);

    // Long page → offer a way back without a scroll marathon. Only ever created
    // alongside the rail, so short pages don't grow a floating button.
    var topBtn = document.createElement('button');
    topBtn.type = 'button';
    topBtn.className = 'admin-top-btn';
    topBtn.setAttribute('aria-label', 'Back to top');
    topBtn.innerHTML = '↑';
    topBtn.addEventListener('click', function () {
      window.scrollTo({ top: 0, behavior: reduceMotion ? 'auto' : 'smooth' });
    });
    document.body.appendChild(topBtn);
    function toggleTopBtn() {
      topBtn.classList.toggle('is-on', window.pageYOffset > 700);
    }

    // Deep link (#section) — re-run the jump ourselves so the heading clears the
    // sticky chrome instead of hiding behind it.
    if (location.hash) {
      var hashId = location.hash.slice(1);
      for (var h = 0; h < heads.length; h++) {
        if (heads[h].id === hashId) { (function (k) { setTimeout(function () { jumpTo(k, false); }, 60); })(h); break; }
      }
    }
    spy();
    toggleTopBtn();
  }

  // ── Pool name + testnet detection (was duplicated in every page's IIFE) ──
  function decoratePoolIdentity() {
    fetch('/api/pool/stats').then(function (r) { return r.json(); }).then(function (d) {
      if (!d) return;
      // Cache the chain so window.Explorer builds testnet-correct deep-links.
      if (d.network) { try { sessionStorage.setItem(NETWORK_KEY, d.network); } catch (e) {} }
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

  /* ── AdminTable — search + paging + retention note for list tables ────────
     Every history/audit table in the admin panel had the same three problems:
     it dumped the entire result set into the DOM (the miners table can be 500
     rows), it gave no way to find one address/height without Ctrl-F, and it
     never said how long the rows survive — so an empty stretch was ambiguous
     between "nothing happened" and "retention already deleted it".

     One controller solves all three. A page keeps its own fetch + row markup
     and hands the array over:

       var t = AdminTable.create({
         tbody: 'pa-tbody',                 // id or element
         search: 'Search address, origin…', // placeholder (omit → no search box)
         perPage: 20,                       // default 20
         note: 'Kept {days} days.',         // {days} filled from retentionKey
         retentionKey: 'audit_log_keep_days',
         row:  function (e) { return '<tr>…</tr>'; },
         text: function (e) { return e.grin_address + ' ' + e.action; }, // searchable
         empty: 'No payout requests in this window.'
       });
       t.setLoading();  t.setRows(list);  t.setError(err.message);

     Notes worth keeping in mind when wiring a new table:
     • Column count is read from the table's own <thead>, so the loading/empty/
       error rows always span correctly — no colspan argument to keep in sync.
     • `text` is optional; the fallback searches the rendered row with tags
       stripped PLUS every title="" value, which is what makes a truncated
       address (full value parked in the title) findable by its full string.
     • setRows() keeps the current query and page — these pages re-poll on a
       timer, and resetting to page 1 mid-read (or wiping what was typed) would
       make the table unusable while it refreshes. */

  var _dbSettings = null;
  function databaseSettings() {
    if (!_dbSettings) {
      var url = '/api/admin/settings/database';
      var p = (window.API && API.get)
        ? API.get(url)
        : fetch(url, { credentials: 'same-origin' }).then(function (r) { return r.json(); });
      _dbSettings = p.then(function (d) { return (d && d.data) || {}; }).catch(function () { return {}; });
    }
    return _dbSettings;
  }

  // Searchable fallback text for a row: visible text + every title="" value (the
  // full address/reason that the visible cell truncates away).
  function rowFallbackText(html) {
    var titles = [];
    String(html).replace(/title="([^"]*)"/g, function (_, v) { titles.push(v); return ''; });
    return (String(html).replace(/<[^>]+>/g, ' ') + ' ' + titles.join(' '))
      .replace(/\s+/g, ' ').toLowerCase();
  }

  var PER_PAGE_CHOICES = [20, 50, 100, 0];   // 0 = All

  function createTable(opts) {
    opts = opts || {};
    var tbody = (typeof opts.tbody === 'string') ? document.getElementById(opts.tbody) : opts.tbody;
    // A missing table must never take the page down with it — hand back a no-op
    // handle so the page's load/refresh code keeps working. It must carry EVERY
    // method of the real handle: pages call setVisible()/setNoteDays() at parse
    // time, so one missing stub would throw before the page script finished and
    // take down the whole page — the exact failure this guard exists to prevent.
    if (!tbody) {
      var noop = function () { return api; };
      var api = {
        setRows: noop, setLoading: noop, setError: noop, refresh: noop,
        setNoteDays: noop, setVisible: noop,
        rows: [], query: ''
      };
      return api;
    }

    var table = tbody.closest('table');
    var cols = (table && table.querySelectorAll('thead th').length) || 1;
    // Anchor: the surrounding .card if there is one, else the table's own wrapper,
    // so the tools sit above the whole card and the pager below it.
    var host = tbody.closest('.card') || tbody.closest('.table-wrap') || table;

    var state = {
      rows: [], q: '', page: 1,
      per: (opts.perPage === 0 || opts.perPage) ? opts.perPage : 20,
      mode: 'loading', err: '', hidden: false
    };

    // ── Tools bar (search + "showing x–y of n" + retention note) ────────────
    var tools = document.createElement('div');
    tools.className = 'table-tools';
    var input = null;
    if (opts.search) {
      var lab = document.createElement('label');
      lab.className = 'table-search';
      input = document.createElement('input');
      input.type = 'search';
      input.placeholder = (typeof opts.search === 'string') ? opts.search : 'Search…';
      input.setAttribute('aria-label', input.placeholder);
      input.autocomplete = 'off';
      lab.appendChild(input);
      tools.appendChild(lab);
    }
    var meta = document.createElement('span');
    meta.className = 'table-meta';
    tools.appendChild(meta);
    var note = document.createElement('span');
    note.className = 'table-note';
    tools.appendChild(note);
    host.parentNode.insertBefore(tools, host);

    // The note is page-authored markup (a link to Settings → Database is common), so it
    // is inserted as HTML — never build one out of user/API text. {days} is filled from
    // the live retention setting, from opts.retentionDays, or later via setNoteDays()
    // for endpoints that report their own window.
    function setNoteDays(days) {
      if (!opts.note) return;
      note.innerHTML = String(opts.note).replace(/\{days\}/g, (days == null || days === '') ? '—' : String(days));
    }
    if (opts.note) {
      setNoteDays(opts.retentionKey ? opts.retentionDefault : opts.retentionDays);
      if (opts.retentionKey) {
        databaseSettings().then(function (s) {
          var v = parseInt(s[opts.retentionKey], 10);
          if (v > 0) setNoteDays(v);
        });
      }
    }

    // ── Pager ───────────────────────────────────────────────────────────────
    var pager = document.createElement('div');
    pager.className = 'table-pager';
    var perSel = document.createElement('select');
    perSel.className = 'pager-per';
    perSel.setAttribute('aria-label', 'Rows per page');
    // A page asking for a size that isn't one of the presets gets it added, so the
    // select never shows "20 / page" while the table is actually rendering something else.
    var choices = (PER_PAGE_CHOICES.indexOf(state.per) === -1)
      ? [state.per].concat(PER_PAGE_CHOICES)
      : PER_PAGE_CHOICES;
    choices.forEach(function (n) {
      var o = document.createElement('option');
      o.value = String(n);
      o.textContent = n ? (n + ' / page') : 'All';
      if (n === state.per) o.selected = true;
      perSel.appendChild(o);
    });
    var nav = document.createElement('div');
    nav.className = 'pager-nav';
    function mkBtn(label, aria) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'pager-btn';
      b.textContent = label;
      b.setAttribute('aria-label', aria);
      nav.appendChild(b);
      return b;
    }
    var bFirst = mkBtn('«', 'First page');
    var bPrev  = mkBtn('‹', 'Previous page');
    var pageLbl = document.createElement('span');
    pageLbl.className = 'pager-page';
    nav.appendChild(pageLbl);
    var bNext = mkBtn('›', 'Next page');
    var bLast = mkBtn('»', 'Last page');
    pager.appendChild(perSel);
    pager.appendChild(nav);
    if (host.nextSibling) host.parentNode.insertBefore(pager, host.nextSibling);
    else host.parentNode.appendChild(pager);

    function fillRow(html, cls) {
      tbody.innerHTML = '<tr class="' + cls + '"><td colspan="' + cols + '">' + html + '</td></tr>';
    }

    function matches(item) {
      var t = opts.text ? String(opts.text(item)).toLowerCase()
                        : rowFallbackText(opts.row(item));
      // Space-separated terms are ANDed — "deny grin1ab" narrows to refused rows
      // for one address without needing the exact column order.
      return state.q.split(/\s+/).every(function (term) { return !term || t.indexOf(term) !== -1; });
    }

    function render() {
      if (state.mode === 'loading') {
        fillRow('<span class="spinner"></span>Loading…', 'loading-row');
        meta.textContent = '';
        pager.style.display = 'none';
        return;
      }
      if (state.mode === 'error') {
        fillRow('Error: ' + esc(state.err), 'empty-row');
        meta.textContent = '';
        pager.style.display = 'none';
        return;
      }
      var all = state.rows;
      var filtered = state.q ? all.filter(matches) : all;
      var total = filtered.length;
      var per = state.per;
      var pages = per ? Math.max(1, Math.ceil(total / per)) : 1;
      if (state.page > pages) state.page = pages;
      if (state.page < 1) state.page = 1;
      var start = per ? (state.page - 1) * per : 0;
      var slice = per ? filtered.slice(start, start + per) : filtered;

      if (!slice.length) {
        fillRow(esc(state.q ? 'No rows match “' + state.q + '”.' : (opts.empty || 'Nothing to show.')), 'empty-row');
      } else {
        tbody.innerHTML = slice.map(function (item, i) { return opts.row(item, start + i); }).join('');
      }

      if (!total) {
        meta.textContent = all.length ? 'Showing 0 of ' + all.length : '';
      } else {
        meta.textContent = 'Showing ' + (start + 1) + '–' + (start + slice.length) + ' of ' + total +
          (state.q && all.length !== total ? ' (filtered from ' + all.length + ')' : '');
      }

      // Hide the pager entirely when everything already fits — the short tables
      // (a handful of rows) should not grow a control strip they never need. A table
      // hidden by setVisible(false) stays hidden through any later setRows(), or a
      // refresh would leave a lone pager floating above a card that isn't displayed.
      pager.style.display = (!state.hidden && per && total > per) ? '' : 'none';
      pageLbl.textContent = 'Page ' + state.page + ' of ' + pages;
      bFirst.disabled = bPrev.disabled = (state.page <= 1);
      bNext.disabled = bLast.disabled = (state.page >= pages);
    }

    function go(p) { state.page = p; render(); tools.scrollIntoView({ block: 'nearest' }); }
    bFirst.addEventListener('click', function () { go(1); });
    bPrev.addEventListener('click', function () { go(state.page - 1); });
    bNext.addEventListener('click', function () { go(state.page + 1); });
    bLast.addEventListener('click', function () { go(Infinity); });
    perSel.addEventListener('change', function () {
      state.per = parseInt(perSel.value, 10) || 0;
      state.page = 1;
      render();
    });
    if (input) {
      input.addEventListener('input', function () {
        state.q = input.value.trim().toLowerCase();
        state.page = 1;              // a new query always starts at the top
        render();
      });
    }

    var handle = {
      // setRows(rows)                 → keep the current page (timer refresh)
      // setRows(rows, { reset: true }) → back to page 1 (the operator changed a
      //                                  filter chip, so the old page number is
      //                                  meaningless against the new result set)
      setRows: function (rows, o) {
        state.rows = Array.isArray(rows) ? rows : [];
        state.mode = 'ready';
        if (o && o.reset) state.page = 1;
        render();
        return handle;
      },
      setLoading: function () { state.mode = 'loading'; render(); return handle; },
      setError: function (msg) { state.mode = 'error'; state.err = msg || 'failed'; render(); return handle; },
      refresh: function () { render(); return handle; },
      // Fill {days} in the note from a window the API reports itself.
      setNoteDays: function (d) { setNoteDays(d); return handle; },
      // For tables whose whole card is hidden in some states (e.g. the wallet-send
      // audit, which only appears when there is something unmatched) — the tools bar
      // and pager must disappear with it, not float above a hidden table.
      setVisible: function (on) {
        state.hidden = !on;
        tools.style.display = on ? '' : 'none';
        if (!on) pager.style.display = 'none'; else render();
        return handle;
      },
      // Read-only views for callers that need to size a summary line themselves.
      get rows() { return state.rows; },
      get query() { return state.q; }
    };
    render();
    return handle;
  }

  window.AdminTable = { create: createTable, settings: databaseSettings };

  // ── Tooltips for [data-tip] elements (the emoji row-action buttons) ──────
  // The icons carry no text, so the label must be one hover away. Two obvious
  // approaches both fail here: a CSS ::after tooltip gets clipped by .table-wrap
  // (overflow-x:auto clips BOTH axes), and the native title= tooltip only appears
  // after ~1 s, is OS-styled, and never shows on keyboard focus. So: one shared
  // position:fixed node parented to <body> — outside every clipping context —
  // shown on hover AND focus after a short delay.
  var tipEl = null, tipHost = null, tipTimer = null;

  function tipShow(host) {
    var text = host.getAttribute('data-tip');
    if (!text) return;
    if (!tipEl) {
      tipEl = document.createElement('div');
      tipEl.className = 'admin-tip';
      // Decorative: the button's own aria-label is already its accessible name,
      // so announcing this too would just double up for screen readers.
      tipEl.setAttribute('aria-hidden', 'true');
      document.body.appendChild(tipEl);
    }
    tipEl.textContent = text;
    // Park at 0,0 first so the measured size is the natural (unclamped) one.
    tipEl.style.left = '0px';
    tipEl.style.top = '0px';
    var r = host.getBoundingClientRect();
    var t = tipEl.getBoundingClientRect();
    var top = r.top - t.height - 8;
    if (top < 4) top = r.bottom + 8;   // no room above (top table rows) → flip below
    var left = r.left + r.width / 2 - t.width / 2;
    left = Math.max(6, Math.min(left, window.innerWidth - t.width - 6));
    tipEl.style.left = Math.round(left) + 'px';
    tipEl.style.top = Math.round(top) + 'px';
    tipEl.classList.add('is-on');
  }

  function tipHide() {
    if (tipTimer) { clearTimeout(tipTimer); tipTimer = null; }
    tipHost = null;
    if (tipEl) tipEl.classList.remove('is-on');
  }

  function tipEnter(el) {
    var host = el && el.closest ? el.closest('[data-tip]') : null;
    if (host === tipHost) return;
    tipHide();
    if (!host) return;
    tipHost = host;
    tipTimer = setTimeout(function () { if (tipHost === host) tipShow(host); }, 120);
  }

  document.addEventListener('mouseover', function (e) { tipEnter(e.target); });
  document.addEventListener('mouseout', function (e) {
    // Ignore moves within the same host (icon → its own padding).
    if (tipHost && e.relatedTarget && tipHost.contains(e.relatedTarget)) return;
    tipHide();
  });
  document.addEventListener('focusin', function (e) { tipEnter(e.target); });
  document.addEventListener('focusout', tipHide);
  // A row re-render or a scroll leaves the tip pointing at nothing.
  document.addEventListener('click', tipHide);
  window.addEventListener('scroll', tipHide, true);
  window.addEventListener('resize', tipHide);

  // ── Idle session manager (window.AdminSession) ──────────────────────────
  // Started by API.guardAdminPage once /api/admin/me confirms the session, with the policy
  // that endpoint returns. Two jobs:
  //   1. Keep an ACTIVE operator signed in — silently refresh the token while they work, so
  //      the hour stops being "an hour since you logged in" and becomes "an hour idle".
  //   2. Sign out an INACTIVE one, on the client, with an explicit reason.
  //
  // "Activity" is real user interaction (pointer/key/touch/wheel), NEVER request traffic.
  // Several admin pages poll on a timer (health.html every 30 s, AdminTable refreshes), so a
  // traffic-driven window would never close while a tab sat open on the dashboard — the
  // timeout would exist on paper only. The server enforces the same window independently as
  // the access-token TTL, so a closed, stale or hostile client changes nothing.
  var AS = {
    idleMs: 3600000,
    absMs: 43200000,
    startedAt: 0,        // ms epoch of the real login (from the token's sst), skew-corrected
    skewMs: 0,           // clientClock - serverClock; see startSession, reused by refreshToken
    lastAct: 0,
    lastRefresh: 0,
    timer: null,
    started: false,
    // Cross-tab activity. Without this, working in tab A while tab B sits idle lets B hit its
    // timeout and call /api/auth/logout — which revokes the tokens tab A is actively using,
    // logging the operator out of the tab they're typing in.
    ACT_KEY: 'grinpool_admin_last_act',
    REF_KEY: 'grinpool_admin_last_refresh'
  };

  function nowMs() { return Date.now(); }

  function lsGet(k) {
    try { return parseInt(window.localStorage.getItem(k) || '0', 10) || 0; } catch (e) { return 0; }
  }
  function lsSet(k, v) {
    try { window.localStorage.setItem(k, String(v)); } catch (e) { /* private mode / quota */ }
  }

  // Most recent interaction in ANY admin tab.
  function lastActivity() {
    return Math.max(AS.lastAct, lsGet(AS.ACT_KEY));
  }
  function lastRefreshAt() {
    return Math.max(AS.lastRefresh, lsGet(AS.REF_KEY));
  }

  function noteActivity() {
    var t = nowMs();
    // Throttle: pointermove fires continuously. One localStorage write per 5 s is plenty for
    // cross-tab purposes and keeps this off the hot path.
    if (t - AS.lastAct < 5000) { AS.lastAct = t; return; }
    AS.lastAct = t;
    lsSet(AS.ACT_KEY, t);
  }

  function signOut(reason) {
    if (AS.timer) { window.clearInterval(AS.timer); AS.timer = null; }
    AS.started = false;
    var go = function () { window.location.href = '/login.html?reason=' + encodeURIComponent(reason); };
    // Revoke server-side, then leave. Navigate even if the call fails — a client that can't
    // reach the server must still stop showing the panel.
    try {
      window.fetch('/api/auth/logout', { method: 'POST', credentials: 'include' })
        .then(go, go);
    } catch (e) { go(); }
  }

  function refreshToken() {
    var t = nowMs();
    AS.lastRefresh = t;
    lsSet(AS.REF_KEY, t);
    window.fetch('/api/auth/refresh', { method: 'POST', credentials: 'include' })
      .then(function (res) {
        if (res.status === 401) {
          // Two very different cases. session_expired = the absolute cap is reached and no
          // token will ever be issued again, so stop and say why. Anything else is most
          // likely a lost multi-tab rotation race (the sibling tab rotated token_version
          // first and installed a good cookie we now share) — ignore it and let the next
          // real request decide, rather than logging the operator out over a race.
          return res.json().then(function (b) {
            if (b && b.session_expired) signOut('expired');
          }, function () { /* non-JSON 401 → ignore, see above */ });
        }
        if (!res.ok) return;   // transient (429/5xx) — try again next tick
        return res.json().then(function (b) {
          // Same skew correction as startSession — this value is in the server's clock.
          if (b && b.session_started_at) AS.startedAt = b.session_started_at * 1000 + AS.skewMs;
          if (b && b.session_absolute_seconds) AS.absMs = b.session_absolute_seconds * 1000;
        }, function () { /* body optional */ });
      }, function () { /* offline — next tick */ });
  }

  function tick() {
    if (!AS.started) return;
    var t = nowMs();
    var idleFor = t - lastActivity();

    if (idleFor >= AS.idleMs) { signOut('idle'); return; }
    if (AS.startedAt && (t - AS.startedAt) >= AS.absMs) { signOut('expired'); return; }

    // Refresh only while genuinely in use: there must have been interaction since the last
    // refresh, and we space them out. An idle tab therefore issues no traffic at all and its
    // token is allowed to die — which is the whole point.
    var since = lastRefreshAt();
    var spacing = Math.max(60000, Math.floor(AS.idleMs / 6));
    if (lastActivity() > since && (t - since) >= spacing) refreshToken();
  }

  function startSession(policy) {
    if (AS.started) return;
    policy = policy || {};
    var idle = Number(policy.idle_seconds);
    var abs = Number(policy.absolute_seconds);
    if (isFinite(idle) && idle >= 60) AS.idleMs = idle * 1000;
    if (isFinite(abs) && abs >= 60) AS.absMs = abs * 1000;
    // started_at comes from the token, not from page load: reloading a page mid-session must
    // not reset the absolute cap. Correct for clock skew using the server's own `now`.
    // Keep the skew: the refresh response also reports session_started_at in SERVER seconds,
    // and applying it raw there would throw this correction away. A workstation clock hours
    // off would then compute a bogus session age and force an "expired" sign-out mid-shift.
    AS.skewMs = policy.now ? (nowMs() - policy.now * 1000) : 0;
    if (policy.started_at) AS.startedAt = policy.started_at * 1000 + AS.skewMs;
    AS.started = true;
    // Landing on an admin page IS activity: the operator navigated here, and reaching this
    // point means the SERVER already accepted the token (guardAdminPage would have bounced to
    // /login.html otherwise). So a stale shared stamp is not evidence of an expired session —
    // the server is the boundary, and it can't be: this code isn't running while tabs are shut.
    AS.lastAct = nowMs();
    lsSet(AS.ACT_KEY, AS.lastAct);
    // Seed the refresh clock from the shared stamp. Without this, lastRefreshAt() is 0 on
    // every page load, so the first tick 30 s later always burns a token rotation — six pages
    // of normal navigation would mean six pointless rotations (and six chances to lose a
    // multi-tab race). Absent stamp = this session was just minted, so `now` is correct; a
    // stale stamp (came back after a while) correctly triggers a refresh on the first tick.
    if (!lastRefreshAt()) lsSet(AS.REF_KEY, AS.lastAct);

    ['pointerdown', 'keydown', 'touchstart', 'wheel', 'pointermove'].forEach(function (ev) {
      window.addEventListener(ev, noteActivity, { passive: true, capture: true });
    });
    // Becoming visible again is NOT interaction — it only means "evaluate now".
    //
    // This handler used to stamp AS.lastAct before calling tick(), which defeated the whole
    // feature: an idle admin panel is normally a BACKGROUNDED tab, so the sequence
    // hide → 3 h → show reset the idle clock to zero, tick() then saw idleFor = 0, and the
    // "there was interaction since the last refresh" test passed on the stamp it had just
    // written — so returning to the tab silently RENEWED the session instead of ending it.
    // Verified: 5 h of nothing but switching away and back produced 10 refreshes and no
    // sign-out, and it also renewed the server's access token, so the server-side TTL
    // backstop was defeated too.
    //
    // A genuinely returning operator credits themselves within moments (moving the pointer
    // onto the page fires pointermove), so nothing is lost by not guessing on their behalf.
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) tick();
    });

    AS.timer = window.setInterval(tick, 30000);
  }

  window.AdminSession = {
    start: startSession,
    // Exposed for the session banner on users.html and for debugging.
    state: function () {
      return {
        started: AS.started,
        idle_seconds: Math.round(AS.idleMs / 1000),
        absolute_seconds: Math.round(AS.absMs / 1000),
        idle_for_seconds: Math.round((nowMs() - lastActivity()) / 1000),
        session_age_seconds: AS.startedAt ? Math.round((nowMs() - AS.startedAt) / 1000) : null
      };
    }
  };

  // Body already parsed up to this script (end of <body>), so mount now.
  if (document.querySelector('main')) {
    mount();
  } else {
    document.addEventListener('DOMContentLoaded', mount);
  }
})();
