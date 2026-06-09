const { getDb } = require('./db');
const PoolSettings = require('./pool-settings');

// PPLNS window in blocks — mirrors RewardDistributor.pplnsWindow (rewards.js).
// Distribution reads shares in [foundHeight - PPLNS_WINDOW_BLOCKS, foundHeight];
// orphan reversal reads shares at an immature block's exact height. The prune
// floor below is derived from these so retention can NEVER remove a share that a
// pending payout could still read.
const PPLNS_WINDOW_BLOCKS = 60;

class RetentionManager {
  constructor(config) {
    this.config = config;
    this.db = getDb();
    this.settings = new PoolSettings(this.db);
    this.timer = null;
    this.lastRun = null;
    this.lastResult = null;
  }

  _confirmDepth() {
    return this.config.network === 'mainnet'
      ? (this.config.confirm_depth_mainnet || 1440)
      : (this.config.confirm_depth_testnet || 100);
  }

  // Highest block_height we may prune BELOW without removing shares that PPLNS
  // distribution or orphan reversal could still need. Returns null if there is
  // nothing safe to prune yet.
  //
  //   required = confirm_depth + PPLNS window     (blocks that may still mature)
  //   cutoff   = currentHeight - (required + shares_margin_blocks)
  //   clamp    = lowered below the OLDEST immature block (minus PPLNS window +
  //              margin) so an un-processed block never loses its shares
  _sharesCutoffHeight(marginBlocks) {
    const row = this.db.prepare('SELECT MAX(block_height) AS h FROM shares').get();
    const currentHeight = row && row.h ? row.h : 0;
    if (!currentHeight) return null;

    const required = this._confirmDepth() + PPLNS_WINDOW_BLOCKS;
    let cutoff = currentHeight - (required + marginBlocks);

    // Never prune at/above the oldest still-immature block's PPLNS window.
    const imm = this.db.prepare(
      "SELECT MIN(height) AS h FROM blocks WHERE status = 'immature'"
    ).get();
    if (imm && imm.h !== null && imm.h !== undefined) {
      const immFloor = imm.h - PPLNS_WINDOW_BLOCKS - marginBlocks;
      if (immFloor < cutoff) cutoff = immFloor;
    }

    return cutoff;
  }

  // Run one prune pass. Synchronous (better-sqlite3). Safe to call manually.
  runOnce() {
    const s = this.settings.getSection('database');
    const enabled = s.retention_enabled === true || s.retention_enabled === 'true';
    const result = {
      ran_at: Math.floor(Date.now() / 1000),
      enabled,
      shares_deleted: 0,
      hashrate_deleted: 0,
      alerts_deleted: 0,
    };

    if (!enabled) {
      this.lastRun = result.ran_at;
      this.lastResult = result;
      return result;
    }

    const margin = parseInt(s.shares_margin_blocks, 10) || 0;
    const hashrateKeepDays = parseInt(s.hashrate_keep_days, 10) || 30;
    const alertsKeepDays = parseInt(s.resolved_alerts_keep_days, 10) || 30;
    const now = Math.floor(Date.now() / 1000);

    const tx = this.db.transaction(() => {
      // 1. Raw shares — only strictly below the provably-safe cutoff height.
      const cutoff = this._sharesCutoffHeight(margin);
      if (cutoff !== null && cutoff > 0) {
        const r = this.db.prepare('DELETE FROM shares WHERE block_height < ?').run(cutoff);
        result.shares_deleted = r.changes;
        result.shares_cutoff_height = cutoff;
      }

      // 2. Hashrate history — display data only; safe to prune purely by age.
      const hrCut = now - hashrateKeepDays * 86400;
      const r2 = this.db.prepare('DELETE FROM hashrate_history WHERE recorded_at < ?').run(hrCut);
      result.hashrate_deleted = r2.changes;

      // 3. Resolved/acknowledged alerts — prune by numeric created_at.
      const alCut = now - alertsKeepDays * 86400;
      const r3 = this.db.prepare(
        "DELETE FROM alerts WHERE status IN ('resolved','acknowledged') AND created_at < ?"
      ).run(alCut);
      result.alerts_deleted = r3.changes;
    });
    tx();

    this.lastRun = result.ran_at;
    this.lastResult = result;
    console.log(
      `[Retention] shares=${result.shares_deleted} hashrate=${result.hashrate_deleted} ` +
      `alerts=${result.alerts_deleted}` +
      (result.shares_cutoff_height ? ` (shares cutoff height ${result.shares_cutoff_height})` : '')
    );
    return result;
  }

  // SQLite file size in bytes (page_count * page_size). File space is reclaimed by
  // the existing weekly VACUUM cron, not here — DELETEs alone don't shrink the file.
  dbSizeBytes() {
    try {
      const pc = this.db.pragma('page_count', { simple: true });
      const ps = this.db.pragma('page_size', { simple: true });
      return pc * ps;
    } catch (e) {
      return null;
    }
  }

  status() {
    const count = (t) => this.db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get().c;
    return {
      db_size_bytes: this.dbSizeBytes(),
      last_run: this.lastRun,
      last_result: this.lastResult,
      counts: {
        shares: count('shares'),
        hashrate_history: count('hashrate_history'),
        alerts: count('alerts'),
      },
      settings: this.settings.getSection('database'),
    };
  }

  // Schedule periodic pruning. Interval is read once here (applied at restart).
  start() {
    const s = this.settings.getSection('database');
    const intervalMin = parseInt(s.prune_interval_minutes, 10) || 60;

    // First pass shortly after startup, then on the configured interval.
    setTimeout(() => {
      try { this.runOnce(); } catch (e) { console.error(`[Retention] ${e.message}`); }
    }, 30000);

    this.timer = setInterval(() => {
      try { this.runOnce(); } catch (e) { console.error(`[Retention] ${e.message}`); }
    }, intervalMin * 60 * 1000);
    if (this.timer.unref) this.timer.unref();

    console.log(`[Retention] scheduled every ${intervalMin} min`);
    return this;
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

module.exports = RetentionManager;
