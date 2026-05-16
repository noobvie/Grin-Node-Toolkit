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

  recordHashrates() {
    try {
      const sessions = this.minerManager.getActiveSessions();

      const minerHashrates = new Map();

      for (const session of sessions) {
        if (!minerHashrates.has(session.grinAddress)) {
          minerHashrates.set(session.grinAddress, 0);
        }

        const currentHashrate = minerHashrates.get(session.grinAddress);
        const sessionHashrate = this.calculateHashrate(session.difficulty, 60);
        minerHashrates.set(session.grinAddress, currentHashrate + sessionHashrate);
      }

      const stmt = this.db.prepare(`
        INSERT INTO hashrate_history (grin_address, hashrate_gps, window_seconds)
        VALUES (?, ?, 60)
      `);

      for (const [addr, hashrate] of minerHashrates) {
        stmt.run(addr, hashrate);
      }

      return minerHashrates.size;
    } catch (err) {
      console.error(`Error recording hashrates: ${err.message}`);
      return 0;
    }
  }

  calculateHashrate(difficulty, windowSeconds = 60) {
    const CYCLE_LENGTH = 42;
    const SOLUTION_RATE = 16384;

    if (difficulty <= 0 || windowSeconds <= 0) return 0;

    return (difficulty * CYCLE_LENGTH) / (windowSeconds * SOLUTION_RATE);
  }

  getPoolHashrate(windowMinutes = 1) {
    try {
      const windowSeconds = windowMinutes * 60;
      const cutoffTime = Math.floor(Date.now() / 1000) - windowSeconds;

      const stmt = this.db.prepare(`
        SELECT SUM(hashrate_gps) as total_hashrate
        FROM hashrate_history
        WHERE recorded_at > ?
      `);

      const result = stmt.get(cutoffTime);
      return result.total_hashrate || 0;
    } catch (err) {
      console.error(`Error calculating pool hashrate: ${err.message}`);
      return 0;
    }
  }

  getMinerHashrate(minerAddress, windowMinutes = 1) {
    try {
      const windowSeconds = windowMinutes * 60;
      const cutoffTime = Math.floor(Date.now() / 1000) - windowSeconds;

      const stmt = this.db.prepare(`
        SELECT AVG(hashrate_gps) as avg_hashrate, MAX(hashrate_gps) as max_hashrate
        FROM hashrate_history
        WHERE grin_address = ? AND recorded_at > ?
      `);

      return stmt.get(minerAddress, cutoffTime);
    } catch (err) {
      console.error(`Error calculating miner hashrate: ${err.message}`);
      return { avg_hashrate: 0, max_hashrate: 0 };
    }
  }

  getTopMiners(limit = 10, windowMinutes = 1) {
    try {
      const windowSeconds = windowMinutes * 60;
      const cutoffTime = Math.floor(Date.now() / 1000) - windowSeconds;

      const stmt = this.db.prepare(`
        SELECT grin_address, AVG(hashrate_gps) as avg_hashrate, MAX(hashrate_gps) as max_hashrate
        FROM hashrate_history
        WHERE recorded_at > ?
        GROUP BY grin_address
        ORDER BY avg_hashrate DESC
        LIMIT ?
      `);

      return stmt.all(cutoffTime, limit);
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
