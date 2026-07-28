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

// Normalise a settings value (JSON array OR comma/newline-separated string) into a
// deduped JSON-array string. `each(s)` validates+transforms one entry (return null to
// drop it); an empty result falls back to `opts.fallback`. Throws on malformed JSON.
function normStrArray(val, opts) {
  const { cap = 50, each = (s) => s, fallback = [], label = 'list' } = opts || {};
  let arr = val;
  if (typeof arr === 'string') {
    const s = arr.trim();
    if (s === '') return JSON.stringify(fallback);
    if (s.startsWith('[')) {
      try { arr = JSON.parse(s); } catch (e) { throw new Error(`${label} must be a JSON array or a comma/newline-separated list`); }
    } else {
      arr = s.split(/[\n,]+/);
    }
  }
  if (!Array.isArray(arr)) throw new Error(`${label} must be an array`);
  const cleaned = [];
  const seen = new Set();
  for (const raw of arr) {
    const t = each(String(raw).trim());
    if (t && !seen.has(t)) { seen.add(t); cleaned.push(t); }
  }
  if (cleaned.length === 0) return JSON.stringify(fallback);
  if (cleaned.length > cap) throw new Error(`${label}: max ${cap} entries`);
  return JSON.stringify(cleaned);
}

// Parse a stored JSON-array string (already validator-normalised) back to an array at
// startup; tolerate a value that is already an array, and fall back on any corruption.
function parseJsonArray(val, fallback) {
  if (Array.isArray(val)) return val;
  if (typeof val === 'string') {
    try { const a = JSON.parse(val); if (Array.isArray(a)) return a; } catch (_) { /* fall through */ }
  }
  return fallback;
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
      // No `homepage_banner` here — removed 2026-07-27 as dead (see the note in
      // admin-panel/settings-pool-info.html). Site notices are notices.banners, which
      // actually render. A pool that saved a value still has the orphan pool_config row;
      // nothing reads it, and it is no longer published in the public branding payload.
      // Public stratum host shown by the connect/config generator (defaults to the
      // request host at runtime when left blank). Port comes from pool.json.
      public_stratum_host: '',
      // Footer "go-live" year for the copyright line. Blank collapses to just the
      // current year. Stored as a 4-digit string.
      founded_year: '2026',
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
      // Default = a clean two-way pick: the original "Reactor" dark and "Light".
      // Uranium/Nexus and the 10 white-label extras stay opt-in via the admin
      // panel checkbox grid.
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
      twitter_link: 'https://x.com/griniumpool',
      // Nostr profile as a full web URL (e.g. https://njump.me/npub1...) so the footer
      // link works for visitors without a Nostr client.
      nostr_link: '',
      website_link: 'https://grinium.com',
      footer_text: '',
    },
    seo: {
      meta_description: 'GRINIUM is a low-fee Grin (GRIN) mining pool — PPLNS rewards, anonymous Tor payouts, prize draws and bonuses. No sign-up; point your miner and start earning.',
      meta_keywords: 'grin mining pool, grin pool, GRIN, mimblewimble, cuckatoo32, PPLNS pool, anonymous mining, tor payout, asic mining, cryptocurrency mining, GRINIUM',
      title_template: '%page% — %pool_name%',
      // Home page gets its own title (the %page% token is empty on home, so the
      // generic template would render "%pool_name% — %pool_name%"). Tokens:
      // %pool_name%, %tagline%. Leave blank to fall back to the pool name alone.
      home_title: '%pool_name% — Fast & Secure Grin Mining Pool',
      og_title: 'GRINIUM — Grin Mining Pool',
      og_description: 'Mine Grin with low fees, PPLNS rewards and anonymous Tor payouts — plus prize draws, join bonuses and a community fortune board. No account needed.',
      og_image_file: '',
      og_locale: 'en_US',
      twitter_handle: '@GriniumPool',
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
      min_withdrawal: 25.0,
      // Flat withdrawal fee (GRIN) deducted from every payout on every rail — recovers the
      // sender-paid on-chain network fee (~0.023 GRIN typical, weight-based not amount-based).
      // Must stay < min_withdrawal. 0 = the pool absorbs the network fee.
      withdrawal_fee: 0.04,
      auto_payout: 'false',
      payout_frequency: 'manual',
      confirm_depth_mainnet: 1440,
      confirm_depth_testnet: 100,
      max_pending_withdrawals: 100,
      max_user_pending: 10,
      withdrawal_retry_delays: '[21600,43200,86400,172800]',
      // Minutes a miner must wait after a reversed payout (Tor failure, slatepack expiry,
      // admin cancel) before requesting another payout on ANY rail. 0 disables.
      withdrawal_cooldown_minutes: 30,
      // Pre-flight Tor reachability gate: refuse a Tor payout up front when the miner's wallet
      // listener isn't answering over Tor now (probe = onion:80 SOCKS5 connect). Fails OPEN if
      // the pool box can't run the probe, so it never blocks every payout. ON by default.
      tor_preflight_gate: 'true',
      // ── Goblin/Nostr payout rail (design §15). OFF by default. Relays + NIP-05 domains
      // are JSON arrays of strings; the domain list is the SSRF/typo-squat allowlist.
      nostr_payouts_enabled: 'false',
      nostr_relays: '["wss://relay.floonet.dev","wss://relay.0xchat.com","wss://offchain.pub"]',
      nostr_nip05_domains: '["goblin.st"]',
      nostr_destination_cooldown_hours: 48,
      // Minutes a DELIVERED-but-unanswered Goblin payout stays locked before it auto-refunds.
      // Goblin AutoReceives, so a live miner answers in seconds; short bounds a stranded lock.
      nostr_pending_ttl_minutes: 10,
      // ── Abandoned-balance disposition (lib/dormancy.js). OFF by default — turning it on
      // is a deliberate operator decision that eventually MOVES miners' money, so it must be
      // explicitly enabled AND disclosed (ToS + payout-page banner). When on: an address with
      // no share, no successful payout AND no withdrawal request for `dormancy_months`, still
      // holding a balance, is swept into the community PRIZE POOL, which is given away through the
      // pool's published draws. Sweeps only run while the incentive draws are ON (no draws → no
      // sweep). FINAL — the original owner can reclaim any time BEFORE disposition simply by
      // requesting a payout (which resets the countdown even if that payout later fails), never
      // after. `dormancy_active_window_days` is the recent-activity boundary below which an address
      // is treated as idle (NOT a recipient window — there is no recipient split). Never operator revenue.
      dormancy_enabled: 'false',
      dormancy_months: 24,
      dormancy_active_window_days: 30,
      // Grandfather anchor: the 24-month clock counts from max(last_activity, this). 0 = not yet
      // set; the first enabled dormancy run stamps it to "now" and disposes nobody that run, so
      // EVERY address gets a full window of runway after the policy goes live. Never hand-edit.
      dormancy_policy_effective_at: 0,
    },
    access: {
      admin_ip_allowlist: '[]',
      admin_ip_blacklist: '[]',
      session_timeout_hours: 1,
      invite_codes_enabled: 'false',
      invite_codes: '[]',
      // Extra stratum passwords banned from the ownership gate, ON TOP of the hardcoded
      // seed in lib/owner-proof.js — additions-only: the seed and the structural rules
      // (length, d= prefix) always apply and cannot be removed here. Use it for newly
      // discovered firmware defaults (per-ASIC-model factory passwords etc.).
      // Stored as a JSON array of lowercase strings.
      extra_banned_passwords: '[]',
      // Publish the network-map data feeds (/api/pool/topology + /api/network/peers)?
      // OFF by default. Neither endpoint has ever returned an IP — no coordinate is resolved at
      // all (an aggregate sits on its country's centroid, and that country is published beside
      // it) and peer IPs never leave the DB — but both publish a per-country breakdown of who
      // connects to this pool, and on a small pool a country with a single entry is effectively
      // a pointer at one operator. Opt in deliberately.
      network_map_public: 'false',
      // k-anonymity floor applied when the above IS enabled: a country is omitted from the
      // public response unless it holds at least this many peers/miners. Rolled into an
      // "Other" bucket instead, so totals stay honest without naming the thin countries.
      network_map_min_bucket: 3,
      // Country of the central (hub) box, as an ISO-3166-1 alpha-2 code — the top of the hub
      // location chain in /api/pool/topology. The box cannot discover this itself (it sits
      // behind nginx and usually a CDN), so it is declared here. Blank = derive it (pool.json
      // region_country_code → this box's region row → busiest gateway → busiest miner country);
      // if every step misses, the map simply draws no hub marker.
      hub_country_code: '',
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
    //
    // Pages added AFTER that legacy migration (start-mining) are seeded by
    // db.js seedShippedPages() instead: migratePagesFromConfig only ever walks its own
    // fixed five slugs, and its marker means it never runs twice, so a new default here
    // would otherwise never reach an existing pool. Markup uses only classes that already
    // exist in dashboard.css (.callout, .cmd, .data-table, .table-wrap, .muted) — page.html
    // ships no CMS-specific CSS of its own.
    pages: {
      'start-mining': `<img src="/images/pages/start-mining.svg" alt="Start mining in three steps: get a Grin address, point your miner at the pool, then get paid.">

<p class="muted">Last updated: July 2026</p>
<p>New to Grin? This page takes you from nothing to a running miner in about ten minutes. There is <strong>no account to create</strong> — your Grin address is your identity here. Work through the four steps in order, then read <em>Your first 24 hours</em> at the bottom so you know what normal looks like before you start worrying.</p>

<h2>What you need first</h2>
<ul>
  <li><strong>A Grin miner.</strong> Grin uses the <strong>Cuckatoo32 (C32)</strong> proof-of-work, which in practice means an ASIC. Older secondhand C32 units are cheap and draw very little power — often around 120 W — which is why small miners still find Grin worth doing. GPUs cannot compete on C32.</li>
  <li><strong>A Grin wallet.</strong> Any wallet that gives you a Grin address starting with <code>grin1…</code> will do. This is where your earnings land.</li>
  <li><strong>Nothing else.</strong> No registration, no email, no KYC, no minimum deposit.</li>
</ul>

<h2>Step 1 — Get your Grin address</h2>
<p>Install a Grin wallet and copy your address. It is a long string beginning with <code>grin1</code>. Write down your wallet's recovery seed and store it somewhere safe and offline — if you lose the seed, you lose the coins, and nobody (including this pool) can recover them for you.</p>
<p>The pool credits your earnings to whatever address it sees in your miner's config, so this address is the single most important thing you will type today.</p>
<div class="callout"><span><strong>Copy and paste it. Never type it by hand.</strong> Grin addresses are not spell-checked by the pool — a typo produces a perfectly valid address belonging to nobody, and rewards paid to it are gone for good.</span></div>

<h2>Step 2 — Point your miner at the pool</h2>
<p>Every Grin miner needs the same three settings. The exact field names differ between models, but they always mean the same thing:</p>
<code class="cmd">SERVER    stratum.your-pool.com:3333
USER      grin1youraddress.rigname
PASS      any-password-you-choose</code>
<ul>
  <li><strong>Server.</strong> Use the endpoint closest to you. The <a href="/#connect">connection panel on the homepage</a> lists every region and will generate the exact config lines for you — copy them from there rather than from this page, so you get the real hostname and port for this pool.</li>
  <li><strong>User.</strong> Your Grin address, then a dot, then a short name for that machine — for example <code>grin1abc…xyz.rig1</code>. <strong>It must be all lower case</strong>, and the rig name may only contain letters, digits, <code>-</code> and <code>_</code>. <code>Rig1</code>, <code>my rig</code> or an e-mail address are refused at login, not silently ignored. The rig name is just a label so you can tell your machines apart in the stats — running several miners means the same address with a different rig name on each.</li>
  <li><strong>Password.</strong> The pool never uses it to log you in. It is a <em>backup proof of ownership</em>, used to release a payout if your home IP address later changes. Make it <strong>at least 8 characters</strong> and not guessable, and write it down. Your miner works regardless of what you put here — a password that is too short or too common is simply not stored as proof, which quietly leaves you relying on your IP alone. If your miner uses this field to request a difficulty (a value like <code>d=1000</code>), the pool reads it as a setting, not a secret, and keeps no proof from it.</li>
</ul>

<h2>Step 3 — Confirm the pool can see you</h2>
<p>Start the miner and watch its own log first. Within a minute or two it should report that it connected and that shares are being <strong>accepted</strong>. A share is a proof-of-work your machine found that was good enough to count, but not good enough to be a block — shares are how the pool measures your contribution.</p>
<p>Once a few shares have landed, look yourself up on the <a href="/miners-stats.html">Miners</a> page using your Grin address. Your hashrate there is an estimate calculated from recent shares, so give it 10–15 minutes to settle before comparing it with what your miner reports. Some difference between the two numbers is normal and permanent; a number that stays at zero is not.</p>

<h2>Step 4 — Get paid</h2>
<p>This pool pays with <strong>PPLNS</strong> (Pay Per Last N Shares). When the pool finds a block, the reward is split across the shares submitted most recently, so you are paid for the work you actually contributed. It also means your earnings arrive in steps whenever the pool finds a block, not as a smooth trickle — this is normal and applies to every miner in the pool equally.</p>
<ul>
  <li><strong>Maturity.</strong> A freshly mined block cannot be spent for <strong>1,440 blocks</strong> — roughly 24 hours. This is a Grin network rule, not a pool policy. Your share of a block appears as <em>pending</em> until then, and only becomes spendable balance afterwards.</li>
  <li><strong>Fees.</strong> The pool keeps a small percentage of each matured block reward, plus a flat fee per payout that covers the on-chain network fee. Both live figures are shown on the homepage and on your <a href="/account-settings.html">Account</a> page.</li>
  <li><strong>Requesting a payout.</strong> Go to your <a href="/account-settings.html">Account</a> page, enter your address, and choose an amount above the pool's minimum. You will be asked to prove the address is yours — either by requesting from an IP you have recently mined from, or with the rig password from Step 2.</li>
  <li><strong>How it arrives.</strong> By default the pool sends to your wallet over <strong>Tor</strong>, which needs your wallet to be online and listening. If it is not, choose the <strong>Slatepack</strong> option instead: the pool gives you an encrypted blob, you paste it into your wallet, and you paste the reply back. Nothing is lost either way — a payout that cannot be delivered is returned to your balance in full.</li>
</ul>

<h2>Your first 24 hours</h2>
<p>Most "is it broken?" questions are really questions about timing. Here is the honest schedule:</p>
<div class="table-wrap">
<table class="data-table">
  <thead><tr><th>When</th><th>What should happen</th></tr></thead>
  <tbody>
    <tr><td>First 2 minutes</td><td>Your miner connects and its log starts reporting accepted shares.</td></tr>
    <tr><td>First 15 minutes</td><td>Your address appears on the Miners page and its hashrate estimate steadies.</td></tr>
    <tr><td>Hours 1–24</td><td>Pending earnings accumulate every time the pool finds a block. A quiet stretch with no increase is normal — blocks arrive at random.</td></tr>
    <tr><td>After ~24 hours</td><td>The first block you contributed to matures and moves from pending into your spendable balance.</td></tr>
    <tr><td>When you reach the minimum</td><td>Request a payout from the Account page. Until then your balance simply keeps growing.</td></tr>
  </tbody>
</table>
</div>

<h2>If something looks wrong</h2>
<div class="table-wrap">
<table class="data-table">
  <thead><tr><th>What you see</th><th>Usual cause</th></tr></thead>
  <tbody>
    <tr><td>Miner cannot reach the pool at all</td><td>Wrong host or port, or a firewall blocking the outbound stratum port. Re-copy the server line from the homepage connection panel.</td></tr>
    <tr><td><code>Invalid login</code>, or it connects then drops straight away</td><td>The <em>user</em> field. It must be your full <code>grin1…</code> address, optionally a dot and a lower-case rig name. Capitals, spaces, an e-mail address or a rig name on its own are all rejected at login — before a single share is sent.</td></tr>
    <tr><td>Shares are accepted but many come back stale</td><td>Network latency to that endpoint. Switch to a closer region on the homepage connection panel.</td></tr>
    <tr><td>Not listed on the Miners page</td><td>No accepted share has arrived yet. Get the login working first; the listing follows automatically.</td></tr>
    <tr><td>Pool hashrate is lower than the miner's</td><td>Expected. The pool estimates from recent shares, and short-term variance is large. Compare averages over an hour, not instant readings.</td></tr>
    <tr><td>Balance stuck as pending</td><td>Coinbase maturity — 1,440 blocks, about a day. Nothing is wrong and nothing needs doing.</td></tr>
    <tr><td>Earnings dropped after a block</td><td>That block was orphaned by the network, so its credits were reversed for everyone who shared in it. Orphans are visible on the <a href="/blocks.html">Blocks</a> page.</td></tr>
    <tr><td>Payout says it cannot verify you</td><td>Your IP has changed since you last mined. Use the rig password from Step 2 instead — provided it met the 8-character minimum, otherwise it was never stored and the operator has to verify you by hand.</td></tr>
  </tbody>
</table>
</div>

<h2>Still stuck?</h2>
<p>The <a href="/page.html?p=faq">FAQ</a> answers the longer questions — reward maths, orphans, privacy, and what happens to an abandoned balance. For anything else, the contact address and community link are in the footer of every page, and the wider Grin community is friendly to newcomers on the <a href="https://forum.grin.mw" rel="noopener" target="_blank">Grin forum</a>.</p>`,

      about: `<p class="muted">Last updated: July 2026</p>
<p><strong>GRINIUM</strong> is a community mining pool for <strong>Grin (GRIN)</strong>, the privacy-preserving, Mimblewimble-based cryptocurrency. We run the heavy infrastructure — full nodes, multi-region stratum servers, and payout wallets — so you can point a miner at us and start earning without operating any of it yourself.</p>

<h2>What is Grin?</h2>
<p>Grin is a lightweight implementation of the Mimblewimble protocol. It stores no addresses or amounts on-chain, has no pre-mine and no founder's reward, and follows a simple, fair emission of 1 GRIN per second, forever. Mining uses the ASIC-friendly <strong>Cuckatoo32 (C32)</strong> proof-of-work.</p>

<h2>Why mine with GRINIUM?</h2>
<ul>
  <li><strong>Low fee.</strong> A 1% pool fee plus a small flat withdrawal fee that covers the on-chain network fee (the live values are shown on the homepage and on your <a href="/account-settings.html">Account</a> page).</li>
  <li><strong>PPLNS rewards.</strong> Pay-Per-Last-N-Shares spreads rewards fairly and resists pool-hopping.</li>
  <li><strong>Private payouts.</strong> Rewards are delivered to your Grin address over Tor, or as an encrypted Slatepack you finalise yourself.</li>
  <li><strong>No account, no KYC.</strong> Your Grin address <em>is</em> your identity — there is nothing to sign up for.</li>
  <li><strong>Global regions.</strong> Connect to the nearest stratum endpoint for low latency and fewer stale shares.</li>
  <li><strong>Open source.</strong> Every line of the pool is public and auditable — see below.</li>
</ul>

<h2>How it works</h2>
<p>You connect your miner using your Grin address as the username, in the form <code>grin1youraddress.workername</code>. Set a password in your miner's pool config too — the pool never uses it to log you in, but it doubles as a backup proof of ownership when your IP address changes. The pool credits every valid share you submit. When the pool finds a block and it matures, your portion of the reward is added to your balance, ready to withdraw to your wallet.</p>

<h2>Rewards &amp; extras</h2>
<p>Beyond block rewards, GRINIUM can run optional community incentives — a community <a href="/donate.html">prize pool</a>, a block-finder jackpot, loyalty streaks, and periodic prize draws, with winners shown on the public <a href="/fortune-board.html">fortune board</a>. Each one is switched on or off by the pool operator; whichever are live are shown on those pages.</p>

<h2>Open source</h2>
<p>This pool is not a black box. It runs on the <a href="https://github.com/noobvie/Grin-Node-Toolkit" target="_blank" rel="noopener">Grin Node Toolkit</a>, an open-source project you are free to read, audit, clone, fork, and modify. The stratum server, the PPLNS share accounting, the fee calculation and the payout code are all public, so you can verify exactly how your shares become a balance rather than taking our word for it.</p>
<p>If you would rather not trust any operator — including us — the same toolkit deploys a pool of your own, or a solo-mining setup with no pool at all. Found a bug or a fairness problem? Please open an issue or send a patch; it is the fastest way to get it fixed here and at every other pool running the same code.</p>

<p>Ready to start? See the <a href="/">homepage</a> for connection details, or read the <a href="/page.html?p=faq">FAQ</a>.</p>`,

      terms: `<p class="muted">Last updated: July 2026</p>
<p>These Terms of Service ("Terms") govern your use of the GRINIUM mining pool and its website (the "Service"). By connecting a miner or using the website you agree to these Terms. If you do not agree, do not use the Service.</p>

<h2>1. The Service</h2>
<p>GRINIUM is a Grin (GRIN) mining pool. We aggregate the hashpower of participating miners, submit work to the Grin network, and distribute block rewards according to the pool's reward scheme. The Service is provided on a best-effort basis with no guarantee of uptime, profitability, or that any block will be found in a given period.</p>

<h2>2. Identity and accounts</h2>
<p>The Service does not use registered miner accounts. Your Grin address is your identity: rewards earned by hashpower submitted under an address are credited to, and payable only to, that address. You are solely responsible for the security and correctness of the address you mine to. <strong>Rewards paid to an address you do not control cannot be recovered.</strong></p>
<p>Because there is no login, self-service money actions (requesting a payout, creating or finalising a Slatepack, registering a payout destination) require a lightweight ownership check: either one of the last two source IP addresses your address has mined from, or the stratum password configured on your rig. Both are stored only as salted hashes. This is an anti-abuse gate, not authentication — it exists so that a stranger reading the public leaderboard cannot move coins you did not ask to move.</p>

<h2>3. Fees and payouts</h2>
<ul>
  <li>The pool retains a percentage fee from block rewards (default 1%; the current value is shown on the website). It is applied once, when a block's reward matures, and is reversed with the rest of the credit if that block is later orphaned.</li>
  <li>A flat withdrawal fee (default 0.04 GRIN) is deducted from each payout on every payout method. It covers the sender-paid Grin network transaction fee. It is charged only when a payout is confirmed — a payout that fails is returned to your balance in full. The real network fee actually paid on each payout is published on the <a href="/payment-history.html">Payments &amp; Transparency</a> page.</li>
  <li>Block rewards are credited only after the network coinbase maturity period (1,440 blocks on mainnet) to protect against chain reorganisations.</li>
  <li>Payouts are subject to a minimum withdrawal amount (default 25 GRIN; the live value is shown on your Account page). You choose the amount to withdraw, between that minimum and your available balance.</li>
  <li>One payout request may be pending at a time per address, and a short cooling-off period (default 30 minutes) applies after a payout fails and is refunded.</li>
  <li>If a block is later orphaned by the network, the associated credits are reversed.</li>
</ul>

<h2>4. Abandoned and unclaimed balances</h2>
<p><em>This section applies only while the abandoned-balance policy is switched on. It is off by default; whether it is active, the current window, and every balance approaching it are shown on the <a href="/payment-history.html">Payments &amp; Transparency</a> page. While it is off, no balance is ever swept.</em></p>
<p>Because the pool is custodial between the time a reward is credited and the time it is paid out, an address may accumulate a balance and then stop mining without ever withdrawing it. To keep the pool solvent and its books clean, balances left <strong>completely inactive</strong> — no accepted share and no successful payout — for a prolonged period (by default <strong>24 months</strong>; the current window and a live list of affected balances are shown on the <a href="/payment-history.html">Payments &amp; Transparency</a> page) are treated as <strong>abandoned</strong>.</p>
<ul>
  <li>An abandoned balance is <strong>swept into the community prize pool</strong>, where it is given away to miners through the pool's published prize draws. <strong>It is never taken by, or paid to, the pool operator.</strong> Sweeps only run while those draws are active, so an abandoned balance is only ever moved into a pool that pays back out to miners. The prize pool's full inflows and outflows are shown publicly on the <a href="/donate.html">Prize Pool</a> page.</li>
  <li>The sweep is <strong>final</strong>. You may reclaim your balance at any time <strong>before</strong> it is swept — simply request a payout from the <a href="/account-settings.html">Account</a> page, where each address shows how long until its balance would be swept. <strong>Requesting a payout resets your countdown</strong> (and keeps it reset even if that payout later fails and returns to your balance), so any attempt to withdraw protects the balance. Once a balance has been swept into the prize pool it <strong>cannot be recovered</strong>.</li>
  <li>The countdown is measured from the later of your last activity — mining, a successful payout, or any withdrawal request — and the date this policy took effect, so every address is given the full window from that date.</li>
  <li>If your balance is below the minimum withdrawal threshold and you wish to stop mining and withdraw it, contact the operator (see the footer or the Grin forum). After verifying that you control the address, the operator can arrange a manual payout.</li>
</ul>

<h2>5. Acceptable use</h2>
<p>You agree not to: submit invalid or fraudulent shares; attempt to overload, attack, or gain unauthorised access to the Service; reverse-engineer or disrupt the stratum or API endpoints; or use the Service for any unlawful purpose. We may, at our discretion, throttle, ban, or refuse service to any address or IP that abuses the Service.</p>

<h2>6. No warranty</h2>
<p>The Service is provided "as is" and "as available", without warranties of any kind. Cryptocurrency mining carries financial and technical risk, including costs of hardware and electricity, network difficulty changes, and coin-price volatility. You mine at your own risk.</p>

<h2>7. Limitation of liability</h2>
<p>To the maximum extent permitted by law, GRINIUM and its operators shall not be liable for any indirect, incidental, or consequential damages, or for any loss of profits, rewards, or data arising from your use of the Service.</p>

<h2>8. Changes</h2>
<p>We may update these Terms or the pool's parameters (fees, thresholds, reward scheme) at any time. Continued use after a change constitutes acceptance.</p>

<h2>9. Promotions and incentives</h2>
<p>Any prize pool, bonus, jackpot, streak reward, or draw is optional, discretionary, and may be changed, suspended, or withdrawn at any time. Prizes are paid from the community prize pool, whose inflows and outflows are published on the <a href="/donate.html">Prize Pool</a> page; draws are seeded from a Grin block height and hash so the result can be checked independently. Prizes have no cash value beyond the GRIN credited, and are void where prohibited by local law.</p>

<h2>10. Contact</h2>
<p>Questions about these Terms can be directed to the pool operator using the contact links in the website footer, or via the Grin forum (<a href="https://forum.grin.mw/u/hellogrin" target="_blank" rel="noopener">hellogrin on forum.grin.mw</a>).</p>`,

      privacy: `<p class="muted">Last updated: July 2026</p>
<p>This Privacy Policy explains what information the GRINIUM mining pool processes when you mine with us or visit our website. Grin is a privacy-focused cryptocurrency, and we keep data collection to the minimum needed to run the pool.</p>

<h2>What we collect</h2>
<ul>
  <li><strong>Your Grin address.</strong> Submitted as your stratum username; it is your public mining identity and the destination for your payouts.</li>
  <li><strong>Proof of ownership — stored hashed, never in the clear.</strong> So that only you can move your balance, we keep the last two source IP addresses and the last two stratum passwords your address has mined with. Both are stored as <strong>salted scrypt hashes</strong>: the database holds no readable mining IP and no readable password, and a value can only be checked against a hash you supply yourself. Trivial or factory-default passwords are never recorded.</li>
  <li><strong>Country, not location.</strong> Where a connecting IP is geolocated at all it is resolved to a <strong>country only</strong> — no city, no coordinates. Country counts feed the public statistics and the network map; the map's data feeds are off unless the operator enables them, and even then a country is only named once enough peers share it.</li>
  <li><strong>Mining metrics.</strong> Shares, hashrate samples, worker names, and reject/stale counts — used to calculate rewards and display statistics.</li>
  <li><strong>Administrative audit log.</strong> Security-relevant events (admin logins, payout approvals, ownership checks — both accepted and refused) are logged. Any IP recorded there is <strong>truncated to its network block</strong> (/24 for IPv4, /48 for IPv6) rather than stored in full.</li>
  <li><strong>Website analytics &amp; preferences.</strong> Aggregate analytics (e.g. page views) and a locally-stored theme preference.</li>
</ul>

<h2>What we do NOT collect</h2>
<p>We do not ask for or store your name, email address, government ID, or any KYC information. There are no miner accounts and no login passwords — the stratum password field is not a credential and is never used to sign you in; it is only ever compared as a hash when you ask to move your own coins. We never see or store your wallet's private keys or seed phrase.</p>

<h2>Cookies and analytics</h2>
<p>The website may use cookies and a third-party analytics provider (such as Google Analytics) to understand aggregate traffic. Your theme choice is stored in your browser's local storage, not on our servers. You can block cookies in your browser without affecting mining.</p>

<h2>Data retention</h2>
<p>Raw share data is kept only for the duration of the reward (PPLNS) window and then pruned. Per-miner hashrate history is kept for around 100 days and downsampled into durable aggregates. Detailed ledger rows are rolled up into daily totals after about 60 days. The administrative audit log is kept for about 180 days. Financial records (balances and payouts) are retained for accounting and audit integrity. These windows are operator-configurable; the values above are the shipped defaults.</p>

<h2>Third parties</h2>
<p>Payouts are delivered over the <strong>Tor network</strong> to your address; routing is handled by Tor, not by us. A Slatepack payout involves no third party at all. Analytics data is processed by the analytics provider under their own privacy policy. We do not sell or rent your data.</p>
<p>A future payout route delivering to a <strong>Goblin wallet over Nostr</strong> is in development. It would relay your payout as an encrypted message through public Nostr relays — third parties operating under their own terms. It is not enabled, nothing is sent to any relay today, and this policy will be updated before it is.</p>

<h2>Incentives and the fortune board</h2>
<p>Where optional incentives are enabled, winning Grin addresses are published in shortened (masked) form alongside the prize amount on the public fortune board, and prize-pool inflows and outflows are published on the Prize Pool page. Where the abandoned-balance policy is enabled, balances approaching that deadline are listed in masked form on the Payments &amp; Transparency page so an owner can recognise their own. No other personal information is published.</p>

<h2>Your control</h2>
<p>Because mining is address-based and pseudonymous, you can stop participating at any time by disconnecting your miner. To ask about data tied to your address, contact the operator via the footer contact links or the Grin forum (<a href="https://forum.grin.mw/u/hellogrin" target="_blank" rel="noopener">hellogrin on forum.grin.mw</a>).</p>`,

      faq: `<p class="muted">Last updated: July 2026</p>

<h2>What is GRINIUM?</h2>
<p>GRINIUM is a mining pool for Grin (GRIN). We combine many miners' hashpower to find blocks more steadily and share the rewards.</p>

<h2>Do I need to register an account?</h2>
<p>No. There are no accounts and no sign-up. Your Grin address is your identity — just start mining to it.</p>

<h2>How do I start mining?</h2>
<p>Point your miner at the nearest region's stratum endpoint (shown on the homepage), using:</p>
<ul>
  <li><strong>Username:</strong> <code>your_grin_address.worker_name</code> (e.g. <code>grin1abc….rig1</code>)</li>
  <li><strong>Password:</strong> a private string of <strong>at least 8 characters</strong> — use the <em>same</em> one on every rig. It is not a login, but it is one of the two ways you can later prove the address is yours, so don't leave it as <code>x</code> or <code>123</code>.</li>
  <li><strong>Port:</strong> the stratum port on the homepage (default 3333), the same across all regions.</li>
</ul>
<p>Grin-capable ASICs (the iPollo G1 and G1 mini) are configured in their own web interface; GPU miners need a Cuckatoo32-capable miner and a card with at least 11&nbsp;GB of VRAM.</p>

<h2>Isn't the stratum password ignored?</h2>
<p>It used to be. It is still never a login — you cannot use it to sign in anywhere, and no account exists — but the pool now records it (as a salted hash) alongside your recent mining IP addresses, and accepts either one as proof that you control the address when you ask to move your coins. That matters because IP addresses change: a router reboot, an ISP re-lease, switching to mobile data or moving the rig all give you a new one, and only your last two are kept. A password you chose survives all of that.</p>

<h2>What makes a valid rig password?</h2>
<p>Any private string of <strong>8 to 128 characters</strong>. A password that breaks these rules is <strong>silently not recorded</strong> — mining still works normally and you keep earning, but that address is left relying on IP proof alone, which you will only notice on the day you try to withdraw. Refused values:</p>
<ul>
  <li>Anything <strong>shorter than 8 characters</strong> — short enough to guess offline.</li>
  <li>A <strong>single character repeated</strong>, of any length (<code>x</code>, <code>xxxx</code>, <code>1111111111</code>).</li>
  <li><strong>Known factory defaults</strong> such as <code>123456</code> or <code>password</code>. Thousands of rigs ship with the same value, so accepting one would hand a single skeleton key to every address using it.</li>
  <li>Anything starting with <code>d=</code> — some miners put a difficulty request like <code>d=32</code> in the password field. That is a mining instruction, not a secret, so it is never treated as one.</li>
</ul>
<p>Use the same password on every rig, and check the ownership section of your <a href="/account-settings.html">Account</a> page — it shows whether your current password was accepted and recorded. Changing it is safe: the last two are both accepted, so a rotation never locks you out.</p>

<h2>What does it cost?</h2>
<p>Two charges, both published on the site and neither hidden:</p>
<ul>
  <li>A <strong>pool fee</strong>, 1% by default (the live value is on the homepage), taken from block rewards when they mature.</li>
  <li>A <strong>flat withdrawal fee</strong>, 0.04&nbsp;GRIN by default, deducted from each payout on every method. It covers the Grin network transaction fee the pool pays to send your coins; the real per-payout chain fee is published on the <a href="/payment-history.html">Payments &amp; Transparency</a> page. Your Account page shows the exact net amount before you confirm, and the fee is charged only if the payout succeeds.</li>
</ul>

<h2>How are rewards calculated?</h2>
<p>By default the pool uses <strong>PPLNS</strong> (Pay-Per-Last-N-Shares): when the pool finds a block, the reward is split across the most recent shares, so consistent miners earn their fair share and the scheme resists pool-hopping.</p>

<h2>When and how do I get paid?</h2>
<p>A found block must mature (1,440 blocks on mainnet) before its reward is credited — this protects against chain reorganisations. Once your balance reaches the minimum payout (25 GRIN by default; the live value is on your Account page), you request a withdrawal from the <a href="/account-settings.html">Account</a> page. Every method first confirms you own the address, using either a recent mining IP address or your rig's stratum password:</p>
<ul>
  <li><strong>Tor (automatic):</strong> the pool sends your payout to your address over the Tor network. Your wallet listener has to be reachable — the pool checks before locking any funds and tells you if it cannot reach you.</li>
  <li><strong>Slatepack (interactive):</strong> the pool produces an encrypted Slatepack that only your wallet can receive and finalise. No listener required.</li>
</ul>
<p class="muted">A third route — delivery straight into a <strong>Goblin wallet over Nostr</strong>, by username instead of by address — is <strong>in development</strong> and not yet available. It will appear as an extra option on the Account page if and when the operator switches it on.</p>

<h2>Can I choose how much to withdraw?</h2>
<p>Yes. You enter the amount on the Account page — anything from the pool minimum up to your available balance, with shortcut chips for both ends. (The old per-address payout threshold has been retired in favour of choosing an amount at the moment you withdraw.) You can have one payout pending at a time.</p>

<h2>My payout failed. What now?</h2>
<p>The full amount, including the withdrawal fee, returns to your balance automatically — there is nothing to claim back. A short cooling-off period (30 minutes by default) applies before your next request on any method, so a rig that is offline or unreachable does not burn repeated attempts. The usual cause is a Tor wallet listener that is not running; a Slatepack payout works without one.</p>

<h2>My balance is below the minimum and I want to stop mining.</h2>
<p>Contact the operator using the footer links or the Grin forum. After verifying you control the address, the operator can arrange a manual payout.</p>

<h2>What happens if a block is orphaned?</h2>
<p>If a block we found is later orphaned by the network, the credits from that block are reversed. This is normal and rare.</p>

<h2>Is mining anonymous?</h2>
<p>Grin is built on Mimblewimble, so on-chain data is private. We require no personal information, there is no account to create, and the default payout route runs over Tor. What little we do keep to protect your balance — recent mining IPs and your rig password — is stored only as salted hashes. See our <a href="/page.html?p=privacy">Privacy Policy</a> for details.</p>

<h2>Are there prizes or bonuses?</h2>
<p>Optionally, yes. The operator can enable a community <a href="/donate.html">prize pool</a>, a block-finder jackpot, loyalty streaks, and prize draws. Draws are seeded from a Grin block height and hash, so anyone can check the result was not chosen after the fact. Whatever is live shows up on the <a href="/fortune-board.html">fortune board</a>, with winning addresses shown in shortened form.</p>

<h2>What if I stop mining and leave a balance behind?</h2>
<p>If the operator has enabled the abandoned-balance policy, a balance with no mining, no payout and no withdrawal request for a long period (24 months by default) is swept into the community prize pool and given back out to miners through the draws — never to the operator, and the sweep is final. Requesting a payout at any point before then resets your clock. The policy is off by default; whether it is running, and every balance nearing the deadline, are listed on the <a href="/payment-history.html">Payments &amp; Transparency</a> page, and your Account page shows your own countdown.</p>

<h2>I need help.</h2>
<p>Check the connection details on the homepage, post on the Grin forum (<a href="https://forum.grin.mw/u/hellogrin" target="_blank" rel="noopener">hellogrin on forum.grin.mw</a>), or use the contact links in the footer.</p>`,

      impressum: '',
    },
    // Incentive features (prize pool, join bonus, jackpot, streaks, lottery).
    // All funded from a single prize_pool pseudo-address bucket; see lib/incentives.js.
    incentives: {
      incentives_enabled: 'true',            // master switch (on by default; no payouts until the
                                             // prize pool is funded and a specific feature is enabled)
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
      // Recurring weekly draw. OFF by default: `lottery_enabled` is the master switch for
      // contest campaigns too (runDueCampaigns), so an operator who turns the lottery on
      // purely to run an occasion contest would otherwise also arm a weekly draw that pays
      // out lottery_pot_fraction_percent (100 by default) of the whole prize pool. Turn this
      // on deliberately if you want a recurring cadence rather than one-off contests.
      lottery_weekly_enabled: 'false',
      lottery_pot_share_weighted_percent: 50,  // Pot A: tickets ∝ sustained work (hashrate_history)
      lottery_pot_equal_chance_percent: 50,    // Pot B: one entry per qualifying address
      lottery_min_shares: 10,                  // legacy gate (unused since eligibility moved to
                                               // hashrate_history; kept for backward compat)
      lottery_min_active_days: 1,              // min distinct active days to qualify (anti-sybil gate)
      lottery_max_ticket_share_percent: 0,     // whale cap on Pot A tickets (% of total; 0 = off)
      lottery_pot_fraction_percent: 100,       // % of prize_pool paid out per draw
      // special events: JSON array of {name, date:"MM-DD", pot_grin, enabled}
      lottery_special_events: JSON.stringify([
        { name: 'Christmas', date: '12-25', pot_grin: 0, enabled: false },
        { name: 'New Year', date: '01-01', pot_grin: 0, enabled: false },
        { name: 'Grin Genesis Day', date: '01-15', pot_grin: 0, enabled: false },
      ]),
      // Grin Transporter (payout rail #3, Script 092) — reserved, forced off until it ships
      transporter_enabled: 'false',
    },
    // Site-wide maintenance mode + announcement banners.
    notices: {
      maintenance_mode: 'false',
      maintenance_title: 'Under Maintenance',
      maintenance_message: 'We are performing scheduled maintenance and will be back shortly.',
      // banners: JSON array of {id,type,message,link,link_text,dismissible,enabled,start,end}
      // Seeded ON by default: a fresh pool is pre-launch, so every new operator wants the
      // "under development" notice up from day one. It renders site-wide via branding.js
      // renderBanners() and is fully overridable — edit/disable it in admin → Settings →
      // Announcements the moment the pool goes live (a saved row overrides this default).
      banners: '[{"id":"under-dev","type":"warning","message":"This website is under development & testing — data may be incomplete or reset without notice. When the pool goes live, the official announcement will be posted on the Grin Forum.","link":"https://forum.grin.mw/","link_text":"Grin Forum","dismissible":false,"enabled":true}]',
    },
    // Database retention / cleanup. Keeps the SQLite file bounded WITHOUT ever
    // deleting shares still needed for PPLNS distribution or orphan reversal:
    // the prune floor is (confirm_depth + PPLNS window + shares_margin_blocks) and
    // is additionally clamped below the oldest immature block. See lib/retention.js.
    database: {
      retention_enabled: 'true',
      shares_margin_blocks: 360,        // safety blocks kept BEYOND confirm_depth + PPLNS window
      hashrate_keep_days: 100,          // prune per-miner hashrate_history rows older than this
                                        // (pool-wide trends live forever in pool_metrics_hourly)
      resolved_alerts_keep_days: 30,    // prune resolved/acknowledged alerts older than this
      prune_interval_minutes: 60,       // how often retention.js runs (applied at restart)
      balance_log_keep_days: 60,        // raw ledger rows older than this are pruned AFTER being
                                        // rolled up into balance_log_daily (verified per day; the
                                        // rollup is never pruned so lifetime analytics stay exact).
                                        // Runtime floor 45: raw-only readers use windows up to 30d
                                        // (reconciliation wallet-send audit, account earnings).
      audit_log_keep_days: 180,         // prune admin_audit_log rows older than this. These rows
                                        // pair a grin address with a (coarsened) origin IP, so they
                                        // are personal data with a real expiry cost — but they are
                                        // also the money-path trail, so the floor is 30 days: long
                                        // enough to investigate a disputed payout after the fact.
    },
  };

  // Fixed display titles for the five LEGACY content pages only — it predates the CMS and
  // nothing reads it any more (titles live in the `pages` table). Do NOT add newer shipped
  // pages here expecting them to pick up a title: they carry their own in db.js
  // seedShippedPages(), so this map no longer mirrors the `pages` defaults section.
  static pageTitles = {
    about: 'About',
    terms: 'Terms of Service',
    privacy: 'Privacy Policy',
    faq: 'FAQ',
    impressum: 'Impressum',
  };

  // Every valid theme key (public_html/css/themes.css + js/theme.js + js/public-theme.js).
  // 'dark' is the retired pre-mockup public default — still accepted for stored
  // configs; the public pages normalise it to 'atomic' (since 2026-07 that default is
  // the Reactor control-room skin). 'nexus' is public+admin; 'uranium' is BOTH the
  // public "Uranium Classic" theme (the pre-2026-07 uranium-lime default) and an
  // admin-panel palette; 'cyber'/'gradient' and matrix/naruto/japan are admin-only.
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
      home_title: (val) => {
        if (val && val.length > 120) throw new Error('home_title too long (max 120)');
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
      // Upper bound is a sanity rail, not a policy: a fat-fingered 40 instead of 0.04 would
      // silently swallow a whole payout. The hard invariant (fee < min_withdrawal) is enforced
      // in validateConfig, which sees BOTH values — a per-field validator only sees its own.
      withdrawal_fee: (val) => {
        const n = parseFloat(val);
        if (isNaN(n) || n < 0) throw new Error('withdrawal_fee must be >= 0');
        if (n > 1) throw new Error('withdrawal_fee must be <= 1 GRIN (typical network fee is ~0.023)');
        return n;
      },
      payout_frequency: (val) => {
        if (!['manual', 'hourly', 'daily', 'weekly'].includes(val)) throw new Error('invalid payout_frequency');
        return val;
      },
      withdrawal_cooldown_minutes: (val) => {
        const n = parseInt(val, 10);
        if (isNaN(n) || n < 0 || n > 1440) throw new Error('withdrawal_cooldown_minutes must be 0-1440');
        return n;
      },
      tor_preflight_gate: (val) => {
        if (val === true || val === 'true') return 'true';
        if (val === false || val === 'false' || val === undefined || val === '') return 'false';
        throw new Error('tor_preflight_gate must be true or false');
      },
      nostr_payouts_enabled: (val) => {
        if (val === true || val === 'true') return 'true';
        if (val === false || val === 'false' || val === undefined || val === '') return 'false';
        throw new Error('nostr_payouts_enabled must be true or false');
      },
      // Accepts a JSON array or a comma/newline-separated list; normalises to a JSON array
      // of trimmed wss:// URLs (deduped, cap 6). Empty → the relay floor only.
      nostr_relays: (val) => normStrArray(val, {
        cap: 6,
        each: (s) => (/^wss:\/\/[^\s]+$/.test(s) ? s : null),
        fallback: ['wss://relay.floonet.dev'],
        label: 'nostr_relays (wss:// URLs)',
      }),
      // JSON array or comma/newline list of bare hostnames (no scheme, no path). Deduped,
      // lowercased, cap 20. Empty → goblin.st.
      nostr_nip05_domains: (val) => normStrArray(val, {
        cap: 20,
        each: (s) => {
          const d = s.toLowerCase();
          return /^[a-z0-9.-]{1,253}$/.test(d) && !/^\d+\.\d+\.\d+\.\d+$/.test(d) &&
                 !d.startsWith('.') && !d.endsWith('.') && !d.includes('..') ? d : null;
        },
        fallback: ['goblin.st'],
        label: 'nostr_nip05_domains (hostnames)',
      }),
      nostr_destination_cooldown_hours: (val) => {
        const n = parseInt(val, 10);
        if (isNaN(n) || n < 0 || n > 720) throw new Error('nostr_destination_cooldown_hours must be 0-720');
        return n;
      },
      nostr_pending_ttl_minutes: (val) => {
        // Floor of 2: the expiry sweep runs every 60s, so a TTL under ~2 min can't be enforced
        // accurately. Cap of 1440 (24h) keeps it at or below the manual slatepack rail.
        const n = parseInt(val, 10);
        if (isNaN(n) || n < 2 || n > 1440) throw new Error('nostr_pending_ttl_minutes must be 2-1440');
        return n;
      },
      dormancy_enabled: (val) => {
        if (val === true || val === 'true') return 'true';
        if (val === false || val === 'false' || val === undefined || val === '') return 'false';
        throw new Error('dormancy_enabled must be true or false');
      },
      dormancy_months: (val) => {
        // Floor 12: the whole point is a long, unmistakable abandonment window before a FINAL
        // disposition. Cap 120 (10y). Integer months.
        const n = parseInt(val, 10);
        if (isNaN(n) || n < 12 || n > 120) throw new Error('dormancy_months must be 12-120');
        return n;
      },
      dormancy_active_window_days: (val) => {
        const n = parseInt(val, 10);
        if (isNaN(n) || n < 1 || n > 365) throw new Error('dormancy_active_window_days must be 1-365');
        return n;
      },
      dormancy_policy_effective_at: (val) => {
        // Grandfather anchor, unix seconds. Managed by the dormancy runner (self-stamps on first
        // enabled run); accept a non-negative integer so an operator can only ever PUSH it later
        // (more runway), never retroactively shorten anyone's window.
        const n = parseInt(val, 10);
        if (isNaN(n) || n < 0) throw new Error('dormancy_policy_effective_at must be >= 0');
        return n;
      },
    },
    access: {
      session_timeout_hours: (val) => {
        const n = parseInt(val, 10);
        if (isNaN(n) || n < 1 || n > 168) throw new Error('session_timeout_hours must be 1-168');
        return n;
      },
      // Accepts a JSON array or a comma/newline-separated list; normalises to a deduped
      // lowercase JSON array (matching is case-insensitive in owner-proof).
      extra_banned_passwords: (val) => {
        let arr = val;
        if (typeof arr === 'string') {
          const s = arr.trim();
          if (s === '') return '[]';
          if (s.startsWith('[')) {
            try { arr = JSON.parse(s); } catch (e) { throw new Error('extra_banned_passwords must be a JSON array or a comma/newline-separated list'); }
          } else {
            arr = s.split(/[\n,]+/);
          }
        }
        if (!Array.isArray(arr)) throw new Error('extra_banned_passwords must be a JSON array or a comma/newline-separated list');
        const cleaned = [...new Set(
          arr.map((p) => String(p).trim().toLowerCase()).filter((p) => p.length >= 1 && p.length <= 128)
        )];
        if (cleaned.length > 500) throw new Error('extra_banned_passwords: max 500 entries');
        return JSON.stringify(cleaned);
      },
      network_map_min_bucket: (val) => {
        const n = parseInt(val, 10);
        if (isNaN(n) || n < 1 || n > 100) throw new Error('network_map_min_bucket must be 1-100');
        return n;
      },
      // Blank (= derive) or exactly two letters, stored uppercase — this catches the shape
      // mistakes ('VNM', 'Vietnam', 'vn '), which is as far as the check can honestly go: the
      // map's centroid table (lib/geoip.js COUNTRIES) is a curated ~54-country list, so
      // validating membership here would reject a real ISO code just because we hold no
      // position for that country yet. A well-formed code we can't place draws no hub marker
      // (never a wrong one) — see the note in the admin helper text.
      hub_country_code: (val) => {
        const s = String(val == null ? '' : val).trim().toUpperCase();
        if (s === '') return '';
        if (!/^[A-Z]{2}$/.test(s)) throw new Error('hub_country_code must be a 2-letter ISO country code (e.g. VN) or blank');
        return s;
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
        lottery_min_active_days: intRange('lottery_min_active_days', 0, 366),
        lottery_max_ticket_share_percent: percent('lottery_max_ticket_share_percent'),
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
      balance_log_keep_days: (val) => {
        const n = parseInt(val, 10);
        if (isNaN(n) || n < 45 || n > 3650) throw new Error('balance_log_keep_days must be 45-3650');
        return n;
      },
      audit_log_keep_days: (val) => {
        const n = parseInt(val, 10);
        if (isNaN(n) || n < 30 || n > 3650) throw new Error('audit_log_keep_days must be 30-3650');
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
        // `homepage_banner` was published here until 2026-07-27 and nothing ever rendered
        // it. Banners come from `announcements` further down (getActiveBanners()).
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
          nostr: b.nostr_link || '',
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
        home_title: seo.home_title || '',
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

    // Grandfather re-arm (finding #5): remember whether dormancy was enabled BEFORE this write, so a
    // false→true (re)enable can reset the effective anchor and hand every address a fresh full window
    // — otherwise the clock kept running through a long disabled stretch and addresses could be
    // eligible the instant it's turned back on.
    const _flagBool = (v) => v === true || v === 'true';
    const prevDormancyEnabled = section === 'payout'
      ? _flagBool(this.getSection('payout').dormancy_enabled) : null;

    const transaction = this.db.transaction(() => {
      for (const [key, value] of Object.entries(values)) {
        if (!(key in PoolSettings.defaults[section])) {
          throw new Error(`Unknown key '${key}' in section '${section}'`);
        }

        let validated = value;
        if (validators[key]) {
          validated = validators[key](value);
        }

        // Persist the VALIDATED value, not the raw input: validators normalise
        // (trim donation_address, dedupe enabled_themes, re-serialise cleaned JSON) and a
        // validator may turn an object/array input into a storable JSON string — storing
        // `value` would silently keep the un-normalised raw (or bind a raw array).
        let valueStr = validated;
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

      // Dormancy re-arm: on a false→true transition (and only if the caller didn't set the anchor
      // itself in this same update), reset dormancy_policy_effective_at to 0 so the next disposition
      // pass re-stamps it to "now" → a full fresh window for everyone. reflects the rows just written.
      if (section === 'payout' && 'dormancy_enabled' in values && !('dormancy_policy_effective_at' in values)) {
        const nowEnabled = _flagBool(this.getSection('payout').dormancy_enabled);
        if (nowEnabled && !prevDormancyEnabled) {
          stmt.run('payout', 'dormancy_policy_effective_at', '0', 'number', userId);
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
    if (payout.withdrawal_fee !== undefined) {
      config.withdrawal_fee = payout.withdrawal_fee;
    }
    // Cross-field guard, applied AFTER both are merged. The per-field validator can't see the
    // other value, and lowering min_withdrawal on its own can strand an already-stored fee above
    // the new floor. A fee >= the floor makes an at-minimum payout net <= 0, so fall back to
    // absorbing it rather than letting the scheduler reject every threshold withdrawal.
    if (!(config.withdrawal_fee >= 0) || config.withdrawal_fee >= config.min_withdrawal) {
      console.warn(
        `[settings] withdrawal_fee ${config.withdrawal_fee} is invalid against min_withdrawal ` +
        `${config.min_withdrawal} — falling back to 0 (pool absorbs the network fee)`
      );
      config.withdrawal_fee = 0;
    }
    if (payout.max_pending_withdrawals !== undefined) {
      config.max_pending_withdrawals = payout.max_pending_withdrawals;
    }
    if (payout.max_user_pending !== undefined) {
      config.max_user_pending = payout.max_user_pending;
    }
    if (payout.withdrawal_cooldown_minutes !== undefined) {
      config.withdrawal_cooldown_minutes = payout.withdrawal_cooldown_minutes;
    }
    if (payout.tor_preflight_gate !== undefined) {
      config.tor_preflight_gate = payout.tor_preflight_gate === true || payout.tor_preflight_gate === 'true';
    }
    // Nostr payout rail — stored as strings/JSON; coerce to the runtime shapes the bridge
    // expects (boolean, arrays, number). Malformed JSON falls back to the safe default.
    if (payout.nostr_payouts_enabled !== undefined) {
      config.nostr_payouts_enabled = payout.nostr_payouts_enabled === true || payout.nostr_payouts_enabled === 'true';
    }
    if (payout.nostr_relays !== undefined) {
      config.nostr_relays = parseJsonArray(payout.nostr_relays, ['wss://relay.floonet.dev']);
    }
    if (payout.nostr_nip05_domains !== undefined) {
      config.nostr_nip05_domains = parseJsonArray(payout.nostr_nip05_domains, ['goblin.st']);
    }
    if (payout.nostr_destination_cooldown_hours !== undefined) {
      config.nostr_destination_cooldown_hours = payout.nostr_destination_cooldown_hours;
    }
    if (payout.nostr_pending_ttl_minutes !== undefined) {
      config.nostr_pending_ttl_minutes = payout.nostr_pending_ttl_minutes;
    }
    if (pool_info.pool_name !== undefined) {
      config.pool_name = pool_info.pool_name;
    }

    return config;
  }
}

module.exports = PoolSettings;
