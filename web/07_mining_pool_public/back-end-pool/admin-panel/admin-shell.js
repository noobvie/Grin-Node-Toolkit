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
  // to a public Grin chain explorer in a new tab. To spread load — and avoid tying the
  // pool to a single explorer — each mainnet link randomly picks between grinscan.org
  // and scan.grin.money; both share the same path scheme (/block/<h>, /kernel/<excess>,
  // /output/<commit>). scan.grin.money is mainnet-only, so on testnet every link uses
  // testnet.grinscan.org. Network is resolved once by decoratePoolIdentity() (below) and
  // cached in sessionStorage; until then we assume mainnet (the common deployment).
  var NETWORK_KEY = 'pool-network';
  function explorerNetwork() {
    try { var n = sessionStorage.getItem(NETWORK_KEY); if (n) return n; } catch (e) {}
    return 'mainnet';
  }
  var EXPLORERS = ['https://grinscan.org', 'https://scan.grin.money'];
  function explorerBase(kind) {
    if (explorerNetwork() === 'testnet') return 'https://testnet.grinscan.org';
    // kernel/output deep-links are only guaranteed on scan.grin.money; heights & hashes
    // resolve on both, so those randomize across the two explorers.
    if (kind === 'kernel' || kind === 'output') return 'https://scan.grin.money';
    return EXPLORERS[Math.random() < 0.5 ? 0 : 1];
  }
  function explorerUrl(kind, value) {
    var path = (kind === 'kernel') ? 'kernel' : (kind === 'output') ? 'output' : 'block';
    return explorerBase(kind) + '/' + path + '/' + encodeURIComponent(String(value));
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

  // Body already parsed up to this script (end of <body>), so mount now.
  if (document.querySelector('main')) {
    mount();
  } else {
    document.addEventListener('DOMContentLoaded', mount);
  }
})();
