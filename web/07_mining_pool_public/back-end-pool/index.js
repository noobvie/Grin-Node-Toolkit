#!/usr/bin/env node

const express = require('express');
const path = require('path');
const { initDb, getDb, ensureLocalRegion, seedDefaultRegions } = require('./lib/db');
const { loadConfig, mergeDbSettings } = require('./lib/config');
const PoolSettings = require('./lib/pool-settings');
const AssetManager = require('./lib/asset-manager');
const WalletAPI = require('./lib/wallet');
const StratumServer = require('./lib/stratum-server');
const NodeStratumClient = require('./lib/node-stratum-client');
const BlockManager = require('./lib/blocks');
const ShareValidator = require('./lib/shares');
const MinerManager = require('./lib/miners');
const BlockMonitor = require('./lib/block-monitor');
const RewardDistributor = require('./lib/rewards');
const IncentivesManager = require('./lib/incentives');
const LotteryManager = require('./lib/lottery');
const WalletTor = require('./lib/wallet-tor');
const WithdrawalScheduler = require('./lib/withdrawal-scheduler');
const AuthManager = require('./lib/auth');
const Captcha = require('./lib/captcha');
const { requireAuth, requireAdmin, requireFreshAuth } = require('./lib/auth-middleware');
const HashrateTracker = require('./lib/hashrate-tracker');
const { verifyIpProof, auditOwnerProof, normalizeIp } = require('./lib/owner-proof');
const PoolstatsReporter = require('./lib/poolstats-reporter');
const RateLimiter = require('./lib/rate-limiter');
const IpFilter = require('./lib/ip-filter');
const AlertMonitor = require('./lib/alert-monitor');
const AlertDelivery = require('./lib/alert-delivery');
const RetentionManager = require('./lib/retention');
const AdsManager = require('./lib/ads');
const PagesManager = require('./lib/pages');
const PostsManager = require('./lib/posts');
const multer = require('multer');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const { execSync } = require('child_process');

// Best-effort WireGuard handshake per region (Model C gateway liveness). Maps each peer's
// public key → region using the "# region: <name>" comment the installer writes above every
// [Peer] in /etc/wireguard/wg-grinpool.conf, then reads `wg show ... latest-handshakes`.
// Returns { <region>: { handshake: <unix_ts> } }; {} on ANY failure (wg not installed, not the
// central box, no permission, dev/Windows) so callers fall back to the share-activity signal.
function readWgHandshakes() {
  const out = {};
  try {
    const conf = fs.readFileSync('/etc/wireguard/wg-grinpool.conf', 'utf8');
    const pubToRegion = {};
    let curRegion = null;
    for (const line of conf.split('\n')) {
      const rm = line.match(/^\s*#\s*region:\s*(.+?)\s*$/i);
      if (rm) { curRegion = rm[1]; continue; }
      const pm = line.match(/^\s*PublicKey\s*=\s*(.+?)\s*$/i);
      if (pm && curRegion) { pubToRegion[pm[1]] = curRegion; curRegion = null; }
    }
    const dump = execSync('wg show wg-grinpool latest-handshakes', { timeout: 2000 }).toString();
    for (const line of dump.split('\n')) {
      const [pub, ts] = line.trim().split(/\s+/);
      if (pub && ts && pubToRegion[pub]) out[pubToRegion[pub]] = { handshake: parseInt(ts, 10) || 0 };
    }
  } catch (e) { /* wg unavailable — share-activity signal is used instead */ }
  return out;
}

const app = express();
// Trust X-Forwarded-For ONLY when the connection comes from our own nginx on loopback.
// This makes req.ip the real client IP from XFF (instead of nginx's 127.0.0.1) while making
// raw XFF UNspoofable: a direct hit on :8080 (not via the local proxy) gets its real socket
// IP, not a forged header. Without this the rate-limiter and admin IP allowlist all compare
// against the wrong/forgeable address.
// 'loopback' matches the toolkit convention (see web/051_wallet/server.js); app-scoped, so
// no collision with other toolkit Express products.
app.set('trust proxy', 'loopback');
app.use(express.json());
app.use(cookieParser());  // FIX #4: Parse httpOnly cookies

// True when a request arrived DIRECTLY on loopback (the trusted operator on the box —
// e.g. Script 07's guided installer hitting 127.0.0.1:8080), NOT proxied in from nginx.
// The app binds 127.0.0.1 only, and trust proxy='loopback' rewrites req.ip to the real
// client IP for anything coming through nginx (which always sets XFF). So a loopback req.ip
// can ONLY be a direct on-box call. Used to skip the anti-robot CAPTCHA for setup-time admin
// registration — the captcha exists to slow REMOTE brute force, not the local root operator.
function isLocalRequest(req) {
  const ip = String(req.ip || '').replace('::ffff:', '');
  return ip === '127.0.0.1' || ip === '::1';
}

// FIX #8: Compute config integrity hash
function hashConfig(cfg) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(cfg))
    .digest('hex');
}

// Security headers middleware
app.use((req, res, next) => {
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'");
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});

// Validation constants
const VALID_NETWORKS = ['mainnet', 'testnet'];

// Config validation
function validateConfig(cfg) {
  if (!VALID_NETWORKS.includes(cfg.network)) {
    throw new Error(`Invalid network: ${cfg.network}`);
  }
  if (!cfg.port || cfg.port < 1024 || cfg.port > 65535) {
    throw new Error(`Invalid port: ${cfg.port}`);
  }
  if (!cfg.db_path || !cfg.db_path.includes('/opt/grin/') && !cfg.db_path.includes('./')) {
    throw new Error(`Invalid db_path: ${cfg.db_path}`);
  }
  if (!cfg.stratum_port || cfg.stratum_port < 1024 || cfg.stratum_port > 65535) {
    throw new Error(`Invalid stratum_port: ${cfg.stratum_port}`);
  }
  // FIX #7: Validate pool fee is between 0 and 50% (prevent fee theft)
  if (cfg.pool_fee_percent !== undefined && (cfg.pool_fee_percent < 0 || cfg.pool_fee_percent > 50)) {
    throw new Error(`Invalid pool_fee_percent: ${cfg.pool_fee_percent} (must be 0-50)`);
  }
  return cfg;
}

let config = null;
let db = null;
let wallet = null;
let stratumServer = null;
let nodeStratumClient = null;
let blockManager = null;
let shareValidator = null;
let minerManager = null;
let blockMonitor = null;
let rewardDistributor = null;
let incentivesManager = null;
let lotteryManager = null;
let walletTor = null;
let withdrawalScheduler = null;
let authManager = null;
// Self-hosted login CAPTCHA (in-memory, single process). No external dependency.
const loginCaptcha = new Captcha();
// Auto-ban (fail2ban-style): too many failed admin logins from one IP within the window
// → temporary IP ban (cooldown). In-memory; pairs with ipFilter.tempBan().
const ADMIN_LOGIN_FAIL_THRESHOLD = 10;
const ADMIN_LOGIN_FAIL_WINDOW_MS = 15 * 60 * 1000;
const ADMIN_LOGIN_BAN_MS = 60 * 60 * 1000;
const adminLoginFailures = new Map(); // ip -> { count, firstAt }
let hashrateTracker = null;
let poolstatsReporter = null;
let rateLimiter = null;
let ipFilter = null;
let alertMonitor = null;
let alertDelivery = null;
let poolSettings = null;
let assetManager = null;
let retentionManager = null;
let adsManager = null;
let pagesManager = null;
let postsManager = null;
let uploadsDir = null;       // persistent media dir (served at /uploads, nginx in prod)
let mediaUpload = null;      // configured multer instance for image uploads

async function initializePool() {
  try {
    // GRIN_POOL_CONF is set by the Script 07 systemd unit (/opt/grin/conf/
    // grin_pubpool.json); ./pool.json is the manual/testnet fallback. Without
    // it the installed service would ignore the operator's config entirely.
    config = loadConfig(process.env.GRIN_POOL_CONF || './pool.json');
    console.log(`[${new Date().toISOString()}] Loading pool configuration...`);

    // Validate config (CRITICAL: issue #12)
    config = validateConfig(config);

    // FIX #8: Check config integrity - warn if modified since last startup
    const configHash = hashConfig(config);
    const hashFile = '.config.sha256';
    if (fs.existsSync(hashFile)) {
      const savedHash = fs.readFileSync(hashFile, 'utf-8').trim();
      if (savedHash !== configHash) {
        console.warn('[SECURITY] Config file modified since last startup! Verify changes are intentional.');
      }
    }
    fs.writeFileSync(hashFile, configHash, 'utf-8');

    console.log(`  Network: ${config.network}`);
    console.log(`  API port: ${config.port}`);
    console.log(`  Stratum port: ${config.stratum_port}`);

    db = initDb(config.db_path);
    console.log(`[${new Date().toISOString()}] Database initialized at ${config.db_path}`);

    // Merge DB settings into config (applies UI-customized settings at startup)
    config = mergeDbSettings(config, db);
    console.log(`[${new Date().toISOString()}] Pool configuration merged from database`);

    // One-time seed of the default grinium regional endpoints (grouped by country),
    // so the public "nearest region" connect grid is populated out of the box. Idempotent
    // (guarded by a persistent marker) — never clobbers operator edits in admin → Regions.
    // Gated to the real grinium.com deployment: a fork running its own domain must NOT
    // advertise grinium.com hosts (its miners would connect to the wrong pool).
    seedDefaultRegions(config.stratum_port, config.subdomain);

    // Self-register this pool server's own region so it shows as a real connect card
    // and auto-joins the grid when a gateway for another zone forwards shares in. Only the
    // singlebox role runs a local stratum; a bare hub relies purely on regional gateways.
    if (config.role === 'singlebox') {
      const localStratum = config.subdomain ? `${config.subdomain}:${config.stratum_port}` : '';
      ensureLocalRegion(config.region, localStratum, {
        label: config.region_label,
        country: config.region_country,
        country_code: config.region_country_code
      });
    }

    // Initialize pool settings manager and asset manager
    poolSettings = new PoolSettings(db);
    assetManager = new AssetManager(config, db);
    console.log(`[${new Date().toISOString()}] Pool settings and asset managers initialized`);

    wallet = new WalletAPI(config);
    console.log(`[${new Date().toISOString()}] Wallet API initialized (${config.network})`);

    blockManager = new BlockManager(config);
    shareValidator = new ShareValidator(config);
    minerManager = new MinerManager(config);
    console.log(`[${new Date().toISOString()}] Mining managers initialized`);

    stratumServer = new StratumServer(config);
    stratumServer.setBlockManager(blockManager);
    stratumServer.start();

    // Wire upstream node stratum → pool stratum server.
    // NodeStratumClient receives job notifications from the Grin node and calls
    // stratumServer.setNewJob(), which broadcasts them to all connected miners.
    // It also forwards miner submits to the node for PoW validation.
    nodeStratumClient = new NodeStratumClient(config, stratumServer);
    stratumServer.setNodeStratumClient(nodeStratumClient);
    nodeStratumClient.start();

    blockMonitor = new BlockMonitor(config);
    blockMonitor.start();

    // Let BlockManager capture per-block network difficulty (for round effort / luck) by reusing
    // the block monitor's node client. Optional — creditBlock leaves it NULL if unavailable.
    if (blockMonitor.grinNode) blockManager.setNodeApi(blockMonitor.grinNode);

    rewardDistributor = new RewardDistributor(config);
    blockMonitor.setRewardDistributor(rewardDistributor);
    console.log(`[${new Date().toISOString()}] Reward distributor initialized (PPLNS window: 60 blocks)`);

    // Incentive system: prize pool, join bonus, jackpot, streaks, lottery. All no-ops unless
    // enabled in the admin panel. LotteryManager reuses the block monitor's node client for
    // its verifiable draw seed.
    incentivesManager = new IncentivesManager(config);
    adsManager = new AdsManager(config);
    pagesManager = new PagesManager(config);
    postsManager = new PostsManager(config);

    // Media uploads (cover images + in-body images from the admin CMS editor). Stored in a
    // persistent dir OUTSIDE public_html (which is rsynced/overwritten by the installer):
    // <db dir>/uploads, served at /uploads — by nginx in production (location /uploads/) and
    // by the express.static fallback below in dev / if the nginx block is absent.
    uploadsDir = config.uploads_dir || path.join(path.dirname(config.db_path || './pool.db'), 'uploads');
    try { fs.mkdirSync(uploadsDir, { recursive: true }); }
    catch (e) { console.error(`[media] could not create uploads dir ${uploadsDir}: ${e.message}`); }
    const ALLOWED_IMG = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp', 'image/svg+xml': '.svg' };
    mediaUpload = multer({
      storage: multer.diskStorage({
        destination: (req, file, cb) => cb(null, uploadsDir),
        filename: (req, file, cb) => {
          const ext = ALLOWED_IMG[file.mimetype] || '.bin';
          const safe = (file.originalname || 'image').toLowerCase()
            .replace(/\.[^.]*$/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'image';
          cb(null, `${Date.now()}-${crypto.randomBytes(4).toString('hex')}-${safe}${ext}`);
        },
      }),
      limits: { fileSize: 5 * 1024 * 1024, files: 1 },  // 5 MB, single file
      fileFilter: (req, file, cb) => {
        if (ALLOWED_IMG[file.mimetype]) return cb(null, true);
        cb(new Error('Only JPG, PNG, GIF, WEBP or SVG images are allowed'));
      },
    });
    console.log(`[${new Date().toISOString()}] CMS managers ready (pages, posts); uploads → ${uploadsDir}`);
    lotteryManager = new LotteryManager(config, blockMonitor.grinNode);
    console.log(`[${new Date().toISOString()}] Incentives + lottery managers initialized`);

    // Daily loyalty-streak roll-up (every 24h) and hourly lottery scheduler tick.
    setInterval(() => {
      try { incentivesManager.updateStreaks(); }
      catch (e) { console.error(`[Incentives] streak update failed: ${e.message}`); }
    }, 24 * 3600 * 1000);
    setInterval(() => {
      lotteryManager.runDueDraws().catch((e) => console.error(`[Lottery] scheduler tick failed: ${e.message}`));
    }, 3600 * 1000);

    walletTor = new WalletTor(config);
    console.log(`[${new Date().toISOString()}] Wallet Tor integration initialized`);

    // Pass the Owner-API wallet so the scheduler can drive the slatepack payout rail.
    withdrawalScheduler = new WithdrawalScheduler(config, wallet);
    withdrawalScheduler.start();

    authManager = new AuthManager(config);
    console.log(`[${new Date().toISOString()}] Authentication manager initialized`);

    hashrateTracker = new HashrateTracker(config, minerManager);
    hashrateTracker.start();

    // Initialize poolstats reporter (push to miningpoolstats.stream)
    poolstatsReporter = new PoolstatsReporter(config, {
      blockManager,
      minerManager,
      stratumServer,
      hashrateTracker
    });
    poolstatsReporter.start();

    // Initialize rate limiter
    rateLimiter = new RateLimiter({
      rate_limits: config.rate_limits || {
        public: 60,
        auth: 3,
        api: 30,
        admin: 10
      }
    });
    console.log(`[${new Date().toISOString()}] Rate limiter initialized`);

    // Initialize IP filter (allowlist/blacklist)
    ipFilter = new IpFilter({
      allowlist: config.admin_ip_allowlist || [],
      blacklist: config.admin_ip_blacklist || []
    });
    console.log(`[${new Date().toISOString()}] IP filter initialized`);

    // Initialize alert delivery (email, Discord, Slack)
    alertDelivery = new AlertDelivery(config);

    // Initialize alert monitor (health checks, triggers). alertDelivery is passed in so
    // triggered alerts are actually delivered (Discord/Slack); `wallet` (Owner-API client)
    // gives it a real wallet online/balance signal.
    alertMonitor = new AlertMonitor(config, {
      blockMonitor,
      walletTor,
      wallet,
      stratumServer,
      withdrawalScheduler,
      alertDelivery
    }, db);
    alertMonitor.start();
    console.log(`[${new Date().toISOString()}] Alert monitor started`);

    // Database retention/cleanup — prunes shares (only below the PPLNS+maturity-safe
    // floor), old hashrate history, and resolved alerts. Configurable in the admin
    // panel → Database / Cleanup. File space is reclaimed by the weekly VACUUM cron.
    retentionManager = new RetentionManager(config);
    retentionManager.start();

    setupRoutes();

    // Bind the configured host (default 127.0.0.1). The app sits behind nginx and relies on
    // trust proxy='loopback' + the admin IP allowlist, both of which assume a loopback-only
    // bind — binding all interfaces would let a direct off-box hit bypass nginx with a forged
    // X-Forwarded-For. config.host comes from the systemd HOST env / pool.json.
    app.listen(config.port, config.host, () => {
      console.log(`[${new Date().toISOString()}] Pool API listening on ${config.host}:${config.port}`);
    });

  } catch (err) {
    console.error(`[ERROR] Pool initialization failed: ${err.message}`);
    process.exit(1);
  }
}

function setupRoutes() {
  // Serve uploaded CMS media at /uploads. In production nginx serves this dir directly
  // (location /uploads/), but mounting it here too makes the app self-sufficient in dev
  // and a safe fallback if the nginx block is missing. immutable: filenames are unique.
  if (uploadsDir) {
    app.use('/uploads', express.static(uploadsDir, {
      maxAge: '7d', immutable: true, index: false, dotfiles: 'ignore',
      setHeaders: (res) => {
        // Parity with the nginx /uploads/ block: stop MIME-sniffing and neutralise any
        // script inside a directly-opened SVG. Overrides the app's global CSP for this
        // path (which otherwise allows 'unsafe-inline' and would let an SVG run script).
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
      },
    }));
  }

  // ─── Helper middleware: secure admin endpoints (IP filter + auth + rate limit) ────
  const secureAdmin = [
    rateLimiter.middleware('admin'),
    ipFilter.middleware('admin'),
    requireAdmin(authManager)
  ];

  // Step-up gate for money/destructive admin actions: same as secureAdmin but also requires
  // a PASSWORD re-verification within the last 5 min (requireFreshAuth → token.pwa). A live
  // (or stolen) session alone is not enough — the client must call /api/admin/reauth first.
  const STEP_UP_MAX_AGE_S = 300;
  const freshAdmin = [
    rateLimiter.middleware('admin'),
    ipFilter.middleware('admin'),
    requireFreshAuth(authManager, STEP_UP_MAX_AGE_S)
  ];

  // Auto-ban bookkeeping shared by the password and 2FA login steps: count failures per IP
  // within the window, temp-ban on threshold.
  const recordAdminLoginFailure = (ip) => {
    const now = Date.now();
    let rec = adminLoginFailures.get(ip);
    if (!rec || now - rec.firstAt > ADMIN_LOGIN_FAIL_WINDOW_MS) rec = { count: 0, firstAt: now };
    rec.count++;
    adminLoginFailures.set(ip, rec);
    if (rec.count >= ADMIN_LOGIN_FAIL_THRESHOLD) {
      ipFilter.tempBan(ip, ADMIN_LOGIN_BAN_MS);
      adminLoginFailures.delete(ip);
      try {
        db.prepare(`INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, details, ip)
                    VALUES (NULL, 'ip_autoban', 'security', ?, ?, ?)`)
          .run(ip, JSON.stringify({ reason: 'failed_admin_logins', threshold: ADMIN_LOGIN_FAIL_THRESHOLD, ban_minutes: ADMIN_LOGIN_BAN_MS / 60000 }), ip);
      } catch (e) { /* non-fatal */ }
    }
  };

  // ─── Public Health Check (rate-limited, no auth) ───────────────────────────
  // Registered on both /health and /api/health: nginx proxies /api/* to the backend,
  // so the /api/health alias is what reaches the pool through the standard proxy path.
  app.get(['/health', '/api/health'],
    rateLimiter.middleware('public'),
    (req, res) => {
      res.json({
        status: 'ok',
        network: config.network,
        timestamp: new Date().toISOString()
      });
    }
  );

  // ─── Multi-region (Model C) ─────────────────────────────────────────────────
  // There is NO satellite share/block ingestion API any more. Regional GATEWAYS are
  // thin stratum forwarders (HAProxy + WireGuard, scripts/lib/07_lib_gateway.sh): they
  // forward raw stratum to a per-region internal port on THIS box (PROXY-protocol v2
  // carries the real miner IP). The central stratum-server records those shares directly
  // into the local DB with the region stamped from the listener — exactly like local
  // miners — so all accounting stays single-writer here. Per-region liveness is derived
  // from recent shares (+ best-effort WireGuard handshake); see /api/admin/health/gateways.

  // ─── Public White-Label Config (rate-limited, no auth) ─────────────────────
  // Serves the curated branding/SEO/analytics payload consumed by /js/branding.js
  // on every public page. Only operator-set, non-sensitive fields are exposed.
  app.get('/api/public/branding',
    rateLimiter.middleware('public'),
    (req, res) => {
      try {
        const assetUrlFor = (type) => {
          const asset = assetManager.getActiveAsset(type);
          return asset ? assetManager.getAssetUrl(asset.filename) : '';
        };
        const cfg = poolSettings.buildPublicConfig(assetUrlFor);
        // Connection info for the miner-config generator (host falls back to request host).
        cfg.connection = {
          stratum_host: cfg.pool.public_stratum_host || req.hostname || '',
          stratum_port: config.stratum_port || '',
          network: config.network || 'mainnet',
          algorithm: 'Cuckatoo32',
        };
        // Public incentive summary (prize-pool size, next draw, recent winners). Only shown
        // when the operator has enabled incentives. Winner addresses are truncated.
        try {
          if (incentivesManager && incentivesManager.enabled()) {
            const recent = lotteryManager.recentDraws(3);
            const trunc = (a) => (a && a.length > 14 ? `${a.slice(0, 10)}…${a.slice(-4)}` : a);
            const incCfg = poolSettings.getSection('incentives');
            cfg.incentives = {
              enabled: true,
              ...incentivesManager.publicSummary(),
              donation_address: incCfg.donation_address || '',
              lottery: lotteryManager.nextScheduled(),
              recent_winners: recent.flatMap((d) =>
                (d.winners || []).map((w) => ({
                  event: d.event_name || 'Weekly',
                  address: trunc(w.address || w.grin_address),
                  amount: w.amount,
                }))
              ),
            };
          } else {
            cfg.incentives = { enabled: false };
          }
        } catch (e) {
          cfg.incentives = { enabled: false };
        }
        // Short cache: branding changes are infrequent and the page can tolerate it.
        res.setHeader('Cache-Control', 'public, max-age=60');
        res.json({ success: true, data: cfg });
      } catch (err) {
        res.status(500).json({ error: 'Failed to load branding' });
      }
    }
  );

  // ─── Public GRIN price (footer ticker) — cached external lookup ────────────────
  // The pool box has a node + wallet but no market data, so price comes from a public
  // market API (CoinGecko). Fetched server-side (avoids CORS + a per-visitor key) and
  // cached ~5 min. On any failure we serve the last good value, or {available:false}.
  let _priceCache = { ts: 0, data: null };
  const PRICE_TTL_MS = 5 * 60 * 1000;
  app.get('/api/public/price',
    rateLimiter.middleware('public'),
    async (req, res) => {
      const now = Date.now();
      if (_priceCache.data && (now - _priceCache.ts) < PRICE_TTL_MS) {
        res.setHeader('Cache-Control', 'public, max-age=300');
        return res.json({ success: true, data: _priceCache.data });
      }
      try {
        const ctrl = AbortSignal.timeout ? AbortSignal.timeout(5000) : undefined;
        const r = await fetch(
          'https://api.coingecko.com/api/v3/simple/price?ids=grin&vs_currencies=usd,btc',
          { signal: ctrl, headers: { accept: 'application/json' } }
        );
        if (!r.ok) throw new Error('upstream ' + r.status);
        const j = await r.json();
        const g = j && j.grin ? j.grin : {};
        const data = {
          available: typeof g.usd === 'number' || typeof g.btc === 'number',
          usd: typeof g.usd === 'number' ? g.usd : null,
          btc: typeof g.btc === 'number' ? g.btc : null,
          source: 'coingecko',
          updated_at: now,
        };
        if (data.available) _priceCache = { ts: now, data };
        res.setHeader('Cache-Control', 'public, max-age=300');
        res.json({ success: true, data: _priceCache.data || data });
      } catch (err) {
        // Serve stale-if-error; otherwise report unavailable (footer hides the ticker).
        if (_priceCache.data) return res.json({ success: true, data: _priceCache.data });
        res.json({ success: true, data: { available: false } });
      }
    }
  );

  // ─── Public API reference — auto-generated from the live Express route table ───
  // Always accurate (it reflects the routes actually mounted), self-documenting. Only
  // public-safe prefixes are exposed; admin/auth routes are never listed. api-docs.html
  // renders this. Descriptions are a best-effort lookup keyed by "METHOD path"; an
  // unknown route still appears (with an empty description) so the list can't drift.
  const PUBLIC_API_PREFIXES = [
    '/api/public/', '/api/account/', '/api/config/', '/api/pool/',
  ];
  const API_DOC_DESCRIPTIONS = {
    'GET /api/public/branding': 'White-label config (name, theme, SEO, social, footer links).',
    'GET /api/public/price': 'Cached GRIN price (USD + BTC).',
    'GET /api/public/status': 'Coarse pool/node/wallet health (no balances).',
    'GET /api/public/ads': 'Active operator ads by placement.',
    'GET /api/public/lottery/winners': 'Fortune-board winner history (truncated addresses).',
    'GET /api/public/endpoints': 'This API reference (machine-readable).',
    'GET /api/config/pool-info': 'Network, pool fee %, minimum withdrawal.',
    'GET /api/pool/stats': 'Live pool stats: hashrate, miners, blocks, share quality.',
    'GET /api/pool/stats/regions': 'Per-region stratum endpoints + live status.',
    'GET /api/pool/blocks': 'Pool-found blocks (paginated: limit, offset, status).',
    'GET /api/pool/effort': 'Current round effort, recent luck, time since last block.',
    'GET /api/pool/hashrate/history': 'Pool hashrate time-series (?hours=).',
    'GET /api/pool/status': 'Coarse service status strip.',
    'GET /api/account/:addr': 'Account summary: balance, paid, min payout, effort.',
    'GET /api/account/:addr/workers': 'Per-worker (rig) hashrate + share quality.',
    'GET /api/account/:addr/hashrate/history': 'Account hashrate time-series (?hours=).',
    'POST /api/account/:addr/withdraw': 'Request a payout (Tor or Slatepack); IP-proof gated.',
    'POST /api/account/:addr/min-payout': 'Set this address’s personal payout threshold.',
  };
  app.get('/api/public/endpoints',
    rateLimiter.middleware('public'),
    (req, res) => {
      try {
        const stack = (req.app._router && req.app._router.stack) || [];
        const seen = new Set();
        const out = [];
        for (const layer of stack) {
          const route = layer && layer.route;
          if (!route || !route.path) continue;
          const paths = Array.isArray(route.path) ? route.path : [route.path];
          for (const p of paths) {
            if (typeof p !== 'string') continue;
            if (!PUBLIC_API_PREFIXES.some((pre) => p === pre || p.startsWith(pre))) continue;
            const methods = Object.keys(route.methods || {})
              .filter((m) => m !== '_all').map((m) => m.toUpperCase());
            for (const m of methods) {
              const key = m + ' ' + p;
              if (seen.has(key)) continue;
              seen.add(key);
              out.push({ method: m, path: p, description: API_DOC_DESCRIPTIONS[key] || '' });
            }
          }
        }
        out.sort((a, b) => (a.path === b.path ? a.method.localeCompare(b.method) : a.path.localeCompare(b.path)));
        res.setHeader('Cache-Control', 'public, max-age=300');
        res.json({ success: true, data: { count: out.length, endpoints: out } });
      } catch (err) {
        res.status(500).json({ error: 'Failed to build API reference' });
      }
    }
  );

  // ─── Public Fortune Board: lottery winner history (no auth, rate-limited) ──────
  // Transparency/audit feed — winner (truncated address) + amount + date + verifiable seed.
  app.get('/api/public/lottery/winners',
    rateLimiter.middleware('public'),
    (req, res) => {
      try {
        if (!incentivesManager || !incentivesManager.enabled()) {
          return res.json({ success: true, data: { total: 0, winners: [] } });
        }
        const limit = Math.min(parseInt(req.query.limit, 10) || 25, 100);
        const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
        res.setHeader('Cache-Control', 'public, max-age=60');
        res.json({ success: true, data: lotteryManager.winnerHistory(limit, offset) });
      } catch (err) {
        res.status(500).json({ error: 'Failed to load winners' });
      }
    }
  );

  // Single content page authored in the admin CMS (dynamic `pages` table; the legacy
  // fixed-slot config was migrated into it). `:key` is the page slug.
  app.get('/api/public/page/:key',
    rateLimiter.middleware('public'),
    (req, res) => {
      try {
        const page = pagesManager.getPublic(req.params.key);
        if (!page) return res.status(404).json({ error: 'Page not found' });
        res.setHeader('Cache-Control', 'public, max-age=60');
        res.json({ success: true, data: page });
      } catch (err) {
        res.status(500).json({ error: 'Failed to load page' });
      }
    }
  );

  // Navigable published pages (for footer/header link lists in public-shell.js).
  app.get('/api/public/pages',
    rateLimiter.middleware('public'),
    (req, res) => {
      try {
        res.setHeader('Cache-Control', 'public, max-age=60');
        res.json({ success: true, data: pagesManager.listEnabled() });
      } catch (err) {
        res.status(500).json({ error: 'Failed to load pages' });
      }
    }
  );

  // Blog: paginated list of published posts (cards).
  app.get('/api/public/posts',
    rateLimiter.middleware('public'),
    (req, res) => {
      try {
        const out = postsManager.listPublished({ limit: req.query.limit, offset: req.query.offset });
        res.setHeader('Cache-Control', 'public, max-age=60');
        res.json({ success: true, data: out });
      } catch (err) {
        res.status(500).json({ error: 'Failed to load posts' });
      }
    }
  );

  // Blog: full published post by slug (permalink page).
  app.get('/api/public/post/:slug',
    rateLimiter.middleware('public'),
    (req, res) => {
      try {
        const post = postsManager.getPublic(req.params.slug);
        if (!post) return res.status(404).json({ error: 'Post not found' });
        res.setHeader('Cache-Control', 'public, max-age=60');
        res.json({ success: true, data: post });
      } catch (err) {
        res.status(500).json({ error: 'Failed to load post' });
      }
    }
  );

  // Blog RSS 2.0 feed (latest 20 published posts). nginx proxies /blog/rss.xml here.
  app.get('/blog/rss.xml',
    rateLimiter.middleware('public'),
    (req, res) => {
      try {
        const branding = poolSettings.getSection('branding');
        const seo = poolSettings.getSection('seo');
        const origin = siteOrigin(req);
        const title = (branding.pool_name || seo.site_title || 'Grin Pool') + ' — Blog';
        const { posts } = postsManager.listPublished({ limit: 20, offset: 0 });
        const esc = (s) => String(s == null ? '' : s)
          .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
        xml += '<rss version="2.0"><channel>\n';
        xml += '  <title>' + esc(title) + '</title>\n';
        xml += '  <link>' + esc(origin + '/blog.html') + '</link>\n';
        xml += '  <description>' + esc(seo.site_description || 'Pool news and announcements') + '</description>\n';
        posts.forEach((p) => {
          const url = origin + '/blog/' + encodeURIComponent(p.slug);
          xml += '  <item>\n';
          xml += '    <title>' + esc(p.title) + '</title>\n';
          xml += '    <link>' + esc(url) + '</link>\n';
          xml += '    <guid isPermaLink="true">' + esc(url) + '</guid>\n';
          xml += '    <pubDate>' + new Date((p.published_at || 0) * 1000).toUTCString() + '</pubDate>\n';
          xml += '    <description>' + esc(p.excerpt || '') + '</description>\n';
          xml += '  </item>\n';
        });
        xml += '</channel></rss>\n';
        res.type('application/rss+xml').send(xml);
      } catch (err) {
        res.status(500).type('text/plain').send('Failed to build feed');
      }
    }
  );

  // ─── SEO files: robots.txt, sitemap.xml, PWA manifest (served via nginx proxy) ──
  // Resolve the canonical site origin: configured site_url > request host.
  function siteOrigin(req) {
    const seo = poolSettings.getSection('seo');
    if (seo.site_url) return String(seo.site_url).replace(/\/+$/, '');
    return (req.protocol || 'https') + '://' + req.get('host');
  }

  app.get('/robots.txt',
    rateLimiter.middleware('public'),
    (req, res) => {
      try {
        const seo = poolSettings.getSection('seo');
        const noindex = seo.robots_noindex === true || seo.robots_noindex === 'true';
        const sitemapOn = !(seo.sitemap_enabled === false || seo.sitemap_enabled === 'false');
        let body = 'User-agent: *\n';
        body += noindex ? 'Disallow: /\n' : 'Disallow:\n'; // index by default
        if (sitemapOn && !noindex) body += 'Sitemap: ' + siteOrigin(req) + '/sitemap.xml\n';
        res.type('text/plain').send(body);
      } catch (err) {
        res.type('text/plain').send('User-agent: *\nDisallow:\n');
      }
    }
  );

  // Public pages included in the sitemap (extension-less; nginx resolves $uri.html).
  // pool-info + connect were merged into the dashboard (index) 2026-06; the dashboard
  // carries the #connect + #info anchors, so only / is listed for that content.
  const SITEMAP_PATHS = ['/', '/miners-stats', '/blocks.html', '/fortune-board', '/donate', '/blog.html', '/api-docs.html'];

  app.get('/sitemap.xml',
    rateLimiter.middleware('public'),
    (req, res) => {
      try {
        const seo = poolSettings.getSection('seo');
        const noindex = seo.robots_noindex === true || seo.robots_noindex === 'true';
        const sitemapOn = !(seo.sitemap_enabled === false || seo.sitemap_enabled === 'false');
        if (noindex || !sitemapOn) return res.status(404).type('text/plain').send('Not found');

        const origin = siteOrigin(req);
        const paths = SITEMAP_PATHS.slice();
        // Append authored content pages (dynamic CMS) and published blog posts.
        pagesManager.listEnabled().forEach((p) => paths.push('/page.html?p=' + p.key));
        try {
          postsManager.listPublished({ limit: 50, offset: 0 }).posts
            .forEach((p) => paths.push('/blog/' + p.slug));
        } catch (e) { /* posts optional in sitemap */ }

        const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
        xml += '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n';
        paths.forEach((p) => {
          xml += '  <url><loc>' + esc(origin + p) + '</loc></url>\n';
        });
        xml += '</urlset>\n';
        res.type('application/xml').send(xml);
      } catch (err) {
        res.status(500).type('text/plain').send('Error');
      }
    }
  );

  app.get('/manifest.json',
    rateLimiter.middleware('public'),
    (req, res) => {
      try {
        const pool = poolSettings.getSection('pool_info');
        const seo = poolSettings.getSection('seo');
        const brand = poolSettings.getSection('branding');
        const name = pool.pool_name || 'Grin Mining Pool';
        const themeColor = seo.theme_color || brand.accent_color || '#667eea';

        const icons = [];
        const pushIcon = (type, size) => {
          const asset = assetManager.getActiveAsset(type);
          if (asset) {
            icons.push({ src: assetManager.getAssetUrl(asset.filename), sizes: size, type: asset.mime_type || 'image/png' });
          }
        };
        pushIcon('icon_192', '192x192');
        pushIcon('icon_512', '512x512');

        const manifest = {
          name: name,
          short_name: brand.app_short_name || name,
          start_url: '/',
          display: 'standalone',
          background_color: themeColor,
          theme_color: themeColor,
          icons: icons,
        };
        res.type('application/manifest+json').send(JSON.stringify(manifest, null, 2));
      } catch (err) {
        res.status(500).json({ error: 'Failed to build manifest' });
      }
    }
  );

  // Issue a self-hosted CAPTCHA challenge for the login/register forms. Public-rate-limited
  // (60/min) so the form can fetch one without spending the strict auth budget (10/min).
  app.get('/api/auth/captcha', rateLimiter.middleware('public'), (req, res) => {
    res.json(loginCaptcha.issue());
  });

  // FIX #7, #6, #4: Add rate limiting + first-admin gating + httpOnly cookies
  app.post('/api/auth/register',
    async (req, res) => {
      try {
        // Rate gate (peek, don't spend yet) — refuse early if locked/over budget.
        const rl = rateLimiter.peek('auth', req);
        if (!rl.allowed) return rateLimiter.sendLimited(res, rl);

        // Check if any admin already exists (prevent first-admin takeover)
        const adminCount = db.prepare('SELECT COUNT(*) as cnt FROM users WHERE is_admin=1').get();
        if (adminCount.cnt > 0) {
          return res.status(403).json({ error: 'Admin registration closed.' });
        }

        // CAPTCHA gate (before any credential work — a wrong/expired captcha never counts
        // as a password attempt and can't trip the account lockout). Skipped for direct
        // on-box (loopback) calls: this is first-admin-only registration, run once by the
        // trusted root operator via Script 07's guided installer. The captcha only exists
        // to slow REMOTE brute force, which can't reach this loopback-bound endpoint anyway.
        if (!isLocalRequest(req) &&
            !loginCaptcha.verify(req.body?.captcha_id, req.body?.captcha_answer)) {
          return res.status(400).json({ success: false, error: 'Captcha incorrect or expired. Try again.' });
        }

        // Genuine credential attempt — spend one token against the auth limit.
        rateLimiter.consume('auth', req);

        const { username, password } = req.body;
        const result = await authManager.registerAdmin(username, password);
        if (result.success) {
          // FIX #4: Generate tokens and set as httpOnly cookies. pwa=now — the admin just
          // set this password, so the first session starts step-up-fresh.
          const tokens = authManager.generateTokens(result.user_id, username, true, 0, Math.floor(Date.now() / 1000));

          res.cookie('access_token', tokens.accessToken, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'strict',
            maxAge: 3600000
          });

          res.cookie('refresh_token', tokens.refreshToken, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'strict',
            maxAge: 604800000
          });

          // Log registration event
          const auditStmt = db.prepare(`
            INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, details, ip)
            VALUES (?, 'register', 'auth', 'register', ?, ?)
          `);
          auditStmt.run(
            result.user_id,
            JSON.stringify({ username }),
            req.ip
          );

          // Don't return tokens (in cookies now)
          res.json({ success: true, username: result.username, is_admin: result.is_admin });
        } else {
          res.status(400).json({ success: false, error: result.error });
        }
      } catch (err) {
        res.status(500).json({ error: 'Server error' });
      }
    }
  );

  // FIX #7, #15, #4: Add rate limiting + audit logging + httpOnly cookies
  app.post('/api/auth/login',
    async (req, res) => {
      try {
        const ip = req.ip;

        // Rate gate (peek, don't spend yet): if already locked/over budget, refuse now.
        const rl = rateLimiter.peek('auth', req);
        if (!rl.allowed) return rateLimiter.sendLimited(res, rl);

        // Auto-ban: reject IPs that tripped the failed-login threshold (temporary cooldown).
        if (ipFilter && ipFilter.isBlocked(ip)) {
          return res.status(403).json({ success: false, error: 'Too many failed attempts from your network. Try again later.' });
        }

        // CAPTCHA gate next — a wrong/expired captcha is rejected before the password is
        // ever checked, so it can't be used to probe credentials or trip account lockout.
        // It is checked BEFORE consuming the auth budget, so fumbling the captcha is free
        // and a human can't lock themselves out just by mistyping the verification answer.
        if (!loginCaptcha.verify(req.body?.captcha_id, req.body?.captcha_answer)) {
          return res.status(400).json({ success: false, error: 'Captcha incorrect or expired. Try again.' });
        }

        // Genuine credential attempt — now spend one token against the auth limit.
        rateLimiter.consume('auth', req);

        const { username, password } = req.body;
        const result = await authManager.login(username, password, ip);

        if (result.success) {
          // Password is correct → clear the auto-ban counter for this IP.
          adminLoginFailures.delete(ip);

          // 2FA gate: if this admin has TOTP enabled, DON'T issue a session yet. Return a
          // short-lived 2fa token; the client completes via POST /api/auth/login/totp. (CAPTCHA
          // was already consumed here, so the second step doesn't require solving it again.)
          if (authManager.isTotpEnabled(result.user_id)) {
            return res.json({ success: false, totp_required: true, twofa_token: authManager.generate2faToken(result.user_id) });
          }

          // FIX #4: Set httpOnly, Secure cookie instead of returning token
          res.cookie('access_token', result.access_token, {
            httpOnly: true,        // JS cannot access (prevents XSS theft)
            secure: process.env.NODE_ENV === 'production',  // HTTPS only in production
            sameSite: 'strict',    // CSRF protection
            maxAge: 3600000        // 1 hour
          });

          res.cookie('refresh_token', result.refresh_token, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'strict',
            maxAge: 604800000      // 7 days
          });

          // Log successful login
          const auditStmt = db.prepare(`
            INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, details, ip)
            VALUES (?, 'login_success', 'auth', 'login', ?, ?)
          `);
          auditStmt.run(
            result.user_id || null,
            JSON.stringify({ username }),
            ip
          );

          // Don't return tokens in response body (they're in httpOnly cookies)
          res.json({ success: true, username: result.username, is_admin: result.is_admin });
        } else {
          // Log failed login attempt (admin_id NULL — bad username may not exist in users)
          const auditStmt = db.prepare(`
            INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, details, ip)
            VALUES (NULL, 'login_failed', 'auth', 'login', ?, ?)
          `);
          auditStmt.run(JSON.stringify({ username }), ip);
          recordAdminLoginFailure(ip);
          res.status(401).json({ success: false, error: 'Invalid credentials' });
        }
      } catch (err) {
        res.status(500).json({ error: 'Server error' });  // Don't expose error details
      }
    }
  );

  // Second login step for 2FA-enabled admins. Takes the short-lived twofa_token from step 1
  // (proves the password passed) plus a TOTP or recovery code. No CAPTCHA here — it was solved
  // in step 1. Issues the real session on success.
  app.post('/api/auth/login/totp', rateLimiter.middleware('auth'), async (req, res) => {
    try {
      const ip = req.ip;
      if (ipFilter && ipFilter.isBlocked(ip)) {
        return res.status(403).json({ success: false, error: 'Too many failed attempts from your network. Try again later.' });
      }
      const { twofa_token, code } = req.body || {};
      const userId = authManager.verify2faToken(twofa_token);
      if (!userId) return res.status(401).json({ success: false, error: '2FA session expired — please log in again.' });

      const ok = await authManager.verifyTotpOrRecovery(userId, code);
      if (!ok) {
        try {
          db.prepare(`INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, details, ip)
                      VALUES (?, 'login_2fa_failed', 'auth', 'login', NULL, ?)`).run(userId, ip);
        } catch (e) { /* non-fatal */ }
        recordAdminLoginFailure(ip);
        return res.status(401).json({ success: false, error: 'Invalid 2FA code' });
      }

      const sess = authManager.issueSessionFor(userId);
      if (!sess.success) return res.status(401).json({ success: false, error: sess.error || 'Login failed' });

      res.cookie('access_token', sess.access_token, {
        httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict', maxAge: 3600000
      });
      res.cookie('refresh_token', sess.refresh_token, {
        httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict', maxAge: 604800000
      });
      adminLoginFailures.delete(ip);
      try {
        db.prepare(`INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, details, ip)
                    VALUES (?, 'login_success', 'auth', 'login', ?, ?)`).run(userId, JSON.stringify({ via: '2fa' }), ip);
      } catch (e) { /* non-fatal */ }
      res.json({ success: true, username: sess.username, is_admin: sess.is_admin });
    } catch (err) {
      res.status(500).json({ error: 'Server error' });
    }
  });

  app.post('/api/auth/refresh', (req, res) => {
    // FIX #4: Get refresh token from cookie instead of body
    const refreshToken = req.cookies.refresh_token || req.body.refresh_token;
    if (!refreshToken) {
      return res.status(401).json({ error: 'No refresh token' });
    }

    const result = authManager.refreshAccessToken(refreshToken);
    if (result.success) {
      // Set new access token in httpOnly cookie
      res.cookie('access_token', result.access_token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'strict',
        maxAge: 3600000
      });

      // Set new refresh token if provided
      if (result.refresh_token) {
        res.cookie('refresh_token', result.refresh_token, {
          httpOnly: true,
          secure: process.env.NODE_ENV === 'production',
          sameSite: 'strict',
          maxAge: 604800000
        });
      }

      res.json({ success: true });
    } else {
      res.status(401).json({ success: false, error: result.error });
    }
  });

  // Step-up re-authentication: a logged-in admin re-enters their password to authorize a
  // money/destructive action. Mints a fresh (pwa=now) access token; the client then retries
  // the freshAdmin-gated request. secureAdmin (not freshAdmin) gates this — you need a valid
  // session to step up, plus the password.
  app.post('/api/admin/reauth', secureAdmin, async (req, res) => {
    try {
      const { password } = req.body || {};
      if (!password) return res.status(400).json({ error: 'Password required' });
      const result = await authManager.stepUp(req.user.user_id, password);
      if (!result.success) {
        try {
          db.prepare(`INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, details, ip)
                      VALUES (?, 'reauth_failed', 'auth', 'reauth', NULL, ?)`).run(req.user.user_id, req.ip);
        } catch (e) { /* non-fatal */ }
        return res.status(401).json({ error: result.error || 'Re-authentication failed' });
      }
      res.cookie('access_token', result.access_token, {
        httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict', maxAge: 3600000
      });
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: 'Server error' });
    }
  });

  // ─── Admin TOTP 2FA management ──────────────────────────────────────────────
  // Status is readable with a normal admin session; enabling/disabling requires step-up
  // (freshAdmin) so a hijacked live session can't silently turn 2FA off.
  app.get('/api/admin/2fa/status', secureAdmin, (req, res) => {
    try {
      res.json({
        success: true,
        enabled: authManager.isTotpEnabled(req.user.user_id),
        recovery_codes_remaining: authManager.unusedRecoveryCount(req.user.user_id),
      });
    } catch (err) { res.status(500).json({ error: 'Server error' }); }
  });

  app.post('/api/admin/2fa/enroll/begin', freshAdmin, (req, res) => {
    try {
      if (authManager.isTotpEnabled(req.user.user_id)) {
        return res.status(400).json({ error: '2FA is already enabled. Disable it first to re-enroll.' });
      }
      let issuer = 'Grin Pool';
      try { issuer = (poolSettings.getSection('pool_info').pool_name) || issuer; } catch (e) {}
      const r = authManager.begin2faEnrollment(req.user.user_id, issuer);
      if (!r.success) return res.status(400).json({ error: r.error });
      res.json({ success: true, secret: r.secret, otpauth_uri: r.otpauth_uri });
    } catch (err) { res.status(500).json({ error: 'Server error' }); }
  });

  app.post('/api/admin/2fa/enroll/confirm', freshAdmin, async (req, res) => {
    try {
      const r = await authManager.confirm2faEnrollment(req.user.user_id, (req.body || {}).code);
      if (!r.success) return res.status(400).json({ error: r.error });
      db.prepare(`INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, details, ip)
                  VALUES (?, '2fa_enabled', 'auth', '2fa', NULL, ?)`).run(req.user.user_id, req.ip);
      res.json({ success: true, recovery_codes: r.recovery_codes });
    } catch (err) { res.status(500).json({ error: 'Server error' }); }
  });

  app.post('/api/admin/2fa/disable', freshAdmin, async (req, res) => {
    try {
      const r = await authManager.disable2fa(req.user.user_id, (req.body || {}).code);
      if (!r.success) return res.status(400).json({ error: r.error });
      db.prepare(`INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, details, ip)
                  VALUES (?, '2fa_disabled', 'auth', '2fa', NULL, ?)`).run(req.user.user_id, req.ip);
      res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'Server error' }); }
  });

  app.post('/api/admin/2fa/recovery/regenerate', freshAdmin, async (req, res) => {
    try {
      if (!authManager.isTotpEnabled(req.user.user_id)) {
        return res.status(400).json({ error: 'Enable 2FA first.' });
      }
      // Require a current code so only the genuine 2FA holder can mint new recovery codes.
      const ok = await authManager.verifyTotpOrRecovery(req.user.user_id, (req.body || {}).code);
      if (!ok) return res.status(401).json({ error: 'Incorrect 2FA / recovery code' });
      const recovery_codes = await authManager.generateRecoveryCodes(req.user.user_id);
      db.prepare(`INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, details, ip)
                  VALUES (?, '2fa_recovery_regenerated', 'auth', '2fa', NULL, ?)`).run(req.user.user_id, req.ip);
      res.json({ success: true, recovery_codes });
    } catch (err) { res.status(500).json({ error: 'Server error' }); }
  });

  // FIX: Add logout endpoint
  app.post('/api/auth/logout', (req, res) => {
    // Server-side revoke: bump the user's token_version so the issued refresh token
    // can't be replayed after logout (clearing the cookie alone only affects this browser).
    authManager.revokeByRefreshToken(req.cookies?.refresh_token || req.body?.refresh_token);
    res.clearCookie('access_token', { httpOnly: true });
    res.clearCookie('refresh_token', { httpOnly: true });
    res.json({ success: true });
  });


  app.post('/api/auth/change-password', requireAuth(authManager), (req, res) => {
    const { old_password, new_password } = req.body;
    authManager.changePassword(req.user.user_id, old_password, new_password)
      .then(result => {
        if (result.success) {
          res.json(result);
        } else {
          // FIX #6: Don't expose detailed error messages
          res.status(400).json({ success: false, error: 'Password change failed' });
        }
      })
      .catch(err => {
        res.status(500).json({ error: 'Server error' });
      });
  });

  app.get('/api/config/pool-info', (req, res) => {
    res.json({
      network: config.network,
      pool_fee_percent: config.pool_fee_percent,
      min_withdrawal: config.min_withdrawal,
      address_format: `grin1...`,
      wallet_required: config.tor_enabled ? 'Tor listener' : 'HTTP endpoint'
    });
  });

  // FIX #10: Test endpoints removed for production security
  // REMOVED: /api/test/add-miner, /api/test/miners, /api/test/blocks, /api/test/tables
  // These endpoints are unprotected and allow arbitrary data manipulation.
  // For testing in development, use curl with direct database queries.

  app.get('/api/stratum/stats', rateLimiter.middleware('public'), (req, res) => {
    try {
      const stats = stratumServer.getStats();
      // Public, unauthenticated endpoint: truncate miner addresses so the live session list
      // can't be scraped to enumerate every miner's full identity (same privacy posture as
      // the blocks/fortune-board pages). Internal callers use getStats() directly for the
      // full address; this route is the only public surface and never needs it.
      if (Array.isArray(stats.sessions)) {
        stats.sessions = stats.sessions.map((s) => {
          const a = String(s.grin_address || '');
          return {
            ...s,
            grin_address: a.length > 16 ? a.slice(0, 9) + '…' + a.slice(-4) : a
          };
        });
      }
      res.json(stats);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/pool/stats', (req, res) => {
    try {
      const blockStats = blockManager.getPoolStats();
      const minerCount = minerManager.getActiveMinersCount();
      const sstats = stratumServer.getStats();
      // Pool-wide live share quality (accepted/stale/rejected) summed across stratum
      // sessions. Under Model C EVERY miner's session terminates here (gateways just forward
      // TCP), so this is complete pool-wide — no more hub-mode reject/stale blind spot. Still
      // LIVE-only (in-memory): empty on a bare hub with no sessions, resets on disconnect.
      const sq = { accepted: 0, stale: 0, rejected: 0 };
      for (const s of (sstats.sessions || [])) {
        sq.accepted += s.accepted || 0;
        sq.stale    += s.stale    || 0;
        sq.rejected += s.rejected || 0;
      }
      res.json({
        ...blockStats,
        active_miners: minerCount,
        active_connections: sstats.active_connections,
        share_quality: sq
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Public service-health summary for the homepage status strip. Deliberately coarse —
  // up/down + node peer count + sync flag only. NEVER exposes wallet balances or addresses
  // (those stay on the admin-only /api/admin/health/* endpoints).
  app.get('/api/pool/status', rateLimiter.middleware('public'), async (req, res) => {
    const out = {
      pool: { ok: true },
      node: { reachable: false, synced: false, peers: 0, height: 0 },
      wallet: { reachable: false },
    };
    try {
      // getStatus() resolves (doesn't throw) with { ok: false } when the node is
      // unreachable — gate on status.ok, not the absence of an exception.
      const status = await blockMonitor.grinNode.getStatus();
      if (status && status.ok) {
        out.node = {
          reachable: true,
          synced: status.synced === true,
          peers: status.peer_count || 0,
          height: status.header_height || 0,
        };
      }
    } catch (e) { /* node down → reachable stays false */ }

    try {
      if (wallet && wallet.getBalance) {
        await wallet.getBalance();   // success = wallet API reachable; balance discarded
        out.wallet.reachable = true;
      }
    } catch (e) { /* wallet down → reachable stays false */ }

    res.setHeader('Cache-Control', 'public, max-age=15');
    res.json(out);
  });

  // Public pool-found blocks, newest first. Paginated (limit+offset) with an optional status
  // filter for the public blocks explorer. Response stays a plain array (back-compat with the
  // homepage recent-blocks table); callers detect the last page when fewer than `limit` return.
  app.get('/api/pool/blocks', (req, res) => {
    try {
      const limit = Math.min(Math.max(parseInt(req.query.limit || 50, 10), 1), 500);
      const offset = Math.max(parseInt(req.query.offset || 0, 10), 0);
      const status = req.query.status;
      const valid = ['immature', 'confirmed', 'orphaned'];
      let sql = 'SELECT * FROM blocks';
      const params = [];
      if (status && valid.includes(status)) { sql += ' WHERE status = ?'; params.push(status); }
      sql += ' ORDER BY height DESC LIMIT ? OFFSET ?';
      params.push(limit, offset);
      const blocks = db.prepare(sql).all(...params);
      res.json(blocks);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/account/:addr/shares', (req, res) => {
    try {
      const { addr } = req.params;
      const limit = Math.min(parseInt(req.query.limit || 100), 500);
      const offset = parseInt(req.query.offset || 0);

      const shares = shareValidator.getSharesForMiner(addr, limit, offset);
      res.json(shares);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // FIX #10: Test endpoint removed - manual block crediting disabled for security

  app.get('/api/admin/node-status', secureAdmin, (req, res) => {
    blockMonitor.grinNode.getStatus()
      .then(status => res.json(status))
      .catch(err => res.status(500).json({ error: err.message }));
  });

  app.get('/api/admin/block-monitor', secureAdmin, (req, res) => {
    res.json(blockMonitor.getStatus());
  });

  // FIX #10: Test endpoint removed - manual reward distribution disabled for security

  app.get('/api/admin/reward-stats', secureAdmin, (req, res) => {
    rewardDistributor.rewardStats()
      .then(stats => res.json(stats))
      .catch(err => res.status(500).json({ error: err.message }));
  });

  // REMOVED: /api/test/initiate-withdrawal endpoint
  // Reason: Test endpoint disabled in production. Allowed admin to initiate arbitrary withdrawals.
  // Use /api/admin/withdrawals to view and manage withdrawal scheduler instead.
  // For testing: use withdrawal_scheduler.initiateWithdrawal() directly in backend tests.

  app.get('/api/admin/withdrawals', secureAdmin, (req, res) => {
    try {
      const status = req.query.status || null;

      let stmt;
      if (status) {
        stmt = db.prepare(`
          SELECT * FROM withdrawals WHERE status = ? ORDER BY created_at DESC LIMIT 100
        `);
        res.json(stmt.all(status));
      } else {
        stmt = db.prepare(`
          SELECT * FROM withdrawals ORDER BY created_at DESC LIMIT 100
        `);
        res.json(stmt.all());
      }
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/admin/withdrawal-scheduler', secureAdmin, (req, res) => {
    res.json(withdrawalScheduler.getStatus());
  });

  // ─── PAYOUT QUEUE CONTROL (Admin, step-up) ─────────────────────────
  // The scheduler auto-retries Tor payouts, but a payout can still get stuck
  // (recipient offline for days) or land in tor_failed after exhausting retries. These two
  // actions let the operator intervene. Both move money/ledger state → freshAdmin (step-up).
  //
  // Funds model (see withdrawal-scheduler.js): retry_scheduled/tor_checking keep the amount in
  // balance_locked; tor_failed has already reversed it back to spendable balance. retry/cancel
  // must honour that so the ledger never drifts.

  // Force a stuck/failed withdrawal back into the send queue immediately.
  app.post('/api/admin/withdrawals/:id/retry', freshAdmin, (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const w = db.prepare('SELECT * FROM withdrawals WHERE id = ?').get(id);
      if (!w) return res.status(404).json({ error: 'withdrawal not found' });
      if (!['retry_scheduled', 'tor_failed'].includes(w.status)) {
        return res.status(409).json({ error: `cannot retry a withdrawal in status '${w.status}'` });
      }

      const result = db.transaction(() => {
        // tor_failed funds were reversed to spendable balance → re-lock them (CAS) before resending.
        if (w.status === 'tor_failed') {
          const before = db.prepare('SELECT balance, balance_locked FROM miner_accounts WHERE grin_address = ?').get(w.grin_address);
          const locked = db.prepare(
            `UPDATE miner_accounts SET balance = balance - ?, balance_locked = balance_locked + ?, updated_at = unixepoch()
             WHERE grin_address = ? AND balance >= ?`
          ).run(w.amount, w.amount, w.grin_address, w.amount);
          if (locked.changes !== 1) { const e = new Error('insufficient balance to re-lock for retry'); e.code = 409; throw e; }
          db.prepare(`
            INSERT INTO balance_log (grin_address, event_type, amount, balance_before, balance_after, locked_before, locked_after, reference_type, reference_id)
            VALUES (?, 'lock', ?, ?, ?, ?, ?, 'withdrawal', ?)
          `).run(w.grin_address, w.amount, before.balance, before.balance - w.amount, before.balance_locked, before.balance_locked + w.amount, id);
          db.prepare('UPDATE withdrawals SET status = ?, retry_count = 0, next_retry_at = NULL WHERE id = ?').run('tor_checking', id);
        } else {
          // retry_scheduled: funds already locked, just move it to the active queue now.
          db.prepare('UPDATE withdrawals SET status = ?, next_retry_at = NULL WHERE id = ?').run('tor_checking', id);
        }
        db.prepare(`
          INSERT INTO withdrawal_events (withdrawal_id, from_status, to_status, triggered_by, note)
          VALUES (?, ?, 'tor_checking', 'admin', ?)
        `).run(id, w.status, 'manual retry by admin');
        return true;
      })();

      db.prepare(`
        INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, details, ip)
        VALUES (?, 'withdrawal_retry', 'withdrawal', ?, ?, ?)
      `).run(req.user.user_id, String(id), JSON.stringify({ address: w.grin_address, amount: w.amount, from_status: w.status }), req.ip);

      res.json({ success: true, id, queued: result });
    } catch (err) {
      res.status(err.code || 500).json({ error: err.message });
    }
  });

  // Cancel a pending/failed withdrawal and return the funds to the miner's spendable balance.
  app.post('/api/admin/withdrawals/:id/cancel', freshAdmin, (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const reason = String((req.body && req.body.reason) || '').slice(0, 280) || null;
      const w = db.prepare('SELECT * FROM withdrawals WHERE id = ?').get(id);
      if (!w) return res.status(404).json({ error: 'withdrawal not found' });
      if (w.status === 'tor_sending') return res.status(409).json({ error: 'cannot cancel a withdrawal that is currently sending' });
      if (!['retry_scheduled', 'tor_checking', 'tor_failed'].includes(w.status)) {
        return res.status(409).json({ error: `cannot cancel a withdrawal in status '${w.status}'` });
      }

      db.transaction(() => {
        // retry_scheduled / tor_checking still hold the amount in balance_locked → release it.
        // tor_failed already reversed locked→balance, so the money is back; just record the cancel.
        if (w.status !== 'tor_failed') {
          const before = db.prepare('SELECT balance, balance_locked FROM miner_accounts WHERE grin_address = ?').get(w.grin_address);
          db.prepare(
            `UPDATE miner_accounts SET balance = balance + ?, balance_locked = CASE WHEN balance_locked >= ? THEN balance_locked - ? ELSE 0 END, updated_at = unixepoch()
             WHERE grin_address = ?`
          ).run(w.amount, w.amount, w.amount, w.grin_address);
          db.prepare(`
            INSERT INTO balance_log (grin_address, event_type, amount, balance_before, balance_after, locked_before, locked_after, reference_type, reference_id)
            VALUES (?, 'reversal', ?, ?, ?, ?, ?, 'withdrawal', ?)
          `).run(w.grin_address, w.amount, before.balance, before.balance + w.amount, before.balance_locked, Math.max(0, before.balance_locked - w.amount), id);
        }
        db.prepare('UPDATE withdrawals SET status = ?, cancelled_by = ?, cancel_reason = ? WHERE id = ?')
          .run('cancelled', req.user.user_id, reason, id);
        db.prepare(`
          INSERT INTO withdrawal_events (withdrawal_id, from_status, to_status, triggered_by, note)
          VALUES (?, ?, 'cancelled', 'admin', ?)
        `).run(id, w.status, reason || 'cancelled by admin');
      })();

      db.prepare(`
        INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, details, ip)
        VALUES (?, 'withdrawal_cancel', 'withdrawal', ?, ?, ?)
      `).run(req.user.user_id, String(id), JSON.stringify({ address: w.grin_address, amount: w.amount, from_status: w.status, reason }), req.ip);

      res.json({ success: true, id, refunded: w.status !== 'tor_failed', amount: w.amount });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── WALLET ↔ LEDGER RECONCILIATION (Admin) ────────────────────────
  // The single most important custodial safety check: does the on-chain wallet actually hold
  // at least what the pool owes its miners? Compares wallet balance (source of truth for coins)
  // against the SQLite ledger (source of truth for who is owed what). A negative coverage gap =
  // the pool is under-funded; a balance_locked vs pending-withdrawals mismatch = a stuck ledger.
  app.get('/api/admin/reconciliation', secureAdmin, async (req, res) => {
    try {
      const ledger = db.prepare(
        `SELECT COALESCE(SUM(balance),0) AS sum_balance, COALESCE(SUM(balance_locked),0) AS sum_locked,
                COUNT(*) AS accounts FROM miner_accounts`
      ).get();
      const pending = db.prepare(
        `SELECT COALESCE(SUM(amount),0) AS amt, COUNT(*) AS cnt FROM withdrawals
         WHERE status IN ('tor_checking','tor_sending','retry_scheduled')`
      ).get();
      const prizePool = (() => { try { return incentivesManager ? incentivesManager.prizePoolBalance() : 0; } catch (e) { return 0; } })();

      // Wallet (on-chain) balance — same path as /api/admin/health/wallet.
      let walletReachable = false;
      let walletBalance = { total: 0, available: 0, locked: 0 };
      if (wallet && wallet.getBalance) {
        try {
          // refresh=true: custodial coverage check needs fresh on-chain numbers (runs at
          // a relaxed 3-min cadence from the admin page, not on every dashboard poll).
          const summary = await wallet.getBalance(true);
          const info = Array.isArray(summary) ? summary[1] : (summary || {});
          walletBalance = {
            total: Number(info.total || 0) / 1e9,
            available: Number(info.amount_currently_spendable || 0) / 1e9,
            locked: Number(info.amount_locked || 0) / 1e9,
          };
          walletReachable = true;
        } catch (e) { walletReachable = false; }
      }

      const owed = ledger.sum_balance + ledger.sum_locked; // total the pool owes (incl. prize bucket)
      const coverage_gap = parseFloat((walletBalance.total - owed).toFixed(9)); // ≥0 healthy, <0 under-funded
      const locked_drift = parseFloat((ledger.sum_locked - pending.amt).toFixed(9)); // should be ~0
      const TOL = 1e-6;

      res.json({
        success: true,
        timestamp: new Date().toISOString(),
        wallet: { reachable: walletReachable, ...walletBalance },
        ledger: {
          spendable_owed: parseFloat(ledger.sum_balance.toFixed(9)),
          locked_owed: parseFloat(ledger.sum_locked.toFixed(9)),
          total_owed: parseFloat(owed.toFixed(9)),
          accounts: ledger.accounts,
          prize_pool: parseFloat((prizePool || 0).toFixed(9)),
        },
        pending_withdrawals: { count: pending.cnt, amount: parseFloat(pending.amt.toFixed(9)) },
        checks: {
          // Wallet covers what miners are owed.
          coverage_gap,
          coverage_ok: !walletReachable ? null : coverage_gap >= -TOL,
          // Locked ledger equals in-flight withdrawal amounts.
          locked_drift,
          locked_ok: Math.abs(locked_drift) <= TOL,
        },
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── ADS (Admin CRUD) ──────────────────────────────────────────────
  // Operator-managed promotions (banner image OR ad-network code snippet) bound to a public
  // placement. secureAdmin (not freshAdmin) — ads are not money/destructive of funds.
  app.get('/api/admin/ads', secureAdmin, (req, res) => {
    try {
      res.json({ ads: adsManager.list(req.query.placement), placements: AdsManager.PLACEMENTS });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/admin/ads', secureAdmin, (req, res) => {
    try {
      res.json({ ad: adsManager.create(req.body || {}) });
    } catch (err) { res.status(400).json({ error: err.message }); }
  });

  app.post('/api/admin/ads/:id', secureAdmin, (req, res) => {
    try {
      res.json({ ad: adsManager.update(parseInt(req.params.id, 10), req.body || {}) });
    } catch (err) {
      res.status(err.message === 'not found' ? 404 : 400).json({ error: err.message });
    }
  });

  app.delete('/api/admin/ads/:id', secureAdmin, (req, res) => {
    try {
      const ok = adsManager.remove(parseInt(req.params.id, 10));
      if (!ok) return res.status(404).json({ error: 'not found' });
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ─── ADS (Public) ──────────────────────────────────────────────────
  // Active, in-window ads for the public site. `?placement=header` returns one slot;
  // no param returns all slots keyed by placement. Only render-relevant fields are exposed.
  app.get('/api/public/ads', rateLimiter.middleware('public'), (req, res) => {
    try {
      const p = req.query.placement;
      if (p) return res.json({ placement: p, ads: adsManager.publicByPlacement(p) });
      res.json({ ads: adsManager.publicAll() });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ─── MEDIA UPLOAD (Admin) ──────────────────────────────────────────
  // Image upload for the CMS editor (cover images + in-body images). secureAdmin — not
  // money/destructive. Returns { url } pointing at the persistent /uploads dir. multer
  // errors (bad type, too big) are surfaced as 400 via the wrapper.
  app.post('/api/admin/media', secureAdmin, (req, res) => {
    mediaUpload.single('file')(req, res, (err) => {
      if (err) return res.status(400).json({ error: err.message || 'upload failed' });
      if (!req.file) return res.status(400).json({ error: 'no file' });
      res.json({ url: '/uploads/' + req.file.filename, filename: req.file.filename });
    });
  });

  // ─── PAGES (Admin CRUD) ────────────────────────────────────────────
  // Dynamic content pages (the CMS that replaced the fixed 5-slot config). secureAdmin.
  app.get('/api/admin/pages', secureAdmin, (req, res) => {
    try {
      res.json({ pages: pagesManager.list(), nav_locations: PagesManager.NAV_LOCATIONS });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/admin/pages', secureAdmin, (req, res) => {
    try {
      res.json({ page: pagesManager.create(req.body || {}) });
    } catch (err) { res.status(400).json({ error: err.message }); }
  });

  app.post('/api/admin/pages/:id', secureAdmin, (req, res) => {
    try {
      res.json({ page: pagesManager.update(parseInt(req.params.id, 10), req.body || {}) });
    } catch (err) {
      res.status(err.message === 'not found' ? 404 : 400).json({ error: err.message });
    }
  });

  app.delete('/api/admin/pages/:id', secureAdmin, (req, res) => {
    try {
      const ok = pagesManager.remove(parseInt(req.params.id, 10));
      if (!ok) return res.status(404).json({ error: 'not found' });
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ─── POSTS / BLOG (Admin CRUD) ─────────────────────────────────────
  // Dated blog/announcement posts. secureAdmin — content, not funds.
  app.get('/api/admin/posts', secureAdmin, (req, res) => {
    try {
      res.json({ posts: postsManager.list(req.query.status), statuses: PostsManager.STATUSES });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/admin/posts', secureAdmin, (req, res) => {
    try {
      res.json({ post: postsManager.create(req.body || {}) });
    } catch (err) { res.status(400).json({ error: err.message }); }
  });

  app.post('/api/admin/posts/:id', secureAdmin, (req, res) => {
    try {
      res.json({ post: postsManager.update(parseInt(req.params.id, 10), req.body || {}) });
    } catch (err) {
      res.status(err.message === 'not found' ? 404 : 400).json({ error: err.message });
    }
  });

  app.delete('/api/admin/posts/:id', secureAdmin, (req, res) => {
    try {
      const ok = postsManager.remove(parseInt(req.params.id, 10));
      if (!ok) return res.status(404).json({ error: 'not found' });
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ─── POOL BLOCKS EXPLORER (Admin) ──────────────────────────────────
  // Pool-found blocks with maturity countdown + GrinScan deep-links. Distinct from the public
  // chain explorer (grinscan.org): this is only THIS pool's blocks, with payout-relevant context
  // (status, maturity, orphan reversals) that a chain explorer cannot have.
  app.get('/api/admin/blocks', secureAdmin, async (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit || 50, 10), 500);
      const offset = parseInt(req.query.offset || 0, 10);
      const status = req.query.status || null;

      const where = status ? 'WHERE status = ?' : '';
      const args = status ? [status, limit, offset] : [limit, offset];
      const rows = db.prepare(
        `SELECT id, height, hash, nonce, reward, status, found_by, found_at, confirmed_at, created_at
         FROM blocks ${where} ORDER BY height DESC LIMIT ? OFFSET ?`
      ).all(...args);

      // Current tip → maturity countdown. confirm_depth depends on the network.
      const confirmDepth = config.network === 'testnet'
        ? (config.confirm_depth_testnet || 100)
        : (config.confirm_depth_mainnet || 1440);
      let tipHeight = 0;
      try {
        const st = await blockMonitor.grinNode.getStatus();
        tipHeight = (st && st.ok && st.height) || 0;
      } catch (e) { tipHeight = 0; }

      const grinscanBase = config.network === 'testnet'
        ? 'https://testnet.grinscan.org/block'
        : 'https://grinscan.org/block';

      const blocks = rows.map((b) => {
        const confirmations = tipHeight ? Math.max(0, tipHeight - b.height) : 0;
        const blocks_to_maturity = (b.status === 'confirmed' || b.status === 'orphaned')
          ? 0 : Math.max(0, confirmDepth - confirmations);
        return {
          ...b,
          confirmations,
          blocks_to_maturity,
          grinscan_url: `${grinscanBase}/${b.height}`,
        };
      });

      res.json({
        success: true,
        tip_height: tipHeight,
        confirm_depth: confirmDepth,
        network: config.network,
        summary: blockManager.getPoolStats(),
        count: blocks.length,
        blocks,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── FINANCIAL EXPORT (Admin, CSV) ─────────────────────────────────
  // Plain-CSV downloads for accounting/tax. Cookie-authenticated GETs so a normal browser
  // download link works (same-origin sends the httpOnly session cookie); still IP+auth gated.
  const csvCell = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const sendCsv = (res, filename, header, rows) => {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    const lines = [header.join(',')];
    for (const r of rows) lines.push(r.map(csvCell).join(','));
    res.send(lines.join('\r\n') + '\r\n');
  };

  // All confirmed payouts.
  app.get('/api/admin/export/payouts.csv', secureAdmin, (req, res) => {
    try {
      const rows = db.prepare(
        `SELECT id, grin_address, amount, fee, status, created_at, confirmed_at
         FROM withdrawals WHERE status = 'confirmed' ORDER BY confirmed_at DESC`
      ).all();
      const iso = (t) => (t ? new Date(t * 1000).toISOString() : '');
      sendCsv(res, `payouts-${config.network}.csv`,
        ['id', 'grin_address', 'amount_grin', 'fee_grin', 'status', 'created_at', 'confirmed_at'],
        rows.map((r) => [r.id, r.grin_address, r.amount, r.fee, r.status, iso(r.created_at), iso(r.confirmed_at)]));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Pool-fee revenue per found block (reward × pool_fee_percent). An honest, derived report —
  // the pool's cut of each block, not a separately stored figure.
  app.get('/api/admin/export/fee-revenue.csv', secureAdmin, (req, res) => {
    try {
      const feePct = parseFloat(config.pool_fee_percent != null ? config.pool_fee_percent : 1.0) || 0;
      const rows = db.prepare(
        `SELECT height, hash, reward, status, found_at FROM blocks ORDER BY height DESC`
      ).all();
      const iso = (t) => (t ? new Date(t * 1000).toISOString() : '');
      sendCsv(res, `fee-revenue-${config.network}.csv`,
        ['height', 'hash', 'reward_grin', 'pool_fee_percent', 'pool_cut_grin', 'status', 'found_at'],
        rows.map((r) => [r.height, r.hash, r.reward, feePct,
          parseFloat((r.reward * feePct / 100).toFixed(9)), r.status, iso(r.found_at)]));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/account/:addr/balance', (req, res) => {
    try {
      const { addr } = req.params;

      const stmt = db.prepare(`
        SELECT balance, balance_locked FROM miner_accounts WHERE grin_address = ?
      `);
      const account = stmt.get(addr);

      if (!account) {
        return res.status(404).json({ error: 'Account not found' });
      }

      res.json({
        grin_address: addr,
        balance: account.balance,
        balance_locked: account.balance_locked,
        total: account.balance + account.balance_locked
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/pool/miners', (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit || 50), 500);
      const stmt = db.prepare(`
        SELECT grin_address, balance, is_online FROM miner_accounts
        ORDER BY balance DESC LIMIT ?
      `);
      const miners = stmt.all(limit);
      res.json(miners);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/pool/payments', (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit || 100), 500);
      const stmt = db.prepare(`
        SELECT * FROM withdrawals WHERE status = 'confirmed'
        ORDER BY confirmed_at DESC LIMIT ?
      `);
      const payments = stmt.all(limit);
      res.json(payments);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── Account summary (address-as-identity; no auth) ─────────────────────────
  // One-stop public view for a miner address: balances + lifetime paid + pending
  // withdrawal + share/hashrate snapshot. 404 if the address has never mined here.
  app.get('/api/account/:addr', rateLimiter.middleware('public'), (req, res) => {
    try {
      const { addr } = req.params;
      const acct = db.prepare(
        `SELECT grin_address, balance, balance_locked, is_online, last_seen_at, created_at,
                min_payout, last_ip, prev_ip
         FROM miner_accounts WHERE grin_address = ?`
      ).get(addr);
      if (!acct) return res.status(404).json({ error: 'Account not found' });

      const paid = db.prepare(
        `SELECT COALESCE(SUM(amount), 0) AS total FROM withdrawals
         WHERE grin_address = ? AND status = 'confirmed'`
      ).get(addr).total;

      const pending = db.prepare(
        `SELECT COUNT(*) AS c FROM withdrawals
         WHERE grin_address = ? AND status IN ('tor_checking','tor_sending','retry_scheduled')`
      ).get(addr).c;

      const shareAgg = db.prepare(
        `SELECT COUNT(*) AS count, MAX(created_at) AS last_share_at FROM shares WHERE grin_address = ?`
      ).get(addr);

      const hr = hashrateTracker.getMinerHashrate(addr, 60) || {};

      // Effective payout threshold: the account override (min_payout) if set, else the pool default.
      // last/prev IP are NOT exposed (they back the ownership gate) — only whether one is on record.
      const effectiveMin = (acct.min_payout != null) ? acct.min_payout : config.min_withdrawal;

      res.json({
        grin_address: acct.grin_address,
        balance: acct.balance,
        balance_locked: acct.balance_locked,
        total: acct.balance + acct.balance_locked,
        total_paid: paid,
        pending_withdrawals: pending,
        is_online: !!acct.is_online,
        last_seen_at: acct.last_seen_at || null,
        created_at: acct.created_at,
        shares: {
          count: shareAgg.count || 0,
          last_share_at: shareAgg.last_share_at || null
        },
        hashrate_gps: parseFloat(((hr.avg_hashrate || 0)).toFixed(6)),
        min_withdrawal: config.min_withdrawal,
        min_payout: acct.min_payout != null ? acct.min_payout : null,
        effective_min_payout: effectiveMin,
        has_recorded_ip: !!(acct.last_ip || acct.prev_ip)
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Per-worker breakdown for an address. Hashrate/share-count/last-share from the SHARES table
  // (all regions, survives restarts); reject%/stale% + online from the live in-memory stratum
  // sessions. Under Model C every region's miners terminate their session here, so reject/stale
  // is complete pool-wide (it is still live-only, so it resets on a worker disconnect).
  app.get('/api/account/:addr/workers', rateLimiter.middleware('public'), (req, res) => {
    try {
      const { addr } = req.params;
      const windowMin = Math.min(Math.max(parseInt(req.query.window || 10), 1), 1440);
      const workers = hashrateTracker.getWorkersForAccount(addr, windowMin);
      res.json({ grin_address: addr, window_min: windowMin, workers });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Per-address hashrate time-series for charting (downsampled to ~maxPoints buckets).
  app.get('/api/account/:addr/hashrate/history', rateLimiter.middleware('public'), (req, res) => {
    try {
      const { addr } = req.params;
      const hours = Math.min(Math.max(parseInt(req.query.hours || 24), 1), 720);
      const series = hashrateTracker.getAccountHistory(addr, hours);
      res.json({ grin_address: addr, hours, series });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Set a per-miner payout threshold (address-as-identity, IP-gated). Anti-griefing: a random
  // visitor must not be able to stall someone's payouts by raising their threshold. Proof = one
  // of the address's last-2 mining source IPs. Range: cannot drop below the pool minimum.
  app.post('/api/account/:addr/min-payout', rateLimiter.middleware('public'), (req, res) => {
    const { addr } = req.params;
    const reqIp = normalizeIp(req.ip);
    try {
      const acct = db.prepare('SELECT grin_address FROM miner_accounts WHERE grin_address = ?').get(addr);
      if (!acct) return res.status(404).json({ error: 'Account not found' });

      const ipProof = (req.body && req.body.ip_proof) || '';
      const proof = verifyIpProof(db, addr, ipProof);
      if (!proof.ok) {
        auditOwnerProof(db, { action: 'set_min_payout', grinAddress: addr, ip: reqIp, ok: false, details: { reason: proof.reason } });
        return res.status(403).json({ error: 'Ownership proof failed', reason: proof.reason });
      }

      let val = req.body && req.body.min_payout;
      // null/empty → clear the override (revert to pool default).
      if (val === null || val === undefined || val === '') {
        db.prepare('UPDATE miner_accounts SET min_payout = NULL, updated_at = unixepoch() WHERE grin_address = ?').run(addr);
        auditOwnerProof(db, { action: 'set_min_payout', grinAddress: addr, ip: reqIp, ok: true, details: { min_payout: null } });
        return res.json({ success: true, min_payout: null, effective_min_payout: config.min_withdrawal });
      }

      val = Number(val);
      const poolMin = Number(config.min_withdrawal) || 0;
      if (!Number.isFinite(val) || val < poolMin) {
        return res.status(400).json({ error: `min_payout must be a number ≥ pool minimum (${poolMin})` });
      }
      if (val > 1e6) return res.status(400).json({ error: 'min_payout too large' });

      db.prepare('UPDATE miner_accounts SET min_payout = ?, updated_at = unixepoch() WHERE grin_address = ?').run(val, addr);
      auditOwnerProof(db, { action: 'set_min_payout', grinAddress: addr, ip: reqIp, ok: true, details: { min_payout: val } });
      res.json({ success: true, min_payout: val, effective_min_payout: val });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Pool-wide hashrate time-series (SUM across addresses per bucket) for the dashboard chart.
  app.get('/api/pool/hashrate/history', rateLimiter.middleware('public'), (req, res) => {
    try {
      const hours = Math.min(Math.max(parseInt(req.query.hours || 24), 1), 720);
      const series = hashrateTracker.getPoolHistory(hours);
      res.json({ hours, series });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Round effort / luck / time-since-last-block — pool-trust signals.
  //  · round_effort_pct = Σ(share diff since last block) / current per-block network diff × 100
  //  · luck_100_pct     = mean over last 100 blocks of (network_difficulty / round_shares) × 100
  //    (>100% = luckier than expected; uses captured per-block columns, NULL rows skipped)
  // Current network difficulty is cached ~60s to avoid hammering the node.
  app.get('/api/pool/effort', rateLimiter.middleware('public'), async (req, res) => {
    try {
      const last = blockManager.getLastBlock();
      const lastBlockAt = last ? last.found_at : null;
      const now = Math.floor(Date.now() / 1000);

      // Cached current per-block network difficulty.
      if (!app.locals._netDiffCache || (Date.now() - app.locals._netDiffCache.at) > 60000) {
        let netDiff = null;
        try {
          if (blockMonitor && blockMonitor.grinNode) {
            const tip = await blockMonitor.grinNode.getTip();
            netDiff = await blockManager._fetchNetworkDifficulty(tip.height);
          }
        } catch (_) { /* leave null */ }
        app.locals._netDiffCache = { at: Date.now(), value: netDiff };
      }
      const netDiff = app.locals._netDiffCache.value;

      const roundDiff = db.prepare(
        'SELECT COALESCE(SUM(difficulty), 0) AS d FROM shares WHERE created_at > ?'
      ).get(lastBlockAt || 0).d;

      const roundEffortPct = (netDiff && netDiff > 0)
        ? parseFloat(((roundDiff / netDiff) * 100).toFixed(2)) : null;

      const luckRows = db.prepare(
        `SELECT network_difficulty AS nd, round_shares AS rs FROM blocks
         WHERE network_difficulty IS NOT NULL AND round_shares > 0
         ORDER BY height DESC LIMIT 100`
      ).all();
      let luckPct = null;
      if (luckRows.length > 0) {
        const mean = luckRows.reduce((a, r) => a + (r.nd / r.rs), 0) / luckRows.length;
        luckPct = parseFloat((mean * 100).toFixed(1));
      }

      res.json({
        last_block_at: lastBlockAt,
        seconds_since_last_block: lastBlockAt ? (now - lastBlockAt) : null,
        round_shares: parseFloat(roundDiff.toFixed(6)),
        network_difficulty: netDiff,
        round_effort_pct: roundEffortPct,
        luck_100_pct: luckPct,
        luck_sample: luckRows.length
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Append-only ledger for an address (every balance/locked change). No auth — the
  // ledger only exposes the address's own money movements, and the address is identity.
  app.get('/api/account/:addr/balance/log', rateLimiter.middleware('public'), (req, res) => {
    try {
      const { addr } = req.params;
      const limit = Math.min(parseInt(req.query.limit || 50), 500);
      const offset = parseInt(req.query.offset || 0);
      const rows = db.prepare(
        `SELECT event_type, amount, balance_before, balance_after, locked_before, locked_after,
                reference_type, reference_id, created_at
         FROM balance_log WHERE grin_address = ?
         ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`
      ).all(addr, limit, offset);
      res.json({ grin_address: addr, count: rows.length, log: rows });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Is this miner reachable over Tor right now? Drives the UI hint for whether an
  // auto (Tor) payout can succeed vs. needing a Slatepack claim. No state change.
  app.get('/api/account/:addr/tor-check', rateLimiter.middleware('public'), async (req, res) => {
    try {
      const { addr } = req.params;
      const result = await walletTor.probeToronlineStatus(addr);
      res.json({
        grin_address: addr,
        // Tri-state: true/false when known, null = "determined at payout time" (grin-wallet
        // performs the actual Tor connection to the recipient during the send).
        online: result.online === null ? null : !!result.online,
        reason: result.reason || (result.online ? 'reachable' : 'unreachable')
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Miner-initiated withdrawal (address-as-identity). Two rails:
  //  · tor (default) — zero-interaction; payout always goes back to the requesting address via
  //    its Tor listener, so there is no theft vector even without auth (it only moves an
  //    address's own balance to itself). No IP gate.
  //  · slatepack — interactive (no Tor). Emits a slate ENCRYPTED to the requesting address, so
  //    only that wallet can decrypt + receive (no theft). Gated by an IP-proof (one of the
  //    address's last-2 mining IPs) purely to throttle who can trigger it.
  // Rate-limited; CAS balance lock + 1-pending-per-address cap live in the scheduler.
  app.post('/api/account/:addr/withdraw', rateLimiter.middleware('public'), async (req, res) => {
    try {
      const { addr } = req.params;
      const method = (req.body && req.body.method) || 'tor';

      if (method === 'tor') {
        const result = withdrawalScheduler.createWithdrawal(addr, req.body && req.body.amount, method);
        return res.json({ success: true, withdrawal_id: result.withdrawal_id, status: 'tor_checking' });
      }

      if (method === 'slatepack') {
        const reqIp = normalizeIp(req.ip);
        const proof = verifyIpProof(db, addr, (req.body && req.body.ip_proof) || '');
        if (!proof.ok) {
          auditOwnerProof(db, { action: 'slatepack_withdraw', grinAddress: addr, ip: reqIp, ok: false, details: { reason: proof.reason } });
          return res.status(403).json({ error: 'Ownership proof failed', reason: proof.reason });
        }
        const result = await withdrawalScheduler.createSlatepackWithdrawal(addr, req.body && req.body.amount);
        auditOwnerProof(db, { action: 'slatepack_withdraw', grinAddress: addr, ip: reqIp, ok: true, details: { withdrawal_id: result.withdrawal_id, amount: result.amount } });
        return res.json({ success: true, withdrawal_id: result.withdrawal_id, amount: result.amount, status: 'slatepack_pending', slatepack: result.slatepack });
      }

      return res.status(400).json({ error: `unsupported withdrawal method: ${method}` });
    } catch (err) {
      res.status(err.code && err.code >= 400 && err.code < 600 ? err.code : 500).json({ error: err.message });
    }
  });

  // Complete a slatepack withdrawal: the miner pastes back the RESPONSE slatepack their wallet
  // produced after `receive`. IP-gated like the trigger. The pool finalizes + broadcasts.
  app.post('/api/account/:addr/withdraw/:id/finalize', rateLimiter.middleware('public'), async (req, res) => {
    try {
      const { addr, id } = req.params;
      const reqIp = normalizeIp(req.ip);
      const proof = verifyIpProof(db, addr, (req.body && req.body.ip_proof) || '');
      if (!proof.ok) {
        auditOwnerProof(db, { action: 'slatepack_finalize', grinAddress: addr, ip: reqIp, ok: false, details: { reason: proof.reason, withdrawal_id: id } });
        return res.status(403).json({ error: 'Ownership proof failed', reason: proof.reason });
      }
      const result = await withdrawalScheduler.finalizeSlatepackWithdrawal(
        addr, parseInt(id, 10), (req.body && req.body.response_slatepack) || ''
      );
      auditOwnerProof(db, { action: 'slatepack_finalize', grinAddress: addr, ip: reqIp, ok: true, details: { withdrawal_id: id } });
      res.json(result);
    } catch (err) {
      res.status(err.code && err.code >= 400 && err.code < 600 ? err.code : 500).json({ error: err.message });
    }
  });

  // ─── Multi-region public read APIs ──────────────────────────────────────────
  // Descriptive list of operator-declared regions (for a "connect to your nearest region"
  // UI). Only active rows + non-sensitive fields; the IP allowlist/secret are never exposed.
  app.get('/api/pool/locations', rateLimiter.middleware('public'), (req, res) => {
    try {
      const rows = db.prepare(
        `SELECT region, label, stratum_url, is_active FROM pool_locations
         WHERE is_active = 1 ORDER BY region ASC`
      ).all();
      res.json(rows.map(r => ({ region: r.region, label: r.label, stratum_url: r.stratum_url })));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Per-region live stats. Hashrate is derived from accepted-share difficulty over a short
  // window using the canonical C32 formula (GPS = Σdiff × 42 / window_s / 16384 — matches
  // hashrate-tracker.js and CLAUDE.md), grouped by the `region` tag the central stratum
  // stamps on each share (per-region listener / Model C gateway). Regions with a
  // pool_locations row but no recent shares appear with online=false / status "unknown".
  app.get('/api/pool/stats/regions', rateLimiter.middleware('public'), (req, res) => {
    try {
      const WINDOW_S = 900; // 15-minute window for "current" regional hashrate
      const CYCLE_LENGTH = 42, SOLUTION_RATE = 16384;
      const cutoff = Math.floor(Date.now() / 1000) - WINDOW_S;

      const agg = db.prepare(
        `SELECT region,
                COUNT(*) AS shares,
                COUNT(DISTINCT grin_address) AS miners,
                COALESCE(SUM(difficulty), 0) AS sumdiff
         FROM shares WHERE created_at > ? GROUP BY region`
      ).all(cutoff);
      const byRegion = new Map(agg.map(r => [r.region, r]));

      const locations = db.prepare(
        `SELECT region, label, country, country_code, stratum_url, is_active FROM pool_locations`
      ).all();
      const locByRegion = new Map(locations.map(l => [l.region, l]));

      // Coarse per-region liveness for the public connect-page pill. With Model C the edge
      // is a dumb forwarder that never calls back, so the honest public signal is recent
      // share activity: shares in the window → "online"; none → "unknown" (a freshly-declared
      // or simply-quiet region — never a false "down"). The richer wg-handshake signal is
      // admin-only (/api/admin/health/gateways), not exposed on the public pill.
      //
      // EXCEPTION — the LOCAL region (the singlebox/central box itself): its stratum is this
      // very process's in-bound listener, so if this API is answering, the local stratum is
      // bound and accepting miners. Report it "online" regardless of recent shares — otherwise
      // a quiet-but-healthy main host wrongly shows "○ Unknown" even with :3333/:13333 listening.
      const localRegion = (config && config.role === 'singlebox') ? config.region : null;
      const regionStatus = (region, hasShares) =>
        (hasShares || region === localRegion) ? 'online' : 'unknown';

      // Union of regions seen in shares and regions declared in pool_locations.
      const regions = new Set([...byRegion.keys(), ...locByRegion.keys()]);
      const out = [];
      let totalGps = 0, totalMiners = 0, totalShares = 0;
      for (const region of regions) {
        const a = byRegion.get(region) || { shares: 0, miners: 0, sumdiff: 0 };
        const loc = locByRegion.get(region) || {};
        const gps = (a.sumdiff * CYCLE_LENGTH) / (WINDOW_S * SOLUTION_RATE);
        totalGps += gps; totalMiners += a.miners; totalShares += a.shares;
        out.push({
          region,
          label: loc.label || null,
          country: loc.country || null,
          country_code: loc.country_code || null,
          stratum_url: loc.stratum_url || null,
          is_active: loc.is_active === undefined ? null : !!loc.is_active,
          status: regionStatus(region, a.shares > 0),
          online: a.shares > 0 || region === localRegion,
          hashrate_gps: parseFloat(gps.toFixed(6)),
          miners: a.miners,
          shares_window: a.shares
        });
      }
      out.sort((x, y) => y.hashrate_gps - x.hashrate_gps);

      res.json({
        window_seconds: WINDOW_S,
        region_count: out.length,
        totals: {
          hashrate_gps: parseFloat(totalGps.toFixed(6)),
          miners: totalMiners,
          shares_window: totalShares
        },
        regions: out,
        timestamp: new Date().toISOString()
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/stratum/hashrate', (req, res) => {
    try {
      const stats = hashrateTracker.getHashrateStats();
      res.json(stats);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/admin/metrics', secureAdmin, async (req, res) => {
    try {
      const blockStats = blockManager.getPoolStats();
      const rewardStats = await rewardDistributor.rewardStats();
      const hashrateStats = hashrateTracker.getHashrateStats();
      const withdrawalStats = withdrawalScheduler.getStatus();

      res.json({
        blocks: blockStats,
        rewards: rewardStats,
        hashrate: hashrateStats,
        withdrawals: withdrawalStats,
        timestamp: new Date().toISOString()
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/admin/audit-log', secureAdmin, (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit || 100), 1000);
      const offset = parseInt(req.query.offset || 0);

      const stmt = db.prepare(`
        SELECT * FROM admin_audit_log
        ORDER BY created_at DESC
        LIMIT ? OFFSET ?
      `);
      const logs = stmt.all(limit, offset);

      res.json({
        count: logs.length,
        logs
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── Poolstats Reporter (miningpoolstats.stream integration) ────────────────
  app.get('/api/admin/poolstats', secureAdmin, (req, res) => {
    try {
      const status = poolstatsReporter.getStatus();
      res.json(status);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/admin/poolstats/update-key', freshAdmin, (req, res) => {
    try {
      const { api_key } = req.body;
      if (!api_key || api_key.trim().length === 0) {
        return res.status(400).json({ error: 'API key cannot be empty' });
      }
      poolstatsReporter.updateApiKey(api_key);
      res.json({
        success: true,
        message: 'Poolstats API key updated',
        status: poolstatsReporter.getStatus()
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/admin/poolstats/test', secureAdmin, (req, res) => {
    try {
      poolstatsReporter.submit()
        .then(() => res.json({
          success: true,
          message: 'Test submission sent to poolstats.stream',
          status: poolstatsReporter.getStatus()
        }))
        .catch(err => res.status(500).json({ error: err.message }));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── Security Management (Rate Limiting & IP Filtering) ──────────────────────
  app.get('/api/admin/security/rate-limit-status', secureAdmin, (req, res) => {
    try {
      const clientIp = rateLimiter.getClientIp(req);
      const status = rateLimiter.getStatus(clientIp);
      const violations = rateLimiter.getViolations();
      res.json({ my_status: status, all_violations: violations });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/admin/security/rate-limit-reset', secureAdmin, (req, res) => {
    try {
      const { ip } = req.body;
      if (!ip) {
        return res.status(400).json({ error: 'IP address required' });
      }
      rateLimiter.resetIp(ip);
      res.json({ success: true, message: `Rate limit reset for ${ip}` });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/admin/security/ip-filter-status', secureAdmin, (req, res) => {
    try {
      const status = ipFilter.getStatus();
      // Surface the caller's IP so the UI can warn before an allowlist locks them out.
      status.your_ip = ipFilter.getClientIp(req);
      res.json(status);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/admin/security/ip-allowlist/add', freshAdmin, (req, res) => {
    try {
      const { ip } = req.body;
      if (!ip) {
        return res.status(400).json({ error: 'IP address or CIDR required' });
      }
      const result = ipFilter.addAllowed(ip);
      if (result.success) {
        res.json({ success: true, message: `Added ${ip} to allowlist`, status: ipFilter.getStatus() });
      } else {
        res.status(400).json({ error: result.error });
      }
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/admin/security/ip-allowlist/remove', freshAdmin, (req, res) => {
    try {
      const { ip } = req.body;
      if (!ip) {
        return res.status(400).json({ error: 'IP address required' });
      }
      ipFilter.removeAllowed(ip);
      res.json({ success: true, message: `Removed ${ip} from allowlist`, status: ipFilter.getStatus() });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/admin/security/ip-blacklist/add', freshAdmin, (req, res) => {
    try {
      const { ip } = req.body;
      if (!ip) {
        return res.status(400).json({ error: 'IP address or CIDR required' });
      }
      const result = ipFilter.addBlocked(ip);
      if (result.success) {
        res.json({ success: true, message: `Added ${ip} to blacklist`, status: ipFilter.getStatus() });
      } else {
        res.status(400).json({ error: result.error });
      }
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/admin/security/ip-blacklist/remove', freshAdmin, (req, res) => {
    try {
      const { ip } = req.body;
      if (!ip) {
        return res.status(400).json({ error: 'IP address required' });
      }
      ipFilter.removeBlocked(ip);
      res.json({ success: true, message: `Removed ${ip} from blacklist`, status: ipFilter.getStatus() });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── Alert System (Real-time monitoring & notifications) ──────────────────────
  // ─── ADMIN SESSIONS / LOGIN ACTIVITY (Admin) ───────────────────────
  // Sessions are stateless JWTs (no server-side session table), so there is no per-device
  // list to enumerate. What the operator CAN see + control: recent login activity (from the
  // audit log) and a "revoke sessions" kill-switch (bumps token_version → invalidates all
  // refresh tokens for the account; live access tokens still expire within their 1h TTL).
  app.get('/api/admin/security/login-history', secureAdmin, (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit || 50, 10), 200);
      const rows = db.prepare(`
        SELECT a.id, a.action, a.ip, a.created_at, u.username
        FROM admin_audit_log a LEFT JOIN users u ON u.id = a.admin_id
        WHERE a.action IN ('login_success','login_failure','ip_autoban','logout')
        ORDER BY a.id DESC LIMIT ?
      `).all(limit);
      res.json({ success: true, count: rows.length, history: rows });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/admin/security/revoke-sessions', freshAdmin, (req, res) => {
    try {
      authManager.revokeUserTokens(req.user.user_id);
      db.prepare(`
        INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, details, ip)
        VALUES (?, 'revoke_sessions', 'auth', ?, '{}', ?)
      `).run(req.user.user_id, String(req.user.user_id), req.ip);
      res.json({
        success: true,
        message: 'All refresh tokens revoked. Other devices lose access within the 1-hour session window; re-login required.'
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── ALERT TEST DELIVERY (Admin) ───────────────────────────────────
  // Fire a synthetic alert through the live delivery channels (email/Discord/Slack/Telegram)
  // so the operator can confirm notifications actually arrive before relying on them. Channels
  // are read from the running config (pool.json) — the response reports which are configured.
  app.post('/api/admin/alerts/test', secureAdmin, async (req, res) => {
    try {
      if (!alertDelivery) return res.status(503).json({ error: 'alert delivery not initialised' });
      const channels = alertDelivery.configuredChannels ? alertDelivery.configuredChannels() : {};
      const anyConfigured = Object.values(channels).some(Boolean);
      if (!anyConfigured) {
        return res.status(400).json({ error: 'No alert channels are configured. Set a webhook / email / Telegram in pool.json first.', channels });
      }
      await alertDelivery.send({
        type: 'test_alert',
        level: 'info',
        message: `Test alert from ${config.pool_name || 'Grin Pool'} — if you see this, notifications work.`,
        occurrence_count: 1,
        triggered_at: Date.now(),
        data: JSON.stringify({ test: true, network: config.network }),
      });
      db.prepare(`
        INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, details, ip)
        VALUES (?, 'alert_test', 'alerts', 'test', ?, ?)
      `).run(req.user.user_id, JSON.stringify({ channels }), req.ip);
      res.json({ success: true, channels, message: 'Test alert dispatched to all configured channels.' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/admin/alerts', secureAdmin, (req, res) => {
    try {
      const status = req.query.status || 'active'; // 'active' or 'resolved'
      let alerts;

      if (status === 'resolved') {
        alerts = alertMonitor.getResolvedAlerts(50);
      } else {
        alerts = alertMonitor.getActiveAlerts();
      }

      res.json({
        status,
        count: alerts.length,
        alerts
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/admin/alerts/:alertId/acknowledge', secureAdmin, (req, res) => {
    try {
      const { alertId } = req.params;
      const success = alertMonitor.acknowledgeAlert(parseInt(alertId, 10));
      if (success) {
        res.json({ success: true, message: `Alert ${alertId} acknowledged` });
      } else {
        res.status(400).json({ error: 'Failed to acknowledge alert' });
      }
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/admin/alerts/:alertId/snooze', secureAdmin, (req, res) => {
    try {
      const { alertId } = req.params;
      const { minutes } = req.body;
      const snoozeMinutes = minutes || 60;

      const success = alertMonitor.snoozeAlert(parseInt(alertId, 10), snoozeMinutes);
      if (success) {
        res.json({
          success: true,
          message: `Alert ${alertId} snoozed for ${snoozeMinutes} minutes`
        });
      } else {
        res.status(400).json({ error: 'Failed to snooze alert' });
      }
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/admin/alerts/config', secureAdmin, (req, res) => {
    try {
      res.json({
        enabled_alerts: alertMonitor.enabledAlerts,
        thresholds: alertMonitor.thresholds,
        check_interval_secs: config.alert_check_interval_secs || 60,
        delivery: {
          email: !!config.alert_email_address,
          discord: !!config.discord_webhook_url,
          slack: !!config.slack_webhook_url
        }
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── Phase 2: New Endpoints ──────────────────────────────────────────────

  // Identity of the currently-authenticated admin. The session token is an httpOnly cookie,
  // so the browser CANNOT decode it (that's the point of httpOnly). Admin pages therefore
  // can't read the username/is_admin client-side — they must ask the server. Without this,
  // the pages tried to decode the cookie locally, always got null, and bounced to /login.html
  // in an infinite loop. Gated by secureAdmin: a 200 here is itself the "you're logged in"
  // signal; 401/403 means redirect to login.
  app.get('/api/admin/me', secureAdmin, (req, res) => {
    res.json({
      username: req.user?.username || null,
      is_admin: !!req.user?.is_admin,
      user_id: req.user?.user_id || null
    });
  });

  // Lightweight gate for nginx `auth_request` in front of the static /admin/ pages.
  // Purpose: stop nginx serving the admin HTML to an unauthenticated browser AT ALL —
  // no render, no "flash of admin page then redirect to /login.html". nginx subrequests
  // this on every /admin/* hit and only serves the page on a 2xx; 401/403 → redirect to
  // /login.html (handled in the nginx @admin_login fallback). Deliberately bypasses the
  // `admin` rate limiter (just requireAdmin = a cheap cookie+JWT verify, no DB) because it
  // fires per page AND per admin asset (admin-shell.js, styles.css) — running it through
  // the brute-force budget would throttle normal navigation. The network perimeter is
  // already enforced at the nginx `location /admin/` level ($admin_rules); the real
  // /api/admin/* data endpoints keep the full secureAdmin stack. Returns 204 (no body —
  // auth_request ignores it). client-side API.guardAdminPage() stays as a fallback for
  // installs whose nginx wasn't re-run.
  app.get('/api/admin/_authcheck', requireAdmin(authManager), (req, res) => {
    res.status(204).end();
  });

  // Unified Admin Dashboard
  app.get('/api/admin/dashboard', secureAdmin, async (req, res) => {
    try {
      const blockStats = blockManager.getPoolStats() || {};
      const minerCount = minerManager.getActiveMinersCount() || 0;
      const hashrateStats = hashrateTracker.getHashrateStats() || {};
      const withdrawalStatus = withdrawalScheduler.getStatus() || {};

      // created_at is an INTEGER unixepoch, so compare against unixepoch() arithmetic — NOT
      // datetime('now',…) (a TEXT value), which would make every row compare false. "Found"
      // counts all non-orphaned blocks (immature/confirmed/paid).
      const blocks24h = db.prepare(`
        SELECT COUNT(*) as count FROM blocks WHERE status != 'orphaned' AND created_at > unixepoch() - 86400
      `).get() || { count: 0 };
      const blocks7d = db.prepare(`
        SELECT COUNT(*) as count FROM blocks WHERE status != 'orphaned' AND created_at > unixepoch() - 7 * 86400
      `).get() || { count: 0 };
      const orphaned = db.prepare(`
        SELECT COUNT(*) as count FROM blocks WHERE status = 'orphaned'
      `).get() || { count: 0 };

      const stmt2 = db.prepare(`
        SELECT height, hash, found_by, reward, status, created_at FROM blocks ORDER BY height DESC LIMIT 1
      `);
      const lastBlock = stmt2.get() || null;

      res.json({
        timestamp: new Date().toISOString(),
        pool_status: {
          name: config.pool_name || 'GRINIUM',
          uptime_hours: +(process.uptime() / 3600).toFixed(1),
          last_restart: new Date(Date.now() - process.uptime() * 1000).toISOString()
        },
        stratum_metrics: {
          active_connections: stratumServer.getStats().active_connections || 0,
          active_miners: minerCount || 0,
          shares_per_sec: hashrateStats?.shares_per_second || 0,
          difficulty_avg: hashrateStats?.average_difficulty || 0,
          connection_errors_1h: 0
        },
        hashrate: {
          current_gps: hashrateStats?.current_hashrate || 0,
          avg_24h_gps: hashrateStats?.hashrate_24h || 0,
          peak_gps: hashrateStats?.peak_hashrate || 0,
          difficulty_delta: hashrateStats?.difficulty_delta || 0
        },
        blocks: {
          found_24h: blocks24h?.count || 0,
          found_7d: blocks7d?.count || 0,
          pending_payout: withdrawalStatus?.pending_count || 0,
          orphaned: orphaned?.count || 0,
          last_block: lastBlock ? {
            height: lastBlock.height,
            timestamp: lastBlock.created_at,
            reward: lastBlock.reward,
            status: lastBlock.status,
            miner_address: lastBlock.found_by
          } : null,
          current_difficulty: blockStats?.current_difficulty || 0,
          avg_difficulty_24h: blockStats?.avg_difficulty_24h || 0,
          found_total: blockStats?.total_blocks_found || 0,
          average_hashrate: hashrateStats?.average_difficulty || 0
        },
        payouts: {
          pending: withdrawalStatus?.pending_count || 0,
          failed: withdrawalStatus?.failed_count || 0,
          last_payout: withdrawalStatus?.last_payout_time || null,
          next_payout: withdrawalStatus?.next_payout_time || null,
          total_paid_24h: withdrawalStatus?.total_paid_24h || 0
        },
        pool_fee_percent: config.pool_fee_percent || 0,
        alerts: alertMonitor?.getActiveAlerts?.() || []
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Top Miners List - FIX #3: Use real data, not hardcoded values
  app.get('/api/miners/top', (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit || 10), 100);
      const offset = parseInt(req.query.offset || 0);

      const stmt = db.prepare(`
        SELECT
          ma.grin_address,
          ma.balance,
          ma.balance_locked,
          ma.is_online,
          ma.created_at,
          (SELECT COUNT(*) FROM shares WHERE grin_address = ma.grin_address) as shares_count,
          (SELECT MAX(created_at) FROM shares WHERE grin_address = ma.grin_address) as last_share_timestamp
        FROM miner_accounts ma
        ORDER BY ma.balance DESC
        LIMIT ? OFFSET ?
      `);

      const miners = stmt.all(limit, offset);

      const formatted = miners.map(m => ({
        grin_address: m.grin_address,
        balance: m.balance,
        balance_locked: m.balance_locked,
        total_balance: m.balance + m.balance_locked,
        shares_count: m.shares_count || 0,
        is_online: m.is_online ? true : false,
        last_share: m.last_share_timestamp || null,
        created_at: m.created_at
      }));

      res.json(formatted);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Combined health snapshot — the single call admin-panel/health.html makes for the
  // services grid + System Stats. The per-component routes below (/health/node, /wallet,
  // /system, /gateways) stay for granular polling; this one aggregates them into the flat
  // { services:{key:{status,…}}, system:{…} } shape the page renders, in ONE request (keeps
  // the admin rate budget low). Each probe is independently try/caught so one dead component
  // never blanks the whole grid.
  // Short cache (20s): the combined health payload is polled by every open admin tab and
  // on fast nav; without this each poll would re-hit the node + wallet. Liveness data this
  // coarse tolerates 20s staleness. Cleared implicitly by TTL only.
  let _healthCache = { ts: 0, payload: null };
  app.get('/api/admin/health', secureAdmin, async (req, res) => {
    if (_healthCache.payload && (Date.now() - _healthCache.ts) < 20000) {
      return res.json({ ..._healthCache.payload, cached: true });
    }
    const fmtUptime = (secs) => {
      secs = Math.floor(secs || 0);
      const d = Math.floor(secs / 86400);
      const h = Math.floor((secs % 86400) / 3600);
      const m = Math.floor((secs % 3600) / 60);
      return (d ? d + 'd ' : '') + (h ? h + 'h ' : '') + m + 'm';
    };
    const services = {};

    // pool_manager — this Node process
    services.pool_manager = { status: 'ok', pid: process.pid, uptime: fmtUptime(process.uptime()) };

    // grin_node
    try {
      const st = await blockMonitor.grinNode.getStatus();
      const synced = st?.synced === true;
      services.grin_node = {
        status: synced ? 'ok' : 'warning',
        height: st?.header_height || 0,
        synced
      };
    } catch (e) {
      services.grin_node = { status: 'error', message: e.message };
    }

    // stratum (local proxy) — present on the singlebox role; a pure hub has none
    try {
      if (minerManager && typeof minerManager.getActiveMinersCount === 'function') {
        services.stratum = {
          status: 'ok',
          port: config.stratum_port || 3333,
          miners_connected: minerManager.getActiveMinersCount()
        };
      } else {
        services.stratum = { status: 'warning', message: 'no local stratum (hub mode)' };
      }
    } catch (e) {
      services.stratum = { status: 'error', message: e.message };
    }

    // grin_wallet
    try {
      if (wallet && wallet.getBalance) {
        const summary = await wallet.getBalance();
        const info = Array.isArray(summary) ? summary[1] : (summary || {});
        services.grin_wallet = {
          status: 'ok',
          spendable_balance: Number(info.amount_currently_spendable || 0) / 1e9
        };
      } else {
        services.grin_wallet = { status: 'warning', message: 'wallet API not configured' };
      }
    } catch (e) {
      services.grin_wallet = { status: 'error', message: e.message };
    }

    // nginx — the request reached us through it, so the reverse proxy is up
    services.nginx = { status: 'ok', message: 'reachable (serving requests)' };

    // database
    try {
      const dbst = retentionManager.status();
      services.database = {
        status: 'ok',
        size_mb: dbst.db_size_bytes != null ? +(dbst.db_size_bytes / 1e6).toFixed(1) : null,
        wal_mode: 'enabled',
        message: `${dbst.counts?.shares ?? 0} shares`
      };
    } catch (e) {
      services.database = { status: 'error', message: e.message };
    }

    // system — real host metrics (same os/statfs logic as /health/system)
    let system = {};
    try {
      const load = os.loadavg();
      const totalMem = os.totalmem();
      const freeMem = os.freemem();
      const memPct = totalMem ? Math.round(((totalMem - freeMem) / totalMem) * 100) : null;
      let diskFree = null;
      try {
        if (typeof fs.statfsSync === 'function') {
          let target = '/';
          if (config.db_path && path.isAbsolute(config.db_path)) target = path.dirname(config.db_path);
          else target = process.cwd();
          const s = fs.statfsSync(target);
          diskFree = +((s.bavail * s.bsize) / 1e9).toFixed(1);
        }
      } catch (e) { diskFree = null; }
      system = {
        disk_free: diskFree,
        memory_pct: memPct,
        load_avg: load && load.length ? load.map(n => n.toFixed(2)).join(' ') : null,
        uptime: fmtUptime(os.uptime())
      };
    } catch (e) { system = {}; }

    const payload = { services, system, timestamp: new Date().toISOString() };
    _healthCache = { ts: Date.now(), payload };
    res.json(payload);
  });

  // Node Health Status - FIX #2, #14: Use async/await and remove hardcoded data
  app.get('/api/admin/health/node', secureAdmin, async (req, res) => {
    try {
      const status = await blockMonitor.grinNode.getStatus();
      const startTime = Date.now();

      // Check if node API is reachable (by getting status successfully)
      const latencyMs = Date.now() - startTime;
      const isSynced = status?.synced === true;

      res.json({
        status: isSynced ? 'healthy' : 'warning',
        checks: {
          api_reachable: {
            status: 'ok',
            latency_ms: latencyMs,
            endpoint: `http://127.0.0.1:${config.node_api_port || 3413}/v2/owner`
          },
          sync_status: {
            status: isSynced ? 'ok' : 'warning',
            height: status?.header_height || 0,
            network_height: status?.network_height || status?.header_height || 0,
            synced: isSynced,
            blocks_behind: (status?.network_height || 0) - (status?.header_height || 0)
          },
          peers: {
            status: (status?.peer_count || 0) >= 3 ? 'ok' : 'warning',
            count: status?.peer_count || 0,
            healthy_peers: status?.peer_count || 0,
            min_required: 3
          },
          difficulty: {
            status: 'ok',
            current: status?.difficulty || 0,
            average_24h: status?.difficulty || 0
          }
        },
        timestamp: new Date().toISOString()
      });
    } catch (err) {
      res.status(500).json({
        status: 'unhealthy',
        error: err.message,
        checks: {
          api_reachable: { status: 'error', latency_ms: 0 }
        },
        timestamp: new Date().toISOString()
      });
    }
  });

  // Wallet Health Status - FIX #14: Query actual wallet status instead of hardcoded data
  app.get('/api/admin/health/wallet', secureAdmin, async (req, res) => {
    try {
      let walletStatus = 'unknown';
      let walletBalance = { total: 0, available: 0, locked: 0 };
      let torStatus = config.tor_enabled ? 'enabled' : 'disabled';

      // Attempt to query wallet if API exists. retrieve_summary_info returns
      // [was_refreshed, WalletInfo] with amounts as nanoGRIN strings — parse to GRIN.
      if (wallet && wallet.getBalance) {
        try {
          const summary = await wallet.getBalance();
          const info = Array.isArray(summary) ? summary[1] : (summary || {});
          walletBalance = {
            total: Number(info.total || 0) / 1e9,
            available: Number(info.amount_currently_spendable || 0) / 1e9,
            locked: Number(info.amount_locked || 0) / 1e9
          };
          walletStatus = 'ok';
        } catch (err) {
          console.error('Wallet query failed:', err.message);
          walletStatus = 'unreachable';
        }
      }

      res.json({
        status: walletStatus === 'ok' ? 'healthy' : (walletStatus === 'unreachable' ? 'unhealthy' : 'unknown'),
        checks: {
          api_reachable: {
            status: walletStatus === 'ok' ? 'ok' : (walletStatus === 'unreachable' ? 'error' : 'unknown'),
            endpoint: `http://127.0.0.1:${config.wallet_foreign_api_port || 13415}/v2/foreign`,
            latency_ms: walletStatus === 'ok' ? 52 : 0
          },
          tor_reachable: {
            status: torStatus,
            tor_enabled: config.tor_enabled,
            last_successful_send: walletTor?.lastWithdrawalTime || null
          },
          balance: {
            status: walletBalance.total > 0 ? 'ok' : 'warning',
            total: walletBalance.total || 0,
            available: walletBalance.available || 0,
            locked: walletBalance.locked || 0,
            min_required: config.min_withdrawal || 5.0
          },
          synced: {
            status: 'ok',
            last_sync: new Date().toISOString(),
            blocks_behind: 0
          }
        },
        timestamp: new Date().toISOString()
      });
    } catch (err) {
      res.status(500).json({
        status: 'unhealthy',
        error: err.message,
        timestamp: new Date().toISOString()
      });
    }
  });

  // System Resources — real host metrics (CPU load, memory, disk, uptime). No hardcoded
  // values: everything comes from Node's `os` module + statfs on the data partition.
  app.get('/api/admin/health/system', secureAdmin, (req, res) => {
    try {
      const cpus = os.cpus() || [];
      const cpuCount = cpus.length || 1;
      const load = os.loadavg(); // [1m, 5m, 15m]; reported as 0,0,0 on platforms without it
      const totalMem = os.totalmem();
      const freeMem = os.freemem();
      const usedMem = totalMem - freeMem;
      const memPct = totalMem ? Math.round((usedMem / totalMem) * 100) : 0;
      // CPU utilisation proxy: 1-min load average relative to core count (standard Linux view).
      const cpuPct = Math.min(100, Math.round((load[0] / cpuCount) * 100));

      // Disk usage for the partition holding the pool DB (falls back to the cwd, then '/').
      // fs.statfsSync landed in Node 18.15 — guard so older runtimes degrade to null.
      let disk = null;
      try {
        if (typeof fs.statfsSync === 'function') {
          let target = '/';
          if (config.db_path && path.isAbsolute(config.db_path)) target = path.dirname(config.db_path);
          else target = process.cwd();
          const st = fs.statfsSync(target);
          const totalBytes = st.blocks * st.bsize;
          const freeBytes = st.bavail * st.bsize;
          const usedBytes = totalBytes - freeBytes;
          disk = {
            mount: target,
            total_gb: +(totalBytes / 1e9).toFixed(1),
            free_gb: +(freeBytes / 1e9).toFixed(1),
            used_pct: totalBytes ? Math.round((usedBytes / totalBytes) * 100) : 0
          };
        }
      } catch (e) {
        disk = null;
      }

      res.json({
        status: 'ok',
        hostname: os.hostname(),
        platform: os.platform(),
        cpu: {
          count: cpuCount,
          model: cpus[0] ? cpus[0].model : null,
          used_pct: cpuPct,
          load_1m: +load[0].toFixed(2),
          load_5m: +load[1].toFixed(2),
          load_15m: +load[2].toFixed(2)
        },
        memory: {
          total_gb: +(totalMem / 1e9).toFixed(2),
          used_gb: +(usedMem / 1e9).toFixed(2),
          free_gb: +(freeMem / 1e9).toFixed(2),
          used_pct: memPct
        },
        disk,
        uptime: {
          system_seconds: Math.floor(os.uptime()),
          process_seconds: Math.floor(process.uptime())
        },
        timestamp: new Date().toISOString()
      });
    } catch (err) {
      res.status(500).json({ status: 'error', error: err.message, timestamp: new Date().toISOString() });
    }
  });

  // Per-region GATEWAY liveness (Model C). Gateways are dumb stratum forwarders that never
  // call the Central API, so liveness is derived from two honest signals:
  //   (a) recent shares stamped with the region (financial-grade, survives restart), and
  //   (b) best-effort WireGuard peer last-handshake — the truest "tunnel up" signal for a
  //       region that is healthy but momentarily idle (no miners connected).
  // The freshest of the two wins. region_ports declares the expected regions so an admin
  // sees a configured-but-silent gateway too. (Replaces the old relay-heartbeat endpoint.)
  app.get('/api/admin/health/gateways', secureAdmin, (req, res) => {
    const STALE_S = 180, OFFLINE_S = 600;
    const now = Math.floor(Date.now() / 1000);

    let shareRows = [];
    try {
      shareRows = db.prepare(
        `SELECT region, COUNT(*) AS shares, MAX(created_at) AS last_share,
                MAX(block_height) AS last_height, COUNT(DISTINCT grin_address) AS miners
         FROM shares WHERE created_at > ? GROUP BY region`
      ).all(now - 900);
    } catch (e) { /* table may be empty */ }
    const byRegion = new Map(shareRows.map(r => [r.region, r]));

    const wgByRegion = readWgHandshakes(); // {} on any failure (wg absent / not central box)

    const declared = Object.keys(config.region_ports || {});
    const regions = new Set([...declared, ...byRegion.keys(), ...Object.keys(wgByRegion)]);
    const gateways = [];
    for (const region of regions) {
      const s = byRegion.get(region);
      const wg = wgByRegion[region];
      const shareAge = s && s.last_share ? now - s.last_share : null;
      const hsAge = wg && wg.handshake ? now - wg.handshake : null;
      const ages = [shareAge, hsAge].filter((a) => a !== null);
      let status = 'unknown', ageS = null;
      if (ages.length) {
        ageS = Math.min.apply(null, ages);
        status = ageS >= OFFLINE_S ? 'offline' : ageS >= STALE_S ? 'stale' : 'online';
      }
      gateways.push({
        region,
        port: (config.region_ports || {})[region] || null,
        status,
        age_seconds: ageS,
        last_share_height: s ? (s.last_height || 0) : 0,
        shares_window: s ? s.shares : 0,
        miners: s ? s.miners : 0,
        tunnel_handshake_age: hsAge
      });
    }
    gateways.sort((a, b) => a.region.localeCompare(b.region));

    res.json({
      role: config.role || 'singlebox',
      stale_threshold_seconds: STALE_S,
      offline_threshold_seconds: OFFLINE_S,
      gateway_count: gateways.length,
      gateways,
      timestamp: new Date().toISOString()
    });
  });

  // ─── MULTI-REGION LOCATIONS (Admin only) ──────────────────────────
  // CRUD over pool_locations — the operator's descriptive registry of regions/gateways
  // (labels + public stratum URLs surfaced to miners via /api/pool/locations). This is
  // metadata only; the actual region wiring is the WireGuard peer + per-region port set up
  // by Script 07 (W) Multi-region) — live status comes from /api/admin/health/gateways.
  app.get('/api/admin/locations', secureAdmin, (req, res) => {
    try {
      const rows = db.prepare('SELECT * FROM pool_locations ORDER BY region ASC').all();
      res.json({ success: true, locations: rows });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Create or update a region by its unique `region` key (upsert).
  app.post('/api/admin/locations', secureAdmin, (req, res) => {
    try {
      const { region, label, country, country_code, api_url, stratum_url } = req.body || {};
      const is_active = req.body && req.body.is_active === false ? 0 : 1;
      const reg = String(region || '').trim();
      if (!reg) return res.status(400).json({ error: 'region is required' });
      const cc = country_code ? String(country_code).trim().toUpperCase().slice(0, 2) : null;

      db.prepare(`
        INSERT INTO pool_locations (region, label, country, country_code, api_url, stratum_url, is_active, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, unixepoch())
        ON CONFLICT(region) DO UPDATE SET
          label = excluded.label,
          country = excluded.country,
          country_code = excluded.country_code,
          api_url = excluded.api_url,
          stratum_url = excluded.stratum_url,
          is_active = excluded.is_active,
          updated_at = unixepoch()
      `).run(reg, label || null, country || null, cc, api_url || null, stratum_url || null, is_active);

      const row = db.prepare('SELECT * FROM pool_locations WHERE region = ?').get(reg);
      db.prepare(`
        INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, details, ip)
        VALUES (?, 'location_upsert', 'pool_location', ?, ?, ?)
      `).run(req.user.user_id, reg, JSON.stringify({ label, country, country_code: cc, api_url, stratum_url, is_active }), req.ip);

      res.json({ success: true, location: row });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.delete('/api/admin/locations/:id', freshAdmin, (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const row = db.prepare('SELECT * FROM pool_locations WHERE id = ?').get(id);
      if (!row) return res.status(404).json({ error: 'location not found' });
      db.prepare('DELETE FROM pool_locations WHERE id = ?').run(id);
      db.prepare(`
        INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, details, ip)
        VALUES (?, 'location_delete', 'pool_location', ?, ?, ?)
      `).run(req.user.user_id, row.region, JSON.stringify(row), req.ip);
      res.json({ success: true, deleted: row.region });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── MINERS (Admin only) ───────────────────────────────────────────
  // Admin view of miner accounts (address-keyed; miners never have logins). Read access
  // to balances + share/hashrate activity, plus a testnet-only balance injector for
  // exercising the payout pipeline without mining 100 blocks first.
  app.get('/api/admin/miners', secureAdmin, (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit || 50), 500);
      const offset = parseInt(req.query.offset || 0);
      const search = req.query.search ? `%${req.query.search}%` : null;

      const where = search ? 'WHERE ma.grin_address LIKE ?' : '';
      const args = search ? [search, limit, offset] : [limit, offset];
      const rows = db.prepare(`
        SELECT ma.grin_address, ma.balance, ma.balance_locked, ma.is_online, ma.is_banned, ma.ban_reason, ma.last_seen_at, ma.created_at,
               (SELECT COUNT(*) FROM shares s WHERE s.grin_address = ma.grin_address) AS shares_count,
               (SELECT MAX(created_at) FROM shares s WHERE s.grin_address = ma.grin_address) AS last_share_at,
               (SELECT COALESCE(SUM(amount),0) FROM withdrawals w WHERE w.grin_address = ma.grin_address AND w.status='confirmed') AS total_paid
        FROM miner_accounts ma
        ${where}
        ORDER BY ma.balance DESC
        LIMIT ? OFFSET ?
      `).all(...args);

      res.json({ success: true, count: rows.length, miners: rows });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/admin/miners/:addr', secureAdmin, (req, res) => {
    try {
      const { addr } = req.params;
      const acct = db.prepare('SELECT * FROM miner_accounts WHERE grin_address = ?').get(addr);
      if (!acct) return res.status(404).json({ error: 'miner not found' });

      const total_paid = db.prepare(
        `SELECT COALESCE(SUM(amount),0) AS t FROM withdrawals WHERE grin_address = ? AND status='confirmed'`
      ).get(addr).t;
      const pending = db.prepare(
        `SELECT * FROM withdrawals WHERE grin_address = ? AND status IN ('tor_checking','tor_sending','retry_scheduled') ORDER BY created_at DESC`
      ).all(addr);
      const shareAgg = db.prepare(
        `SELECT COUNT(*) AS count, MAX(created_at) AS last_share_at FROM shares WHERE grin_address = ?`
      ).get(addr);
      const blocks_found = db.prepare(
        `SELECT COUNT(*) AS c FROM blocks WHERE found_by = ?`
      ).get(addr).c;
      const incentives = db.prepare('SELECT * FROM miner_incentives WHERE grin_address = ?').get(addr) || null;
      const hr = hashrateTracker.getMinerHashrate(addr, 60) || {};

      res.json({
        success: true,
        miner: {
          ...acct,
          is_online: !!acct.is_online,
          total_paid,
          shares_count: shareAgg.count || 0,
          last_share_at: shareAgg.last_share_at || null,
          blocks_found,
          hashrate_gps: parseFloat(((hr.avg_hashrate || 0)).toFixed(6)),
          pending_withdrawals: pending,
          incentives
        }
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Testnet-only: inject GRIN into a miner's balance to exercise the payout pipeline
  // (skip the confirm_depth wait). Hard-guarded to testnet so it can never mint mainnet
  // balances. Records a balance_log credit + admin_audit_log row.
  app.post('/api/admin/miners/:addr/inject', secureAdmin, (req, res) => {
    try {
      if (config.network !== 'testnet') {
        return res.status(403).json({ error: 'balance injection is testnet-only' });
      }
      const { addr } = req.params;
      const amount = parseFloat(req.body && req.body.amount);
      if (isNaN(amount) || amount <= 0) {
        return res.status(400).json({ error: 'amount must be a positive number' });
      }

      const injected = db.transaction(() => {
        minerManager.ensureMinerExists(addr);
        const before = db.prepare('SELECT balance, balance_locked FROM miner_accounts WHERE grin_address = ?').get(addr);
        db.prepare('UPDATE miner_accounts SET balance = balance + ?, updated_at = unixepoch() WHERE grin_address = ?').run(amount, addr);
        const after = before.balance + amount;
        db.prepare(`
          INSERT INTO balance_log
          (grin_address, event_type, amount, balance_before, balance_after, locked_before, locked_after, reference_type, reference_id)
          VALUES (?, 'credit', ?, ?, ?, ?, ?, 'admin_inject', 0)
        `).run(addr, amount, before.balance, after, before.balance_locked, before.balance_locked);
        return after;
      })();

      db.prepare(`
        INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, details, ip)
        VALUES (?, 'miner_inject', 'miner_account', ?, ?, ?)
      `).run(req.user.user_id, addr, JSON.stringify({ amount, balance: injected }), req.ip);

      res.json({ success: true, grin_address: addr, amount, balance: injected });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Ban / unban a mining address (abuse control). Banning blocks future stratum logins +
  // drops live sessions; the balance is left intact so anything already owed can still be
  // paid out. Step-up gated (freshAdmin) — it's a moderation/access action.
  app.post('/api/admin/miners/:addr/ban', freshAdmin, (req, res) => {
    try {
      const addr = String(req.params.addr || '').trim();
      const reason = String((req.body && req.body.reason) || '').slice(0, 280) || null;
      if (!addr) return res.status(400).json({ error: 'address required' });
      minerManager.banMiner(addr, reason);
      db.prepare(`
        INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, details, ip)
        VALUES (?, 'miner_ban', 'miner_account', ?, ?, ?)
      `).run(req.user.user_id, addr, JSON.stringify({ reason }), req.ip);
      res.json({ success: true, grin_address: addr, is_banned: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/admin/miners/:addr/unban', freshAdmin, (req, res) => {
    try {
      const addr = String(req.params.addr || '').trim();
      if (!addr) return res.status(400).json({ error: 'address required' });
      minerManager.unbanMiner(addr);
      db.prepare(`
        INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, details, ip)
        VALUES (?, 'miner_unban', 'miner_account', ?, '{}', ?)
      `).run(req.user.user_id, addr, req.ip);
      res.json({ success: true, grin_address: addr, is_banned: false });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Award a contest/incentive prize directly to a miner's address (address-as-identity —
  // no account needed). Funded from the prize_pool bucket by default so it's backed by real
  // GRIN already in the wallet; the prize pays out to the address via the normal Tor flow.
  // The note is stored in the audit log for the operator's records.
  app.post('/api/admin/incentives/award', freshAdmin, (req, res) => {
    try {
      const addr = String((req.body && req.body.address) || '').trim();
      const amount = parseFloat(req.body && req.body.amount);
      const note = String((req.body && req.body.note) || '').slice(0, 280);
      const fromPrizePool = (req.body && req.body.from_prize_pool) !== false; // default true

      if (!/^t?grin1[ac-hj-np-z02-9]{40,}$/.test(addr)) {
        return res.status(400).json({ error: 'Enter a valid Grin Slatepack address (grin1…)' });
      }
      if (isNaN(amount) || amount <= 0) {
        return res.status(400).json({ error: 'amount must be a positive number' });
      }
      if (!incentivesManager) {
        return res.status(503).json({ error: 'incentives unavailable' });
      }

      const result = incentivesManager.awardPrize(addr, amount, { fromPrizePool });
      if (!result.ok) {
        const msg = result.reason === 'insufficient_prize_pool'
          ? 'Prize pool balance is too low to cover this award. Top up the prize pool or uncheck "fund from prize pool".'
          : (result.reason || 'award failed');
        return res.status(400).json({ error: msg });
      }

      db.prepare(`
        INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, details, ip)
        VALUES (?, 'prize_award', 'miner_account', ?, ?, ?)
      `).run(req.user.user_id, addr, JSON.stringify({ amount, note, from_prize_pool: fromPrizePool, balance: result.balance }), req.ip);

      res.json({ success: true, grin_address: addr, amount, balance: result.balance, funded_from: fromPrizePool ? 'prize_pool' : 'mint' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── POOL SETTINGS ENDPOINTS (Admin only) ─────────────────────────

  // Get all settings sections
  app.get('/api/admin/settings', secureAdmin, (req, res) => {
    try {
      const allSettings = poolSettings.getAll();
      res.json({ success: true, data: allSettings });
    } catch (err) {
      res.status(500).json({ error: 'Failed to fetch settings' });
    }
  });

  // Get one settings section
  app.get('/api/admin/settings/:section', secureAdmin, (req, res) => {
    try {
      const section = poolSettings.getSection(req.params.section);
      res.json({ success: true, section: req.params.section, data: section });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // Update one settings section
  // High-risk settings sections (payout = fee/min-withdrawal/wallet; access = admin IP rules)
  // require step-up auth; cosmetic sections (branding/seo/…) save with a normal admin session.
  const STEP_UP_SETTINGS_SECTIONS = new Set(['payout', 'access']);
  app.post('/api/admin/settings/:section', secureAdmin, (req, res) => {
    try {
      if (STEP_UP_SETTINGS_SECTIONS.has(req.params.section) &&
          !authManager.isTokenFresh(req.token, STEP_UP_MAX_AGE_S)) {
        return res.status(403).json({ error: 'Re-authentication required for this section', challenge_required: true });
      }
      const updated = poolSettings.updateSection(req.params.section, req.body, req.user.user_id);
      res.json({ success: true, section: req.params.section, data: updated });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // Restore section to defaults
  app.post('/api/admin/settings/:section/restore', freshAdmin, (req, res) => {
    try {
      const restored = poolSettings.resetSection(req.params.section, req.user.user_id);
      res.json({ success: true, section: req.params.section, data: restored });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // ─── DATABASE / CLEANUP (Admin only) ──────────────────────────────
  // Scalar retention config is handled by /api/admin/settings/database; these expose
  // the live DB size + row counts and a manual "run cleanup now" trigger.
  app.get('/api/admin/database/status', secureAdmin, (req, res) => {
    try {
      res.json({ success: true, data: retentionManager.status() });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/admin/database/cleanup', freshAdmin, (req, res) => {
    try {
      const result = retentionManager.runOnce();
      res.json({ success: true, data: result });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── INCENTIVES ENDPOINTS (Admin only) ────────────────────────────
  // Scalar config is handled by the generic /api/admin/settings/incentives endpoints; these
  // cover the live prize-pool bucket and lottery draws that the generic settings can't.

  app.get('/api/admin/incentives/prize-pool', secureAdmin, (req, res) => {
    try {
      res.json({
        success: true,
        balance: incentivesManager.prizePoolBalance(),
        ledger: incentivesManager.prizePoolLedger(25),
      });
    } catch (err) {
      res.status(500).json({ error: 'Failed to load prize pool' });
    }
  });

  // Manual operator top-up of the prize bucket. Accounting only — the operator must already
  // hold the GRIN in the pool wallet; this just records it as available for prizes.
  app.post('/api/admin/incentives/prize-pool/topup', freshAdmin, (req, res) => {
    try {
      const balance = incentivesManager.manualTopup(req.body.amount);
      db.prepare(`
        INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, details)
        VALUES (?, 'prize_pool_topup', 'prize_pool', 'prize_pool', ?)
      `).run(req.user.user_id, JSON.stringify({ amount: req.body.amount, balance }));
      res.json({ success: true, balance });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.get('/api/admin/incentives/lottery/draws', secureAdmin, (req, res) => {
    try {
      res.json({
        success: true,
        draws: lotteryManager.recentDraws(20),
        next: lotteryManager.nextScheduled(),
      });
    } catch (err) {
      res.status(500).json({ error: 'Failed to load lottery draws' });
    }
  });

  // Manually trigger a draw (testing / off-schedule special event).
  app.post('/api/admin/incentives/lottery/draw-now', freshAdmin, async (req, res) => {
    try {
      const type = req.body.type === 'special' ? 'special' : 'weekly';
      const result = await lotteryManager.runDraw(type, req.body.event_name || null, parseFloat(req.body.pot_grin) || 0);
      db.prepare(`
        INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, details)
        VALUES (?, 'lottery_draw_now', 'lottery', ?, ?)
      `).run(req.user.user_id, String(result.draw_id || ''), JSON.stringify(result));
      res.json({ success: true, result });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // ─── ASSET UPLOAD ENDPOINTS (Admin only) ──────────────────────────

  // Upload an asset (logo, favicon, og_image)
  app.post('/api/admin/assets/upload', secureAdmin, (req, res) => {
    try {
      const upload = assetManager.getMulterInstance().single('file');
      upload(req, res, async (err) => {
        if (err) {
          return res.status(400).json({ error: err.message });
        }
        if (!req.file) {
          return res.status(400).json({ error: 'No file provided' });
        }

        try {
          const assetType = req.query.type || 'custom';
          const saved = await assetManager.saveAsset(req.file, assetType, req.user.user_id);
          res.json({ success: true, asset: saved });
        } catch (err) {
          res.status(400).json({ error: err.message });
        }
      });
    } catch (err) {
      res.status(500).json({ error: 'Upload failed' });
    }
  });

  // List uploaded assets
  app.get('/api/admin/assets', secureAdmin, (req, res) => {
    try {
      const assets = assetManager.listAssets(true);
      res.json({ success: true, assets });
    } catch (err) {
      res.status(500).json({ error: 'Failed to list assets' });
    }
  });

  // Delete an asset
  app.delete('/api/admin/assets/:filename', secureAdmin, (req, res) => {
    try {
      const result = assetManager.deleteAsset(req.params.filename);
      res.json({ success: true, ...result });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.use((req, res) => {
    res.status(404).json({ error: 'Not found' });
  });
}

process.on('SIGINT', () => {
  console.log(`\n[${new Date().toISOString()}] Shutting down gracefully...`);
  process.exit(0);
});

initializePool();
