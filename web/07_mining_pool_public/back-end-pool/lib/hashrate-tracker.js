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
