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

  function renderAd(ad) {
    var idAttr = ' data-ad-id="' + (parseInt(ad.id, 10) || 0) + '"';
    if (ad.ad_type === 'code' && ad.html_code) {
      return '<div class="ad-unit ad-unit--code"' + idAttr + '>' + ad.html_code + '</div>';
    }
    if (ad.ad_type === 'banner' && ad.image_url) {
      var img = '<img src="' + attr(ad.image_url) + '" alt="' + attr(ad.alt_text || '') + '" loading="lazy">';
      var inner = ad.link_url
        ? '<a href="' + attr(ad.link_url) + '" target="_blank" rel="noopener nofollow sponsored"' +
          (ad.alt_text ? ' title="' + attr(ad.alt_text) + '"' : '') + '>' + img + '</a>'
        : img;
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

  // When one placement holds several active ads, show ONE at a time and rotate
  // (weight order from the API = cycle order; random entry point so different
  // pageloads lead with different ads). Code-ad scripts were already activated at
  // insert time — rotation only toggles visibility, it never re-runs snippets.
  var rotateMs = 8000; // default; overridden by rotate_ms from the API (admin-set)

  function startRotation(el) {
    var units = el.querySelectorAll('.ad-unit');
    if (units.length < 2) return;
    var idx = Math.floor(Math.random() * units.length);
    units.forEach(function (u, i) {
      u.classList.add('ad-unit--rotor');
      if (i !== idx) u.classList.add('ad-unit--hidden');
    });
    setInterval(function () {
      if (document.hidden) return; // background tabs: don't burn impressions unseen
      units[idx].classList.add('ad-unit--hidden');
      idx = (idx + 1) % units.length;
      units[idx].classList.remove('ad-unit--hidden');
      queueImpression(units[idx]); // first reveal of this ad counts once
    }, rotateMs);
  }

  function fill(byPlacement) {
    document.querySelectorAll('[data-ad-slot]').forEach(function (el) {
      var placement = el.getAttribute('data-ad-slot');
      var ads = (byPlacement && byPlacement[placement]) || [];
      var html = ads.map(renderAd).filter(Boolean).join('');
      if (!html) { el.style.display = 'none'; return; }
      el.innerHTML = '<span class="ad-slot-label">Ad</span>' + html;
      activateScripts(el);
      el.style.display = '';
      startRotation(el);
      // count what's actually visible now (all units when static, the lead unit when rotating)
      el.querySelectorAll('.ad-unit').forEach(function (u) {
        if (!u.classList.contains('ad-unit--hidden')) queueImpression(u);
      });
      // click beacon (delegated; sendBeacon survives the target="_blank" navigation)
      el.addEventListener('click', function (ev) {
        var unit = ev.target && ev.target.closest ? ev.target.closest('.ad-unit') : null;
        var id = unit ? unitId(unit) : 0;
        if (id) sendEvent({ clicks: [id] });
      });
    });
  }

  fetch('/api/public/ads')
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (d) {
      if (!d) return;
      if (d.rotate_ms > 0) rotateMs = d.rotate_ms;
      if (d.ads) fill(d.ads);
    })
    .catch(function () { /* ads are non-essential; fail silent */ });
})();
