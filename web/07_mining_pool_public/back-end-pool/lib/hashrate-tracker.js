const { getDb } = require('./db');

class HashrateTracker {
  constructor(config, minerManager) {
    this.config = config;
    this.db = getDb();
    this.minerManager = minerManager;
    this.samplingInterval = 60000;
    this.isRunning = false;
  }

  start() {
    if (this.isRunning) return;

    this.isRunning = true;
    console.log(`[${new Date().toISOString()}] Hashrate tracker started`);

    this.trackingLoop();
  }

  async trackingLoop() {
    while (this.isRunning) {
      try {
        await this.recordHashrates();
      } catch (err) {
        console.error(`[ERROR] Hashrate tracking error: ${err.message}`);
      }

      await this.sleep(this.samplingInterval);
    }
  }

  // Cuckatoo32 hashrate: GPS = Σ(share difficulty) × 42 / window_seconds / 16384
  // (matches CLAUDE.md and /api/pool/stats/regions). Derived from the SHARES table — real
  // accepted work — NOT from a static per-session difficulty.
  static CYCLE_LENGTH = 42;
  static SOLUTION_RATE = 16384;

  // Snapshot each active miner's hashrate over the last sampling window into hashrate_history
  // (time-series for charts). Computed from shares actually accepted in the window.
  recordHashrates() {
    try {
      const windowSeconds = this.samplingInterval / 1000;
      const cutoff = Math.floor(Date.now() / 1000) - windowSeconds;

      const rows = this.db.prepare(`
        SELECT grin_address, COALESCE(SUM(difficulty), 0) AS sumdiff
        FROM shares WHERE created_at > ? GROUP BY grin_address
      `).all(cutoff);

      const stmt = this.db.prepare(`
        INSERT INTO hashrate_history (grin_address, hashrate_gps, window_seconds)
        VALUES (?, ?, ?)
      `);
      const tx = this.db.transaction(() => {
        for (const r of rows) {
          const gps = (r.sumdiff * HashrateTracker.CYCLE_LENGTH) /
                      (windowSeconds * HashrateTracker.SOLUTION_RATE);
          stmt.run(r.grin_address, gps, windowSeconds);
        }
      });
      tx();

      return rows.length;
    } catch (err) {
      console.error(`Error recording hashrates: ${err.message}`);
      return 0;
    }
  }

  calculateHashrate(difficulty, windowSeconds = 60) {
    if (difficulty <= 0 || windowSeconds <= 0) return 0;
    return (difficulty * HashrateTracker.CYCLE_LENGTH) / (windowSeconds * HashrateTracker.SOLUTION_RATE);
  }

  // Pool-wide GPS over a window — computed directly from shares (not by summing the per-sample
  // history rows, which would multiply by the number of samples in the window).
  getPoolHashrate(windowMinutes = 1) {
    try {
      const windowSeconds = windowMinutes * 60;
      const cutoffTime = Math.floor(Date.now() / 1000) - windowSeconds;

      const row = this.db.prepare(`
        SELECT COALESCE(SUM(difficulty), 0) AS sumdiff FROM shares WHERE created_at > ?
      `).get(cutoffTime);

      return (row.sumdiff * HashrateTracker.CYCLE_LENGTH) / (windowSeconds * HashrateTracker.SOLUTION_RATE);
    } catch (err) {
      console.error(`Error calculating pool hashrate: ${err.message}`);
      return 0;
    }
  }

  // Per-miner average GPS over a window, derived from that miner's accepted shares. Shape
  // ({ avg_hashrate, max_hashrate }) is preserved for existing callers; max == avg here since
  // it's a single window aggregate.
  getMinerHashrate(minerAddress, windowMinutes = 1) {
    try {
      const windowSeconds = windowMinutes * 60;
      const cutoffTime = Math.floor(Date.now() / 1000) - windowSeconds;

      const row = this.db.prepare(`
        SELECT COALESCE(SUM(difficulty), 0) AS sumdiff
        FROM shares WHERE grin_address = ? AND created_at > ?
      `).get(minerAddress, cutoffTime);

      const gps = (row.sumdiff * HashrateTracker.CYCLE_LENGTH) / (windowSeconds * HashrateTracker.SOLUTION_RATE);
      return { avg_hashrate: gps, max_hashrate: gps };
    } catch (err) {
      console.error(`Error calculating miner hashrate: ${err.message}`);
      return { avg_hashrate: 0, max_hashrate: 0 };
    }
  }

  getTopMiners(limit = 10, windowMinutes = 1) {
    try {
      const windowSeconds = windowMinutes * 60;
      const cutoffTime = Math.floor(Date.now() / 1000) - windowSeconds;
      const factor = HashrateTracker.CYCLE_LENGTH / (windowSeconds * HashrateTracker.SOLUTION_RATE);

      const rows = this.db.prepare(`
        SELECT grin_address, COALESCE(SUM(difficulty), 0) AS sumdiff
        FROM shares WHERE created_at > ?
        GROUP BY grin_address
        ORDER BY sumdiff DESC
        LIMIT ?
      `).all(cutoffTime, limit);

      return rows.map(r => ({
        grin_address: r.grin_address,
        avg_hashrate: r.sumdiff * factor,
        max_hashrate: r.sumdiff * factor
      }));
    } catch (err) {
      console.error(`Error fetching top miners: ${err.message}`);
      return [];
    }
  }

  // Per-worker breakdown for one address. Hashrate + share count + last_share come from the
  // SHARES table (works across restarts and all regions); accepted/rejected/stale + online come
  // from the LIVE in-memory stratum sessions. Under Model C every region's miners terminate
  // their session on this box, so reject/stale is complete pool-wide. Workers seen in shares but
  // with no live session show online:false and null reject/stale.
  getWorkersForAccount(minerAddress, windowMinutes = 10) {
    try {
      const windowSeconds = windowMinutes * 60;
      const cutoff = Math.floor(Date.now() / 1000) - windowSeconds;
      const factor = HashrateTracker.CYCLE_LENGTH / (windowSeconds * HashrateTracker.SOLUTION_RATE);

      // worker_name may be NULL (default worker) — COALESCE so it groups under a stable label.
      const rows = this.db.prepare(`
        SELECT COALESCE(worker_name, 'default') AS worker_name,
               COALESCE(SUM(difficulty), 0) AS sumdiff,
               COUNT(*) AS share_count,
               MAX(created_at) AS last_share_at
        FROM shares
        WHERE grin_address = ? AND created_at > ?
        GROUP BY COALESCE(worker_name, 'default')
        ORDER BY sumdiff DESC
      `).all(minerAddress, cutoff);

      // Live session counters keyed by worker name.
      const liveByWorker = new Map();
      const sessions = this.minerManager.getSessionsByMiner
        ? this.minerManager.getSessionsByMiner(minerAddress)
        : [];
      for (const s of sessions) {
        const wn = s.workerName || 'default';
        const acc = liveByWorker.get(wn) || { accepted: 0, rejected: 0, stale: 0, online: true };
        acc.accepted += s.accepted || 0;
        acc.rejected += s.rejected || 0;
        acc.stale    += s.stale    || 0;
        liveByWorker.set(wn, acc);
      }

      const workers = rows.map(r => {
        const live = liveByWorker.get(r.worker_name);
        const out = {
          worker_name:  r.worker_name,
          hashrate_gps: parseFloat((r.sumdiff * factor).toFixed(6)),
          share_count:  r.share_count,
          last_share_at: r.last_share_at,
          online:       !!live,
          accepted:     live ? live.accepted : null,
          rejected:     live ? live.rejected : null,
          stale:        live ? live.stale : null
        };
        if (live) {
          const total = live.accepted + live.rejected + live.stale;
          out.reject_pct = total > 0 ? parseFloat(((live.rejected / total) * 100).toFixed(2)) : 0;
          out.stale_pct  = total > 0 ? parseFloat(((live.stale    / total) * 100).toFixed(2)) : 0;
        } else {
          out.reject_pct = null;
          out.stale_pct  = null;
        }
        if (live) liveByWorker.delete(r.worker_name);
        return out;
      });

      // Live workers connected but with no accepted share in the window yet → still list them.
      for (const [wn, live] of liveByWorker) {
        const total = live.accepted + live.rejected + live.stale;
        workers.push({
          worker_name:  wn,
          hashrate_gps: 0,
          share_count:  0,
          last_share_at: null,
          online:       true,
          accepted:     live.accepted,
          rejected:     live.rejected,
          stale:        live.stale,
          reject_pct:   total > 0 ? parseFloat(((live.rejected / total) * 100).toFixed(2)) : 0,
          stale_pct:    total > 0 ? parseFloat(((live.stale    / total) * 100).toFixed(2)) : 0
        });
      }

      return workers;
    } catch (err) {
      console.error(`Error building worker breakdown for ${minerAddress}: ${err.message}`);
      return [];
    }
  }

  // Time-series for one address — the per-minute samples recorded by recordHashrates(), thinned
  // to ~maxPoints evenly-spaced buckets for charting. Returns [{ t, gps }] oldest→newest.
  getAccountHistory(minerAddress, hours = 24, maxPoints = 288) {
    try {
      const cutoff = Math.floor(Date.now() / 1000) - hours * 3600;
      const rows = this.db.prepare(`
        SELECT recorded_at AS t, hashrate_gps AS gps
        FROM hashrate_history
        WHERE grin_address = ? AND recorded_at > ?
        ORDER BY recorded_at ASC
      `).all(minerAddress, cutoff);
      return HashrateTracker._thin(rows, maxPoints);
    } catch (err) {
      console.error(`Error fetching account history for ${minerAddress}: ${err.message}`);
      return [];
    }
  }

  // Pool-wide time-series — SUM across addresses per recorded_at bucket (the history table is
  // per-address, so the pool series is not pre-aggregated). Returns [{ t, gps }] oldest→newest.
  getPoolHistory(hours = 24, maxPoints = 288) {
    try {
      const cutoff = Math.floor(Date.now() / 1000) - hours * 3600;
      const rows = this.db.prepare(`
        SELECT recorded_at AS t, COALESCE(SUM(hashrate_gps), 0) AS gps
        FROM hashrate_history
        WHERE recorded_at > ?
        GROUP BY recorded_at
        ORDER BY recorded_at ASC
      `).all(cutoff);
      return HashrateTracker._thin(rows, maxPoints);
    } catch (err) {
      console.error(`Error fetching pool history: ${err.message}`);
      return [];
    }
  }

  // Evenly downsample a dense oldest→newest series to at most maxPoints (keeps the last point).
  static _thin(rows, maxPoints) {
    if (rows.length <= maxPoints) {
      return rows.map(r => ({ t: r.t, gps: parseFloat((r.gps || 0).toFixed(6)) }));
    }
    const step = rows.length / maxPoints;
    const out = [];
    for (let i = 0; i < maxPoints; i++) {
      const r = rows[Math.floor(i * step)];
      out.push({ t: r.t, gps: parseFloat((r.gps || 0).toFixed(6)) });
    }
    const last = rows[rows.length - 1];
    if (out.length === 0 || out[out.length - 1].t !== last.t) {
      out.push({ t: last.t, gps: parseFloat((last.gps || 0).toFixed(6)) });
    }
    return out;
  }

  getHashrateStats() {
    try {
      const poolHashrate1h = this.getPoolHashrate(60);
      const poolHashrate24h = this.getPoolHashrate(1440);
      const topMiners = this.getTopMiners(10, 60);

      const activeSessions = this.minerManager.getActiveSessions();
      const uniqueMiners = new Set(activeSessions.map(s => s.grinAddress)).size;

      return {
        pool_hashrate_1h_gps: parseFloat(poolHashrate1h.toFixed(6)),
        pool_hashrate_24h_gps: parseFloat(poolHashrate24h.toFixed(6)),
        active_miners: uniqueMiners,
        active_connections: activeSessions.length,
        top_miners: topMiners.map(m => ({
          grin_address: m.grin_address,
          hashrate_gps: parseFloat(m.avg_hashrate.toFixed(6)),
          max_hashrate_gps: parseFloat(m.max_hashrate.toFixed(6))
        }))
      };
    } catch (err) {
      console.error(`Error fetching hashrate stats: ${err.message}`);
      return {
        pool_hashrate_1h_gps: 0,
        pool_hashrate_24h_gps: 0,
        active_miners: 0,
        active_connections: 0,
        top_miners: []
      };
    }
  }

  stop() {
    this.isRunning = false;
    console.log(`[${new Date().toISOString()}] Hashrate tracker stopped`);
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = HashrateTracker;
