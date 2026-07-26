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

  // ── Chain explorer deep-links (window.Explorer) ─────────────────────────────
  // Any block height / hash / kernel / output shown anywhere on a public page links out to a
  // public Grin chain explorer in a new tab — the miner's independent proof.
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
  // (06b GrinScan's testnet sibling). scan.grin.money is mainnet-only and test.grinscan.org
  // is testnet-only, so the pair covers both networks with no overlap. NOTE the testnet host
  // is `test.` — `testnet.grinscan.org` does NOT resolve (that typo made every testnet link
  // dead). To switch explorer, change DEFAULT_EXPLORER below — the style travels with the
  // entry, so a swap can never resurrect the mismatched-scheme bug.
  //
  // Network is resolved from the branding fetch (cfg.connection.network) and cached in
  // sessionStorage; until then we assume mainnet (the common deployment).
  var NETWORK_KEY = 'pool-network';
  function explorerNetwork() {
    try { var n = sessionStorage.getItem(NETWORK_KEY); if (n) return n; } catch (e) {}
    return 'mainnet';
  }
  // Path styles, keyed by explorer product. The value is the segment placed between the base
  // URL and the encoded reference.
  var EXPLORER_STYLES = {
    path:  { block: 'block/',            kernel: 'kernel/',             output: 'output/' },
    query: { block: 'block.html?h=',     kernel: 'kernel.html?ex=',     output: 'output.html?c=' }
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
  function xEsc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  // Returns an <a> (HTML string) that opens the explorer in a new tab. `label` defaults to
  // `value`. Both URL and label are HTML-escaped — safe for untrusted chain strings. A missing
  // value returns just the escaped label (no dead link).
  function explorerLink(kind, value, label, cls) {
    if (value == null || value === '') return xEsc(label == null ? '' : label);
    return '<a href="' + xEsc(explorerUrl(kind, value)) + '" target="_blank" rel="noopener" ' +
      'class="xplink' + (cls ? ' ' + xEsc(cls) : '') + '" title="Open on Grin chain explorer ↗">' +
      xEsc(label == null ? value : label) + '</a>';
  }
  function injectExplorerCss() {
    if (document.getElementById('xplink-css')) return;
    var s = document.createElement('style');
    s.id = 'xplink-css';
    // Inherit the surrounding colour so links embed cleanly in tables/rods; a dotted underline
    // signals "clickable" without fighting the reactor theme.
    s.textContent = 'a.xplink{color:inherit;text-decoration:underline;text-decoration-style:dotted;' +
      'text-underline-offset:2px;text-decoration-thickness:1px;cursor:pointer;}' +
      'a.xplink:hover{text-decoration-style:solid;opacity:.82;}';
    head().appendChild(s);
  }
  window.Explorer = { url: explorerUrl, link: explorerLink, network: explorerNetwork };

  // ── 1. SEO / meta tags ─────────────────────────────────────────────────────
  function applySeo(cfg) {
    var pool = cfg.pool || {};
    var seo = cfg.seo || {};
    var brand = cfg.branding || {};
    var page = currentPageKey();
    var pageSeo = (seo.page_seo && seo.page_seo[page]) || {};

    var poolName = pool.name || '';
    var tagline = pool.tagline || '';
    var pageLabel = pageSeo.label || prettyPage(page);
    var isHome = (page === 'home' || page === 'index');

    function fillTokens(tpl) {
      return tpl
        .replace(/%page%/g, pageLabel || poolName)
        .replace(/%pool_name%/g, poolName)
        .replace(/%tagline%/g, tagline);
    }

    // Title precedence:
    //   1. explicit per-page override (page_seo[page].title)
    //   2. home page → home_title (the %page% token is empty on home, so the
    //      generic template would duplicate the pool name)
    //   3. the generic title_template
    // …else leave the hard-coded <title> as-is.
    var title = pageSeo.title;
    if (!title && isHome && poolName) {
      // Home never uses the generic template (its %page% token is empty and would
      // duplicate the pool name). Use home_title, else the pool name alone.
      title = seo.home_title ? fillTokens(seo.home_title) : poolName;
    }
    if (!title && seo.title_template && poolName) {
      title = fillTokens(seo.title_template);
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
      var sameAs = [social.twitter, social.discord, social.telegram, social.nostr, social.website].filter(Boolean);
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
    //
    // Set on BOTH :root and <body>. The admin panel declares its palette on :root, but the
    // public pages declare their whole token bridge on `body` (dashboard.css) so themes.css
    // can remap it per theme class — and a declaration on body always beats an inherited
    // one from :root. Writing only to :root therefore made "Accent Color" and every
    // overlapping custom_theme var a silent no-op on the public site while appearing to
    // work in the admin preview. See the bridge note at the top of css/dashboard.css.
    function setVar(name, value) {
      root.style.setProperty(name, value);
      if (document.body) document.body.style.setProperty(name, value);
    }

    var custom = brand.custom_theme || {};
    Object.keys(custom).forEach(function (k) {
      if (!custom[k]) return;
      var name = k.charAt(0) === '-' ? k : '--' + k;
      setVar(name, custom[k]);
    });

    // Accent colour drives the most common variables. Deliberately NOT --neon-cyan (the
    // bridge's accent input): the bridge also derives --ok from it, so branding the site
    // red would repaint every "healthy" lamp red. This recolours the accent, not the
    // semantic status inks.
    if (brand.accent_color) {
      ['--accent', '--primary', '--btn-bg'].forEach(function (v) {
        setVar(v, brand.accent_color);
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
  // Decode a base64-encoded contact email from the public config. Returns '' on anything
  // unexpected so a bad value just hides the contact rather than throwing.
  function decodeEmail(enc) {
    if (!enc) return '';
    try {
      var s = (typeof atob === 'function') ? atob(enc) : '';
      return /@/.test(s) ? s : '';
    } catch (e) { return ''; }
  }

  // Wire an <a> as a mailto without ever placing the plaintext address in the DOM href:
  // the mailto: is built in JS at click time, defeating href-scraping harvesters.
  function wireMailto(el, addr, label) {
    if (!el || !addr) return;
    el.textContent = label || addr;
    el.setAttribute('href', '#');
    el.setAttribute('rel', 'nofollow');
    el.addEventListener('click', function (e) {
      e.preventDefault();
      window.location.href = 'mailto:' + addr;
    });
  }

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
      footer_text: brand.footer_text
    };
    Object.keys(map).forEach(function (key) {
      if (!map[key]) return;
      document.querySelectorAll('[data-brand="' + key + '"]').forEach(function (el) {
        el.textContent = map[key];
      });
    });

    // Contact email is delivered base64-encoded (decodeEmail) and only ever rendered by JS,
    // so it never appears in static HTML or the public config as a plaintext address.
    var contactEmail = decodeEmail(pool.contact_email_enc);
    if (contactEmail) {
      document.querySelectorAll('[data-brand="contact_email"]').forEach(function (el) {
        el.textContent = contactEmail;
      });
    }

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
      applyLogoVariant();
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

    // Content-page footer links (About / Terms / Privacy / FAQ / Impressum). Rendered as
    // plain block links so the footer column CSS lays them out; no inline spacing.
    var pages = cfg.pages || [];
    document.querySelectorAll('[data-brand="page-links"]').forEach(function (container) {
      if (!pages.length) return;
      container.innerHTML = '';
      pages.forEach(function (p) {
        var a = document.createElement('a');
        a.href = '/page.html?p=' + encodeURIComponent(p.key);
        a.textContent = p.title;
        container.appendChild(a);
      });
    });

    // Footer copyright: "Since <founded>". Uses the founding year when set, otherwise
    // the current year. Pool name is intentionally omitted — it already appears in the
    // footer brand column, so repeating it here is redundant.
    var year = new Date().getFullYear();
    var founded = parseInt(pool.founded_year, 10);
    var since = (founded && founded <= year) ? founded : year;
    document.querySelectorAll('[data-brand="copyright"]').forEach(function (el) {
      el.textContent = 'Since ' + since;
    });

    // Legal-column "Contact" link, shown only when a contact email is set. The mailto: is
    // assembled lazily (wireMailto) so the plaintext address is never in the DOM until click.
    if (contactEmail) {
      document.querySelectorAll('[data-brand="contact-link"]').forEach(function (el) {
        wireMailto(el, contactEmail, el.textContent || 'Contact');
        el.style.display = '';
      });
    }

    // Footer "Community" alternative — an email-free public channel (e.g. Grin forum).
    if (pool.support_forum_url) {
      document.querySelectorAll('[data-brand="forum-link"]').forEach(function (el) {
        el.setAttribute('href', pool.support_forum_url);
        el.style.display = '';
      });
    }

    // Footer security/abuse contact (lazy mailto) + optional PGP link.
    var secEmail = decodeEmail(pool.security_contact_enc);
    if (secEmail) {
      document.querySelectorAll('[data-brand="security-link"]').forEach(function (el) {
        wireMailto(el, secEmail, secEmail);
      });
      if (pool.pgp_key_url) {
        document.querySelectorAll('[data-brand="pgp-link"]').forEach(function (el) {
          el.setAttribute('href', pool.pgp_key_url);
          el.style.display = '';
        });
      }
      document.querySelectorAll('[data-brand-show="security"]').forEach(function (el) {
        el.style.display = '';
      });
    }

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

  // ── 3a. Light-theme logo variant ───────────────────────────────────────────
  // The branding page has always offered a "Logo (Light Theme variant)" upload
  // (asset key logo_dark) and the API has always returned logo_dark_url — but nothing on
  // the public site read it, so the control did nothing. A single logo that reads on
  // #07090c usually disappears on a white page, which is exactly what the light themes
  // are, so swap it on every theme change, not just at load. GriniumTheme.isLight() owns
  // the list of light palettes (mirrors css/themes.css).
  var LOGOS = { main: '', light: '' };

  function applyLogoVariant() {
    if (!LOGOS.light) return;             // no variant uploaded → one logo everywhere
    var light = !!(window.GriniumTheme && window.GriniumTheme.isLight());
    var src = light ? LOGOS.light : (LOGOS.main || LOGOS.light);
    document.querySelectorAll('.brand-logo, img[data-brand="logo"]').forEach(function (el) {
      if (el.getAttribute('src') !== src) el.setAttribute('src', src);
    });
  }

  // Theme can change after load (visitor clicks the palette button), so watch for it.
  // Guarded: a page without <body> yet, or an environment without MutationObserver, must
  // not break the rest of branding.
  function watchThemeForLogo() {
    try {
      if (!document.body || typeof MutationObserver !== 'function') return;
      new MutationObserver(applyLogoVariant)
        .observe(document.body, { attributes: true, attributeFilter: ['class'] });
    } catch (e) { /* logo just stays on the main variant */ }
  }

  // ── 3b. Site-wide header: swinging logo + slogan, Rewards link, miner auth ──
  // Applied on every public page so headers stay consistent without editing each file.
  // Acts only when a .brand element exists (skips login/admin pages that have none).
  function enhanceHeader(cfg) {
    injectHeaderStyles();
    enhanceBrand(cfg);
    injectRewardsLink(cfg);
  }

  function injectHeaderStyles() {
    if (document.getElementById('brand-header-css')) return;
    var css =
      '.brand{display:flex;align-items:center;gap:.6rem;}' +
      '.brand-logo{width:34px;height:34px;flex:0 0 auto;transform-origin:50% 8%;' +
        'animation:brandSwing 3.2s ease-in-out infinite;}' +
      '.brand-text{display:flex;flex-direction:column;line-height:1.04;}' +
      '.brand-slogan{font-size:.66rem;font-weight:500;letter-spacing:.02em;opacity:.7;' +
        'text-transform:none;white-space:nowrap;}' +
      // Pendulum: ~80° total arc (±40°) pivoting near the top, like a clock pendulum.
      // Swing is intentionally NOT gated by prefers-reduced-motion (operator request).
      '@keyframes brandSwing{0%{transform:rotate(-40deg);}50%{transform:rotate(40deg);}100%{transform:rotate(-40deg);}}';
    var s = document.createElement('style');
    s.id = 'brand-header-css';
    s.textContent = css;
    head().appendChild(s);
  }

  function enhanceBrand(cfg) {
    var pool = cfg.pool || {};
    var brand = cfg.branding || {};
    document.querySelectorAll('.brand').forEach(function (el) {
      var nameEl = el.querySelector('[data-brand="pool_name"]');

      // Public pages now ship a static <img class="brand-logo"> (so the swing shows even before
      // this fetch resolves). If one exists, just repoint it at a custom logo; otherwise create it
      // (admin/older markup using a .dot). Either way we still add the slogan below.
      var logo = el.querySelector('.brand-logo');
      if (logo) {
        if (brand.logo_url) logo.src = brand.logo_url;
      } else {
        // Only synthesise a logo for admin/older markup that ships a .dot placeholder.
        // A .brand with neither a logo nor a dot (e.g. the footer brand) intentionally
        // has no logo — don't recreate one, or the footer logo comes back.
        var dot = el.querySelector('.dot');
        if (dot) {
          logo = document.createElement('img');
          logo.className = 'brand-logo';
          logo.src = brand.logo_url || '/images/grin_lime.svg';
          logo.alt = '';
          logo.setAttribute('aria-hidden', 'true');
          el.replaceChild(logo, dot);
        }
      }

      // The footer brand already ships its own <p class="footer-tagline"> (filled by the
      // generic [data-brand] pass), so adding a .brand-slogan here would print the tagline
      // twice in the footer. Header/admin brands have no tagline of their own — they get one.
      if (nameEl && !el.closest('.footer-brand') && !el.querySelector('.brand-text')) {
        var col = document.createElement('span');
        col.className = 'brand-text';
        nameEl.parentNode.insertBefore(col, nameEl);
        col.appendChild(nameEl);
        var slogan = document.createElement('small');
        slogan.className = 'brand-slogan';
        slogan.setAttribute('data-brand', 'pool_tagline');
        var tag = pool.tagline || '';
        if (tag) slogan.textContent = tag;
        col.appendChild(slogan);
      }
    });
    // Last word on every .brand-logo src: this pass just wrote the main logo into each of
    // them, so the light variant has to be re-applied after it (no-op when none is set).
    applyLogoVariant();
  }

  // Add a "Rewards" nav link to the incentive/contest page when incentives are live.
  function injectRewardsLink(cfg) {
    if (!cfg.incentives || !cfg.incentives.enabled) return;
    var nav = document.querySelector('.header-nav');
    if (!nav || nav.querySelector('a[href$="fortune-board.html"]')) return;
    var a = document.createElement('a');
    a.className = 'nav-link';
    a.href = 'fortune-board.html';
    a.textContent = '🎁 Rewards';
    var account = nav.querySelector('a[href$="account-settings.html"]');
    if (account) nav.insertBefore(a, account); else nav.appendChild(a);
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

  // Privacy: strip the miner's grin address (?addr=) out of any URL before it reaches
  // analytics. The account page is deep-linkable (account-settings.html?addr=grin1…), and
  // GA4's default page_view sends page_location = the full URL — which would log the
  // address into the operator's analytics. We drop only `addr` and keep everything else
  // (utm_* campaign tags etc. stay intact for attribution). Returns origin+path+scrubbed-query.
  function scrubbedLocation() {
    try {
      var u = new URL(window.location.href);
      u.searchParams.delete('addr');
      return u.origin + u.pathname + (u.search ? u.search : '');
    } catch (e) {
      return window.location.origin + window.location.pathname;
    }
  }

  function loadGa4(id) {
    if (!id) return;
    var s = document.createElement('script');
    s.async = true;
    s.src = 'https://www.googletagmanager.com/gtag/js?id=' + encodeURIComponent(id);
    head().appendChild(s);
    var init = document.createElement('script');
    // page_location pinned to the scrubbed URL so the initial page_view (and every event
    // that inherits the config default) never carries a miner's address to GA4.
    init.textContent =
      'window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}' +
      "gtag('js',new Date());gtag('config','" + id.replace(/'/g, '') +
      "',{page_location:" + JSON.stringify(scrubbedLocation()) + "});";
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
    // Cache the chain so window.Explorer builds testnet-correct deep-links.
    try {
      var net = cfg.connection && cfg.connection.network;
      if (net) sessionStorage.setItem(NETWORK_KEY, net);
    } catch (e) {}

    try { applyTheme(cfg); } catch (e) {}

    // Record both logo variants before any content hook paints one, then start watching
    // for theme switches. Must run AFTER applyTheme (which sets the initial body class)
    // so the first pick already matches the theme the visitor lands on.
    try {
      var b = cfg.branding || {};
      LOGOS.main = b.logo_url || '';
      LOGOS.light = b.logo_dark_url || '';
      watchThemeForLogo();
    } catch (e) {}

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
    try { enhanceHeader(cfg); } catch (e) {}
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

    // Upcoming contest campaigns teaser (e.g. the fortune board). Fed by inc.lottery.campaigns
    // (scheduled, not-yet-drawn) from /api/public/branding → LotteryManager.nextScheduled().
    var campaigns = (inc.lottery && inc.lottery.campaigns) || [];
    var fmtUtc = function (sec) {
      return sec ? new Date(sec * 1000).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : '—';
    };
    document.querySelectorAll('[data-brand="upcoming-campaigns"]').forEach(function (container) {
      var wrap = container.closest('[data-brand-show="campaigns"]');
      if (!inc.enabled || !campaigns.length) { if (wrap) wrap.style.display = 'none'; return; }
      if (wrap) wrap.style.display = '';
      container.innerHTML = '';
      campaigns.forEach(function (c) {
        var pot = (c.pot_grin > 0) ? (' — ' + c.pot_grin + ' GRIN') : '';
        var row = document.createElement('div');
        row.style.cssText = 'padding:.4rem 0;border-bottom:1px solid rgba(128,128,128,.2);';
        row.innerHTML = '<strong>🏆 ' + escapeText(c.name) + '</strong>' + escapeText(pot) +
          (c.description ? '<br><span style="opacity:.8;">' + escapeText(c.description) + '</span>' : '') +
          '<br><span style="font-size:.85em;opacity:.7;">Draws ' + escapeText(fmtUtc(c.ends_at)) + '</span>';
        container.appendChild(row);
      });
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
    // window.Explorer is usable immediately (defined synchronously above); inject its style now
    // so chain deep-links render correctly even before the branding fetch resolves.
    try { injectExplorerCss(); } catch (e) {}
    // The header/footer + base nav are now injected synchronously by public-shell.js
    // (single source of truth, no flash). branding.js only ENHANCES that chrome:
    // logo/slogan, [data-brand] hooks, and the incentives-gated 🎁 Rewards link.
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
