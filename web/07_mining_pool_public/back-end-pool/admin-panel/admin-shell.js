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
        { file: 'donors.html',   title: 'Donors' },     // banner review queue + donor names + donors + donation settings (design §18.6, §19.17.6)
        { file: 'blocks.html',   title: 'Blocks' },
        { file: 'users.html',    title: 'Security' },   // login security, admin sessions, payout request audit
        { file: 'regions.html',  title: 'Regions' },
        { file: 'health.html',   title: 'System Health' },
        { file: 'node-availability.html', title: 'Node Availability' }   // pool view + node-box recorder, side by side (design §20.6)
      ] },
    // Payouts (2026-10): the old single payments page, split by SUBJECT — each page pairs a
    // reading with the action that changes it. The queue keeps payments.html (bookmarks,
    // miners.html's ?q= link); like Settings, the parent's file is also its first child.
    { file: 'payments.html', title: 'Payouts', ico: '💸', children: [
        { file: 'payments.html', title: 'Queue' },
        { file: 'treasury.html', title: 'Treasury' },    // reconciliation, wallet-send audit, wallet identity + switch wizard
        { file: 'dormant.html',  title: 'Dormant balances' }   // abandoned-balance policy, sweep, sweep history
      ] },
    // Games (design §19.11): the /play/ games' own pages, all through the admin proxy to the
    // games service. Shown whatever the games mode is — the operator prepares before opening.
    // The pool-owned on/off + chat switches stay under Settings → Games.
    { file: 'games.html', title: 'Games', ico: '🎮', children: [
        { file: 'games.html',         title: 'Overview & settings' },
        { file: 'games-chat.html',    title: 'Chat & moderation' },
        { file: 'games-players.html', title: 'Players' },
        { file: 'games-events.html',  title: 'Events' },
        { file: 'games-names.html',   title: 'Nicknames' }
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
        { file: 'settings-games.html',         title: 'Games' },       // /play/ master + chat switch (design §19.11)
        { file: 'settings-names.html',         title: 'Names' },       // the blocked-word list for player names (design §19.17.5)
        { file: 'settings-access.html',        title: 'Access Control' },
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
  // rotation is what hid it — half the clicks worked. The schemes:
  //   grincoin.org       /block/<h>  (hash → /hash/<hash>)  /kernel/<excess>  /output/<commit>
  //   scan.grin.money    /block/<h>           /kernel/<excess>          /output/<commit>
  //   *.grinscan.org     /block.html?h=<h>    /kernel.html?ex=<excess>  /output.html?c=<commit>
  // grincoin.org takes DIGITS ONLY in /block/, hence its separate `blockHash` segment.
  //
  // WHICH explorer is an ADMIN SETTING (Settings → Branding, `branding.explorer_mainnet`):
  // mainnet picks grincoin (default) | tiny | grinscan; testnet is FIXED on test.grinscan.org
  // (NOTE the host is `test.` — `testnet.grinscan.org` does NOT resolve). The server publishes
  // the RESOLVED key as `explorer` beside `network`; it is mapped through the registry below,
  // never used as a URL. Full rationale lives in /js/branding.js.
  // ⚠ EXPLORERS / EXPLORER_STYLES / MAINNET_CHOICES MIRROR lib/explorers.js and /js/branding.js;
  // scripts/test-explorers.js fails if they drift.
  //
  // Network + key are resolved once by decoratePoolIdentity() (below, from /api/pool/stats)
  // and cached in sessionStorage; until then we assume mainnet + grincoin.
  var NETWORK_KEY = 'pool-network';
  var EXPLORER_KEY = 'pool-explorer';
  function explorerNetwork() {
    try { var n = sessionStorage.getItem(NETWORK_KEY); if (n) return n; } catch (e) {}
    return 'mainnet';
  }
  var EXPLORER_STYLES = {
    path:     { block: 'block/',        kernel: 'kernel/',        output: 'output/' },
    grincoin: { block: 'block/', blockHash: 'hash/', kernel: 'kernel/', output: 'output/' },
    query:    { block: 'block.html?h=', kernel: 'kernel.html?ex=', output: 'output.html?c=' }
  };
  var EXPLORERS = {
    grincoin:         { base: 'https://grincoin.org',      style: 'grincoin' }, // aglkm full archive, mainnet
    tiny:             { base: 'https://scan.grin.money',   style: 'path'     }, // 06d, mainnet only
    grinscan:         { base: 'https://grinscan.org',      style: 'query'    }, // 06b mainnet
    grinscan_testnet: { base: 'https://test.grinscan.org', style: 'query'    }  // 06b testnet sibling
  };
  var MAINNET_CHOICES = ['grincoin', 'tiny', 'grinscan'];
  var DEFAULT_MAINNET = 'grincoin';
  var TESTNET_EXPLORER = 'grinscan_testnet';
  // resolveExplorerKey() re-applied to the cached key: testnet always test.grinscan.org (a stale
  // mainnet key can't leak onto a testnet pool); mainnet takes it only if it is one of the three
  // choices AND an own registry entry, else grincoin.
  function explorerKey() {
    if (explorerNetwork() === 'testnet') return TESTNET_EXPLORER;
    var k = null;
    try { k = sessionStorage.getItem(EXPLORER_KEY); } catch (e) {}
    return (typeof k === 'string' && MAINNET_CHOICES.indexOf(k) !== -1 &&
      Object.prototype.hasOwnProperty.call(EXPLORERS, k)) ? k : DEFAULT_MAINNET;
  }
  function explorerPick() {
    return EXPLORERS[explorerKey()];
  }
  function explorerUrl(kind, value) {
    var ex = explorerPick();
    var style = EXPLORER_STYLES[ex.style] || EXPLORER_STYLES.path;
    var v = String(value);
    var seg = (kind === 'kernel') ? style.kernel : (kind === 'output') ? style.output
      : (style.blockHash && !/^\d+$/.test(v)) ? style.blockHash : style.block;
    return ex.base.replace(/\/+$/, '') + '/' + seg + encodeURIComponent(v);
  }
  // Returns an <a> that opens the explorer in a new tab. `label` defaults to `value`.
  // Both URL and label are HTML-escaped — safe to embed untrusted chain strings.
  function explorerLink(kind, value, label, cls) {
    if (value == null || value === '') return esc(label == null ? '' : label);
    return '<a href="' + esc(explorerUrl(kind, value)) + '" target="_blank" rel="noopener"' +
      (cls ? ' class="' + esc(cls) + '"' : '') +
      ' title="Open on Grin chain explorer ↗"' +
      ' data-xp-kind="' + esc(kind) + '" data-xp-ref="' + esc(value) + '">' +
      esc(label == null ? value : label) + '</a>';
  }
  // A page's own fetch can render links before decoratePoolIdentity() caches network + explorer
  // (sessionStorage is per tab, so every new tab starts empty) — those took the mainnet/grincoin
  // fallback, a MAINNET explorer on a testnet pool. Re-point every tagged anchor: the host comes
  // from the registry and the ref is re-encoded, so an attribute value never becomes the URL.
  function explorerRelink() {
    var list = document.querySelectorAll('a[data-xp-kind]');
    for (var i = 0; i < list.length; i++) {
      var a = list[i], ref = a.getAttribute('data-xp-ref');
      if (ref) a.setAttribute('href', explorerUrl(a.getAttribute('data-xp-kind'), ref));
    }
  }
  window.Explorer = { url: explorerUrl, link: explorerLink, network: explorerNetwork, key: explorerKey, relink: explorerRelink };

  // ── Theme (Dark default, Light) ─────────────────────────────────────────
  // Own key, and deliberately not 'admin-theme'. branding.js used to write the
  // operator's public default_theme (e.g. "atomic") to that key on every public
  // page, which would have clobbered this Dark/Light toggle and reset it to Dark.
  // That write went away in 2026-08 with js/theme.js, so the collision is gone —
  // but the separate key stays: this toggle is admin UI chrome and has nothing to
  // do with the operator's public palette, so sharing a key would be wrong again
  // the moment anything writes the public one back.
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
    '<div class="admin-search" role="search">' +
      '<input type="search" id="admin-search-input" placeholder="Search settings…  ( / )"' +
        ' aria-label="Search admin pages and settings" autocomplete="off" spellcheck="false"' +
        ' aria-controls="admin-search-results">' +
    '</div>' +
    '<nav class="admin-nav">' + navHtml + '</nav>' +
    '<div class="admin-search-results" id="admin-search-results" role="listbox" hidden></div>' +
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

    // In-page section navigation for the long pages (treasury, ads, settings-*)
    buildSectionRail(wrap, main);

    // Page title in the browser tab + topbar pool name
    decoratePoolIdentity();

    // "N donor requests waiting for review" on the Donors nav row (design §18.6)
    decorateDonorBadge();

    // Red "Stratum PAUSED" strip under the topbar, on every page (design §21.0 #6)
    startStratumStrip(wrap, main);

    // Sidebar search box + ?find= landing (a search result opened from another page)
    wireSidebarSearch();
    landOnFind();
  }

  /* ── Sidebar search ───────────────────────────────────────────────────────
     One box above the nav that finds a page, a section or a single setting by its label,
     so reaching e.g. "Slatepack Response Window" is one keystroke-search away instead of
     a guess at which of the 14 settings pages holds it.

     The index is BUILT FROM THE PAGES THEMSELVES — no hand-kept list to drift. Nav titles
     match instantly; on first use each NAV file is fetched once and parsed (DOMParser, so no
     page script runs) for section headings (h2, h3, .section-title) and label[for] fields,
     each field tagged with its nearest heading and its .helper-text (searchable, not shown).
     Labels inside a .modal-overlay are skipped — a dialog's field is not reachable by
     scrolling to it.

     ⚠ PACED, one page at a time with a gap, never fired all at once: /admin/ sits behind its
     own nginx limit_req zone (120r/m, burst 40 nodelay). ~30 parallel fetches would spend the
     whole burst, and the NEXT page load's own assets would then 503 — the blank-sidebar bug
     that zone was sized to end. The result is cached in localStorage for INDEX_TTL_MS, so
     this happens about once per working session, not once per page.

     Results link with ?find=<field id> or ?findh=<heading text>, NEVER a #hash: on the
     settings pages settings-common.js listens for hashchange and would "switch tab" to any
     element whose id matched — hiding the whole form behind the field we meant to show. */
  var INDEX_KEY = 'admin-search-index-v1';
  var INDEX_TTL_MS = 6 * 3600 * 1000;
  var INDEX_GAP_MS = 350;          // ≈3 req/s for a few seconds — well inside the burst
  var SEARCH_MAX = 14;

  // Every distinct NAV file, with the trail shown under its results ("Settings › Payout").
  function navPages() {
    var out = [], seen = {};
    NAV.forEach(function (n) {
      function add(file, trail, ico) {
        if (seen[file]) return;
        seen[file] = true;
        out.push({ file: file, trail: trail, ico: ico });
      }
      if (!n.children) { add(n.file, n.title, n.ico); return; }
      // A parent whose file is also its first child (Payouts → Queue) takes the child's trail.
      if (!n.children.some(function (c) { return c.file === n.file; })) add(n.file, n.title, n.ico);
      n.children.forEach(function (c) { add(c.file, n.title + ' › ' + c.title, n.ico); });
    });
    return out;
  }

  function cleanText(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); }

  // Parse one page's static HTML into section + field entries.
  function indexPageHtml(html) {
    var doc;
    try { doc = new DOMParser().parseFromString(html, 'text/html'); } catch (e) { return []; }
    var root = doc.querySelector('main') || doc.body;
    if (!root) return [];
    var out = [], section = '';
    root.querySelectorAll('h2, h3, .section-title, label[for]').forEach(function (el) {
      if (el.closest('.modal-overlay') || el.hasAttribute('data-nosearch')) return;
      if (el.tagName === 'LABEL') {
        var id = el.getAttribute('for');
        var label = cleanText(el.textContent);
        if (!id || !label || !doc.getElementById(id)) return;
        var grp = el.closest('.form-group');
        var help = grp ? grp.querySelector('.helper-text') : null;
        if (!help) {
          // Checkbox rows keep their helper as the NEXT sibling of .checkbox-group.
          var box = el.closest('.checkbox-group');
          var nx = box && box.nextElementSibling;
          if (nx && nx.classList.contains('helper-text')) help = nx;
        }
        out.push({ k: 'f', t: label, id: id, s: section,
                   h: help ? cleanText(help.textContent).slice(0, 400) : '' });
        return;
      }
      var head = headingLabel(el);
      if (!head) return;
      section = head;
      out.push({ k: 's', t: head, s: '' });
    });
    return out;
  }

  var SI = { pages: null, entries: {}, at: 0, started: false, building: false,
             done: 0, total: 0, onProgress: null };

  // The cache is saved after EVERY page, not only at the end: the first pass takes ~12 s, and
  // an operator who clicks a result before it finishes navigates away mid-build. The next page
  // resumes from what is stored instead of starting over. A page whose fetch failed is simply
  // absent, so it is retried on the next page load rather than staying unsearchable for the
  // whole TTL. `at` is when the oldest entry was taken, so the TTL can't be renewed by resuming.
  function loadIndexCache() {
    try {
      var c = JSON.parse(localStorage.getItem(INDEX_KEY) || 'null');
      if (c && c.at && (Date.now() - c.at) < INDEX_TTL_MS && c.pages && typeof c.pages === 'object') return c;
    } catch (e) {}
    return null;
  }
  function saveIndexCache() {
    try { localStorage.setItem(INDEX_KEY, JSON.stringify({ at: SI.at, pages: SI.entries })); } catch (e) {}
  }

  function buildIndex() {
    if (SI.started) return;          // once per page load; focus + every keystroke call this
    SI.started = true;
    SI.pages = navPages();
    var cached = loadIndexCache();
    SI.entries = cached ? cached.pages : {};
    SI.at = cached ? cached.at : Date.now();
    // Missing pages only; the page you're on first — its fields are the likeliest next pick.
    var queue = SI.pages.map(function (p) { return p.file; })
      .filter(function (f) { return !Object.prototype.hasOwnProperty.call(SI.entries, f); })
      .sort(function (a, b) { return (b === here) - (a === here); });
    SI.total = SI.pages.length;
    SI.done = SI.total - queue.length;
    if (!queue.length) return;
    SI.building = true;
    (function next() {
      var file = queue.shift();
      if (!file) {
        SI.building = false;
        if (SI.onProgress) SI.onProgress();
        return;
      }
      fetch(file, { credentials: 'same-origin' })
        .then(function (r) {
          // A dead session lands on /login.html via nginx's error_page — not this page.
          if (!r.ok || (r.redirected && !/\/admin\//.test(r.url))) return null;
          return r.text();
        })
        .then(function (html) {
          if (!html) return;
          SI.entries[file] = indexPageHtml(html);
          saveIndexCache();
        })
        .catch(function () {})
        .then(function () {
          SI.done++;
          if (SI.onProgress) SI.onProgress();
          setTimeout(next, INDEX_GAP_MS);
        });
    })();
  }

  // Score an entry against ANDed terms; 0 = no match. Label hits beat section/page hits,
  // which beat helper-text-only hits, and a word-start beats a mid-word hit.
  function scoreEntry(terms, label, ctx, help) {
    var L = label.toLowerCase(), C = ctx.toLowerCase(), H = help.toLowerCase(), score = 0;
    for (var i = 0; i < terms.length; i++) {
      var t = terms[i], at = L.indexOf(t);
      if (at === 0) score += 12;
      else if (at > 0) score += /[\s(\-\/·›]/.test(L.charAt(at - 1)) ? 9 : 6;
      else if (C.indexOf(t) !== -1) score += 3;
      else if (H.indexOf(t) !== -1) score += 1;
      else return 0;
    }
    return score;
  }

  function searchIndex(q) {
    var terms = q.toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return [];
    var hits = [];
    (SI.pages || navPages()).forEach(function (p, order) {
      var title = p.trail.split(' › ').pop();
      var ps = scoreEntry(terms, title, p.trail, '');
      if (ps) hits.push({ score: ps + 4, order: order, kind: 'page', label: title, ctx: p.trail,
                          ico: p.ico, href: p.file, file: p.file });
      (SI.entries[p.file] || []).forEach(function (e, j) {
        var ctx = p.trail + (e.s ? ' · ' + e.s : '');
        var s = scoreEntry(terms, e.t, ctx, e.h || '');
        if (!s) return;
        hits.push({
          score: s + (e.k === 's' ? 1 : 0), order: order + j / 1000,
          kind: e.k === 's' ? 'section' : 'field', label: e.t, ctx: ctx, file: p.file,
          href: p.file + (e.k === 'f' ? '?find=' + encodeURIComponent(e.id)
                                      : '?findh=' + encodeURIComponent(e.t)),
          id: e.id, head: e.k === 's' ? e.t : null
        });
      });
    });
    hits.sort(function (a, b) { return (b.score - a.score) || (a.order - b.order); });
    return hits.slice(0, SEARCH_MAX);
  }

  // Wrap each term's occurrences in <mark>, escaping every segment (never the raw string).
  function highlight(text, terms) {
    var low = text.toLowerCase(), marks = [];
    terms.forEach(function (t) {
      for (var at = low.indexOf(t); t && at !== -1; at = low.indexOf(t, at + t.length)) marks.push([at, at + t.length]);
    });
    if (!marks.length) return esc(text);
    marks.sort(function (a, b) { return a[0] - b[0]; });
    var out = '', pos = 0;
    marks.forEach(function (m) {
      if (m[1] <= pos) return;
      var s = Math.max(m[0], pos);
      out += esc(text.slice(pos, s)) + '<mark>' + esc(text.slice(s, m[1])) + '</mark>';
      pos = m[1];
    });
    return out + esc(text.slice(pos));
  }

  function wireSidebarSearch() {
    var input = document.getElementById('admin-search-input');
    var box = document.getElementById('admin-search-results');
    var navEl = sidebar.querySelector('.admin-nav');
    if (!input || !box || !navEl) return;
    var results = [], sel = 0;

    function render() {
      var q = input.value.trim();
      var open = q.length > 0;
      box.hidden = !open;
      navEl.hidden = open;
      if (!open) { box.innerHTML = ''; results = []; return; }
      var terms = q.toLowerCase().split(/\s+/).filter(Boolean);
      results = searchIndex(q);
      if (sel >= results.length) sel = 0;
      var html = results.map(function (r, i) {
        var tag = r.kind === 'page' ? 'Page' : r.kind === 'section' ? 'Section' : 'Setting';
        return '<a href="' + esc(r.href) + '" class="srch-item' + (i === sel ? ' is-sel' : '') +
                 '" role="option" data-i="' + i + '"' + (i === sel ? ' aria-selected="true"' : '') + '>' +
                 '<span class="srch-label">' + highlight(r.label, terms) + '</span>' +
                 '<span class="srch-ctx"><span class="srch-tag">' + tag + '</span>' + esc(r.ctx) + '</span>' +
               '</a>';
      }).join('');
      if (!results.length) {
        html = '<div class="srch-empty">' + (SI.building ? 'No match yet…' : 'No page or setting matches “' + esc(q) + '”.') + '</div>';
      }
      if (SI.building) {
        html += '<div class="srch-status">Indexing pages… ' + SI.done + ' / ' + SI.total + '</div>';
      }
      box.innerHTML = html;
    }

    function move(d) {
      if (!results.length) return;
      sel = (sel + d + results.length) % results.length;
      render();
      var cur = box.querySelector('.srch-item.is-sel');
      if (cur && cur.scrollIntoView) cur.scrollIntoView({ block: 'nearest' });
    }

    // A result on the page you're already on scrolls in place — no reload, no lost edits.
    function open(r, e) {
      if (!r) return;
      if (r.file === here && r.kind !== 'page') {
        if (e) e.preventDefault();
        document.body.classList.remove('admin-drawer-open');
        findTarget(r.id || null, r.head || null);
        return;
      }
      if (!e) location.href = r.href;
    }

    SI.onProgress = function () { if (input.value.trim()) render(); };
    input.addEventListener('focus', buildIndex);
    input.addEventListener('input', function () { sel = 0; buildIndex(); render(); });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
      else if (e.key === 'Enter') { e.preventDefault(); open(results[sel], null); }
      else if (e.key === 'Escape') {
        if (input.value) { input.value = ''; render(); } else input.blur();
      }
    });
    box.addEventListener('click', function (e) {
      var a = e.target.closest && e.target.closest('.srch-item');
      if (!a) return;
      open(results[parseInt(a.getAttribute('data-i'), 10)], e);
    });
    // "/" or Ctrl/Cmd+K from anywhere that isn't already a text field.
    document.addEventListener('keydown', function (e) {
      var t = e.target, typing = t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
      var k = (e.key === '/' && !typing && !e.ctrlKey && !e.metaKey && !e.altKey) ||
              ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K'));
      if (!k) return;
      e.preventDefault();
      // Phones/narrow (styles.css: max-width 900px): the box lives in the off-canvas drawer.
      if (window.matchMedia && window.matchMedia('(max-width: 900px)').matches) {
        document.body.classList.add('admin-drawer-open');
      }
      input.focus();
      input.select();
    });
  }

  // Scroll a field (by id) or a heading (by its label) into view below the sticky chrome
  // and flash it (unless `quiet`: the re-aim pass after late content). False = no match.
  function findTarget(id, head, quiet) {
    var main = document.querySelector('.admin-main > main') || document.querySelector('main');
    if (!main) return false;
    var el = null;
    if (id) el = document.getElementById(id);
    else if (head) {
      var want = head.toLowerCase();
      var list = main.querySelectorAll('h2, h3, .section-title');
      for (var i = 0; i < list.length && !el; i++) {
        if (headingLabel(list[i]).toLowerCase() === want) el = list[i];
      }
    }
    if (!el || !main.contains(el)) return false;
    var flash = id ? (el.closest('.form-group, .checkbox-group') || el)
                   : (el.closest('.form-section') || el);
    // A setting inside a block that is hidden right now (a feature switched off) has no box —
    // scrolling to it would mean scrolling to the top. Aim at the nearest visible ancestor.
    while (flash && flash !== main && !flash.getClientRects().length) flash = flash.parentElement;
    if (!flash || flash === main) return false;
    var rail = document.querySelector('.admin-rail');
    var y = window.pageYOffset + flash.getBoundingClientRect().top -
            (topbar.offsetHeight + (rail ? rail.offsetHeight : 0) + 18);
    window.scrollTo({ top: Math.max(0, y) });
    if (quiet) return true;
    flash.classList.remove('admin-find-flash');
    void flash.offsetWidth;                       // restart the animation on a repeat find
    flash.classList.add('admin-find-flash');
    setTimeout(function () { flash.classList.remove('admin-find-flash'); }, 2600);
    if (id && el.focus && !el.disabled && el.type !== 'hidden') {
      try { el.focus({ preventScroll: true }); } catch (e) {}
    }
    return true;
  }

  // Landing from another page: ?find= / ?findh=. Waits for DOMContentLoaded — settings pages
  // reveal their form there (switchTab), so before it the target has no box to scroll to —
  // and runs once more shortly after, since lists loading above can push the target down.
  // The second pass is skipped once the operator has scrolled or clicked themselves.
  function landOnFind() {
    var id = null, head = null;
    try {
      var sp = new URLSearchParams(location.search);
      id = sp.get('find'); head = sp.get('findh');
    } catch (e) { return; }
    if (!id && !head) return;
    var touched = false;
    ['wheel', 'pointerdown', 'keydown', 'touchstart'].forEach(function (ev) {
      window.addEventListener(ev, function () { touched = true; }, { once: true, passive: true });
    });
    function go() {
      setTimeout(function () {
        findTarget(id, head);
        setTimeout(function () { if (!touched) findTarget(id, head, true); }, 700);
      }, 30);
      // Drop the find params so a reload doesn't yank the page back; any other (?q=) stays.
      try {
        var sp2 = new URLSearchParams(location.search);
        sp2.delete('find'); sp2.delete('findh');
        var qs = sp2.toString();
        history.replaceState(null, '', location.pathname + (qs ? '?' + qs : '') + location.hash);
      } catch (e) {}
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', go);
    else go();
  }

  // ── Donors nav badge ─────────────────────────────────────────────────────
  // One cheap secureAdmin COUNT per page load (/api/admin/donors/summary — not the dashboard
  // route, which runs a dozen queries). Silent on any failure: before the page's own
  // API.guardAdminPage() has redirected a logged-out visitor, this may 401, and a badge is
  // not worth a toast. Rendered only when the count is a positive number, so a stale or
  // malformed body (a rate-limit 429 is JSON too) can never paint "undefined".
  function decorateDonorBadge() {
    var link = sidebar.querySelector('.admin-subnav a[href="donors.html"]');
    if (!link) return;
    fetch('/api/admin/donors/summary', { credentials: 'include', cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        var n = d && typeof d.pending_requests === 'number' ? d.pending_requests : 0;
        if (!(n > 0)) return;
        var b = document.createElement('span');
        b.className = 'nav-count';
        b.textContent = String(n);
        b.title = n + ' donor banner' + (n === 1 ? '' : 's') + ' waiting for review';
        b.setAttribute('aria-label', b.title);
        link.appendChild(b);
      })
      .catch(function () {});
  }

  /* ── Stratum pause: strip + shared view (window.AdminStratum) — design §21 ──
     One poll of GET /api/admin/stratum/control per admin page (60 s; 15 s on the page that
     holds the controls), shared by three readers: the strip below the topbar, the status
     line on health.html and the Stratum section on settings-announcements.html. Pages
     subscribe instead of polling a second time.

     The strip shows while stratum is paused / pausing / resuming, while a listener that
     should be up is not (DEGRADED — the failed re-bind of §21.11), and from 24 h before a
     planned window. It links to the controls with ?findh=, never a #hash — on the settings
     pages a hashchange "switches tab" to any element whose id matches.

     Silent on every failure: before guardAdminPage has redirected a logged-out visitor this
     may 401, and an older backend has no such route (404). A missing strip must never read
     as "accepting" anywhere else, so health.html says "unknown" for it. */

  // ── STRATUM-VIEW BEGIN ── pure helpers: no DOM, no fetch. scripts/test-admin-panel.js runs this
  // block on its own in a vm, so it must stay free of document/window.
  var ST_MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var ST_NOTICE_S = 24 * 3600;     // a planned window is flagged this long before it starts (Q5)

  function stEsc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function stPad(n) { return (n < 10 ? '0' : '') + n; }

  // unix seconds → "05 Oct 14:30" in UTC, with NO zone suffix: the caller states UTC once.
  function stTime(sec) {
    var n = Number(sec);
    if (sec == null || sec === '' || !isFinite(n)) return '—';
    var d = new Date(n * 1000);
    return stPad(d.getUTCDate()) + ' ' + ST_MON[d.getUTCMonth()] + ' ' +
      stPad(d.getUTCHours()) + ':' + stPad(d.getUTCMinutes());
  }
  // "05 Oct 09:00–11:00", the end date repeated only when the window crosses midnight.
  function stRange(a, b) {
    var A = stTime(a), B = stTime(b);
    return A.slice(0, 6) === B.slice(0, 6) ? A + '–' + B.slice(7) : A + ' – ' + B;
  }
  // Seconds → "1 h 05 min" / "4 min" / "<1 min".
  function stDur(s) {
    s = Math.max(0, Math.round(Number(s) || 0));
    if (s < 60) return '<1 min';
    var m = Math.floor(s / 60), h = Math.floor(m / 60);
    if (h >= 24) return Math.floor(h / 24) + ' d ' + (h % 24) + ' h';
    return h ? h + ' h ' + stPad(m % 60) + ' min' : m + ' min';
  }

  // Listeners that SHOULD be up and are not, while intake is on: the public port and every
  // region in config.region_ports. The error comes from the last resume's per-port result,
  // when it has one for that port. Empty while paused/transitioning — nothing should be up.
  function stDown(c) {
    if (!c || c.paused || c.accept_state !== 'accepting') return [];
    var live = {}, errs = {};
    (c.listeners || []).forEach(function (l) { if (l && l.listening) live[Number(l.port)] = true; });
    var lr = c.last_result && c.last_result.results;
    (Array.isArray(lr) ? lr : []).forEach(function (r) {
      if (r && !r.bound && !r.already) errs[Number(r.port)] = r.code || r.error || null;
    });
    var out = [];
    var pub = Number(c.public_port);
    if (pub && !live[pub]) out.push({ port: pub, region: 'public', error: errs[pub] || null });
    (c.regions || []).forEach(function (r) {
      var p = Number(r && r.port);
      if (p && p !== pub && !live[p]) out.push({ port: p, region: r.region, error: errs[p] || null });
    });
    return out;
  }

  // The one classification every reader uses. level ∈ ok | scheduled | pausing | paused |
  // resuming | degraded | unknown; tone 'red' | 'amber' | null (null = no strip).
  function stClassify(c, now) {
    if (!c || typeof c !== 'object') return { level: 'unknown', tone: null, down: [] };
    var down = stDown(c);
    var p = c.planned;
    if (c.paused && c.accept_state === 'pausing') return { level: 'pausing', tone: 'red', down: down };
    if (c.paused) return { level: 'paused', tone: 'red', down: down };
    if (c.accept_state === 'resuming') return { level: 'resuming', tone: 'amber', down: down };
    if (down.length) return { level: 'degraded', tone: 'red', down: down };
    if (p && Number(p.start) > now && Number(p.start) - now <= ST_NOTICE_S) {
      return { level: 'scheduled', tone: 'amber', down: down };
    }
    return { level: 'ok', tone: null, down: down };
  }

  function stDownText(down) {
    return down.map(function (d) {
      return ':' + d.port + ' (' + d.region + ')' + (d.error ? ' — ' + d.error : '');
    }).join(', ');
  }

  // One-line summary as HTML (every API value escaped). "UTC" follows the LAST time shown,
  // so a line states the zone once.
  function stSummaryHtml(c, now) {
    var k = stClassify(c, now);
    var by = c && c.paused_by ? ' by ' + stEsc(c.paused_by) : '';
    var planned = c && c.source === 'planned' ? ' (planned window)'
      : c && c.source === 'restore' ? ' (after a restore — check the pool, then resume)' : '';
    switch (k.level) {
      case 'pausing':
        return '<strong>Stratum PAUSING</strong> — listeners closed, waiting for in-flight shares to settle (up to 30 s).';
      case 'paused':
        return '<strong>Stratum PAUSED</strong>' + planned + by + ' · since ' + stTime(c.since) +
          ' · resumes on its own ' + stTime(c.until) + ' UTC (in ' + stDur(Number(c.until) - now) + ')' +
          (c.settled_at ? '' : ' · <strong>not settled yet</strong>') +
          (c.persisted === false ? ' · <strong>NOT persisted — a restart will reopen stratum</strong>' : '') +
          ' · every miner is refused.';
      case 'resuming':
        return '<strong>Stratum RESUMING</strong> — re-binding the listeners.';
      case 'degraded':
        return '<strong>Stratum DEGRADED</strong> — not listening: ' + stEsc(stDownText(k.down)) +
          '. Miners on that port fail over. Re-bind it from the Stratum controls.';
      case 'scheduled':
        return '<strong>Stratum pause scheduled</strong> ' + stRange(c.planned.start, c.planned.end) +
          ' UTC (starts in ' + stDur(Number(c.planned.start) - now) + ').';
      case 'ok':
        return 'Stratum accepting.';
      default:
        return 'Stratum state unknown.';
    }
  }
  // ── STRATUM-VIEW END ──

  var STRATUM_PAGE = 'settings-announcements.html';
  var ST = { last: null, subs: [], errSubs: [], timer: null, strip: null, wrap: null, main: null, inflight: false };

  function stNow() { return Math.floor(Date.now() / 1000); }

  function stPublish(c) {
    ST.last = c;
    renderStratumStrip();
    ST.subs.slice().forEach(function (fn) { try { fn(c); } catch (e) { /* one reader must not stop the rest */ } });
  }

  // The strip stays silent on a failed poll; a page that shows the state itself subscribes an
  // onError so it can say "unknown" instead of leaving the last answer up as if it were fresh.
  function stFetch() {
    if (ST.inflight) return;
    ST.inflight = true;
    fetch('/api/admin/stratum/control', { credentials: 'include', cache: 'no-store' })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (d) {
          if (!r.ok || !d || !d.success) throw new Error((d && d.error) || ('HTTP ' + r.status));
          return d;
        });
      })
      .then(function (d) { ST.lastErr = null; stPublish(d); }, function (err) {
        ST.lastErr = err;
        ST.errSubs.slice().forEach(function (fn) { try { fn(err); } catch (e) {} });
      })
      .then(function () { ST.inflight = false; });
  }

  function renderStratumStrip() {
    var c = ST.last, k = stClassify(c, stNow());
    if (!k.tone) {
      if (ST.strip && ST.strip.parentNode) ST.strip.parentNode.removeChild(ST.strip);
      ST.strip = null;
      return;
    }
    if (!ST.strip) {
      ST.strip = document.createElement('div');
      ST.strip.className = 'admin-stratum-strip';
      ST.strip.setAttribute('role', 'status');
      ST.wrap.insertBefore(ST.strip, ST.wrap.querySelector('.admin-rail') || ST.main);
    }
    ST.strip.classList.toggle('tone-amber', k.tone === 'amber');
    // Region health (Regions page, the Health link to it) is read from the WireGuard handshake
    // and a TCP probe that hits the gateway's HAProxy — both stay green during a pause.
    var tunnelNote = (k.level === 'paused' || k.level === 'pausing') &&
      (here === 'regions.html' || here === 'health.html')
      ? ' <span class="strip-note">Region status here reflects the tunnel, not intake.</span>' : '';
    ST.strip.innerHTML = '<span class="strip-text">' + stSummaryHtml(c, stNow()) + tunnelNote + '</span>' +
      (here === STRATUM_PAGE ? '<a href="#" data-stratum-jump>Stratum controls ↓</a>'
                             : '<a href="' + STRATUM_PAGE + '?findh=Stratum">Stratum controls →</a>');
    var jump = ST.strip.querySelector('[data-stratum-jump]');
    if (jump) jump.addEventListener('click', function (e) { e.preventDefault(); findTarget(null, 'Stratum'); });
  }

  function startStratumStrip(wrap, main) {
    ST.wrap = wrap;
    ST.main = main;
    stFetch();
    // The countdown in the strip goes stale between polls; re-render it every 30 s for free.
    setInterval(function () { if (ST.last) renderStratumStrip(); }, 30000);
    ST.timer = setInterval(function () { if (!document.hidden) stFetch(); }, here === STRATUM_PAGE ? 15000 : 60000);
    document.addEventListener('visibilitychange', function () { if (!document.hidden) stFetch(); });
  }

  window.AdminStratum = {
    // fn(control) on every poll answer — called at once if one already arrived; onErr(Error)
    // on every failed poll.
    subscribe: function (fn, onErr) {
      ST.subs.push(fn);
      if (typeof onErr === 'function') ST.errSubs.push(onErr);
      if (ST.last) { try { fn(ST.last); } catch (e) {} }
      else if (ST.lastErr && typeof onErr === 'function') { try { onErr(ST.lastErr); } catch (e) {} }
    },
    refresh: stFetch,
    // A page that just acted hands over the state its POST returned — no extra round trip.
    set: function (c) { if (c && typeof c === 'object') stPublish(Object.assign({}, ST.last || {}, c)); },
    last: function () { return ST.last; },
    classify: function (c) { return stClassify(c, stNow()); },
    summaryHtml: function (c) { return stSummaryHtml(c, stNow()); },
    down: stDown, time: stTime, range: stRange, dur: stDur, now: stNow
  };

  /* ── In-page section rail ─────────────────────────────────────────────────
     Several admin pages (treasury, ads, health, the bigger settings pages) are
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
      // Cache the chain + the operator's (server-resolved) explorer so window.Explorer builds
      // the right deep-links; explorerKey() re-validates it. No key → clear a stale one.
      try {
        if (d.network) sessionStorage.setItem(NETWORK_KEY, d.network);
        if (typeof d.explorer === 'string' && d.explorer) sessionStorage.setItem(EXPLORER_KEY, d.explorer);
        else sessionStorage.removeItem(EXPLORER_KEY);
      } catch (e) {}
      try { explorerRelink(); } catch (e) {}   // links a page rendered before this landed
      // Pages that depend on the chain (Settings → Branding greys out the explorer select on
      // testnet) read the attribute if they load late, or the event if they are listening.
      if (d.network) {
        document.documentElement.setAttribute('data-pool-network', d.network);
        try { document.dispatchEvent(new CustomEvent('admin:pool-network', { detail: { network: d.network } })); } catch (e) {}
      }
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
         empty: 'No payout requests in this window.',
         urlQuery: true,                    // optional: prefill the search from ?q=
         onSearch: function (q) { … },      // optional: after each keystroke in the search box
         onRender: function (tbody) { … }   // optional: after rows are painted
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
       make the table unusable while it refreshes.
     • onRender(tbody) runs after every paint of real rows (a page change, a search
       keystroke, setRows) — for work that must follow the markup, such as the Donors
       queue filling each banner <img> from an authenticated blob. Never for the
       loading/error/empty rows. A throw in it is caught: it must not blank the table.
     • onSearch(q) runs after each keystroke's local filter, with the trimmed text as typed
       (not lowercased) — for a page whose rows are a CAPPED subset of the server's, to look
       the query up server-side and add what it finds (miners.html). Not called for a ?q=
       prefill: the page reads `.query` itself once its first load says whether it needs to. */

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
        if (typeof opts.onRender === 'function') {
          try { opts.onRender(tbody); } catch (e) { /* the rows are already painted */ }
        }
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
    // urlQuery: true → start with the search box filled from the page's ?q= (a deep link such as
    // miners.html → payments.html?q=<address>). Opt-in per table, because a page with several
    // searchable tables must not filter all of them with one parameter. The value only ever
    // becomes the input's .value and the lowercase match string; it is never written as markup.
    if (input && opts.urlQuery) {
      try {
        var q0 = new URLSearchParams(window.location.search).get('q');
        if (q0) { input.value = q0.trim(); state.q = input.value.toLowerCase(); }
      } catch (e) { /* no URLSearchParams → just start unfiltered */ }
    }
    if (input) {
      input.addEventListener('input', function () {
        state.q = input.value.trim().toLowerCase();
        state.page = 1;              // a new query always starts at the top
        render();
        if (typeof opts.onSearch === 'function') {
          try { opts.onSearch(input.value.trim()); } catch (e) { /* the local filter already ran */ }
        }
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

  // ── Click-to-copy for [data-copy] elements (truncated addresses) ─────────
  // A 62-char bech32 address renders as `grin12rgur8d…swdz7s2` on every list page with
  // the full value one hover away — but a tooltip can't be selected, so getting an
  // address into a log grep, an explorer search or a ban reason meant a detour. Any
  // element with data-copy="<full value>" now copies that value on click (Enter/Space
  // too when it is a <button>) and flips its [data-tip] to "Copied ✓" for a moment.
  // Pages render the markup themselves — see the address cell in miners.html.
  var copyHost = null, copyTimer = null;

  function legacyCopy(text) {
    // Selection-based copy for browsers where navigator.clipboard is absent or blocked.
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;';
    document.body.appendChild(ta);
    ta.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    document.body.removeChild(ta);
    if (!ok) throw new Error('clipboard blocked');
  }

  function copyText(text) {
    // navigator.clipboard needs a secure context; an http:// admin on a LAN box (a testnet
    // trial with no cert yet) has none, so fall through to the selection-based copy there.
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text).catch(function () { return legacyCopy(text); });
    }
    return new Promise(function (resolve) { resolve(legacyCopy(text)); });
  }

  function copyRestore() {
    if (copyTimer) { clearTimeout(copyTimer); copyTimer = null; }
    var host = copyHost;
    copyHost = null;
    if (!host) return;
    var orig = host.getAttribute('data-tip-orig');
    if (orig !== null) { host.setAttribute('data-tip', orig); host.removeAttribute('data-tip-orig'); }
    host.classList.remove('is-copied', 'is-copy-failed');
    // Still hovered? Re-show the normal tip — unless a table refresh replaced the row.
    if (tipHost === host) {
      if (document.body.contains(host) && host.getAttribute('data-tip')) tipShow(host);
      else tipHide();
    }
  }

  function copyFlash(host, text, cls) {
    copyRestore();                      // a second click mid-flash must not save "Copied ✓" as the original
    copyHost = host;
    if (!host.hasAttribute('data-tip-orig')) host.setAttribute('data-tip-orig', host.getAttribute('data-tip') || '');
    host.setAttribute('data-tip', text);
    host.classList.add(cls);
    tipHost = host;                     // the click listener above just hid it; bring it back with the new text
    tipShow(host);
    copyTimer = setTimeout(copyRestore, 1500);
  }

  document.addEventListener('click', function (e) {
    var host = e.target && e.target.closest ? e.target.closest('[data-copy]') : null;
    if (!host) return;
    var value = host.getAttribute('data-copy');
    if (!value) return;
    e.preventDefault();
    copyText(value).then(function () {
      copyFlash(host, 'Copied ✓', 'is-copied');
    }, function () {
      // Nothing worked: expand the cell to the full value so it can at least be selected.
      host.textContent = value;
      copyFlash(host, 'Copy blocked by the browser — select it by hand', 'is-copy-failed');
    });
  });

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
