// /api/admin node + chain health — node-status, node-events, node-availability, block-monitor,
// reward-stats, dashboard and the /api/admin/health* family. Moved verbatim out of routes/index.js
// (code-layout refactor P7); registrations stay at 2-space indent and write FULL paths. Instances
// come from ctx; the guard chains are the ONE createGuards(ctx) instance (I7), handed in as `guards`.

const express = require('express');
const { readGatewayStatus, probeStratumTcp } = require('../../lib/gateway-status');
const os = require('os');
const fs = require('fs');
const path = require('path');
const NodeAvailability = require('../../lib/node-availability');
const DonorProfiles = require('../../lib/donor-profiles');
const AlertMonitor = require('../../lib/alert-monitor');
const GrinWalletVersion = require('../../lib/grin-wallet-version');

module.exports = function createAdminNodeRoutes(ctx, guards) {
  const { config, db, wallet, stratumServer, blockManager, minerManager, blockMonitor, rewardDistributor, walletTor, withdrawalScheduler, hashrateTracker, alertMonitor, retentionManager, nodeAvailability } = ctx;
  const { secureAdmin } = guards;
  const router = express.Router();

  router.get('/api/admin/node-status', secureAdmin, (req, res) => {
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

  router.get('/api/admin/node-events', secureAdmin, (req, res) => {
    try {
      const range = nodeAvailParams(req, res);
      if (!range) return;
      res.json(Object.assign({ range: range.key }, nodeAvailability.events(range.secs)));
    } catch (err) {
      console.error(`[node-availability] /api/admin/node-events: ${err.message}`);
      res.status(500).json({ error: 'node events unavailable' });
    }
  });

  router.get('/api/admin/node-availability', secureAdmin, (req, res) => {
    try {
      const range = nodeAvailParams(req, res);
      if (!range) return;
      res.json(Object.assign({ range: range.key }, nodeAvailability.availability(range.secs)));
    } catch (err) {
      console.error(`[node-availability] /api/admin/node-availability: ${err.message}`);
      res.status(500).json({ error: 'node availability unavailable' });
    }
  });

  router.get('/api/admin/block-monitor', secureAdmin, (req, res) => {
    res.json(blockMonitor.getStatus());
  });

  // Test endpoint removed - manual reward distribution disabled for security

  router.get('/api/admin/reward-stats', secureAdmin, (req, res) => {
    rewardDistributor.rewardStats()
      .then(stats => res.json(stats))
      .catch(err => res.status(500).json({ error: err.message }));
  });

  // Unified Admin Dashboard
  router.get('/api/admin/dashboard', secureAdmin, async (req, res) => {
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
  router.get('/api/admin/health', secureAdmin, async (req, res) => {
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
  router.get('/api/admin/health/node', secureAdmin, async (req, res) => {
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
  router.get('/api/admin/health/wallet', secureAdmin, async (req, res) => {
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
  router.get('/api/admin/health/system', secureAdmin, (req, res) => {
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
  router.get('/api/admin/health/gateways', secureAdmin, async (req, res) => {
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

  return router;
};
