#!/usr/bin/env node

const express = require('express');
const path = require('path');
const { initDb, getDb } = require('./lib/db');
const { loadConfig } = require('./lib/config');
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

const app = express();
app.use(express.json());

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

async function initializePool() {
  try {
    config = loadConfig('./pool.json');
    console.log(`[${new Date().toISOString()}] Loading pool configuration...`);
    console.log(`  Network: ${config.network}`);
    console.log(`  API port: ${config.port}`);
    console.log(`  Stratum port: ${config.stratum_port}`);

    db = initDb(config.db_path);
    console.log(`[${new Date().toISOString()}] Database initialized at ${config.db_path}`);

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
  app.get('/health', (req, res) => {
    res.json({
      status: 'ok',
      network: config.network,
      timestamp: new Date().toISOString()
    });
  });

  app.post('/api/auth/register', (req, res) => {
    const { username, password } = req.body;
    authManager.registerAdmin(username, password)
      .then(result => {
        if (result.success) {
          res.json(result);
        } else {
          res.status(400).json(result);
        }
      });
  });

  app.post('/api/auth/login', (req, res) => {
    const { username, password } = req.body;
    const ip = req.ip;
    authManager.login(username, password, ip)
      .then(result => {
        if (result.success) {
          res.json(result);
        } else {
          res.status(401).json(result);
        }
      });
  });

  app.post('/api/auth/refresh', (req, res) => {
    const { refresh_token } = req.body;
    const result = authManager.refreshAccessToken(refresh_token);
    if (result.success) {
      res.json(result);
    } else {
      res.status(401).json(result);
    }
  });

  app.post('/api/auth/change-password', requireAuth(authManager), (req, res) => {
    const { old_password, new_password } = req.body;
    authManager.changePassword(req.user.user_id, old_password, new_password)
      .then(result => {
        if (result.success) {
          res.json(result);
        } else {
          res.status(400).json(result);
        }
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

  app.post('/api/test/add-miner', (req, res) => {
    try {
      const { grin_address } = req.body;

      if (!wallet.validateGrinAddress(grin_address, config.network)) {
        return res.status(400).json({ error: 'Invalid Grin address format' });
      }

      const stmt = db.prepare(`
        INSERT OR IGNORE INTO miner_accounts (grin_address, balance, balance_locked)
        VALUES (?, 0.0, 0.0)
      `);
      stmt.run(grin_address);

      res.json({
        grin_address,
        balance: 0.0,
        balance_locked: 0.0,
        created_at: new Date().toISOString()
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/test/miners', (req, res) => {
    try {
      const stmt = db.prepare('SELECT * FROM miner_accounts ORDER BY created_at DESC LIMIT 100');
      const miners = stmt.all();
      res.json(miners);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/test/blocks', (req, res) => {
    try {
      const stmt = db.prepare('SELECT * FROM blocks ORDER BY height DESC LIMIT 50');
      const blocks = stmt.all();
      res.json(blocks);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/test/tables', (req, res) => {
    try {
      const stmt = db.prepare(`
        SELECT name FROM sqlite_master
        WHERE type='table' AND name NOT LIKE 'sqlite_%'
        ORDER BY name
      `);
      const tables = stmt.all();
      res.json({
        table_count: tables.length,
        tables: tables.map(t => t.name)
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

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

  app.post('/api/test/credit-block', (req, res) => {
    try {
      const { height, hash, nonce, reward, miner_address } = req.body;

      if (!height || !hash || nonce === undefined || !reward || !miner_address) {
        return res.status(400).json({ error: 'Missing required fields' });
      }

      const result = blockManager.creditBlock(height, hash, nonce, reward, miner_address);
      if (result.success) {
        res.json(result);
      } else {
        res.status(400).json(result);
      }
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/admin/node-status', (req, res) => {
    blockMonitor.grinNode.getStatus()
      .then(status => res.json(status))
      .catch(err => res.status(500).json({ error: err.message }));
  });

  app.get('/api/admin/block-monitor', (req, res) => {
    res.json(blockMonitor.getStatus());
  });

  app.post('/api/test/distribute-block', (req, res) => {
    try {
      const { block_id } = req.body;

      if (!block_id) {
        return res.status(400).json({ error: 'Missing block_id' });
      }

      rewardDistributor.distributeRewards(block_id)
        .then(result => {
          if (result.success) {
            res.json(result);
          } else {
            res.status(400).json(result);
          }
        })
        .catch(err => res.status(500).json({ error: err.message }));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/admin/reward-stats', (req, res) => {
    rewardDistributor.rewardStats()
      .then(stats => res.json(stats))
      .catch(err => res.status(500).json({ error: err.message }));
  });

  app.post('/api/test/initiate-withdrawal', (req, res) => {
    try {
      const { grin_address, amount } = req.body;

      if (!grin_address || !amount) {
        return res.status(400).json({ error: 'Missing required fields' });
      }

      if (amount <= 0 || amount < config.min_withdrawal) {
        return res.status(400).json({
          error: `Minimum withdrawal is ${config.min_withdrawal} GRIN`
        });
      }

      const stmt = db.prepare(`
        INSERT INTO withdrawals (grin_address, amount, fee)
        VALUES (?, ?, 0)
      `);

      const result = stmt.run(grin_address, amount);

      const eventStmt = db.prepare(`
        INSERT INTO withdrawal_events
        (withdrawal_id, to_status, triggered_by)
        VALUES (?, 'tor_checking', 'test_api')
      `);
      eventStmt.run(result.lastInsertRowid);

      res.json({
        withdrawal_id: result.lastInsertRowid,
        grin_address,
        amount,
        status: 'tor_checking',
        created_at: new Date().toISOString()
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/admin/withdrawals', (req, res) => {
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

  app.get('/api/admin/withdrawal-scheduler', (req, res) => {
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

  app.get('/api/admin/metrics', requireAdmin(authManager), (req, res) => {
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

  app.get('/api/admin/audit-log', requireAdmin(authManager), (req, res) => {
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

  app.use((req, res) => {
    res.status(404).json({ error: 'Not found' });
  });
}

process.on('SIGINT', () => {
  console.log(`\n[${new Date().toISOString()}] Shutting down gracefully...`);
  process.exit(0);
});

initializePool();
