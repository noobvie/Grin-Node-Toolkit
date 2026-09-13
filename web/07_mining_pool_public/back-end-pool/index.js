#!/usr/bin/env node

const express = require('express');
const path = require('path');
const { initDb, getDb, ensureLocalRegion, seedDefaultRegions } = require('./lib/db');
const { loadConfig, mergeDbSettings } = require('./lib/config');
const { computeReconciliation, auditWalletSends, probeWalletIdentity, adoptWalletIdentity } = require('./lib/reconciliation');
const PoolSettings = require('./lib/pool-settings');
const AssetManager = require('./lib/asset-manager');
const WalletAPI = require('./lib/wallet');
const StratumServer = require('./lib/stratum-server');
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
// requireAuth is deliberately NOT imported: it is the non-admin guard, its only caller was
// /api/auth/change-password, and that route now runs requireAdmin. It stays exported from
// auth-middleware.js as the primitive the other two are built on — see §J1/§J2.
const { requireAdmin, requireFreshAuth } = require('./lib/auth-middleware');
const HashrateTracker = require('./lib/hashrate-tracker');
const { getHorizon: getLedgerRollupHorizon } = require('./lib/ledger-rollup');
const { verifyOwnerProof, auditOwnerProof, normalizeIp, migrateOwnerProofHashes, migrateAuditLogIps, backfillProofAnchors } = require('./lib/owner-proof');
const geoip = require('./lib/geoip');
const PoolstatsReporter = require('./lib/poolstats-reporter');
const RateLimiter = require('./lib/rate-limiter');
const IpFilter = require('./lib/ip-filter');
const AlertMonitor = require('./lib/alert-monitor');
const AlertDelivery = require('./lib/alert-delivery');
const RetentionManager = require('./lib/retention');
const DormancyManager = require('./lib/dormancy');
const AdsManager = require('./lib/ads');
const PagesManager = require('./lib/pages');
const PostsManager = require('./lib/posts');
const multer = require('multer');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const net = require('net');
const { execSync, execFile } = require('child_process');

// ─── grin-gateway-ctl bridge (design §13.2/§13.3) ────────────────────────────
// The root helper is the SINGLE WireGuard mutation path (peer add/remove +
// region_ports persistence), shared with the CLI (Script 07 menu W). The
// de-rooted grin-pool-manager reaches it via a one-line scoped sudoers entry
// (pool_deroot); `sudo -n` never blocks on a password prompt. argv array only —
// never a shell string — and the helper re-validates every input itself.
const GWCTL = '/usr/local/bin/grin-gateway-ctl';
// timeoutMs defaults to the 10s that suits every peer/list/status call. Only
// init-server needs more — it may install wireguard-tools inside the request —
// and it passes its own; do NOT raise the default, because the cached liveness
// read sits behind it and a slow helper there stalls the public patch bay.
function gwctl(args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const net = (config && config.network === 'testnet') ? 'testnet' : 'mainnet';
    execFile('sudo', ['-n', GWCTL, ...args, '--net', net],
      { timeout: timeoutMs || 10000, maxBuffer: 1024 * 1024 }, (err, stdout) => {
        let out = null;
        try { out = JSON.parse(String(stdout || '').trim()); } catch (e) { /* not JSON */ }
        if (out && out.ok) return resolve(out);
        reject(new Error((out && out.error) ? out.error : (err ? err.message : 'gateway helper failed')));
      });
  });
}

// Per-region tunnel liveness for the health endpoint: helper `status` first
// (works de-rooted, adds rx/tx), silent fallback to the direct root-only read
// below so an old install (no helper/sudoers yet) or a gateway-only box
// degrades to share-recency status exactly as before (§13.9 step 5).
// Returns { available, regions } — `available` says whether we could READ WireGuard at all,
// which is NOT the same as "there are peers". An empty `regions` used to be returned for both
// "wg unreadable" and "wg readable, zero peers configured", so a pool with no gateway paired
// yet judged every declared region live and painted the whole patch bay blue/idle. Keep the
// two apart: available=true + no entry for a region means that region has NO tunnel.
async function readGatewayStatus() {
  try {
    const st = await gwctl(['status']);
    const out = {};
    for (const g of st.gateways || []) {
      // Include peers that have NEVER handshaked (handshake 0/absent). A present-but-zero
      // entry means "peer declared, tunnel never came up" → regionStatus() treats the 0
      // handshake as stale → offline. (`wg show latest-handshakes` prints 0 the same way.)
      if (!g.region) continue;
      out[g.region] = { handshake: g.handshake || 0, rx_bytes: g.rx_bytes, tx_bytes: g.tx_bytes };
    }
    return { available: true, regions: out };
  } catch (e) {
    return readWgHandshakes();
  }
}

// Best-effort WireGuard handshake per region (Model C gateway liveness). Maps each peer's
// public key → region using the "# region: <name>" comment the installer writes above every
// [Peer] in the central wg config, then reads `wg show ... latest-handshakes`. The iface is
// per-network to match the bash installer (07 pool menu W): mainnet "wg-grinpool", testnet
// "wg-grinpool-tn".
// Legacy/fallback path — requires root (reads /etc/wireguard); readGatewayStatus() is the
// primary. Returns { available: true, regions: { <region>: { handshake: <unix_ts> } } };
// available:false on ANY failure (wg not installed, not the central box, no permission,
// dev/Windows) so callers fall back to the stratum probe / share-activity signals.
function readWgHandshakes() {
  const out = {};
  let available = false;
  try {
    const iface = (config && config.network === 'testnet') ? 'wg-grinpool-tn' : 'wg-grinpool';
    const conf = fs.readFileSync(`/etc/wireguard/${iface}.conf`, 'utf8');
    const pubToRegion = {};
    let curRegion = null;
    for (const line of conf.split('\n')) {
      const rm = line.match(/^\s*#\s*region:\s*(.+?)\s*$/i);
      if (rm) { curRegion = rm[1]; continue; }
      const pm = line.match(/^\s*PublicKey\s*=\s*(.+?)\s*$/i);
      if (pm && curRegion) { pubToRegion[pm[1]] = curRegion; curRegion = null; }
    }
    const dump = execSync(`wg show ${iface} latest-handshakes`, { timeout: 2000 }).toString();
    available = true;  // we READ wg — an empty peer list below is now real information
    for (const line of dump.split('\n')) {
      const [pub, ts] = line.trim().split(/\s+/);
      if (pub && ts && pubToRegion[pub]) out[pubToRegion[pub]] = { handshake: parseInt(ts, 10) || 0 };
    }
  } catch (e) { /* wg unavailable — stratum probe / share activity are used instead */ }
  return { available, regions: out };
}

// Cached wrapper for the public /api/pool/stats/regions + /api/pool/topology paths: those
// endpoints are unauthenticated and polled by every open dashboard, so calling
// readGatewayStatus() (which spawns grin-gateway-ctl / `wg show`) on every hit is a needless
// per-request subprocess. SYNCHRONOUS stale-while-revalidate: the caller always gets the
// cached snapshot immediately and a stale one is refreshed in the background — a liveness
// read must NEVER sit in front of the region list (gwctl carries a 10s exec timeout, which
// on a cold cache used to stall the whole patch bay before it could paint). The admin
// endpoint keeps its own uncached await (low call volume, wants ground truth).
const GW_STATUS_TTL_MS = 15000;
let _gwStatusCache = { ts: 0, running: false, data: { available: false, regions: {} } };
function cachedGatewayStatus() {
  if (!_gwStatusCache.running && Date.now() - _gwStatusCache.ts > GW_STATUS_TTL_MS) {
    _gwStatusCache.running = true;
    readGatewayStatus()
      .then((d) => { _gwStatusCache.data = d; })
      .catch(() => { /* keep the previous snapshot */ })
      .then(() => { _gwStatusCache.ts = Date.now(); _gwStatusCache.running = false; });
  }
  return _gwStatusCache.data;
}

// Active wire check: TCP-dial a region's PUBLIC stratum host:port — the exact path a miner's
// rig takes. Resolves ms-to-connect on success, null on refuse/timeout/DNS fail. Never rejects.
// Connect-only (no stratum handshake): proves the region's HAProxy/listener is up and
// reachable, which is all the edge can prove without a fake miner login.
function probeStratumTcp(host, port, timeoutMs = 2500) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let sock, settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      try { sock.destroy(); } catch (e) { /* already gone */ }
      resolve(ok ? Date.now() - t0 : null);
    };
    try { sock = net.connect({ host, port: +port }); } catch (e) { return resolve(null); }
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

// Public per-region reachability cache (feeds the patch bay + network map).
// WireGuard alone cannot answer "can a miner mine here?" for a region that has no peer at
// all — a seeded/declared endpoint with nothing behind it looked identical to a healthy quiet
// one. This dials the advertised stratum_url instead, entirely OUT of the request path:
// endpoints read the snapshot and kick a refresh only when it is stale, so a public hit never
// waits on a dial. Two consecutive failures before calling a region down (a single dial can
// lose to a momentary egress hiccup); a region with no verdict yet reports 'checking', never
// a guess.
const STRATUM_PROBE_TTL_MS = 60000;
const STRATUM_PROBE_STRIKES = 2;
let _stratumProbe = { ts: 0, running: false, byRegion: new Map() };
function refreshStratumProbes(locations) {
  if (_stratumProbe.running) return;
  if (Date.now() - _stratumProbe.ts < STRATUM_PROBE_TTL_MS) return;
  const targets = [];
  for (const l of locations || []) {
    const m = String(l.stratum_url || '').replace(/^\w+:\/\//, '').match(/^([^:/]+):(\d+)$/);
    if (m) targets.push({ region: l.region, host: m[1], port: m[2] });
  }
  if (!targets.length) { _stratumProbe.ts = Date.now(); return; }
  _stratumProbe.running = true;
  Promise.all(targets.map(async (t) => {
    const ms = await probeStratumTcp(t.host, t.port);
    const prev = _stratumProbe.byRegion.get(t.region) || { fails: 0 };
    _stratumProbe.byRegion.set(t.region, {
      ok: ms !== null,
      fails: ms !== null ? 0 : prev.fails + 1,
      ms,
      ts: Math.floor(Date.now() / 1000)
    });
  })).catch(() => { /* probeStratumTcp never rejects; belt and braces */ })
    .then(() => { _stratumProbe.ts = Date.now(); _stratumProbe.running = false; });
}
// true = reachable · false = confirmed unreachable · null = no verdict yet (never probed,
// or one lone failure that has not been confirmed).
function stratumVerdict(region) {
  const p = _stratumProbe.byRegion.get(region);
  if (!p) return null;
  if (p.ok) return true;
  return p.fails >= STRATUM_PROBE_STRIKES ? false : null;
}

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
app.use(express.json());
app.use(cookieParser());

// True when a request arrived DIRECTLY on loopback (the trusted operator on the box —
// e.g. Script 07's guided installer hitting 127.0.0.1:8080), NOT proxied in from nginx.
// The app binds 127.0.0.1 only, and trust proxy='loopback' rewrites req.ip to the real
// client IP for anything coming through nginx (which always sets XFF). So a loopback req.ip
// can ONLY be a direct on-box call. Used to skip the anti-robot CAPTCHA for setup-time admin
// registration — the captcha exists to slow REMOTE brute force, not the local root operator.
//
// ⚠ The premise above is only true of a vhost where EVERY proxied location sets
// X-Forwarded-For, and §J12-3 found four that did not (the SEO file proxies) — on those,
// req.ip was nginx's own 127.0.0.1 for every visitor on Earth. The vhost is fixed, but an
// invariant that depends on a config file agreeing with it is not an invariant. So this now
// requires BOTH halves: a loopback socket AND no forwarding header at all. A request that
// came through nginx always carries one, so a genuine direct on-box call is the only thing
// that can satisfy both — and the next route someone proxies without the header inherits a
// refusal, not "the trusted root operator".
function isLocalRequest(req) {
  if (req.headers && req.headers['x-forwarded-for']) return false;
  const ip = String(req.ip || '').replace('::ffff:', '');
  return ip === '127.0.0.1' || ip === '::1';
}

// Config integrity hash — compared against <config>.sha256 on every startup.
// Takes the RAW FILE BYTES, not the merged config object (audit §J9-6): the merged object
// carries the systemd environment and every per-network default, so hashing it made a unit-file
// edit or a toolkit upgrade look like tampering.
function hashConfig(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

// Security headers middleware
app.use((req, res, next) => {
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'");
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

// Public-surface address masking (grin1qxy…mn4p). The same truncation the front-end already
// applies when rendering, moved server-side on the aggregate/list endpoints: the pages look
// identical, but the raw API stops handing a scraper a full-address list in one call. NOT used
// on /api/account/:addr responses — there the caller already knows the address (it's identity).
//
// ⚠ THIS IS NOT DE-IDENTIFICATION, and it never was (audit §J11-1). Nine leading plus four
// trailing bech32 characters is a UNIQUE key: given any list of full addresses, every masked
// row re-attaches to its own by a plain table join. It only works as a control while NO public
// route publishes a full address — which is why, as of 2026-09-02, every public list endpoint
// that carries an address masks it, and the account-page deep-link was removed from the three
// leaderboards, the payouts table and the donor wall (those links were the full-address source
// that inverted the mask everywhere else). The invariant to keep:
//
//     NO public route may emit an unmasked grin_address in a LIST.
//
// `/api/account/:addr/*` is the one exception and is not a list — the caller supplied the
// address, so returning it reveals nothing. Adding a full address to any aggregate feed
// re-opens §J11-1 for `/api/pool/miners`, `/api/stratum/stats` and `/api/pool/unclaimed` at
// the same time, and `/api/pool/unclaimed` is the expensive one: its rows are balances whose
// owners are provably not watching. scripts/test-public-leakage.js asserts the invariant.
function maskAddr(a) {
  const s = String(a || '');
  return s.length > 16 ? `${s.slice(0, 9)}…${s.slice(-4)}` : s;
}

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
  // db_path comes from the operator's own root-written pool.json, so this guards a TYPO
  // (a stray path that would silently create a second, empty ledger somewhere unexpected),
  // not an attacker. It was an `includes()` substring test, which is not the same question:
  // `/tmp/x/./y` and `/opt/grin/../../tmp/y` both contained an accepted fragment and passed.
  // Anchor it instead — installed pools write /opt/grin/pubpool/<net>/pool.db, the dev/manual
  // fallback is a ./ relative path — and reject traversal outright.
  if (!cfg.db_path || typeof cfg.db_path !== 'string') {
    throw new Error(`Invalid db_path: ${cfg.db_path}`);
  }
  if (cfg.db_path.split(/[\\/]/).includes('..')) {
    throw new Error(`Invalid db_path (path traversal): ${cfg.db_path}`);
  }
  if (!cfg.db_path.startsWith('/opt/grin/') && !cfg.db_path.startsWith('./')) {
    throw new Error(
      `Invalid db_path: ${cfg.db_path} (must be under /opt/grin/ or a ./ relative dev path)`
    );
  }
  if (!cfg.stratum_port || cfg.stratum_port < 1024 || cfg.stratum_port > 65535) {
    throw new Error(`Invalid stratum_port: ${cfg.stratum_port}`);
  }
  // Pool fee must be 0-50% (prevent fee theft).
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
let dormancyManager = null;
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

    config = validateConfig(config);

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

    // One-time background upgrade of legacy plaintext ownership-proof IPs to salted hashes
    // (owner-proof.js v1$ format). Non-blocking; verify accepts both forms while it runs.
    migrateOwnerProofHashes(db);

    // One-time in-place coarsening of historical miner audit IPs to network prefixes
    // (/24, /48). Synchronous — truncation only, no KDF — and idempotent.
    migrateAuditLogIps(db);

    // Seed the write-once proof anchor (§J3-4) from the proof each existing account already
    // holds. MUST stay synchronous and MUST stay ahead of the stratum listener: if an account
    // reached its first post-upgrade capture anchorless, whoever mined that share — not the
    // owner — would become its permanent proof.
    backfillProofAnchors(db);

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
    // Grin node's connected peers, geolocate each to a COUNTRY ONLY (lib/geoip), and upsert
    // network_peers keyed by a hash of net+IP — the raw address is never stored. Rows
    // accumulate a rolling country picture; the endpoint windows them (default 30d). No-op
    // when geoip-lite is not installed (available() false → lookups return null).
    //
    // Dual-network: a Grin node only peers within its OWN network (mainnet 3414 / testnet
    // 13414 are separate graphs), so besides this pool's own node we opportunistically read
    // the OTHER network's node too — that is how the map shows mainnet (green) + testnet
    // (pink) peers at once. The toolkit typically runs both nodes on the box; a network whose
    // node isn't running simply contributes nothing (getConnectedPeers returns [] on error).
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

    const snapshotNetworkPeers = async () => {
      try {
        if (!geoip.available()) return;
        const now = Math.floor(Date.now() / 1000);
        const sources = [];
        if (blockMonitor && blockMonitor.grinNode) {
          sources.push({ node: blockMonitor.grinNode, net: /^main/i.test(config.network || '') ? 'main' : 'test' });
        }
        if (otherNetNode) {
          sources.push({ node: otherNetNode, net: /^main/i.test(otherNetNode.network || '') ? 'main' : 'test' });
        }
        const rows = [];
        for (const src of sources) {
          const peers = await src.node.getConnectedPeers();
          if (!peers || !peers.length) continue;
          for (const p of peers) {
            const addr = String(p.addr || p.address || '');
            const ip = addr.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');  // strip :port / [v6]
            const geo = geoip.lookupCountry(ip);
            if (!geo) continue;
            // Key includes net so the same IP running BOTH a mainnet and a testnet node yields
            // two distinct rows instead of one flipping the other's colour on ON CONFLICT.
            const key = crypto.createHash('sha256').update(src.net + '|' + ip).digest('hex').slice(0, 32);
            rows.push({ key, cc: geo.cc, name: geo.name, net: src.net });
          }
        }
        if (!rows.length) return;
        const upsert = db.prepare(`
          INSERT INTO network_peers (peer_key, country_code, country, net, first_seen, last_seen)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(peer_key) DO UPDATE SET
            country_code = excluded.country_code, country = excluded.country,
            net = excluded.net, last_seen = excluded.last_seen`);
        db.transaction((rs) => { for (const r of rs) upsert.run(r.key, r.cc, r.name, r.net, now, now); })(rows);
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
      alertDelivery
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
  // ─── One shape check for the whole /api/account/ family (audit §J3-8) ──────────────────
  // Every route under /api/account/:addr took the address straight from the URL with no
  // validation at all. Two of them then interpolated it into a Content-Disposition filename,
  // and several did work for an address that has never existed here. One gate in front of the
  // whole block is better than thirteen sanitisers: nothing downstream has to wonder whether
  // `:addr` could be a quote, a control character, or 4 KB of junk.
  //
  // Deliberately mounted on the PATH rather than declared with app.param('addr', …): the
  // admin panel uses `:addr` too and legitimately addresses the `prize_pool` / `pool_fee`
  // pseudo-accounts, which are not bech32 and must keep working there.
  //
  // The segment is read from req.path and decoded here rather than read from req.params,
  // because inside a mounted middleware Express rebuilds params per layer — so a check
  // written against req.params can silently inspect something other than what the route
  // handler later receives (the trap recorded in memory project_comms_hub_09).
  const GRIN_ADDR_RE = /^t?grin1[ac-hj-np-z02-9]{58}$/;
  app.use('/api/account', (req, res, next) => {
    const seg = String(req.path || '').split('/')[1] || '';
    let addr;
    try { addr = decodeURIComponent(seg); } catch (e) { addr = seg; }
    if (!GRIN_ADDR_RE.test(addr)) {
      // Same 404 shape an unknown-but-well-formed address already gets, so this adds no new
      // signal — a malformed address and an address that never mined here are both "not here".
      return res.status(404).json({ error: 'Account not found' });
    }
    next();
  });

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

  // Is TOTP 2FA mandatory for admins right now? Read live from the DB (not the startup-merged
  // config) so flipping the toggle takes effect without a service restart.
  let _totpMandatoryReadFailAt = 0;
  const totpIsMandatory = () => {
    try {
      return String(poolSettings.getSection('access').require_admin_totp) === 'true';
    } catch (e) {
      // Fail OPEN on a settings read error. Failing closed here would brick every step-up
      // endpoint — including the ones needed to fix the settings — on a transient DB error.
      //
      // But say so (audit §J9-7). This is the only fail-OPEN security switch in the pool, and
      // until this line it downgraded mandatory 2FA to optional in complete silence: no log,
      // no alert, no audit row. Throttled to one line a minute so a persistently broken DB
      // cannot flood the journal on a per-request read.
      const now = Date.now();
      if (now - _totpMandatoryReadFailAt > 60000) {
        _totpMandatoryReadFailAt = now;
        console.error(
          `[SECURITY] access.require_admin_totp is unreadable (${e.message}) — mandatory 2FA ` +
          `is being treated as OFF until the settings read succeeds. Check the database.`
        );
      }
      return false;
    }
  };

  // Enforcement for access.require_admin_totp. Applied to the STEP-UP chain only, so an
  // un-enrolled admin keeps a normal session (and can therefore reach 2FA enrollment) but
  // cannot move money or run destructive actions until 2FA is on. See the setting's comment
  // in lib/pool-settings.js for why this isn't a login refusal.
  const requireTotpEnrolled = (req, res, next) => {
    if (!totpIsMandatory()) return next();
    if (authManager.isTotpEnabled(req.user.user_id)) return next();
    return res.status(403).json({
      error: 'This pool requires two-factor authentication for admin actions. Set up 2FA to continue.',
      totp_enrollment_required: true
    });
  };

  // Step-up gate for money/destructive admin actions: same as secureAdmin but also requires
  // a PASSWORD re-verification within the last 5 min (requireFreshAuth → token.pwa). A live
  // (or stolen) session alone is not enough — the client must call /api/admin/reauth first.
  const STEP_UP_MAX_AGE_S = 300;
  const freshAdmin = [
    rateLimiter.middleware('admin'),
    ipFilter.middleware('admin'),
    requireFreshAuth(authManager, STEP_UP_MAX_AGE_S),
    requireTotpEnrolled
  ];

  // Step-up WITHOUT the mandatory-2FA gate. Used only by the 2FA ENROLLMENT endpoints: on a
  // pool with require_admin_totp on, an admin who hasn't enrolled must be able to reach the
  // very endpoints that enroll them. Putting requireTotpEnrolled in front of enrollment would
  // make the requirement unsatisfiable and hard-lock the panel — recoverable only via the
  // break-glass CLI. Do NOT reuse this chain for anything else.
  const freshAdminEnroll = [
    rateLimiter.middleware('admin'),
    ipFilter.middleware('admin'),
    requireFreshAuth(authManager, STEP_UP_MAX_AGE_S)
  ];

  // Step-up applied CONDITIONALLY, from inside a `secureAdmin` handler, for routes where only
  // some requests are sensitive (a settings section that carries fee/whitelist keys; a region
  // save that carries a wg pubkey). Returns true when it has already answered the request.
  //
  // It exists because those two handlers previously inlined a bare `isTokenFresh()` call, which
  // reproduced requireFreshAuth but silently dropped requireTotpEnrolled — so on a pool with
  // access.require_admin_totp ON, an un-enrolled admin was refused by every freshAdmin route
  // yet could still write the `payout` section with a password-only re-auth (audit §I7).
  // Both halves of the step-up contract live here now; do not re-inline either one.
  const stepUpRefused = (req, res) => {
    if (!authManager.isTokenFresh(req.token, STEP_UP_MAX_AGE_S)) {
      res.status(403).json({ error: 'Session expired', challenge_required: true });
      return true;
    }
    if (totpIsMandatory() && !authManager.isTotpEnabled(req.user.user_id)) {
      res.status(403).json({
        error: 'This pool requires two-factor authentication for admin actions. Set up 2FA to continue.',
        totp_enrollment_required: true
      });
      return true;
    }
    return false;
  };

  // Auto-ban bookkeeping for the two login steps: count failures per IP within the window,
  // temp-ban on threshold. `kind` selects the counter — 'password' and '2fa' are tracked
  // independently (see ADMIN_2FA_FAIL_THRESHOLD), so a run of rejected codes can never
  // consume the password budget or vice versa.
  const recordAdminLoginFailure = (ip, kind = 'password') => {
    const isTwofa = kind === '2fa';
    const store = isTwofa ? admin2faFailures : adminLoginFailures;
    const threshold = isTwofa ? ADMIN_2FA_FAIL_THRESHOLD : ADMIN_LOGIN_FAIL_THRESHOLD;
    const now = Date.now();
    // Sweep expired entries before adding a new one (audit §J12-11). Both maps were pruned
    // ONLY on the next failure from the same IP, or on threshold/success — so an IP that
    // failed once and never came back held its entry for the life of the process. Each entry
    // costs an attacker a solved CAPTCHA, which is why this is a tidy-up rather than a fix for
    // a live lever, but "grows forever" is not a property a security counter should have.
    // Amortised: only runs when a NEW IP appears, and only past a floor no real pool reaches.
    if (!store.has(ip) && store.size >= ADMIN_FAIL_MAP_MAX) {
      for (const [k, v] of store) {
        if (now - v.firstAt > ADMIN_LOGIN_FAIL_WINDOW_MS) store.delete(k);
      }
    }
    let rec = store.get(ip);
    if (!rec || now - rec.firstAt > ADMIN_LOGIN_FAIL_WINDOW_MS) rec = { count: 0, firstAt: now };
    rec.count++;
    store.set(ip, rec);
    if (rec.count >= threshold) {
      ipFilter.tempBan(ip, ADMIN_LOGIN_BAN_MS);
      store.delete(ip);
      try {
        db.prepare(`INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, details, ip)
                    VALUES (NULL, 'ip_autoban', 'security', ?, ?, ?)`)
          .run(ip, JSON.stringify({
            reason: isTwofa ? 'failed_admin_2fa_codes' : 'failed_admin_logins',
            threshold,
            ban_minutes: ADMIN_LOGIN_BAN_MS / 60000
          }), ip);
      } catch (e) { /* non-fatal */ }
    }
  };

  // Cookie lifetimes must track the live session policy, not a hardcoded hour. A cookie that
  // outlives its token is harmless (the request 401s and the client refreshes), but a cookie
  // that dies FIRST silently logs the operator out mid-session with a valid token in hand —
  // which is exactly the bug that made "session timeout" feel arbitrary.
  const accessCookieOpts = () => ({
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: authManager.sessionPolicy().idle * 1000
  });
  // The refresh cookie is capped at the ABSOLUTE session limit: past that, refreshAccessToken
  // refuses anyway, so holding the cookie for the full 7 days would only invite pointless
  // 401s. Whichever is shorter wins.
  const refreshCookieOpts = () => ({
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: Math.min(authManager.refreshTokenExpiresIn, authManager.sessionPolicy().abs) * 1000
  });

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
  //
  // MEMOISED 60 s — the same window the Cache-Control header already advertised, but on the
  // box rather than as a hint to the client (audit §J12-8). This is the most-hit endpoint in
  // the product: every public page fetches it on every load. Each rebuild was five uncached
  // `getSection()` queries (pool-settings.js has no memo of its own), plus asset lookups, an
  // incentives summary and a lottery read — and §J9-8 established that ~40 of the strings it
  // republishes are bounded only by express.json()'s 100 KB PER-REQUEST body limit, so the
  // response size is an operator-set number with no ceiling. Caching does not fix that (the
  // length caps are still §J9-8's open item); it stops it being paid per request.
  //
  // Keyed on req.hostname because `connection.stratum_host` falls back to it.
  // Invalidated explicitly on every settings/asset write (see invalidateBranding), so an
  // operator's edit shows up immediately; the TTL is the backstop for the inputs that are NOT
  // settings writes — the prize-pool figure and the lottery schedule. Those have their own
  // live endpoints (/api/pool/prize-pool), so 60 s of staleness here costs nothing.
  const BRANDING_TTL_MS = 60000;
  let _brandingCache = new Map();   // hostname -> { at, payload }
  const invalidateBranding = () => { _brandingCache = new Map(); };
  app.get('/api/public/branding',
    rateLimiter.middleware('public'),
    (req, res) => {
      try {
        const ckey = String(req.hostname || '');
        const hit = _brandingCache.get(ckey);
        if (hit && (Date.now() - hit.at) < BRANDING_TTL_MS) {
          res.setHeader('Cache-Control', 'public, max-age=60');
          return res.json({ success: true, data: hit.payload });
        }
        const assetUrlFor = (type) => {
          const asset = assetManager.getActiveAsset(type);
          return asset ? assetManager.getAssetUrl(asset.filename) : '';
        };
        const cfg = poolSettings.buildPublicConfig(assetUrlFor);
        // Same derivation siteOrigin() uses, so branding.js's client-side canonical / og:url /
        // JSON-LD agree with the server-rendered ones on the two SSR routes. Without this the
        // blanked site_url default (§J10-4) would simply drop the canonical off every page that
        // is NOT server-rendered, instead of correcting it.
        if (!cfg.seo.site_url && config.subdomain) {
          cfg.seo.site_url = 'https://' + String(config.subdomain).replace(/\/+$/, '');
        }
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
        // Bound the key space: hostname is attacker-chosen (any Host header nginx passes
        // through), so this is a cache, not a registry. Drop the oldest insert past the cap.
        if (_brandingCache.size >= 32) {
          _brandingCache.delete(_brandingCache.keys().next().value);
        }
        _brandingCache.set(ckey, { at: Date.now(), payload: cfg });
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
  // NEGATIVE cache. The success path was cached; the failure path was not, and `_priceCache.ts`
  // was only ever stamped alongside a good value — so any upstream refusal turned this into a
  // per-request outbound fetch, forever (audit §J12-6). At the ~10 req/s nginx allows from one
  // host that is up to 50 concurrent 5-second HTTPS sockets held open by an anonymous client,
  // plus whatever reputation the pool's egress IP earns upstream. 60 s is short enough that a
  // recovered upstream is picked up quickly and long enough that failure is not free to trigger.
  const PRICE_FAIL_TTL_MS = 60 * 1000;
  let _priceFailAt = 0;
  let _priceInflight = null;
  // ⚠ CoinGecko 403s a request with no DESCRIPTIVE User-Agent ("Please add a descriptive
  // User-Agent to your request"), and Node's fetch sends the bare string `node`. Every other
  // CoinGecko caller in this toolkit (06_price_collector.py, 07_mining_block_collector.py,
  // 06b_grinscan/server.js, 06d_tiny_explorer) had to gain one for the same reason; this one
  // was written without it. Memory project_grin_btc_price_source.
  const PRICE_UA = `grin-mining-pool/1.0 (+Grin Node Toolkit; ${config.network || 'mainnet'})`;
  const fetchPrice = async () => {
    const ctrl = AbortSignal.timeout ? AbortSignal.timeout(5000) : undefined;
    const r = await fetch(
      'https://api.coingecko.com/api/v3/simple/price?ids=grin&vs_currencies=usd,btc',
      { signal: ctrl, headers: { accept: 'application/json', 'user-agent': PRICE_UA } }
    );
    if (!r.ok) throw new Error('upstream ' + r.status);
    const j = await r.json();
    const g = j && j.grin ? j.grin : {};
    const data = {
      available: typeof g.usd === 'number' || typeof g.btc === 'number',
      usd: typeof g.usd === 'number' ? g.usd : null,
      btc: typeof g.btc === 'number' ? g.btc : null,
      source: 'coingecko',
      updated_at: Date.now(),
    };
    // A 200 that carries no number is a failure too — it must arm the negative cache, or an
    // upstream that has quietly dropped the `grin` id becomes the per-request fetch again.
    if (!data.available) throw new Error('upstream returned no price');
    return data;
  };
  app.get('/api/public/price',
    rateLimiter.middleware('public'),
    async (req, res) => {
      const now = Date.now();
      res.setHeader('Cache-Control', 'public, max-age=300');
      if (_priceCache.data && (now - _priceCache.ts) < PRICE_TTL_MS) {
        return res.json({ success: true, data: _priceCache.data });
      }
      // Still inside the failure cool-off → answer from last-good (or "unavailable") without
      // touching the network at all.
      if ((now - _priceFailAt) < PRICE_FAIL_TTL_MS) {
        return res.json({ success: true, data: _priceCache.data || { available: false } });
      }
      // Collapse concurrent misses onto one outbound call.
      if (!_priceInflight) {
        _priceInflight = fetchPrice()
          .then((data) => { _priceCache = { ts: Date.now(), data }; return data; })
          .catch(() => { _priceFailAt = Date.now(); return null; })
          .then((data) => { _priceInflight = null; return data; });
      }
      const data = await _priceInflight;
      // Serve stale-if-error; otherwise report unavailable (footer hides the ticker).
      res.json({ success: true, data: data || _priceCache.data || { available: false } });
    }
  );

  // ─── Public API reference — auto-generated from the live Express route table ───
  // Always accurate for WHICH routes exist (it reflects the routes actually mounted); only
  // public-safe prefixes are exposed, so admin/auth routes are never listed. api-docs.html
  // renders this. An unmapped route still appears (with an empty description) so the LIST can
  // never drift — but the per-endpoint metadata below is hand-maintained and CAN drift, so
  // treat it as documentation, not as introspection.
  //
  // `shape` matters more than it looks. This API is NOT uniform: the /api/public/* CMS-era
  // routes return { success: true, data: … } while almost everything older returns the payload
  // raw (often a bare array), and errors are ALWAYS { error: "…" } with no success flag on any
  // of them. The page used to claim a single envelope for all of it, which is wrong for ~70% of
  // the endpoints and breaks the first client anyone writes. Publishing the real shape per
  // endpoint is cheaper and more honest than retrofitting one envelope onto 30 live routes that
  // the pool's own front-end already consumes.
  //   envelope = { success: true, data: … }   flat = { success: true, …fields }
  //   raw      = payload at the top level     array = bare JSON array
  //   none     = 204 No Content
  // `params`  — query string, with the caps the handler actually enforces.
  // `body`    — request body fields, for the POST/DELETE rails.
  // `auth`    — ownership proof required (lib/owner-proof.js), otherwise public.
  // `gated`   — an operator setting that makes the route 404 when off.
  // `rate`    — which rate-limiter bucket applies (see this.limits in lib/rate-limiter.js).
  const PUBLIC_API_PREFIXES = [
    '/api/public/', '/api/account/', '/api/config/', '/api/pool/',
    // Added 2026-07-28. These are public, rate-limited, and consumed by the pool's own pages
    // (reactor-dashboard.js, miners-stats.html, network-map.js) — they were simply invisible to
    // the reference because the prefix list predated them. An undocumented public endpoint is
    // not a private one; it is a public one nobody can use correctly.
    '/api/stratum/', '/api/network/',
  ];
  const OWNER_PROOF_BODY = 'proof (recent mining IP or the rig\'s stratum password; legacy alias ip_proof)';
  const API_DOC_META = {
    // ── Public ────────────────────────────────────────────────────────────────
    'GET /api/public/branding': { desc: 'White-label config (name, theme, SEO, social, footer links).', shape: 'envelope' },
    'GET /api/public/price': { desc: 'Cached GRIN price (USD + BTC) from CoinGecko. Serves the last good value on upstream failure; { available: false } if never fetched.', shape: 'envelope' },
    'GET /api/public/endpoints': { desc: 'This API reference (machine-readable).', shape: 'envelope' },
    'GET /api/public/ads': { desc: 'Active operator ads by placement (+ rotation interval). Cached 60s, so ad edits take up to a minute to appear.', shape: 'raw', params: 'placement (omit for every slot keyed by placement)' },
    'POST /api/public/ads/event': { desc: 'Ad impression/click beacon — aggregate counters only, no visitor data. Always 204, even on a malformed body.', shape: 'none', body: 'impressions[], clicks[] (ad ids)' },
    'GET /api/public/lottery/winners': { desc: 'Fortune-board winner history (truncated addresses). Empty when incentives are disabled.', shape: 'envelope', params: 'limit (≤100, default 25) · offset' },
    'GET /api/public/lottery/stats': { desc: 'Fortune-board aggregates: total prizes/winners/draws, Pot A/B split, monthly series.', shape: 'envelope' },
    'GET /api/public/pages': { desc: 'Published CMS pages (slug + title) for the header/footer link lists.', shape: 'envelope' },
    'GET /api/public/page/:key': { desc: 'One published CMS page by slug (About / Terms / Privacy / FAQ …). 404 if the slug is unknown or unpublished.', shape: 'envelope' },
    'GET /api/public/posts': { desc: 'Blog: paginated list of published posts (card view — excerpt, cover, date).', shape: 'envelope', params: 'limit · offset' },
    'GET /api/public/post/:slug': { desc: 'Blog: one published post in full, by slug. 404 if unknown or unpublished.', shape: 'envelope' },

    // ── Config ────────────────────────────────────────────────────────────────
    'GET /api/config/pool-info': { desc: 'Pool terms: network, pool fee %, minimum withdrawal, the flat per-payout withdrawal fee (0 = the pool absorbs the network fee), address format and which listener a miner needs.', shape: 'raw' },

    // ── Pool ──────────────────────────────────────────────────────────────────
    'GET /api/pool/stats': { desc: 'Live pool stats: block totals, active miners, connections, and share quality (accepted/stale/rejected). Share quality is LIVE in-memory only — it is empty with no connected sessions and resets on disconnect.', shape: 'raw' },
    'GET /api/pool/status': { desc: 'Coarse service health for the status strip: pool up, node reachable/synced/peers/height, wallet reachable. Never exposes balances or addresses.', shape: 'raw' },
    'GET /api/pool/stats/regions': { desc: 'Per-region stratum endpoints + live status (online | idle | offline) and 15-minute regional hashrate. On a MULTI-region pool a k-anonymity floor applies: a region with 0 < miners < min_bucket reports miners/hashrate_gps/shares_window as null with below_floor:true — that is withheld, not zero (a real zero is still 0). Totals are always exact.', shape: 'raw' },
    'GET /api/pool/locations': { desc: 'Operator-declared stratum regions that are currently active — region key, label, and the stratum URL to point a rig at.', shape: 'raw' },
    'GET /api/pool/blocks': { desc: 'Pool-found blocks, newest first. A short page (fewer rows than limit) means the last page. found_by is MASKED (grin1qxy…mn4p).', shape: 'array', params: 'limit (≤500, default 50) · offset · status=immature|confirmed|orphaned' },
    'GET /api/pool/blocks/history': { desc: 'Durable block series: luck, per-period counts, status split, cumulative reward. Blocks are never pruned, so any range is meaningful.', shape: 'raw', params: 'range=week|month|year|all (default month)' },
    'GET /api/pool/effort': { desc: 'Pool network share, luck over the last 100 blocks, current round effort, and time since the last block. Network difficulty is cached ~60s.', shape: 'raw' },
    'GET /api/pool/hashrate/history': { desc: 'Pool hashrate time-series, summed across addresses per bucket.', shape: 'raw', params: 'hours (1–720, default 24)' },
    'GET /api/pool/poolstats': { desc: 'Listing feed for pool directories — this is the URL to hand to miningpoolstats.stream (they poll it; nothing is pushed). Pool + network aggregates in the same field layout as the toolkit\'s solo-mining poolstats_<net>.json, so an importer written for that needs no changes. Recomputed at most once every 60s and served from cache in between, so polling faster than 1/min returns identical bytes — 1–5 min is the sensible range. Every value is an aggregate already shown on the homepage; no address or per-miner row is included, so it needs no auth. The ts field is the generation time: if it stops advancing, the feed is stale. Fields are null (not 0) when the node is unreachable, and network.hashrate_gps_24h is null until the pool has an hour of history.', shape: 'raw' },
    'GET /api/pool/metrics/history': { desc: 'Durable pool trend series: hashrate, miners, earnings, payout, network hashrate. Rolled up hourly and never pruned.', shape: 'raw', params: 'range=day|week|month|year|all (default day)' },
    'GET /api/pool/metrics/history/regions': { desc: 'Per-region miners/hashrate trend series (the "miners by gateway" view). Same k-anonymity floor as /api/pool/stats/regions, applied per point: below the floor miner_count and hashrate_gps are null with below_floor:true. Draw a null as a GAP, never as 0.', shape: 'raw', params: 'range=day|week|month|year|all (default day)' },
    'GET /api/pool/payments/history': { desc: 'Durable payments & transparency series: payouts, reward split, giveaways, donations, fee, plus lifetime totals.', shape: 'raw', params: 'range=day|week|month|year|all (default month)' },
    'GET /api/pool/payments': { desc: 'Recent confirmed payouts: address, amount, flat fee charged, method and timestamps. The on-chain kernel is NOT published here — pool-wide it would be a public address-to-chain index; it is available per address on /api/account/:addr/withdrawals. Pool-internal payout machinery (slate id, Tor probe result, retry state, cancel reason) is deliberately not published either.', shape: 'array', params: 'limit (≤500, default 100)' },
    'GET /api/pool/miners': { desc: 'Balance distribution across accounts, richest first. Addresses are MASKED (grin1qxy…mn4p) — the distribution is public, the address→balance mapping is not.', shape: 'array', params: 'limit (≤500, default 50)' },
    'GET /api/pool/top-block-finders': { desc: 'Lucky-miner leaderboard: blocks found and total reward per address over a recent window. Orphans do not count as a find. Addresses are MASKED.', shape: 'raw', params: 'days (≤3650, default 30) · limit (≤1000, default 500)' },
    'GET /api/pool/unclaimed': { desc: 'Lost-and-found: masked addresses of long-dormant balances with a per-address disposal countdown, plus the historical disposition ledger (sweeps into the prize pool).', shape: 'raw', params: 'limit (≤200, default 100)' },
    'GET /api/pool/donors': { desc: 'Donor wall: per-address lifetime donations to the prize pool, first/last donation date, current donate-tag %. Top 100. Addresses are MASKED.', shape: 'raw' },
    'GET /api/pool/prize-pool': { desc: 'Prize-pool transparency report: current balance + LIFETIME in/out totals by source (fee-cut, donations, operator top-ups, abandoned balances, orphan clawbacks). Per-event rows are deliberately withheld — their timestamps would expose the cadence of discretionary operator top-ups.', shape: 'raw' },
    'GET /api/pool/topology': { desc: 'Network map: hub → gateways → miners aggregated BY COUNTRY. Country-only geolocation; no per-miner coordinate is ever resolved or stored, and countries under the k-anonymity floor merge into one unnamed bucket.', shape: 'raw', gated: 'the operator publishes the network map (off by default → 404)' },

    // ── Stratum (live session aggregates) ─────────────────────────────────────
    'GET /api/stratum/stats': { desc: 'Live stratum server state: connection counts and per-session share tallies. Session addresses are truncated so the live list cannot be scraped to enumerate miners.', shape: 'raw' },
    'GET /api/stratum/hashrate': { desc: 'Pool hashrate aggregates (1h/24h GPS) plus the fixed top-10 by hashrate (addresses MASKED) — the gauge on the homepage.', shape: 'raw' },
    'GET /api/stratum/top-miners': { desc: 'Top miners by hashrate over a recent window — the paginated contribution leaderboard. Addresses are MASKED.', shape: 'raw', params: 'window minutes (≤1440, default 1440) · limit (≤1000, default 500)' },
    'GET /api/stratum/top-avg-hashrate': { desc: 'Top miners by AVERAGE hashrate over a multi-day window (sustained contribution). Backed by hashrate_history, so a 30-day window is meaningful. Addresses are MASKED.', shape: 'raw', params: 'days (≤90, default 30) · limit (≤1000, default 500)' },

    // ── Network ───────────────────────────────────────────────────────────────
    'GET /api/network/peers': { desc: 'Grin P2P peers this node has seen, aggregated by country over a rolling window (+ mainnet/testnet split). Country-only, no IPs; thin countries merge into one unnamed bucket.', shape: 'raw', params: 'window days (1–90, default 30)', gated: 'the operator publishes the network map (off by default → 404)' },

    // ── Account (address-as-identity: the address IS the credential to READ) ──
    'GET /api/account/:addr': { desc: 'Account summary: balance, locked, lifetime paid, pending payout, share/hashrate snapshot, active donation %, and when the ownership evidence on record last changed. 404 if the address has never mined here OR is not a well-formed Grin address.', shape: 'raw' },
    'GET /api/account/:addr/shares': { desc: 'Raw accepted shares for an address, newest first. Shares are pruned aggressively — use the hashrate history for anything older than ~a day.', shape: 'raw', params: 'limit (≤500, default 100) · offset' },
    'GET /api/account/:addr/workers': { desc: 'Per-worker (rig) hashrate + share quality over a recent window.', shape: 'raw', params: 'window minutes (1–1440, default 10)' },
    'GET /api/account/:addr/hashrate/history': { desc: 'Account hashrate time-series, downsampled for charting.', shape: 'raw', params: 'hours (1–720, default 24)' },
    'GET /api/account/:addr/earnings': { desc: 'Credited earnings per period (1h/24h/7d/30d) + 30d in/out totals. Payout reversals count as money-in but never as earnings.', shape: 'raw' },
    'GET /api/account/:addr/balance/log': { desc: 'Address ledger. Raw rows prune after ~60 days (the durable record is the withdrawal history below). format=csv streams the filtered window as a download on a tighter rate limit.', shape: 'raw · csv', params: 'direction=in|out · days (≤3650, default all) · limit (≤500, default 50) · offset · format=csv' },
    'GET /api/account/:addr/withdrawals': { desc: 'Payout history for an address — kept forever, so this is the durable record for accounting. Payouts only: no donations or orphan clawbacks. format=csv streams all-time on a tighter rate limit. The on-chain kernel is NOT returned here — rows carry has_kernel_proof (boolean) and the kernels themselves need an ownership proof; see POST /api/account/:addr/withdrawals/proofs.', shape: 'raw · csv', params: 'limit (≤200, default 20) · offset · format=csv' },
    'POST /api/account/:addr/withdrawals/proofs': { desc: 'On-chain payment proofs (kernel excess) for your own payouts. Returns { proofs: { <withdrawal id>: <kernel> } } for every confirmed payout that has one. Ownership-gated on purpose: publishing an address next to its kernels would be a public address-to-chain index on a privacy coin, so this is the one account field that costs a proof. 403 = proof failed, 404 = no such account.', shape: 'raw', auth: 'ownership proof', rate: 'withdraw', body: OWNER_PROOF_BODY },
    'GET /api/account/:addr/tor-check': { desc: 'Is this miner\'s wallet reachable over Tor right now? Read-only probe behind the payout UI hint. online is TRI-STATE: true/false when known, null = "decided at payout time". 404 if the address has never mined here — the probe is not offered for arbitrary Grin addresses. Answers are cached 60s per address; the payout gate always re-probes fresh.', shape: 'raw', rate: 'torcheck' },
    'POST /api/account/:addr/withdraw': { desc: 'Request a payout on one of three rails. 403 = ownership proof failed; 409 (tor) = wallet unreachable, retry or switch to slatepack; 409 (nostr) = destination unregistered, still in cooldown, or its npub changed.', shape: 'flat', auth: 'ownership proof', rate: 'withdraw', body: `method=tor|slatepack|nostr (default tor) · amount · ${OWNER_PROOF_BODY}` },
    'POST /api/account/:addr/withdraw/:id/finalize': { desc: 'Complete a slatepack payout by posting back the response slatepack your wallet produced with `receive`. The pool finalizes and broadcasts.', shape: 'raw', auth: 'ownership proof', rate: 'withdraw', body: `response_slatepack · ${OWNER_PROOF_BODY}` },
    'POST /api/account/:addr/nostr-destination': { desc: 'Register/replace the Goblin username for Nostr payouts. Does NOT move funds — it pins the destination and (re)starts a security cooldown, during which the nostr rail refuses to pay. Needs BOTH proofs, and each must have been on record for at least the cooldown period — a 409 reason of proof_too_recent means the evidence is newer than that, and anchor_not_accepted_here means the original recorded proof was used (it can withdraw, but not redirect). 503 when the rail is disabled.', shape: 'flat', auth: 'ownership proof', rate: 'withdraw', body: `username (Goblin/NIP-05) · ${OWNER_PROOF_BODY}` },
    'DELETE /api/account/:addr/nostr-destination': { desc: 'Remove the registered Goblin payout destination, clearing the pin and cooldown.', shape: 'flat', auth: 'ownership proof', rate: 'withdraw', body: OWNER_PROOF_BODY },
  };
  app.get('/api/public/endpoints',
    rateLimiter.middleware('public'),
    (req, res) => {
      try {
        // Express 4: the route table hangs off app._router. Express 5 renames it to app.router,
        // so accept either — otherwise a major-version bump would silently empty this page
        // rather than fail loudly (the catch below would never even fire).
        const router = req.app._router || req.app.router;
        const stack = (router && router.stack) || [];
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
              const meta = API_DOC_META[key] || {};
              out.push({
                method: m,
                path: p,
                description: meta.desc || '',
                shape: meta.shape || '',
                params: meta.params || '',
                body: meta.body || '',
                auth: meta.auth || '',
                gated: meta.gated || '',
                rate_limit: meta.rate || 'public',
              });
            }
          }
        }
        out.sort((a, b) => (a.path === b.path ? a.method.localeCompare(b.method) : a.path.localeCompare(b.path)));
        res.setHeader('Cache-Control', 'public, max-age=300');
        res.json({
          success: true,
          data: {
            count: out.length,
            endpoints: out,
            // Cross-cutting facts the page states once instead of on every row.
            notes: {
              errors: 'Errors are always { "error": "…" } with an HTTP status — never { success: false }.',
              cors: 'Public GETs send Access-Control-Allow-Origin: * (no credentials). POST/DELETE are same-origin only.',
              rate_limits: rateLimiter && rateLimiter.limits
                ? { public: rateLimiter.limits.public, withdraw: rateLimiter.limits.withdraw, export: rateLimiter.limits.export }
                : null,
              times: 'All timestamps are UNIX seconds (UTC).',
            },
          },
        });
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
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 25, 1), 100);
        const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
        res.setHeader('Cache-Control', 'public, max-age=60');
        res.json({ success: true, data: lotteryManager.winnerHistory(limit, offset) });
      } catch (err) {
        res.status(500).json({ error: 'Failed to load winners' });
      }
    }
  );

  // Aggregate fortune-board stats (headline tiles + charts). Covers all history, unlike the
  // paginated winners feed above. Empty payload when incentives are disabled.
  app.get('/api/public/lottery/stats',
    rateLimiter.middleware('public'),
    (req, res) => {
      try {
        if (!incentivesManager || !incentivesManager.enabled()) {
          return res.json({
            success: true,
            data: { total_prizes_grin: 0, total_winners: 0, unique_winners: 0, total_draws: 0, by_pot: [], by_event: [], monthly: [] },
          });
        }
        res.setHeader('Cache-Control', 'public, max-age=60');
        res.json({ success: true, data: lotteryManager.stats() });
      } catch (err) {
        res.status(500).json({ error: 'Failed to load lottery stats' });
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
  // Resolve the canonical site origin: configured site_url > installer-set subdomain > Host.
  function siteOrigin(req) {
    const seo = poolSettings.getSection('seo');
    if (seo.site_url) return String(seo.site_url).replace(/\/+$/, '');
    // Installer-set (pool.json `subdomain`, lib/config.js) and therefore NOT client-controlled.
    // It sits ahead of the Host header on purpose: `seo.site_url` used to ship non-empty for
    // every pool (audit §J10-4), so this fallback is new reachable ground and the Host header
    // is attacker-supplied on a vhost that is the box's default :443 server.
    if (config.subdomain) return 'https://' + String(config.subdomain).replace(/\/+$/, '');
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

  // Public pages included in the sitemap. Each URL MUST match that page's own
  // <link rel="canonical"> exactly (the .html form, except the dashboard, whose canonical
  // is the bare origin + '/') — a sitemap URL that
  // differs from the page's canonical makes Google crawl a non-canonical variant.
  // pool-info + connect were merged into the dashboard (index) 2026-06; the dashboard
  // carries the #connect + #info anchors, so only / is listed for that content.
  const SITEMAP_PATHS = ['/', '/miners-stats.html', '/blocks.html', '/network-map.html', '/payment-history.html', '/fortune-board.html', '/donate.html', '/blog.html', '/api-docs.html'];

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

  // ─── Blog + CMS permalinks with server-rendered <head> (nginx proxies these) ───
  // post.html and page.html are JS shells: they fetch their content and set the title
  // client-side. Google renders JS, but Twitter/Facebook/Discord/Telegram/Slack do NOT —
  // so every shared post or About/Terms link unfurled as "Loading…" with no description
  // and no image, and those URLs are all in sitemap.xml. These routes serve the SAME
  // static shell with the head filled in first, so a crawler gets real metadata and a
  // browser gets the identical page it did before (the client script then runs and
  // rewrites the same values — idempotent, no flicker).

  const HEAD_MARK = '</head>';
  const shellCache = new Map(); // filename → contents; only a restart clears it (no reload signal)

  function readShell(name) {
    if (shellCache.has(name)) return shellCache.get(name);
    let html = null;
    try {
      // Resolve inside web_dir only — `name` is a hardcoded literal at every call
      // site, never user input, but keep the join anchored anyway.
      html = fs.readFileSync(path.join(config.web_dir, name), 'utf8');
    } catch (e) {
      console.warn(`[seo] cannot read ${name} from web_dir (${config.web_dir}): ${e.message}` +
        ' — serving a minimal shell instead. Set "web_dir" in the pool config to fix.');
    }
    shellCache.set(name, html);
    return html;
  }

  // Minimal stand-in used only if web_dir is wrong/unreadable, so a misconfigured box
  // degrades to a working page rather than a 500. Loads the same assets as the real
  // shells; the per-page client script is what fills it in.
  function fallbackShell(bodyId) {
    return '<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="UTF-8">\n' +
      '<meta name="viewport" content="width=device-width, initial-scale=1.0">\n' +
      '<link rel="icon" type="image/svg+xml" href="/images/favicon.svg">\n' +
      '<link rel="stylesheet" href="/css/dashboard.css">\n' +
      '<link rel="stylesheet" href="/css/themes.css">\n</head>\n<body>\n' +
      '<main class="wrap" id="' + bodyId + '"></main>\n' +
      '<script src="/js/public-shell.js"></script>\n' +
      '<script src="/js/public-theme.js"></script>\n' +
      '<script src="/js/branding.js"></script>\n</body>\n</html>\n';
  }

  const attrEsc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  // Strip authored HTML to a plain-text description and cap it at a sane card length.
  const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'", nbsp: ' ' };
  function toDescription(html, fallback) {
    const text = String(html || '')
      // Drop script/style bodies FIRST — tag-stripping alone keeps their contents, so a
      // CMS page with an embedded <style> block put raw CSS in its social card.
      .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<[^>]*>/g, ' ')
      // Decode after tag-stripping (so escaped "&lt;b&gt;" text can never become a tag).
      // Without this, authored "&amp;" reached attrEsc() as literal text and came back
      // double-escaped — the card rendered "Bob &amp; Alice".
      .replace(/&(amp|lt|gt|quot|apos|nbsp|#39);/gi,
        (m, e) => ENTITIES[e.toLowerCase()] || m)
      .replace(/\s+/g, ' ')
      .trim();
    const out = text || String(fallback || '');
    return out.length > 200 ? out.slice(0, 197).trimEnd() + '…' : out;
  }

  // Build the <head> block injected ahead of </head>. The shells declare no description,
  // og:* or canonical, and sendShell() removes their static <title> before injecting this
  // one — a document may hold only one title and every parser keeps the FIRST, so leaving
  // it in place would have made this one dead markup.
  //
  // No <link rel="icon"> here: both shells already carry it, and a SECOND icon link would
  // break branding.js's operator-favicon override (setLinkRel updates the first match
  // while the browser honours the last). fallbackShell() carries its own.
  function seoHead({ title, description, canonical, image, type, publishedAt }) {
    const brand = poolSettings.getSection('branding');
    const siteName = brand.pool_name || 'Grin Mining Pool';
    const full = title ? `${title} — ${siteName}` : siteName;
    let h = '\n<title>' + attrEsc(full) + '</title>\n';
    // Marker read by branding.js: this page's metadata is per-item and server-rendered,
    // so the generic site-wide title/description/og template must NOT overwrite it.
    h += '<meta name="server-seo" content="1">\n';
    h += '<link rel="manifest" href="/manifest.json">\n';
    if (canonical) h += '<link rel="canonical" href="' + attrEsc(canonical) + '">\n';
    if (description) h += '<meta name="description" content="' + attrEsc(description) + '">\n';
    h += '<meta property="og:type" content="' + attrEsc(type || 'website') + '">\n';
    h += '<meta property="og:site_name" content="' + attrEsc(siteName) + '">\n';
    h += '<meta property="og:title" content="' + attrEsc(full) + '">\n';
    if (description) h += '<meta property="og:description" content="' + attrEsc(description) + '">\n';
    if (canonical) h += '<meta property="og:url" content="' + attrEsc(canonical) + '">\n';
    if (image) h += '<meta property="og:image" content="' + attrEsc(image) + '">\n';
    if (publishedAt) {
      h += '<meta property="article:published_time" content="' +
        attrEsc(new Date(publishedAt * 1000).toISOString()) + '">\n';
    }
    h += '<meta name="twitter:card" content="' + (image ? 'summary_large_image' : 'summary') + '">\n';
    h += '<meta name="twitter:title" content="' + attrEsc(full) + '">\n';
    if (description) h += '<meta name="twitter:description" content="' + attrEsc(description) + '">\n';
    if (image) h += '<meta name="twitter:image" content="' + attrEsc(image) + '">\n';
    return h;
  }

  // Remove the shell's own <title> so ours is the only one (HTML allows exactly one, and
  // browsers/Google keep the FIRST — leaving it makes the injected per-post title dead).
  //
  // Comments are MASKED first, and that is not paranoia: the shells carry an explanatory
  // comment that mentions "<title>" in prose. A naive regex matched that occurrence, ran
  // on to the real </title>, and deleted the comment's opening — leaving an unterminated
  // "<!--" that swallowed every stylesheet link after it. The page rendered with NO CSS at
  // all. Masking keeps offsets identical, so the match indices still address the original.
  function stripShellTitle(headHtml) {
    const masked = headHtml.replace(/<!--[\s\S]*?-->/g, (m) => '\u0000'.repeat(m.length));
    const m = /[ \t]*<title\b[^>]*>[\s\S]*?<\/title>[ \t]*\r?\n?/i.exec(masked);
    if (!m) return headHtml;
    return headHtml.slice(0, m.index) + headHtml.slice(m.index + m[0].length);
  }

  function sendShell(res, shellName, fallbackId, head) {
    const shell = readShell(shellName) || fallbackShell(fallbackId);
    const idx = shell.indexOf(HEAD_MARK);
    let html = shell;
    if (idx !== -1) {
      html = stripShellTitle(shell.slice(0, idx)) + head + shell.slice(idx);
    }
    res.setHeader('Cache-Control', 'no-cache');
    res.type('html').send(html);
  }

  // First <img src> in an authored HTML body, or '' when there is none. CMS pages have no
  // cover_image column (only posts do), so this is how a page gets a social card picture.
  // Accepts single, double or unquoted src values — the body is operator-authored, so it
  // is not guaranteed to be normalised markup.
  function firstBodyImage(html) {
    const m = /<img\b[^>]*?\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(String(html || ''));
    return m ? (m[1] || m[2] || m[3] || '') : '';
  }

  // Absolute URL for an image path that may already be absolute.
  const absImage = (origin, src) =>
    (!src ? '' : /^https?:\/\//i.test(src) ? src : origin + (src.startsWith('/') ? src : '/' + src));

  // /blog/<slug> — the clean post permalink. Plain :slug, no inline regex: Express 4's
  // path-to-regexp accepts `:slug([A-Za-z0-9_-]+)` but Express 5 THROWS on it at boot,
  // which would take the whole pool down over a blog route. Nothing needs it — nginx
  // already constrains the slug charset, getPublic() runs a parameterised query, and an
  // unknown slug renders the 404 shell. "/blog/rss.xml" is registered earlier, and
  // Express matches in registration order, so it still wins over this.
  app.get('/blog/:slug',
    rateLimiter.middleware('public'),
    (req, res) => {
      try {
        const origin = siteOrigin(req);
        const post = postsManager.getPublic(req.params.slug);
        if (!post) {
          // Still serve the shell (its client script renders a "post not found" state),
          // but say 404 so crawlers don't index a missing post.
          res.status(404);
          return sendShell(res, 'post.html', 'post-body', seoHead({
            title: 'Post not found', canonical: origin + '/blog/' + req.params.slug,
          }));
        }
        sendShell(res, 'post.html', 'post-body', seoHead({
          title: post.title,
          description: post.excerpt || toDescription(post.body_html, ''),
          canonical: origin + '/blog/' + post.slug,
          image: absImage(origin, post.cover_image),
          type: 'article',
          publishedAt: post.published_at,
        }));
      } catch (err) {
        res.status(500).type('text/plain').send('Error');
      }
    }
  );

  // /page.html?p=<key> — the CMS content pages (About / Terms / Privacy / FAQ …).
  app.get('/page.html',
    rateLimiter.middleware('public'),
    (req, res) => {
      try {
        const origin = siteOrigin(req);
        const key = String(req.query.p || '');
        const page = key ? pagesManager.getPublic(key) : null;
        if (!page) {
          // Two ways in: an unknown/unpublished key, or the bare shell with no ?p= at all.
          // Both 404 — /page.html on its own is a shell, not content, and is deliberately
          // absent from sitemap.xml. The shell's client script then fills the body with the
          // list of published pages so a visitor lands on an index, not a dead end. That
          // body is real linked content, so pair the status with an explicit noindex
          // (follow, so the listed pages are still discovered) and drop the canonical: a
          // canonical pointing at a noindex URL just gives a crawler two contradictory
          // signals about a page that should never be indexed in the first place.
          res.status(404);
          return sendShell(res, 'page.html', 'page-body',
            seoHead({ title: key ? 'Page not found' : 'Pages' }) +
            '<meta name="robots" content="noindex, follow">\n');
        }
        sendShell(res, 'page.html', 'page-body', seoHead({
          title: page.seo_title || page.title,
          description: page.seo_desc || toDescription(page.html, ''),
          canonical: origin + '/page.html?p=' + encodeURIComponent(page.key),
          // Pages carry no cover column, so the card picture is the first image in the
          // authored body, falling back to the site-wide card. Before this, every CMS page
          // unfurled on Twitter/Discord/Telegram as a bare text card with no image at all.
          image: absImage(origin, firstBodyImage(page.html) || '/images/og-image.svg'),
        }));
      } catch (err) {
        res.status(500).type('text/plain').send('Error');
      }
    }
  );

  // Issue a self-hosted CAPTCHA challenge for the login/register forms. On the `public`
  // bucket (1200/min) so the form can fetch one without spending the stricter `auth` budget
  // (200/min) — both are the ×20 "loosen now" values; see this.limits in lib/rate-limiter.js.
  app.get('/api/auth/captcha', rateLimiter.middleware('public'), (req, res) => {
    // Pass the client IP so the challenge store caps THIS source's outstanding challenges
    // instead of letting it evict everyone else's. This endpoint is unauthenticated and free
    // at 1200/min, and the store used to be one global 5000-entry Map evicting oldest-first —
    // so an anonymous flood locked the operator out of their own login form with no failed
    // login, no auto-ban and no audit row. See lib/captcha.js and audit §J2-4.
    res.json(loginCaptcha.issue(req.ip));
  });

  // Rate limiting + first-admin gating + httpOnly cookies.
  app.post('/api/auth/register',
    async (req, res) => {
      try {
        // Rate gate (peek, don't spend yet) — refuse early if locked/over budget.
        const rl = rateLimiter.peek('auth', req);
        if (!rl.allowed) return rateLimiter.sendLimited(res, rl);

        // ON-BOX ONLY (audit §J17-1). First-admin registration is open to whoever asks whenever
        // the users table holds no admin, and BOTH mitigations the pre-mainnet gate plan named
        // for that window are inert:
        //   · `admin_allowlist` is emitted into `location /admin/` and `location /api/admin/`
        //     only — this route is `/api/auth/`, which carries no allowlist at any setting.
        //   · "register before the vhost is publicly resolvable" is contradicted by the
        //     installer's own order: step 4 runs `certbot --nginx`, which REQUIRES public DNS
        //     and publishes the hostname to Certificate Transparency; the backend goes live at
        //     step 6 and the admin is not created until step 7.
        // And the window re-opens on a live, already-published pool every time pool.db is
        // reset (Script 07 → Reset Pool Database restarts the service immediately with zero
        // admins). The captcha below is not a barrier — it is single-digit `a+b`/`a×b` by its
        // own module description, there to price scripted brute force, not to stop one request.
        // The installer always POSTs to 127.0.0.1:<port> (pool_setup_admin), so this costs the
        // supported path nothing. Registering from another machine: SSH-forward the API port
        // (`ssh -L 8080:127.0.0.1:8080 root@pool`) and register against the forwarded port.
        if (!isLocalRequest(req)) {
          return res.status(403).json({
            success: false,
            error: 'Admin registration is on-box only. Run Script 07 → Create admin account on the pool server.'
          });
        }

        // Cheap early refusal so a closed pool answers without doing captcha or bcrypt work.
        // This is NOT the gate — it cannot be, because the authoritative check has to happen
        // on the far side of the ~300 ms password hash below, and that await yields the event
        // loop. registerAdmin({ firstAdminOnly: true }) re-checks and inserts atomically; two
        // concurrent registrations used to sail past this line and BOTH become admins
        // (audit §J2-2, demonstrated). Keep both: this one for the common case, that one for
        // correctness.
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
        const result = await authManager.registerAdmin(username, password, { firstAdminOnly: true });
        if (result.success) {
          // Generate tokens and set them as httpOnly cookies. pwa=now — the admin just
          // set this password, so the first session starts step-up-fresh.
          const tokens = authManager.generateTokens(result.user_id, username, true, 0, Math.floor(Date.now() / 1000));

          res.cookie('access_token', tokens.accessToken, accessCookieOpts());
          res.cookie('refresh_token', tokens.refreshToken, refreshCookieOpts());

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
          // "Registration closed" must keep its 403 even when it comes from the atomic gate
          // inside registerAdmin rather than the pre-check above. Script 07's installer
          // branches on the status code — 403 prints "an admin already exists", 400 prints
          // "username >= 3, password >= 8" — so a closed-pool refusal arriving as 400 tells
          // the operator to fix a password that was never the problem.
          const closed = /registration closed/i.test(result.error || '');
          res.status(closed ? 403 : 400).json({ success: false, error: result.error });
        }
      } catch (err) {
        res.status(500).json({ error: 'Server error' });
      }
    }
  );

  // Rate limiting + audit logging + httpOnly cookies.
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
          // Password is correct → clear the PASSWORD auto-ban counter for this IP.
          // Deliberately does NOT clear admin2faFailures: an attacker holding a stolen
          // password could otherwise reset the code counter by simply logging in again
          // between guesses, making the 2FA threshold unreachable. Only completing 2FA
          // clears it.
          adminLoginFailures.delete(ip);

          // 2FA gate: if this admin has TOTP enabled, DON'T issue a session yet. Return a
          // short-lived 2fa token; the client completes via POST /api/auth/login/totp. (CAPTCHA
          // was already consumed here, so the second step doesn't require solving it again.)
          if (authManager.isTotpEnabled(result.user_id)) {
            return res.json({ success: false, totp_required: true, twofa_token: authManager.generate2faToken(result.user_id) });
          }

          // httpOnly (no JS access → no XSS theft), Secure in production, sameSite strict.
          // Lifetime comes from the live session policy — see accessCookieOpts.
          res.cookie('access_token', result.access_token, accessCookieOpts());
          res.cookie('refresh_token', result.refresh_token, refreshCookieOpts());

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
      // verify2faToken returns { userId, jti } — the jti carries the token's OWN guess budget,
      // so the code-guessing cost follows the account instead of the requesting host. A token
      // whose jti has been spent or burned through is refused here even though its JWT still
      // verifies; see authManager.generate2faToken and audit §J2-3.
      const tok = authManager.verify2faToken(twofa_token);
      if (!tok) return res.status(401).json({ success: false, error: '2FA session expired — please log in again.' });
      const userId = tok.userId;

      const ok = await authManager.verifyTotpOrRecovery(userId, code);
      if (!ok) {
        const burned = authManager.record2faFailure(tok.jti);
        try {
          db.prepare(`INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, details, ip)
                      VALUES (?, 'login_2fa_failed', 'auth', 'login', ?, ?)`)
            .run(userId, JSON.stringify({ token_budget_spent: burned }), ip);
        } catch (e) { /* non-fatal */ }
        recordAdminLoginFailure(ip, '2fa');
        // Distinguishing "wrong code" from "this token is finished" is not an oracle — the
        // caller already proved the password to get the token — and without it the operator
        // sees the same message forever while every further attempt is silently refused.
        return res.status(401).json({
          success: false,
          error: burned
            ? 'Too many incorrect codes — please log in again.'
            : 'Invalid 2FA code',
          restart_login: burned
        });
      }
      // Success destroys the token: it must not be re-presented to mint a second session or
      // to buy a fresh guess budget.
      authManager.consume2faToken(tok.jti);

      const sess = authManager.issueSessionFor(userId);
      if (!sess.success) return res.status(401).json({ success: false, error: sess.error || 'Login failed' });

      res.cookie('access_token', sess.access_token, accessCookieOpts());
      res.cookie('refresh_token', sess.refresh_token, refreshCookieOpts());
      // Full authentication completed — clear BOTH counters for this IP.
      adminLoginFailures.delete(ip);
      admin2faFailures.delete(ip);
      try {
        db.prepare(`INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, details, ip)
                    VALUES (?, 'login_success', 'auth', 'login', ?, ?)`).run(userId, JSON.stringify({ via: '2fa' }), ip);
      } catch (e) { /* non-fatal */ }
      res.json({ success: true, username: sess.username, is_admin: sess.is_admin });
    } catch (err) {
      res.status(500).json({ error: 'Server error' });
    }
  });

  app.post('/api/auth/refresh', rateLimiter.middleware('auth'), (req, res) => {
    // Refresh token comes from the cookie; the body form is the legacy fallback.
    const refreshToken = req.cookies.refresh_token || req.body.refresh_token;
    if (!refreshToken) {
      return res.status(401).json({ error: 'No refresh token' });
    }

    const result = authManager.refreshAccessToken(refreshToken);
    if (result.success) {
      // Set new access token in httpOnly cookie
      res.cookie('access_token', result.access_token, accessCookieOpts());

      // Set new refresh token if provided
      if (result.refresh_token) {
        res.cookie('refresh_token', result.refresh_token, refreshCookieOpts());
      }

      // expires_in lets the client schedule the next silent refresh; session_started_at is
      // what it needs to count down the absolute cap without guessing from page-load time.
      res.json({
        success: true,
        expires_in: result.expires_in,
        session_started_at: result.session_started_at,
        session_absolute_seconds: result.session_absolute_seconds
      });
    } else {
      // session_expired = the absolute cap was reached; a new access token will never be
      // issued for this session, so the client must stop retrying and send the operator to
      // the login page instead of looping.
      res.status(401).json({
        success: false,
        error: result.error,
        session_expired: !!result.session_expired
      });
    }
  });

  // Step-up re-authentication: a logged-in admin re-enters their password to authorize a
  // money/destructive action. Mints a fresh (pwa=now) access token; the client then retries
  // the freshAdmin-gated request. It is gated at the secureAdmin TIER (a valid session, not a
  // fresh one — requiring freshness to become fresh is unsatisfiable), but on its own rate
  // bucket rather than the shared `admin` one; the chain is spelled out below rather than
  // reusing the `secureAdmin` array for exactly that reason.
  //
  // This route IS the freshAdmin tier. Everything behind requireFreshAuth — withdrawal
  // retry/cancel, payout freeze, dormancy send-payout, prize-pool topup, wallet
  // adopt-identity — opens the moment it returns, so it is defended like the login route and
  // not like an admin read (audit §J2-1). Three things were missing and are now here:
  //
  //   1. `stepup` rate bucket, not `admin`. 10/min instead of 2400/min. This is the control
  //      that bounds the CPU as well as the guessing: the bcrypt runs before any counter can
  //      see its result, so a lockout alone would not have stopped a session thief from
  //      burning the shared event loop (and with it stratum share intake).
  //   2. The (username, IP) lockout and the fail2ban-style per-IP auto-ban, i.e. the same
  //      three-layer policy /api/auth/login has. The pair key is what keeps this from becoming
  //      a remote operator lockout.
  //   3. A second factor when the pool mandates one. freshAdmin's requireTotpEnrolled only
  //      checks that the account HAS 2FA and never asks for a code, so on a pool with
  //      access.require_admin_totp ON the money gate was still password-only.
  app.post('/api/admin/reauth',
    rateLimiter.middleware('stepup'),
    ipFilter.middleware('admin'),
    requireAdmin(authManager),
    async (req, res) => {
    try {
      const { password, code } = req.body || {};
      if (!password) return res.status(400).json({ error: 'Password required' });

      // Ask for a code only where the pool has decided 2FA is mandatory AND this admin is
      // enrolled. Demanding one from an un-enrolled admin would make step-up unsatisfiable and
      // hard-lock the panel — the same trap freshAdminEnroll exists to avoid.
      const requireCode = totpIsMandatory() && authManager.isTotpEnabled(req.user.user_id);

      // Pass the caller's session start through: a step-up re-verifies the password but does
      // NOT start a new session, so it must not reset the absolute-cap clock.
      const result = await authManager.stepUp(
        req.user.user_id,
        password,
        Number(req.user.sst) || 0,
        { ip: req.ip, requireCode, code }
      );

      // "You must also send a code" is a protocol answer, not a failed credential attempt —
      // counting it would let a correct-password client lock itself out by not knowing the
      // pool's policy yet. 401 + the flag; the client re-prompts and posts both.
      if (!result.success && result.totp_code_required && !code) {
        return res.status(401).json({
          error: result.error || 'Two-factor code required',
          totp_code_required: true
        });
      }

      if (!result.success) {
        try {
          db.prepare(`INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, details, ip)
                      VALUES (?, 'reauth_failed', 'auth', 'reauth', ?, ?)`)
            .run(req.user.user_id, JSON.stringify({ locked: !!result.locked, factor: result.totp_code_required ? '2fa' : 'password' }), req.ip);
        } catch (e) { /* non-fatal */ }
        // Don't spend auto-ban budget on a source that is ALREADY locked out — it is being
        // refused before the password is even read, so counting it would let a lock convert
        // itself into a longer ban with no new information.
        if (!result.locked) {
          recordAdminLoginFailure(req.ip, result.totp_code_required ? '2fa' : 'password');
        }
        return res.status(result.locked ? 429 : 401).json({
          error: result.error || 'Re-authentication failed',
          locked: !!result.locked,
          retry_after_seconds: result.retry_after_seconds || undefined,
          totp_code_required: !!result.totp_code_required,
          code_replay: !!result.code_replay
        });
      }

      // A completed step-up is a full credential proof — clear this IP's counters, exactly as
      // a successful login does.
      adminLoginFailures.delete(req.ip);
      if (requireCode) admin2faFailures.delete(req.ip);

      res.cookie('access_token', result.access_token, accessCookieOpts());
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
      const enabled = authManager.isTotpEnabled(req.user.user_id);
      const mandatory = totpIsMandatory();
      res.json({
        success: true,
        enabled,
        recovery_codes_remaining: authManager.unusedRecoveryCount(req.user.user_id),
        // Lets the panel show the real state instead of a generic 403 the first time a
        // step-up action is refused: mandatory = the pool requires 2FA;
        // must_enroll = required but this admin hasn't set it up, so step-up is blocked.
        mandatory,
        must_enroll: mandatory && !enabled,
      });
    } catch (err) { res.status(500).json({ error: 'Server error' }); }
  });

  app.post('/api/admin/2fa/enroll/begin', freshAdminEnroll, (req, res) => {
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

  app.post('/api/admin/2fa/enroll/confirm', freshAdminEnroll, async (req, res) => {
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
      if (!r.success) {
        // Three routes in this file verify a 2FA code and only ONE of them fed the counter.
        // That asymmetry is not an escalation path today (both 2FA management routes are
        // freshAdmin, so reaching them already means beating 2FA) — it is the kind of gap
        // that becomes one the next time a tier moves. Audit §J2-3.
        recordAdminLoginFailure(req.ip, '2fa');
        return res.status(400).json({ error: r.error, code_replay: !!r.code_replay });
      }
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
      const codeDetail = {};
      const ok = await authManager.verifyTotpOrRecovery(req.user.user_id, (req.body || {}).code, codeDetail);
      if (!ok) {
        recordAdminLoginFailure(req.ip, '2fa');   // same shared counter — see 2fa/disable
        return res.status(401).json({
          error: codeDetail.replay
            ? 'That code has already been used. Wait for your authenticator to show the next one.'
            : 'Incorrect 2FA / recovery code',
          code_replay: !!codeDetail.replay
        });
      }
      const recovery_codes = await authManager.generateRecoveryCodes(req.user.user_id);
      db.prepare(`INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, details, ip)
                  VALUES (?, '2fa_recovery_regenerated', 'auth', '2fa', NULL, ?)`).run(req.user.user_id, req.ip);
      res.json({ success: true, recovery_codes });
    } catch (err) { res.status(500).json({ error: 'Server error' }); }
  });

  app.post('/api/auth/logout', rateLimiter.middleware('auth'), (req, res) => {
    // Server-side revoke: bump the user's token_version so the issued refresh token
    // can't be replayed after logout (clearing the cookie alone only affects this browser).
    authManager.revokeByRefreshToken(req.cookies?.refresh_token || req.body?.refresh_token);
    res.clearCookie('access_token', { httpOnly: true });
    res.clearCookie('refresh_token', { httpOnly: true });
    res.json({ success: true });
  });


  // The second place in this file that verifies a password, and it used to be the quieter one:
  // `auth` bucket (200/min), the non-admin `requireAuth` guard, no ipFilter, no lockout and no
  // audit row at all — 288 k guesses/day for a hijacked session, leaving no trace. It now runs
  // the same three-layer policy as the other two: the `stepup` bucket (10/min), the admin IP
  // filter, the (username, IP) lockout inside changePassword, and the per-IP auto-ban. Audit
  // §J2-1.
  //
  // Deliberately `secureAdmin` and not `freshAdmin`: the request already carries the current
  // password, so demanding a step-up first would mean typing the same secret twice for one
  // action — ceremony an operator learns to click through, which is the failure mode the
  // step-up prompt can least afford. Promoting it to requireAdmin is what retires `requireAuth`
  // (it had exactly one caller, this one — §J1's handoff called it dead code, which it was not
  // until this line changed).
  app.post('/api/auth/change-password',
    rateLimiter.middleware('stepup'),
    ipFilter.middleware('admin'),
    requireAdmin(authManager),
    (req, res) => {
    const { old_password, new_password } = req.body;
    authManager.changePassword(req.user.user_id, old_password, new_password, req.ip)
      .then(result => {
        if (result.success) {
          try {
            db.prepare(`INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, details, ip)
                        VALUES (?, 'password_changed', 'auth', 'password', NULL, ?)`)
              .run(req.user.user_id, req.ip);
          } catch (e) { /* non-fatal */ }
          res.json(result);
        } else {
          try {
            db.prepare(`INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, details, ip)
                        VALUES (?, 'password_change_failed', 'auth', 'password', NULL, ?)`)
              .run(req.user.user_id, req.ip);
          } catch (e) { /* non-fatal */ }
          recordAdminLoginFailure(req.ip);
          // Don't expose detailed error messages
          res.status(400).json({ success: false, error: 'Password change failed' });
        }
      })
      .catch(err => {
        res.status(500).json({ error: 'Server error' });
      });
  });

  app.get('/api/config/pool-info', rateLimiter.middleware('public'), (req, res) => {
    res.json({
      network: config.network,
      pool_fee_percent: config.pool_fee_percent,
      min_withdrawal: config.min_withdrawal,
      // Flat fee deducted from every payout (0 = the pool absorbs the network fee).
      withdrawal_fee: config.withdrawal_fee || 0,
      address_format: `grin1...`,
      wallet_required: config.tor_enabled ? 'Tor listener' : 'HTTP endpoint'
    });
  });

  // Test endpoints removed for production security
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

  app.get('/api/pool/stats', rateLimiter.middleware('public'), (req, res) => {
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
  //
  // SERVER-SIDE cached, 15 s, with in-flight dedup. It used to set `Cache-Control: max-age=15`
  // and nothing else — a hint to the client, which costs an attacker one header to ignore and
  // which nothing on the box consults (audit §J12-2). Every hit made TWO upstream calls: the
  // node Owner API and the wallet Owner API (AES-GCM over the ECDH session). At the ~10 req/s
  // nginx allows from one host that is 10 node calls and 10 wallet calls a second from an
  // unauthenticated client — against the same singleton WalletAPI whose session the payout
  // path uses, and whose _call() re-runs initSession() on any session-shaped error. This is
  // the same reasoning /api/pool/poolstats already carries a 60 s cache for; that endpoint is
  // polled by one listing service, this one by every homepage visitor.
  const POOL_STATUS_TTL_MS = 15000;
  let _poolStatusCache = { at: 0, body: null };
  let _poolStatusInflight = null;
  const buildPoolStatus = async () => {
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

    return out;
  };

  app.get('/api/pool/status', rateLimiter.middleware('public'), async (req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=15');
    const now = Date.now();
    if (_poolStatusCache.body && (now - _poolStatusCache.at) < POOL_STATUS_TTL_MS) {
      return res.json(_poolStatusCache.body);
    }
    // Collapse concurrent misses onto one upstream pair. Without this a burst arriving on a
    // cold cache each fires its own node + wallet call before the first one can populate it —
    // the same trap torProbeCached and cachedGatewayStatus already guard against.
    if (!_poolStatusInflight) {
      _poolStatusInflight = buildPoolStatus()
        .then((body) => { _poolStatusCache = { at: Date.now(), body }; return body; })
        .catch(() => _poolStatusCache.body)   // buildPoolStatus swallows its own errors; belt and braces
        .then((body) => { _poolStatusInflight = null; return body; });
    }
    try {
      const body = await _poolStatusInflight;
      // Last-good on a failed build, so a down node does not turn this back into a per-request
      // prober. `pool.ok` stays true either way — the pool API answered, which is what it means.
      res.json(body || { pool: { ok: true }, node: { reachable: false, synced: false, peers: 0, height: 0 }, wallet: { reachable: false } });
    } catch (err) {
      res.status(500).json({ error: 'status unavailable' });
    }
  });

  // Public pool-found blocks, newest first. Paginated (limit+offset) with an optional status
  // filter for the public blocks explorer. Response stays a plain array (back-compat with the
  // homepage recent-blocks table); callers detect the last page when fewer than `limit` return.
  app.get('/api/pool/blocks', rateLimiter.middleware('public'), (req, res) => {
    try {
      const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 500);
      const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
      const status = req.query.status;
      const valid = ['immature', 'confirmed', 'orphaned'];
      // Explicit columns since 2026-07-28 (was `SELECT *`): `nonce` is the winning solution's
      // nonce and `id`/`created_at` are internal row bookkeeping — none of the three is read by
      // blocks.html or the reactor fuel-rods, and publishing the nonce serves no verifier (the
      // block hash already anchors the find on any chain explorer). Everything the two consumers
      // actually render is kept, including found_by and the luck pair.
      let sql = `SELECT height, hash, reward, status, found_by, found_at, confirmed_at,
                        network_difficulty, round_shares FROM blocks`;
      const params = [];
      if (status && valid.includes(status)) { sql += ' WHERE status = ?'; params.push(status); }
      sql += ' ORDER BY height DESC LIMIT ? OFFSET ?';
      params.push(limit, offset);
      // found_by MASKED since 2026-09-02 (audit §J11-1). blocks.html already displayed only
      // shortAddr(found_by) — the full value went out solely in the row's `title` tooltip — but
      // this route is offset-paged with no upper bound over a table that is never pruned, so it
      // was the cheapest walk of every full address the pool has ever seen, and that walk is
      // what inverted the mask on `/api/pool/miners`, `/api/stratum/stats` and
      // `/api/pool/unclaimed`. Internal callers read `blocks` directly and are unaffected.
      const blocks = db.prepare(sql).all(...params).map((b) => ({
        ...b,
        found_by: maskAddr(b.found_by),
      }));
      res.json(blocks);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Durable block-history series for the public blocks.html deck (one fetch → all four charts:
  // luck trend, blocks-per-period columns, status doughnut, cumulative reward). Blocks are never
  // pruned, so ?range can be arbitrarily long. See BlockManager.getBlocksHistory.
  app.get('/api/pool/blocks/history', rateLimiter.middleware('public'), (req, res) => {
    try {
      const allowed = ['week', 'month', 'year', 'all'];
      const range = allowed.includes(req.query.range) ? req.query.range : 'month';
      res.json(blockManager ? blockManager.getBlocksHistory(range)
                            : { range, bucket_seconds: null, points: [], luck: [], status: { confirmed: 0, immature: 0, orphaned: 0 } });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/account/:addr/shares', rateLimiter.middleware('public'), (req, res) => {
    try {
      const { addr } = req.params;
      const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
      const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

      const shares = shareValidator.getSharesForMiner(addr, limit, offset);
      res.json(shares);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Test endpoint removed - manual block crediting disabled for security

  app.get('/api/admin/node-status', secureAdmin, (req, res) => {
    blockMonitor.grinNode.getStatus()
      .then(status => res.json(status))
      .catch(err => res.status(500).json({ error: err.message }));
  });

  app.get('/api/admin/block-monitor', secureAdmin, (req, res) => {
    res.json(blockMonitor.getStatus());
  });

  // Test endpoint removed - manual reward distribution disabled for security

  app.get('/api/admin/reward-stats', secureAdmin, (req, res) => {
    rewardDistributor.rewardStats()
      .then(stats => res.json(stats))
      .catch(err => res.status(500).json({ error: err.message }));
  });

  // REMOVED: /api/test/initiate-withdrawal endpoint
  // Reason: Test endpoint disabled in production. Allowed admin to initiate arbitrary withdrawals.
  // Use /api/admin/withdrawals to view and manage withdrawal scheduler instead.
  // For testing: use withdrawal_scheduler.initiateWithdrawal() directly in backend tests.

  // `limit` is honoured (1–500, default 100). The dashboard's "Recent Withdrawals" widget
  // asks for 10 and was silently getting the full 100 back — every admin page load shipped
  // and rendered 10× the rows it displays.
  app.get('/api/admin/withdrawals', secureAdmin, (req, res) => {
    try {
      const status = req.query.status || null;
      const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);

      if (status) {
        res.json(db.prepare(`
          SELECT * FROM withdrawals WHERE status = ? ORDER BY created_at DESC LIMIT ?
        `).all(status, limit));
      } else {
        res.json(db.prepare(`
          SELECT * FROM withdrawals ORDER BY created_at DESC LIMIT ?
        `).all(limit));
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
      if (getPayoutControl().frozen) {
        return res.status(409).json({ error: 'payouts are frozen — resume payouts before retrying' });
      }
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

  // Read the payout kill-switch state (single row id=1; absence = not frozen).
  const getPayoutControl = () => {
    const row = db.prepare('SELECT frozen, reason, frozen_by, frozen_at FROM payout_control WHERE id = 1').get();
    return {
      frozen: !!(row && row.frozen),
      reason: row ? row.reason : null,
      frozen_by: row ? row.frozen_by : null,
      frozen_at: row ? row.frozen_at : null,
    };
  };

  // ─── WALLET ↔ LEDGER RECONCILIATION (Admin) ────────────────────────
  // The pool's custodial money statement (coverage, flow, buckets, integrity invariant). The
  // full computation lives in lib/reconciliation.js so the AlertMonitor money detectors and
  // this endpoint share one source of truth. Forces a fresh wallet→node scan (slow) — the admin
  // page polls it on its own 3-min cadence, never the fast liveness loops.
  app.get('/api/admin/reconciliation', secureAdmin, async (req, res) => {
    try {
      const recon = await computeReconciliation(db, wallet, true);
      res.json({ success: true, ...recon, payout_control: getPayoutControl() });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── PAYOUT KILL-SWITCH (Admin) ────────────────────────────────────
  // Emergency freeze of the withdrawal scheduler. Set automatically by AlertMonitor on a critical
  // money trip (coverage shortfall / integrity drift / wallet drain) and manually here. Reading is
  // secureAdmin (surfaced on the Payments page); mutating is freshAdmin (step-up — it's money-control).
  app.get('/api/admin/payouts/control', secureAdmin, (req, res) => {
    try { res.json({ success: true, ...getPayoutControl() }); }
    catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/admin/payouts/freeze', freshAdmin, (req, res) => {
    try {
      const reason = (req.body && req.body.reason || '').toString().slice(0, 500) || 'manual admin freeze';
      if (withdrawalScheduler && withdrawalScheduler.freeze) withdrawalScheduler.freeze(reason, `admin:${req.user.username}`);
      db.prepare(`INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, details, ip)
                  VALUES (?, 'payouts_freeze', 'payouts', 'payouts', ?, ?)`)
        .run(req.user.user_id, JSON.stringify({ reason }), req.ip);
      res.json({ success: true, ...getPayoutControl() });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/admin/payouts/resume', freshAdmin, (req, res) => {
    try {
      if (withdrawalScheduler && withdrawalScheduler.resume) withdrawalScheduler.resume(`admin:${req.user.username}`);
      db.prepare(`INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, details, ip)
                  VALUES (?, 'payouts_resume', 'payouts', 'payouts', ?, ?)`)
        .run(req.user.user_id, JSON.stringify({}), req.ip);
      res.json({ success: true, ...getPayoutControl() });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ─── ABANDONED-BALANCE DISPOSITION (Admin) ─────────────────────────
  // Status + dry-run preview + the dormant list (UNMASKED for the operator) + disposition history.
  // Reading is secureAdmin; the run and manual-payout mutate money → freshAdmin (step-up).
  app.get('/api/admin/dormancy', secureAdmin, (req, res) => {
    try {
      if (!dormancyManager) return res.status(503).json({ error: 'dormancy manager not ready' });
      res.json({
        success: true,
        status: dormancyManager.status(),
        preview: dormancyManager.preview(),
        dormant: dormancyManager.listDormant({ mask: false, limit: 500 }),
        history: dormancyManager.history({ limit: 100 }),
      });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Trigger a disposition pass now (respects the disabled/frozen/grandfather gates internally).
  app.post('/api/admin/dormancy/run', freshAdmin, (req, res) => {
    try {
      if (!dormancyManager) return res.status(503).json({ error: 'dormancy manager not ready' });
      const result = dormancyManager.runOnce({ triggeredBy: req.user.user_id });
      db.prepare(`INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, details, ip)
                  VALUES (?, 'dormancy_run', 'dormancy', ?, ?, ?)`)
        .run(req.user.user_id, String(result.disposition_id || 'none'), JSON.stringify(result), req.ip);
      res.json({ success: true, result });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Was this address's ownership successfully verified by an admin in the last `windowSec`? Reads
  // the audit trail auditOwnerProof() writes ('owner_proof:admin_verify:ok'). Gate for the money
  // endpoints below so a payout can't be pushed without a recent ownership check —
  // unless the operator explicitly acknowledges verifying by other means (verified_ack, for a
  // no-proof-on-record account where verifyOwnerProof can never match).
  const ownerRecentlyVerified = (addr, windowSec = 900) => {
    try {
      const row = db.prepare(
        `SELECT created_at FROM admin_audit_log
         WHERE action = 'owner_proof:admin_verify:ok' AND target_id = ?
         ORDER BY created_at DESC LIMIT 1`
      ).get(addr);
      if (!row) return false;
      return (Math.floor(Date.now() / 1000) - Number(row.created_at)) <= windowSec;
    } catch (e) { return false; }
  };

  // Verify a miner's CLAIMED ownership proof (IP or stratum password) against what's on record —
  // for the operator handling a sub-threshold "email support to withdraw" request. Returns a
  // match/no-match ONLY (the stored proofs are salted-scrypt hashes; nothing is ever revealed).
  app.post('/api/admin/dormancy/verify-owner', secureAdmin, async (req, res) => {
    try {
      const addr = String((req.body && req.body.address) || '').trim();
      const submitted = String((req.body && req.body.proof) || '');
      if (!addr) return res.status(400).json({ error: 'address required' });
      const proof = await verifyOwnerProof(db, addr, submitted);
      auditOwnerProof(db, { action: 'admin_verify', grinAddress: addr, ip: req.ip, ok: proof.ok, details: { by: req.user.username } });
      res.json({ success: true, match: !!proof.ok, method: proof.method || null, reason: proof.reason });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Record an out-of-band manual payout (the admin already sent the coins by Tor/slatepack at the
  // OS level after verifying the owner). Writes a confirmed withdrawals row + 'withdrawal' debit so
  // coverage stays correct and the wallet-send audit matches it. Honours the payout freeze.
  app.post('/api/admin/dormancy/manual-payout', freshAdmin, (req, res) => {
    try {
      if (!dormancyManager) return res.status(503).json({ error: 'dormancy manager not ready' });
      if (getPayoutControl().frozen) {
        return res.status(409).json({ error: 'payouts are frozen — resume payouts before recording a manual payout' });
      }
      const b = req.body || {};
      const addr = String(b.address || '').trim();
      if (!ownerRecentlyVerified(addr) && b.verified_ack !== true) {
        return res.status(428).json({ error: 'verify the address owner first (no successful verification in the last 15 min)', reason: 'verify_required' });
      }
      const result = dormancyManager.manualPayout({
        grinAddress: b.address,
        amount: b.amount,
        fee: b.fee || 0,
        kernelExcess: b.kernel_excess || null,
        slateId: b.slate_id || null,
        note: b.note || null,
        adminId: req.user.user_id,
        allowAboveMin: b.allow_above_min === true,
      });
      if (!result.ok) return res.status(400).json({ error: result.reason, ...result });
      db.prepare(`INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, details, ip)
                  VALUES (?, 'manual_payout', 'miner', ?, ?, ?)`)
        .run(req.user.user_id, String(b.address || ''), JSON.stringify({ withdrawal_id: result.withdrawal_id, amount: result.balance_after, fee: b.fee || 0 }), req.ip);
      res.json({ success: true, ...result });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Backend-INITIATED below-minimum payout (the convenient sub-threshold path). Instead of the
  // operator sending coins out-of-band and recording it, the pool sends over Tor through the SAME
  // locked withdrawal flow a miner uses — atomic lock, real fee/kernel captured by the scheduler,
  // recorded automatically. adminOverride bypasses only the min floor + reversal cooldown; freeze
  // and the one-pending-per-address cap (double-pay guard) still apply. Needs the miner's wallet
  // listener reachable over Tor (the scheduler declines + reverses the lock if it isn't).
  app.post('/api/admin/dormancy/send-payout', freshAdmin, (req, res) => {
    try {
      if (!withdrawalScheduler) return res.status(503).json({ error: 'withdrawal scheduler not ready' });
      if (getPayoutControl().frozen) {
        return res.status(409).json({ error: 'payouts are frozen — resume payouts before sending' });
      }
      const b = req.body || {};
      const addr = String(b.address || '').trim();
      if (!ownerRecentlyVerified(addr) && b.verified_ack !== true) {
        return res.status(428).json({ error: 'verify the address owner first (no successful verification in the last 15 min)', reason: 'verify_required' });
      }
      let result;
      try {
        result = withdrawalScheduler.createWithdrawal(addr, b.amount, 'tor', { adminOverride: true });
      } catch (e) {
        return res.status(e.code && e.code >= 400 && e.code < 500 ? e.code : 500).json({ error: e.message });
      }
      db.prepare(`INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, details, ip)
                  VALUES (?, 'admin_send_payout', 'miner', ?, ?, ?)`)
        .run(req.user.user_id, addr, JSON.stringify({ withdrawal_id: result.withdrawal_id, amount: result.amount, override: 'below_min' }), req.ip);
      res.json({ success: true, ...result });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Wallet-send audit — matches the wallet's OWN confirmed outbound sends against the pool's
  // withdrawals. Any unmatched send is an out-of-band `grin-wallet send` (invisible to the
  // ledger). Forces a fresh wallet scan (slow) → the Payments page polls on the 3-min cadence.
  app.get('/api/admin/payouts/wallet-audit', secureAdmin, async (req, res) => {
    try {
      const audit = await auditWalletSends(db, wallet, {});
      res.json({ success: true, ...audit });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── WALLET-IDENTITY GUARD + SWITCH WIZARD (Admin) ─────────────────
  // The pool pins its wallet's slatepack address (index 0, seed-deterministic). AlertMonitor
  // freezes payouts if the live wallet stops matching. A PLANNED switch re-adopts the new wallet
  // here so the guard doesn't fight an intentional migration. Reading is secureAdmin (forces a
  // fresh owner-API call → the wizard polls it); adopting moves the trust anchor → freshAdmin.
  app.get('/api/admin/wallet/identity', secureAdmin, async (req, res) => {
    try {
      const id = await probeWalletIdentity(db, wallet);
      res.json({ success: true, ...id });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Adopt the CURRENTLY-connected wallet as the pool's identity anchor (step 4 of the switch
  // wizard). Resolves the wallet_identity_changed alert; does NOT auto-resume payouts (resume is a
  // deliberate separate step). Refuses if the wallet is unreachable — you must not adopt a phantom.
  app.post('/api/admin/wallet/adopt-identity', freshAdmin, async (req, res) => {
    try {
      const id = await probeWalletIdentity(db, wallet);
      if (!id.reachable) return res.status(503).json({ error: 'wallet unreachable — cannot adopt an unconfirmed wallet identity' });
      const prev = id.firstRun ? null : id.expected;
      adoptWalletIdentity(db, id.live, `admin:${req.user.username}`);
      if (alertMonitor && typeof alertMonitor.resolveAlert === 'function') {
        await alertMonitor.resolveAlert('wallet_identity_changed');
      }
      db.prepare(`INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, details, ip)
                  VALUES (?, 'wallet_adopt_identity', 'wallet', 'wallet', ?, ?)`)
        .run(req.user.user_id, JSON.stringify({ previous: prev, adopted: id.live }), req.ip);
      res.json({ success: true, adopted: id.live, previous: prev });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ─── ADS (Admin CRUD) ──────────────────────────────────────────────
  // Operator-managed promotions (banner image OR ad-network code snippet) bound to a public
  // placement. secureAdmin (not freshAdmin) — ads are not money/destructive of funds.
  app.get('/api/admin/ads', secureAdmin, (req, res) => {
    try {
      res.json({
        ads: adsManager.list(req.query.placement),
        placements: AdsManager.PLACEMENTS,
        config: adsManager.getConfig()
      });
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

  // Render settings for the public renderer — rotation interval, sidebar layout mode
  // and rail peek timings (stored in pool_config, each clamped to a sane range).
  app.post('/api/admin/ads-config', secureAdmin, (req, res) => {
    try {
      res.json({ config: adsManager.setConfig(req.body || {}) });
    } catch (err) { res.status(400).json({ error: err.message }); }
  });

  // ─── ADS (Public) ──────────────────────────────────────────────────
  // Active, in-window ads for the public site. `?placement=header` returns one slot;
  // no param returns all slots keyed by placement. Only render-relevant fields are
  // exposed. Cached 60 s (every visitor on every page hits this) — ad edits take up
  // to a minute to appear publicly.
  app.get('/api/public/ads', rateLimiter.middleware('public'), (req, res) => {
    try {
      res.set('Cache-Control', 'public, max-age=60');
      const p = req.query.placement;
      const cfg = adsManager.getConfig();
      if (p) return res.json({ placement: p, ads: adsManager.publicByPlacement(p), ...cfg });
      res.json({ ads: adsManager.publicAll(), ...cfg });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Impression/click beacon — coarse per-ad counters only (no per-visitor rows, no
  // IPs). Ids are sanitised + capped in recordEvents; always 204 so the client never
  // retries or logs (ads are non-essential), and so the response never reveals which
  // ad ids exist. UNAUTHENTICATED AND UNDEDUPED BY DESIGN — the counters it moves are
  // not measurement and the admin panel labels them "unverified" (audit §J10-3 /
  // §J14-9). recordEvents only counts ads the public site is actually serving.
  app.post('/api/public/ads/event', rateLimiter.middleware('public'), (req, res) => {
    try { adsManager.recordEvents(req.body || {}); } catch (err) { /* counters only — never fail the page */ }
    res.status(204).end();
  });

  // ─── MEDIA UPLOAD (Admin) ──────────────────────────────────────────
  // Image upload for the CMS editor (cover images + in-body images). secureAdmin — not
  // money/destructive. Returns { url } pointing at the persistent /uploads dir. multer
  // errors (bad type, too big) are surfaced as 400 via the wrapper.
  app.post('/api/admin/media', secureAdmin, (req, res) => {
    mediaUpload.single('file')(req, res, (err) => {
      if (err) return res.status(400).json({ error: err.message || 'upload failed' });
      if (!req.file || !req.file.buffer || !req.file.buffer.length) {
        return res.status(400).json({ error: 'no file' });
      }
      // The decisive check (audit §J10-1): the extension — which is what decides the
      // Content-Type nginx serves this back with — comes from the BYTES, never from the
      // uploader's declared MIME or filename. WEBP is passed in explicitly because the
      // branding-asset endpoint does not accept it (see lib/asset-manager.js).
      const detected = AssetManager.detectImage(req.file.buffer, [AssetManager.WEBP_SNIFFER]);
      if (!detected) {
        return res.status(400).json({ error: 'File content is not a valid PNG, JPEG, GIF, WEBP or SVG image' });
      }
      const safe = (req.file.originalname || 'image').toLowerCase()
        .replace(/\.[^.]*$/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'image';
      const filename = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}-${safe}.${detected.ext}`;
      const destPath = path.join(uploadsDir, filename);
      // Defence in depth, mirroring saveAsset(): the joined path must stay in the dir.
      if (path.dirname(destPath) !== uploadsDir) {
        return res.status(400).json({ error: 'upload failed' });
      }
      try {
        fs.writeFileSync(destPath, req.file.buffer, { mode: 0o644 });
      } catch (e) {
        console.error(`[media] write failed for ${destPath}: ${e.message}`);
        return res.status(500).json({ error: 'upload failed' });
      }
      res.json({ url: '/uploads/' + filename, filename });
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
      const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 500);
      const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
      const status = req.query.status || null;

      const where = status ? 'WHERE status = ?' : '';
      const args = status ? [status, limit, offset] : [limit, offset];
      const rows = db.prepare(
        `SELECT id, height, hash, nonce, reward, fees, status, found_by, found_at, confirmed_at, created_at,
                network_difficulty, round_shares
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

      // Must match the client-side builders in /js/branding.js + admin-panel/admin-shell.js:
      // the two explorers do NOT share a path scheme. Mainnet → scan.grin.money (06d Tiny
      // Explorer, /block/<h>); testnet → test.grinscan.org (06b sibling, /block.html?h=<h>).
      // `testnet.grinscan.org` does not resolve — never use it.
      const explorerBlockUrl = (height) => (config.network === 'testnet'
        ? `https://test.grinscan.org/block.html?h=${encodeURIComponent(height)}`
        : `https://scan.grin.money/block/${encodeURIComponent(height)}`);

      const blocks = rows.map((b) => {
        const confirmations = tipHeight ? Math.max(0, tipHeight - b.height) : 0;
        // 'paid' is confirmed-and-distributed (rewards.js flips confirmed→paid), so maturity
        // is behind it too — omitting it made the admin blocks page compute a countdown for
        // a block that had already paid out. Audit §J14.
        const blocks_to_maturity = (b.status === 'confirmed' || b.status === 'paid' || b.status === 'orphaned')
          ? 0 : Math.max(0, confirmDepth - confirmations);
        return {
          ...b,
          confirmations,
          blocks_to_maturity,
          grinscan_url: explorerBlockUrl(b.height),
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
  // STREAMED, not accumulated (audit §J12-5). This used to build one string in memory by
  // map+join over every row before writing a byte — on tables that are never pruned, from a
  // handler with no row cap, on the 2400/min `admin` bucket. res.write per row lets Node's
  // own backpressure bound the peak instead of the row count deciding it.
  const sendCsv = (res, filename, header, rows, note = '') => {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.write(header.join(',') + '\r\n');
    for (const r of rows) res.write(r.map(csvCell).join(',') + '\r\n');
    // A capped export that LOOKS complete is worse than one that is visibly capped. The
    // X-Export-Truncated header is correct but invisible to an operator clicking a download
    // link in the admin panel, so the last row says it in the file itself.
    if (note) res.write(csvCell(note) + '\r\n');
    res.end();
  };

  // Row cap + cursor for the two POOL-WIDE admin exports. The public, per-address exports have
  // had `CSV_MAX_ROWS = 50000` and a dedicated 10/min `export` bucket since §C1; the pool-wide
  // ones — over `withdrawals` and `blocks`, neither of which is ever pruned — had neither, and
  // rode the bucket the polling dashboard needs kept loose. An operator who genuinely wants the
  // whole ledger pages with `?before=<cursor>`; truncation and the next cursor are reported as
  // response HEADERS so the body stays valid CSV for a spreadsheet.
  const ADMIN_CSV_MAX_ROWS = 50000;
  const adminCsvGate = (req, res) => {
    const gate = rateLimiter.peek('export', req);
    if (!gate.allowed) { rateLimiter.sendLimited(res, gate); return false; }
    rateLimiter.consume('export', req);
    return true;
  };
  // The cursor is a bare integer (a `confirmed_at` timestamp, or a block height). It is bound,
  // not interpolated, either way — but it is validated as a number because a NaN binds happily
  // and matches nothing, turning a typo into an empty export that reads as "no data".
  const adminCsvBefore = (req) => {
    const raw = req.query.before;
    if (raw === undefined || raw === '') return null;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) ? n : null;
  };
  // Returns { page, note }: `note` is the trailing CSV row that makes truncation visible in
  // the downloaded file, since a response header is not.
  const adminCsvPage = (res, rows, nextOf) => {
    const truncated = rows.length > ADMIN_CSV_MAX_ROWS;
    const page = truncated ? rows.slice(0, ADMIN_CSV_MAX_ROWS) : rows;
    res.setHeader('X-Export-Truncated', truncated ? 'true' : 'false');
    let note = '';
    if (truncated && page.length) {
      const next = nextOf(page[page.length - 1]);
      res.setHeader('X-Export-Next-Before', String(next));
      note = `TRUNCATED at ${ADMIN_CSV_MAX_ROWS} rows - continue with ?before=${next}`;
    }
    return { page, note };
  };

  // All confirmed payouts.
  app.get('/api/admin/export/payouts.csv', secureAdmin, (req, res) => {
    try {
      if (!adminCsvGate(req, res)) return;
      const before = adminCsvBefore(req);
      // LIMIT is MAX_ROWS + 1 so the extra row IS the truncation signal — a plain LIMIT can
      // never tell "exactly a full page" from "there is more after this".
      const rows = before === null
        ? db.prepare(
            `SELECT id, grin_address, amount, fee, status, created_at, confirmed_at
             FROM withdrawals WHERE status = 'confirmed'
             ORDER BY confirmed_at DESC, id DESC LIMIT ?`).all(ADMIN_CSV_MAX_ROWS + 1)
        : db.prepare(
            `SELECT id, grin_address, amount, fee, status, created_at, confirmed_at
             FROM withdrawals WHERE status = 'confirmed' AND confirmed_at <= ?
             ORDER BY confirmed_at DESC, id DESC LIMIT ?`).all(before, ADMIN_CSV_MAX_ROWS + 1);
      const { page, note } = adminCsvPage(res, rows, (last) => last.confirmed_at);
      const iso = (t) => (t ? new Date(t * 1000).toISOString() : '');
      sendCsv(res, `payouts-${config.network}.csv`,
        ['id', 'grin_address', 'amount_grin', 'fee_grin', 'status', 'created_at', 'confirmed_at'],
        page.map((r) => [r.id, r.grin_address, r.amount, r.fee, r.status, iso(r.created_at), iso(r.confirmed_at)]),
        note);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Pool-fee revenue per found block (reward × pool_fee_percent). An honest, derived report —
  // the pool's cut of each block, not a separately stored figure.
  app.get('/api/admin/export/fee-revenue.csv', secureAdmin, (req, res) => {
    try {
      const feePct = parseFloat(config.pool_fee_percent != null ? config.pool_fee_percent : 1.0) || 0;
      if (!adminCsvGate(req, res)) return;
      const before = adminCsvBefore(req);
      const rows = before === null
        ? db.prepare(
            `SELECT height, hash, reward, status, found_at FROM blocks
             ORDER BY height DESC LIMIT ?`).all(ADMIN_CSV_MAX_ROWS + 1)
        : db.prepare(
            `SELECT height, hash, reward, status, found_at FROM blocks WHERE height <= ?
             ORDER BY height DESC LIMIT ?`).all(before, ADMIN_CSV_MAX_ROWS + 1);
      const { page, note } = adminCsvPage(res, rows, (last) => last.height);
      const iso = (t) => (t ? new Date(t * 1000).toISOString() : '');
      sendCsv(res, `fee-revenue-${config.network}.csv`,
        ['height', 'hash', 'reward_grin', 'pool_fee_percent', 'pool_cut_grin', 'status', 'found_at'],
        page.map((r) => [r.height, r.hash, r.reward, feePct,
          parseFloat((r.reward * feePct / 100).toFixed(9)), r.status, iso(r.found_at)]),
        note);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // REMOVED (2026-07-28): GET /api/account/:addr/balance — every field it returned
  // (balance, balance_locked, their sum) is already in GET /api/account/:addr, which is what
  // the account page actually calls. Nothing in public_html/ or the admin panel referenced it.
  // A second, undocumented way to read the same number is one more surface to keep honest.

  // Balance distribution across accounts, richest first. Addresses are MASKED here (2026-07-28):
  // unmasked this was a public rich-list — a full address paired with a balance, sorted so the
  // largest balances come first, which is a targeting list, not transparency. The distribution
  // itself is legitimate pool-health data, and it survives masking intact; the address→balance
  // mapping does not, which is the point. No front-end consumes this endpoint (the leaderboards
  // use /api/stratum/top-miners and /api/pool/top-block-finders — hashrate and luck, not money).
  app.get('/api/pool/miners', rateLimiter.middleware('public'), (req, res) => {
    try {
      const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 500);
      const stmt = db.prepare(`
        SELECT grin_address, balance, is_online FROM miner_accounts
        ORDER BY balance DESC LIMIT ?
      `);
      const miners = stmt.all(limit).map((m) => ({
        grin_address: maskAddr(m.grin_address),
        balance: m.balance,
        is_online: m.is_online,
      }));
      res.json(miners);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Top block finders over a recent window (default 30 days) — the "lucky miners" leaderboard.
  // Blocks are never pruned (only raw shares are), so this window can be arbitrarily long.
  // Orphaned blocks don't count as a find; total_reward sums the landed rewards.
  app.get('/api/pool/top-block-finders', rateLimiter.middleware('public'), (req, res) => {
    try {
      const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 500, 1), 1000);
      const days = Math.min(parseInt(req.query.days || 30, 10) || 30, 3650);
      const cutoff = Math.floor(Date.now() / 1000) - days * 86400;
      const rows = db.prepare(`
        SELECT found_by AS grin_address,
               COUNT(*) AS blocks_found,
               COALESCE(SUM(reward), 0) AS total_reward,
               MAX(found_at) AS last_found_at
        FROM blocks
        WHERE status != 'orphaned' AND found_at > ?
        GROUP BY found_by
        ORDER BY blocks_found DESC, total_reward DESC
        LIMIT ?
      `).all(cutoff, limit);
      // MASKED since 2026-09-02 (audit §J11-1). This is a full address paired with a lifetime
      // reward total and sorted descending — byte for byte the shape §C1 masked on
      // `/api/pool/miners`, published at ten times the row cap and over a 10-year window.
      res.json({ days, top_finders: rows.map((r) => ({ ...r, grin_address: maskAddr(r.grin_address) })) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Recent confirmed payouts (public payout teletype + payment-history table). Explicit column
  // list since 2026-07-28: `SELECT *` published the whole withdrawals row, which carries the
  // pool's operational internals — slate_id, tor_check_result, retry_count, next_retry_at,
  // cancel_reason, cancelled_by. Those describe how the pool's payout machinery and a miner's
  // wallet behaved, are read by nothing public, and read as a per-miner reliability record.
  // grin_address stays FULL: address-as-identity means the account page is public and keyed by
  // it, and both consumers link the row through to /account-settings.html?addr=.
  //
  // `kernel_excess` was dropped from this feed 2026-09-02 (audit §J11-2). It is the on-chain
  // payment proof, and pairing it POOL-WIDE with a full recipient address builds a public,
  // permanent Grin-address <-> on-chain-kernel index — for a chain whose whole product is that
  // such an index cannot be built. Neither consumer ever rendered it (the homepage teletype
  // prints amount + a truncated address; payment-history.html prints time/address/amount/status),
  // so it was published and unused. It stays on /api/account/:addr/withdrawals, where it backs
  // the account page's Proof column — that surface's own exposure is still an open decision.
  // Do not re-add it here to "make the feeds consistent".
  app.get('/api/pool/payments', rateLimiter.middleware('public'), (req, res) => {
    try {
      const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
      const stmt = db.prepare(`
        SELECT id, grin_address, amount, fee_charged, method, status,
               created_at, confirmed_at
        FROM withdrawals WHERE status = 'confirmed'
        ORDER BY confirmed_at DESC LIMIT ?
      `);
      // MASKED since 2026-09-02 (audit §J11-1). Both consumers already truncated for display —
      // the homepage teletype calls truncAddr(), payment-history.html renders truncAddr() with
      // the full value in a `title` — so nothing on screen changes; what goes away is the
      // machine-readable full-address list behind them.
      const payments = stmt.all(limit).map((p) => ({ ...p, grin_address: maskAddr(p.grin_address) }));
      res.json(payments);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── Unclaimed / abandoned balances (public transparency) ───────────────────
  // A lost-and-found with a public audit trail: masked addresses of long-dormant balances with a
  // per-address disposal countdown (owner recognises their own → reclaims via the account page
  // BEFORE disposition), plus the historical disposition ledger (final sweeps into the prize
  // pool). Addresses are masked (grin1qxy…mn4p) so this is a reunification aid, not a targeting
  // list; the ownership gate independently protects reclaim. Returns { dormant, dispositions }.
  app.get('/api/pool/unclaimed', rateLimiter.middleware('public'), (req, res) => {
    try {
      if (!dormancyManager) return res.json({ dormant: { enabled: false, totals: { count: 0, amount: 0 }, list: [] }, dispositions: { totals: {}, batches: [] } });
      const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 200);
      res.json({
        dormant: dormancyManager.listDormant({ mask: true, limit }),
        dispositions: dormancyManager.history({ limit: 50 }),
      });
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
                last_ip, prev_ip, last_pass_hash, prev_pass_hash, pass_proof_state,
                last_ip_at, last_pass_at, anchor_ip, anchor_pass_hash,
                nostr_username, nostr_npub, nostr_registered_at
         FROM miner_accounts WHERE grin_address = ?`
      ).get(addr);
      if (!acct) return res.status(404).json({ error: 'Account not found' });

      // Lifetime withdrawals actually paid (confirmed only): total amount + how many.
      const paidAgg = db.prepare(
        `SELECT COUNT(*) AS cnt, COALESCE(SUM(amount), 0) AS total FROM withdrawals
         WHERE grin_address = ? AND status = 'confirmed'`
      ).get(addr);
      const paid = paidAgg.total;

      // Pending set must match the scheduler's one-pending-per-address cap (which includes
      // slatepack_pending) — otherwise the UI shows 0 pending while a new request would 429.
      // The full row is exposed so the account page can show status/next-retry. (No public
      // cancel — parked payouts self-recover: Tor reverses after max retries, slatepack on TTL.)
      const pendingRow = db.prepare(
        `SELECT id, amount, method, status, retry_count, next_retry_at, created_at
         FROM withdrawals
         WHERE grin_address = ? AND status IN ('tor_checking','tor_sending','retry_scheduled','slatepack_pending','finalizing')
         ORDER BY created_at DESC LIMIT 1`
      ).get(addr);
      const pending = db.prepare(
        `SELECT COUNT(*) AS c FROM withdrawals
         WHERE grin_address = ? AND status IN ('tor_checking','tor_sending','retry_scheduled','slatepack_pending','finalizing')`
      ).get(addr).c;

      const shareAgg = db.prepare(
        `SELECT COUNT(*) AS count, MAX(created_at) AS last_share_at FROM shares WHERE grin_address = ?`
      ).get(addr);

      // Blocks this address found (block-finder attribution) — orphaned ones didn't stick,
      // so they don't count. Vanity stat only; rewards are PPLNS, not finder-take-all.
      const blocksFound = db.prepare(
        `SELECT COUNT(*) AS c FROM blocks WHERE found_by = ? AND status != 'orphaned'`
      ).get(addr).c;

      const hr = hashrateTracker.getMinerHashrate(addr, 60) || {};

      // Proof values are NOT exposed (they back the ownership gate; hashed at rest anyway) —
      // only whether one is on record, so the UI can hint which proof kinds will work.
      res.json({
        grin_address: acct.grin_address,
        balance: acct.balance,
        balance_locked: acct.balance_locked,
        total: acct.balance + acct.balance_locked,
        total_paid: paid,
        payouts_count: paidAgg.cnt || 0,
        blocks_found: blocksFound,
        pending_withdrawals: pending,
        pending_withdrawal: pendingRow || null,
        is_online: !!acct.is_online,
        last_seen_at: acct.last_seen_at || null,
        created_at: acct.created_at,
        shares: {
          count: shareAgg.count || 0,
          last_share_at: shareAgg.last_share_at || null
        },
        hashrate_gps: parseFloat(((hr.avg_hashrate || 0)).toFixed(6)),
        min_withdrawal: config.min_withdrawal,
        // Flat fee deducted from a payout — the account page shows the miner what they will
        // actually receive BEFORE they submit, so the net amount is never a surprise.
        withdrawal_fee: config.withdrawal_fee || 0,
        // Boolean only — the freeze REASON stays admin-side (it can reveal wallet trouble).
        payouts_frozen: withdrawalScheduler.isFrozen(),
        // Abandoned-balance countdown for THIS address (state: active|idle|counting|eligible|
        // disposed|no_balance). Drives the account-page dormancy notice + reclaim CTA.
        dormancy: dormancyManager ? dormancyManager.statusFor(acct.grin_address) : null,
        has_recorded_ip: !!(acct.last_ip || acct.prev_ip || acct.anchor_ip),
        has_recorded_pass: !!(acct.last_pass_hash || acct.prev_pass_hash || acct.anchor_pass_hash),
        // When the ownership evidence for this address last CHANGED (audit §J3-4). Anyone may
        // mine to any address, so a capture can be somebody else's session displacing yours —
        // and until now that happened in silence. Surfacing the timestamp lets the page say
        // "evidence last changed on <date>", which is the only way a miner can notice.
        // `anchor` reports whether the write-once original proof is still on record; while it
        // is, the address can always reach its own wallet even if both window slots are lost.
        evidence: {
          ip_changed_at: acct.last_ip_at || null,
          pass_changed_at: acct.last_pass_at || null,
          anchor: !!(acct.anchor_ip || acct.anchor_pass_hash),
        },
        // The `donateN` worker-name tag writes this, and it debits every future block credit
        // (lib/incentives.js applyToDistribution). It was previously invisible to the miner:
        // this endpoint never returned it and the only public surface is a Top-100 donor wall,
        // which a victim reaches only after enough of their money has already moved. A number
        // the pool acts on to reduce someone's earnings has to be readable by that someone.
        // Guarded on its own: this reads pool_config, and the account page is the miner's money
        // UI. A settings hiccup must degrade one advisory row, never 500 the whole summary.
        donation_percent: (() => {
          try {
            if (!incentivesManager || !incentivesManager.donationsActive()) return 0;
            return incentivesManager.donationPercent(acct.grin_address) || 0;
          } catch (e) { return 0; }
        })(),
        // Password-proof diagnostics — why the gate will or won't accept a rig password.
        //   state — the LAST-SEEN login's verdict ('ok' | 'none' | a reject code). Persisted.
        //   live  — cross-rig consistency among CURRENTLY CONNECTED sessions (counts only).
        // Both are deliberately public (the page is address-addressable with no login). A
        // non-compliant password can never be accepted as proof, so telling a visitor it is
        // short or a factory default reveals only that a door they can't open is shut — while
        // hiding it would hide the warning from the one person who needs it.
        password_proof: {
          state: acct.pass_proof_state || null,
          live: minerManager ? minerManager.getPasswordConsistency(acct.grin_address) : null
        },
        // Goblin/Nostr payout rail (design §15). Destination npub is NOT exposed (it's the
        // pinned secret-ish anchor); only the display username + cooldown state, so the UI
        // can show "pending / active at <UTC>". active = past the security cooldown.
        nostr_payouts_enabled: !!(nostrBridge && nostrBridge.isEnabled()),
        nostr_destination: acct.nostr_npub ? {
          username: acct.nostr_username,
          registered_at: acct.nostr_registered_at,
          active_at: acct.nostr_registered_at +
            (config.nostr_destination_cooldown_hours !== undefined ? config.nostr_destination_cooldown_hours : 48) * 3600,
          active: Math.floor(Date.now() / 1000) >=
            acct.nostr_registered_at +
            (config.nostr_destination_cooldown_hours !== undefined ? config.nostr_destination_cooldown_hours : 48) * 3600,
        } : null
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
      const windowMin = Math.min(Math.max(parseInt(req.query.window, 10) || 10, 1), 1440);
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
      const hours = Math.min(Math.max(parseInt(req.query.hours, 10) || 24, 1), 720);
      const series = hashrateTracker.getAccountHistory(addr, hours);
      res.json({ grin_address: addr, hours, series });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // REMOVED (2026-07-17): POST /api/account/:addr/min-payout — the per-account payout threshold
  // was an auto-payout-era relic. Withdrawals are miner-initiated with an explicit amount, so
  // only the pool-wide config.min_withdrawal floor applies (enforced in withdrawal-scheduler).
  // The miner_accounts.min_payout column stays in the schema but is read by nothing.

  // Pool-wide hashrate time-series (SUM across addresses per bucket) for the dashboard chart.
  app.get('/api/pool/hashrate/history', rateLimiter.middleware('public'), (req, res) => {
    try {
      const hours = Math.min(Math.max(parseInt(req.query.hours, 10) || 24, 1), 720);
      const series = hashrateTracker.getPoolHistory(hours);
      res.json({ hours, series });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Durable pool-wide trend series (hashrate · miners · earnings · payout) from pool_metrics_hourly.
  // One fetch feeds all three miners-stats.html charts; ?range selects span + bucket size.
  app.get('/api/pool/metrics/history', rateLimiter.middleware('public'), (req, res) => {
    try {
      const allowed = ['day', 'week', 'month', 'year', 'all'];
      const range = allowed.includes(req.query.range) ? req.query.range : 'day';
      res.json(hashrateTracker.getMetricsHistory(range));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Per-region (gateway) companion to /api/pool/metrics/history: durable miners/hashrate trend
  // per stratum region, for the "miners by gateway" chart. Same ?range vocabulary.
  app.get('/api/pool/metrics/history/regions', rateLimiter.middleware('public'), (req, res) => {
    try {
      const allowed = ['day', 'week', 'month', 'year', 'all'];
      const range = allowed.includes(req.query.range) ? req.query.range : 'day';
      const out = hashrateTracker.getRegionMetricsHistory(range);

      // Same k-anonymity floor as /api/pool/stats/regions (audit §J11-5), applied per POINT.
      // This route is the durable half: `?range=all` publishes the whole recorded history of
      // per-region miner counts, so suppressing only the live view would leave yesterday's
      // "sgn had 1 miner" permanently readable. Rules identical to the live route — zero stays
      // zero, hashrate is suppressed with the count (with one miner it IS that miner's rig),
      // and the whole thing is skipped for a single-region pool. Applied here rather than in
      // hashrate-tracker.js so admin/internal readers keep the true series.
      const kMinRegions = minBucket();
      let suppressedPoints = 0;
      if (Array.isArray(out.series) && out.series.length > 1) {
        for (const s of out.series) {
          for (const p of (s.points || [])) {
            if (p.miner_count > 0 && p.miner_count < kMinRegions) {
              p.miner_count = null;
              p.hashrate_gps = null;
              p.below_floor = true;
              suppressedPoints++;
            }
          }
        }
      }
      out.min_bucket = (Array.isArray(out.series) && out.series.length > 1) ? kMinRegions : null;
      out.suppressed_points = suppressedPoints;
      res.json(out);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Durable payments & transparency series (payouts · reward split · giveaways · donations · fee)
  // from the never-pruned withdrawals + balance_log tables. One fetch feeds the whole
  // payment-history.html ledger deck; ?range selects span + bucket size (totals stay lifetime).
  app.get('/api/pool/payments/history', rateLimiter.middleware('public'), (req, res) => {
    try {
      const allowed = ['day', 'week', 'month', 'year', 'all'];
      const range = allowed.includes(req.query.range) ? req.query.range : 'month';
      res.json(hashrateTracker.getPaymentsHistory(range));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Donor wall — every address that has donated payout slices (donateN worker tag) to the
  // prize pool, with lifetime total and first/last donation date. Composite read per the
  // ledger-rollup horizon contract: rollup(day < H) + raw(created_at >= H), so totals stay
  // exact forever while raw rows age out. first/last dates from rolled days are UTC-day
  // aligned — day precision is all the public wall displays anyway. Current donate-% comes
  // from miner_incentives (0 = paused; past donors stay on the wall).
  app.get('/api/pool/donors', rateLimiter.middleware('public'), (req, res) => {
    try {
      const H = getLedgerRollupHorizon(db); // 0 = no rollup yet → whole ledger is raw
      const donors = db.prepare(`
        SELECT d.grin_address AS address,
               d.total_donated, d.first_donated_at, d.last_donated_at, d.donation_count,
               COALESCE(mi.donation_percent, 0) AS current_percent
        FROM (
          SELECT grin_address,
                 SUM(amt) AS total_donated,
                 MIN(t)   AS first_donated_at,
                 MAX(t)   AS last_donated_at,
                 SUM(cnt) AS donation_count
          FROM (
            SELECT grin_address, total_amount AS amt, day AS t, event_count AS cnt
            FROM balance_log_daily
            WHERE event_type = 'debit' AND reference_type = 'donation' AND day < ?
            UNION ALL
            SELECT grin_address, amount, created_at, 1
            FROM balance_log
            WHERE event_type = 'debit' AND reference_type = 'donation' AND created_at >= ?
          )
          GROUP BY grin_address
        ) d
        LEFT JOIN miner_incentives mi ON mi.grin_address = d.grin_address
        WHERE d.total_donated > 0
        ORDER BY d.total_donated DESC
        LIMIT 100
      `).all(H, H);

      const totals = {
        donor_count: donors.length,
        active_donors: donors.filter((r) => r.current_percent > 0).length,
        total_donated: parseFloat(donors.reduce((a, r) => a + r.total_donated, 0).toFixed(9))
      };
      // `address` MASKED since 2026-09-02 (audit §J11-1) — after the totals are summed, so the
      // wall's arithmetic is unaffected. A donor wall is a thank-you, not an identity register.
      donors.forEach((r) => {
        r.total_donated = parseFloat(r.total_donated.toFixed(9));
        r.address = maskAddr(r.address);
      });
      res.json({ donors, totals });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Public prize-pool transparency report: current balance + lifetime in/out totals broken down by
  // source (fee-cut · donations · operator top-ups · ABANDONED BALANCES · orphan clawbacks in;
  // prizes · jackpots · join bonuses · streaks out). Composite read over the
  // ledger-rollup horizon, so totals stay exact after raw balance_log rows prune. Incentives-gated:
  // when incentives are off the bucket still exists (abandoned sweeps can accumulate), so the report
  // is always available — it's a trust surface.
  //
  // LIFETIME TOTALS ONLY — `prizePoolStatement(0)` deliberately returns an EMPTY `recent[]`.
  // Per-event rows are safe in content (a prize-pool row's grin_address is always 'prize_pool',
  // never a miner's), but their timestamps expose the DATE AND SIZE OF EACH OPERATOR TOP-UP.
  // Top-ups are discretionary promotion spend on no fixed schedule, so publishing a per-event
  // cadence invites a "the pool stopped funding prizes" reading of what is just a quiet month.
  // The lifetime total stays public — it is the point of the page. The admin endpoint
  // (/api/admin/incentives/prize-pool) still requests the detail rows; only this public one drops
  // them. Raise the argument above 0 only as a deliberate disclosure decision, and render what you
  // expose — donate.html D-05 draws in.by/out.by only.
  app.get('/api/pool/prize-pool', rateLimiter.middleware('public'), (req, res) => {
    try {
      if (!incentivesManager) return res.json({ enabled: false, balance: 0, in: { total: 0, by: [] }, out: { total: 0, by: [] }, net: 0, recent: [] });
      const st = incentivesManager.prizePoolStatement(0);
      let enabled = false;
      try { enabled = incentivesManager.enabled(); } catch (_) { /* default false */ }
      res.json({ enabled, ...st });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Network share / luck / round effort / time-since-last-block — pool-trust signals.
  //  · network_share_pct = pool 1h GPS / live network GPS × 100 (how often this pool wins)
  //  · round_effort_pct  = Σ(share diff since last block) / current per-block network diff × 100
  //  · luck_100_pct      = mean over last 100 blocks of (round_shares / network_difficulty) × 100
  //    (UNDER 100% = luckier than expected; uses captured per-block columns, NULL rows skipped)
  //
  //    This ratio used to be the other way up here, which made "luck" mean the OPPOSITE of
  //    what it means everywhere else on the same site: BlockManager.getBlocksHistory and both
  //    blocks tables compute shares ÷ difficulty (the 2miners convention, and the one the
  //    public blocks page spells out in prose), so one page rendered "luck 87%" as a good
  //    round while the dashboard rendered "luck 87%" as a bad one. One convention, and it is
  //    the documented one.
  // Current network difficulty is cached ~60s to avoid hammering the node.
  //
  // MEMOISED 30 s. The network-difficulty half below was already cached for 60 s so a poll
  // could not hammer the node; the SHARE SUM next to it was not, and it is the expensive half
  // (audit §J12-7). Its inputs move no faster than a block, so a per-request rebuild bought
  // nothing.
  const EFFORT_TTL_MS = 30000;
  // Ceiling on how far back the round window may reach. `lastBlockAt` is null until this pool
  // finds its FIRST block, and the old `lastBlockAt || 0` turned that into `created_at > 0` —
  // a sum over the entire shares table, on every request, on a public endpoint the homepage
  // polls. That is launch day, and it is also any long dry spell on a small pool. 7 days is
  // well past the PPLNS/confirm retention horizon, so on a pool that HAS found a block the
  // floor never binds and the figure is unchanged.
  const EFFORT_WINDOW_MAX_S = 7 * 86400;
  let _effortCache = { at: 0, body: null };
  app.get('/api/pool/effort', rateLimiter.middleware('public'), async (req, res) => {
    try {
      if (_effortCache.body && (Date.now() - _effortCache.at) < EFFORT_TTL_MS) {
        return res.json(_effortCache.body);
      }
      const last = blockManager.getLastBlock();
      const lastBlockAt = last ? last.found_at : null;
      const now = Math.floor(Date.now() / 1000);
      // Floor, never 0. `round_window_capped` tells the page that the effort figure is measured
      // from the floor rather than from a real block, so a brand-new pool's number is honest.
      const roundFrom = Math.max(lastBlockAt || 0, now - EFFORT_WINDOW_MAX_S);

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
      ).get(roundFrom).d;

      const roundEffortPct = (netDiff && netDiff > 0)
        ? parseFloat(((roundDiff / netDiff) * 100).toFixed(2)) : null;

      // Pool's share of the live network hashrate — how often this pool wins blocks.
      // Both hashrates use the same C32 constants, so the ratio is the honest share.
      // Network GPS uses the 60s block target (no per-block timestamp here):
      //   GPS = diff × 42 / 60 / 16384   (see CLAUDE.md hashrate formula)
      const networkGps = (netDiff && netDiff > 0)
        ? (netDiff * 42) / 60 / 16384 : null;
      let poolGps = null;
      try { poolGps = hashrateTracker.getHashrateStats().pool_hashrate_1h_gps || 0; } catch (_) { /* null */ }
      const networkSharePct = (networkGps && networkGps > 0 && poolGps != null)
        ? parseFloat(((poolGps / networkGps) * 100).toFixed(2)) : null;

      const luckRows = db.prepare(
        `SELECT network_difficulty AS nd, round_shares AS rs FROM blocks
         WHERE network_difficulty IS NOT NULL AND round_shares > 0
         ORDER BY height DESC LIMIT 100`
      ).all();
      let luckPct = null;
      if (luckRows.length > 0) {
        const mean = luckRows.reduce((a, r) => a + (r.rs / r.nd), 0) / luckRows.length;
        luckPct = parseFloat((mean * 100).toFixed(1));
      }

      const body = {
        last_block_at: lastBlockAt,
        seconds_since_last_block: lastBlockAt ? (now - lastBlockAt) : null,
        round_shares: parseFloat(roundDiff.toFixed(6)),
        round_window_from: roundFrom,
        round_window_capped: roundFrom > (lastBlockAt || 0),
        network_difficulty: netDiff,
        round_effort_pct: roundEffortPct,
        network_hashrate_gps: networkGps != null ? parseFloat(networkGps.toFixed(6)) : null,
        network_share_pct: networkSharePct,
        luck_100_pct: luckPct,
        luck_sample: luckRows.length
      };
      _effortCache = { at: Date.now(), body };
      res.json(body);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── miningpoolstats.stream listing feed ────────────────────────────────────────────────────
  // The PULL half of the MPS integration: they poll this, we push nothing. Shape is a
  // field-for-field mirror of the SOLO feed (poolstats_<net>.json, built by
  // lib/07_mining_block_collector.py build_poolstats) — deliberately, because MPS already has a
  // working importer for that structure. A "better" shape would cost them a new adapter for a
  // small coin, which is how a listing request gets declined. If the two ever have to diverge,
  // add fields, never rename or drop one.
  //
  // Solo writes a static file on a 5-min cron because it has no backend; here the data is already
  // live in-process, so a route needs no cron, no state dir and no auth carve-out. If MPS insists
  // on a .json path, alias it in nginx rather than writing a file.
  //
  // Aggregates only — no address, no per-miner row, nothing that isn't already on the public
  // homepage. Safe to serve unauthenticated.
  app.get('/api/pool/poolstats', rateLimiter.middleware('public'), async (req, res) => {
    try {
      // 60s cache: MPS polls on a fixed interval and this is a public GET that touches the node
      // and the DB, so an uncached version is a free amplification handle (same reasoning as
      // getPoolHistory in lib/hashrate-tracker.js). Serve last-good on error rather than a
      // half-empty feed — a delisting-grade blank is worse than a slightly stale number.
      const cached = app.locals._poolstatsFeed;
      if (cached && (Date.now() - cached.at) < 60000) return res.json(cached.body);

      const now = Math.floor(Date.now() / 1000);
      const blockStats = blockManager.getPoolStats() || {};
      const sstats = stratumServer.getStats() || {};

      // NOT blockManager.getLastBlock() — that returns the highest height REGARDLESS of status,
      // so a freshly orphaned block would be published as "last block found". blocks_24h already
      // excludes orphans (blocks.js getPoolStats), so using it here would also make the feed
      // self-contradictory: "0 blocks in 24h" next to a last_block from ten minutes ago.
      let last = null;
      try {
        last = db.prepare(
          `SELECT height, found_at FROM blocks WHERE status != 'orphaned' ORDER BY height DESC LIMIT 1`
        ).get() || null;
      } catch (_) { /* leave null */ }

      let poolGps = null;
      try { poolGps = hashrateTracker.getHashrateStats().pool_hashrate_1h_gps || 0; } catch (_) { /* null */ }

      // Node tip: height + CUMULATIVE total_difficulty (solo's `network.difficulty` is the
      // cumulative field; `difficulty_per_block` below is the per-block one — don't swap them).
      let height = null, totalDiff = null, peers = null;
      try {
        const status = await blockMonitor.grinNode.getStatus();
        if (status && status.ok) {
          height = status.header_height || 0;
          totalDiff = status.total_difficulty != null ? status.total_difficulty : null;
          peers = status.peer_count || 0;
        }
      } catch (_) { /* leave null — a node blip must not blank the pool half */ }

      // Per-block difficulty reuses the /api/pool/effort 60s cache, so a poll costs no extra
      // node round-trip. GPS = diff × 42 / 60 / 16384 (CLAUDE.md; 60s block target).
      let netDiffPb = null;
      if (app.locals._netDiffCache && (Date.now() - app.locals._netDiffCache.at) < 60000) {
        netDiffPb = app.locals._netDiffCache.value;
      } else {
        try {
          const tip = await blockMonitor.grinNode.getTip();
          netDiffPb = await blockManager._fetchNetworkDifficulty(tip.height);
          app.locals._netDiffCache = { at: Date.now(), value: netDiffPb };
        } catch (_) { /* leave null */ }
      }
      const netGps = (netDiffPb && netDiffPb > 0) ? (netDiffPb * 42) / 60 / 16384 : null;

      // Smooth 24h network figure from the durable hourly rollup (solo derives it from a
      // get_header look-back; we already sample it every hour, so no extra node calls).
      let netGps24h = null;
      try {
        const r = db.prepare(
          `SELECT AVG(network_hashrate_gps) AS g FROM pool_metrics_hourly
           WHERE bucket_start > ? AND network_hashrate_gps IS NOT NULL`
        ).get(now - 86400);
        if (r && r.g != null) netGps24h = parseFloat(r.g.toFixed(3));
      } catch (_) { /* leave null */ }

      const body = {
        ts: new Date(now * 1000).toISOString(),
        // Report the REAL network. A testnet pool must never be importable as a mainnet one.
        net: config.network === 'testnet' ? 'testnet' : 'mainnet',
        pool: {
          name: config.pool_name || 'Grin Pool',
          url: config.subdomain ? `https://${config.subdomain}` : '',
          hashrate: poolGps != null ? parseFloat(poolGps.toFixed(3)) : 0,
          hashrate_unit: 'gps',
          workers: sstats.active_connections || 0,
          miners: minerManager.getActiveMinersCount() || 0,
          fee: config.pool_fee_percent || 0,
          reward_model: config.reward_model || 'pplns',
          blocks_24h: blockStats.blocks_24h || 0,
          last_block: last ? { height: last.height, ts: new Date(last.found_at * 1000).toISOString() } : null,
        },
        network: {
          height,
          difficulty: totalDiff,
          difficulty_per_block: netDiffPb,
          hashrate_gps: netGps != null ? parseFloat(netGps.toFixed(3)) : null,
          hashrate_gps_24h: netGps24h,
          connections: peers,
        },
      };
      app.locals._poolstatsFeed = { at: Date.now(), body };
      res.json(body);
    } catch (err) {
      // Last-good, but BOUNDED. An unbounded fallback means a permanently broken backend keeps
      // serving a plausible-looking feed forever, and a listing that silently freezes is worse
      // than one that visibly errors — the operator never finds out. Past the grace window, fail
      // loudly and let MPS show the pool as down, which is the truth.
      const cached = app.locals._poolstatsFeed;
      if (cached && (Date.now() - cached.at) < 15 * 60 * 1000) return res.json(cached.body);
      res.status(500).json({ error: err.message });
    }
  });

  // Append-only ledger for an address (every balance/locked change). No auth — the
  // ledger only exposes the address's own money movements, and the address is identity.
  // Filters: ?direction=in|out splits the ledger by money flow (in = credits + payout
  // reversals returned to balance; out = payout debits + donations + orphan clawbacks;
  // 'lock' events are neutral — the pending payout, surfaced separately — and only appear
  // in the unfiltered view). ?days=30|90|365 bounds the window (default: all history).
  // ?format=csv streams the filtered window as a CSV download (row-capped, rate-limited).
  const LEDGER_DIRECTION_SQL = {
    in: `(event_type = 'credit' OR (event_type = 'reversal' AND reference_type = 'withdrawal'))`,
    out: `(event_type = 'debit' OR (event_type = 'reversal' AND reference_type != 'withdrawal'))`
  };
  app.get('/api/account/:addr/balance/log', rateLimiter.middleware('public'), (req, res) => {
    try {
      const { addr } = req.params;
      // hasOwn, not a truthiness test on the index (audit §J3-7): a bare object literal
      // resolves `constructor` / `toString` / `hasOwnProperty` through Object.prototype, so
      // `?direction=constructor` passed the guard and spliced a native function's SOURCE into
      // the WHERE clause below. Harmless today — the attacker cannot influence that text and
      // SQLite rejects it — but it is a free 500 that echoes part of the query, and it is a
      // dynamic SQL fragment chosen by an unguarded object index, which is one prototype-
      // polluting path away from being the real thing. Same shape as §J1-6.
      const direction = Object.hasOwn(LEDGER_DIRECTION_SQL, req.query.direction) ? req.query.direction : null;
      const days = parseInt(req.query.days || 0);
      const cutoff = (days > 0) ? Math.floor(Date.now() / 1000) - Math.min(days, 3650) * 86400 : 0;
      const where = `grin_address = ? AND created_at >= ?` +
        (direction ? ` AND ${LEDGER_DIRECTION_SQL[direction]}` : '');

      if (req.query.format === 'csv') {
        // Same dedicated export throttle as the withdrawal-history CSV (anti download-spam).
        const gate = rateLimiter.peek('export', req);
        if (!gate.allowed) return rateLimiter.sendLimited(res, gate);
        rateLimiter.consume('export', req);

        const CSV_MAX_ROWS = 50000;
        const rows = db.prepare(
          `SELECT event_type, reference_type, reference_id, amount, balance_after, created_at
           FROM balance_log WHERE ${where}
           ORDER BY created_at DESC, id DESC LIMIT ${CSV_MAX_ROWS}`
        ).all(addr, cutoff);
        const esc = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
        const lines = ['created_at_utc,event_type,reference_type,reference_id,amount,balance_after'];
        for (const r of rows) {
          lines.push([
            new Date(r.created_at * 1000).toISOString(),
            esc(r.event_type), esc(r.reference_type), r.reference_id,
            r.amount, r.balance_after
          ].join(','));
        }
        const tag = direction || 'all';
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition',
          `attachment; filename="pool-ledger-${tag}-${addr.slice(0, 12)}-${days > 0 ? days + 'd' : 'all'}.csv"`);
        return res.send(lines.join('\n') + '\n');
      }

      const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 500);
      const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
      const total = db.prepare(`SELECT COUNT(*) AS c FROM balance_log WHERE ${where}`).get(addr, cutoff).c;
      const rows = db.prepare(
        `SELECT event_type, amount, balance_before, balance_after, locked_before, locked_after,
                reference_type, reference_id, created_at
         FROM balance_log WHERE ${where}
         ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`
      ).all(addr, cutoff, limit, offset);
      res.json({ grin_address: addr, direction, total, count: rows.length, log: rows });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Withdrawal (payout) history for an address — sourced from the `withdrawals` table, which
  // (unlike balance_log, whose raw rows are pruned after ~60 days) is kept forever, so this is
  // the durable record a miner can export for accounting. Payout-only: no donations or orphan
  // clawbacks. Public like the rest of the account page (the address is identity). ?format=csv
  // streams the full all-time history (row-capped, rate-limited); no ?days window by design.
  app.get('/api/account/:addr/withdrawals', rateLimiter.middleware('public'), (req, res) => {
    try {
      const { addr } = req.params;

      if (req.query.format === 'csv') {
        // Tight, dedicated throttle on the all-time bulk export (separate from the loose
        // `public` bucket) — one-click use is fine, download-spam is cut off after a few hits.
        const gate = rateLimiter.peek('export', req);
        if (!gate.allowed) return rateLimiter.sendLimited(res, gate);
        rateLimiter.consume('export', req);

        const CSV_MAX_ROWS = 50000;
        const rows = db.prepare(
          `SELECT id, amount, fee, method, status, created_at, confirmed_at, kernel_excess
           FROM withdrawals WHERE grin_address = ?
           ORDER BY created_at DESC, id DESC LIMIT ${CSV_MAX_ROWS}`
        ).all(addr);
        const esc = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
        // `kernel_excess` REPLACED by a yes/no flag (audit §J11-2). This export is 50,000 rows,
        // all-time, unauthenticated, for ANY address — the single cheapest way to build the
        // address→on-chain-transaction map the pool must not publish. The kernels themselves
        // now come from POST /api/account/:addr/withdrawals/proofs, behind the same ownership
        // proof a withdrawal needs. The flag stays so an accounting export still says which
        // payouts HAVE a proof to fetch.
        const lines = ['id,requested_at_utc,confirmed_at_utc,method,status,amount,fee,has_kernel_proof'];
        for (const r of rows) {
          lines.push([
            r.id,
            new Date(r.created_at * 1000).toISOString(),
            r.confirmed_at ? new Date(r.confirmed_at * 1000).toISOString() : '',
            esc(r.method), esc(r.status), r.amount, r.fee, r.kernel_excess ? 'yes' : 'no'
          ].join(','));
        }
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition',
          `attachment; filename="pool-withdrawals-${addr.slice(0, 12)}-all.csv"`);
        return res.send(lines.join('\n') + '\n');
      }

      const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 200);
      const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
      const total = db.prepare(
        `SELECT COUNT(*) AS c FROM withdrawals WHERE grin_address = ?`
      ).get(addr).c;
      // `kernel_excess` is NOT in this response (audit §J11-2) — `has_kernel_proof` replaces it,
      // so the account page can render the Proof column's affordance without the value. The
      // value itself needs an ownership proof; see the route directly below.
      const rows = db.prepare(
        `SELECT id, amount, fee, method, status, created_at, confirmed_at, kernel_excess
         FROM withdrawals WHERE grin_address = ?
         ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`
      ).all(addr, limit, offset).map((r) => {
        const { kernel_excess, ...rest } = r;
        return { ...rest, has_kernel_proof: !!kernel_excess };
      });
      res.json({ grin_address: addr, total, count: rows.length, withdrawals: rows });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── On-chain payment proofs for THIS address (ownership-gated) ─────────────
  // The other half of §J11-2. Grin has no txid; the payment-proof primitive is the kernel
  // excess, and `withdrawals.kernel_excess` exists so a miner can verify their own payout on a
  // chain explorer. That is a real feature and it stays — but it was readable, all-time and in
  // bulk, for ANY address by anyone, which on a privacy coin is a public
  // address ↔ on-chain-transaction index. Nothing else the pool publishes is as durable: a
  // balance changes, a kernel is in the chain forever.
  //
  // So the kernel is now the ONE field on the account page that costs an ownership proof — the
  // same proof (recent mining IP or rig password) a withdrawal needs, verified by the same
  // function, audited on both paths, and on the same `withdraw` bucket. It is a POST because
  // the proof travels in a body, never in a URL that lands in an access log.
  //
  // Deliberately NOT on the loose `public` bucket: verifyOwnerProof runs scrypt (16 MB), so a
  // public-bucket proof endpoint is a CPU lever — that is §F2, and this route must not re-open it.
  app.post('/api/account/:addr/withdrawals/proofs', rateLimiter.middleware('withdraw'), async (req, res) => {
    try {
      const { addr } = req.params;
      const reqIp = normalizeIp(req.ip);
      const submitted = (req.body && (req.body.proof || req.body.ip_proof)) || '';

      // Account-existence check first, matching its GET sibling: an address that never mined
      // here is "not found" whether or not a proof was supplied, so this adds no new signal.
      const acct = db.prepare('SELECT 1 AS x FROM miner_accounts WHERE grin_address = ?').get(addr);
      if (!acct) return res.status(404).json({ error: 'Account not found' });

      const proof = await verifyOwnerProof(db, addr, submitted, reqIp);
      if (!proof.ok) {
        auditOwnerProof(db, { action: 'kernel_proofs', grinAddress: addr, ip: reqIp, ok: false, details: { reason: proof.reason } });
        return res.status(403).json({ error: 'Ownership proof failed', reason: proof.reason });
      }
      auditOwnerProof(db, { action: 'kernel_proofs', grinAddress: addr, ip: reqIp, ok: true, details: { proof_method: proof.method } });

      // Only rows that actually carry a kernel. Keyed by withdrawal id so the client can merge
      // them into the table it already has without re-fetching it.
      const rows = db.prepare(
        `SELECT id, kernel_excess FROM withdrawals
         WHERE grin_address = ? AND kernel_excess IS NOT NULL AND kernel_excess != ''`
      ).all(addr);
      const proofs = {};
      for (const r of rows) proofs[r.id] = r.kernel_excess;
      res.json({ grin_address: addr, count: rows.length, proofs });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Credited earnings summed per period (block rewards + bonuses/giveaways), plus the 30-day
  // outflow total — drives the account page's earnings table and the ledger Σ titles. Reads RAW
  // balance_log, which retention DOES prune (database.balance_log_keep_days, default 60 with a
  // hard 45-day floor) — that floor is why the longest period here is 30 days. A longer one
  // would have to read the balance_log_daily rollup too, the way /api/pool/donors does.
  app.get('/api/account/:addr/earnings', rateLimiter.middleware('public'), (req, res) => {
    try {
      const { addr } = req.params;
      const now = Math.floor(Date.now() / 1000);
      // Earnings = true credits only. A payout reversal is "money in" for the ledger card but
      // NOT earnings — counting it would inflate the table every time a payout is cancelled.
      const sums = db.prepare(
        `SELECT
           COALESCE(SUM(CASE WHEN created_at > ? THEN amount END), 0) AS h1,
           COALESCE(SUM(CASE WHEN created_at > ? THEN amount END), 0) AS h24,
           COALESCE(SUM(CASE WHEN created_at > ? THEN amount END), 0) AS d7,
           COALESCE(SUM(CASE WHEN created_at > ? THEN amount END), 0) AS d30
         FROM balance_log
         WHERE grin_address = ? AND event_type = 'credit'`
      ).get(now - 3600, now - 86400, now - 7 * 86400, now - 30 * 86400, addr);
      const in30 = db.prepare(
        `SELECT COALESCE(SUM(amount), 0) AS s FROM balance_log
         WHERE grin_address = ? AND created_at > ? AND ${LEDGER_DIRECTION_SQL.in}`
      ).get(addr, now - 30 * 86400).s;
      const out30 = db.prepare(
        `SELECT COALESCE(SUM(amount), 0) AS s FROM balance_log
         WHERE grin_address = ? AND created_at > ? AND ${LEDGER_DIRECTION_SQL.out}`
      ).get(addr, now - 30 * 86400).s;
      res.json({ grin_address: addr, periods: sums, in_30d: in30, out_30d: out30 });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Is this miner reachable over Tor right now? Drives the UI hint for whether an
  // auto (Tor) payout can succeed vs. needing a Slatepack claim. No state change.
  // ─── Tor reachability probe cache ───────────────────────────────────────────
  // probeToronlineStatus builds a Tor circuit and SOCKS-connects (up to torCheckRetries attempts
  // × tor_check_timeout_ms), so an uncached public endpoint turns one cheap HTTP request into
  // seconds of outbound work. The answer barely changes minute to minute — a wallet listener is
  // either up or it isn't — so a short cache costs the miner nothing and makes repeat clicks free.
  //
  // DELIBERATELY NOT used by the withdraw pre-flight gate. That one is a money decision (it can
  // refuse a payout), so it always takes a fresh probe: a 60s-stale "offline" must never block a
  // listener the miner just started. Caching a UI hint and caching a gate are different calls.
  const TOR_PROBE_TTL_MS = 60000;
  const TOR_PROBE_MAX = 500;                 // bound the map — this is a cache, not a registry
  const torProbeCache = new Map();           // addr -> { at, result }
  const torProbeInflight = new Map();        // addr -> Promise (collapses concurrent probes)

  const torProbeCached = async (addr) => {
    const hit = torProbeCache.get(addr);
    if (hit && (Date.now() - hit.at) < TOR_PROBE_TTL_MS) return hit.result;

    // Rapid repeat clicks are exactly what this endpoint sees, and they arrive before the first
    // probe resolves — so dedup in-flight too, or the cache never gets the chance to help.
    const inflight = torProbeInflight.get(addr);
    if (inflight) return inflight;

    const p = (async () => {
      try {
        const result = await walletTor.probeToronlineStatus(addr);
        const now = Date.now();
        if (torProbeCache.size >= TOR_PROBE_MAX) {
          for (const [k, v] of torProbeCache) {
            if ((now - v.at) >= TOR_PROBE_TTL_MS) torProbeCache.delete(k);
          }
          // Still full → everything is live; drop the oldest insert (Map keeps insertion order)
          // so a sweep across distinct addresses can never grow this without bound.
          if (torProbeCache.size >= TOR_PROBE_MAX) {
            torProbeCache.delete(torProbeCache.keys().next().value);
          }
        }
        torProbeCache.set(addr, { at: now, result });
        return result;
      } finally {
        torProbeInflight.delete(addr);
      }
    })();
    torProbeInflight.set(addr, p);
    return p;
  };

  app.get('/api/account/:addr/tor-check', rateLimiter.middleware('torcheck'), async (req, res) => {
    try {
      const { addr } = req.params;
      // Must have actually mined here. Without this the endpoint was a public oracle: the onion
      // is derived from the bech32 address by pure math, so it answered "is this wallet listener
      // up right now?" for ANY Grin address — an activity side-channel on people who never opted
      // into this pool at all. The 404 matches GET /api/account/:addr exactly, so it reveals
      // nothing that endpoint doesn't already. For miners who ARE here the residual signal is
      // small: the pool already publishes their hashrate, which tracks activity far more closely.
      const known = db.prepare('SELECT 1 AS x FROM miner_accounts WHERE grin_address = ?').get(addr);
      if (!known) return res.status(404).json({ error: 'no mining account for this address' });

      const result = await torProbeCached(addr);
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

  // Miner-initiated withdrawal (address-as-identity). Two rails, BOTH ownership-gated
  // (operator decision 2026-07-17 — "every money action goes behind the gate"): even though
  // neither rail can steal (Tor pays only to the address's own wallet; a slatepack is encrypted
  // to the address), an ungated trigger let anyone reading the public leaderboard force payouts
  // for other people's addresses — burning pool-paid network fees, consuming hot-wallet outputs
  // and force-moving coins the owner didn't ask to move. Proof = a recent mining IP (v4/v6) OR
  // the rig's stratum password (lib/owner-proof.js; single `proof` field, legacy `ip_proof`
  // still accepted). Rate-limited; CAS balance lock + 1-pending-per-address cap in the scheduler.
  app.post('/api/account/:addr/withdraw', rateLimiter.middleware('withdraw'), async (req, res) => {
    try {
      const { addr } = req.params;
      const method = (req.body && req.body.method) || 'tor';
      const reqIp = normalizeIp(req.ip);
      const submitted = (req.body && (req.body.proof || req.body.ip_proof)) || '';

      const proof = await verifyOwnerProof(db, addr, submitted, reqIp);
      if (!proof.ok) {
        auditOwnerProof(db, { action: `withdraw_${method}`, grinAddress: addr, ip: reqIp, ok: false, details: { reason: proof.reason } });
        return res.status(403).json({ error: 'Ownership proof failed', reason: proof.reason });
      }

      if (method === 'tor') {
        // Cheap admission checks FIRST — audit §J12-12. The pre-flight probe below builds up to
        // two fresh Tor circuits (≤6 s), and it used to run before any of this, so a miner
        // holding one valid proof could force 20 circuit builds a minute at the `withdraw`
        // bucket while every withdrawal they asked for would have been refused anyway. This is
        // an early refusal, not the gate: createWithdrawal repeats all of it authoritatively
        // inside its transaction, so the ordering change costs nothing and races nothing.
        //
        // It deliberately does NOT weaken the probe's freshness guarantee (index.js:3737): a
        // request that will actually create a withdrawal still takes a fresh probe.
        try {
          withdrawalScheduler.precheckWithdrawable(addr);
        } catch (e) {
          return res.status(e.code && e.code < 600 ? e.code : 400).json({ error: e.message });
        }

        // Pre-flight reachability gate (operator toggle, default ON). Refuse up front — BEFORE
        // any balance lock or cooldown — if the miner's wallet listener isn't answering over Tor
        // right now, so the funds never get locked into a doomed retry ladder. Only a CONFIDENT
        // offline (online === false) blocks; online === null (probe couldn't run) falls through
        // and lets grin-wallet be the authority at send, so a pool box without a working probe
        // never blocks every Tor payout.
        if (config.tor_preflight_gate !== false) {
          let reach = { online: null };
          try { reach = await walletTor.probeToronlineStatus(addr); }
          catch (e) { reach = { online: null, reason: `probe_error: ${e.message}` }; }
          if (reach.online === null) {
            // Fail OPEN is deliberate (memory project_pool_tor_preflight_gate). It must not be
            // fail SILENT: neither the probe nor this route said anything when it could not run,
            // so an operator who switched the gate on had no way to learn it had been inert since
            // the tor daemon died / `socks` went missing (audit §J4-7).
            console.warn(
              `[tor-preflight] gate could not run (${reach.reason || 'unknown'}) — allowing the ` +
              `send; grin-wallet remains the authority at send time`
            );
          }
          if (reach.online === false) {
            auditOwnerProof(db, { action: 'withdraw_tor', grinAddress: addr, ip: reqIp, ok: false, details: { reason: 'tor_unreachable', probe: reach.reason } });
            return res.status(409).json({
              error: 'Your wallet is not reachable over Tor right now. Start your wallet listener and try again, or withdraw via Slatepack (which does not need your wallet online).',
              reason: reach.reason || 'tor_unreachable',
              tor_online: false,
              suggest: 'slatepack'
            });
          }
        }
        const result = withdrawalScheduler.createWithdrawal(addr, req.body && req.body.amount, method);
        auditOwnerProof(db, { action: 'withdraw_tor', grinAddress: addr, ip: reqIp, ok: true, details: { withdrawal_id: result.withdrawal_id, amount: result.amount, proof_method: proof.method } });
        return res.json({ success: true, withdrawal_id: result.withdrawal_id, status: 'tor_checking' });
      }

      if (method === 'slatepack') {
        const result = await withdrawalScheduler.createSlatepackWithdrawal(addr, req.body && req.body.amount);
        auditOwnerProof(db, { action: 'withdraw_slatepack', grinAddress: addr, ip: reqIp, ok: true, details: { withdrawal_id: result.withdrawal_id, amount: result.amount, proof_method: proof.method } });
        return res.json({ success: true, withdrawal_id: result.withdrawal_id, amount: result.amount, status: 'slatepack_pending', slatepack: result.slatepack });
      }

      if (method === 'nostr') {
        if (!nostrBridge || !nostrBridge.isEnabled()) return res.status(503).json({ error: 'nostr payouts are not enabled on this pool' });
        // The destination must be REGISTERED, aged past the cooldown, and still resolve to the
        // SAME npub it was pinned to (TOFU) — this is what stops a passed ownership gate from
        // redirecting funds to an attacker's account (design §15.2). All three are re-checked
        // here at send time, never trusting a username supplied in the request body.
        const dest = db.prepare(
          'SELECT nostr_username, nostr_npub, nostr_registered_at FROM miner_accounts WHERE grin_address = ?'
        ).get(addr);
        if (!dest || !dest.nostr_npub || !dest.nostr_registered_at) {
          return res.status(409).json({ error: 'no Goblin destination registered — add one first' });
        }
        const cooldownH = config.nostr_destination_cooldown_hours !== undefined ? config.nostr_destination_cooldown_hours : 48;
        const activeAt = dest.nostr_registered_at + cooldownH * 3600;
        const nowS = Math.floor(Date.now() / 1000);
        if (nowS < activeAt) {
          return res.status(409).json({ error: 'Goblin destination is still in its security cooldown', active_at: activeAt });
        }
        // TOFU re-pin: re-resolve the stored username and refuse if the npub changed.
        let resolved;
        try { resolved = await nostrBridge.resolveDestination(dest.nostr_username); }
        catch (e) { return res.status(e.code && e.code < 600 ? e.code : 502).json({ error: `could not verify Goblin destination: ${e.message}` }); }
        if (resolved.pubHex !== dest.nostr_npub) {
          auditOwnerProof(db, { action: 'withdraw_nostr', grinAddress: addr, ip: reqIp, ok: false, details: { reason: 'npub_changed', username: dest.nostr_username } });
          return res.status(409).json({ error: 'your Goblin username now points to a different key — re-register the destination (a fresh cooldown applies)' });
        }
        const result = await withdrawalScheduler.createNostrWithdrawal(
          addr, req.body && req.body.amount, dest.nostr_npub, `Grin mining payout — ${dest.nostr_username}`
        );
        auditOwnerProof(db, { action: 'withdraw_nostr', grinAddress: addr, ip: reqIp, ok: true, details: { withdrawal_id: result.withdrawal_id, amount: result.amount, proof_method: proof.method, username: dest.nostr_username } });
        return res.json({ success: true, withdrawal_id: result.withdrawal_id, amount: result.amount, status: 'slatepack_pending' });
      }

      return res.status(400).json({ error: `unsupported withdrawal method: ${method}` });
    } catch (err) {
      res.status(err.code && err.code >= 400 && err.code < 600 ? err.code : 500).json({ error: err.message });
    }
  });

  // Complete a slatepack withdrawal: the miner pastes back the RESPONSE slatepack their wallet
  // produced after `receive`. Ownership-gated like the trigger. The pool finalizes + broadcasts.
  app.post('/api/account/:addr/withdraw/:id/finalize', rateLimiter.middleware('withdraw'), async (req, res) => {
    try {
      const { addr, id } = req.params;
      const reqIp = normalizeIp(req.ip);
      const proof = await verifyOwnerProof(db, addr, (req.body && (req.body.proof || req.body.ip_proof)) || '', reqIp);
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

  // ─── Goblin/Nostr payout destination (design §15) ────────────────────────────
  // Register/replace the Goblin username funds may be sent to over Nostr. This does NOT move
  // funds — it stores the pinned destination and (re)starts the security cooldown.
  //
  // WHY THIS GATE IS STRICTER THAN A WITHDRAWAL. Tor pays the miner's OWN address and a
  // slatepack is encrypted TO it, so passing the ownership gate on those rails buys an
  // attacker nothing. Goblin pays a USERNAME — so this endpoint, not the withdraw endpoint,
  // is where money can be redirected. It therefore demands BOTH proofs (mining IP AND rig
  // password) where a withdrawal accepts either. The trade is deliberate: a miner with no
  // usable rig password cannot use the Goblin rail until they set one and mine again.
  //
  // Three layers sit behind this, each doing a different job: the AND-gate raises the bar to
  // get in; a DM to the PREVIOUS destination gives the real owner out-of-band detection; the
  // cooldown gives them time to act on it (withdraw via Tor, which an attacker cannot touch).
  // AND-gate + AGE-gate (audit §J3-1). The AND alone was never two factors: both legs are
  // written by ONE call on ONE accepted share
  // (lib/stratum-server.js recordOwnerEvidence), and anyone may mine to anyone's address —
  // so a stranger who pointed a rig at this address for a few seconds, with a password of
  // their choosing, held the mining IP AND the rig password and could re-point the payout.
  //
  // What actually separates the owner from that attacker is AGE: the owner's evidence has been
  // on record since they started mining, the attacker's was minted minutes ago. So each leg
  // must additionally have been captured at least `minAgeSec` ago — the destination cooldown,
  // the same window the operator already accepts as "long enough for the real owner to notice".
  // A miner whose IP has just changed is not locked out by this: their PREVIOUS IP is still in
  // the window with its own older timestamp, and submitting that one passes.
  //
  // The anchor slot is refused outright. It is unrevocable by construction (§J3-4), which is
  // exactly right for getting your own money to your own wallet and exactly wrong for changing
  // where the money goes — a leaked first-ever rig password must not be a permanent key to
  // somebody else's payout destination.
  const requireBothProofs = async (addr, body, reqIp, action) => {
    const ipRaw = (body && (body.ip_proof || body.proof)) || '';
    const passRaw = (body && body.password_proof) || '';
    if (!ipRaw || !passRaw) {
      return { ok: false, code: 400, error: 'Both your mining IP and your rig password are required to change a payout destination', reason: 'both_proofs_required' };
    }
    const cooldownH = config.nostr_destination_cooldown_hours !== undefined ? config.nostr_destination_cooldown_hours : 48;
    // Floored, and NOT allowed to reach zero. The destination cooldown is an operator dial and
    // 0 is a legitimate setting for it ("don't make me wait after registering") — but the age
    // requirement is a different control that happens to borrow the same number, and letting a
    // 0 there switch it off would silently restore the §J3-1 hole on any pool that turned the
    // cooldown down. An injected proof is minutes old; one hour breaks "mine for ten seconds,
    // then redirect" while staying invisible to anyone who has actually been mining here.
    const MIN_PROOF_AGE_SEC = 3600;
    const minAgeSec = Math.max(MIN_PROOF_AGE_SEC, (Math.max(0, Number(cooldownH) || 0) * 3600));
    // A leg is acceptable only from the live last-2 window, and only once it has aged.
    // age_seconds === null means the slot predates the timestamp columns; treat an unknown
    // age as OLD, not as fresh — those rows were written before this attack was reachable,
    // and failing them closed would lock out every miner who mined before the upgrade.
    const legFails = (p) => {
      if (p.slot === 'anchor') return 'anchor_not_accepted_here';
      if (p.age_seconds !== null && p.age_seconds !== undefined && p.age_seconds < minAgeSec) {
        return 'proof_too_recent';
      }
      return null;
    };
    const deny = (leg, reason, code) => {
      auditOwnerProof(db, { action, grinAddress: addr, ip: reqIp, ok: false, details: { reason, leg } });
      return {
        ok: false, code: code || 403, reason,
        error: reason === 'proof_too_recent'
          ? `That ${leg === 'ip' ? 'mining IP' : 'rig password'} was only recorded recently. A payout destination can only be changed using evidence at least ${cooldownH} h old — this is what stops someone who briefly mined to your address from re-pointing your payouts.`
          : reason === 'anchor_not_accepted_here'
            ? 'That proof is your original recorded one. It can withdraw to your own wallet, but changing a payout destination needs your current mining IP and rig password.'
            : (leg === 'ip' ? 'Mining IP proof failed' : 'Rig password proof failed'),
      };
    };
    // Checked in order so a wrong IP costs one failed attempt, not two.
    const ipProof = await verifyOwnerProof(db, addr, ipRaw, reqIp);
    if (!ipProof.ok || ipProof.method !== 'ip') {
      return deny('ip', ipProof.reason || 'ip_no_match');
    }
    const ipBad = legFails(ipProof);
    if (ipBad) return deny('ip', ipBad, 409);
    // method must be 'password' — submitting the password in BOTH fields must not pass.
    const passProof = await verifyOwnerProof(db, addr, passRaw, reqIp);
    if (!passProof.ok || passProof.method !== 'password') {
      return deny('password', passProof.reason || 'password_no_match');
    }
    const passBad = legFails(passProof);
    if (passBad) return deny('password', passBad, 409);
    return { ok: true, method: 'ip+password' };
  };

  // Fire the change alert at the destination being REPLACED. Best-effort by contract
  // (publishNotice never throws) — a relay outage must not block a legitimate change — but
  // the outcome is always audited and returned, because an alert nobody received is not a
  // control. Advice order matters: withdrawing via Tor moves the money beyond reach, whereas
  // re-registering only evicts the attacker and leaves the balance sitting there.
  const alertPreviousDestination = async (prevNpub, prevUsername, newUsername, addr, reqIp) => {
    if (!prevNpub || !nostrBridge || !nostrBridge.isEnabled()) return null;
    const text = newUsername
      ? `Your Grin payout destination was CHANGED to "${newUsername}".\n\n`
        + `If this was not you, act now:\n`
        + `1. Withdraw your balance using Tor or Slatepack — those rails still work and can only pay your own mining address.\n`
        + `2. Then re-register your Goblin destination to evict the change.\n\n`
        + `Mining address: ${addr}`
      : `Your Grin payout destination ("${prevUsername || 'previous'}") was REMOVED.\n\n`
        + `If this was not you, withdraw your balance using Tor or Slatepack now — those rails `
        + `still work and can only pay your own mining address.\n\nMining address: ${addr}`;
    const sent = await nostrBridge.publishNotice(prevNpub, text, 'Grin pool: payout destination changed');
    auditOwnerProof(db, {
      action: 'nostr_destination_alert', grinAddress: addr, ip: reqIp, ok: !!sent.ok,
      details: { prev_username: prevUsername || null, new_username: newUsername || null, error: sent.ok ? null : sent.error }
    });
    return sent;
  };

  app.post('/api/account/:addr/nostr-destination', rateLimiter.middleware('withdraw'), async (req, res) => {
    try {
      const { addr } = req.params;
      const reqIp = normalizeIp(req.ip);
      if (!nostrBridge || !nostrBridge.isEnabled()) return res.status(503).json({ error: 'nostr payouts are not enabled on this pool' });

      const proof = await requireBothProofs(addr, req.body, reqIp, 'nostr_destination_register');
      if (!proof.ok) return res.status(proof.code).json({ error: proof.error, reason: proof.reason });

      const acct = db.prepare('SELECT grin_address FROM miner_accounts WHERE grin_address = ?').get(addr);
      if (!acct) return res.status(404).json({ error: 'Account not found' });

      let resolved;
      try { resolved = await nostrBridge.resolveDestination((req.body && req.body.username) || ''); }
      catch (e) { return res.status(e.code && e.code < 600 ? e.code : 400).json({ error: e.message }); }

      // Replacing an existing destination needs an explicit confirmation carrying the username
      // being replaced. Enforced SERVER-side, not just in the UI: a client-side "are you sure"
      // is skippable by anyone posting directly, and this step exists to catch a mistyped
      // username sending real money to a stranger — irreversibly. Echoing `replacing` back
      // means the confirmation the operator saw is the state the server actually holds.
      const prev = db.prepare(
        'SELECT nostr_username, nostr_npub, nostr_prev_username, nostr_prev_npub FROM miner_accounts WHERE grin_address = ?'
      ).get(addr) || {};
      if (prev.nostr_npub && prev.nostr_npub !== resolved.pubHex &&
          String((req.body && req.body.confirm_replace) || '') !== String(prev.nostr_username)) {
        return res.status(409).json({
          error: `This replaces your current destination "${prev.nostr_username}" and restarts the security cooldown.`,
          reason: 'confirm_replace_required',
          replacing: prev.nostr_username,
          replacing_with: resolved.username,
        });
      }

      const nowS = Math.floor(Date.now() / 1000);
      // Carry the outgoing destination forward so a later REMOVE still has somewhere to send
      // the alert. An unchanged re-registration (same npub, cooldown refresh) must not
      // overwrite a genuine previous destination with itself.
      const keepPrevUser = prev.nostr_npub && prev.nostr_npub !== resolved.pubHex
        ? prev.nostr_username : (prev.nostr_prev_username || null);
      const keepPrevNpub = prev.nostr_npub && prev.nostr_npub !== resolved.pubHex
        ? prev.nostr_npub : (prev.nostr_prev_npub || null);
      db.prepare(
        `UPDATE miner_accounts SET nostr_username = ?, nostr_npub = ?, nostr_registered_at = ?,
           nostr_prev_username = ?, nostr_prev_npub = ?, updated_at = unixepoch()
         WHERE grin_address = ?`
      ).run(resolved.username, resolved.pubHex, nowS, keepPrevUser, keepPrevNpub, addr);

      const cooldownH = config.nostr_destination_cooldown_hours !== undefined ? config.nostr_destination_cooldown_hours : 48;
      auditOwnerProof(db, { action: 'nostr_destination_register', grinAddress: addr, ip: reqIp, ok: true, details: { username: resolved.username, replaced: prev.nostr_username || null, proof_method: proof.method } });

      // Alert the destination we just displaced. Only when it actually changed — a cooldown
      // refresh onto the same npub is not a security event and must not cry wolf.
      let alert = null;
      if (prev.nostr_npub && prev.nostr_npub !== resolved.pubHex) {
        alert = await alertPreviousDestination(prev.nostr_npub, prev.nostr_username, resolved.username, addr, reqIp);
      }

      res.json({
        success: true,
        username: resolved.username,
        npub: resolved.npub,
        registered_at: nowS,
        active_at: nowS + cooldownH * 3600,
        cooldown_hours: cooldownH,
        replaced: prev.nostr_username || null,
        // Surfaced so the miner learns the warning did not go out — never silently swallowed.
        previous_notified: alert ? !!alert.ok : null,
      });
    } catch (err) {
      res.status(err.code && err.code >= 400 && err.code < 600 ? err.code : 500).json({ error: err.message });
    }
  });

  // Remove the registered Goblin destination (ownership-gated). Clears the pin + cooldown.
  // Single-proof (OR) on purpose: removal cannot redirect money, it only disables the rail.
  // But it IS the bypass route for the change alert — remove, then register fresh, and there
  // would be no previous destination left to warn. So removal alerts the destination it is
  // clearing: the row is READ into `prev` before the UPDATE blanks nostr_* / nostr_prev_*, so
  // the alert still has somewhere to go. Never move that SELECT below the UPDATE.
  app.delete('/api/account/:addr/nostr-destination', rateLimiter.middleware('withdraw'), async (req, res) => {
    try {
      const { addr } = req.params;
      const reqIp = normalizeIp(req.ip);
      const proof = await verifyOwnerProof(db, addr, (req.body && (req.body.proof || req.body.ip_proof)) || '', reqIp);
      if (!proof.ok) {
        auditOwnerProof(db, { action: 'nostr_destination_remove', grinAddress: addr, ip: reqIp, ok: false, details: { reason: proof.reason } });
        return res.status(403).json({ error: 'Ownership proof failed', reason: proof.reason });
      }
      const prev = db.prepare(
        'SELECT nostr_username, nostr_npub FROM miner_accounts WHERE grin_address = ?'
      ).get(addr) || {};
      db.prepare(
        `UPDATE miner_accounts SET nostr_username = NULL, nostr_npub = NULL, nostr_registered_at = NULL,
           nostr_prev_username = NULL, nostr_prev_npub = NULL, updated_at = unixepoch()
         WHERE grin_address = ?`
      ).run(addr);
      auditOwnerProof(db, { action: 'nostr_destination_remove', grinAddress: addr, ip: reqIp, ok: true, details: { removed: prev.nostr_username || null } });

      const alert = await alertPreviousDestination(prev.nostr_npub, prev.nostr_username, null, addr, reqIp);
      res.json({ success: true, removed: prev.nostr_username || null, previous_notified: alert ? !!alert.ok : null });
    } catch (err) {
      res.status(err.code && err.code >= 400 && err.code < 600 ? err.code : 500).json({ error: err.message });
    }
  });

  // Public cancel REMOVED 2026-07-17 (operator decision). Both parked states self-recover —
  // Tor auto-reverses after max retries, slatepack auto-refunds via TTL expiry — so a public
  // cancel was pure abuse surface: in Grin a "failed" send may actually have posted, and a
  // late cancel reversing the lock would double-pay. Operator support cases go through the
  // admin route (/api/admin/withdrawals/:id/cancel, step-up gated, on the payments page).

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

  // ─── Network-map exposure gate (access.network_map_public, OFF by default) ──────────────
  // Guards the two feeds behind /network-map.html. Neither has ever returned an IP — peer IPs
  // never leave the DB and no coordinate is ever resolved: an aggregate marker sits on its
  // country's exact centroid (geoip.countryCentroid) and the country itself is published beside
  // it, so there is nothing for a scattered point to hide — but
  // both publish a per-country breakdown of who mines here / who this node peers with, and on
  // a small pool a country with one entry names one person. Disabled → 404 (not 403: a 403
  // confirms the feature exists and is merely switched off). network-map.js already treats a
  // failed fetch as "no data" and renders its illustrative fallback, so the page degrades.
  const networkMapPublic = () => {
    try {
      const a = poolSettings.getSection('access');
      return a.network_map_public === true || a.network_map_public === 'true';
    } catch (e) {
      return false; // settings unreadable → stay closed
    }
  };
  // k-anonymity floor for the country breakdowns when the feed IS enabled. Countries under
  // the threshold are merged into a single unnamed "Other" row rather than dropped, so the
  // published totals still add up.
  const minBucket = () => {
    try {
      return Math.max(1, parseInt(poolSettings.getSection('access').network_map_min_bucket, 10) || 3);
    } catch (e) {
      return 3;
    }
  };
  // Operator-declared country of the central (hub) box, set in admin → Access. Most pools sit
  // behind a CDN, so the box cannot geo-locate itself — nothing but the operator knows where it
  // is. Blank falls through to the derivation chain in /api/pool/topology.
  const hubCountryCode = () => {
    try {
      const cc = String(poolSettings.getSection('access').hub_country_code || '').toUpperCase();
      return /^[A-Z]{2}$/.test(cc) ? cc : null;
    } catch (e) {
      return null;
    }
  };

  // ─── Network map: full pool topology (hub → gateways → miners-by-country) ───────────────
  // One call powers /network-map.html. Everything is aggregate + privacy-clean:
  //   · gateways — pool_locations + live share window + WireGuard liveness → status
  //     'connected' (up + miners) | 'handshake' (up, no miners) | 'offline' (tunnel down).
  //   · countries — LIVE stratum sessions (accurate online set + the region each connects
  //     through) crossed with miner_geo (COUNTRY ONLY, from lib/geoip at first accepted share).
  //     Each country is assigned to the gateway most of its miners route through. When
  //     geoip-lite isn't installed (miner_geo empty) we fall back to the GATEWAY's country so
  //     the map still renders; geo_source reports which path was taken.
  //   · positions are COUNTRY CENTROIDS (geoip.countryCentroid) — every marker here is an
  //     aggregate whose country is published in this same payload, so scattering the point
  //     would hide nothing and could only land the dot in the wrong country. The map draws
  //     miner countries as a filled polygon; the centroid is just the label/hover anchor.
  //     Exact per-miner coordinates are never resolved or stored — country is all we hold.
  //
  // MEMOISED 30 s (audit §J12-9). The expensive OUTBOUND parts were already kept out of the
  // request path — cachedGatewayStatus (15 s + running flag) and refreshStratumProbes (60 s +
  // running flag) — but the DB half was not: the 15-minute share aggregate below plans as
  // `SCAN shares USING INDEX idx_share_region | USE TEMP B-TREE FOR count(DISTINCT)`, a full
  // index scan, because `created_at > ?` sits on the SECOND column of idx_share_region and
  // cannot seek. Its inputs move on a 15-minute window, so a per-request rebuild bought
  // nothing. No cache key: the response has no per-caller component.
  const TOPOLOGY_TTL_MS = 30000;
  let _topologyCache = { at: 0, body: null };
  app.get('/api/pool/topology', rateLimiter.middleware('public'), async (req, res) => {
    try {
      if (!networkMapPublic()) return res.status(404).json({ error: 'not_found' });
      if (_topologyCache.body && (Date.now() - _topologyCache.at) < TOPOLOGY_TTL_MS) {
        return res.json(_topologyCache.body);
      }
      const WINDOW_S = 900, OFFLINE_S = 600, CYCLE = 42, SOL = 16384;
      const nowS = Math.floor(Date.now() / 1000), cutoff = nowS - WINDOW_S;

      // Two views of the same table, on purpose:
      //   locationsAll — every row. Used ONLY to look up which country a region sits in, for
      //     miners whose own country we can't resolve, and for the hub's location. Both are
      //     facts about where a box IS, which don't stop being true when a row is unpublished.
      //   locations    — is_active = 1 only, the same filter the public connect UI applies
      //     (reactor-dashboard.js). A deactivated row (or one seeded ahead of the gateway
      //     actually being built) is not a place this pool runs, so it must not put a marker on
      //     the public globe: unfiltered it drew as a red "offline" gateway, which reads as a
      //     broken pool rather than an unused row. Also what the stratum probe works from —
      //     no point dialling an endpoint nobody is being sent to.
      const locationsAll = db.prepare(
        `SELECT region, label, country, country_code, stratum_url, is_active FROM pool_locations`
      ).all();
      const locations = locationsAll.filter(l => l.is_active === 1 || l.is_active === true);
      const locAllByRegion = new Map(locationsAll.map(l => [l.region, l]));
      const agg = db.prepare(
        `SELECT region, COUNT(DISTINCT grin_address) AS miners, COALESCE(SUM(difficulty),0) AS sumdiff,
                MAX(created_at) AS last_share
         FROM shares WHERE created_at > ? GROUP BY region`
      ).all(cutoff);
      const byRegion = new Map(agg.map(r => [r.region, r]));

      const wgSnapshot = cachedGatewayStatus();
      const wgByRegion = wgSnapshot.regions || {};
      refreshStratumProbes(locations);
      const localRegion = (config && config.role === 'singlebox') ? config.region : null;
      // Public gateway state — the SAME signal precedence as /api/pool/stats/regions (shares →
      // local box → WireGuard peer → stratum dial; see the comment there), mapped to the
      // network-map states: connected = up + miners, handshake = up + no miners, offline,
      // checking = no verdict yet.
      const statusOf = (region, hasMiners, shareAge, hasTarget) => {
        const sharesFresh = shareAge !== null && shareAge < OFFLINE_S;
        const verdict = stratumVerdict(region);
        let up;
        if (sharesFresh) up = true;
        else if (region === localRegion) up = true;
        else if (wgSnapshot.available && wgByRegion[region]) {
          const wg = wgByRegion[region];
          up = !!(wg.handshake && (nowS - wg.handshake) < OFFLINE_S) && verdict !== false;
        } else if (verdict === null) {
          if (!hasTarget) return hasMiners ? 'connected' : 'handshake';
          return 'checking';
        } else {
          up = verdict;
        }
        if (!up) return 'offline';
        return hasMiners ? 'connected' : 'handshake';
      };

      // Markers sit on the country centroid. `perCountry` counts how many we've already
      // placed in each country so the 2nd+ marker there (a second gateway, or the hub next
      // to a gateway) gets a small de-stack nudge instead of landing on the same pixel.
      // gwByRegion has a null prototype: region tags are operator-chosen strings, and on a plain
      // {} a region named 'constructor'/'toString' would answer truthy to the lookups below
      // without ever having been registered — the client would then be handed a gateway tag it
      // can't resolve to a position.
      const gateways = [], gwByRegion = Object.create(null), perCountry = {};
      const nudgeFor = (cc) => (cc ? (perCountry[cc] = (perCountry[cc] || 0) + 1) - 1 : 0);
      for (const loc of locations) {
        const a = byRegion.get(loc.region) || { miners: 0, sumdiff: 0, last_share: 0 };
        const shareAge = a.last_share ? (nowS - a.last_share) : null;
        const status = statusOf(loc.region, a.miners > 0, shareAge, !!loc.stratum_url);
        const gps = (a.sumdiff * CYCLE) / (WINDOW_S * SOL);
        const pos = geoip.countryCentroid(loc.country_code, nudgeFor(loc.country_code));
        const g = {
          region: loc.region, label: loc.label || loc.region,
          country: loc.country || (loc.country_code ? geoip.countryName(loc.country_code) : null),
          country_code: loc.country_code || null,
          status, online: status !== 'offline', miners: a.miners,
          hashrate_gps: parseFloat(gps.toFixed(6)),
          lat: pos ? pos.lat : null, lng: pos ? pos.lng : null
        };
        gateways.push(g); gwByRegion[loc.region] = g;
      }

      // Miners by country from live sessions × miner_geo (with gateway-country fallback).
      const sessions = minerManager.getActiveSessions();
      const addrRegion = new Map();
      for (const s of sessions) if (!addrRegion.has(s.grinAddress)) addrRegion.set(s.grinAddress, s.region);
      const addrs = [...addrRegion.keys()];
      const geoByAddr = new Map();
      if (addrs.length) {
        const rows = db.prepare(
          `SELECT grin_address, country_code, country FROM miner_geo
           WHERE grin_address IN (${addrs.map(() => '?').join(',')})`
        ).all(...addrs);
        rows.forEach(r => geoByAddr.set(r.grin_address, r));
      }
      const countries = new Map();
      let geoHits = 0;
      for (const [addr, region] of addrRegion) {
        let cc = null, name = null;
        const g = geoByAddr.get(addr);
        if (g && g.country_code) { cc = g.country_code; name = g.country || geoip.countryName(cc); geoHits++; }
        // Fallback from locationsAll, NOT from the published gateway list: a miner connected
        // through a region the operator has since unpublished still mines from the country that
        // region is in, and dropping them here would quietly shrink the miner total.
        else {
          const loc = locAllByRegion.get(region);
          if (loc && loc.country_code) { cc = loc.country_code; name = loc.country || geoip.countryName(cc); }
        }
        if (!cc) continue;
        let c = countries.get(cc);
        if (!c) { c = { cc, name: name || geoip.countryName(cc), miners: 0, votes: {} }; countries.set(cc, c); }
        c.miners++; c.votes[region] = (c.votes[region] || 0) + 1;
      }
      // k-anonymity: countries below the floor are merged into one unnamed "Other" row (no
      // country_code, no coordinates) so the miner total stays truthful without naming a
      // country that holds a single miner.
      const kMin = minBucket();
      const named = [], thin = [];
      for (const c of countries.values()) (c.miners >= kMin ? named : thin).push(c);
      const countryList = named.map(c => {
        const topRegion = Object.entries(c.votes).sort((a, b) => b[1] - a[1])[0][0];
        // Only name the region if it is a PUBLISHED gateway — the client resolves this string
        // against the gateways it was given, and an unresolvable one made it draw the arc to
        // whichever gateway happened to be first. null = "we're not saying", and the client
        // arcs to the hub instead of to an unrelated city.
        const gw = gwByRegion[topRegion] ? topRegion : null;
        // Nudged off the same counter the gateways used: a gateway's own country almost
        // always has miners too, and an un-nudged marker would land on the exact pixel of
        // that gateway — the hit-test keeps the first match, so the miner tooltip would be
        // unreachable and the region→gateway arc would collapse to a zero-length spike.
        // The index is stable per country (= how many gateways precede it there).
        const pos = geoip.countryCentroid(c.cc, nudgeFor(c.cc));
        return {
          country_code: c.cc, country: c.name, miners: c.miners, gateway: gw,
          lat: pos ? pos.lat : null, lng: pos ? pos.lng : null
        };
      }).sort((a, b) => b.miners - a.miners);
      if (thin.length) {
        countryList.push({
          country_code: null, country: 'Other', gateway: null, lat: null, lng: null,
          miners: thin.reduce((s, c) => s + c.miners, 0), aggregated_countries: thin.length
        });
      }

      // Hub = this settlement core. Nothing on the box can discover its own country (it is
      // behind nginx, usually behind a CDN), so the location is operator-declared with a
      // derivation chain behind it, most authoritative first:
      //   1. access.hub_country_code   — admin → Access (the one field an operator can edit live)
      //   2. config.hub_country_code   — pool.json escape hatch (no UI, honoured if hand-set)
      //   3. config.region_country_code — Script 07 → 2) Configure ("where is THIS server?")
      //   4. this box's own PUBLISHED gateway card — singlebox role only (`localRegion`).
      //   5. this box's own pool_locations row — keyed on config.region, NOT gated on
      //      role === 'singlebox' like `localRegion` is: a 'hub' role still registers its own
      //      region via ensureLocalRegion(), and gating it here left the hub unlocated on
      //      every multi-region install.
      //   6. busiest ONLINE gateway → 7. any gateway with a country → 8. busiest miner country.
      // All eight can miss (fresh install, nothing configured, no miners). Then lat/lng go out
      // as null and the map DRAWS NO HUB — never a placeholder position (network-map.js keeps
      // no fallback coordinate: a wrong hub country is worse than an absent marker).
      // locationsAll, not locations: "where is this box" stays true whether or not the operator
      // publishes that region as a place to point a miner at.
      const localRow = locationsAll.find(l => l.region === config.region) || null;
      const rawHubCc = hubCountryCode()
        || config.hub_country_code
        || config.region_country_code
        || (localRegion && gwByRegion[localRegion] && gwByRegion[localRegion].country_code)
        || (localRow && localRow.country_code)
        || (gateways.filter(g => g.online).sort((a, b) => b.miners - a.miners)[0] || {}).country_code
        || (gateways.find(g => g.country_code) || {}).country_code
        || (countryList.find(c => c.country_code) || {}).country_code
        || null;
      // Normalise ONCE, at the end of the chain: only the admin field is validated on save, so
      // a hand-edited pool.json ('vn', 'Vietnam') or an old DB row could otherwise reach
      // countryCentroid() in a form it can't match and drop the marker without a word.
      const hubCc = /^[A-Z]{2}$/.test(String(rawHubCc || '').toUpperCase())
        ? String(rawHubCc).toUpperCase() : null;
      const hubPos = hubCc ? geoip.countryCentroid(hubCc, nudgeFor(hubCc)) : null;
      // Live pool name first: pool_info.pool_name is what the rest of the site renders, and it is
      // editable in admin, whereas pool.json's `pool_name` is frozen at install time ("My Grin
      // Pool") — reading that one labelled the hub marker with a name shown nowhere else.
      let hubLabel = null;
      try { hubLabel = poolSettings.getSection('pool_info').pool_name || null; } catch (_) {}
      const hub = {
        label: hubLabel || config.pool_name || config.name || 'Pool Hub',
        country_code: hubCc, country: hubCc ? geoip.countryName(hubCc) : null,
        lat: hubPos ? hubPos.lat : null, lng: hubPos ? hubPos.lng : null
      };

      const body = {
        hub, gateways, countries: countryList,
        totals: {
          // Distinct live miner addresses — the SAME set /api/pool/stats reports as
          // active_miners (both come from minerManager's active sessions), so the map's
          // placard can never disagree with the homepage. Deliberately not the sum of
          // countries[]: a miner whose country resolves to nothing at all (no geoip and a
          // region row with no country declared) is absent from that array but is still
          // mining, and summing it under-reported the pool.
          miners: addrRegion.size,
          gateways_up: gateways.filter(g => g.online).length,
          gateways_total: gateways.length,
          // True distinct-country count (thin ones are hidden by name, not by tally).
          countries: named.length + thin.length
        },
        geo_source: (geoip.available() && geoHits > 0) ? 'geoip' : 'gateway',
        timestamp: new Date().toISOString()
      };
      _topologyCache = { at: Date.now(), body };
      res.json(body);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── Network map: Grin P2P peers by country (rolling window) ────────────────────────────
  // Aggregates network_peers (populated by the peer-snapshot collector — COUNTRY ONLY, no IPs)
  // over the last ?window days (default 30, max 90). Returns per-country counts (+ main/test
  // split) and a capped set of scattered-in-country twinkle points for the globe. Empty when geoip-lite
  // isn't installed or the node has no peers yet (page then shows its illustrative fallback).
  app.get('/api/network/peers', rateLimiter.middleware('public'), (req, res) => {
    try {
      if (!networkMapPublic()) return res.status(404).json({ error: 'not_found' });
      const days = Math.min(Math.max(parseInt(req.query.window, 10) || 30, 1), 90);
      const cutoff = Math.floor(Date.now() / 1000) - days * 86400;
      const allRows = db.prepare(`
        SELECT country_code, country, COUNT(*) AS peers,
               SUM(CASE WHEN net='main' THEN 1 ELSE 0 END) AS main,
               SUM(CASE WHEN net='test' THEN 1 ELSE 0 END) AS test
        FROM network_peers WHERE last_seen >= ? AND country_code IS NOT NULL
        GROUP BY country_code ORDER BY peers DESC`).all(cutoff);

      // k-anonymity floor. Applied BEFORE the twinkle points are built, not just to the
      // country list — a point is placed inside its own country, so emitting points for a
      // thin country would re-expose exactly what the floor is hiding.
      const kMin = minBucket();
      const rows = allRows.filter(r => r.peers >= kMin);
      const thinRows = allRows.filter(r => r.peers < kMin);

      // Country rows are aggregates → centroid (the map uses them as label anchors). Only the
      // twinkle points below are scattered, because there the spread IS the visual: many dots
      // means many nodes. Scatter half-extents are per-country (geoip COUNTRIES[].s).
      const countries = rows.map(r => {
        const pos = geoip.countryCentroid(r.country_code);
        return {
          country_code: r.country_code, country: r.country || geoip.countryName(r.country_code),
          peers: r.peers, main: r.main, test: r.test,
          lat: pos ? pos.lat : null, lng: pos ? pos.lng : null
        };
      });

      const totalPeers = rows.reduce((s, r) => s + r.peers, 0);
      const CAP = 220, points = [];
      for (const r of rows) {
        if (points.length >= CAP) break;
        const want = Math.max(1, Math.round(CAP * r.peers / (totalPeers || 1)));
        const mainWant = Math.round(want * (r.main / (r.peers || 1)));
        for (let i = 0; i < want && points.length < CAP; i++) {
          const pos = geoip.placeInCountry(r.country_code, `pt:${r.country_code}:${i}`);
          if (!pos) break;
          points.push({ lat: pos.lat, lng: pos.lng, net: i < mainWant ? 'main' : 'test' });
        }
      }

      // Thin countries survive as one unnamed bucket so the published totals stay truthful.
      if (thinRows.length) {
        countries.push({
          country_code: null, country: 'Other', lat: null, lng: null,
          peers: thinRows.reduce((s, r) => s + r.peers, 0),
          main: thinRows.reduce((s, r) => s + r.main, 0),
          test: thinRows.reduce((s, r) => s + r.test, 0),
          aggregated_countries: thinRows.length
        });
      }

      res.json({
        window_days: days,
        countries, points,
        // Totals span ALL peers (including the ones folded into "Other") — the floor hides
        // which country a thin peer is in, not that it exists.
        totals: {
          peers: allRows.reduce((s, r) => s + r.peers, 0),
          main: allRows.reduce((s, r) => s + r.main, 0),
          test: allRows.reduce((s, r) => s + r.test, 0)
        },
        timestamp: new Date().toISOString()
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Per-region live stats. Hashrate is derived from accepted-share difficulty over a short
  // window using the canonical C32 formula (GPS = Σdiff × 42 / window_s / 16384 — matches
  // hashrate-tracker.js and CLAUDE.md), grouped by the `region` tag the central stratum
  // stamps on each share (per-region listener / Model C gateway). Per-region `status` is
  // 'online' (up + active miners) | 'idle' (up, no recent miners) | 'offline' (WireGuard
  // tunnel down / never handshaked); see regionStatus() below for the liveness rules.
  app.get('/api/pool/stats/regions', rateLimiter.middleware('public'), async (req, res) => {
    try {
      const WINDOW_S = 900;  // 15-minute window for "current" regional hashrate
      const OFFLINE_S = 600; // a WireGuard handshake older than this (or none at all) = gateway
                             // down. Aligned with /api/admin/health/gateways so the public pill
                             // and the admin health view never disagree about who is offline.
      const CYCLE_LENGTH = 42, SOLUTION_RATE = 16384;
      const nowS = Math.floor(Date.now() / 1000);
      const cutoff = nowS - WINDOW_S;

      const agg = db.prepare(
        `SELECT region,
                COUNT(*) AS shares,
                COUNT(DISTINCT grin_address) AS miners,
                COALESCE(SUM(difficulty), 0) AS sumdiff,
                MAX(created_at) AS last_share
         FROM shares WHERE created_at > ? GROUP BY region`
      ).all(cutoff);
      const byRegion = new Map(agg.map(r => [r.region, r]));

      const locations = db.prepare(
        `SELECT region, label, country, country_code, stratum_url, is_active FROM pool_locations`
      ).all();
      const locByRegion = new Map(locations.map(l => [l.region, l]));

      // Per-region tunnel liveness (Model C): WireGuard latest-handshake per gateway. Peers
      // carry PersistentKeepalive=25, so a healthy tunnel re-handshakes every ~25s regardless
      // of miner traffic — a handshake older than OFFLINE_S (or none at all) means the gateway
      // is genuinely DOWN, not merely quiet. Cached snapshot, never awaited in the request path.
      const wgSnapshot = cachedGatewayStatus();
      const wgByRegion = wgSnapshot.regions || {};

      // Active reachability: TCP-dial each declared stratum_url in the BACKGROUND. This is the
      // only signal that covers a region with no WireGuard peer at all — a declared/seeded
      // endpoint pointing at nothing (never paired, DNS not up, gateway not built) used to read
      // as 'idle' blue, i.e. "ready, just quiet", when a miner pointing a rig there gets a
      // refused connection. Kicked here, read from cache; the first hit after boot legitimately
      // has no verdict and reports 'checking'.
      refreshStratumProbes(locations);

      // The LOCAL/singlebox region has no WG peer (it IS the box); this API answering proves
      // the box is alive, so it is never marked offline (its public host may also be
      // un-dialable from itself behind hairpin NAT, so the probe is not trusted to fail it).
      const localRegion = (config && config.role === 'singlebox') ? config.region : null;

      // Four honest public states for a miner choosing where to point their rig:
      //   online   — reachable AND ≥1 share in the window (miners active here right now)
      //   idle     — reachable, no recent miners (perfectly fine to connect, just quiet)
      //   offline  — tunnel down / nothing listening (don't bother — you can't mine here)
      //   checking — no verdict yet (first poll after a restart); say so, never guess 'idle'
      // Signal precedence, strongest first:
      //   ① recent shares — financial-grade proof miners ARE mining through this region; wins
      //      over everything, so a handshake/probe blip can never flip an actively-mined
      //      region red while its own card still shows miners > 0.
      //   ② the local box — see above.
      //   ③ a declared WireGuard peer — for a Model C gateway the tunnel IS the path; a stale
      //      handshake means down even if its public port still answers (HAProxy up, no route
      //      home). A fresh handshake is still overruled by a CONFIRMED dead public port.
      //   ④ otherwise the stratum dial — covers every region wg cannot speak for.
      const regionStatus = (region, hasShares, shareAge, hasTarget) => {
        const sharesFresh = shareAge !== null && shareAge < OFFLINE_S;
        const verdict = stratumVerdict(region);
        let up;
        if (sharesFresh) up = true;
        else if (region === localRegion) up = true;
        else if (wgSnapshot.available && wgByRegion[region]) {
          const wg = wgByRegion[region];
          up = !!(wg.handshake && (nowS - wg.handshake) < OFFLINE_S) && verdict !== false;
        } else if (verdict === null) {
          // Nothing to dial and no tunnel to read → liveness is genuinely unknowable; keep the
          // old lenient behaviour rather than stranding the region on 'checking' forever.
          if (!hasTarget) return hasShares ? 'online' : 'idle';
          return 'checking';
        } else {
          up = verdict;
        }
        if (!up) return 'offline';
        return hasShares ? 'online' : 'idle';
      };

      // Union of regions seen in shares and regions declared in pool_locations.
      const regions = new Set([...byRegion.keys(), ...locByRegion.keys()]);
      const out = [];
      let totalGps = 0, totalMiners = 0, totalShares = 0, checking = 0;
      for (const region of regions) {
        const a = byRegion.get(region) || { shares: 0, miners: 0, sumdiff: 0, last_share: 0 };
        const loc = locByRegion.get(region) || {};
        const gps = (a.sumdiff * CYCLE_LENGTH) / (WINDOW_S * SOLUTION_RATE);
        totalGps += gps; totalMiners += a.miners; totalShares += a.shares;
        const shareAge = a.last_share ? (nowS - a.last_share) : null;
        const status = regionStatus(region, a.shares > 0, shareAge, !!loc.stratum_url);
        if (status === 'checking') checking++;
        out.push({
          region,
          label: loc.label || null,
          country: loc.country || null,
          country_code: loc.country_code || null,
          stratum_url: loc.stratum_url || null,
          is_active: loc.is_active === undefined ? null : !!loc.is_active,
          status,                       // 'online' | 'idle' | 'offline' | 'checking'
          online: status !== 'offline', // reachable? (up regardless of miner count)
          hashrate_gps: parseFloat(gps.toFixed(6)),
          miners: a.miners,
          shares_window: a.shares
        });
      }
      out.sort((x, y) => y.hashrate_gps - x.hashrate_gps);

      // ── k-anonymity floor on the per-region counts (audit §J11-5, 2026-09-02) ──────────────
      // The same floor `/api/pool/topology` and `/api/network/peers` apply to their COUNTRY
      // breakdowns, applied here to the REGION breakdown — which had neither the floor nor the
      // network-map gate. Each region carries an operator-declared country, so on a multi-region
      // pool `{region:'sgn', country_code:'VN', miners:1}` is exactly the statement the floor
      // exists to prevent: one identifiable person mines near Vietnam. The admin helper text for
      // `network_map_min_bucket` says so in as many words.
      //
      // Three rules, each deliberate:
      //  1. Suppress only `0 < n < kMin`. **Zero stays zero** — "no miners here" identifies
      //     nobody and a gateway with none is exactly what a miner picking one needs to see.
      //     Nulling it would repeat §J5-4's mistake in reverse (a suppressed number read as a
      //     real one); here a real zero must not be read as suppressed.
      //  2. Suppress `hashrate_gps` and `shares_window` alongside `miners`. With one miner in a
      //     region the hashrate IS that miner's rig size — more identifying than the count, and
      //     suppressing the count alone would have been security theatre.
      //  3. `status`/`online` are KEPT. They are one bit ("can I mine here?"), that bit is the
      //     entire point of the public connect grid, and a miner pointed at a dead gateway is a
      //     real harm. This is a stated residual, not an oversight: on a thin region 'online'
      //     still implies at least one miner.
      //
      // Skipped entirely when there is only ONE region: the region is then the pool, `totals`
      // already publishes the same number, and suppressing would blank the dashboard of every
      // single-box install for exactly zero privacy gain. Totals stay exact in both cases —
      // they are summed above, before any suppression, so the floor hides WHERE, never HOW MANY.
      const kMinRegions = minBucket();
      let suppressed = 0;
      if (out.length > 1) {
        for (const r of out) {
          if (r.miners > 0 && r.miners < kMinRegions) {
            r.miners = null;
            r.hashrate_gps = null;
            r.shares_window = null;
            r.below_floor = true;
            suppressed++;
          }
        }
      }

      res.json({
        window_seconds: WINDOW_S,
        region_count: out.length,
        // > 0 means at least one region has no liveness verdict yet — the client should
        // repaint shortly instead of waiting out its normal poll interval.
        checking: checking,
        // Tells a client that some per-region numbers are withheld rather than zero, so it can
        // render "—" instead of inventing a 0. The threshold is published too: hiding the floor
        // itself buys nothing (it is in the admin UI and in this file) and an unexplained "—"
        // reads as a bug.
        min_bucket: out.length > 1 ? kMinRegions : null,
        suppressed_regions: suppressed,
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

  app.get('/api/stratum/hashrate', rateLimiter.middleware('public'), (req, res) => {
    try {
      const stats = hashrateTracker.getHashrateStats();
      // getHashrateStats() carries a `top_miners` array with FULL addresses (10 @ 1h). It is a
      // SEVENTH full-address feed — the one §J11-1's table missed, found while applying that
      // fix — and no consumer reads it: both callers (reactor-dashboard.js, miners-stats.html)
      // use only pool_hashrate_1h_gps. Masked rather than deleted so the documented response
      // shape stays stable for the third-party bots api-docs.html invites.
      // The poolstats reporter also calls getHashrateStats(), and it reads ONLY
      // pool_hashrate_1h_gps (poolstats-reporter.js collectStats) — so no address has ever
      // gone off-box to miningpoolstats.stream. Keep it that way.
      if (Array.isArray(stats.top_miners)) {
        stats.top_miners = stats.top_miners.map((m) => ({ ...m, grin_address: maskAddr(m.grin_address) }));
      }
      res.json(stats);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Top miners by hashrate over an arbitrary window (default 24h) — powers the paginated
  // leaderboard on miners-stats.html. Separate from /api/stratum/hashrate (fixed 10 @ 1h,
  // shared with the poolstats reporter) so we can serve a larger list without churning it.
  app.get('/api/stratum/top-miners', rateLimiter.middleware('public'), (req, res) => {
    try {
      const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 500, 1), 1000);
      const windowMinutes = Math.min(parseInt(req.query.window || 1440, 10) || 1440, 1440);
      // MASKED since 2026-09-02 (audit §J11-1). The tracker keeps the full address for internal
      // callers; only this public projection truncates.
      const miners = hashrateTracker.getTopMiners(limit, windowMinutes).map(m => ({
        grin_address: maskAddr(m.grin_address),
        hashrate_gps: parseFloat((m.avg_hashrate || 0).toFixed(6))
      }));
      res.json({ window_minutes: windowMinutes, top_miners: miners });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Top miners by AVERAGE hashrate over a multi-day window (default 30 days) — the "sustained
  // contribution" leaderboard on miners-stats.html. Backed by hashrate_history (retained
  // database.hashrate_keep_days, default 100d), not the shares table (pruned ~1d on mainnet:
  // confirm_depth + PPLNS window), so the 90-day cap below stays inside real data.
  app.get('/api/stratum/top-avg-hashrate', rateLimiter.middleware('public'), (req, res) => {
    try {
      const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 500, 1), 1000);
      const days = Math.min(parseInt(req.query.days || 30, 10) || 30, 90);
      // MASKED since 2026-09-02 (audit §J11-1) — see /api/stratum/top-miners above.
      const miners = hashrateTracker.getTopAvgHashrate(days, limit)
        .map((m) => ({ ...m, grin_address: maskAddr(m.grin_address) }));
      res.json({ days, top_miners: miners });
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
      const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 1000);
      const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

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

  // ─── Payout request audit (money actions only) ──────────────────────────────────────────
  // The ownership-gated money surface, both ACCEPTED and DENIED, so the operator can see a
  // brute-force / spam run against the payout button rather than inferring it from nginx logs.
  // Sourced from the same admin_audit_log rows auditOwnerProof() writes (admin_id IS NULL).
  //
  // `ip` is the COARSENED network prefix (/24, /48) — see lib/owner-proof.js coarsenIp(). That
  // is deliberate and is enough for this view's purpose: repeated attempts from one origin still
  // group together. `geo` is the country resolved from the full IP at write time (details.geo).
  //
  // Bounded by BOTH the requested window and database.audit_log_keep_days — asking for 365 days
  // when retention is 180 cannot surface rows that were already pruned, so the response reports
  // the effective window and lets the UI say so instead of implying the gap means "no attempts".
  app.get('/api/admin/payments/audit', secureAdmin, (req, res) => {
    try {
      const reqDays = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 3650);
      const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 200, 1), 1000);
      const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
      const only = String(req.query.result || 'all').toLowerCase(); // all | deny | ok

      let keepDays = 180;
      try { keepDays = Math.max(30, parseInt(poolSettings.getSection('database').audit_log_keep_days, 10) || 180); }
      catch (e) { /* fall back to the documented default */ }
      const effDays = Math.min(reqDays, keepDays);
      const cutoff = Math.floor(Date.now() / 1000) - effDays * 86400;

      // Money actions only. A LIKE over the action prefix keeps this in step with owner-proof.js
      // without duplicating its action list here.
      const MONEY = "(a.action LIKE 'owner_proof:withdraw\\_%' ESCAPE '\\'" +
                    " OR a.action LIKE 'owner_proof:slatepack\\_finalize%' ESCAPE '\\'" +
                    " OR a.action LIKE 'owner_proof:nostr\\_destination\\_%' ESCAPE '\\')";
      const resultClause = only === 'deny' ? " AND a.action LIKE '%:deny'"
                         : only === 'ok'   ? " AND a.action LIKE '%:ok'" : '';

      const rows = db.prepare(
        `SELECT a.id, a.action, a.target_id AS grin_address, a.details, a.ip, a.created_at
         FROM admin_audit_log a
         WHERE a.admin_id IS NULL AND ${MONEY} AND a.created_at >= ?${resultClause}
         ORDER BY a.id DESC LIMIT ? OFFSET ?`
      ).all(cutoff, limit, offset);

      const events = rows.map(r => {
        let d = {};
        try { d = r.details ? JSON.parse(r.details) : {}; } catch (_) { d = {}; }
        // 'owner_proof:withdraw_tor:deny' → rail 'withdraw_tor', outcome 'deny'
        const parts = String(r.action || '').split(':');
        const outcome = parts[parts.length - 1] === 'ok' ? 'ok' : 'deny';
        const { geo, ...rest } = d;
        return {
          id: r.id,
          at: r.created_at,
          action: parts.slice(1, -1).join(':') || r.action,
          outcome,
          grin_address: r.grin_address,
          ip_prefix: r.ip || null,
          country_code: geo || null,
          country: geo ? geoip.countryName(geo) : null,
          reason: rest.reason || null,
          amount: typeof rest.amount === 'number' ? rest.amount : null,
          withdrawal_id: rest.withdrawal_id || null,
        };
      });

      // Denial concentration over the SAME window — the signal that separates "a miner mistyped
      // their password twice" from "one origin is sweeping addresses". Computed in SQL over the
      // whole window, not over the returned page, so paging can't hide a burst.
      const topDenied = db.prepare(
        `SELECT a.ip AS ip_prefix, COUNT(*) AS denials,
                COUNT(DISTINCT a.target_id) AS addresses, MAX(a.created_at) AS last_at
         FROM admin_audit_log a
         WHERE a.admin_id IS NULL AND ${MONEY} AND a.created_at >= ?
           AND a.action LIKE '%:deny' AND a.ip IS NOT NULL
         GROUP BY a.ip HAVING denials > 1
         ORDER BY denials DESC, addresses DESC LIMIT 10`
      ).all(cutoff);

      const totals = db.prepare(
        `SELECT SUM(CASE WHEN a.action LIKE '%:ok' THEN 1 ELSE 0 END) AS ok,
                SUM(CASE WHEN a.action LIKE '%:deny' THEN 1 ELSE 0 END) AS deny,
                COUNT(DISTINCT a.ip) AS origins
         FROM admin_audit_log a
         WHERE a.admin_id IS NULL AND ${MONEY} AND a.created_at >= ?`
      ).get(cutoff);

      res.json({
        requested_days: reqDays,
        window_days: effDays,
        retention_days: keepDays,
        truncated_by_retention: reqDays > keepDays,
        geo_available: geoip.available(),
        totals: { ok: totals.ok || 0, deny: totals.deny || 0, origins: totals.origins || 0 },
        top_denied_origins: topDenied,
        count: events.length,
        events,
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

  // freshAdmin, not secureAdmin (audit §J1-4). resetIp() deletes EVERY bucket and violation
  // entry keyed on this IP — including the `auth` bucket, i.e. the login brute-force lockout —
  // so this is the third route meaning "stop throttling this address". The other two,
  // security/temp-ban/clear and security/ip-blacklist/remove, were already behind step-up;
  // this one was the way to clear a lockout and then grind the password toward freshAdmin
  // without ever passing through it. Three routes with one effect now share one tier.
  app.post('/api/admin/security/rate-limit-reset', freshAdmin, (req, res) => {
    try {
      const { ip } = req.body;
      if (!ip) {
        return res.status(400).json({ error: 'IP address required' });
      }
      rateLimiter.resetIp(ip);
      // §J1-2: lifting a throttle for an arbitrary address is a security-relevant mutation and
      // wrote no audit row. Its two siblings do.
      db.prepare(`INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, details, ip)
                  VALUES (?, 'rate_limit_reset', 'security', ?, ?, ?)`)
        .run(req.user.user_id, String(ip), JSON.stringify({ target_ip: String(ip) }), req.ip);
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

  // ─── ADMIN SESSIONS / LOGIN ACTIVITY (Admin) ───────────────────────
  // Sessions are stateless JWTs (no server-side session table), so there is no per-device
  // list to enumerate. What the operator CAN see + control: recent login activity (from the
  // audit log) and a "revoke sessions" kill-switch (bumps token_version → invalidates all
  // refresh tokens for the account).
  //
  // KNOWN LIMIT, state it plainly: revoke does NOT kill live ACCESS tokens. Only refresh
  // tokens carry a token_version check (that asymmetry is deliberate — it's what stops one
  // tab's rotation from logging every other tab out), so an already-issued access token stays
  // valid until its own expiry, i.e. for up to access.session_timeout_hours. That setting is
  // therefore clamped to 24 h in auth.js/pool-settings.js: it is the true "time to revoke".
  // Anything longer needs a token_version check on access tokens plus a non-rotating refresh
  // scheme, which is a bigger change than this endpoint.
  app.get('/api/admin/security/login-history', secureAdmin, (req, res) => {
    try {
      // Clamped low as well as high: a negative LIMIT means "no limit" to SQLite, and a
      // non-numeric one binds as NaN and throws — so ?limit=-1 quietly returned the whole
      // audit table. Same idiom as /api/admin/withdrawals.
      const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
      // The action list MUST match what the writers actually emit. It previously asked for
      // 'login_failure' while the login route writes 'login_failed' (and the 2FA step writes
      // 'login_2fa_failed'), so this endpoint returned successes and auto-bans only — the
      // panel's "Failed login" row could never appear and the operator had no way to see a
      // brute-force attempt. 'login_failure' is kept for rows written by older builds.
      //
      // Username comes from the audit row's details when admin_id is NULL, which is the case
      // for every failed attempt (a bad username has no user row to join to) — without this
      // the User column would be '—' on exactly the rows that matter.
      const rows = db.prepare(`
        SELECT a.id, a.action, a.ip, a.created_at, a.details, u.username
        FROM admin_audit_log a LEFT JOIN users u ON u.id = a.admin_id
        WHERE a.action IN ('login_success','login_failed','login_failure','login_2fa_failed',
                           'ip_autoban','logout','2fa_enabled','2fa_disabled','admin_cli_reset')
        ORDER BY a.id DESC LIMIT ?
      `).all(limit);
      const history = rows.map((r) => {
        let username = r.username;
        if (!username && r.details) {
          try { username = JSON.parse(r.details).username || null; } catch (e) { /* not JSON */ }
        }
        return { id: r.id, action: r.action, ip: r.ip, created_at: r.created_at, username: username || null };
      });
      res.json({ success: true, count: history.length, history });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── Login security summary (Admin) ────────────────────────────────────────
  // Answers "is anyone attacking my login right now, and from where?" — the counts, the
  // worst source addresses, and the locks/bans currently in force.
  //
  // Two honesty requirements, same as the payout-request audit panel:
  //   * the window is CLAMPED to the audit retention, and the response says so, so a gap
  //     caused by pruning is never displayed as "no attempts";
  //   * requests refused by the rate limiter, the IP filter or the CAPTCHA gate are rejected
  //     BEFORE the login route writes any row, so they are invisible here. The panel states
  //     this — otherwise a quiet table would read as "no attack" during a live flood.
  app.get('/api/admin/security/auth-activity', secureAdmin, (req, res) => {
    try {
      let retentionDays = 180;
      try { retentionDays = parseInt(poolSettings.getSection('database').audit_log_keep_days, 10) || 180; } catch (e) {}

      const askedHours = Math.min(Math.max(parseInt(req.query.hours, 10) || 24, 1), 24 * 365);
      const maxHours = retentionDays * 24;
      const hours = Math.min(askedHours, maxHours);
      const since = Math.floor(Date.now() / 1000) - (hours * 3600);

      const FAIL_ACTIONS = ['login_failed', 'login_failure', 'login_2fa_failed'];
      const failPlaceholders = FAIL_ACTIONS.map(() => '?').join(',');

      // Every query below pins target_type AND target_id so idx_audit_target
      // (target_type, target_id, created_at DESC) is usable as a range seek. Without the
      // target_id term the index can only match the first column and the created_at filter
      // degrades to a scan of the whole audit table — and a full scan on this DB blocks
      // SHARE writes, not just this page (see the hashrate-scan fix in db capacity notes).
      const counts = {};
      for (const r of db.prepare(
        `SELECT action, COUNT(*) AS c FROM admin_audit_log
          WHERE target_type = 'auth' AND target_id = 'login' AND created_at >= ?
          GROUP BY action`
      ).all(since)) counts[r.action] = r.c;

      // ip_autoban is written with target_type 'security', so it is NOT in the set above.
      const autobans = db.prepare(
        `SELECT COUNT(*) AS c FROM admin_audit_log
          WHERE target_type = 'security' AND action = 'ip_autoban' AND created_at >= ?`
      ).get(since).c;

      const failures = FAIL_ACTIONS.reduce((n, a) => n + (counts[a] || 0), 0);

      // Worst source addresses for failed attempts. Pure aggregate, bounded output — no
      // json_extract: JSON1 availability isn't verifiable from this repo (better-sqlite3 is a
      // native module built on the target box), and a security panel is the wrong place to
      // discover a missing SQLite extension via a 500.
      const topOrigins = db.prepare(
        `SELECT ip, COUNT(*) AS attempts, MAX(created_at) AS last_at
           FROM admin_audit_log
          WHERE target_type = 'auth' AND target_id = 'login' AND created_at >= ?
            AND action IN (${failPlaceholders})
            AND ip IS NOT NULL AND ip <> ''
          GROUP BY ip ORDER BY attempts DESC, last_at DESC LIMIT 20`
      ).all(since, ...FAIL_ACTIONS);

      // Which usernames are being tried, across all sources. This is the sweep-vs-grind
      // signal the raw failure count can't give: many usernames from one place is a scanner
      // working a wordlist, repeated hits on one real username is someone targeting YOU.
      // Grouped on the raw details string in SQL (bounded by distinct usernames tried, and
      // capped at 10), then parsed in JS — so no JSON support is needed in SQLite.
      const targeted = db.prepare(
        `SELECT details, COUNT(*) AS attempts, MAX(created_at) AS last_at
           FROM admin_audit_log
          WHERE target_type = 'auth' AND target_id = 'login' AND created_at >= ?
            AND action IN (${failPlaceholders}) AND details IS NOT NULL
          GROUP BY details ORDER BY attempts DESC LIMIT 10`
      ).all(since, ...FAIL_ACTIONS).map((r) => {
        let username = null;
        try { username = JSON.parse(r.details).username; } catch (e) { /* not JSON */ }
        // Usernames are attacker-supplied free text. Cap the length here so one absurd
        // 10 KB "username" can't bloat the response or wreck the table layout; the panel
        // escapes it on render.
        if (typeof username === 'string' && username.length > 64) username = username.slice(0, 64) + '…';
        return { username: username || '(blank)', attempts: r.attempts, last_at: r.last_at };
      });

      // Per-account failure counters (visibility signal kept by AuthManager.login) — shows
      // WHICH account is being ground even when the sources rotate.
      const accounts = db.prepare(
        `SELECT username, failed_login_attempts, totp_enabled, is_active
           FROM users WHERE is_admin = 1 ORDER BY failed_login_attempts DESC, username ASC`
      ).all();

      res.json({
        success: true,
        window_hours: hours,
        requested_hours: askedHours,
        truncated_by_retention: hours < askedHours,
        retention_days: retentionDays,
        totals: {
          success: counts.login_success || 0,
          failed: failures,
          failed_password: (counts.login_failed || 0) + (counts.login_failure || 0),
          failed_2fa: counts.login_2fa_failed || 0,
          autobans,
        },
        top_origins: topOrigins,
        targeted_usernames: targeted,
        // In-memory and process-local: both lists reset on a service restart, which the panel
        // says out loud so an empty list after a deploy isn't read as "the attack stopped".
        active_lockouts: authManager.getActiveLockouts(),
        banned_ips: ipFilter ? ipFilter.getTempBans() : [],
        accounts,
        totp_mandatory: totpIsMandatory(),
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Lift a temporary auto-ban early. Step-up gated: it re-opens login attempts from an
  // address the pool decided to shut out, and the common legitimate use (the operator banned
  // their own office IP by fumbling a password) is exactly when a hijacked session would
  // most like to do the same.
  app.post('/api/admin/security/temp-ban/clear', freshAdmin, (req, res) => {
    try {
      const ip = String((req.body || {}).ip || '').trim();
      if (!ip) return res.status(400).json({ error: 'IP address required' });
      const had = ipFilter.clearTempBan(ip);
      db.prepare(`INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, details, ip)
                  VALUES (?, 'temp_ban_cleared', 'security', ?, ?, ?)`)
        .run(req.user.user_id, ip, JSON.stringify({ was_banned: had }), req.ip);
      res.json({ success: true, was_banned: had, banned_ips: ipFilter.getTempBans() });
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
      // Say what this actually does. It bumps token_version, which kills every REFRESH token —
      // no device can renew. It does NOT kill an access token already in someone's hands:
      // requireAdmin/requireFreshAuth never compare `tv` against the DB (that asymmetry is what
      // makes multi-tab refresh rotation safe), so a live access token stays valid until it
      // expires. The window is access.session_timeout_hours, operator-set 1-24 h — the old
      // hardcoded "1-hour" text under-reported it by up to 24x, to an operator reading it
      // mid-incident. Report the LIVE value and name the only control that is faster.
      const idleHours = Math.round((authManager.sessionPolicy().idle / 3600) * 10) / 10;
      res.json({
        success: true,
        idle_window_hours: idleHours,
        message: `Refresh tokens revoked — no device can renew this session. Access tokens ` +
                 `already issued cannot be revoked and stay valid for up to ${idleHours} h ` +
                 `(access.session_timeout_hours). To cut a live intruder off sooner, rotate ` +
                 `jwt_secret in pool.json and restart the service — that invalidates every token at once.`
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

  // Identity of the currently-authenticated admin. The session token is an httpOnly cookie,
  // so the browser CANNOT decode it (that's the point of httpOnly). Admin pages therefore
  // can't read the username/is_admin client-side — they must ask the server. Without this,
  // the pages tried to decode the cookie locally, always got null, and bounced to /login.html
  // in an infinite loop. Gated by secureAdmin: a 200 here is itself the "you're logged in"
  // signal; 401/403 means redirect to login.
  app.get('/api/admin/me', secureAdmin, (req, res) => {
    // `session` drives AdminSession (admin-shell.js): the idle window it counts user
    // interaction against, the absolute cap, and when THIS session actually began. The
    // client can't derive any of it — the token is httpOnly and page-load time is not
    // session start (a reload mid-session would otherwise reset the cap client-side).
    const policy = authManager.sessionPolicy();
    res.json({
      username: req.user?.username || null,
      is_admin: !!req.user?.is_admin,
      user_id: req.user?.user_id || null,
      session: {
        idle_seconds: policy.idle,
        absolute_seconds: policy.abs,
        started_at: Number(req.user?.sst) || null,
        now: Math.floor(Date.now() / 1000)   // lets the client correct for clock skew
      }
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

      // Flat KPI fields for the Overview page (admin index.html). The pseudo-addresses
      // pool_fee/prize_pool are internal buckets, not miners — excluded from both the
      // account count and the unclaimed (spendable-owed) total, matching reconciliation.js.
      const usersRow = db.prepare(
        `SELECT COUNT(*) AS c FROM miner_accounts WHERE grin_address NOT IN ('pool_fee','prize_pool')`
      ).get() || { c: 0 };
      const unclaimedRow = db.prepare(
        `SELECT COALESCE(SUM(balance),0) AS s FROM miner_accounts WHERE grin_address NOT IN ('pool_fee','prize_pool')`
      ).get() || { s: 0 };

      res.json({
        timestamp: new Date().toISOString(),
        // Flat aliases consumed by the Overview KPI tiles.
        total_users:         usersRow.c || 0,
        active_miners:       minerCount || 0,
        pool_hashrate_gps:   hashrateStats?.current_hashrate || 0,
        unclaimed_balance:   unclaimedRow.s || 0,
        pending_withdrawals: withdrawalStatus?.pending_count || 0,
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

  // REMOVED (2026-07-28): GET /api/miners/top — a public, unauthenticated rich-list. It paired a
  // full grin address with balance + balance_locked + share count + online flag + account age,
  // ordered by balance descending and offset-paginated, so a scraper could walk the pool's entire
  // custodial position miner by miner. Nothing in public_html/ or the admin panel called it, and
  // it duplicated /api/pool/miners (now address-masked). The legitimate public leaderboards are
  // /api/stratum/top-miners and /api/pool/top-block-finders, which rank on hashrate and blocks
  // found — contribution, not how much money is sitting in someone's pool balance.

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
      // getStatus() RESOLVES with { ok:false, error } when the node cannot be reached — it
      // does not throw, so the catch below never sees an outage. Gate on st.ok explicitly or
      // an unreachable node renders as a merely "Degraded · Height: 0 · Synced: No" card
      // while the one line that identifies the cause (HTTP 401, ECONNREFUSED, wrong port)
      // is discarded. Height/synced are omitted on failure: they are not measurements.
      if (!st || st.ok !== true) {
        services.grin_node = {
          status: 'error',
          message: (st && st.error) || 'node API unreachable'
        };
      } else {
        const synced = st.synced === true;
        services.grin_node = {
          status: synced ? 'ok' : 'warning',
          height: st.header_height || 0,
          synced
        };
      }
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

  // Node Health Status — every field is read live from the node, none is hardcoded.
  app.get('/api/admin/health/node', secureAdmin, async (req, res) => {
    try {
      // Time the actual round-trip: start the clock BEFORE the call, read it after.
      const startTime = Date.now();
      const status = await blockMonitor.grinNode.getStatus();
      const latencyMs = Date.now() - startTime;
      const endpoint = `http://127.0.0.1:${config.node_api_port || 3413}/v2/owner`;

      // getStatus() RESOLVES with { ok:false, error } on an unreachable node — it does not
      // throw, so the catch below is NOT the unreachable path. api_reachable used to be a
      // hardcoded 'ok' here, which reported the node API as reachable while every other
      // field on the card read 0/false. Answer the question the field actually asks.
      if (!status || status.ok !== true) {
        return res.status(503).json({
          status: 'unhealthy',
          error: (status && status.error) || 'node API unreachable',
          checks: {
            api_reachable: {
              status: 'error',
              latency_ms: latencyMs,
              endpoint,
              error: (status && status.error) || 'node API unreachable'
            }
          },
          timestamp: new Date().toISOString()
        });
      }

      const isSynced = status.synced === true;

      res.json({
        status: isSynced ? 'healthy' : 'warning',
        checks: {
          api_reachable: {
            status: 'ok',
            latency_ms: latencyMs,
            endpoint
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

  // Wallet Health Status — queried from the live wallet, not hardcoded.
  app.get('/api/admin/health/wallet', secureAdmin, async (req, res) => {
    try {
      let walletStatus = 'unknown';
      let walletBalance = { total: 0, available: 0, locked: 0 };
      let walletLatencyMs = 0;
      let torStatus = config.tor_enabled ? 'enabled' : 'disabled';

      // Attempt to query wallet if API exists. retrieve_summary_info returns
      // [was_refreshed, WalletInfo] with amounts as nanoGRIN strings — parse to GRIN.
      if (wallet && wallet.getBalance) {
        try {
          const startTime = Date.now();
          const summary = await wallet.getBalance();
          walletLatencyMs = Date.now() - startTime;
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
            // Combined listener: the wallet's Foreign API (build_coinbase) is mounted on the
            // Owner port via owner_api_include_foreign=true, so coinbase + payouts share one port.
            endpoint: `http://127.0.0.1:${config.wallet_owner_port || 13420}/v2/foreign`,
            latency_ms: walletLatencyMs
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
            min_required: config.min_withdrawal || 25.0
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

  // The TCP stratum dial lives at module scope (probeStratumTcp, next to the public
  // reachability cache it also feeds) so the admin view and the public patch bay judge a
  // region's public port with exactly the same probe. This endpoint dials live on every
  // call — low volume, and an admin looking at gateway health wants ground truth, not a
  // ≤60s-old cached verdict.

  // Per-region GATEWAY liveness (Model C). Gateways are dumb stratum forwarders that never
  // call the Central API, so liveness is derived from two honest signals:
  //   (a) recent shares stamped with the region (financial-grade, survives restart), and
  //   (b) best-effort WireGuard peer last-handshake — the truest "tunnel up" signal for a
  //       region that is healthy but momentarily idle (no miners connected),
  // plus one ACTIVE probe: a TCP dial of the region's public stratum URL (pool_locations),
  // reported separately as stratum_reachable so the admin sees "port open but no miners yet"
  // vs "gateway dead" at a glance.
  // The freshest of (a)/(b) wins for status. region_ports declares the expected regions so
  // an admin sees a configured-but-silent gateway too. (Replaces the relay-heartbeat endpoint.)
  app.get('/api/admin/health/gateways', secureAdmin, async (req, res) => {
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

    // { available, regions } — available:false on any failure (wg absent / not central box)
    const wgSnapshot = await readGatewayStatus();
    const wgByRegion = wgSnapshot.regions || {};

    // Public stratum URLs per region (for the active TCP probe below).
    const locByRegion = new Map();
    try {
      for (const l of db.prepare('SELECT region, stratum_url FROM pool_locations').all()) {
        locByRegion.set(l.region, l.stratum_url);
      }
    } catch (e) { /* table may not exist yet */ }

    const declared = Object.keys(config.region_ports || {});
    // Include admin-declared locations too, so a region added in the panel gets its
    // public port probed even before its WireGuard peer / first share exists.
    const regions = new Set([...declared, ...byRegion.keys(), ...Object.keys(wgByRegion), ...locByRegion.keys()]);
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
        tunnel_handshake_age: hsAge,
        tunnel_rx_bytes: wg && wg.rx_bytes !== undefined ? wg.rx_bytes : null,
        tunnel_tx_bytes: wg && wg.tx_bytes !== undefined ? wg.tx_bytes : null,
        stratum_reachable: null,   // filled by the probe below when a stratum_url exists
        stratum_probe_ms: null
      });
    }
    gateways.sort((a, b) => a.region.localeCompare(b.region));

    // Active probe, all regions in parallel — bounded by the 2.5s per-dial timeout.
    // stratum_reachable stays null when no public URL is declared (nothing to dial).
    await Promise.all(gateways.map(async (g) => {
      const url = locByRegion.get(g.region);
      const m = url ? String(url).match(/^(.+):(\d+)$/) : null;
      if (!m) return;
      const ms = await probeStratumTcp(m[1], m[2]);
      g.stratum_reachable = ms !== null;
      g.stratum_probe_ms = ms;
    }));

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
  // Optional `wg_pubkey` (design §13.3): when present, the WireGuard gateway peer
  // is paired in the SAME step via grin-gateway-ctl — the panel replaces the old
  // 4-hop SSH ping-pong. Metadata save is never hostage to wg state: a helper
  // failure still keeps the saved location and reports 502 + wg_error.
  app.post('/api/admin/locations', secureAdmin, async (req, res) => {
    try {
      const { region, label, country, country_code, api_url, stratum_url } = req.body || {};
      const is_active = req.body && req.body.is_active === false ? 0 : 1;
      const reg = String(region || '').trim();
      if (!reg) return res.status(400).json({ error: 'region is required' });
      const wgPubkey = req.body && req.body.wg_pubkey ? String(req.body.wg_pubkey).trim() : '';
      // A malformed key is a typo, not wg state — fail fast before saving anything.
      if (wgPubkey && !/^[A-Za-z0-9+/]{43}=$/.test(wgPubkey)) {
        return res.status(400).json({ error: 'wg_pubkey is not a WireGuard public key (44 base64 chars ending "=")' });
      }
      if (wgPubkey && !/^[a-z0-9-]{2,12}$/.test(reg)) {
        return res.status(400).json({ error: 'a gateway region key must match ^[a-z0-9-]{2,12}$ (it becomes the wg peer tag)' });
      }
      // Step-up gate for the PAIRING branch only: adding a wg peer grants a remote box a
      // trusted tunnel that forwards stratum with PROXY-protocol source IPs (which feed the
      // miner ownership gate) — at least as sensitive as peer REMOVAL, which is already
      // freshAdmin. Metadata-only saves (no wg_pubkey) stay plain secureAdmin so routine
      // region edits don't prompt. Same challenge contract as requireFreshAuth, so the
      // admin client's adminFetch() step-up flow handles it transparently.
      if (wgPubkey && stepUpRefused(req, res)) return;

      // Step-up gate for the ENDPOINT branch (audit §J1-3). stratum_url is not metadata: it is
      // published by GET /api/pool/locations and rendered on the public dashboard as the
      // connection string miners copy into their rigs (public_html/js/reactor-dashboard.js),
      // so editing it re-points the pool's own "how to connect" panel at another server.
      // Deleting the same region is already freshAdmin; advertising a new destination for the
      // whole pool's hashrate must not be cheaper than that. Compare against what is stored so
      // a label/country edit — which re-posts these fields unchanged — still saves without a
      // prompt, and treat "no stored row yet" as a change so a freshly INSERTed region carrying
      // a URL is gated too.
      const _u = (v) => String(v == null ? '' : v).trim();
      const prevLoc = db.prepare('SELECT api_url, stratum_url FROM pool_locations WHERE region = ?').get(reg);
      const endpointChanged = _u(stratum_url) !== _u(prevLoc && prevLoc.stratum_url) ||
                              _u(api_url) !== _u(prevLoc && prevLoc.api_url);
      if (endpointChanged && stepUpRefused(req, res)) return;

      // Pre-flight the hub tunnel BEFORE writing anything (read-only `list`).
      // The upsert used to run first, so a pool that had never raised its
      // WireGuard server ended up holding a saved region card AND a 502 that
      // named an SSH menu — the worst possible moment to discover a prerequisite.
      // Refuse the whole request instead, and point at the button that fixes it.
      if (wgPubkey) {
        try {
          await gwctl(['list']);
        } catch (e) {
          return res.status(409).json({
            error: 'Multi-region is not enabled on this pool yet, so the gateway key cannot be paired. Turn it on with "Enable multi-region" at the top of this page, then save this region again.',
            wg_server_missing: true,
            wg_error: e.message
          });
        }
      }

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

      if (!wgPubkey) return res.json({ success: true, location: row });

      let pair;
      try {
        pair = await gwctl(['add-peer', '--region', reg, '--pubkey', wgPubkey]);
      } catch (e) {
        return res.status(502).json({
          success: false, location: row, wg_error: e.message,
          error: 'Region saved, but WireGuard pairing failed: ' + e.message
        });
      }

      // Hot-bind (§13.3): the helper persisted region_ports in pool.json; mirror it
      // in the in-memory config and bind the tunnel listener NOW — no service
      // restart, zero disruption to connected miners. On the next boot the
      // listener is rebuilt from pool.json anyway. `existing` (dup pubkey) and
      // `replaced` (new box, same region) keep their port, so bind is a no-op then.
      let bindError = null;
      if (pair.region_port) {
        config.region_ports = config.region_ports || {};
        config.region_ports[pair.region] = pair.region_port;
        if (pair.hub_tunnel_ip) config.region_listen_host = pair.hub_tunnel_ip;
        if (stratumServer) {
          // AWAIT the real outcome and surface it (audit §J6-12). bindRegionListener used to
          // return true unconditionally — the listen is asynchronous and its error handler only
          // logged — and this call discarded the return value anyway, so the panel reported a
          // successful pairing for a listener that was not listening. A bind failure is exactly
          // the case an operator must be told about: the region is saved and the tunnel is up,
          // but no miner in it can reach the pool.
          try {
            const r = await stratumServer.bindRegionListener(pair.region, pair.region_port);
            if (r && r.error) bindError = r.error;
          } catch (e) {
            bindError = e.message;
            console.error(`[ERROR] hot-bind region listener ${pair.region}: ${e.message}`);
          }
        }
      }

      db.prepare(`
        INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, details, ip)
        VALUES (?, 'gateway_pair', 'wg_peer', ?, ?, ?)
      `).run(req.user.user_id, pair.region, JSON.stringify({
        region: pair.region, pubkey: wgPubkey, peer_ip: pair.peer_ip,
        region_port: pair.region_port, existing: !!pair.existing, replaced: !!pair.replaced
      }), req.ip);

      // `synced:false` = the peer is in the CONFIG but `wg syncconf` did not load it
      // into the running interface, so the gateway will hand-shake only after a
      // tunnel bounce. The CLI has always warned about this; the panel used to
      // report plain success and leave the operator debugging the gateway box.
      res.json({
        success: true, location: row,
        // Non-fatal but load-bearing: the region exists and the peer is configured, yet its
        // stratum listener did not come up, so nothing in that region can connect (§J6-12).
        stratum_bind_error: bindError,
        pairing: pair.pairing, peer_ip: pair.peer_ip, region_port: pair.region_port,
        existing: !!pair.existing, replaced: !!pair.replaced,
        synced: pair.synced !== false,
        sync_warning: pair.synced === false
          ? 'The peer was written to the WireGuard config, but it could not be loaded into the running tunnel. '
            + 'This gateway will not hand-shake until the tunnel is brought back up on this box.'
          : undefined
      });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // ─── MULTI-REGION SERVER (Admin only) ──────────────────────────────
  // The hub's OWN WireGuard tunnel — the thing every gateway peers with. Until
  // these two routes existed it could only be raised from the CLI (menu W → 1),
  // which made "pair a gateway from the panel, no SSH needed" false for every
  // pool that had never gone multi-region. GET is the page's pre-flight; POST is
  // the button that fixes it in place.
  app.get('/api/admin/gateways/server', secureAdmin, async (req, res) => {
    try {
      const list = await gwctl(['list']);
      // Two independent facts. `ready` = the hub was set up at all (conf + keypair);
      // `interface_up` = the tunnel is running RIGHT NOW. A conf outlives a
      // `wg-quick down` and a boot where the unit failed, so collapsing them into
      // one light is how a dead tunnel renders green while every gateway is dark.
      res.json({
        success: true, ready: true,
        interface_up: list.interface_up !== false,
        hub_pubkey: list.hub_pubkey || null,
        hub_endpoint: list.hub_endpoint || null,
        hub_tunnel_ip: list.hub_tunnel_ip || null,
        peers: (list.gateways || []).length
      });
    } catch (e) {
      // NOT an error: "no tunnel yet" is the normal state of a single-box pool,
      // and the page renders a banner for it rather than a failure.
      res.json({ success: true, ready: false, interface_up: false, reason: e.message });
    }
  });

  // Raising a tunnel and opening a UDP port is at least as sensitive as pairing a
  // peer, so it takes the same step-up gate peer REMOVAL takes. The long timeout
  // is deliberate: on a box without wireguard-tools the helper installs the
  // package inside this request rather than failing with homework for the operator.
  app.post('/api/admin/gateways/server', freshAdmin, async (req, res) => {
    try {
      const r = await gwctl(['init-server'], 180000);
      // Mirror region_listen_host into the live config so a pairing done in this
      // same process binds its listener on the tunnel IP without a restart.
      if (r.hub_tunnel_ip) config.region_listen_host = r.hub_tunnel_ip;
      db.prepare(`
        INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, details, ip)
        VALUES (?, 'gateway_server_init', 'wg_server', ?, ?, ?)
      `).run(req.user.user_id, r.hub_tunnel_ip || 'wg', JSON.stringify({
        config: r.config, keypair: r.keypair, interface: r.interface,
        firewall: r.firewall, listen_port: r.listen_port, boot_enabled: r.boot_enabled
      }), req.ip);
      // Two steps can legitimately fail while the tunnel itself came up, and BOTH
      // are invisible until something else breaks much later, so they are reported
      // as caveats rather than folded into success:
      //   · boot_enabled=false — /etc/systemd/system is not writable in this
      //     service's namespace, so the tunnel is up now and gone after a reboot.
      //   · firewall='ufw-failed' — same reason for /etc/ufw; the UDP port stays
      //     shut and every gateway times out with no local symptom at all.
      // The CLI (root, no namespace) does both, which is why W → 1 is the fallback.
      const caveats = [];
      if (r.boot_enabled === false) {
        caveats.push('The tunnel could not be enabled at boot from here, so a reboot of this box would '
          + 'take it down. Run "systemctl enable wg-quick@<interface>" over SSH once, or use pool menu W → 1.');
      }
      if (r.firewall === 'ufw-failed') {
        caveats.push('ufw is active but the WireGuard UDP port could not be opened from here. Until you run '
          + `"ufw allow ${r.listen_port}/udp" over SSH, gateways will not be able to hand-shake.`);
      }
      res.json({
        success: true,
        already_configured: !!r.already_configured,
        hub_pubkey: r.hub_pubkey, hub_endpoint: r.hub_endpoint,
        hub_tunnel_ip: r.hub_tunnel_ip, listen_port: r.listen_port,
        firewall: r.firewall, interface: r.interface,
        boot_enabled: r.boot_enabled !== false,
        caveats: caveats.length ? caveats : undefined
      });
    } catch (e) {
      res.status(502).json({ error: 'Could not enable multi-region: ' + e.message });
    }
  });

  // Re-print a region's GRINGW1 pairing string (replaces SSH `W → 3` for a lost
  // string). Read-only — the helper re-derives it from the live wg conf + pool.json.
  app.get('/api/admin/gateways/:region/pairing', secureAdmin, async (req, res) => {
    try {
      const region = String(req.params.region || '').trim();
      if (!/^[a-z0-9-]{2,12}$/.test(region)) return res.status(400).json({ error: 'invalid region key' });
      const list = await gwctl(['list']);
      const g = (list.gateways || []).find((x) => x.region === region);
      if (!g) return res.status(404).json({ error: `no WireGuard gateway peer for region "${region}"` });
      res.json({ success: true, region, pairing: g.pairing, peer_ip: g.peer_ip, region_port: g.region_port });
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  // Peer removal is destructive (revokes the gateway's tunnel) → stays behind
  // freshAdmin with the delete. `?remove_peer=1` also unpairs the wg peer; without
  // it only the display card goes (the tunnel keeps working — legacy behaviour).
  app.delete('/api/admin/locations/:id', freshAdmin, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const row = db.prepare('SELECT * FROM pool_locations WHERE id = ?').get(id);
      if (!row) return res.status(404).json({ error: 'location not found' });
      db.prepare('DELETE FROM pool_locations WHERE id = ?').run(id);
      db.prepare(`
        INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, details, ip)
        VALUES (?, 'location_delete', 'pool_location', ?, ?, ?)
      `).run(req.user.user_id, row.region, JSON.stringify(row), req.ip);

      if (String(req.query.remove_peer || '') !== '1') {
        return res.json({ success: true, deleted: row.region });
      }
      try {
        const rm = await gwctl(['remove-peer', '--region', row.region]);
        if (config.region_ports) delete config.region_ports[row.region];
        // v1 does NOT hot-unbind the listener (rare op) — it idles on the tunnel
        // IP until the next natural service restart rebuilds from pool.json.
        db.prepare(`
          INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, details, ip)
          VALUES (?, 'gateway_unpair', 'wg_peer', ?, ?, ?)
        `).run(req.user.user_id, row.region, JSON.stringify({ region: row.region, synced: rm.synced !== false }), req.ip);
        res.json({ success: true, deleted: row.region, wg_removed: true });
      } catch (e) {
        // The card is already gone — surface the peer failure instead of 500ing.
        res.json({ success: true, deleted: row.region, wg_removed: false, wg_error: e.message });
      }
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
      const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 500);
      const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
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

  // Explicit column list, NOT `SELECT *` (audit §J8-2). `miner_accounts` carries six
  // ownership-proof columns — last_ip / prev_ip / anchor_ip (salted scrypt of the miner's
  // mining IP) and last_pass_hash / prev_pass_hash / anchor_pass_hash (salted scrypt of the
  // rig password). Those exist so the DB holds no readable mining IP and no readable rig
  // password (§G, memory `project_pool_ip_privacy`), and the PUBLIC account summary is
  // careful to report only `has_recorded_ip` / `has_recorded_pass` booleans. `...acct` here
  // was shipping the hashes themselves into an admin browser, where §C3's unrevocable
  // access token puts them one stolen session away from an offline attack on the payout
  // gate's second factor. Same fix, same reason, as the 2026-07-28 pass on
  // /api/pool/payments and /api/pool/miners. The panel reads none of these six.
  // `pass_proof_state` IS included: it is a verdict string ('ok' / a reject code), already
  // public on /api/account/:addr, and it is what answers "why won't my password work?".
  app.get('/api/admin/miners/:addr', secureAdmin, (req, res) => {
    try {
      const { addr } = req.params;
      const acct = db.prepare(
        `SELECT id, grin_address, balance, balance_locked, is_online, last_seen_at, min_payout,
                last_ip_at, prev_ip_at, last_pass_at, prev_pass_at, anchor_set_at,
                pass_proof_state, is_banned, ban_reason, banned_at,
                nostr_username, nostr_npub, nostr_registered_at,
                nostr_prev_username, nostr_prev_npub,
                created_at, updated_at
           FROM miner_accounts WHERE grin_address = ?`
      ).get(addr);
      if (!acct) return res.status(404).json({ error: 'miner not found' });

      const total_paid = db.prepare(
        `SELECT COALESCE(SUM(amount),0) AS t FROM withdrawals WHERE grin_address = ? AND status='confirmed'`
      ).get(addr).t;
      const pending = db.prepare(
        `SELECT * FROM withdrawals WHERE grin_address = ? AND status IN ('tor_checking','tor_sending','retry_scheduled','slatepack_pending','finalizing') ORDER BY created_at DESC`
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
  // balances. Records a balance_log credit + admin_audit_log row. Step-up gated (freshAdmin)
  // for parity with every other balance-mutating action (withdrawals, payouts, incentives).
  app.post('/api/admin/miners/:addr/inject', freshAdmin, (req, res) => {
    try {
      if (config.network !== 'testnet') {
        return res.status(403).json({ error: 'balance injection is testnet-only' });
      }
      const { addr } = req.params;
      const amount = parseFloat(req.body && req.body.amount);
      // Number.isFinite, not isNaN: `"Infinity"` passes isNaN() and `<= 0`, and a REAL
      // balance column stores +Inf permanently — no finite correction can undo it, and
      // JSON.stringify renders it as `null`, so the corruption is invisible. Audit §J7-5.
      if (!Number.isFinite(amount) || amount <= 0) {
        return res.status(400).json({ error: 'amount must be a positive, finite number' });
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
      // Number.isFinite, not isNaN: `"Infinity"` passes isNaN() and `<= 0`, and a REAL
      // balance column stores +Inf permanently — no finite correction can undo it, and
      // JSON.stringify renders it as `null`, so the corruption is invisible. Audit §J7-5.
      if (!Number.isFinite(amount) || amount <= 0) {
        return res.status(400).json({ error: 'amount must be a positive, finite number' });
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
  // High-risk sections require step-up auth; cosmetic ones (branding/seo/…) save with a normal
  // admin session. A section is listed here when EVERY key in it is money- or access-critical:
  //   payout      fees, min withdrawal, dormancy, the Goblin destination cooldown
  //   access      admin IP rules, mandatory-2FA switch
  //   incentives  every key sets an amount that auto-credits miner balances (jackpot, join
  //               bonus, streak, lottery pots, the % of pool fee diverted to the prize pool)
  //   database    retention windows that DELETE the money trail — balance_log_keep_days and
  //               audit_log_keep_days prune the ledger and the admin audit log
  const STEP_UP_SETTINGS_SECTIONS = new Set(['payout', 'access', 'incentives', 'database']);

  // Individually critical keys that live in an otherwise cosmetic section. pool_info is mostly
  // name/tagline/description, but it also carries the pool's cut and who may mine at all.
  //
  // Gate on a real VALUE CHANGE, not on the key being present: the settings form harvester
  // posts EVERY field in the section on every save, so "the body mentions pool_fee_percent"
  // is true even when the operator only edited the tagline — that would demand a TOTP code
  // for cosmetic edits and train the operator to reflex-approve challenges.
  //
  // The analytics/branding entries below are NOT cosmetic despite living in cosmetic sections
  // (audit §J1-1). They are script/CSS execution sinks on the PUBLIC origin, and public_html/
  // login.html loads branding.js — so an attacker on a stolen session (which, per §C3, survives
  // logout, a password change AND "revoke sessions" until the access token expires) could write
  // a keylogger onto the admin login form, harvest the password + a live TOTP code, and thereby
  // reach every freshAdmin route. Gating them here is what makes secureAdmin genuinely weaker
  // than freshAdmin for this write. Do not "tidy" them out as branding fields.
  const STEP_UP_SETTINGS_KEYS = new Set([
    'pool_fee_percent',   // the pool's cut of every block
    // 'address_whitelist' / 'max_miners' / 'pool_visibility' were gated here until 2026-09-02.
    // The keys are gone (audit §J9-1): nothing enforced them, and the step-up gate on a key no
    // consumer reads is the strongest signal the surface can give that a control is real.
    // analytics — raw HTML injected into every public page; branding.js re-creates <script>
    // nodes out of it via cloneScript() specifically so they execute.
    'custom_head_html',
    'custom_body_html',
    // analytics — third-party script ORIGINS, loaded as <script src> by the matching provider.
    'plausible_src',
    'umami_src',
    'matomo_url',
    // branding — CSS injection sinks. custom_css and font_family both land in a <style>
    // (font_family by string concatenation, so it breaks out of the rule), and font_url is a
    // <link rel=stylesheet> to an operator-chosen origin. CSS alone cannot run JS, but it can
    // restyle the payout form or overlay a fake one, which is money-relevant on its own.
    'custom_css',
    'font_url',
    'font_family',
    // branding — the theme-builder map. applyTheme() writes every entry with
    // style.setProperty() onto BOTH <html> and <body>, and unlike custom_css/font_* it runs
    // ABOVE branding.js's isCredentialPage() guard, so it reaches login.html (audit §J9-3).
    // Same class of sink as custom_css; it was the only one of the four left at secureAdmin.
    'custom_theme',
    // branding — reaches an <a href> verbatim, so a javascript: URI executes on click.
    'cta_link',
  ]);

  // Compare a submitted value against the stored one. Stored rows are TEXT while the form may
  // send numbers, booleans or arrays, so compare by shape: numerically when both are numeric
  // (1.0 vs '1.0'), canonical JSON when either side is a structure ([] vs '[]'), else trimmed
  // strings. Ambiguity resolves to "changed" — a false positive costs one extra TOTP prompt,
  // a false negative silently lets the fee move on a plain session.
  const settingValueUnchanged = (submitted, stored) => {
    if (submitted === undefined || stored === undefined) return submitted === stored;
    const sa = typeof submitted === 'string' ? submitted.trim() : submitted;
    const sb = typeof stored === 'string' ? stored.trim() : stored;
    const structural = (v) => (v && typeof v === 'object') ||
      (typeof v === 'string' && (v.startsWith('[') || v.startsWith('{')));
    if (structural(sa) || structural(sb)) {
      const canon = (v) => {
        if (v && typeof v === 'object') return JSON.stringify(v);
        try { return JSON.stringify(JSON.parse(v)); } catch (e) { return String(v); }
      };
      return canon(sa) === canon(sb);
    }
    // Compare numerically only when BOTH sides are plain decimal — `Number()` also accepts
    // 0x/0b/0o literals while every validator in pool-settings.js uses parseFloat/parseInt,
    // which stop at the 'x'. That mismatch made `0x1` compare EQUAL to a stored `1` (so no
    // step-up was demanded) and then store `0` (audit §J9-2): the pool fee went to zero on a
    // plain secureAdmin session, past the gate that exists to survive a stolen one. Anything
    // this rejects falls through to the string compare and reads as CHANGED, which is the
    // direction this function already says it resolves ambiguity in.
    const plainDecimal = (v) =>
      typeof v === 'number' || /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(String(v));
    const na = Number(sa), nb = Number(sb);
    if (sa !== '' && sb !== '' && plainDecimal(sa) && plainDecimal(sb) &&
        Number.isFinite(na) && Number.isFinite(nb)) return na === nb;
    return String(sa) === String(sb);
  };

  const criticalSettingChanged = (section, body) => {
    if (!body || typeof body !== 'object') return false;
    let current;
    // An unreadable section means we cannot prove nothing critical moved → demand step-up.
    try { current = poolSettings.getSection(section); } catch (e) { return true; }
    return Object.keys(body).some((key) =>
      STEP_UP_SETTINGS_KEYS.has(key) && !settingValueUnchanged(body[key], current[key]));
  };

  app.post('/api/admin/settings/:section', secureAdmin, (req, res) => {
    try {
      const sectionGated = STEP_UP_SETTINGS_SECTIONS.has(req.params.section);
      if (sectionGated || criticalSettingChanged(req.params.section, req.body)) {
        // Freshness + mandatory-2FA, both halves (audit §I7). Keep the section-specific
        // wording on the freshness refusal — the operator needs to know WHY they are being
        // challenged for what may look like a cosmetic save.
        if (!authManager.isTokenFresh(req.token, STEP_UP_MAX_AGE_S)) {
          return res.status(403).json({
            error: sectionGated
              ? 'Re-authentication required for this section'
              : 'Re-authentication required to change a fee, whitelist or visibility setting',
            challenge_required: true
          });
        }
        if (stepUpRefused(req, res)) return;
      }
      // Refuse to switch mandatory 2FA ON unless the admin doing it is already enrolled.
      // Otherwise the save succeeds (the gate read `false` when the middleware ran) and the
      // operator's very next step-up action — including editing this section back — is
      // refused, leaving enrollment or the break-glass CLI as the only ways out. Making the
      // requirement satisfiable at the moment it's imposed avoids that entirely.
      if (req.params.section === 'access' &&
          String((req.body || {}).require_admin_totp) === 'true' &&
          !authManager.isTotpEnabled(req.user.user_id)) {
        return res.status(400).json({
          error: 'Set up 2FA on your own account first — otherwise enabling this would immediately block your own admin actions.',
          totp_enrollment_required: true
        });
      }
      const updated = poolSettings.updateSection(req.params.section, req.body, req.user.user_id);
      invalidateBranding();   // §J12-8: /api/public/branding is memoised; an edit must show at once
      res.json({ success: true, section: req.params.section, data: updated });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // Restore section to defaults
  app.post('/api/admin/settings/:section/restore', freshAdmin, (req, res) => {
    try {
      const restored = poolSettings.resetSection(req.params.section, req.user.user_id);
      invalidateBranding();   // §J12-8
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
      // statement = lifetime in/out breakdown (fee-cut · donations · top-ups · abandoned balances
      // in; prizes · jackpots · join bonuses · streaks out) + current balance + recent 25 rows.
      // `balance`/`ledger` kept for backward-compat with the existing panel wiring.
      const statement = incentivesManager.prizePoolStatement(25);
      res.json({
        success: true,
        balance: statement.balance,
        ledger: statement.recent,
        statement,
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
      const result = await lotteryManager.runDraw(type, {
        eventName: req.body.event_name || null,
        // Finite-only (§J7-5): parseFloat('Infinity') is truthy, so `|| 0` does not catch it.
        potGrinOverride: (Number.isFinite(parseFloat(req.body.pot_grin)) ? parseFloat(req.body.pot_grin) : 0),
      });
      db.prepare(`
        INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, details)
        VALUES (?, 'lottery_draw_now', 'lottery', ?, ?)
      `).run(req.user.user_id, String(result.draw_id || ''), JSON.stringify(result));
      res.json({ success: true, result });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // ─── Contest campaigns (admin CRUD) ─────────────────────────────────────────
  // A campaign is a scheduled lottery draw with an explicit date-range window and optional
  // per-campaign rule overrides (pot split, min active days, whale cap). See lib/lottery.js.

  app.get('/api/admin/incentives/campaigns', secureAdmin, (req, res) => {
    try {
      res.json({ success: true, campaigns: lotteryManager.listCampaigns(50) });
    } catch (err) {
      res.status(500).json({ error: 'Failed to load campaigns' });
    }
  });

  app.post('/api/admin/incentives/campaigns', freshAdmin, (req, res) => {
    try {
      const campaign = lotteryManager.createCampaign(req.body || {});
      db.prepare(`
        INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, details)
        VALUES (?, 'campaign_create', 'campaign', ?, ?)
      `).run(req.user.user_id, String(campaign.id), JSON.stringify(campaign));
      res.json({ success: true, campaign });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.put('/api/admin/incentives/campaigns/:id', freshAdmin, (req, res) => {
    try {
      const campaign = lotteryManager.updateCampaign(parseInt(req.params.id, 10), req.body || {});
      db.prepare(`
        INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, details)
        VALUES (?, 'campaign_update', 'campaign', ?, ?)
      `).run(req.user.user_id, String(campaign.id), JSON.stringify(campaign));
      res.json({ success: true, campaign });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post('/api/admin/incentives/campaigns/:id/cancel', freshAdmin, (req, res) => {
    try {
      const campaign = lotteryManager.cancelCampaign(parseInt(req.params.id, 10));
      db.prepare(`
        INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, details)
        VALUES (?, 'campaign_cancel', 'campaign', ?, ?)
      `).run(req.user.user_id, String(campaign.id), JSON.stringify({ id: campaign.id }));
      res.json({ success: true, campaign });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // Manually run a scheduled campaign now (testing / early close). Pays real prize-pool GRIN.
  app.post('/api/admin/incentives/campaigns/:id/run', freshAdmin, async (req, res) => {
    try {
      const c = lotteryManager.getCampaign(parseInt(req.params.id, 10));
      if (!c) return res.status(404).json({ error: 'campaign not found' });
      if (c.status !== 'scheduled') return res.status(400).json({ error: 'campaign already drawn or cancelled' });
      const result = await lotteryManager.runCampaign(c);
      db.prepare(`
        INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, details)
        VALUES (?, 'campaign_run_now', 'campaign', ?, ?)
      `).run(req.user.user_id, String(c.id), JSON.stringify(result));
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
          // No 'custom' fallback: it was never in allowedTypes, so an omitted ?type= always
          // failed with "Invalid asset type: custom" — an error naming an internal constant
          // the operator cannot act on (audit §J10-5). Refuse up front and name the valid set.
          const assetType = String(req.query.type || '');
          if (!assetManager.allowedTypes.includes(assetType)) {
            return res.status(400).json({
              error: `?type= is required and must be one of: ${assetManager.allowedTypes.join(', ')}`
            });
          }
          const saved = await assetManager.saveAsset(req.file, assetType, req.user.user_id);
          invalidateBranding();   // §J12-8: assetUrlFor() feeds the memoised branding payload
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
      invalidateBranding();   // §J12-8
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
