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
    if (ad.ad_type === 'code' && ad.html_code) {
      return '<div class="ad-unit ad-unit--code">' + ad.html_code + '</div>';
    }
    if (ad.ad_type === 'banner' && ad.image_url) {
      var img = '<img src="' + attr(ad.image_url) + '" alt="' + attr(ad.alt_text || '') + '" loading="lazy">';
      var inner = ad.link_url
        ? '<a href="' + attr(ad.link_url) + '" target="_blank" rel="noopener nofollow sponsored"' +
          (ad.alt_text ? ' title="' + attr(ad.alt_text) + '"' : '') + '>' + img + '</a>'
        : img;
      return '<div class="ad-unit ad-unit--banner">' + inner + '</div>';
    }
    return '';
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

  function fill(byPlacement) {
    document.querySelectorAll('[data-ad-slot]').forEach(function (el) {
      var placement = el.getAttribute('data-ad-slot');
      var ads = (byPlacement && byPlacement[placement]) || [];
      var html = ads.map(renderAd).filter(Boolean).join('');
      if (!html) { el.style.display = 'none'; return; }
      el.innerHTML = '<span class="ad-slot-label">Ad</span>' + html;
      activateScripts(el);
      el.style.display = '';
    });
  }

  fetch('/api/public/ads')
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (d) { if (d && d.ads) fill(d.ads); })
    .catch(function () { /* ads are non-essential; fail silent */ });
})();
