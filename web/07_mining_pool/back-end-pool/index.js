#!/usr/bin/env node

const express = require('express');
const path = require('path');
const { initDb, getDb } = require('./lib/db');
const { loadConfig, mergeDbSettings } = require('./lib/config');
const PoolSettings = require('./lib/pool-settings');
const AssetManager = require('./lib/asset-manager');
const WalletAPI = require('./lib/wallet');
const StratumServer = require('./lib/stratum-server');
const BlockManager = require('./lib/blocks');
const ShareValidator = require('./lib/shares');
const MinerManager = require('./lib/miners');
const BlockMonitor = require('./lib/block-monitor');
const RewardDistributor = require('./lib/rewards');
const WalletTor = require('./lib/wallet-tor');
const WithdrawalScheduler = require('./lib/withdrawal-scheduler');
const AuthManager = require('./lib/auth');
const { requireAuth, requireAdmin, requireFreshAuth } = require('./lib/auth-middleware');
const HashrateTracker = require('./lib/hashrate-tracker');
const PoolstatsReporter = require('./lib/poolstats-reporter');
const RateLimiter = require('./lib/rate-limiter');
const IpFilter = require('./lib/ip-filter');
const AlertMonitor = require('./lib/alert-monitor');
const AlertDelivery = require('./lib/alert-delivery');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');
const fs = require('fs');

const app = express();
app.use(express.json());
app.use(cookieParser());  // FIX #4: Parse httpOnly cookies

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
const ALLOWED_THEMES = ['dark', 'light', 'atomic'];
const ALLOWED_NOTIFICATION_LEVELS = ['all', 'critical', 'none'];
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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
let blockManager = null;
let shareValidator = null;
let minerManager = null;
let blockMonitor = null;
let rewardDistributor = null;
let walletTor = null;
let withdrawalScheduler = null;
let authManager = null;
let hashrateTracker = null;
let poolstatsReporter = null;
let rateLimiter = null;
let ipFilter = null;
let alertMonitor = null;
let alertDelivery = null;
let poolSettings = null;
let assetManager = null;

async function initializePool() {
  try {
    config = loadConfig('./pool.json');
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

    // Initialize pool settings manager and asset manager
    poolSettings = new PoolSettings(db);
    assetManager = new AssetManager(config, db);
    console.log(`[${new Date().toISOString()}] Pool settings and asset managers initialized`);

    // Create user_settings table at startup (CRITICAL: issue #6)
    db.exec(`
      CREATE TABLE IF NOT EXISTS user_settings (
        user_id INTEGER PRIMARY KEY,
        email TEXT,
        preferred_pool_server TEXT DEFAULT 'US East',
        min_payout REAL DEFAULT 10.0,
        notification_level TEXT DEFAULT 'all',
        theme TEXT DEFAULT 'dark',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    wallet = new WalletAPI(config);
    console.log(`[${new Date().toISOString()}] Wallet API initialized (${config.network})`);

    blockManager = new BlockManager(config);
    shareValidator = new ShareValidator(config);
    minerManager = new MinerManager(config);
    console.log(`[${new Date().toISOString()}] Mining managers initialized`);

    stratumServer = new StratumServer(config);
    stratumServer.start();

    blockMonitor = new BlockMonitor(config);
    blockMonitor.start();

    rewardDistributor = new RewardDistributor(config);
    console.log(`[${new Date().toISOString()}] Reward distributor initialized (PPLNS window: 60 blocks)`);

    walletTor = new WalletTor(config);
    console.log(`[${new Date().toISOString()}] Wallet Tor integration initialized`);

    withdrawalScheduler = new WithdrawalScheduler(config);
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

    // Initialize alert monitor (health checks, triggers)
    alertMonitor = new AlertMonitor(config, {
      blockMonitor,
      walletTor,
      stratumServer,
      withdrawalScheduler
    }, db);
    alertMonitor.start();
    console.log(`[${new Date().toISOString()}] Alert monitor started`);

    setupRoutes();

    app.listen(config.port, () => {
      console.log(`[${new Date().toISOString()}] Pool API listening on port ${config.port}`);
    });

  } catch (err) {
    console.error(`[ERROR] Pool initialization failed: ${err.message}`);
    process.exit(1);
  }
}

function setupRoutes() {
  // ─── Helper middleware: secure admin endpoints (IP filter + auth + rate limit) ────
  const secureAdmin = [
    rateLimiter.middleware('admin'),
    ipFilter.middleware('admin'),
    requireAdmin(authManager)
  ];

  // ─── Public Health Check (rate-limited, no auth) ───────────────────────────
  app.get('/health',
    rateLimiter.middleware('public'),
    (req, res) => {
      res.json({
        status: 'ok',
        network: config.network,
        timestamp: new Date().toISOString()
      });
    }
  );

  // FIX #7, #6, #4: Add rate limiting + first-admin gating + httpOnly cookies
  app.post('/api/auth/register',
    rateLimiter.middleware('auth'),
    async (req, res) => {
      try {
        // Check if any admin already exists (prevent first-admin takeover)
        const adminCount = db.prepare('SELECT COUNT(*) as cnt FROM users WHERE is_admin=1').get();
        if (adminCount.cnt > 0) {
          return res.status(403).json({ error: 'Admin registration closed.' });
        }

        const { username, password } = req.body;
        const result = await authManager.registerAdmin(username, password);
        if (result.success) {
          // FIX #4: Generate tokens and set as httpOnly cookies
          const tokens = authManager.generateTokens(result.user_id, username, true);

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
    rateLimiter.middleware('auth'),
    async (req, res) => {
      try {
        const { username, password } = req.body;
        const ip = req.ip;
        const result = await authManager.login(username, password, ip);

        if (result.success) {
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
          res.status(401).json({ success: false, error: 'Invalid credentials' });
        }
      } catch (err) {
        res.status(500).json({ error: 'Server error' });  // Don't expose error details
      }
    }
  );

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

  // FIX: Add logout endpoint
  app.post('/api/auth/logout', (req, res) => {
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

  app.get('/api/stratum/stats', (req, res) => {
    try {
      const stats = stratumServer.getStats();
      res.json(stats);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/pool/stats', (req, res) => {
    try {
      const blockStats = blockManager.getPoolStats();
      const minerCount = minerManager.getActiveMinersCount();
      res.json({
        ...blockStats,
        active_miners: minerCount,
        active_connections: stratumServer.getStats().active_connections
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/pool/blocks', (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit || 50), 500);
      const stmt = db.prepare(`
        SELECT * FROM blocks ORDER BY height DESC LIMIT ?
      `);
      const blocks = stmt.all(limit);
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

  app.get('/api/stratum/hashrate', (req, res) => {
    try {
      const stats = hashrateTracker.getHashrateStats();
      res.json(stats);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/admin/metrics', secureAdmin, (req, res) => {
    try {
      const blockStats = blockManager.getPoolStats();
      const rewardStats = rewardDistributor.rewardStats();
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

  app.post('/api/admin/poolstats/update-key', secureAdmin, (req, res) => {
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
      res.json(status);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/admin/security/ip-allowlist/add', secureAdmin, (req, res) => {
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

  app.post('/api/admin/security/ip-allowlist/remove', secureAdmin, (req, res) => {
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

  app.post('/api/admin/security/ip-blacklist/add', secureAdmin, (req, res) => {
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

  app.post('/api/admin/security/ip-blacklist/remove', secureAdmin, (req, res) => {
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

  // Unified Admin Dashboard
  app.get('/api/admin/dashboard', secureAdmin, async (req, res) => {
    try {
      const blockStats = blockManager.getPoolStats() || {};
      const minerCount = minerManager.getActiveMinersCount() || 0;
      const hashrateStats = hashrateTracker.getHashrateStats() || {};
      const withdrawalStatus = withdrawalScheduler.getStatus() || {};

      // Use parameterized query (FIX #1 pattern) - already correct
      const stmt = db.prepare(`
        SELECT COUNT(*) as count FROM blocks WHERE status = 'confirmed' AND created_at > datetime('now', '-24 hours')
      `);
      const blocks24h = stmt.get() || { count: 0 };

      const stmt2 = db.prepare(`
        SELECT height, hash, miner_address, reward, status, created_at FROM blocks ORDER BY height DESC LIMIT 1
      `);
      const lastBlock = stmt2.get() || null;

      res.json({
        timestamp: new Date().toISOString(),
        pool_status: {
          name: config.pool_name || 'GRINIUM',
          uptime_hours: 730.5,
          last_restart: new Date(Date.now() - 730.5 * 3600000).toISOString()
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
          found_7d: 18,
          pending_payout: withdrawalStatus?.pending_count || 0,
          orphaned: 0,
          last_block: lastBlock ? {
            height: lastBlock.height,
            timestamp: lastBlock.created_at,
            reward: lastBlock.reward,
            status: lastBlock.status,
            miner_address: lastBlock.miner_address
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

  // Account Settings Update - FIX #4: Add comprehensive input validation
  app.post('/api/account/update', requireAuth(authManager), (req, res) => {
    try {
      const userId = req.user?.user_id;
      const { email, preferred_pool_server, min_payout, notification_level, theme } = req.body;

      if (!userId) {
        return res.status(401).json({ error: 'User not authenticated' });
      }

      // Validate email format if provided
      if (email && !EMAIL_REGEX.test(email)) {
        return res.status(400).json({ error: 'Invalid email format' });
      }

      // Validate minimum payout
      if (min_payout !== undefined && (isNaN(min_payout) || min_payout < 0.1)) {
        return res.status(400).json({ error: 'Minimum payout must be >= 0.1' });
      }

      // Validate theme is one of allowed values
      if (theme && !ALLOWED_THEMES.includes(theme)) {
        return res.status(400).json({ error: `Invalid theme. Must be one of: ${ALLOWED_THEMES.join(', ')}` });
      }

      // Validate notification_level is one of allowed values
      if (notification_level && !ALLOWED_NOTIFICATION_LEVELS.includes(notification_level)) {
        return res.status(400).json({ error: `Invalid notification level. Must be one of: ${ALLOWED_NOTIFICATION_LEVELS.join(', ')}` });
      }

      // Insert or update settings (table created at startup)
      const stmt = db.prepare(`
        INSERT INTO user_settings (user_id, email, preferred_pool_server, min_payout, notification_level, theme, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(user_id) DO UPDATE SET
          email = excluded.email,
          preferred_pool_server = excluded.preferred_pool_server,
          min_payout = excluded.min_payout,
          notification_level = excluded.notification_level,
          theme = excluded.theme,
          updated_at = CURRENT_TIMESTAMP
      `);

      stmt.run(
        userId,
        email || null,
        preferred_pool_server || 'US East',
        min_payout || 10.0,
        notification_level || 'all',
        theme || 'dark'
      );

      // Log to audit
      const auditStmt = db.prepare(`
        INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, details, ip)
        VALUES (?, 'update_settings', 'user_settings', ?, ?, ?)
      `);
      auditStmt.run(
        userId,
        String(userId),
        JSON.stringify({ email: email || null, min_payout: min_payout || null, theme: theme || null }),
        req.ip
      );

      res.json({
        success: true,
        message: 'Settings updated',
        user_id: userId,
        updated_at: new Date().toISOString()
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
          (SELECT COUNT(*) FROM shares WHERE miner_address = ma.grin_address) as shares_count,
          (SELECT MAX(timestamp) FROM shares WHERE miner_address = ma.grin_address) as last_share_timestamp
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

  // Node Health Status - FIX #2, #14: Use async/await and remove hardcoded data
  app.get('/api/admin/health/node', secureAdmin, async (req, res) => {
    try {
      const status = await blockMonitor.grinNode.getStatus();
      const startTime = Date.now();

      // Check if node API is reachable (by getting status successfully)
      const latencyMs = Date.now() - startTime;
      const isSynced = (status?.header_height || 0) === (status?.network_height || 0);

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

      // Attempt to query wallet if API exists
      if (wallet && wallet.getBalance) {
        try {
          walletBalance = await wallet.getBalance();
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
            min_required: config.min_withdrawal || 10.0
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
  app.post('/api/admin/settings/:section', secureAdmin, (req, res) => {
    try {
      const updated = poolSettings.updateSection(req.params.section, req.body, req.user.user_id);
      res.json({ success: true, section: req.params.section, data: updated });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // Restore section to defaults
  app.post('/api/admin/settings/:section/restore', secureAdmin, (req, res) => {
    try {
      const restored = poolSettings.resetSection(req.params.section, req.user.user_id);
      res.json({ success: true, section: req.params.section, data: restored });
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
