#!/usr/bin/env node

const express = require('express');
const path = require('path');
const { initDb, ensureLocalRegion, seedDefaultRegions } = require('./lib/db');
const { loadConfig, mergeDbSettings, hashConfig, validateBootConfig } = require('./lib/config');
const gatewayStatus = require('./lib/gateway-status');
const PoolSettings = require('./lib/pool-settings');
const AssetManager = require('./lib/asset-manager');
const WalletAPI = require('./lib/wallet');
const StratumServer = require('./lib/stratum-server');
const StratumPause = require('./lib/stratum-pause');
const NodeStratumClient = require('./lib/node-stratum-client');
const BlockManager = require('./lib/blocks');
const ShareValidator = require('./lib/shares');
const MinerManager = require('./lib/miners');
const BlockMonitor = require('./lib/block-monitor');
const GrinNodeAPI = require('./lib/grin-node');
const RewardDistributor = require('./lib/rewards');
const IncentivesManager = require('./lib/incentives');
const LotteryManager = require('./lib/lottery');
const WalletTor = require('./lib/wallet-tor');
const WithdrawalScheduler = require('./lib/withdrawal-scheduler');
const NostrPayoutBridge = require('./lib/nostr-payout');
const AuthManager = require('./lib/auth');
const Captcha = require('./lib/captcha');
const HashrateTracker = require('./lib/hashrate-tracker');
const DonorProfiles = require('./lib/donor-profiles');
const { migrateProofSet, migrateAuditLogIps } = require('./lib/owner-proof');
const geoip = require('./lib/geoip');
const PoolstatsReporter = require('./lib/poolstats-reporter');
const RateLimiter = require('./lib/rate-limiter');
const IpFilter = require('./lib/ip-filter');
const AlertMonitor = require('./lib/alert-monitor');
const AlertDelivery = require('./lib/alert-delivery');
const RetentionManager = require('./lib/retention');
const NodeAvailability = require('./lib/node-availability');
const DormancyManager = require('./lib/dormancy');
const AdsManager = require('./lib/ads');
const PagesManager = require('./lib/pages');
const PostsManager = require('./lib/posts');
const { createGamesLink } = require('./lib/games-link');
const registerRoutes = require('./routes');
const multer = require('multer');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');
const fs = require('fs');

const app = express();
// Trust X-Forwarded-For ONLY when the connection comes from our own nginx on loopback.
// This makes req.ip the real client IP from XFF (instead of nginx's 127.0.0.1) while making
// raw XFF UNspoofable: a direct hit on :8080 (not via the local proxy) gets its real socket
// IP, not a forged header. Without this the rate-limiter and admin IP allowlist all compare
// against the wrong/forgeable address.
// 'loopback' matches the toolkit convention (see web/051_fidelius/server.js); app-scoped, so
// no collision with other toolkit Express products.
app.set('trust proxy', 'loopback');
// No `X-Powered-By: Express` on any response (audit §J11-6). Free reconnaissance, and the
// pool's vhost is the one toolkit vhost that does not also set `server_tokens off` — the
// nginx half of that pair is §J16's.
app.disable('x-powered-by');
// Games platform internal routes (/internal/games/*, design §19.3) — all logic in
// lib/games-link.js. Mounted BEFORE express.json() and every rate limiter on purpose: the link
// secret is checked before any body is parsed, and every games call comes from 127.0.0.1, so a
// per-IP bucket would be one bucket for every player (D7). attach() in setupRoutes wires it up.
const gamesLink = createGamesLink();
app.use(gamesLink.internal);
app.use(express.json());
app.use(cookieParser());

// Security headers middleware
app.use((req, res, next) => {
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'");
  // Report-Only twin: the policy above minus 'unsafe-inline' in script-src (style-src keeps it).
  // The browser console logs whatever the strict policy WOULD block and nothing is blocked. No
  // report-uri on purpose — no new endpoint. Kept identical to the line above except for that
  // one token (test-csp-report-only.js); the strict flip replaces both lines with the strict one.
  res.setHeader('Content-Security-Policy-Report-Only', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'");
  // NO includeSubDomains (audit §J1-7 / §I self-review). `subdomain` in pool.json is routinely
  // the operator's APEX domain, and the directive would pin api., testapi. and every other
  // sibling host to HTTPS for a year with no way to cache it away. The generated nginx snippet
  // was corrected in §I; this copy was not, and nginx does not strip upstream headers — so every
  // proxied /api/… response carried BOTH, and RFC 6797 §8.1 says the UA processes only the
  // FIRST, which is this one. The two must stay identical; changing one means changing both.
  res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  next();
});

// ─── CORS — read-only public API only ─────────────────────────────────────────
// api-docs.html invites people to "build your own monitor or bot"; for a browser-based client
// that means a cross-origin fetch, which without these headers fails while the identical curl
// succeeds. Allowed on PUBLIC **GET**s only:
//   · no Access-Control-Allow-Credentials — with `*` browsers reject the pair anyway, and
//     inviting it would turn a logged-in operator's admin cookie into a cross-site read.
//   · /api/admin/ and /api/auth/ are excluded, so the admin surface is untouched.
//   · POST/DELETE are excluded, so the ownership-gated money actions stay same-origin: a
//     preflight for them gets no CORS headers and the browser refuses the call.
// Everything this opens is already world-readable to curl — it only removes a browser-only
// restriction, it does not widen what is published.
const CORS_PUBLIC_PREFIXES = [
  '/api/public/', '/api/config/', '/api/pool/', '/api/account/', '/api/stratum/', '/api/network/',
];
app.use((req, res, next) => {
  if ((req.method === 'GET' || req.method === 'OPTIONS') &&
      CORS_PUBLIC_PREFIXES.some((p) => req.path.startsWith(p))) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Max-Age', '86400');
    res.setHeader('Vary', 'Origin');
    if (req.method === 'OPTIONS') return res.status(204).end();
  }
  next();
});

let config = null;
let db = null;
let wallet = null;
let stratumServer = null;
let stratumPause = null;
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
let nostrBridge = null;
let authManager = null;
// Self-hosted login CAPTCHA (in-memory, single process). No external dependency.
const loginCaptcha = new Captcha();
// Auto-ban (fail2ban-style): too many failed admin logins from one IP within the window
// → temporary IP ban (cooldown). In-memory; pairs with ipFilter.tempBan().
//
// This ban stays SHORT on purpose and must not be lengthened. `ipFilter.tempBans` is an
// in-process Map with no size cap and lazy pruning, so a long TTL is both unenforceable
// (any deploy/restart clears it) and unbounded (a rotating scanner accumulates entries for
// the whole TTL). The durable, operator-tunable ban is the fail2ban jail `grin-pool-login`
// (Script 07 → fail2ban_bantime), which lives in the firewall and survives a pool restart.
// Note the break-glass admin-reset CLI cannot lift a ban held here — it edits pool.db, this
// is another process's memory. Recovery is: wait it out, come from another address, or
// restart the service.
const ADMIN_LOGIN_FAIL_THRESHOLD = 10;
const ADMIN_LOGIN_FAIL_WINDOW_MS = 15 * 60 * 1000;   // matches fail2ban findtime (900s)
const ADMIN_LOGIN_BAN_MS = 60 * 60 * 1000;
// Entry count past which recordAdminLoginFailure sweeps expired rows before adding a new IP
// (audit §J12-11). Well above any real pool's concurrent failing-IP count, so a legitimate
// operator never pays for the sweep.
const ADMIN_FAIL_MAP_MAX = 10000;
const adminLoginFailures = new Map(); // ip -> { count, firstAt }

// Wrong TOTP/recovery codes are counted SEPARATELY from wrong passwords, with a higher
// threshold. Reaching this step already required the correct password, so it is a weak
// brute-force signal — while it is a strong FALSE-POSITIVE source for the real operator:
// if the server's clock drifts, every code is rejected, and the human response is to try
// several codes and then a mistyped recovery code. Mixing those into the password counter
// let an honest operator earn an IP ban at exactly the moment they need access. The
// threshold still has to exist: a 6-digit code is only 10^6 wide and the `auth` limiter
// sits at a loose 200/min.
const ADMIN_2FA_FAIL_THRESHOLD = 20;
const admin2faFailures = new Map();   // ip -> { count, firstAt }
let hashrateTracker = null;
let poolstatsReporter = null;
let rateLimiter = null;
let ipFilter = null;
let alertMonitor = null;
let alertDelivery = null;
let poolSettings = null;
let assetManager = null;
let retentionManager = null;
let nodeAvailability = null;
let dormancyManager = null;
let adsManager = null;
let pagesManager = null;
let postsManager = null;
let uploadsDir = null;       // persistent media dir (served at /uploads, nginx in prod)
let mediaUpload = null;      // configured multer instance for image uploads
// Which Grin networks the network-map peer sensor reads (set once the collector is wired,
// reported by /api/network/peers so the page can say "mainnet + testnet" vs "mainnet only").
let _peerSensorNets = { main: false, test: false };

// The name rule's context for a donor name (design §19.17.6, Part C4): the operator's
// `names.blocked_words` and the pool's name, read per call so a Settings → Names save applies
// to the next submit. Unreadable → '' and the code seed in lib/name-rule.js still applies
// (fail open to the seed, as the games side does with its last good copy).
function donorNameRule() {
  let words = '';
  let poolName = '';
  try { words = poolSettings.getSection('names').blocked_words; } catch (_) { words = ''; }
  try { poolName = poolSettings.getSection('pool_info').pool_name; } catch (_) { poolName = ''; }
  return DonorProfiles.nameRuleContext(words, poolName);
}

async function initializePool() {
  try {
    // GRIN_POOL_CONF is set by the Script 07 systemd unit (/opt/grin/conf/
    // grin_pubpool.json); ./pool.json is the manual/testnet fallback. Without
    // it the installed service would ignore the operator's config entirely.
    config = loadConfig(process.env.GRIN_POOL_CONF || './pool.json');
    console.log(`[${new Date().toISOString()}] Loading pool configuration...`);

    config = validateBootConfig(config);
    gatewayStatus.setConfig(config);

    console.log(`  Network: ${config.network}`);
    console.log(`  API port: ${config.port}`);
    console.log(`  Stratum port: ${config.stratum_port}`);

    db = initDb(config.db_path);
    console.log(`[${new Date().toISOString()}] Database initialized at ${config.db_path}`);

    // Config integrity (audit §J9-6). Runs AFTER initDb so a mismatch can be recorded in the
    // alerts table instead of only in the journal — AlertMonitor does not exist this early.
    //
    // Three things were wrong and are fixed here:
    //  1. The baseline was rewritten UNCONDITIONALLY, outside the mismatch branch. The warning
    //     appeared once and the tampered value became the new truth; restart twice and the pool
    //     reports clean. It now refuses to overwrite a mismatched baseline — the alert stands
    //     until a human replaces the file — and writes the observed hash to `.new` beside it.
    //  2. It hashed the MERGED config object, so the systemd PORT/HOST env and every per-network
    //     default were inside the hash: a unit-file edit or a toolkit upgrade that adds a default
    //     key tripped it. A detector that cries wolf on routine maintenance is one the operator
    //     learns to ignore, which makes (1) worse rather than being a separate problem. It now
    //     hashes the RAW BYTES of the file it claims to be watching.
    //  3. The baseline lived in the app directory while the config lives in /opt/grin/conf, so a
    //     redeploy dropped it and `existsSync` turned the check into a silent no-op. It now sits
    //     beside the config it describes.
    //
    // Still NOT covered, deliberately: the `pool_config` table, where every runtime money value
    // actually lives. §J1-2's audit row is the control for those; this one watches pool.json.
    try {
      const confPath = config.__config_path;
      if (confPath && fs.existsSync(confPath)) {
        const configHash = hashConfig(fs.readFileSync(confPath));
        const hashFile = `${confPath}.sha256`;
        const saved = fs.existsSync(hashFile) ? fs.readFileSync(hashFile, 'utf-8').trim() : null;
        if (saved && saved !== configHash) {
          console.warn(
            `[SECURITY] ${confPath} has changed since the recorded baseline. If you edited it, ` +
            `delete ${hashFile} to re-anchor. If you did not, treat this box as compromised — ` +
            `this warning will repeat on every start until the baseline is replaced by hand.`
          );
          fs.writeFileSync(`${hashFile}.new`, configHash, 'utf-8');
          try {
            db.prepare(`
              INSERT INTO alerts (type, level, message, data, status, triggered_at, last_seen)
              VALUES ('config_tampered', 'critical', ?, ?, 'active', ?, ?)
            `).run(
              `${confPath} does not match its recorded hash. Every credential and money setting ` +
              `in that file is suspect until this is explained.`,
              JSON.stringify({ path: confPath, expected: saved, observed: configHash }),
              new Date().toISOString(), new Date().toISOString()
            );
          } catch (e) { console.error(`[SECURITY] …and the alert row failed: ${e.message}`); }
        } else if (!saved) {
          fs.writeFileSync(hashFile, configHash, 'utf-8');
          console.log(`[${new Date().toISOString()}] Config integrity baseline recorded at ${hashFile}`);
        }
      }
    } catch (e) {
      console.error(`[SECURITY] config integrity check could not run: ${e.message}`);
    }

    // Merge DB settings into config (applies UI-customized settings at startup)
    config = mergeDbSettings(config, db);
    console.log(`[${new Date().toISOString()}] Pool configuration merged from database`);

    // One-time seed of the default grinium regional endpoints (grouped by country),
    // so the public "nearest region" connect grid is populated out of the box. Idempotent
    // (guarded by a persistent marker) — never clobbers operator edits in admin → Regions.
    // Gated to the real grinium.com deployment: a fork running its own domain must NOT
    // advertise grinium.com hosts (its miners would connect to the wrong pool).
    // Third arg: this box's own region tag, which the seed must NOT create (it would create it
    // inactive — see the note on seedDefaultRegions; ensureLocalRegion below owns that row).
    seedDefaultRegions(config.stratum_port, config.subdomain, config.region);

    // Self-register this pool server's own region so it shows as a real connect card
    // and auto-joins the grid when a gateway for another zone forwards shares in. Only the
    // singlebox role runs a local stratum; a bare hub relies purely on regional gateways.
    // After a hub MOVE (config.region differs from the last one this DB saw) it also activates
    // the new region's row once — see the note on ensureLocalRegion.
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

    // Part C4 (design §19.17.6): donor names are auto-checked. Both steps are idempotent and run
    // at every start, in this order — the carried words must apply to the pending names:
    //   1. the retired `donor_name_blocklist` → `names.blocked_words` (the operator's own
    //      entries, once; the old row's deletion is the marker);
    //   2. every PENDING donor name through the check → approved or rejected (nothing writes a
    //      pending name any more, so after the first start there are none). Approved names stay.
    // A failure is logged, never fatal: mining does not wait for donor names. Pending names left
    // by a failed run stay pending and are retried at the next start.
    try {
      const carry = poolSettings.retireDonorNameBlocklist();
      if (carry) {
        console.log(`[${new Date().toISOString()}] Donor flag words retired into Settings → Names: ` +
          `${carry.carried.length} carried over` +
          (carry.skipped.length ? `, ${carry.skipped.length} skipped (cannot match a name: ${carry.skipped.join(', ')})` : '') +
          (carry.over_cap.length ? `, ${carry.over_cap.length} over the 500-entry cap (${carry.over_cap.join(', ')})` : ''));
      }
      const moved = DonorProfiles.migratePendingNames(db, { rule: donorNameRule() });
      if (moved.approved || moved.rejected) {
        console.log(`[${new Date().toISOString()}] Pending donor names checked automatically: ${moved.approved} approved, ${moved.rejected} rejected`);
      }
    } catch (err) {
      console.error(`[${new Date().toISOString()}] Donor-name migration (C4) failed — retried at the next start:`, err.message);
    }

    wallet = new WalletAPI(config);
    console.log(`[${new Date().toISOString()}] Wallet API initialized (${config.network})`);

    blockManager = new BlockManager(config);
    shareValidator = new ShareValidator(config);
    minerManager = new MinerManager(config);
    console.log(`[${new Date().toISOString()}] Mining managers initialized`);

    // One-time copy of the legacy 2-slot proof window into the proof set (design §17.2 #9),
    // subsuming the old plaintext-hash upgrade and the anchor backfill. MUST stay synchronous
    // and MUST run BEFORE stratumServer.start() below: an account that reached its first
    // post-upgrade capture with an EMPTY set would anchor to whoever mined that share, not to
    // the owner. It used to sit ~130 lines further down, after `await nostrBridge.start()` —
    // so with Nostr payouts on, the listener was accepting shares for as long as the relays
    // took to answer (Part 4 review; the §J3 backfill had the same placement). Idempotent — it
    // NULLs the columns it copied, so a second start finds nothing to do.
    migrateProofSet(db);

    // The stratum server MUST share this minerManager — sessions are created there on login and
    // read here (/api/pool/stats, per-worker online flags, network map, poolstats, hashrate
    // tracker). Two instances = an API that never sees a miner. See the StratumServer ctor note.
    stratumServer = new StratumServer(config, minerManager);
    stratumServer.setBlockManager(blockManager);
    // Stratum pause (design §21.5): read the persisted pause BEFORE any bind. Binding first and
    // closing after would reopen intake for a moment at every restart of a paused pool, and the
    // gateways' HAProxy would push waiting miners straight in. A missing row = accepting; a row
    // that cannot be read fails CLOSED (paused ≤ 2 h).
    stratumPause = new StratumPause({ db, stratumServer });
    const stratumBootPaused = stratumPause.load();
    stratumServer.start({ paused: stratumBootPaused });

    // Wire upstream node stratum → pool stratum server.
    // NodeStratumClient receives job notifications from the Grin node and calls
    // stratumServer.setNewJob(), which broadcasts them to all connected miners.
    // It also forwards miner submits to the node for PoW validation.
    nodeStratumClient = new NodeStratumClient(config, stratumServer);
    stratumServer.setNodeStratumClient(nodeStratumClient);
    nodeStratumClient.start();

    // Arm the pause tick (15 s) and run the boot re-derive: an expired pause resumes now, a planned
    // window that started while the process was down converts to a pause, one wholly missed is
    // dropped. After the node client is wired, so a boot resume opens intake onto a pool that can
    // forward submits. Never fatal — a failure leaves the boot state in place for the next tick.
    stratumPause.start().catch((err) => {
      console.error(`[${new Date().toISOString()}] [stratum-pause] boot evaluate failed: ${err.message}`);
    });

    blockMonitor = new BlockMonitor(config);
    blockMonitor.start();

    // Node availability (design §20): the pool's own 30 s node probe + the node box's recorder
    // ledger, recorded side by side for admin → Node availability and the homepage `up_days`.
    // It calls the same GrinNodeAPI object but runs its OWN loop — never block-monitor's timing,
    // which sits on the money path. A failure here must not stop the pool.
    try {
      nodeAvailability = new NodeAvailability(config, db, blockMonitor.grinNode).start();
      nodeStratumClient.onLinkChange = (up) => nodeAvailability.noteStratumLink(up);
    } catch (e) {
      nodeAvailability = null;
      console.error(`[${new Date().toISOString()}] [node-availability] not started: ${e.message}`);
    }

    // Let BlockManager capture per-block network difficulty (for round effort / luck) by reusing
    // the block monitor's node client. Optional — creditBlock leaves it NULL if unavailable.
    if (blockMonitor.grinNode) blockManager.setNodeApi(blockMonitor.grinNode);

    // Pass BlockMonitor's node client: RewardDistributor re-verifies each block against the
    // chain immediately before crediting, and that check is a no-op without it (audit §I3).
    rewardDistributor = new RewardDistributor(config, blockMonitor.grinNode);
    blockMonitor.setRewardDistributor(rewardDistributor);
    console.log(`[${new Date().toISOString()}] Reward distributor initialized (PPLNS window: 60 blocks)`);

    // Incentive system: prize pool, join bonus, jackpot, streaks, lottery. All no-ops unless
    // enabled in the admin panel. LotteryManager reuses the block monitor's node client for
    // its verifiable draw seed.
    incentivesManager = new IncentivesManager(config);
    adsManager = new AdsManager(config);
    try {
      if (adsManager.seedSelfPromo()) console.log(`[${new Date().toISOString()}] [ads] seeded 4 starter self-promo banners (header/sidebar×2/footer)`);
    } catch (e) { console.error(`[ads] self-promo seed failed: ${e.message}`); }
    pagesManager = new PagesManager(config);
    postsManager = new PostsManager(config);
    // One starter post so /blog is not empty on a fresh pool (and so the permalink, RSS
    // and social-card path have something to exercise). Marker-guarded: edited or deleted,
    // it stays that way. Non-fatal — a blog seed must never stop the pool booting.
    try {
      if (postsManager.seedStarterPost()) {
        console.log(`[${new Date().toISOString()}] [blog] seeded the starter post (/blog/why-grin-mining-adds-up)`);
      }
      // Give the starter post its shipped cover on pools that seeded it before the artwork
      // existed — the seed above cannot, it never runs twice. Same non-fatal treatment.
      if (postsManager.backfillStarterCover()) {
        console.log(`[${new Date().toISOString()}] [blog] backfilled the starter post cover image`);
      }
    } catch (e) { console.error(`[blog] starter post seed failed: ${e.message}`); }

    // Media uploads (cover images + in-body images from the admin CMS editor). Stored in a
    // persistent dir OUTSIDE public_html (which is rsynced/overwritten by the installer):
    // <db dir>/uploads, served at /uploads — by nginx in production (location /uploads/) and
    // by the express.static fallback below in dev / if the nginx block is absent.
    // path.resolve so the containment assert in POST /api/admin/media compares like with
    // like — a relative uploads_dir (dev default) would otherwise never equal path.dirname().
    uploadsDir = path.resolve(config.uploads_dir || path.join(path.dirname(config.db_path || './pool.db'), 'uploads'));
    try { fs.mkdirSync(uploadsDir, { recursive: true }); }
    catch (e) { console.error(`[media] could not create uploads dir ${uploadsDir}: ${e.message}`); }
    // Declared-MIME gate only — cheap and spoofable. The decisive check is the magic-byte
    // sniff in the route handler; see §A and audit §J10-1. Until 2026-09-02 this map ALSO
    // chose the stored extension, so `Content-Type: image/svg+xml` on a file of arbitrary
    // bytes wrote a `.svg` that nginx then served as image/svg+xml — the exact defect §A
    // fixed on the branding-asset endpoint, never applied to this one. The serve-time
    // sandbox CSP on /uploads/ was the only thing left standing between it and stored XSS.
    const ALLOWED_IMG = { 'image/jpeg': 1, 'image/png': 1, 'image/gif': 1, 'image/webp': 1, 'image/svg+xml': 1 };
    mediaUpload = multer({
      // memoryStorage, like the asset endpoint: nothing untrusted reaches disk until the
      // bytes have been sniffed and we have chosen the filename ourselves.
      storage: multer.memoryStorage(),
      limits: { fileSize: 5 * 1024 * 1024, files: 1 },  // 5 MB, single file
      fileFilter: (req, file, cb) => {
        if (Object.prototype.hasOwnProperty.call(ALLOWED_IMG, file.mimetype)) return cb(null, true);
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
      // Reveal first, then commit: a draw commits to a seed block ~10 blocks ahead of the tip
      // and is only resolved once the chain reaches it (audit §I8), so every tick settles what
      // the previous one committed before opening anything new.
      lotteryManager.resolveCommittedDraws()
        .catch((e) => console.error(`[Lottery] reveal tick failed: ${e.message}`))
        .then(() => {
          lotteryManager.runDueDraws().catch((e) => console.error(`[Lottery] scheduler tick failed: ${e.message}`));
          lotteryManager.runDueCampaigns().catch((e) => console.error(`[Campaigns] scheduler tick failed: ${e.message}`));
        });
    }, 3600 * 1000);

    walletTor = new WalletTor(config);
    console.log(`[${new Date().toISOString()}] Wallet Tor integration initialized`);

    // Pass the Owner-API wallet so the scheduler can drive the slatepack payout rail.
    withdrawalScheduler = new WithdrawalScheduler(config, wallet);
    withdrawalScheduler.start();

    // Goblin/Nostr payout bridge (design §15). OFF unless nostr_payouts_enabled. Constructed
    // and started here so a missing nostr-tools install (feature enabled but `npm install`
    // not yet run) logs a warning and leaves the feature disabled instead of crashing boot.
    // The scheduler and bridge are cross-wired post-construction: the scheduler sends via the
    // bridge; the bridge hands incoming response slatepacks back to the scheduler to finalize.
    if (config.nostr_payouts_enabled) {
      try {
        nostrBridge = new NostrPayoutBridge(config, db);
        nostrBridge.setResponseHandler((wid, addr, slatepack, senderPub) =>
          withdrawalScheduler.finalizeNostrWithdrawal(wid, addr, slatepack, senderPub));
        withdrawalScheduler.nostrBridge = nostrBridge;
        await nostrBridge.start();
      } catch (e) {
        console.error(`[nostr-payout] disabled — ${e.message}`);
        nostrBridge = null;
        withdrawalScheduler.nostrBridge = null;
      }
    }

    // One-time in-place coarsening of historical miner audit IPs to network prefixes
    // (/24, /48). Synchronous — truncation only, no KDF — and idempotent.
    migrateAuditLogIps(db);

    authManager = new AuthManager(config);
    // Live session policy. A provider function (not a snapshot) so changing the timeout in
    // Access Control takes effect on the next token issue, with no restart. Every read is
    // clamped inside auth.js and falls back to 1 h idle / 12 h absolute if this throws —
    // PoolSettings is constructed before AuthManager, but a DB hiccup must not brick login.
    authManager.sessionPolicyProvider = () => {
      const s = poolSettings.getSection('access');
      return {
        idle_seconds: Number(s.session_timeout_hours) * 3600,
        absolute_seconds: Number(s.session_absolute_hours) * 3600
      };
    };
    console.log(`[${new Date().toISOString()}] Authentication manager initialized`);

    hashrateTracker = new HashrateTracker(config, minerManager);
    // Hourly network-hashrate sample for the durable rollup (homepage pool-vs-network trend).
    // Reuses the block monitor's node client; the tracker calls this at most once per completed
    // hour and stores NULL when the node is unreachable. 60s-target formula, same constants as
    // /api/pool/effort: GPS = diff × 42 / 60 / 16384 (CLAUDE.md hashrate formula).
    hashrateTracker.networkGpsProvider = async () => {
      if (!blockMonitor || !blockMonitor.grinNode || !blockManager) return null;
      const tip = await blockMonitor.grinNode.getTip();
      const diff = await blockManager._fetchNetworkDifficulty(tip.height);
      return (diff && diff > 0) ? (diff * 42) / 60 / 16384 : null;
    };
    hashrateTracker.start();

    // Network-map peer snapshot (feeds /api/network/peers). Every 20 min, read each running
    // Grin node's peers, geolocate each to a COUNTRY ONLY (lib/geoip), and upsert
    // network_peers keyed by a hash of net+IP — the raw address is never stored. Rows
    // accumulate a rolling country picture; the endpoint windows them (default 30d). No-op
    // when geoip-lite is not installed (available() false → lookups return null).
    //
    // TWO reads per node, and the second is the one that carries the volume:
    //  • get_connected_peers — the live seats (8 outbound by default + whatever inbound the
    //    firewall lets in). Sticky connections, so over 30 days this alone yields tens of
    //    distinct nodes, not the hundreds the network has.
    //  • get_peers (the node's PEER STORE) — the node itself crawls the network in the
    //    background (grin v5.5 seed.rs `monitor_peers`: ~100 handshake probes every 20 s) and
    //    records each success as `last_connected`, then drops the probe connection when it
    //    already has enough outbound peers — so a node it verified 10 minutes ago is in the
    //    store but never in the connected list. Store rows are stamped with the NODE's own
    //    `last_connected`, so the endpoint's window measures when the handshake happened, not
    //    when we noticed; `last_connected: 0` = gossip-only address never reached, skipped.
    //    Steady state only rows newer than the previous snapshot are pushed (1 h overlap).
    //
    // Dual-network: a Grin node only peers within its OWN network (mainnet 3414 / testnet
    // 13414 are separate graphs), so besides this pool's own node we opportunistically read
    // the OTHER network's node too — that is how the map shows mainnet (green) + testnet
    // (pink) peers at once. The toolkit typically runs both nodes on the box; a network whose
    // node isn't running simply contributes nothing (both reads return [] on error).
    let otherNetNode = null;
    try {
      const ownIsMain = /^main/i.test(config.network || '');
      const otherNet = ownIsMain ? 'testnet' : 'mainnet';
      const otherUrl = ownIsMain ? 'http://127.0.0.1:13413' : 'http://127.0.0.1:3413';
      // mainnet may run as an archive (full) node — prefer whichever dir actually holds a secret.
      const dirs = otherNet === 'mainnet'
        ? ['/opt/grin/node/mainnet-full', '/opt/grin/node/mainnet-prune']
        : ['/opt/grin/node/testnet-prune'];
      const otherDir = dirs.find((d) => { try { return fs.existsSync(path.join(d, '.api_secret')); } catch (_) { return false; } });
      if (otherDir) {
        otherNetNode = new GrinNodeAPI({ network: otherNet, node_api_url: otherUrl, node_dir: otherDir });
        console.log(`[network-map] dual-network peer sensor: also reading ${otherNet} node at ${otherUrl}`);
      }
    } catch (e) {
      console.error(`[network-map] other-net node init failed: ${e.message}`);
    }

    const peerSources = [];
    if (blockMonitor && blockMonitor.grinNode) {
      peerSources.push({ node: blockMonitor.grinNode, net: /^main/i.test(config.network || '') ? 'main' : 'test' });
    }
    if (otherNetNode) {
      peerSources.push({ node: otherNetNode, net: /^main/i.test(otherNetNode.network || '') ? 'main' : 'test' });
    }
    for (const src of peerSources) _peerSensorNets[src.net] = true;

    // Upper bound of the endpoint's ?window (90 d): store rows older than that can never be
    // shown, so the first pass after boot doesn't bother writing them.
    const PEER_STORE_HORIZON_S = 90 * 86400;
    const PEER_WRITE_CHUNK = 500;
    let peerStoreMark = 0;   // `now` of the last snapshot that committed; 0 = none yet
    const storeWarned = {};  // per net: warned once that get_peers yields nothing
    const snapshotNetworkPeers = async () => {
      try {
        if (!geoip.available()) return;
        const now = Math.floor(Date.now() / 1000);
        const since = peerStoreMark ? peerStoreMark - 3600 : now - PEER_STORE_HORIZON_S;
        // key → row carrying the earliest and latest stamp seen in this batch: a node in both
        // the live list (`now`) and the store (its handshake time) is ONE write, and neither
        // stamp is lost — first_seen stays the handshake, last_seen the live sighting.
        const rows = new Map();
        const push = (net, addr, seen) => {
          const ip = String(addr || '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '');  // strip :port / [v6]
          const geo = geoip.lookupCountry(ip);
          if (!geo) return;
          // Key includes net so the same IP running BOTH a mainnet and a testnet node yields
          // two distinct rows instead of one flipping the other's colour on ON CONFLICT.
          const key = crypto.createHash('sha256').update(net + '|' + ip).digest('hex').slice(0, 32);
          const prev = rows.get(key);
          if (!prev) rows.set(key, { key, cc: geo.cc, name: geo.name, net, first: seen, last: seen });
          else { if (seen < prev.first) prev.first = seen; if (seen > prev.last) prev.last = seen; }
        };
        for (const src of peerSources) {
          const live = await src.node.getConnectedPeers();
          for (const p of live || []) push(src.net, p.addr || p.address, now);
          const store = await src.node.getPeerStore();
          // Every connected peer is saved to the store on handshake, so an empty store beside
          // a non-empty live list means the get_peers call itself failed (getPeerStore swallows
          // errors) — say so once, or the map silently falls back to the ~8-seat count while
          // the page copy still promises the peer store.
          if ((!store || !store.length) && live && live.length && !storeWarned[src.net]) {
            storeWarned[src.net] = true;
            console.error(`[network-map] ${src.net}: get_peers returned nothing while ${live.length} peers are connected — peer-store sensor inactive, node count will stay low`);
          }
          for (const p of store || []) {
            const t = Number(p.last_connected) || 0;
            if (t >= since) push(src.net, p.addr, t);
          }
        }
        if (!rows.size) return;
        // MAX/MIN, not plain overwrite: a live sighting stamped `now` and the store's older
        // `last_connected` for the same node can arrive in consecutive snapshots in either order.
        const upsert = db.prepare(`
          INSERT INTO network_peers (peer_key, country_code, country, net, first_seen, last_seen)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(peer_key) DO UPDATE SET
            country_code = excluded.country_code, country = excluded.country, net = excluded.net,
            first_seen = MIN(first_seen, excluded.first_seen),
            last_seen = MAX(last_seen, excluded.last_seen)`);
        const writeChunk = db.transaction((rs) => { for (const r of rs) upsert.run(r.key, r.cc, r.name, r.net, r.first, r.last); });
        // Chunked, yielding between chunks: the first pass after boot can be a few thousand
        // rows and this DB is the same synchronous handle the share path writes through — one
        // long transaction would stall share acceptance for its whole duration. Steady-state
        // passes are a handful of rows and finish in one chunk. Idempotent, so a failure
        // mid-way just leaves `peerStoreMark` where it was and the next pass re-covers it.
        const all = Array.from(rows.values());
        for (let i = 0; i < all.length; i += PEER_WRITE_CHUNK) {
          writeChunk(all.slice(i, i + PEER_WRITE_CHUNK));
          if (i + PEER_WRITE_CHUNK < all.length) await new Promise((r) => setImmediate(r));
        }
        peerStoreMark = now;
      } catch (e) {
        console.error(`[network-map] peer snapshot failed: ${e.message}`);
      }
    };
    setInterval(snapshotNetworkPeers, 20 * 60 * 1000);
    setTimeout(snapshotNetworkPeers, 30 * 1000); // first snapshot shortly after boot

    // Initialize poolstats reporter (push to miningpoolstats.stream)
    poolstatsReporter = new PoolstatsReporter(config, {
      blockManager,
      minerManager,
      stratumServer,
      hashrateTracker
    });
    poolstatsReporter.start();

    // Initialize rate limiter. Do NOT provide an inline fallback here: rate-limiter.js
    // owns the defaults (public 1200 / auth 200 / api 600 / admin 2400 — the 2026-06
    // "loosen now" posture). An earlier fallback object here (admin: 10/min) silently
    // overrode those via Object.assign and 429'd the admin settings pages.
    rateLimiter = new RateLimiter({
      rate_limits: config.rate_limits
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
      alertDelivery,
      nodeAvailability
    }, db);
    alertMonitor.start();
    console.log(`[${new Date().toISOString()}] Alert monitor started`);

    // Database retention/cleanup — prunes shares (only below the PPLNS+maturity-safe
    // floor), old hashrate history, and resolved alerts. Configurable in the admin
    // panel → Database / Cleanup. File space is reclaimed by the weekly VACUUM cron.
    retentionManager = new RetentionManager(config);
    retentionManager.start();

    // Abandoned-balance disposition — sweeps balances of long-dormant addresses (default 24mo,
    // OFF until enabled in admin → Payout) into the community prize pool. Freeze-aware,
    // grandfathered, FINAL. No-op every pass while disabled. See lib/dormancy.js.
    dormancyManager = new DormancyManager(config);
    dormancyManager.start();
    console.log(`[${new Date().toISOString()}] Dormancy manager started`);

    // Every HTTP route, in match order (routes/index.js). Instances and state built above go in
    // ctx; none of them is reassigned after this call.
    registerRoutes(app, {
      config, db, wallet, stratumServer, stratumPause, blockManager, shareValidator, minerManager,
      blockMonitor, rewardDistributor, incentivesManager, lotteryManager, walletTor, withdrawalScheduler,
      nostrBridge, authManager, hashrateTracker, poolstatsReporter, rateLimiter, ipFilter, alertMonitor,
      alertDelivery, poolSettings, assetManager, retentionManager, nodeAvailability, dormancyManager,
      adsManager, pagesManager, postsManager, uploadsDir, mediaUpload, _peerSensorNets,
      gamesLink, loginCaptcha,
      adminLoginFailures, admin2faFailures, ADMIN_LOGIN_FAIL_THRESHOLD, ADMIN_LOGIN_FAIL_WINDOW_MS,
      ADMIN_LOGIN_BAN_MS, ADMIN_FAIL_MAP_MAX, ADMIN_2FA_FAIL_THRESHOLD,
      donorNameRule,
    });

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

process.on('SIGINT', () => {
  console.log(`\n[${new Date().toISOString()}] Shutting down gracefully...`);
  process.exit(0);
});

initializePool();
