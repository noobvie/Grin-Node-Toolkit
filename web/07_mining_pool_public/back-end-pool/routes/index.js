// Every HTTP route the pool serves, registered on `app` in the order Express will match them.
// This is the former setupRoutes() body from index.js, moved verbatim (code-layout refactor P1);
// later parts split it into per-area files under routes/ and this file becomes the ordered list.
//
// Where identifiers come from: stateless modules are require()d here exactly as index.js does
// (a lib re-required is the same cached module instance). Everything that is an INSTANCE or
// STATE — the managers, config, db, the failure Maps, and index.js's module-level helpers — is
// built once by index.js and handed over in `ctx`. None of them is reassigned after
// registerRoutes() runs (checked in P1), so destructuring them here is behaviour-identical to
// the old closure capture.

const express = require('express');
const path = require('path');
const AssetManager = require('../lib/asset-manager');
const GrinWalletVersion = require('../lib/grin-wallet-version');
const { requireAdmin } = require('../lib/auth-middleware');
const minerStatus = require('../lib/miner-status');
const { getHorizon: getLedgerRollupHorizon } = require('../lib/ledger-rollup');
const { donorSettings } = require('../lib/donor-names');
const { donorLedger, donorScore, loyaltyMultiplier: donorLoyaltyMultiplier,
        leagueOrder: donorLeagueOrder, liveDonations: donorLiveDonations,
        NO_LIVE: DONOR_NO_LIVE } = require('../lib/donor-ledger');
const DonorProfiles = require('../lib/donor-profiles');
const { parseDonateToken } = require('../lib/stratum-protocol');
const { verifyOwnerProof, auditOwnerProof, PROOF_SET_MAX } = require('../lib/owner-proof');
const explorers = require('../lib/explorers');
const AlertMonitor = require('../lib/alert-monitor');
const NodeAvailability = require('../lib/node-availability');
const AdsManager = require('../lib/ads');
const PagesManager = require('../lib/pages');
const PostsManager = require('../lib/posts');
const crypto = require('crypto');
const fs = require('fs');
const createGuards = require('./_shared/guards');
const createPublicRoutes = require('./public');
const createSeoRoutes = require('./seo');
const createAuthRoutes = require('./auth');
const createPoolRoutes = require('./pool');
const createAccountRoutes = require('./account');
const createAdminPayoutsRoutes = require('./admin/payouts');
const createAdminStratumRoutes = require('./admin/stratum');
const { GRIN_ADDR_RE } = require('./_shared/grin-address');
const createCurrentExplorerKey = require('./_shared/explorer');
const caches = require('./_shared/caches');
const os = require('os');

module.exports = function registerRoutes(app, ctx) {
  const {
    config, db, wallet, stratumServer, stratumPause, blockManager, minerManager,
    blockMonitor, rewardDistributor, incentivesManager, lotteryManager, walletTor, withdrawalScheduler,
    authManager, hashrateTracker, poolstatsReporter, rateLimiter, ipFilter, alertMonitor,
    alertDelivery, poolSettings, assetManager, retentionManager, nodeAvailability,
    adsManager, pagesManager, postsManager, uploadsDir, mediaUpload,
    gamesLink,
    gwctl, readGatewayStatus, probeStratumTcp, donorNameRule,
  } = ctx;

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

  // One guards instance for the whole app (I7) — handed to every route file that needs a chain.
  const guards = createGuards(ctx);
  const {
    secureAdmin, freshAdmin,
    stepUpRefused, totpIsMandatory, STEP_UP_MAX_AGE_S,
  } = guards;

  // ─── Public Health Check (rate-limited, no auth) ───────────────────────────
  // Registered on both /health and /api/health: nginx proxies /api/* to the backend,
  // so the /api/health alias is what reaches the pool through the standard proxy path.
  app.get(['/health', '/api/health'],
    rateLimiter.middleware('public'),
    (req, res) => {
      res.json({
        // `status` reports the HTTP backend, which is fine during a stratum pause (§21.9);
        // `stratum` says whether miners are being accepted.
        status: 'ok',
        network: config.network,
        stratum: stratumPause && stratumPause.isPaused() ? 'paused' : 'accepting',
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

  // _brandingCache lives on routes/_shared/caches.js (readers here, invalidators in other files).
  const { invalidateBranding } = caches;
  // Every stratum pause transition — the 15 s timer's auto-resume and window start included —
  // drops the memo, so the computed maintenance overlay follows the pause (design §21.8).
  if (stratumPause) stratumPause.onChange = invalidateBranding;
  const currentExplorerKey = createCurrentExplorerKey(ctx);
  app.use(createPublicRoutes(ctx));

  // ─── Games platform link (design §19.3) — all logic in lib/games-link.js ──────
  // The three internal routes are already mounted (top of file); this gives them the DB, starts
  // the 60 s health probe and mounts the admin proxy (/api/admin/games/*) behind secureAdmin,
  // with step-up enforced in the lib for the §19.11 paths.
  gamesLink.attach({ db, config, poolSettings, verifyOwnerProof, auditOwnerProof, onHealthChange: invalidateBranding });
  gamesLink.mountAdmin(app, { secureAdmin, stepUpRefused });

  app.use(createSeoRoutes(ctx));
  app.use(createAuthRoutes(ctx, guards));

  app.use(createPoolRoutes(ctx, app));

  // Test endpoints removed for production security
  // REMOVED: /api/test/add-miner, /api/test/miners, /api/test/blocks, /api/test/tables
  // These endpoints are unprotected and allow arbitrary data manipulation.
  // For testing in development, use curl with direct database queries.





  app.use(createAccountRoutes(ctx));

  // Test endpoint removed - manual block crediting disabled for security

  app.get('/api/admin/node-status', secureAdmin, (req, res) => {
    blockMonitor.grinNode.getStatus()
      .then(status => res.json(status))
      .catch(err => res.status(500).json({ error: err.message }));
  });

  // Node availability (design §20.6) — both observers' rows, never merged: source 'pool' (this
  // pool's own probe) and source 'recorder' (the node box's event recorder ledger). Admin only;
  // these carry exact timestamps, classes and details that the public surface never may.
  // `network` defaults to (and can only usefully be) the pool's own network.
  const nodeAvailParams = (req, res) => {
    if (!nodeAvailability) { res.status(503).json({ error: 'node availability is not running' }); return null; }
    const range = NodeAvailability.parseRange(req.query.range);
    if (!range) { res.status(400).json({ error: 'range must be one of 7d, 30d, 90d, 1y' }); return null; }
    const network = req.query.network;
    if (network !== undefined && network !== '' && network !== 'mainnet' && network !== 'testnet') {
      res.status(400).json({ error: 'network must be mainnet or testnet' }); return null;
    }
    if (network && network !== nodeAvailability.net) {
      // This pool watches one node; the other network has no rows here.
      res.json({ network, range: range.key, other_network: true, events: [], sources: {} }); return null;
    }
    return range;
  };

  app.get('/api/admin/node-events', secureAdmin, (req, res) => {
    try {
      const range = nodeAvailParams(req, res);
      if (!range) return;
      res.json(Object.assign({ range: range.key }, nodeAvailability.events(range.secs)));
    } catch (err) {
      console.error(`[node-availability] /api/admin/node-events: ${err.message}`);
      res.status(500).json({ error: 'node events unavailable' });
    }
  });

  app.get('/api/admin/node-availability', secureAdmin, (req, res) => {
    try {
      const range = nodeAvailParams(req, res);
      if (!range) return;
      res.json(Object.assign({ range: range.key }, nodeAvailability.availability(range.secs)));
    } catch (err) {
      console.error(`[node-availability] /api/admin/node-availability: ${err.message}`);
      res.status(500).json({ error: 'node availability unavailable' });
    }
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

  app.use(createAdminPayoutsRoutes(ctx, guards));
  app.use(createAdminStratumRoutes(ctx, guards));

  // ─── ADS (Admin CRUD) ──────────────────────────────────────────────
  // Operator-managed promotions (a banner image or a native text card) bound to a public
  // placement. secureAdmin (not freshAdmin) — ads are not money/destructive of funds, and
  // since design §19.17 D22 removed the `code` type an ad can no longer carry script, so
  // secureAdmin is no longer a route to code on the public origin. An attempt to create a
  // code ad, or to edit a legacy one, is a 400 that says why (lib/ads.js).
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
  // Pool-found blocks with maturity countdown + chain-explorer deep-links. Distinct from a public
  // chain explorer: this is only THIS pool's blocks, with payout-relevant context (status,
  // maturity, orphan reversals) that a chain explorer cannot have. `grinscan_url` is a legacy
  // field name kept for API shape — it holds whichever explorer the `branding.explorer_mainnet`
  // setting resolves to (lib/explorers.js; testnet is always test.grinscan.org), and the admin
  // page builds its own links via window.Explorer.
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

      // The operator's explorer setting, resolved once per request (lib/explorers.js owns the
      // path schemes — they differ per explorer, so never build one of these URLs by hand).
      const explorerKey = currentExplorerKey();
      const explorerBlockUrl = (height) => explorers.explorerUrl(explorerKey, 'block', height);

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

  // Close an alert that nothing resolves on its own (AlertMonitor.MANUAL_RESOLVE_TYPES): today only
  // slate_refunded_but_mined, the "paid twice?" alarm the Health page's Grin Wallet card shows until
  // the operator has reconciled it by hand. Step-up + audited, and a note is REQUIRED — closing it
  // silences a money alarm, so the audit row must say what the operator found. Any other type is
  // refused (409): those are resolved by the code that raised them.
  app.post('/api/admin/alerts/:alertId/resolve', freshAdmin, (req, res) => {
    try {
      const id = parseInt(req.params.alertId, 10);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'invalid alert id' });
      const note = String((req.body && req.body.note) || '').trim().slice(0, 500);
      if (!note) return res.status(400).json({ error: 'say what you found or did — the note goes in the audit log' });
      const r = AlertMonitor.resolveManual(db, id, req.user.user_id);
      if (!r.ok) return res.status(r.code).json({ error: r.error });
      db.prepare(`
        INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, details, ip)
        VALUES (?, 'alert_resolve', 'alert', ?, ?, ?)
      `).run(req.user.user_id, String(id), JSON.stringify({ type: r.alert.type, message: r.alert.message, note }), req.ip);
      res.json({ success: true, id, type: r.alert.type });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/admin/alerts/:alertId/snooze', secureAdmin, (req, res) => {
    try {
      const { alertId } = req.params;
      const { minutes } = req.body;
      const snoozeMinutes = minutes || 60;
      // The revenue-address alarm cannot be hidden during its hold (AlertMonitor.closeLockedUntil).
      const target = db.prepare('SELECT type FROM alerts WHERE id = ?').get(parseInt(alertId, 10));
      if (target && AlertMonitor.closeLockedUntil(db, target.type)) {
        return res.status(409).json({ error: 'this alert cannot be snoozed until the 24 h revenue-address hold ends' });
      }

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
      // Donor names + banners waiting for review (design §18.6) — the Overview tile that says
      // the Donors page has something to decide. Same count the nav badge reads.
      let pendingDonorRequests = 0;
      try { pendingDonorRequests = DonorProfiles.pendingCount(db); } catch (_) { pendingDonorRequests = 0; }

      res.json({
        timestamp: new Date().toISOString(),
        // Flat aliases consumed by the Overview KPI tiles.
        total_users:         usersRow.c || 0,
        active_miners:       minerCount || 0,
        pool_hashrate_gps:   hashrateStats?.current_hashrate || 0,
        unclaimed_balance:   unclaimedRow.s || 0,
        pending_withdrawals: withdrawalStatus?.pending_count || 0,
        pending_donor_requests: pendingDonorRequests,
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
    // Payouts the pool wallet could not cover in the last 24h (withdrawal-scheduler
    // _noteWalletShort). The miner only ever sees "pool busy, try again later"; grin-wallet's
    // real available/needed figures are shown HERE, on the admin-only health card. A reachable
    // wallet that is refusing payouts is not "OK", so it downgrades ok → warning (never hides an
    // error). Usually outputs tied up by payouts still settling; if it persists, fund the wallet.
    try {
      const dayAgo = new Date(Date.now() - 86400000).toISOString();
      const short = db.prepare(
        `SELECT message, occurrence_count, last_seen FROM alerts
         WHERE type = 'pool_wallet_short' AND status = 'active' AND last_seen >= ?
         ORDER BY id DESC LIMIT 1`
      ).get(dayAgo);
      if (short && services.grin_wallet) {
        if (services.grin_wallet.status === 'ok') services.grin_wallet.status = 'warning';
        const n = short.occurrence_count || 1;
        services.grin_wallet.message = [
          services.grin_wallet.message,
          `${n} payout attempt${n === 1 ? '' : 's'} refused — pool wallet short (last ${String(short.last_seen).slice(0, 16).replace('T', ' ')} UTC). ` +
          `Latest: ${short.message}`
        ].filter(Boolean).join(' · ');
      }
    } catch (e) { /* alerts table unreadable — leave the wallet card as measured */ }
    // The scheduler's rolling payout alerts — payout_held (a Tor payout held > 24 h), payout_unmined
    // (paid but not seen mined after 1 h: 'critical' when the wallet cancelled the tx or has no
    // record of it) and tor_send_path (the pool's own Tor send path is broken). Each is resolved by
    // the scheduler, so no time window here. 'critical' outranks a merely degraded card but never
    // masks a wallet that is actually down ('error'). One helper, so the rules live in one place.
    try {
      AlertMonitor.foldPayoutAlerts(db, services.grin_wallet);
    } catch (e) { /* alerts table unreadable — leave the wallet card as measured */ }
    // The grin-wallet the pool runs vs the version its payout guards were checked against
    // (lib/grin-wallet-version.js). Cached 10 min; Degraded when they differ, never worse.
    try {
      GrinWalletVersion.foldIntoCard(services.grin_wallet, await GrinWalletVersion.detect(config.wallet_dir));
    } catch (e) { /* version probe failed — leave the wallet card as measured */ }

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
         FROM shares WHERE created_at > ? AND created_at <= ? GROUP BY region`
      ).all(now - 900, now);   // upper bound load-bearing — see /api/pool/topology
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
      // Optional map position of the gateway box (operator-typed, never resolved from an IP —
      // see the column comment in lib/db.js). Both blank → NULL/NULL and the network map falls
      // back to the country centroid; one blank, non-numeric, or out of range → 400, because a
      // half pair silently becomes "no pin" and NaN/Infinity would put the marker off the globe.
      // Number() not parseFloat(): parseFloat('12abc') is 12, and a typo must not save as a spot.
      // A body with NEITHER key (an API caller editing just the label) keeps the stored pin —
      // clearing is an explicit blank pair, never an omission. The panel always posts both.
      const _rawLat = req.body && req.body.lat, _rawLng = req.body && req.body.lng;
      const _blank = (v) => v == null || String(v).trim() === '';
      const keepPin = !(req.body && ('lat' in req.body || 'lng' in req.body));
      let lat = null, lng = null;
      if (!_blank(_rawLat) || !_blank(_rawLng)) {
        if (_blank(_rawLat) || _blank(_rawLng)) {
          return res.status(400).json({ error: 'lat and lng must be given together (or both left blank)' });
        }
        lat = Number(String(_rawLat).trim()); lng = Number(String(_rawLng).trim());
        if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
          return res.status(400).json({ error: 'lat must be a number in -90..90 and lng in -180..180 (decimal degrees, e.g. 34.05 / -118.24)' });
        }
        lat = Math.round(lat * 1e4) / 1e4; lng = Math.round(lng * 1e4) / 1e4;
      }
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
      const prevLoc = db.prepare('SELECT api_url, stratum_url, lat, lng FROM pool_locations WHERE region = ?').get(reg);
      const endpointChanged = _u(stratum_url) !== _u(prevLoc && prevLoc.stratum_url) ||
                              _u(api_url) !== _u(prevLoc && prevLoc.api_url);
      if (endpointChanged && stepUpRefused(req, res)) return;
      if (keepPin && prevLoc) { lat = prevLoc.lat; lng = prevLoc.lng; }

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
        INSERT INTO pool_locations (region, label, country, country_code, api_url, stratum_url, is_active, lat, lng, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
        ON CONFLICT(region) DO UPDATE SET
          label = excluded.label,
          country = excluded.country,
          country_code = excluded.country_code,
          api_url = excluded.api_url,
          stratum_url = excluded.stratum_url,
          is_active = excluded.is_active,
          lat = excluded.lat,
          lng = excluded.lng,
          updated_at = unixepoch()
      `).run(reg, label || null, country || null, cc, api_url || null, stratum_url || null, is_active, lat, lng);

      const row = db.prepare('SELECT * FROM pool_locations WHERE region = ?').get(reg);
      // The public map memoises /api/pool/topology for 30 s; an operator who just moved a
      // pin (or hid a region) and opens the map expects to see it, not the previous answer.
      caches.topology = { at: 0, body: null };
      db.prepare(`
        INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, details, ip)
        VALUES (?, 'location_upsert', 'pool_location', ?, ?, ?)
      `).run(req.user.user_id, reg, JSON.stringify({ label, country, country_code: cc, api_url, stratum_url, is_active, lat, lng }), req.ip);

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
      let bindDeferred = false;
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
            // Stratum is PAUSED (design §21.4): nothing was bound, and that is correct — the
            // port is already in config.region_ports above, which is what resume binds. "No
            // error" must not read as "listening", so say so.
            if (r && r.deferred) bindDeferred = true;
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
        stratum_bind_deferred: bindDeferred,
        stratum_bind_note: bindDeferred
          ? 'Region saved — stratum is paused, so its listener opens when stratum resumes.' : null,
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
      // Journal it: the audit row above is written only on success, so until this
      // line a failed enable left no trace on the box at all — and the browser's
      // copy of the message is one page reload from gone.
      console.error(`[gateways] init-server failed (${req.user && req.user.user_id ? 'admin ' + req.user.user_id : 'admin ?'}): ${e.message}`);
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
      caches.topology = { at: 0, body: null }; // same 30 s memo as the upsert above
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
  //
  // Live columns (status, workers, hashrate, last_share_at) come from lib/miner-status.js: the
  // in-memory sessions plus ONE windowed pass over the last hour of shares. The per-row
  // `shares_count` / `last_share_at` subqueries this replaced walked every retained share twice
  // per refresh (see RECENT_SQL there). So last_share_at is now null when the address has not
  // shared inside the hour. The page then falls back to last_seen_at, which the session code
  // stamps on connect and disconnect and which, unlike shares, is never pruned.
  // `shares_count` is gone: it counted whatever retention had left, so it fell at every prune.
  //
  // WHICH accounts (the list is capped at `limit`, max 1000):
  //   ?search=  substring of the address, by balance, with `offset` — the page's server-side
  //             lookup for an account the capped list does not hold.
  //   otherwise every account that MINED inside seen_s (biggest first), then admin-banned ones,
  //             then share-less sessions, then the rest by balance (minerStatus.listPriority says
  //             why share-less sessions go last). `offset` does not apply: a page offset into a
  //             priority list that re-orders every refresh would skip and repeat rows.
  // `total_accounts` / `mined_accounts` / `truncated` let the page say how much it is showing.
  app.get('/api/admin/miners', secureAdmin, (req, res) => {
    try {
      const ADMIN_MINER_COLS = `
        ma.grin_address, ma.balance, ma.balance_locked, ma.is_online, ma.is_banned, ma.ban_reason, ma.banned_at,
        ma.last_seen_at, ma.created_at,
        (SELECT COALESCE(SUM(amount),0) FROM withdrawals w WHERE w.grin_address = ma.grin_address AND w.status='confirmed') AS total_paid`;
      const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 1000);
      const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
      // One string, bounded, and LIKE's own wildcards escaped so `_` in a query matches a literal
      // underscore rather than any character.
      const q = typeof req.query.search === 'string' ? req.query.search.trim().slice(0, 100) : '';
      const search = q ? '%' + q.replace(/[\\%_]/g, (c) => '\\' + c) + '%' : null;

      const now = Math.floor(Date.now() / 1000);
      const live = minerStatus.liveRigs(minerManager ? minerManager.getActiveSessions() : []);
      const recent = minerStatus.recentShares(db, now);
      const { mined, connecting } = minerStatus.listPriority(live, recent);

      let rows;
      if (search) {
        rows = db.prepare(`SELECT ${ADMIN_MINER_COLS} FROM miner_accounts ma
                            WHERE ma.grin_address LIKE ? ESCAPE '\\'
                            ORDER BY ma.balance DESC LIMIT ? OFFSET ?`).all(search, limit, offset);
      } else {
        const banned = db.prepare('SELECT grin_address FROM miner_accounts WHERE is_banned = 1 ORDER BY balance DESC LIMIT ?')
          .all(limit).map((r) => r.grin_address);
        const want = [...new Set([...mined, ...banned, ...connecting])].slice(0, limit);
        const wantJson = JSON.stringify(want);
        const picked = want.length
          ? db.prepare(`SELECT ${ADMIN_MINER_COLS} FROM miner_accounts ma
                         WHERE ma.grin_address IN (SELECT value FROM json_each(?))`).all(wantJson)
          : [];
        const room = limit - picked.length;
        const rest = room > 0
          ? db.prepare(`SELECT ${ADMIN_MINER_COLS} FROM miner_accounts ma
                         WHERE ma.grin_address NOT IN (SELECT value FROM json_each(?))
                         ORDER BY ma.balance DESC LIMIT ?`).all(wantJson, room)
          : [];
        // Balance order for the page's default view; the priority only decided who is IN.
        rows = picked.concat(rest).sort((a, b) => (b.balance || 0) - (a.balance || 0));
      }

      const miners = rows.map((m) => ({
        ...m,
        ...minerStatus.summarize(live.get(m.grin_address), recent.get(m.grin_address), now)
      }));
      const total_accounts = db.prepare('SELECT COUNT(*) AS n FROM miner_accounts').get().n;

      res.json({
        success: true, count: miners.length, windows: minerStatus.WINDOWS,
        total_accounts, mined_accounts: mined.length,
        truncated: !search && total_accounts > miners.length,
        miners
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Explicit column list, NOT `SELECT *` (audit §J8-2). `miner_accounts` carries the
  // ownership-gate's `proof_salt` plus ten legacy proof columns, and the proof HASHES now
  // live in `miner_proofs`. None of that may reach a browser: the hashes exist so the DB
  // holds no readable mining IP and no readable rig password (§G, memory
  // `project_pool_ip_privacy`), and §C3's unrevocable admin access token puts anything an
  // admin page receives one stolen session away from an offline attack on the payout gate's
  // second factor. `...acct` below spreads whatever this SELECT names, so the SELECT is the
  // control — the same fix, and the same reason, as the 2026-07-28 pass on
  // /api/pool/payments and /api/pool/miners.
  // `pass_proof_state` IS included: it is a verdict string ('ok' / a reject code), already
  // public on /api/account/:addr, and it is what answers "why won't my password work?".
  app.get('/api/admin/miners/:addr', secureAdmin, (req, res) => {
    try {
      const { addr } = req.params;
      const acct = db.prepare(
        `SELECT id, grin_address, balance, balance_locked, is_online, last_seen_at, min_payout,
                pass_proof_state, is_banned, ban_reason, banned_at,
                nostr_username, nostr_npub, nostr_registered_at,
                nostr_prev_username, nostr_prev_npub,
                created_at, updated_at
           FROM miner_accounts WHERE grin_address = ?`
      ).get(addr);
      if (!acct) return res.status(404).json({ error: 'miner not found' });

      // Support view of the proof set (design §17.2 #7): COUNTS AND TIMESTAMPS ONLY, per kind.
      // Enough to answer "does this miner have any proof on record, and how old is it?" —
      // which is the question a support ticket asks — without handing the panel a digest to
      // grind or a per-row capture time to correlate. `anchor_live` distinguishes an anchor
      // that is still an ordinary set member from one that has been evicted (and so is
      // refused by the destination gate, §J3-4), because that is the difference between a
      // miner who can change their payout destination and one who cannot.
      const proofSets = {};
      for (const kind of ['ip', 'pass']) {
        const agg = db.prepare(
          `SELECT SUM(CASE WHEN evicted_at IS NULL THEN 1 ELSE 0 END) AS live,
                  MIN(first_seen_at) AS oldest_first_seen,
                  MAX(CASE WHEN evicted_at IS NULL THEN last_seen_at END) AS newest_last_seen,
                  MAX(CASE WHEN is_anchor = 1 AND evicted_at IS NULL THEN 1 ELSE 0 END) AS anchor_live
             FROM miner_proofs WHERE grin_address = ? AND kind = ?`
        ).get(addr, kind) || {};
        proofSets[kind] = {
          live: agg.live || 0,
          oldest_first_seen: agg.oldest_first_seen === undefined ? null : agg.oldest_first_seen,
          newest_last_seen: agg.newest_last_seen === undefined ? null : agg.newest_last_seen,
          anchor_live: !!agg.anchor_live
        };
      }

      const total_paid = db.prepare(
        `SELECT COALESCE(SUM(amount),0) AS t FROM withdrawals WHERE grin_address = ? AND status='confirmed'`
      ).get(addr).t;
      // Same strip as GET /api/admin/withdrawals: never serve an old row's stepwise final slate
      // (the column is inert since 2026-09-26), nor the manual rail's stored S1.
      const pending = db.prepare(
        `SELECT * FROM withdrawals WHERE grin_address = ? AND status IN ('tor_checking','tor_sending','tor_held','retry_scheduled','slatepack_pending','finalizing') ORDER BY created_at DESC`
      ).all(addr).map(({ tor_final_slate, slatepack_s1, ...rest }) => rest);
      // The Tor pause as the miner sees it; the operator clears it with the route below.
      const tor_pause = withdrawalScheduler ? withdrawalScheduler.torPauseStatus(addr) : null;
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
          tor_pause,
          proofs: { max: PROOF_SET_MAX, ip: proofSets.ip, pass: proofSets.pass },
          incentives
        }
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Per-rig rows for the expanded view on miners.html. Same data as the public
  // /api/account/:addr/workers (getWorkersForAccount), taken over the seen_s window so a rig that
  // dropped inside it is still listed as `offline`, plus a ten-minute hashrate, the region(s) each
  // live rig is connected through and when that session started. Nothing here the account page
  // does not already publish, apart from the region, and no rig IP or password: those stay
  // hashes in miner_proofs (memory project_pool_ip_privacy). Status rules live in
  // lib/miner-status.js, the same place the list's status dot comes from.
  app.get('/api/admin/miners/:addr/workers', secureAdmin, (req, res) => {
    try {
      const { addr } = req.params;
      const known = db.prepare('SELECT 1 AS x FROM miner_accounts WHERE grin_address = ?').get(addr);
      if (!known) return res.status(404).json({ error: 'miner not found' });
      const W = minerStatus.WINDOWS;
      // ONE call for both windows (the short one is a subset of the long one): the page re-polls
      // this route for each open row, so it reads the address's last hour of shares once, not twice.
      const hour = hashrateTracker.getWorkersForAccount(addr, W.seen_s / 60, W.hashrate_s / 60);
      const live = minerStatus.liveRigs(minerManager ? minerManager.getSessionsByMiner(addr) : []).get(addr);
      // A donateN tag moves nothing while the operator has donations off, so it reads null
      // then, the same rule as the public worker readout.
      let donationsOn = false;
      try { donationsOn = !!(incentivesManager && incentivesManager.donationsActive()); } catch (_) { donationsOn = false; }
      const donateOf = (name) => {
        const t = donationsOn ? parseDonateToken(name) : null;
        return t ? t.percent : null;
      };
      const now = Math.floor(Date.now() / 1000);
      res.json({
        success: true,
        grin_address: addr,
        windows: W,
        workers: minerStatus.workerRows({ hour, live, now, donateOf })
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

  // Clear an address's Tor pause — for a pause the operator judges was the pool's fault. The
  // counted failures are re-coded wallet_offline_cleared (the counter skips them); no history is
  // deleted. Step-up, like ban/unban: it re-opens a payout rail for someone.
  app.post('/api/admin/miners/:addr/tor-pause/clear', freshAdmin, (req, res) => {
    try {
      const addr = String(req.params.addr || '').trim();
      if (!addr) return res.status(400).json({ error: 'address required' });
      if (!withdrawalScheduler) return res.status(503).json({ error: 'withdrawal scheduler not running' });
      const known = db.prepare('SELECT 1 AS x FROM miner_accounts WHERE grin_address = ?').get(addr);
      if (!known) return res.status(404).json({ error: 'miner not found' });
      const before = withdrawalScheduler.torPauseStatus(addr);
      const cleared = withdrawalScheduler.clearTorPause(addr, { adminId: req.user.user_id });
      const after = withdrawalScheduler.torPauseStatus(addr);
      db.prepare(`
        INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, details, ip)
        VALUES (?, 'miner_tor_pause_clear', 'miner_account', ?, ?, ?)
      `).run(req.user.user_id, addr, JSON.stringify({ cleared, before }), req.ip);
      res.json({ success: true, grin_address: addr, cleared, tor_pause: after });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── DONORS (Admin only) — design §18.6 (§18 Part 3, 2026-09-24) ─────────────────────────
  // The operator's review surface for donor profiles. Every donor nickname and banner is
  // PRE-moderated: a submission is a pending donor_requests row (lib/donor-profiles.js) that
  // nothing public reads until an approve here. FULL addresses on purpose — this is the admin
  // side (the public wall masks, §J11-1).
  //
  // Tiers: secureAdmin reads, freshAdmin (step-up) writes — a decision puts words or an image on
  // a public page in someone's name, the same tier as ban/unban. Every write's state change and
  // its admin_audit_log row are ONE transaction inside the lib (fail-closed: no decision lands
  // without its audit row), so these routes only validate input and map result codes to status.
  //
  // v1's censor/uncensor routes and the rescan-on-settings-save hook were REMOVED in this part
  // (§18.6): with pre-moderation there is nothing published to censor after the fact.
  const DONOR_ADMIN_CODES = {
    bad_id:        [400, 'Not a valid request id'],
    bad_status:    [400, `status must be one of ${DonorProfiles.STATUSES.join(', ')}`],
    bad_kind:      [400, 'kind must be "name" or "banner"'],
    not_found:     [404, 'No such request (for an image: no such banner request)'],
    no_image:      [404, 'This request has no image bytes (only a pending or approved banner does)'],
    not_pending:   [409, 'This request has already been decided — reload the queue'],
    blocked:       [409, 'This address is blocked from donor profiles — unblock it first'],
    conflict:      [409, 'Another decision on this donor landed at the same moment — reload and try again'],
    invalid_image: [422, 'The stored image no longer passes the banner rules'],
    write_failed:  [500, 'The banner file could not be written — check the uploads directory'],
    nothing_live:  [404, 'There is no live item of that kind to remove'],
    already:       [409, 'This address is already blocked'],
    not_blocked:   [409, 'This address is not blocked'],
    // Part C4 — donor names
    bad_state:      [400, 'state must be "live" or "removed"'],
    bad_name:       [400, 'Give a name that folds to 1–32 letters and digits (spaces and - _ . & \' are ignored)'],
    already_banned: [409, 'That name (in some spelling) is already banned'],
    not_banned:     [404, 'That name is not on the ban list'],
  };
  const donorAdminRefuse = (res, r) => {
    const [status, text] = DONOR_ADMIN_CODES[r.code] || [400, 'Refused'];
    return res.status(status).json({ error: r.error || text, reason: r.code || 'refused' });
  };
  const donorAdminSettings = () =>
    donorSettings(poolSettings.getSection('incentives'), poolSettings.getSection('pool_info').pool_name);

  // The donor ledger once, with the §16.6 numbers the wall ranks by (same helpers, same order):
  // Map<address, ledger row + multiplier + score + rank>. rank is null with nothing in the window.
  // Not capped at the wall's 100 — the operator sees #150 even though the wall does not.
  const donorLedgerRanked = (ds, now, H) => {
    const rows = donorLedger(db, { H, windowDays: ds.rankWindowDays, now });
    for (const r of rows) {
      r.multiplier = donorLoyaltyMultiplier(r.active_months, ds);
      r.score = donorScore(r.in_window_donated, r.active_months, ds);
      r.rank = null;
    }
    let rank = 0;
    for (const r of rows.filter((x) => x.in_window_donated > 0).sort(donorLeagueOrder)) r.rank = ++rank;
    return new Map(rows.map((r) => [r.address, r]));
  };

  // The donors list. One row per address that has EVER donated (a ledger debit), has a LIVE tag
  // (a tagged rig mining now, liveDonations(), §18.3 — counted only while donations are on), or
  // has a profile on file (an approved or pending request, or a block). The third set keeps a
  // blocked or approved address visible so it can be unblocked or taken down.
  //
  // Cost: the ONE composite ledger scan /api/pool/donors already does, one read of the small
  // donor_requests/donor_blocks tables, and per returned row (cap 500, like /api/admin/miners)
  // getWorkersForAccount over the 24 h window — an indexed (grin_address) lookup on a table
  // pruned to ~31 h. It never walks shares per donor beyond that window.
  app.get('/api/admin/donors', secureAdmin, (req, res) => {
    try {
      const now = Math.floor(Date.now() / 1000);
      const H = getLedgerRollupHorizon(db);
      const ds = donorAdminSettings();
      let active = false;
      try { active = !!(incentivesManager && incentivesManager.donationsActive()); } catch (_) { active = false; }

      const ledgerByAddr = donorLedgerRanked(ds, now, H);
      const live = donorLiveDonations(minerManager ? minerManager.getActiveSessions() : []);
      const liveTagged = active ? [...live].filter(([, v]) => v.rigs_donating > 0).map(([a]) => a) : [];
      const profiles = DonorProfiles.adminProfiles(db, {
        ds, now, lastDonatedAt: (a) => (ledgerByAddr.get(a) || {}).last_donated_at || null
      });

      const addrs = new Set([...ledgerByAddr.keys(), ...liveTagged, ...profiles.keys()]);
      const rows = [];
      for (const address of addrs) {
        const l = ledgerByAddr.get(address) || {};
        const p = profiles.get(address) || { name: null, banner: null, pending: { name: false, banner: false }, blocked: null };
        const lv = live.get(address) || DONOR_NO_LIVE;
        const donating = active ? lv.rigs_donating : 0;
        rows.push({
          address,
          // The LIVE (approved) profile, with the same expiry state the donor and the wall see.
          name: p.name,
          banner: p.banner,
          pending: p.pending,
          blocked: p.blocked,
          // Same readings + gate as the wall and the account page (design §18.3).
          rigs_online: lv.rigs_online,
          rigs_donating: donating,
          pct_min: donating ? lv.pct_min : 0,
          pct_max: donating ? lv.pct_max : 0,
          lifetime_donated: l.total_donated || 0,
          in_window_donated: l.in_window_donated || 0,
          active_months: l.active_months || 0,
          first_donated_at: l.first_donated_at || null,
          last_donated_at: l.last_donated_at || null,
          donation_count: l.donation_count || 0,
          multiplier: l.multiplier || donorLoyaltyMultiplier(0, ds),
          score: l.score || 0,
          rank: l.rank || null,
          workers: []
        });
      }
      rows.sort(donorLeagueOrder);

      const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 500, 1), 500);
      const page = rows.slice(0, limit);
      for (const r of page) {
        // 24 h window: name, live flag, and the rig's tag (null = untagged) — same grammar as
        // the login and the per-share money path (parseDonateToken).
        let ws = [];
        try { ws = hashrateTracker.getWorkersForAccount(r.address, 1440) || []; } catch (_) { ws = []; }
        r.workers = ws.map((w) => {
          const t = parseDonateToken(w.worker_name);
          return { name: w.worker_name, online: !!w.online, donate_percent: t ? t.percent : null };
        });
      }

      res.json({
        success: true,
        count: rows.length,
        donors: page,
        window_days: ds.rankWindowDays,
        banner_slots: ds.bannerSlots,
        donations_active: active,
        pending_requests: DonorProfiles.pendingCount(db),
        now
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // The nav badge on every admin page reads this instead of /api/admin/dashboard: one COUNT on
  // a partial-indexed status versus the dashboard's dozen queries, per page load.
  app.get('/api/admin/donors/summary', secureAdmin, (req, res) => {
    try {
      res.json({ success: true, pending_requests: DonorProfiles.pendingCount(db) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // The review queue (§18.6). ?status= is a closed enum (default pending — oldest first);
  // the decided statuses are the history. ?kind= (name | banner, optional) narrows it: since
  // Part C4 names are auto-checked, so the admin page asks for banners. Each row carries the
  // address's current approved item of that kind and the donor's league rank + lifetime so the
  // reviewer knows who is asking. Never the bytes.
  app.get('/api/admin/donors/requests', secureAdmin, (req, res) => {
    try {
      const ds = donorAdminSettings();
      const limit = parseInt(req.query.limit, 10);
      const q = DonorProfiles.adminQueue(db, {
        status: req.query.status, kind: req.query.kind, limit: Number.isSafeInteger(limit) ? limit : undefined
      });
      if (!q.ok) return donorAdminRefuse(res, q);
      const ledgerByAddr = donorLedgerRanked(ds, Math.floor(Date.now() / 1000), getLedgerRollupHorizon(db));
      for (const r of q.rows) {
        const l = ledgerByAddr.get(r.address) || {};
        r.rank = l.rank || null;
        r.lifetime_donated = l.total_donated || 0;
        r.last_donated_at = l.last_donated_at || null;
      }
      res.json({ success: true, status: q.status, total: q.total, requests: q.rows, banner_slots: ds.bannerSlots });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // The bytes behind one banner request (pending blob or approved file) for the queue's
  // preview. The admin page points a plain same-origin <img src> here (the httpOnly SameSite=strict
  // session cookie rides along), so these headers govern every way the image is viewed —
  // including "open image in new tab". Served as the STORED sniffed mime, never
  // sniffed by the browser, and sandboxed with no sub-resources, so a polyglot renders as an
  // image or not at all — never as a document on the admin origin.
  app.get('/api/admin/donors/requests/:id/image', secureAdmin, (req, res) => {
    try {
      const r = DonorProfiles.requestImage(db, req.params.id, { uploadsDir });
      if (!r.ok) return donorAdminRefuse(res, r);
      res.setHeader('Content-Type', r.mime);
      res.setHeader('Content-Length', String(r.bytes.length));
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
      res.setHeader('Cache-Control', 'no-store');
      res.status(200).end(r.bytes);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // A banner decision needs the uploads directory (approve writes the file; removing a live one
  // deletes it). The lib throws without it, so say it here as a clean 503 instead.
  const donorRequestKind = (id) => {
    const n = /^[0-9]{1,15}$/.test(String(id)) ? parseInt(id, 10) : NaN;
    const row = Number.isSafeInteger(n) ? db.prepare('SELECT kind FROM donor_requests WHERE id = ?').get(n) : null;
    return row ? row.kind : null;
  };
  const NO_UPLOADS = { error: 'The uploads directory is not configured on this pool, so a banner cannot be published or removed.' };

  app.post('/api/admin/donors/requests/:id/approve', freshAdmin, (req, res) => {
    try {
      if (!uploadsDir && donorRequestKind(req.params.id) === 'banner') return res.status(503).json(NO_UPLOADS);
      const r = DonorProfiles.approve(db, req.params.id, { adminId: req.user.user_id, ip: req.ip, uploadsDir: uploadsDir || undefined });
      if (!r.ok) return donorAdminRefuse(res, r);
      if (r.warning) console.warn(`[donor-profile] approve #${r.id}: ${r.warning}`);
      res.json({ success: true, id: r.id, kind: r.kind, grin_address: r.address, status: 'approved',
                 url: r.file ? DonorProfiles.publicUrl(r.file) : null, replaced_id: r.replaced_id, warning: r.warning || null });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // The reason is SHOWN to the donor on their account page, which anyone holding the address can
  // open (the admin page says so beside the field). Optional; one line, ≤ 200 chars (cleanReason).
  app.post('/api/admin/donors/requests/:id/reject', freshAdmin, (req, res) => {
    try {
      const r = DonorProfiles.reject(db, req.params.id, { adminId: req.user.user_id, ip: req.ip, reason: (req.body || {}).reason });
      if (!r.ok) return donorAdminRefuse(res, r);
      res.json({ success: true, id: r.id, kind: r.kind, grin_address: r.address, status: 'rejected' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Take a LIVE (approved) name or banner down. :addr through the one gate the account family
  // uses (GRIN_ADDR_RE, §J3-8) — the prize_pool/pool_fee pseudo-accounts are not reachable.
  app.post('/api/admin/donors/:addr/remove', freshAdmin, (req, res) => {
    try {
      const addr = String(req.params.addr || '').trim();
      if (!GRIN_ADDR_RE.test(addr)) return res.status(400).json({ error: 'Not a well-formed Grin address' });
      const body = req.body || {};
      const kind = body.kind;
      if (!DonorProfiles.KINDS.includes(kind)) return donorAdminRefuse(res, { code: 'bad_kind' });
      if (kind === 'banner' && !uploadsDir) return res.status(503).json(NO_UPLOADS);
      const r = DonorProfiles.removeLive(db, addr, kind, { adminId: req.user.user_id, ip: req.ip, reason: body.reason, uploadsDir: uploadsDir || undefined });
      if (!r.ok) return donorAdminRefuse(res, r);
      if (r.warning) console.warn(`[donor-profile] remove ${addr.slice(0, 9)}… ${kind}: ${r.warning}`);
      res.json({ success: true, grin_address: addr, kind, status: 'removed', id: r.id, warning: r.warning || null });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Bar an address from SUBMITTING (its live name/banner stays until removed separately);
  // blocking withdraws its pending requests in the same transaction, so the queue never shows a
  // blocked address's work. The miner routes refuse a blocked address with 403 `blocked`.
  app.post('/api/admin/donors/:addr/block', freshAdmin, (req, res) => {
    try {
      const addr = String(req.params.addr || '').trim();
      if (!GRIN_ADDR_RE.test(addr)) return res.status(400).json({ error: 'Not a well-formed Grin address' });
      const r = DonorProfiles.block(db, addr, { adminId: req.user.user_id, ip: req.ip, reason: (req.body || {}).reason });
      if (!r.ok) {
        if (r.code === 'not_found') return res.status(404).json({ error: 'This address has never mined here', reason: 'not_found' });
        return donorAdminRefuse(res, r);
      }
      res.json({ success: true, grin_address: addr, blocked: true, withdrawn: r.withdrawn });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/admin/donors/:addr/unblock', freshAdmin, (req, res) => {
    try {
      const addr = String(req.params.addr || '').trim();
      if (!GRIN_ADDR_RE.test(addr)) return res.status(400).json({ error: 'Not a well-formed Grin address' });
      const r = DonorProfiles.unblock(db, addr, { adminId: req.user.user_id, ip: req.ip });
      if (!r.ok) return donorAdminRefuse(res, r);
      res.json({ success: true, grin_address: addr, blocked: false });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── Donor NAMES (design §19.17.6, Part C4) ─────────────────────────────────────────────────
  // Names are checked automatically and live at once, so the operator's surface is a LIST with
  // post-moderation, not a queue: remove (POST /api/admin/donors/:addr/remove {kind:'name'},
  // above), ban a name (every spelling, every holder), block a donor (above). Same tiers as the
  // rest of the donor admin: secureAdmin reads, freshAdmin (step-up) writes, each write's audit
  // row inside its transaction in the lib.

  // ?state=live (default) | removed, ?q= an address start or a name fragment (matched on the
  // matching form, so `sh1t` finds "Shit"). Live rows carry `hit` — what the rule says TODAY, so
  // a word added after a name went live shows as a hint — `banned`, `same_as` (pre-C4 approved
  // names may collide) and `blocked`.
  app.get('/api/admin/donors/names', secureAdmin, (req, res) => {
    try {
      const r = DonorProfiles.adminNames(db, {
        state: req.query.state, q: typeof req.query.q === 'string' ? req.query.q : '', rule: donorNameRule()
      });
      if (!r.ok) return donorAdminRefuse(res, r);
      res.json({ success: true, state: r.state, total: r.total, names: r.rows, change_days: DonorProfiles.NAME_CHANGE_DAYS });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/admin/donors/banned-names', secureAdmin, (req, res) => {
    try {
      res.json({ success: true, banned: DonorProfiles.bannedNames(db) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Ban a name: its matching form goes on the list (no spelling of it can be set again) and every
  // live holder loses it now — the reason is shown to them, as for a remove.
  app.post('/api/admin/donors/banned-names', freshAdmin, (req, res) => {
    try {
      const body = req.body || {};
      if (typeof body.name !== 'string') return donorAdminRefuse(res, { code: 'bad_name' });
      const r = DonorProfiles.banName(db, body.name, { adminId: req.user.user_id, ip: req.ip, reason: body.reason });
      if (!r.ok) return donorAdminRefuse(res, r);
      res.json({ success: true, norm: r.norm, removed: r.removed.length });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Lift a ban. Nothing comes back: a removed name stays removed.
  app.post('/api/admin/donors/banned-names/:norm/unban', freshAdmin, (req, res) => {
    try {
      const r = DonorProfiles.unbanName(db, req.params.norm, { adminId: req.user.user_id, ip: req.ip });
      if (!r.ok) return donorAdminRefuse(res, r);
      res.json({ success: true, norm: r.norm });
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
  //   games       turns a public feature and a public CHAT on for the live pool (design §19.11:
  //               every games-settings write is step-up)
  //   names       the blocked-word list every public name is checked against (design §19.17.5):
  //               emptying it is how a stolen session would let offensive names go live unseen
  const STEP_UP_SETTINGS_SECTIONS = new Set(['payout', 'access', 'incentives', 'database', 'games', 'names']);

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
    // 'custom_head_html' / 'custom_body_html' (raw HTML whose <script> nodes branding.js
    // re-created so they ran) were gated here until 2026-10-03. They are not merely un-gated:
    // the keys are DELETED (design §19.17 D22, Option B) and updateSection() refuses a write
    // to either, so there is nothing left for step-up to protect.
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
      // (The donor-name rescan that ran here on a changed word list was removed in design §18
      // Part 3: names are pre-moderated, so the list only flags queued names at read time.)
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
};
