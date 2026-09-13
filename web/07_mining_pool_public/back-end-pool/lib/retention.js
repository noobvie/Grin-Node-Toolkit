const { getDb } = require('./db');
const PoolSettings = require('./pool-settings');
const LedgerRollup = require('./ledger-rollup');

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

    // Never prune at/above the oldest UNSETTLED block's PPLNS window. 'confirmed' counts as
    // unsettled: it has matured but not yet been distributed, and it still reads shares in
    // [height - PPLNS, height]. Only 'immature' used to be considered here, which was fine
    // while distribution kept up — but a block that stalls in 'confirmed' (node outage, a
    // failing credit) could have its shares aged out from under it, and getSharesForDistribution
    // returning empty makes rewards.js mark it 'paid' with the reward retained and the miners
    // never credited. See audit §I9.
    const imm = this.db.prepare(
      "SELECT MIN(height) AS h FROM blocks WHERE status IN ('immature', 'confirmed')"
    ).get();
    if (imm && imm.h !== null && imm.h !== undefined) {
      const immFloor = imm.h - PPLNS_WINDOW_BLOCKS - marginBlocks;
      if (immFloor < cutoff) cutoff = immFloor;
    }

    return cutoff;
  }

  // Run one prune pass. Synchronous (node:sqlite). Safe to call manually.
  runOnce() {
    const s = this.settings.getSection('database');
    const enabled = s.retention_enabled === true || s.retention_enabled === 'true';
    const result = {
      ran_at: Math.floor(Date.now() / 1000),
      enabled,
      shares_deleted: 0,
      hashrate_deleted: 0,
      hashrate_daily_deleted: 0,
      alerts_deleted: 0,
      audit_log_deleted: 0,
      balance_log_deleted: 0,
      ledger_rollup_horizon: null,
      ledger_rollup_mismatch: null,
    };

    if (!enabled) {
      this.lastRun = result.ran_at;
      this.lastResult = result;
      return result;
    }

    const margin = parseInt(s.shares_margin_blocks, 10) || 0;
    const hashrateKeepDays = parseInt(s.hashrate_keep_days, 10) || 100;
    const alertsKeepDays = parseInt(s.resolved_alerts_keep_days, 10) || 30;
    // Raw ledger window. Floor of 45 days: must stay above the longest raw-only window
    // reader (reconciliation 7d flows + 30d wallet-send audit, account 30d earnings) + slack.
    const ledgerKeepDays = Math.max(45, parseInt(s.balance_log_keep_days, 10) || 60);
    // Audit trail window. Floor of 30 days so a mis-set value can never leave the money path
    // untraceable — long enough to investigate a disputed payout after the miner reports it.
    const auditKeepDays = Math.max(30, parseInt(s.audit_log_keep_days, 10) || 180);
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

      // 2b. The per-address DAILY rollup of the same data (audit §J12-1), pruned on the SAME
      //     horizon. Deliberately not keep-forever like pool_metrics_hourly / balance_log_daily:
      //     those are pool-wide aggregates, this one is per-ADDRESS mining activity, and a
      //     summary that outlived the raw rows it was built from would quietly retain more
      //     about a miner than the pool did before it existed. A rollup must never extend a
      //     retention window. Pruned by whole UTC day so a partially-covered day is kept.
      const dayCut = Math.floor(hrCut / 86400) * 86400;
      const r2b = this.db.prepare('DELETE FROM miner_hashrate_daily WHERE day < ?').run(dayCut);
      result.hashrate_daily_deleted = r2b.changes;

      // 3. Resolved/acknowledged alerts — prune by numeric created_at.
      const alCut = now - alertsKeepDays * 86400;
      const r3 = this.db.prepare(
        "DELETE FROM alerts WHERE status IN ('resolved','acknowledged') AND created_at < ?"
      ).run(alCut);
      result.alerts_deleted = r3.changes;

      // 4. Audit trail — miner-attributed rows pair a grin address with a coarsened origin
      //    IP and previously accumulated forever. Pruned purely by age; no other table
      //    references admin_audit_log, so nothing breaks when rows leave.
      const auCut = now - auditKeepDays * 86400;
      const r4 = this.db.prepare('DELETE FROM admin_audit_log WHERE created_at < ?').run(auCut);
      result.audit_log_deleted = r4.changes;

      // 5. Goblin/Nostr replay-dedup ids (audit §J4-8). The bridge creates this table itself
      //    and nothing ever pruned it: anyone can publish a kind-1059 event #p-tagged to the
      //    pool's public key, and each one costs a PERMANENT row — the row is written before
      //    the wrap is decrypted, which is the right order (dedup ahead of an expensive nip44
      //    decrypt) but means undecryptable junk counts too. Unbounded growth on the same
      //    SQLite file share intake writes to, which is the thing that stalls SHARES.
      //
      //    24 h is comfortably past both windows that give an id meaning — the relay lookback
      //    (LOOKBACK_SECS) and nostr_pending_ttl_minutes — so a pruned id can no longer arrive
      //    again as a "new" event. The table is absent on a pool that never enabled the rail,
      //    hence the try/catch rather than a CREATE here: retention must not conjure a table
      //    for a feature that is off.
      try {
        const nsCut = now - 86400;
        const r5 = this.db.prepare('DELETE FROM nostr_seen_events WHERE seen_at < ?').run(nsCut);
        result.nostr_seen_deleted = r5.changes;
      } catch (_) { result.nostr_seen_deleted = 0; }
    });
    tx();

    // 5. balance_log — roll completed UTC days into balance_log_daily FIRST (the rollup
    //    is what lifetime analytics read forever), then prune raw rows older than
    //    balance_log_keep_days, each day verified against its rollup before deletion.
    //    Runs outside the tx above: ledger-rollup manages its own per-day transactions.
    try {
      const roll = LedgerRollup.rollupCompletedDays(this.db);
      result.ledger_rollup_horizon = roll.horizon;
      const prune = LedgerRollup.verifyAndPruneRaw(this.db, ledgerKeepDays);
      result.balance_log_deleted = prune.deleted;
      result.ledger_rollup_mismatch = prune.mismatch; // non-null = verify failed, prune halted
    } catch (e) {
      console.error(`[Retention] ledger rollup/prune failed: ${e.message}`);
    }

    this.lastRun = result.ran_at;
    this.lastResult = result;
    console.log(
      `[Retention] shares=${result.shares_deleted} hashrate=${result.hashrate_deleted} ` +
      `hashrate_daily=${result.hashrate_daily_deleted} ` +
      `alerts=${result.alerts_deleted} audit_log=${result.audit_log_deleted} ` +
      `balance_log=${result.balance_log_deleted}` +
      (result.shares_cutoff_height ? ` (shares cutoff height ${result.shares_cutoff_height})` : '') +
      (result.ledger_rollup_mismatch ? ' [LEDGER ROLLUP MISMATCH — ledger prune halted]' : '')
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
        miner_hashrate_daily: count('miner_hashrate_daily'),
        alerts: count('alerts'),
        admin_audit_log: count('admin_audit_log'),
        balance_log: count('balance_log'),
        balance_log_daily: count('balance_log_daily'),
      },
      ledger_rollup_horizon: LedgerRollup.getHorizon(this.db),
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
