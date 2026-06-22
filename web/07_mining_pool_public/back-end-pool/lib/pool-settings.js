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
      pool_description: 'Mine Grin and have fun while you do it. GRINIUM is a low-fee PPLNS pool with anonymous Tor payouts, a per-address identity (no accounts, no sign-up), and live per-rig stats. Stack rewards on top of your shares with prize draws, join bonuses, streak rewards and a community fortune board — fair payouts for everyone, plus a little luck for the lucky. Point your miner at the nearest region and start earning in minutes.',
      pool_visibility: 'public',
      address_whitelist: '[]',
      mining_mode: 'stratum',
      pool_fee_percent: 1.0,
      max_miners: 0,
      contact_email: 'support@grinium.com',
      homepage_banner: '',
      // Public stratum host shown by the connect/config generator (defaults to the
      // request host at runtime when left blank). Port comes from pool.json.
      public_stratum_host: '',
      // Footer "go-live" year for the copyright line (© <founded>–<current>). Blank
      // collapses to just the current year. Stored as a 4-digit string.
      founded_year: '',
      // Security / abuse contact surfaced in the footer (email). Falls back to nothing
      // when blank (the footer just omits the row). pgp_key_url is an optional link to a
      // published PGP public key for encrypted security reports.
      security_contact: 'support@grinium.com',
      pgp_key_url: '',
      // Public community/support channel shown in the footer as an email-free alternative
      // (e.g. a forum profile). Safe to expose in plaintext (it's a public URL, not an
      // address). Blank hides the footer "Community" link.
      support_forum_url: 'https://forum.grin.mw/u/hellogrin',
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
      app_short_name: 'GRINIUM',
      // Show the "powered by" footer attribution
      show_attribution: 'true',
      // Hero / slogan block (rendered into [data-brand] hooks on public pages)
      hero_heading: 'Mine Grin, Earn More, Have Fun',
      hero_subheading: 'Low-fee PPLNS pool with anonymous Tor payouts, prize draws and bonuses — no sign-up, just point your miner and go.',
      cta_text: '',
      cta_link: '',
      discord_link: '',
      telegram_link: '',
      twitter_link: 'https://twitter.com/grinium',
      website_link: 'https://grinium.com',
      footer_text: '',
    },
    seo: {
      meta_description: 'GRINIUM is a low-fee Grin (GRIN) mining pool — PPLNS rewards, anonymous Tor payouts, prize draws and bonuses. No sign-up; point your miner and start earning.',
      meta_keywords: 'grin mining pool, grin pool, GRIN, mimblewimble, cuckatoo32, PPLNS pool, anonymous mining, tor payout, asic mining, cryptocurrency mining, GRINIUM',
      title_template: '%page% — %pool_name%',
      og_title: 'GRINIUM — Grin Mining Pool',
      og_description: 'Mine Grin with low fees, PPLNS rewards and anonymous Tor payouts — plus prize draws, join bonuses and a community fortune board. No account needed.',
      og_image_file: '',
      og_locale: 'en_US',
      twitter_handle: '@grinium',
      twitter_card_type: 'summary_large_image',
      theme_color: '#b8e600',
      site_url: 'https://grinium.com',
      // page_seo: JSON map of page key -> {title, description}
      page_seo: '{}',
      structured_data_enabled: 'true',
      sitemap_enabled: 'true',
      robots_noindex: 'false',
    },
    analytics: {
      // provider selects which analytics script loads: none|ga4|plausible|umami|matomo
      provider: 'ga4',
      ga_tracking_id: 'G-GMYJ4PVG4L',
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
    // about/terms/privacy/faq ship with editable GRINIUM defaults (seeded once into the
    // `pages` CMS table by db.js migratePagesFromConfig — operators edit them in admin →
    // Pages). impressum stays blank (German legal imprint = operator-specific).
    pages: {
      about: `<p class="muted">Last updated: June 2026</p>
<p><strong>GRINIUM</strong> is a community mining pool for <strong>Grin (GRIN)</strong>, the privacy-preserving, Mimblewimble-based cryptocurrency. We run the heavy infrastructure — full nodes, multi-region stratum servers, and payout wallets — so you can point a miner at us and start earning without operating any of it yourself.</p>

<h2>What is Grin?</h2>
<p>Grin is a lightweight implementation of the Mimblewimble protocol. It stores no addresses or amounts on-chain, has no pre-mine and no founder's reward, and follows a simple, fair emission of 1 GRIN per second, forever. Mining uses the ASIC-friendly <strong>Cuckatoo32 (C32)</strong> proof-of-work.</p>

<h2>Why mine with GRINIUM?</h2>
<ul>
  <li><strong>Low fee.</strong> A flat 1% pool fee (the live value is shown on the homepage).</li>
  <li><strong>PPLNS rewards.</strong> Pay-Per-Last-N-Shares spreads rewards fairly and resists pool-hopping.</li>
  <li><strong>Private payouts.</strong> Rewards are delivered to your Grin address over Tor.</li>
  <li><strong>No account, no KYC.</strong> Your Grin address <em>is</em> your identity — there is nothing to sign up for.</li>
  <li><strong>Global regions.</strong> Connect to the nearest stratum endpoint for low latency and fewer stale shares.</li>
</ul>

<h2>How it works</h2>
<p>You connect your miner using your Grin address as the username, in the form <code>grin1youraddress.workername</code>. The pool credits every valid share you submit. When the pool finds a block and it matures, your portion of the reward is added to your balance, ready to withdraw to your wallet.</p>

<!-- TO BE UPDATED: confirm incentive details before publishing -->
<h2>Rewards &amp; extras</h2>
<p>Beyond block rewards, GRINIUM may run optional community incentives — for example a prize pool, a block-finder jackpot, loyalty streaks, and a periodic lottery, with winners shown on the public fortune board. <em>(To be updated.)</em></p>

<p>Ready to start? See the <a href="/">homepage</a> for connection details, or read the <a href="/page.html?p=faq">FAQ</a>.</p>`,

      terms: `<p class="muted">Last updated: June 2026</p>
<p>These Terms of Service ("Terms") govern your use of the GRINIUM mining pool and its website (the "Service"). By connecting a miner or using the website you agree to these Terms. If you do not agree, do not use the Service.</p>

<h2>1. The Service</h2>
<p>GRINIUM is a Grin (GRIN) mining pool. We aggregate the hashpower of participating miners, submit work to the Grin network, and distribute block rewards according to the pool's reward scheme. The Service is provided on a best-effort basis with no guarantee of uptime, profitability, or that any block will be found in a given period.</p>

<h2>2. Identity and accounts</h2>
<p>The Service does not use registered miner accounts. Your Grin address is your identity: rewards earned by hashpower submitted under an address are credited to, and payable only to, that address. You are solely responsible for the security and correctness of the address you mine to. <strong>Rewards paid to an address you do not control cannot be recovered.</strong></p>

<h2>3. Fees and payouts</h2>
<ul>
  <li>The pool retains a fee from block rewards (default 1%; the current value is shown on the website).</li>
  <li>Block rewards are credited only after the network coinbase maturity period (1,440 blocks on mainnet) to protect against chain reorganisations.</li>
  <li>Payouts are subject to a minimum withdrawal threshold (default 5 GRIN), which you may raise for your own address.</li>
  <li>If a block is later orphaned by the network, the associated credits are reversed.</li>
</ul>

<h2>4. Acceptable use</h2>
<p>You agree not to: submit invalid or fraudulent shares; attempt to overload, attack, or gain unauthorised access to the Service; reverse-engineer or disrupt the stratum or API endpoints; or use the Service for any unlawful purpose. We may, at our discretion, throttle, ban, or refuse service to any address or IP that abuses the Service.</p>

<h2>5. No warranty</h2>
<p>The Service is provided "as is" and "as available", without warranties of any kind. Cryptocurrency mining carries financial and technical risk, including costs of hardware and electricity, network difficulty changes, and coin-price volatility. You mine at your own risk.</p>

<h2>6. Limitation of liability</h2>
<p>To the maximum extent permitted by law, GRINIUM and its operators shall not be liable for any indirect, incidental, or consequential damages, or for any loss of profits, rewards, or data arising from your use of the Service.</p>

<h2>7. Changes</h2>
<p>We may update these Terms or the pool's parameters (fees, thresholds, reward scheme) at any time. Continued use after a change constitutes acceptance.</p>

<!-- TO BE UPDATED: confirm incentive details before publishing -->
<h2>8. Promotions and incentives</h2>
<p>Any prize pool, bonus, jackpot, streak reward, or lottery is optional, discretionary, and may be changed, suspended, or withdrawn at any time. Where a draw is offered, its method is intended to be publicly verifiable. <em>(To be updated.)</em></p>

<h2>9. Contact</h2>
<p>Questions about these Terms can be directed to the pool operator using the contact links in the website footer, or via the Grin forum (<a href="https://forum.grin.mw/u/hellogrin" target="_blank" rel="noopener">hellogrin on forum.grin.mw</a>).</p>`,

      privacy: `<p class="muted">Last updated: June 2026</p>
<p>This Privacy Policy explains what information the GRINIUM mining pool processes when you mine with us or visit our website. Grin is a privacy-focused cryptocurrency, and we keep data collection to the minimum needed to run the pool.</p>

<h2>What we collect</h2>
<ul>
  <li><strong>Your Grin address.</strong> Submitted as your stratum username; it is your public mining identity and the destination for your payouts.</li>
  <li><strong>Worker source IP address.</strong> We record the last one or two IP addresses an address mines from. This powers the ownership check that gates payout settings (so a stranger cannot change your threshold or trigger a withdrawal) and helps us detect abuse.</li>
  <li><strong>Mining metrics.</strong> Shares, hashrate samples, worker names, and reject/stale counts — used to calculate rewards and display statistics.</li>
  <li><strong>Website analytics &amp; preferences.</strong> Aggregate analytics (e.g. page views) and a locally-stored theme preference.</li>
</ul>

<h2>What we do NOT collect</h2>
<p>We do not ask for or store your name, email address, government ID, or any KYC information. There are no miner accounts and no passwords (the stratum "password" field is ignored). We never see or store your wallet's private keys or seed phrase.</p>

<h2>Cookies and analytics</h2>
<p>The website may use cookies and a third-party analytics provider (such as Google Analytics) to understand aggregate traffic. Your theme choice is stored in your browser's local storage, not on our servers. You can block cookies in your browser without affecting mining.</p>

<h2>Data retention</h2>
<p>Raw share data is kept only for the duration of the reward (PPLNS) window and then pruned; hashrate history is downsampled over time. Financial records (balances and payouts) are retained for accounting and audit integrity.</p>

<h2>Third parties</h2>
<p>Payouts are delivered over the <strong>Tor network</strong> to your address; routing is handled by Tor, not by us. Analytics data is processed by the analytics provider under their own privacy policy. We do not sell or rent your data.</p>

<!-- TO BE UPDATED: confirm incentive details before publishing -->
<h2>Incentives and the fortune board</h2>
<p>If optional incentives are enabled, winning Grin addresses (often in shortened form) and prize amounts may be shown publicly on the fortune board. No other personal information is published. <em>(To be updated.)</em></p>

<h2>Your control</h2>
<p>Because mining is address-based and pseudonymous, you can stop participating at any time by disconnecting your miner. To ask about data tied to your address, contact the operator via the footer contact links or the Grin forum (<a href="https://forum.grin.mw/u/hellogrin" target="_blank" rel="noopener">hellogrin on forum.grin.mw</a>).</p>`,

      faq: `<p class="muted">Last updated: June 2026</p>

<h2>What is GRINIUM?</h2>
<p>GRINIUM is a mining pool for Grin (GRIN). We combine many miners' hashpower to find blocks more steadily and share the rewards.</p>

<h2>Do I need to register an account?</h2>
<p>No. There are no accounts and no sign-up. Your Grin address is your identity — just start mining to it.</p>

<h2>How do I start mining?</h2>
<p>Point your miner at the nearest region's stratum endpoint (shown on the homepage), using:</p>
<ul>
  <li><strong>Username:</strong> <code>your_grin_address.worker_name</code> (e.g. <code>grin1abc….rig1</code>)</li>
  <li><strong>Password:</strong> anything — it is ignored.</li>
  <li><strong>Port:</strong> the stratum port on the homepage (default 3333), the same across all regions.</li>
</ul>
<p>Grin-capable ASICs (the iPollo G1 and G1 mini) are configured in their own web interface; GPU miners need a Cuckatoo32-capable miner and a card with more than 8&nbsp;GB of VRAM.</p>

<h2>What does it cost?</h2>
<p>The pool fee is 1% by default (the live value is on the homepage). There are no hidden charges.</p>

<h2>How are rewards calculated?</h2>
<p>By default the pool uses <strong>PPLNS</strong> (Pay-Per-Last-N-Shares): when the pool finds a block, the reward is split across the most recent shares, so consistent miners earn their fair share and the scheme resists pool-hopping.</p>

<h2>When and how do I get paid?</h2>
<p>A found block must mature (1,440 blocks on mainnet) before its reward is credited — this protects against chain reorganisations. Once your balance reaches the minimum payout (5 GRIN by default), you request a withdrawal from the <a href="/account-settings.html">Account</a> page. Two payout methods are available, and both confirm you own the address by checking it against one of the last two IP addresses you have mined from:</p>
<ul>
  <li><strong>Tor (automatic):</strong> the pool sends your payout to your address over the Tor network.</li>
  <li><strong>Slatepack (interactive):</strong> the pool produces an encrypted Slatepack that only your wallet can receive and finalise.</li>
</ul>

<h2>Can I set my own minimum payout?</h2>
<p>Yes. From the Account page you can raise your personal payout threshold above the pool minimum (it can be raised, not lowered). Changing payout settings requires a quick ownership check against an IP you have recently mined from.</p>

<h2>What happens if a block is orphaned?</h2>
<p>If a block we found is later orphaned by the network, the credits from that block are reversed. This is normal and rare.</p>

<h2>Is mining anonymous?</h2>
<p>Grin is built on Mimblewimble, so on-chain data is private. We require no personal information, and payouts travel over Tor. See our <a href="/page.html?p=privacy">Privacy Policy</a> for details.</p>

<!-- TO BE UPDATED: confirm incentive details before publishing -->
<h2>Are there prizes or bonuses?</h2>
<p>GRINIUM may offer optional extras such as a prize pool, jackpots, loyalty streaks, and a lottery with a publicly verifiable draw. When these are enabled, results appear on the fortune board. <em>(To be updated.)</em></p>

<h2>I need help.</h2>
<p>Check the connection details on the homepage, post on the Grin forum (<a href="https://forum.grin.mw/u/hellogrin" target="_blank" rel="noopener">hellogrin on forum.grin.mw</a>), or use the contact links in the footer.</p>`,

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
        // A single corrupt json row must NOT throw out of getSection() — that would
        // 500 the whole /api/admin/settings load and make the entire admin Settings
        // panel unusable ("Failed to load settings"). Keep the section's default for
        // just this key instead, and log which row needs fixing.
        try {
          defaults[row.key] = JSON.parse(row.value);
        } catch (e) {
          console.error(`[pool-settings] malformed json for ${section}.${row.key}; using default`, e.message);
        }
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

    // Light obfuscation for contact emails in the public payload (base64, not encryption).
    const b64 = (v) => (v ? Buffer.from(String(v), 'utf8').toString('base64') : '');

    // GA id can live in analytics (new) or seo (legacy leftover) — prefer analytics.
    const gaId = a.ga_tracking_id || seo.ga_tracking_id || '';

    return {
      pool: {
        name: pool.pool_name || '',
        tagline: pool.pool_tagline || '',
        description: pool.pool_description || '',
        // Emails are base64-encoded (not plaintext) so the public /api config response
        // can't be grepped for an address by harvesters; the frontend decodes them and
        // assembles the mailto: only on user interaction. See branding.js decodeEmail().
        contact_email_enc: b64(pool.contact_email),
        homepage_banner: pool.homepage_banner || '',
        visibility: pool.pool_visibility || 'public',
        public_stratum_host: pool.public_stratum_host || '',
        founded_year: pool.founded_year || '',
        security_contact_enc: b64(pool.security_contact),
        pgp_key_url: pool.pgp_key_url || '',
        support_forum_url: pool.support_forum_url || '',
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

  // Linked content pages (the dynamic `pages` CMS table is the source of truth since
  // 2026-06) as [{key, title}] for footer navigation. Excludes nav_location='none'
  // (those are reachable by direct URL only). The sitemap uses PagesManager.listEnabled()
  // directly for the full set; this footer list intentionally honours the link choice.
  listEnabledPages() {
    try {
      return this.db.prepare(`
        SELECT slug, title FROM pages
        WHERE is_published = 1 AND TRIM(html) <> '' AND nav_location <> 'none'
        ORDER BY sort_order, title
      `).all().map((r) => ({ key: r.slug, title: r.title }));
    } catch (e) {
      return [];
    }
  }

  // Full content for one published page by slug (kept for backward compatibility; the
  // public route now calls PagesManager.getPublic directly).
  getPage(key) {
    try {
      const row = this.db.prepare(
        'SELECT slug, title, html FROM pages WHERE slug = ? AND is_published = 1'
      ).get(String(key || ''));
      if (!row || String(row.html).trim() === '') return null;
      return { key: row.slug, title: row.title, html: row.html };
    } catch (e) {
      return null;
    }
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
