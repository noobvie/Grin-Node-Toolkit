/* ============================================================================
   ads.js — render operator-managed ads into public placement slots  [2026-06]
   ----------------------------------------------------------------------------
   Fetches GET /api/public/ads (active, in-window ads grouped by placement) and
   fills every [data-ad-slot="<placement>"] element on the page. Two ad kinds:
     · banner — <img> (optionally wrapped in a sponsored link)
     · code   — operator-trusted HTML/JS snippet (ad-network zone). innerHTML does
                NOT run <script> tags, so we re-create them so network tags execute.
   Placements: header, sidebar, in-content, footer. Header/footer slots are
   injected site-wide by public-shell.js; sidebar/in-content are per-page anchors.
   ========================================================================== */
(function () {
  'use strict';

  function attr(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/"/g, '&quot;')
      .replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // A real click-through target (anything but empty or the '#' starter placeholder).
  function hasLink(url) { return !!url && url !== '#'; }
  // Site paths (start with a single '/') open in the SAME tab; external URLs open in a new
  // tab with the usual sponsored-link rels. Self-promo CTAs are internal, so they navigate
  // in place rather than spawning a tab back to our own site.
  function isInternal(url) { return /^\/(?!\/)/.test(url); }
  function linkOpen(url) {
    return isInternal(url) ? '' : ' target="_blank" rel="noopener nofollow sponsored"';
  }

  function renderAd(ad) {
    var idAttr = ' data-ad-id="' + (parseInt(ad.id, 10) || 0) + '"';
    if (ad.ad_type === 'code' && ad.html_code) {
      return '<div class="ad-unit ad-unit--code"' + idAttr + '>' + ad.html_code + '</div>';
    }
    if (ad.ad_type === 'text' && ad.headline) {
      var card = '<span class="ad-text-head">' + attr(ad.headline) + '</span>' +
        (ad.body_text ? '<span class="ad-text-body">' + attr(ad.body_text) + '</span>' : '') +
        (ad.cta_label ? '<span class="ad-text-cta">' + attr(ad.cta_label) + '</span>' : '');
      var body = hasLink(ad.link_url)
        ? '<a class="ad-text-card" href="' + attr(ad.link_url) + '"' + linkOpen(ad.link_url) +
          (ad.headline ? ' title="' + attr(ad.headline) + '"' : '') + '>' + card + '</a>'
        : '<div class="ad-text-card">' + card + '</div>';
      return '<div class="ad-unit ad-unit--text"' + idAttr + '>' + body + '</div>';
    }
    if (ad.ad_type === 'banner' && ad.image_url) {
      var img = '<img src="' + attr(ad.image_url) + '" alt="' + attr(ad.alt_text || '') + '" loading="lazy">';
      // '#' is the shipped starter placeholder — render it as a plain image rather than
      // a link that opens an empty tab. Clicks are still counted on the unit itself.
      if (!hasLink(ad.link_url)) return '<div class="ad-unit ad-unit--banner"' + idAttr + '>' + img + '</div>';
      var inner = '<a href="' + attr(ad.link_url) + '"' + linkOpen(ad.link_url) +
        (ad.alt_text ? ' title="' + attr(ad.alt_text) + '"' : '') + '>' + img + '</a>';
      return '<div class="ad-unit ad-unit--banner"' + idAttr + '>' + inner + '</div>';
    }
    return '';
  }

  // ── Impression/click beacon ──────────────────────────────────────────────
  // Aggregate counters only (POST /api/public/ads/event — the server stores no
  // visitor data). Impressions: once per ad per pageload, when the ad is actually
  // shown (rotation reveals count; hidden rotor ads don't). Batched + sent via
  // sendBeacon so it never blocks navigation; totally fail-silent.
  var _counted = {};
  var _pendingImpr = [];
  var _imprTimer = null;

  function sendEvent(payload) {
    try {
      var body = JSON.stringify(payload);
      if (navigator.sendBeacon) {
        navigator.sendBeacon('/api/public/ads/event', new Blob([body], { type: 'application/json' }));
      } else {
        fetch('/api/public/ads/event', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: body, keepalive: true
        }).catch(function () {});
      }
    } catch (e) { /* ads are non-essential */ }
  }

  function unitId(unit) {
    return parseInt(unit.getAttribute('data-ad-id'), 10) || 0;
  }

  function queueImpression(unit) {
    var id = unitId(unit);
    if (!id || _counted[id]) return;
    _counted[id] = true;
    _pendingImpr.push(id);
    clearTimeout(_imprTimer);
    _imprTimer = setTimeout(function () {
      var ids = _pendingImpr.splice(0);
      if (ids.length) sendEvent({ impressions: ids });
    }, 1500);
  }

  // innerHTML-inserted <script> tags never execute; re-create them so ad-network
  // snippets (e.g. Coinzilla/A-ADS zones) actually run.
  function activateScripts(container) {
    container.querySelectorAll('script').forEach(function (old) {
      var s = document.createElement('script');
      for (var i = 0; i < old.attributes.length; i++) {
        s.setAttribute(old.attributes[i].name, old.attributes[i].value);
      }
      s.text = old.textContent || '';
      old.parentNode.replaceChild(s, old);
    });
  }

  // ── Render settings (admin-set; defaults used if the API is unreachable) ──
  var cfg = {
    rotate_ms: 8000,      // multi-ad placement cycle interval
    sidebar_mode: 'rail', // rail | inline | off
    rail_show_ms: 12000,  // rail visible before tucking away
    rail_hide_ms: 45000   // rail tucked before peeking back (0 = never tuck)
  };

  // The rail only engages where there is real empty gutter beside the 1180px .wrap.
  // MUST match the @media breakpoint on .ad-slot--rail in dashboard.css.
  var RAIL_MQ = '(min-width: 1366px)';
  var RAIL_DISMISS_KEY = 'grinium.adRail.dismissed';

  function railDismissed() {
    try { return sessionStorage.getItem(RAIL_DISMISS_KEY) === '1'; } catch (e) { return false; }
  }
  function rememberDismiss() {
    try { sessionStorage.setItem(RAIL_DISMISS_KEY, '1'); } catch (e) { /* private mode */ }
  }

  // When one placement holds several active ads, show ONE at a time and cycle through
  // them (weight order from the API = cycle order; random entry point so different
  // pageloads lead with different ads). Code-ad scripts were already activated at
  // insert time — cycling only toggles visibility, it never re-runs snippets.
  function makeRotor(el) {
    var units = [].slice.call(el.querySelectorAll('.ad-unit'));
    if (!units.length) return null;
    var idx = Math.floor(Math.random() * units.length);
    if (units.length > 1) {
      units.forEach(function (u, i) {
        u.classList.add('ad-unit--rotor');
        if (i !== idx) u.classList.add('ad-unit--hidden');
      });
    }
    return {
      count: units.length,
      current: function () { return units[idx]; },
      advance: function () {
        if (units.length < 2) return units[idx];
        units[idx].classList.add('ad-unit--hidden');
        idx = (idx + 1) % units.length;
        units[idx].classList.remove('ad-unit--hidden');
        return units[idx];
      }
    };
  }

  function startAutoRotate(rotor) {
    if (!rotor || rotor.count < 2) return;
    setInterval(function () {
      if (document.hidden) return; // background tabs: don't burn impressions unseen
      queueImpression(rotor.advance()); // first reveal of this ad counts once
    }, Math.max(2000, cfg.rotate_ms));
  }

  // ── Sidebar rail ─────────────────────────────────────────────────────────
  // A slim vertical strip fixed in the page gutter: zero layout cost, and instead of
  // sitting there permanently it peeks out for rail_show_ms, tucks away for
  // rail_hide_ms, then slides back with the NEXT creative. Tucking is a transform, so
  // the page never reflows; a vertical tab stays reachable to pull it back by hand.
  function startRail(el, rotor) {
    el.classList.add('ad-slot--rail', 'is-tucked');
    if (railDismissed()) { el.classList.add('is-dismissed'); return; }

    var close = document.createElement('button');
    close.type = 'button';
    close.className = 'ad-rail-close';
    close.title = 'Hide ads for this visit';
    close.setAttribute('aria-label', 'Hide ads for this visit');
    close.textContent = '×';
    el.appendChild(close);

    var timer = null;
    var out = false; // is the rail currently peeked out?

    function at(ms, fn) { clearTimeout(timer); timer = setTimeout(fn, ms); }

    function show(advance) {
      if (el.classList.contains('is-dismissed')) return;
      // Background tab: wait rather than burning a peek (and an impression) unseen.
      if (document.hidden) { at(2000, function () { show(advance); }); return; }
      if (advance && rotor) rotor.advance();
      el.classList.remove('is-tucked');
      out = true;
      if (rotor) queueImpression(rotor.current());
      if (cfg.rail_hide_ms > 0) at(cfg.rail_show_ms, tuck);
    }

    function tuck() {
      el.classList.add('is-tucked');
      out = false;
      // rail_hide_ms = 0 is "always visible": a manual tuck then stays tucked until the
      // visitor pulls the tab again, instead of springing straight back out.
      if (cfg.rail_hide_ms > 0) at(cfg.rail_hide_ms, function () { show(true); });
      else clearTimeout(timer);
    }

    // The label doubles as the pull-tab: click toggles, and a manual pull restarts the
    // cycle from that point instead of yanking the rail away a moment later.
    var tab = el.querySelector('.ad-slot-label');
    if (tab) {
      tab.setAttribute('role', 'button');
      tab.setAttribute('tabindex', '0');
      tab.title = 'Show/hide this ad';
      var toggle = function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        if (out) tuck(); else show(false);
      };
      tab.addEventListener('click', toggle);
      tab.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter' || ev.key === ' ') toggle(ev);
      });
    }

    close.addEventListener('click', function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      clearTimeout(timer);
      el.classList.add('is-dismissed');
      rememberDismiss();
    });

    // First peek shortly after load, so it reads as an arriving banner rather than
    // part of the page furniture. No advance: keep the random entry creative.
    at(1200, function () { show(false); });

    // rail_hide_ms = 0 means "operator wants it always visible": there are no peeks to
    // advance on, so fall back to the normal timed cycle for multi-creative rails.
    if (cfg.rail_hide_ms === 0) startAutoRotate(rotor);
  }

  // ── The sidebar placement is the vertical-rail inventory (tall 160×600 creatives) ──
  // Below the rail breakpoint there is no gutter to park it in, so it would fall into the
  // page flow at full column width — a 600px-tall banner is a screenful of forced
  // scrolling on a phone. So on narrow screens the whole sidebar placement is simply not
  // rendered: mobile inventory belongs in header / in-content / footer. This is
  // structural (keyed off the placement, not off measuring a creative at runtime), so it
  // can never leak the way an aspect-ratio guess could. dashboard.css hides
  // .ad-slot--sidebar below the same breakpoint as a CSS belt-and-braces.

  function fill(byPlacement) {
    var narrow = !!window.matchMedia && !window.matchMedia(RAIL_MQ).matches;
    var railOK = cfg.sidebar_mode === 'rail' && !narrow;

    document.querySelectorAll('[data-ad-slot]').forEach(function (el) {
      var placement = el.getAttribute('data-ad-slot');
      var ads = (byPlacement && byPlacement[placement]) || [];
      var isSidebar = placement === 'sidebar';
      var isInContent = placement === 'in-content';
      // Sidebar is off entirely when the operator disabled it, and always on narrow
      // screens (see the note above — don't even build the DOM/load the image).
      if (!ads.length || (isSidebar && (cfg.sidebar_mode === 'off' || narrow))) { el.style.display = 'none'; return; }

      function render(list) {
        var html = list.map(renderAd).filter(Boolean).join('');
        if (!html) { el.style.display = 'none'; return; }
        el.innerHTML = '<span class="ad-slot-label">Ad</span>' + html;
        activateScripts(el);
        el.style.display = '';

        if (isInContent) {
          // in-content shows EVERY active creative side by side — a balanced centred row
          // (two 300×250 squares on desktop) that wraps to a stack on mobile — never a
          // one-at-a-time rotor, so there is no lone square marooned in an empty band.
          el.querySelectorAll('.ad-unit').forEach(function (u) { queueImpression(u); });
        } else {
          var rotor = makeRotor(el);
          if (isSidebar && railOK) {
            startRail(el, rotor);          // rail drives its own cycling, one creative per peek
          } else {
            startAutoRotate(rotor);
            // count what's actually visible now (all units when static, the lead unit when cycling)
            el.querySelectorAll('.ad-unit').forEach(function (u) {
              if (!u.classList.contains('ad-unit--hidden')) queueImpression(u);
            });
          }
        }

        // click beacon (delegated; sendBeacon survives the target="_blank" navigation)
        el.addEventListener('click', function (ev) {
          var unit = ev.target && ev.target.closest ? ev.target.closest('.ad-unit') : null;
          var id = unit ? unitId(unit) : 0;
          if (id) sendEvent({ clicks: [id] });
        });
      }

      render(ads);
    });
  }

  fetch('/api/public/ads')
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (d) {
      if (!d) return;
      ['rotate_ms', 'rail_show_ms', 'rail_hide_ms'].forEach(function (k) {
        if (typeof d[k] === 'number' && d[k] >= 0) cfg[k] = d[k];
      });
      if (d.sidebar_mode) cfg.sidebar_mode = d.sidebar_mode;
      if (d.ads) fill(d.ads);
    })
    .catch(function () { /* ads are non-essential; fail silent */ });
})();
