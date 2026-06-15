// Small deterministic string hash → used to derive a stable banner id for client-side
// dismissal when the operator didn't assign one.
function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h << 5) - h + s.charCodeAt(i);
    h |= 0;
  }
  return h;
}

class PoolSettings {
  constructor(db) {
    this.db = db;
  }

  // Default values for each configuration section
  static defaults = {
    pool_info: {
      pool_name: 'GRINIUM',
      pool_tagline: 'Mine Grin, anywhere',
      pool_description: '',
      pool_visibility: 'public',
      address_whitelist: '[]',
      mining_mode: 'stratum',
      pool_fee_percent: 1.0,
      max_miners: 0,
      contact_email: '',
      homepage_banner: '',
      // Public stratum host shown by the connect/config generator (defaults to the
      // request host at runtime when left blank). Port comes from pool.json.
      public_stratum_host: '',
    },
    branding: {
      logo_file: '',
      logo_dark_file: '',
      favicon_file: '',
      accent_color: '#667eea',
      // pool_theme kept for backward compatibility; default_theme is authoritative
      pool_theme: 'dark',
      default_theme: 'atomic',
      allow_theme_switch: 'true',
      // enabled_themes: JSON array of theme keys visitors may switch between on the
      // public pages. With ≤1 entry (or allow_theme_switch off) no switcher is shown
      // and default_theme is forced. default_theme need not be in this list.
      // Default = the two polished looks (Atomic dark + Light); nexus and the 10
      // white-label extras stay opt-in via the admin panel checkbox grid.
      enabled_themes: '["atomic","light"]',
      // custom_theme: JSON map of CSS variable name -> value (theme builder output)
      custom_theme: '{}',
      custom_css: '',
      font_family: '',
      font_url: '',
      // PWA: short name for the home-screen icon (falls back to pool_name)
      app_short_name: '',
      // Show the "powered by" footer attribution
      show_attribution: 'true',
      // Hero / slogan block (rendered into [data-brand] hooks on public pages)
      hero_heading: '',
      hero_subheading: '',
      cta_text: '',
      cta_link: '',
      discord_link: '',
      telegram_link: '',
      twitter_link: '',
      website_link: '',
      footer_text: '',
    },
    seo: {
      meta_description: '',
      meta_keywords: '',
      title_template: '%page% — %pool_name%',
      og_title: '',
      og_description: '',
      og_image_file: '',
      og_locale: 'en_US',
      twitter_handle: '',
      twitter_card_type: 'summary_large_image',
      theme_color: '',
      site_url: '',
      // page_seo: JSON map of page key -> {title, description}
      page_seo: '{}',
      structured_data_enabled: 'true',
      sitemap_enabled: 'true',
      robots_noindex: 'false',
    },
    analytics: {
      // provider selects which analytics script loads: none|ga4|plausible|umami|matomo
      provider: 'none',
      ga_tracking_id: '',
      plausible_domain: '',
      plausible_src: 'https://plausible.io/js/script.js',
      umami_website_id: '',
      umami_src: 'https://cloud.umami.is/script.js',
      matomo_url: '',
      matomo_site_id: '',
      // custom_head_html: raw HTML injected into <head> on every public page
      custom_head_html: '',
      // custom_body_html: raw HTML injected before </body> (chat widgets, etc.)
      custom_body_html: '',
      cookie_consent_enabled: 'false',
      cookie_consent_text: 'We use analytics cookies to improve your experience.',
    },
    payout: {
      min_withdrawal: 5.0,
      auto_payout: 'false',
      payout_frequency: 'manual',
      confirm_depth_mainnet: 1440,
      confirm_depth_testnet: 100,
      max_pending_withdrawals: 100,
      max_user_pending: 10,
      withdrawal_retry_delays: '[21600,43200,86400,172800]',
    },
    access: {
      admin_ip_allowlist: '[]',
      admin_ip_blacklist: '[]',
      session_timeout_hours: 1,
      invite_codes_enabled: 'false',
      invite_codes: '[]',
    },
    alerts: {
      alert_check_interval_secs: 60,
      alert_email_address: '',
      discord_webhook_url: '',
      slack_webhook_url: '',
      telegram_bot_token: '',
      telegram_chat_id: '',
      alert_large_withdrawal: 100,
      alert_tor_fails_per_week: 3,
      alert_thresholds: '{"wallet_balance_warning_grin":10,"rejection_rate_warning_percent":20,"error_rate_warning_percent":50,"difficulty_change_warning_percent":50}',
    },
    // Operator-authored content pages (HTML). Empty content = page disabled / hidden.
    pages: {
      about: '',
      terms: '',
      privacy: '',
      faq: '',
      impressum: '',
    },
    // Incentive features (prize pool, join bonus, jackpot, streaks, lottery).
    // All funded from a single prize_pool pseudo-address bucket; see lib/incentives.js.
    incentives: {
      incentives_enabled: 'false',           // master switch
      // Funding
      prize_fee_cut_percent: 0,              // % OF the collected pool fee diverted to prize_pool (0-100)
      allow_miner_donations: 'true',         // miners opt in via a `donateN` worker-name tag
      // Published pool Slatepack address for community donations (shown on the fortune board).
      // External donations land in the wallet; the operator reflects them via a manual top-up.
      donation_address: '',
      // Join bonus — paid once per address, only after its first successful withdrawal
      join_bonus_enabled: 'false',
      join_bonus_amount: 0.1,                // GRIN
      // Block-finder jackpot — flat bonus to block.found_by; credited at maturity, reversed on orphan
      jackpot_enabled: 'false',
      jackpot_amount: 0.0,                   // GRIN per found block
      // Loyalty streak multiplier — top-up funded from prize_pool, never dilutes other miners
      streak_enabled: 'false',
      streak_bonus_per_week_percent: 1.0,    // +% per consecutive 7-day streak
      streak_max_percent: 5.0,               // cap
      // Lottery
      lottery_enabled: 'false',
      lottery_weekly_enabled: 'true',
      lottery_pot_share_weighted_percent: 50,  // Pot A: tickets ∝ valid shares
      lottery_pot_equal_chance_percent: 50,    // Pot B: one entry per qualifying address
      lottery_min_shares: 10,                  // min valid shares in the period to qualify
      lottery_pot_fraction_percent: 100,       // % of prize_pool paid out per draw
      // special events: JSON array of {name, date:"MM-DD", pot_grin, enabled}
      lottery_special_events: JSON.stringify([
        { name: 'Christmas', date: '12-25', pot_grin: 0, enabled: false },
        { name: 'New Year', date: '01-01', pot_grin: 0, enabled: false },
        { name: 'Grin Genesis Day', date: '01-15', pot_grin: 0, enabled: false },
      ]),
      // Grin Transporter (payout rail #3, Script 056) — reserved, forced off until it ships
      transporter_enabled: 'false',
    },
    // Site-wide maintenance mode + announcement banners.
    notices: {
      maintenance_mode: 'false',
      maintenance_title: 'Under Maintenance',
      maintenance_message: 'We are performing scheduled maintenance and will be back shortly.',
      // banners: JSON array of {id,type,message,link,link_text,dismissible,enabled,start,end}
      banners: '[]',
    },
    // Database retention / cleanup. Keeps the SQLite file bounded WITHOUT ever
    // deleting shares still needed for PPLNS distribution or orphan reversal:
    // the prune floor is (confirm_depth + PPLNS window + shares_margin_blocks) and
    // is additionally clamped below the oldest immature block. See lib/retention.js.
    database: {
      retention_enabled: 'true',
      shares_margin_blocks: 360,        // safety blocks kept BEYOND confirm_depth + PPLNS window
      hashrate_keep_days: 30,           // prune hashrate_history rows older than this
      resolved_alerts_keep_days: 30,    // prune resolved/acknowledged alerts older than this
      prune_interval_minutes: 60,       // how often retention.js runs (applied at restart)
    },
  };

  // Fixed display titles for the content pages (keys match the `pages` section).
  static pageTitles = {
    about: 'About',
    terms: 'Terms of Service',
    privacy: 'Privacy Policy',
    faq: 'FAQ',
    impressum: 'Impressum',
  };

  // Every valid theme key (public_html/css/themes.css + js/theme.js + js/public-theme.js).
  // 'dark' is the retired pre-mockup public default — still accepted for stored
  // configs; the public pages normalise it to 'atomic'. 'nexus' is public+admin;
  // 'cyber'/'uranium'/'gradient' (the moved old looks) and matrix/naruto/japan
  // are admin-panel-only palettes.
  static THEME_KEYS = [
    'atomic', 'nexus', 'light', 'dark', 'custom',
    'matrix', 'naruto', 'japan', 'cyber', 'uranium', 'gradient',
    'winter', 'spring', 'summer', 'autumn', 'halloween', 'christmas',
    'galaxy', 'winxp', 'aqua', 'comic',
  ];

  // Validation rules per section
  static validators = {
    pool_info: {
      pool_fee_percent: (val) => {
        const n = parseFloat(val);
        if (isNaN(n) || n < 0 || n > 50) throw new Error('pool_fee_percent must be 0-50');
        return n;
      },
      pool_visibility: (val) => {
        if (!['public', 'private', 'maintenance'].includes(val)) throw new Error('invalid pool_visibility');
        return val;
      },
      mining_mode: (val) => {
        if (!['stratum', 'solo'].includes(val)) throw new Error('invalid mining_mode');
        return val;
      },
      max_miners: (val) => {
        const n = parseInt(val, 10);
        if (isNaN(n) || n < 0) throw new Error('max_miners must be >= 0');
        return n;
      },
    },
    branding: {
      accent_color: (val) => {
        if (!/^#[0-9a-fA-F]{6}$/.test(val)) throw new Error('accent_color must be valid hex (#xxxxxx)');
        return val;
      },
      default_theme: (val) => {
        if (!PoolSettings.THEME_KEYS.includes(val)) {
          throw new Error('invalid default_theme');
        }
        return val;
      },
      enabled_themes: (val) => {
        // Accept a JS array or a JSON string; always store a deduped JSON-string array
        // of valid theme keys. Empty array is allowed (= no public switcher).
        let arr = val;
        if (typeof val === 'string') {
          if (val.trim() === '') return '[]';
          try { arr = JSON.parse(val); } catch (err) { throw new Error('enabled_themes must be valid JSON'); }
        }
        if (!Array.isArray(arr)) throw new Error('enabled_themes must be an array');
        const seen = new Set();
        const cleaned = [];
        for (const t of arr) {
          if (!PoolSettings.THEME_KEYS.includes(t)) throw new Error(`invalid theme in enabled_themes: ${t}`);
          if (!seen.has(t)) { seen.add(t); cleaned.push(t); }
        }
        return JSON.stringify(cleaned);
      },
      custom_theme: (val) => {
        // Accept an object directly or a JSON string; always store as JSON string
        if (typeof val === 'object' && val !== null) return JSON.stringify(val);
        if (typeof val === 'string') {
          if (val.trim() === '') return '{}';
          try {
            JSON.parse(val);
          } catch (err) {
            throw new Error('custom_theme must be valid JSON');
          }
          return val;
        }
        return '{}';
      },
      font_url: (val) => {
        if (val) {
          try { new URL(val); } catch (err) { throw new Error('font_url must be a valid URL'); }
        }
        return val;
      },
    },
    seo: {
      title_template: (val) => {
        if (val && val.length > 120) throw new Error('title_template too long (max 120)');
        return val;
      },
      twitter_card_type: (val) => {
        if (val && !['summary', 'summary_large_image'].includes(val)) {
          throw new Error('invalid twitter_card_type');
        }
        return val;
      },
      theme_color: (val) => {
        if (val && !/^#[0-9a-fA-F]{6}$/.test(val)) throw new Error('theme_color must be valid hex (#xxxxxx)');
        return val;
      },
      page_seo: (val) => {
        if (typeof val === 'object' && val !== null) return JSON.stringify(val);
        if (typeof val === 'string') {
          if (val.trim() === '') return '{}';
          try { JSON.parse(val); } catch (err) { throw new Error('page_seo must be valid JSON'); }
          return val;
        }
        return '{}';
      },
      site_url: (val) => {
        if (val) {
          try {
            new URL(val);
          } catch (err) {
            throw new Error('site_url must be a valid URL');
          }
        }
        return val;
      },
    },
    analytics: {
      provider: (val) => {
        if (!['none', 'ga4', 'plausible', 'umami', 'matomo'].includes(val)) {
          throw new Error('invalid analytics provider');
        }
        return val;
      },
      ga_tracking_id: (val) => {
        if (val && !/^G-[A-Z0-9]+$/.test(val)) throw new Error('invalid GA tracking ID format');
        return val;
      },
      matomo_site_id: (val) => {
        if (val && !/^\d+$/.test(String(val))) throw new Error('matomo_site_id must be numeric');
        return val;
      },
      plausible_src: (val) => {
        if (val) { try { new URL(val); } catch (err) { throw new Error('plausible_src must be a valid URL'); } }
        return val;
      },
      umami_src: (val) => {
        if (val) { try { new URL(val); } catch (err) { throw new Error('umami_src must be a valid URL'); } }
        return val;
      },
      matomo_url: (val) => {
        if (val) { try { new URL(val); } catch (err) { throw new Error('matomo_url must be a valid URL'); } }
        return val;
      },
    },
    notices: {
      banners: (val) => {
        let arr = val;
        if (typeof arr === 'string') {
          if (arr.trim() === '') return '[]';
          try { arr = JSON.parse(arr); } catch (err) { throw new Error('banners must be valid JSON'); }
        }
        if (!Array.isArray(arr)) throw new Error('banners must be a JSON array');
        return JSON.stringify(arr);
      },
    },
    payout: {
      min_withdrawal: (val) => {
        const n = parseFloat(val);
        if (isNaN(n) || n <= 0) throw new Error('min_withdrawal must be > 0');
        return n;
      },
      payout_frequency: (val) => {
        if (!['manual', 'hourly', 'daily', 'weekly'].includes(val)) throw new Error('invalid payout_frequency');
        return val;
      },
    },
    access: {
      session_timeout_hours: (val) => {
        const n = parseInt(val, 10);
        if (isNaN(n) || n < 1 || n > 168) throw new Error('session_timeout_hours must be 1-168');
        return n;
      },
    },
    alerts: {
      alert_check_interval_secs: (val) => {
        const n = parseInt(val, 10);
        if (isNaN(n) || n < 5 || n > 3600) throw new Error('alert_check_interval_secs must be 5-3600');
        return n;
      },
    },
    incentives: (() => {
      const percent = (name) => (val) => {
        const n = parseFloat(val);
        if (isNaN(n) || n < 0 || n > 100) throw new Error(`${name} must be 0-100`);
        return n;
      };
      const nonNeg = (name) => (val) => {
        const n = parseFloat(val);
        if (isNaN(n) || n < 0) throw new Error(`${name} must be >= 0`);
        return n;
      };
      const intRange = (name, lo, hi) => (val) => {
        const n = parseInt(val, 10);
        if (isNaN(n) || n < lo || n > hi) throw new Error(`${name} must be ${lo}-${hi}`);
        return n;
      };
      return {
        prize_fee_cut_percent: percent('prize_fee_cut_percent'),
        donation_address: (val) => {
          if (!val) return '';
          const v = String(val).trim();
          if (!/^t?grin1[ac-hj-np-z02-9]{40,}$/.test(v)) {
            throw new Error('donation_address must be a grin/tgrin Slatepack address');
          }
          return v;
        },
        join_bonus_amount: nonNeg('join_bonus_amount'),
        jackpot_amount: nonNeg('jackpot_amount'),
        streak_bonus_per_week_percent: percent('streak_bonus_per_week_percent'),
        streak_max_percent: percent('streak_max_percent'),
        lottery_pot_share_weighted_percent: percent('lottery_pot_share_weighted_percent'),
        lottery_pot_equal_chance_percent: percent('lottery_pot_equal_chance_percent'),
        lottery_pot_fraction_percent: percent('lottery_pot_fraction_percent'),
        lottery_min_shares: intRange('lottery_min_shares', 0, 1000000),
        lottery_special_events: (val) => {
          let arr = val;
          if (typeof arr === 'string') {
            if (arr.trim() === '') return '[]';
            try { arr = JSON.parse(arr); } catch (err) { throw new Error('lottery_special_events must be valid JSON'); }
          }
          if (!Array.isArray(arr)) throw new Error('lottery_special_events must be a JSON array');
          const cleaned = arr.map((e) => {
            e = e || {};
            if (!/^\d{2}-\d{2}$/.test(String(e.date || ''))) {
              throw new Error('each special event needs a date in MM-DD format');
            }
            const pot = parseFloat(e.pot_grin);
            return {
              name: String(e.name || 'Event').slice(0, 60),
              date: e.date,
              pot_grin: isNaN(pot) || pot < 0 ? 0 : pot,
              enabled: !(e.enabled === false || e.enabled === 'false'),
            };
          });
          return JSON.stringify(cleaned);
        },
      };
    })(),
    database: {
      shares_margin_blocks: (val) => {
        const n = parseInt(val, 10);
        if (isNaN(n) || n < 0 || n > 100000) throw new Error('shares_margin_blocks must be 0-100000');
        return n;
      },
      hashrate_keep_days: (val) => {
        const n = parseInt(val, 10);
        if (isNaN(n) || n < 1 || n > 3650) throw new Error('hashrate_keep_days must be 1-3650');
        return n;
      },
      resolved_alerts_keep_days: (val) => {
        const n = parseInt(val, 10);
        if (isNaN(n) || n < 1 || n > 3650) throw new Error('resolved_alerts_keep_days must be 1-3650');
        return n;
      },
      prune_interval_minutes: (val) => {
        const n = parseInt(val, 10);
        if (isNaN(n) || n < 5 || n > 10080) throw new Error('prune_interval_minutes must be 5-10080');
        return n;
      },
    },
  };

  getSection(section) {
    if (!PoolSettings.defaults[section]) {
      throw new Error(`Unknown section: ${section}`);
    }

    const defaults = { ...PoolSettings.defaults[section] };
    const stmt = this.db.prepare('SELECT key, value, value_type FROM pool_config WHERE section = ?');
    const rows = stmt.all(section);

    for (const row of rows) {
      if (row.value_type === 'number') {
        defaults[row.key] = parseFloat(row.value);
      } else if (row.value_type === 'boolean') {
        defaults[row.key] = row.value === 'true';
      } else if (row.value_type === 'json') {
        defaults[row.key] = JSON.parse(row.value);
      } else {
        defaults[row.key] = row.value;
      }
    }

    return defaults;
  }

  getAll() {
    const result = {};
    for (const section of Object.keys(PoolSettings.defaults)) {
      result[section] = this.getSection(section);
    }
    return result;
  }

  // Build the curated, public-safe white-label payload served at /api/public/branding.
  // assetUrlFor(type) -> URL string (or '') for an active uploaded asset; injected so this
  // module stays free of the AssetManager dependency.
  buildPublicConfig(assetUrlFor = () => '') {
    const pool = this.getSection('pool_info');
    const b = this.getSection('branding');
    const seo = this.getSection('seo');
    const a = this.getSection('analytics');
    const n = this.getSection('notices');

    const parseJson = (v, fallback) => {
      if (v && typeof v === 'object') return v;
      try { return JSON.parse(v); } catch (e) { return fallback; }
    };

    // GA id can live in analytics (new) or seo (legacy leftover) — prefer analytics.
    const gaId = a.ga_tracking_id || seo.ga_tracking_id || '';

    return {
      pool: {
        name: pool.pool_name || '',
        tagline: pool.pool_tagline || '',
        description: pool.pool_description || '',
        contact_email: pool.contact_email || '',
        homepage_banner: pool.homepage_banner || '',
        visibility: pool.pool_visibility || 'public',
        public_stratum_host: pool.public_stratum_host || '',
      },
      branding: {
        accent_color: b.accent_color || '',
        default_theme: b.default_theme || b.pool_theme || 'atomic',
        allow_theme_switch: b.allow_theme_switch === true || b.allow_theme_switch === 'true',
        enabled_themes: parseJson(b.enabled_themes, ['atomic', 'light']),
        custom_theme: parseJson(b.custom_theme, {}),
        custom_css: b.custom_css || '',
        font_family: b.font_family || '',
        font_url: b.font_url || '',
        app_short_name: b.app_short_name || '',
        show_attribution: !(b.show_attribution === false || b.show_attribution === 'false'),
        hero_heading: b.hero_heading || '',
        hero_subheading: b.hero_subheading || '',
        cta_text: b.cta_text || '',
        cta_link: b.cta_link || '',
        footer_text: b.footer_text || '',
        social: {
          discord: b.discord_link || '',
          telegram: b.telegram_link || '',
          twitter: b.twitter_link || '',
          website: b.website_link || '',
        },
        logo_url: assetUrlFor('logo'),
        logo_dark_url: assetUrlFor('logo_dark'),
        favicon_url: assetUrlFor('favicon'),
        apple_touch_url: assetUrlFor('apple_touch_icon'),
        icon_192_url: assetUrlFor('icon_192'),
        icon_512_url: assetUrlFor('icon_512'),
      },
      seo: {
        meta_description: seo.meta_description || '',
        meta_keywords: seo.meta_keywords || '',
        title_template: seo.title_template || '%page% — %pool_name%',
        og_title: seo.og_title || '',
        og_description: seo.og_description || '',
        og_image_url: assetUrlFor('og_image'),
        og_locale: seo.og_locale || 'en_US',
        twitter_handle: seo.twitter_handle || '',
        twitter_card_type: seo.twitter_card_type || 'summary_large_image',
        theme_color: seo.theme_color || b.accent_color || '',
        site_url: seo.site_url || '',
        page_seo: parseJson(seo.page_seo, {}),
        structured_data_enabled: seo.structured_data_enabled === true || seo.structured_data_enabled === 'true',
        robots_noindex: seo.robots_noindex === true || seo.robots_noindex === 'true',
      },
      analytics: {
        provider: a.provider || 'none',
        ga_tracking_id: gaId,
        plausible_domain: a.plausible_domain || '',
        plausible_src: a.plausible_src || '',
        umami_website_id: a.umami_website_id || '',
        umami_src: a.umami_src || '',
        matomo_url: a.matomo_url || '',
        matomo_site_id: a.matomo_site_id || '',
        custom_head_html: a.custom_head_html || '',
        custom_body_html: a.custom_body_html || '',
        cookie_consent_enabled: a.cookie_consent_enabled === true || a.cookie_consent_enabled === 'true',
        cookie_consent_text: a.cookie_consent_text || '',
      },
      // Footer link list: content pages that have been authored (content present).
      pages: this.listEnabledPages(),
      // Maintenance mode (rendered as a full-page overlay by branding.js).
      maintenance: {
        enabled: n.maintenance_mode === true || n.maintenance_mode === 'true',
        title: n.maintenance_title || 'Under Maintenance',
        message: n.maintenance_message || '',
      },
      // Currently-active announcement banners (enabled + within date window).
      announcements: this.getActiveBanners(),
    };
  }

  // Announcement banners that are enabled and within their start/end window (if set).
  getActiveBanners() {
    const notices = this.getSection('notices');
    let banners = notices.banners;
    if (typeof banners === 'string') {
      try { banners = JSON.parse(banners); } catch (e) { banners = []; }
    }
    if (!Array.isArray(banners)) return [];
    const now = Date.now();
    const parse = (d) => {
      if (!d) return null;
      const t = Date.parse(d);
      return isNaN(t) ? null : t;
    };
    return banners
      .filter((b) => b && b.enabled !== false && b.enabled !== 'false')
      .filter((b) => {
        const start = parse(b.start);
        const end = parse(b.end);
        if (start !== null && now < start) return false;
        if (end !== null && now > end) return false;
        return true;
      })
      .map((b) => ({
        id: b.id || ('b' + Math.abs(hashStr(String(b.type) + String(b.message)))),
        type: ['news', 'update', 'maintenance', 'warning'].includes(b.type) ? b.type : 'news',
        message: b.message || '',
        link: b.link || '',
        link_text: b.link_text || '',
        dismissible: !(b.dismissible === false || b.dismissible === 'false'),
      }))
      .filter((b) => b.message.trim() !== '');
  }

  // Content pages that have non-empty HTML, as [{key, title}] for footer navigation.
  listEnabledPages() {
    const pages = this.getSection('pages');
    return Object.keys(PoolSettings.defaults.pages)
      .filter((key) => pages[key] && String(pages[key]).trim() !== '')
      .map((key) => ({ key, title: PoolSettings.pageTitles[key] || key }));
  }

  // Full content for one page (used by GET /api/public/page/:key).
  getPage(key) {
    if (!(key in PoolSettings.defaults.pages)) return null;
    const pages = this.getSection('pages');
    const html = pages[key] || '';
    if (String(html).trim() === '') return null; // disabled when empty
    return { key, title: PoolSettings.pageTitles[key] || key, html };
  }

  updateSection(section, values, userId = null) {
    if (!PoolSettings.defaults[section]) {
      throw new Error(`Unknown section: ${section}`);
    }

    const validators = PoolSettings.validators[section] || {};
    const stmt = this.db.prepare(`
      INSERT INTO pool_config (section, key, value, value_type, updated_by)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(section, key) DO UPDATE SET
        value = excluded.value,
        value_type = excluded.value_type,
        updated_by = excluded.updated_by,
        updated_at = unixepoch()
    `);

    const transaction = this.db.transaction(() => {
      for (const [key, value] of Object.entries(values)) {
        if (!(key in PoolSettings.defaults[section])) {
          throw new Error(`Unknown key '${key}' in section '${section}'`);
        }

        let validated = value;
        if (validators[key]) {
          validated = validators[key](value);
        }

        let valueStr = value;
        let valueType = 'string';

        if (typeof validated === 'number') {
          valueStr = validated.toString();
          valueType = 'number';
        } else if (typeof validated === 'boolean') {
          valueStr = validated ? 'true' : 'false';
          valueType = 'boolean';
        } else if (typeof validated === 'object') {
          valueStr = JSON.stringify(validated);
          valueType = 'json';
        } else if (validated === null || validated === undefined) {
          valueStr = '';
        }

        stmt.run(section, key, valueStr, valueType, userId);
      }

      // Cross-field rule: the two lottery pots can't claim more than 100% of a draw's pot.
      // (Per-key validators can't see sibling fields. getSection() here reflects the rows just
      // written — same connection, same transaction — so a partial update is validated against
      // the resulting merged state, and an over-100 total rolls the whole update back.)
      if (section === 'incentives') {
        const merged = this.getSection('incentives');
        const w = parseFloat(merged.lottery_pot_share_weighted_percent) || 0;
        const e = parseFloat(merged.lottery_pot_equal_chance_percent) || 0;
        if (w + e > 100) {
          throw new Error('lottery_pot_share_weighted_percent + lottery_pot_equal_chance_percent must not exceed 100');
        }
      }
    });

    transaction();
    return this.getSection(section);
  }

  resetSection(section, userId = null) {
    if (!PoolSettings.defaults[section]) {
      throw new Error(`Unknown section: ${section}`);
    }

    const stmt = this.db.prepare('DELETE FROM pool_config WHERE section = ?');
    stmt.run(section);

    const auditStmt = this.db.prepare(`
      INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, details)
      VALUES (?, 'reset_settings', 'pool_config', ?, ?)
    `);
    auditStmt.run(userId, section, JSON.stringify({ section, timestamp: new Date().toISOString() }));

    return this.getSection(section);
  }

  resetAll(userId = null) {
    const stmt = this.db.prepare('DELETE FROM pool_config');
    stmt.run();

    const auditStmt = this.db.prepare(`
      INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, details)
      VALUES (?, 'reset_all_settings', 'pool_config', 'all', ?)
    `);
    auditStmt.run(userId, JSON.stringify({ timestamp: new Date().toISOString() }));

    return this.getAll();
  }

  // Merge DB settings into a config object (called at startup)
  static applyToConfig(config, allSettings) {
    const { pool_info, payout } = allSettings;

    if (pool_info.pool_fee_percent !== undefined) {
      config.pool_fee_percent = pool_info.pool_fee_percent;
    }
    if (payout.min_withdrawal !== undefined) {
      config.min_withdrawal = payout.min_withdrawal;
    }
    if (payout.max_pending_withdrawals !== undefined) {
      config.max_pending_withdrawals = payout.max_pending_withdrawals;
    }
    if (payout.max_user_pending !== undefined) {
      config.max_user_pending = payout.max_user_pending;
    }
    if (pool_info.pool_name !== undefined) {
      config.pool_name = pool_info.pool_name;
    }

    return config;
  }
}

module.exports = PoolSettings;
