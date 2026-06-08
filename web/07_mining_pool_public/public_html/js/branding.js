// branding.js — client-side white-label injector for public pool pages.
//
// Static pages are served by nginx (the Node/Express backend only handles /api/*),
// so branding can't be templated server-side. Instead every public page loads this
// script, which fetches /api/public/branding and applies the operator's customisation:
//   · document title + meta description/keywords/robots/theme-color
//   · Open Graph + Twitter card tags + canonical URL
//   · JSON-LD structured data (Organization)
//   · theme (custom CSS variables, accent colour, custom CSS, web font)
//   · analytics (GA4 / Plausible / Umami / Matomo) + raw custom <head> HTML
//   · [data-brand] content hooks (hero heading/subheading, CTA, footer, social links)
//
// All operations are defensive: a failed fetch or a missing field leaves the page's
// hardcoded defaults untouched. Nothing here throws to the page.

(function () {
  'use strict';

  var ENDPOINT = '/api/public/branding';

  // Which logical page is this? Pages set <html data-page="home">; otherwise we
  // derive a key from the path so per-page SEO overrides still work.
  function currentPageKey() {
    var explicit = document.documentElement.getAttribute('data-page');
    if (explicit) return explicit;
    var path = (location.pathname || '/').replace(/\/+$/, '');
    if (path === '' || path === '/index' ) return 'home';
    var last = path.split('/').pop() || 'home';
    return last.replace(/\.html$/, '');
  }

  // ── small DOM helpers ──────────────────────────────────────────────────────
  function head() { return document.head || document.getElementsByTagName('head')[0]; }

  function setMetaByName(name, content) {
    if (!content) return;
    var el = document.querySelector('meta[name="' + name + '"]');
    if (!el) { el = document.createElement('meta'); el.setAttribute('name', name); head().appendChild(el); }
    el.setAttribute('content', content);
  }

  function setMetaByProperty(prop, content) {
    if (!content) return;
    var el = document.querySelector('meta[property="' + prop + '"]');
    if (!el) { el = document.createElement('meta'); el.setAttribute('property', prop); head().appendChild(el); }
    el.setAttribute('content', content);
  }

  function setLinkRel(rel, href) {
    if (!href) return;
    var el = document.querySelector('link[rel="' + rel + '"]');
    if (!el) { el = document.createElement('link'); el.setAttribute('rel', rel); head().appendChild(el); }
    el.setAttribute('href', href);
  }

  function absUrl(base, maybeRelative) {
    if (!maybeRelative) return '';
    if (/^https?:\/\//i.test(maybeRelative)) return maybeRelative;
    if (!base) return maybeRelative;
    return base.replace(/\/+$/, '') + (maybeRelative.charAt(0) === '/' ? '' : '/') + maybeRelative;
  }

  // ── 1. SEO / meta tags ─────────────────────────────────────────────────────
  function applySeo(cfg) {
    var pool = cfg.pool || {};
    var seo = cfg.seo || {};
    var brand = cfg.branding || {};
    var page = currentPageKey();
    var pageSeo = (seo.page_seo && seo.page_seo[page]) || {};

    var poolName = pool.name || '';
    var pageLabel = pageSeo.label || prettyPage(page);

    // Title: per-page override wins, else the title_template, else leave as-is.
    var title = pageSeo.title;
    if (!title && seo.title_template && poolName) {
      title = seo.title_template
        .replace(/%page%/g, pageLabel || poolName)
        .replace(/%pool_name%/g, poolName);
    }
    if (title) document.title = title;

    var description = pageSeo.description || seo.meta_description;
    setMetaByName('description', description);
    setMetaByName('keywords', seo.meta_keywords);
    setMetaByName('theme-color', seo.theme_color);
    if (seo.robots_noindex) setMetaByName('robots', 'noindex, nofollow');

    var siteUrl = seo.site_url || '';
    var canonical = siteUrl ? absUrl(siteUrl, location.pathname) : '';
    if (canonical) setLinkRel('canonical', canonical);

    // Open Graph
    setMetaByProperty('og:type', 'website');
    setMetaByProperty('og:title', seo.og_title || title || poolName);
    setMetaByProperty('og:description', seo.og_description || description);
    setMetaByProperty('og:site_name', poolName);
    setMetaByProperty('og:locale', seo.og_locale);
    if (canonical) setMetaByProperty('og:url', canonical);
    var ogImage = absUrl(siteUrl, seo.og_image_url);
    if (ogImage) setMetaByProperty('og:image', ogImage);

    // Twitter card
    setMetaByName('twitter:card', seo.twitter_card_type || 'summary_large_image');
    setMetaByName('twitter:title', seo.og_title || title || poolName);
    setMetaByName('twitter:description', seo.og_description || description);
    if (seo.twitter_handle) setMetaByName('twitter:site', normalizeHandle(seo.twitter_handle));
    if (ogImage) setMetaByName('twitter:image', ogImage);

    // Favicon + PWA icons
    if (brand.favicon_url) setLinkRel('icon', brand.favicon_url);
    if (brand.apple_touch_url) setLinkRel('apple-touch-icon', brand.apple_touch_url);

    if (seo.structured_data_enabled && poolName) injectStructuredData(cfg, canonical, ogImage);
  }

  function prettyPage(key) {
    if (!key || key === 'home' || key === 'index') return '';
    return key.replace(/[-_]/g, ' ').replace(/\b\w/g, function (c) { return c.toUpperCase(); });
  }

  function normalizeHandle(h) {
    if (/^https?:\/\//i.test(h)) return h;
    return h.charAt(0) === '@' ? h : '@' + h;
  }

  function injectStructuredData(cfg, canonical, ogImage) {
    try {
      var pool = cfg.pool || {};
      var ld = {
        '@context': 'https://schema.org',
        '@type': 'Organization',
        name: pool.name,
        description: pool.description || (cfg.seo && cfg.seo.meta_description) || ''
      };
      if (canonical) ld.url = canonical;
      if (ogImage) ld.logo = ogImage;
      var social = (cfg.branding && cfg.branding.social) || {};
      var sameAs = [social.twitter, social.discord, social.telegram, social.website].filter(Boolean);
      if (sameAs.length) ld.sameAs = sameAs;

      var s = document.createElement('script');
      s.type = 'application/ld+json';
      s.setAttribute('data-brand-ld', '1');
      s.textContent = JSON.stringify(ld);
      head().appendChild(s);
    } catch (e) { /* non-fatal */ }
  }

  // ── 2. Theme / colours / fonts ─────────────────────────────────────────────
  function applyTheme(cfg) {
    var brand = cfg.branding || {};
    var root = document.documentElement;

    // Custom theme: a map of CSS-variable name -> value. Works regardless of which
    // theme system a page uses, because both the public pages and the admin panel
    // read from CSS custom properties.
    var custom = brand.custom_theme || {};
    Object.keys(custom).forEach(function (k) {
      if (!custom[k]) return;
      var name = k.charAt(0) === '-' ? k : '--' + k;
      root.style.setProperty(name, custom[k]);
    });

    // Accent colour drives the most common variables.
    if (brand.accent_color) {
      ['--accent', '--primary', '--btn-bg'].forEach(function (v) {
        root.style.setProperty(v, brand.accent_color);
      });
    }

    // Named default theme. Three possible runtimes:
    //   · public pages  → GriniumTheme (public-theme.js) owns the body class + switcher
    //   · admin panel   → ThemeSwitcher (theme.js) applies CSS variables
    //   · neither loaded → fall back to adding the body class directly
    if (brand.default_theme) {
      try { localStorage.setItem('admin-theme', brand.default_theme); } catch (e) {}
      if (window.GriniumTheme && typeof window.GriniumTheme.applyDefault === 'function') {
        window.GriniumTheme.applyDefault(
          brand.default_theme, !!brand.allow_theme_switch, brand.enabled_themes);
      } else if (window.ThemeSwitcher && typeof window.ThemeSwitcher.applyTheme === 'function') {
        // Don't override a visitor's saved choice when switching is allowed.
        if (!brand.allow_theme_switch || !localStorage.getItem('user-theme')) {
          window.ThemeSwitcher.applyTheme(brand.default_theme);
        }
      } else {
        document.body && document.body.classList.add(brand.default_theme + '-theme');
      }
    }

    // Web font.
    if (brand.font_url) {
      setLinkRel('preconnect', 'https://fonts.googleapis.com');
      var l = document.createElement('link');
      l.rel = 'stylesheet';
      l.href = brand.font_url;
      head().appendChild(l);
    }
    if (brand.font_family) {
      root.style.setProperty('--brand-font', brand.font_family);
      var fs = document.createElement('style');
      fs.textContent = 'body{font-family:' + brand.font_family + ',var(--brand-font-fallback,sans-serif);}';
      head().appendChild(fs);
    }

    // Operator custom CSS (last so it can override everything above).
    if (brand.custom_css) {
      var st = document.createElement('style');
      st.setAttribute('data-brand-css', '1');
      st.textContent = brand.custom_css;
      head().appendChild(st);
    }
  }

  // ── 3. Content hooks ([data-brand="..."]) ──────────────────────────────────
  function applyContent(cfg) {
    var pool = cfg.pool || {};
    var brand = cfg.branding || {};
    var social = brand.social || {};

    var map = {
      pool_name: pool.name,
      pool_tagline: pool.tagline,
      pool_description: pool.description,
      hero_heading: brand.hero_heading,
      hero_subheading: brand.hero_subheading,
      footer_text: brand.footer_text,
      contact_email: pool.contact_email
    };
    Object.keys(map).forEach(function (key) {
      if (!map[key]) return;
      document.querySelectorAll('[data-brand="' + key + '"]').forEach(function (el) {
        el.textContent = map[key];
      });
    });

    // CTA button: set text + link if a hook exists.
    document.querySelectorAll('[data-brand="cta"]').forEach(function (el) {
      if (brand.cta_text) el.textContent = brand.cta_text;
      if (brand.cta_link && el.tagName === 'A') el.setAttribute('href', brand.cta_link);
      if (brand.cta_text || brand.cta_link) el.style.display = '';
    });

    // Social links: show/hide + set href on hooks like data-brand="social-discord".
    Object.keys(social).forEach(function (net) {
      var url = social[net];
      document.querySelectorAll('[data-brand="social-' + net + '"]').forEach(function (el) {
        if (url) {
          if (el.tagName === 'A') el.setAttribute('href', url);
          el.style.display = '';
        } else {
          el.style.display = 'none';
        }
      });
    });

    // Logo image hooks.
    if (brand.logo_url) {
      document.querySelectorAll('[data-brand="logo"]').forEach(function (el) {
        if (el.tagName === 'IMG') el.setAttribute('src', brand.logo_url);
      });
    }

    // Homepage announcement banner.
    if (pool.homepage_banner) {
      document.querySelectorAll('[data-brand="banner"]').forEach(function (el) {
        el.innerHTML = pool.homepage_banner; // operator-controlled content
        el.style.display = '';
      });
    }

    // "Powered by" attribution toggle.
    if (!brand.show_attribution) {
      document.querySelectorAll('[data-brand="attribution"]').forEach(function (el) {
        el.style.display = 'none';
      });
    }

    // Content-page footer links (About / Terms / Privacy / FAQ / Impressum).
    var pages = cfg.pages || [];
    document.querySelectorAll('[data-brand="page-links"]').forEach(function (container) {
      if (!pages.length) return;
      container.innerHTML = '';
      pages.forEach(function (p) {
        var a = document.createElement('a');
        a.href = '/page.html?p=' + encodeURIComponent(p.key);
        a.textContent = p.title;
        a.style.margin = '0 .5rem';
        container.appendChild(a);
      });
    });

    // Connection details for the miner-config generator.
    var conn = cfg.connection || {};
    var stratumUrl = conn.stratum_host ? (conn.stratum_host + ':' + conn.stratum_port) : '';
    var connMap = {
      stratum_host: conn.stratum_host,
      stratum_port: conn.stratum_port,
      stratum_url: stratumUrl,
      network: conn.network,
      algorithm: conn.algorithm
    };
    Object.keys(connMap).forEach(function (key) {
      if (!connMap[key]) return;
      document.querySelectorAll('[data-brand="' + key + '"]').forEach(function (el) {
        el.textContent = connMap[key];
      });
    });
  }

  // ── 4. Analytics + custom head HTML ────────────────────────────────────────
  function applyAnalytics(cfg) {
    var a = cfg.analytics || {};

    // Raw operator-supplied <head> HTML (verification tags, custom pixels, etc.).
    if (a.custom_head_html) {
      var tmp = document.createElement('div');
      tmp.innerHTML = a.custom_head_html;
      // Move parsed nodes into <head>. Inline <script> created via innerHTML does NOT
      // execute, so recreate script elements so they run.
      Array.prototype.slice.call(tmp.childNodes).forEach(function (node) {
        if (node.tagName === 'SCRIPT') {
          head().appendChild(cloneScript(node));
        } else {
          head().appendChild(node);
        }
      });
    }

    // Raw operator-supplied HTML appended before </body> (chat widgets, etc.).
    if (a.custom_body_html && document.body) {
      var b = document.createElement('div');
      b.innerHTML = a.custom_body_html;
      Array.prototype.slice.call(b.childNodes).forEach(function (node) {
        if (node.tagName === 'SCRIPT') {
          document.body.appendChild(cloneScript(node));
        } else {
          document.body.appendChild(node);
        }
      });
    }

    if (a.cookie_consent_enabled && !consentGiven()) {
      showConsentBanner(a, function () { loadProvider(a); });
      return;
    }
    loadProvider(a);
  }

  function cloneScript(node) {
    var s = document.createElement('script');
    if (node.src) s.src = node.src;
    if (node.type) s.type = node.type;
    if (node.async) s.async = true;
    if (node.textContent) s.textContent = node.textContent;
    return s;
  }

  function loadProvider(a) {
    switch (a.provider) {
      case 'ga4': return loadGa4(a.ga_tracking_id);
      case 'plausible': return loadPlausible(a);
      case 'umami': return loadUmami(a);
      case 'matomo': return loadMatomo(a);
      default: return;
    }
  }

  function loadGa4(id) {
    if (!id) return;
    var s = document.createElement('script');
    s.async = true;
    s.src = 'https://www.googletagmanager.com/gtag/js?id=' + encodeURIComponent(id);
    head().appendChild(s);
    var init = document.createElement('script');
    init.textContent =
      'window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}' +
      "gtag('js',new Date());gtag('config','" + id.replace(/'/g, '') + "');";
    head().appendChild(init);
  }

  function loadPlausible(a) {
    if (!a.plausible_domain || !a.plausible_src) return;
    var s = document.createElement('script');
    s.defer = true;
    s.setAttribute('data-domain', a.plausible_domain);
    s.src = a.plausible_src;
    head().appendChild(s);
  }

  function loadUmami(a) {
    if (!a.umami_website_id || !a.umami_src) return;
    var s = document.createElement('script');
    s.defer = true;
    s.setAttribute('data-website-id', a.umami_website_id);
    s.src = a.umami_src;
    head().appendChild(s);
  }

  function loadMatomo(a) {
    if (!a.matomo_url || !a.matomo_site_id) return;
    var base = a.matomo_url.replace(/\/+$/, '') + '/';
    window._paq = window._paq || [];
    window._paq.push(['trackPageView']);
    window._paq.push(['enableLinkTracking']);
    window._paq.push(['setTrackerUrl', base + 'matomo.php']);
    window._paq.push(['setSiteId', String(a.matomo_site_id)]);
    var s = document.createElement('script');
    s.async = true;
    s.src = base + 'matomo.js';
    head().appendChild(s);
  }

  // ── Cookie consent (only shown when enabled) ───────────────────────────────
  function consentGiven() {
    try { return localStorage.getItem('cookie-consent') === 'yes'; } catch (e) { return false; }
  }

  function showConsentBanner(a, onAccept) {
    if (document.getElementById('brand-consent')) return;
    var bar = document.createElement('div');
    bar.id = 'brand-consent';
    bar.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:9999;padding:1rem;' +
      'background:var(--bg-card,#1a1f29);color:var(--text,#e0e0e0);border-top:1px solid var(--border-color,#2d3748);' +
      'display:flex;gap:1rem;align-items:center;justify-content:center;flex-wrap:wrap;font-size:.9rem;';
    var msg = document.createElement('span');
    msg.textContent = a.cookie_consent_text || 'We use cookies for analytics.';
    var accept = document.createElement('button');
    accept.textContent = 'Accept';
    accept.style.cssText = 'padding:.5rem 1.25rem;border:none;border-radius:4px;cursor:pointer;' +
      'background:var(--accent,#667eea);color:#fff;font-weight:600;';
    accept.addEventListener('click', function () {
      try { localStorage.setItem('cookie-consent', 'yes'); } catch (e) {}
      bar.remove();
      onAccept();
    });
    var decline = document.createElement('button');
    decline.textContent = 'Decline';
    decline.style.cssText = 'padding:.5rem 1.25rem;border:1px solid var(--border-color,#2d3748);' +
      'border-radius:4px;cursor:pointer;background:transparent;color:inherit;';
    decline.addEventListener('click', function () {
      try { localStorage.setItem('cookie-consent', 'no'); } catch (e) {}
      bar.remove();
    });
    bar.appendChild(msg); bar.appendChild(accept); bar.appendChild(decline);
    document.body.appendChild(bar);
  }

  // ── bootstrap ──────────────────────────────────────────────────────────────
  function apply(cfg) {
    try { applyTheme(cfg); } catch (e) {}

    // Maintenance mode: show a branded full-page overlay on public pages. Pages that
    // must stay reachable (login, admin, account) opt out with data-maintenance="exempt".
    var maint = cfg.maintenance || {};
    var exempt = document.documentElement.getAttribute('data-maintenance') === 'exempt';
    if (maint.enabled && !exempt) {
      try { applySeo(cfg); } catch (e) {}
      try { showMaintenance(cfg, maint); } catch (e) {}
      return; // skip normal content + analytics while down
    }

    try { applySeo(cfg); } catch (e) {}
    try { applyContent(cfg); } catch (e) {}
    try { applyIncentives(cfg.incentives || {}); } catch (e) {}
    try { renderBanners(cfg.announcements || []); } catch (e) {}
    try { applyAnalytics(cfg); } catch (e) {}
  }

  // ── Incentives: prize pool + recent fortune-board winners ───────────────────
  // Lightweight hooks so any public page can surface incentive info without its own
  // fetch. The full paginated fortune board (fortune-board.html) calls the dedicated
  // /api/public/lottery/winners endpoint instead.
  function applyIncentives(inc) {
    // Prize-pool size hook.
    document.querySelectorAll('[data-brand="prize-pool"]').forEach(function (el) {
      if (inc.enabled && typeof inc.prize_pool_grin === 'number') {
        el.textContent = inc.prize_pool_grin.toFixed(4) + ' GRIN';
      }
    });

    // Public donation address hook (community donations via Slatepack).
    document.querySelectorAll('[data-brand="donation-address"]').forEach(function (el) {
      if (inc.enabled && inc.donation_address) {
        el.textContent = inc.donation_address;
        var wrap = el.closest('[data-brand-show="donation"]');
        if (wrap) wrap.style.display = '';
      }
    });

    // Compact recent-winners list (e.g. a homepage "🎉 Latest winners" widget).
    var winners = inc.recent_winners || [];
    document.querySelectorAll('[data-brand="fortune-board"]').forEach(function (container) {
      if (!inc.enabled || !winners.length) return;
      container.innerHTML = '';
      winners.forEach(function (w) {
        var row = document.createElement('div');
        row.style.cssText = 'display:flex;justify-content:space-between;gap:1rem;padding:.3rem 0;';
        row.innerHTML = '<span>🎉 ' + escapeText(w.event) + ' — ' + escapeText(w.address) + '</span>' +
          '<strong>' + escapeText((w.amount || 0).toFixed ? w.amount.toFixed(4) : w.amount) + ' GRIN</strong>';
        container.appendChild(row);
      });
    });
  }

  // ── Maintenance overlay ────────────────────────────────────────────────────
  function showMaintenance(cfg, maint) {
    if (!document.body) return;
    document.title = maint.title || 'Under Maintenance';
    var pool = cfg.pool || {};
    var brand = cfg.branding || {};
    var overlay = document.createElement('div');
    overlay.id = 'brand-maintenance';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:99999;display:flex;flex-direction:column;' +
      'align-items:center;justify-content:center;text-align:center;padding:2rem;' +
      'background:var(--bg-body,#0f1419);color:var(--text,#e0e0e0);' +
      'font-family:var(--brand-font,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif);';
    var inner = '';
    if (brand.logo_url) {
      inner += '<img src="' + encodeURI(brand.logo_url) + '" alt="" style="max-height:80px;margin-bottom:1.5rem;">';
    } else if (pool.name) {
      inner += '<h2 style="margin:0 0 1.5rem;color:var(--accent,#667eea);">' + escapeText(pool.name) + '</h2>';
    }
    inner += '<h1 style="font-size:2rem;margin:0 0 1rem;">🛠 ' + escapeText(maint.title || 'Under Maintenance') + '</h1>';
    inner += '<div style="max-width:600px;color:var(--text-dim,#a0aec0);line-height:1.6;">' +
      (maint.message || '') + '</div>'; // operator-controlled message
    overlay.innerHTML = inner;
    document.body.appendChild(overlay);
  }

  function escapeText(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // ── Announcement banners ───────────────────────────────────────────────────
  function bannerDismissed(id) {
    try { return localStorage.getItem('banner-dismissed-' + id) === '1'; } catch (e) { return false; }
  }

  function renderBanners(banners) {
    if (!banners.length || !document.body) return;
    var palette = {
      news:        { bg: '#2b6cb0', fg: '#fff', icon: 'ℹ' },
      update:      { bg: '#2f855a', fg: '#fff', icon: '⬆' },
      maintenance: { bg: '#c05621', fg: '#fff', icon: '🛠' },
      warning:     { bg: '#c53030', fg: '#fff', icon: '⚠' }
    };
    var stack = document.createElement('div');
    stack.id = 'brand-banners';
    stack.style.cssText = 'position:relative;z-index:9998;';

    banners.forEach(function (b) {
      if (b.dismissible && bannerDismissed(b.id)) return;
      var c = palette[b.type] || palette.news;
      var bar = document.createElement('div');
      bar.style.cssText = 'display:flex;align-items:center;gap:.6rem;justify-content:center;' +
        'padding:.6rem 2.5rem .6rem 1rem;background:' + c.bg + ';color:' + c.fg + ';' +
        'font-size:.92rem;position:relative;';
      var msg = '<span aria-hidden="true">' + c.icon + '</span><span>' + escapeText(b.message) + '</span>';
      if (b.link) {
        msg += ' <a href="' + encodeURI(b.link) + '" style="color:' + c.fg +
          ';text-decoration:underline;font-weight:600;">' +
          escapeText(b.link_text || 'Learn more') + '</a>';
      }
      bar.innerHTML = msg;
      if (b.dismissible) {
        var x = document.createElement('button');
        x.textContent = '✕';
        x.setAttribute('aria-label', 'Dismiss');
        x.style.cssText = 'position:absolute;right:.6rem;top:50%;transform:translateY(-50%);' +
          'background:transparent;border:none;color:' + c.fg + ';cursor:pointer;font-size:1rem;line-height:1;';
        x.addEventListener('click', function () {
          try { localStorage.setItem('banner-dismissed-' + b.id, '1'); } catch (e) {}
          bar.remove();
        });
        bar.appendChild(x);
      }
      stack.appendChild(bar);
    });

    if (stack.children.length) document.body.insertBefore(stack, document.body.firstChild);
  }

  function load() {
    fetch(ENDPOINT, { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (json) { if (json && json.data) apply(json.data); })
      .catch(function () { /* keep page defaults */ });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', load);
  } else {
    load();
  }
})();
