/**
 * Alert Monitor — Detects pool health issues and triggers alerts
 *
 * Monitors:
 * - Node connectivity & sync status
 * - Wallet health & balance
 * - Stratum metrics (rejection rate, errors)
 * - Block orphan rate
 * - Payout failures
 * - Difficulty spikes
 *
 * Triggers alerts, stores in DB, delivers via email/webhooks
 */

const { computeReconciliation, auditWalletSends, probeWalletIdentity } = require('./reconciliation');

class AlertMonitor {
  constructor(config, modules, db) {
    this.config = config;
    this.blockMonitor = modules.blockMonitor;
    this.walletTor = modules.walletTor;
    this.wallet = modules.wallet;               // WalletAPI (Owner-API) — online + balance signal
    this.stratumServer = modules.stratumServer;
    this.withdrawalScheduler = modules.withdrawalScheduler;
    this.alertDelivery = modules.alertDelivery; // wired so alerts are actually delivered
    this.db = db;

    this.monitorInterval = null;
    this.checkIntervalMs = (config.alert_check_interval_secs || 60) * 1000;

    // Money-integrity + withdrawal-anomaly checks force a fresh (slow) wallet→node scan, so they
    // run on a slower cadence than the 60s liveness loop.
    this.moneyCheckIntervalMs = (config.alert_money_check_interval_secs || 300) * 1000;
    this.lastMoneyCheckAt = 0;
    // Snapshot of wallet total between money checks — the basis for the drain detector.
    this.prevWalletTotal = null;
    this.prevWalletCheckAt = null;

    // On a CRITICAL money trip (coverage shortfall / integrity drift / wallet drain), auto-freeze
    // the withdrawal scheduler to stop the bleeding. Operator resumes manually. Default on.
    this.autoFreezeOnCritical = config.payout_auto_freeze !== false;
    this.withdrawalScheduler = modules.withdrawalScheduler;

    // Track previous states to avoid duplicate alerts
    this.previousStates = {
      node_status: 'unknown',
      wallet_status: 'unknown',
      stratum_status: 'unknown'
    };

    // Alert thresholds (from config or defaults). `??` (not `||`) so an explicit 0 is honoured.
    const t = config.alert_thresholds || {};
    this.thresholds = {
      wallet_balance_warning_grin: t.wallet_balance_warning_grin ?? 50,
      rejection_rate_warning_percent: t.rejection_rate_warning_percent ?? 1.0,
      error_rate_warning_percent: t.error_rate_warning_percent ?? 5.0,
      difficulty_change_warning_percent: t.difficulty_change_warning_percent ?? 20.0,
      // Money-integrity thresholds.
      wallet_drain_grin: t.wallet_drain_grin ?? 100,            // unexplained wallet drop (GRIN)
      wallet_drain_percent: t.wallet_drain_percent ?? 10,       // …or % of prior wallet total
      large_withdrawal_grin: t.large_withdrawal_grin ?? 500,    // single payout size (GRIN)
      large_withdrawal_percent: t.large_withdrawal_percent ?? 25, // …or % of pool holdings
      payout_surge_percent: t.payout_surge_percent ?? 50,       // 24h payout total as % of holdings
      unrecorded_send_min_grin: t.unrecorded_send_min_grin ?? 1, // out-of-band send floor to freeze on
      // Below this holdings size the pool is "early/small": PERCENT-based warnings (large %, surge %)
      // are unreliable there (a normal payout is a huge fraction), so they fall back to fixed GRIN
      // thresholds only. Prevents nuisance warnings on a young pool. Freeze detectors are unaffected.
      small_pool_floor_grin: t.small_pool_floor_grin ?? 1000
    };

    // Alert enablement — merge over defaults so a partial config can't silently disable the
    // alerts it doesn't mention (and new money alerts default ON).
    const DEFAULT_ENABLED = {
      node_down: true,
      wallet_offline: true,
      wallet_balance_low: true,
      block_orphaned: true,
      payout_failed: true,
      high_rejection_rate: true,
      high_error_rate: false,
      tor_unreachable: true,
      difficulty_spike: false,
      connection_surge: false,
      // Money-integrity / theft detectors.
      coverage_shortfall: true,
      ledger_integrity_drift: true,
      wallet_drain: true,
      unrecorded_wallet_send: true,
      large_withdrawal: true,
      payout_surge: true,
      wallet_identity_changed: true
    };
    this.enabledAlerts = Object.assign({}, DEFAULT_ENABLED, config.alert_types_enabled || {});

    this.log('Initialized');
  }

  start() {
    if (this.monitorInterval) {
      return;
    }

    this.log('Starting alert monitor');
    this.check(); // First check immediately
    this.monitorInterval = setInterval(() => this.check(), this.checkIntervalMs);
  }

  stop() {
    if (this.monitorInterval) {
      clearInterval(this.monitorInterval);
      this.monitorInterval = null;
      this.log('Alert monitor stopped');
    }
  }

  /**
   * Main health check — run periodically
   */
  async check() {
    try {
      // Check node health
      if (this.enabledAlerts.node_down) {
        await this.checkNodeHealth();
      }

      // Check wallet health
      if (this.enabledAlerts.wallet_offline || this.enabledAlerts.wallet_balance_low) {
        await this.checkWalletHealth();
      }

      // Check stratum health
      if (this.enabledAlerts.high_rejection_rate || this.enabledAlerts.high_error_rate) {
        await this.checkStratumHealth();
      }

      // Check payout failures
      if (this.enabledAlerts.payout_failed) {
        await this.checkPayoutHealth();
      }

      // Check for orphaned blocks
      if (this.enabledAlerts.block_orphaned) {
        await this.checkOrphanedBlocks();
      }

      // Money-integrity + withdrawal-anomaly checks — slower cadence (they force a fresh,
      // slow wallet→node scan). This is the custodial theft/tamper tripwire.
      const nowMs = Date.now();
      if (nowMs - this.lastMoneyCheckAt >= this.moneyCheckIntervalMs) {
        this.lastMoneyCheckAt = nowMs;
        if (this.enabledAlerts.coverage_shortfall || this.enabledAlerts.ledger_integrity_drift || this.enabledAlerts.wallet_drain) {
          await this.checkMoneyIntegrity();
        }
        if (this.enabledAlerts.large_withdrawal || this.enabledAlerts.payout_surge) {
          await this.checkWithdrawalAnomalies();
        }
        if (this.enabledAlerts.wallet_identity_changed) {
          await this.checkWalletIdentity();
        }
      }

    } catch (err) {
      this.error(`Health check failed: ${err.message}`);
    }
  }

  /**
   * Custodial money-integrity checks: coverage shortfall, ledger integrity drift, wallet drain.
   * Reuses the shared reconciliation computation. A CRITICAL trip auto-freezes payouts.
   */
  async checkMoneyIntegrity() {
    let recon;
    try {
      recon = await computeReconciliation(this.db, this.wallet, true);
    } catch (e) {
      this.error(`Money reconciliation failed: ${e.message}`);
      return;
    }
    const c = recon.checks;

    // ── Coverage shortfall (under-funded — possible theft or accounting bug) ──
    if (this.enabledAlerts.coverage_shortfall) {
      if (c.coverage_full_ok === false) {
        await this.triggerAlert('coverage_shortfall', {
          level: 'critical',
          message: `Pool under-funded: wallet total ${recon.wallet.total} GRIN vs owed ${recon.ledger.total_owed} GRIN (unexplained gap ${c.coverage_full_gap} after ${c.network_fees_paid} GRIN recorded network fees).`,
          data: { coverage_full_gap: c.coverage_full_gap, network_fees_paid: c.network_fees_paid, wallet_total: recon.wallet.total, total_owed: recon.ledger.total_owed }
        });
        await this._maybeFreeze(`coverage shortfall ${c.coverage_full_gap} GRIN`);
      } else if (c.coverage_full_ok === true) {
        await this.resolveAlert('coverage_shortfall');
      }
    }

    // ── Ledger integrity drift (a balance moved without a ledger row — bug or tampering) ──
    if (this.enabledAlerts.ledger_integrity_drift) {
      if (c.integrity_ok === false) {
        await this.triggerAlert('ledger_integrity_drift', {
          level: 'critical',
          message: `Ledger integrity drift ${c.integrity_drift} GRIN — a balance moved without a balance_log row (bug or tampering).`,
          data: { integrity_drift: c.integrity_drift }
        });
        await this._maybeFreeze(`integrity drift ${c.integrity_drift} GRIN`);
      } else if (c.integrity_ok === true) {
        await this.resolveAlert('ledger_integrity_drift');
      }
    }

    // ── Wallet drain (unexplained drop in wallet total beyond confirmed payouts) ──
    // The direct "wallet swiped" signal. New block rewards INCREASE total (drop < 0) → no alert;
    // legit payouts are subtracted out. Only an unexplained fall past the threshold fires.
    if (this.enabledAlerts.wallet_drain && recon.wallet.reachable) {
      const nowSec = Math.floor(Date.now() / 1000);
      if (this.prevWalletTotal != null && this.prevWalletCheckAt != null) {
        // "Explained" outflow = pool payouts confirmed since the last snapshot PLUS everything
        // currently in-flight. Including in-flight absorbs the timing skew between the wallet
        // seeing the on-chain spend and the scheduler marking the withdrawal 'confirmed' — so a
        // legit big payout mid-flight is never mistaken for a drain (biased against false freeze).
        // amount + fee: the wallet spends both on a payout (sender-pays), so the fee is part
        // of the EXPLAINED outflow — without it every payout leaves a small "unexplained" residue.
        const paid = this.db.prepare(
          `SELECT COALESCE(SUM(amount + COALESCE(fee,0)),0) AS s FROM withdrawals WHERE status='confirmed' AND confirmed_at > ?`
        ).get(this.prevWalletCheckAt).s;
        const inFlight = this.db.prepare(
          `SELECT COALESCE(SUM(amount + COALESCE(fee,0)),0) AS s FROM withdrawals
           WHERE status IN ('tor_sending','tor_checking','retry_scheduled','slatepack_pending','finalizing')`
        ).get().s;
        const drop = this.prevWalletTotal - recon.wallet.total;
        const unexplained = drop - paid - inFlight;
        const threshold = Math.max(
          this.thresholds.wallet_drain_grin,
          this.prevWalletTotal * (this.thresholds.wallet_drain_percent / 100)
        );
        if (unexplained > threshold) {
          await this.triggerAlert('wallet_drain', {
            level: 'critical',
            message: `Wallet dropped ${drop.toFixed(4)} GRIN; ${(paid + inFlight).toFixed(4)} explained by pool payouts → ${unexplained.toFixed(4)} unexplained (possible out-of-band send/theft).`,
            data: { drop, explained_by_payouts: paid, explained_in_flight: inFlight, unexplained, threshold }
          });
          await this._maybeFreeze(`unexplained wallet drain ${unexplained.toFixed(4)} GRIN`);
        }
      }
      // Advance the snapshot only when the wallet was reachable (else we'd compare against stale zero).
      this.prevWalletTotal = recon.wallet.total;
      this.prevWalletCheckAt = nowSec;
    }

    // ── Unrecorded wallet send (out-of-band `grin-wallet send` — the DIRECT detector) ──
    if (this.enabledAlerts.unrecorded_wallet_send) {
      await this.checkUnrecordedSends();
    }
  }

  /**
   * Match the wallet's own confirmed outbound sends against the pool's withdrawals. Any send with
   * no matching pool payout is an out-of-band `grin-wallet send` (operator sweep or theft) —
   * invisible to the SQLite ledger. Legit miner payouts always have a withdrawals row, so they
   * match and never trip this. Critical + auto-freeze once the unrecorded total clears a floor.
   */
  async checkUnrecordedSends() {
    let audit;
    try {
      audit = await auditWalletSends(this.db, this.wallet, {});
    } catch (e) {
      this.error(`Wallet-send audit failed: ${e.message}`);
      return;
    }
    if (!audit.reachable) return; // wallet unreachable — skip, don't alarm

    if (audit.unrecorded.length > 0 && audit.total_unrecorded >= this.thresholds.unrecorded_send_min_grin) {
      const top = audit.unrecorded.slice().sort((a, b) => b.amount - a.amount).slice(0, 5);
      const lines = top.map((s) => `${s.amount.toFixed(4)} GRIN @ ${new Date(s.when * 1000).toISOString()}`).join('; ');
      await this.triggerAlert('unrecorded_wallet_send', {
        level: 'critical',
        message: `${audit.unrecorded.length} wallet send(s) totalling ${audit.total_unrecorded.toFixed(4)} GRIN have NO matching pool payout — out-of-band grin-wallet send (sweep or theft). Top: ${lines}`,
        data: { count: audit.unrecorded.length, total_unrecorded: audit.total_unrecorded, sends: top }
      });
      await this._maybeFreeze(`${audit.unrecorded.length} unrecorded wallet send(s), ${audit.total_unrecorded.toFixed(4)} GRIN`);
    } else {
      await this.resolveAlert('unrecorded_wallet_send');
    }
  }

  /**
   * Withdrawal-anomaly checks: a large single payout, or a 24h payout surge. Warning-level
   * (a legit whale cashing out shouldn't freeze the pool — coverage/integrity/drain do that).
   */
  async checkWithdrawalAnomalies() {
    try {
      const totalOwed = this.db.prepare(
        `SELECT COALESCE(SUM(balance),0) + COALESCE(SUM(balance_locked),0) AS t FROM miner_accounts`
      ).get().t;
      const windowStart = Math.floor(Date.now() / 1000) - Math.floor(this.moneyCheckIntervalMs / 1000) - 5;
      // Early/small pool: percentage-based bounds are meaningless when holdings are tiny (a normal
      // payout is a big fraction), so below the floor we use the FIXED GRIN thresholds only. This
      // is purely about warning NOISE — these two checks never freeze payouts.
      const smallPool = totalOwed < this.thresholds.small_pool_floor_grin;

      // Large SINGLE withdrawal created since the last money check (fixed GRIN OR % of holdings).
      if (this.enabledAlerts.large_withdrawal) {
        const fixed = this.thresholds.large_withdrawal_grin;
        const pct = smallPool ? 0 : totalOwed * (this.thresholds.large_withdrawal_percent / 100);
        const trip = pct > 0 ? Math.min(fixed, pct) : fixed; // whichever bound is hit first
        const big = this.db.prepare(
          `SELECT id, grin_address, amount FROM withdrawals
           WHERE created_at >= ? AND amount >= ? ORDER BY amount DESC LIMIT 1`
        ).get(windowStart, trip);
        if (big) {
          const extreme = big.amount >= Math.max(fixed, pct); // exceeds BOTH bounds → critical
          await this.triggerAlert('large_withdrawal', {
            level: extreme ? 'critical' : 'warning',
            message: `Large withdrawal: ${big.amount.toFixed(4)} GRIN (#${big.id}) to ${big.grin_address}.`,
            data: { withdrawal_id: big.id, amount: big.amount, address: big.grin_address, fixed_threshold: fixed, percent_threshold: pct }
          });
        } else {
          await this.resolveAlert('large_withdrawal');
        }
      }

      // 24h payout SURGE — total confirmed payouts in the last 24h above a % of pool holdings.
      // Skipped for a small/early pool (percentage is nuisance-noisy there).
      if (this.enabledAlerts.payout_surge && totalOwed > 0 && !smallPool) {
        const paid24 = this.db.prepare(
          `SELECT COALESCE(SUM(amount),0) AS s FROM withdrawals WHERE status='confirmed' AND confirmed_at > unixepoch() - 86400`
        ).get().s;
        const surgeThreshold = totalOwed * (this.thresholds.payout_surge_percent / 100);
        if (paid24 > surgeThreshold) {
          await this.triggerAlert('payout_surge', {
            level: 'warning',
            message: `Payout surge: ${paid24.toFixed(2)} GRIN paid in 24h (> ${this.thresholds.payout_surge_percent}% of ${totalOwed.toFixed(2)} owed).`,
            data: { paid_24h: paid24, threshold: surgeThreshold, total_owed: totalOwed }
          });
        } else {
          await this.resolveAlert('payout_surge');
        }
      }
    } catch (err) {
      this.error(`Withdrawal anomaly check failed: ${err.message}`);
    }
  }

  /**
   * Wallet-identity guard — the "did the pool wallet get switched under us?" tripwire. Compares
   * the live wallet's slatepack address (index 0, seed-deterministic) against the adopted anchor.
   * A mismatch = a different wallet is answering at the owner API (accidental repoint, wrong-seed
   * restore, or theft) → CRITICAL + auto-freeze, even if balances happen to match. On first use it
   * adopts silently (TOFU); an unreachable wallet is skipped (never read as a mismatch). A PLANNED
   * switch clears this by re-adopting via POST /api/admin/wallet/adopt-identity (the switch wizard).
   */
  async checkWalletIdentity() {
    let id;
    try {
      id = await probeWalletIdentity(this.db, this.wallet);
    } catch (e) {
      this.error(`Wallet-identity probe failed: ${e.message}`);
      return;
    }
    if (!id.reachable) return; // can't observe the wallet → don't change alert state
    if (id.firstRun) {
      this.log(`Wallet identity adopted on first use: ${id.live}`);
      return;
    }
    if (id.match) {
      await this.resolveAlert('wallet_identity_changed');
      return;
    }
    await this.triggerAlert('wallet_identity_changed', {
      level: 'critical',
      message: `Pool wallet identity CHANGED — the wallet answering the owner API (${id.live}) is not the adopted wallet (${id.expected}). Payouts frozen. If you switched wallets intentionally, complete the wallet-switch wizard to adopt the new wallet; otherwise investigate immediately.`,
      data: { expected: id.expected, live: id.live, adopted_at: id.adopted_at }
    });
    await this._maybeFreeze(`wallet identity changed (unrecognized wallet ${id.live} at owner API)`);
  }

  /**
   * Auto-freeze the withdrawal scheduler on a critical money trip (idempotent — no-op if already
   * frozen or if auto-freeze is disabled).
   */
  async _maybeFreeze(reason) {
    if (!this.autoFreezeOnCritical) return;
    const sched = this.withdrawalScheduler;
    if (!sched || typeof sched.freeze !== 'function') return;
    if (typeof sched.isFrozen === 'function' && sched.isFrozen()) return;
    sched.freeze(reason, 'alert_monitor');
    this.log(`AUTO-FROZE payouts: ${reason}`);
  }

  /**
   * Check if node is reachable and synced
   */
  async checkNodeHealth() {
    try {
      // getStatus() resolves (it doesn't throw) with { ok, synced, peer_count, ... }.
      const status = await this.blockMonitor.grinNode.getStatus();

      if (!status.ok) {
        // Node API unreachable / errored — critical.
        await this.triggerAlert('node_down', {
          level: 'critical',
          message: `Node API unreachable: ${status.error || 'no response'}`,
          data: { error: status.error || null }
        });
        return;
      }

      const isSynced = status.synced === true;
      const peerCount = status.peer_count || 0;

      if (!isSynced) {
        // Node not synced — could be catching up (temporary) or stuck
        await this.triggerAlert('node_down', {
          level: 'warning',
          message: `Node not synced (${status.sync_status}). Height: ${status.height}, Network: ${status.network_height}`,
          data: { height: status.height, network_height: status.network_height, sync_status: status.sync_status }
        });
      } else if (peerCount < 2) {
        // Few peers — connectivity issue
        await this.triggerAlert('node_down', {
          level: 'warning',
          message: `Low peer count: ${peerCount} peers (minimum 3 recommended)`,
          data: { peer_count: peerCount }
        });
      } else {
        // Node healthy — resolve any previous alerts
        await this.resolveAlert('node_down');
      }

    } catch (err) {
      // Node unreachable — critical
      await this.triggerAlert('node_down', {
        level: 'critical',
        message: `Node API unreachable: ${err.message}`,
        data: { error: err.message }
      });
    }
  }

  /**
   * Check wallet balance and connectivity
   */
  async checkWalletHealth() {
    if (!this.wallet || typeof this.wallet.getBalance !== 'function') return; // no wallet wired

    // A successful Owner-API retrieve_summary_info both proves the wallet is reachable AND
    // gives the balance. retrieve_summary_info returns [was_refreshed, WalletInfo] with the
    // amounts as nanoGRIN strings, so convert to GRIN. A throw → wallet offline.
    let info;
    try {
      const summary = await this.wallet.getBalance();
      info = Array.isArray(summary) ? summary[1] : summary;
    } catch (err) {
      await this.triggerAlert('wallet_offline', {
        level: 'critical',
        message: `Wallet unreachable: ${err.message}`,
        data: { error: err.message }
      });
      return;
    }

    await this.resolveAlert('wallet_offline');

    if (this.enabledAlerts.wallet_balance_low) {
      const spendable = Number((info && info.amount_currently_spendable) || 0) / 1e9;
      if (spendable < this.thresholds.wallet_balance_warning_grin) {
        await this.triggerAlert('wallet_balance_low', {
          level: 'warning',
          message: `Wallet spendable balance ${spendable.toFixed(2)} GRIN below warning threshold (${this.thresholds.wallet_balance_warning_grin} GRIN)`,
          data: { spendable, threshold: this.thresholds.wallet_balance_warning_grin }
        });
      } else {
        await this.resolveAlert('wallet_balance_low');
      }
    }
  }

  /**
   * Check stratum metrics (rejection rate, errors)
   */
  async checkStratumHealth() {
    try {
      // getStats() exposes per-session counters (accepted/rejected/stale) in sessions[].
      // Aggregate them for a live rejection rate; stale shares count as "bad".
      const stats = this.stratumServer.getStats();
      const sessions = stats.sessions || [];
      let accepted = 0, bad = 0;
      for (const s of sessions) {
        accepted += s.accepted || 0;
        bad += (s.rejected || 0) + (s.stale || 0);
      }
      const totalShares = accepted + bad;

      if (this.enabledAlerts.high_rejection_rate && totalShares > 0) {
        const rejectionRate = (bad / totalShares) * 100;

        if (rejectionRate > this.thresholds.rejection_rate_warning_percent) {
          await this.triggerAlert('high_rejection_rate', {
            level: 'warning',
            message: `High share rejection rate: ${rejectionRate.toFixed(2)}% (threshold: ${this.thresholds.rejection_rate_warning_percent}%)`,
            data: { rejection_rate: rejectionRate, accepted, rejected: bad }
          });
        } else {
          await this.resolveAlert('high_rejection_rate');
        }
      }

    } catch (err) {
      this.error(`Stratum health check failed: ${err.message}`);
    }
  }

  /**
   * Check for failed payouts
   */
  async checkPayoutHealth() {
    try {
      // withdrawals.status uses 'tor_failed' for an exhausted/failed payout, and created_at
      // is an INTEGER unixepoch (compare with unixepoch() arithmetic, not datetime('now')).
      const stmt = this.db.prepare(`
        SELECT COUNT(*) as failed_count, MAX(created_at) as last_failure
        FROM withdrawals
        WHERE status = 'tor_failed' AND created_at > unixepoch() - 86400
      `);
      const result = stmt.get();

      if (result.failed_count > 0) {
        await this.triggerAlert('payout_failed', {
          level: 'warning',
          message: `${result.failed_count} failed withdrawals in last 24 hours`,
          data: { failed_count: result.failed_count, last_failure: result.last_failure }
        });
      } else {
        await this.resolveAlert('payout_failed');
      }

    } catch (err) {
      this.error(`Payout health check failed: ${err.message}`);
    }
  }

  /**
   * Check for orphaned blocks
   */
  async checkOrphanedBlocks() {
    try {
      // blocks.found_at is an INTEGER unixepoch — compare with unixepoch() arithmetic.
      const stmt = this.db.prepare(`
        SELECT COUNT(*) as orphaned_count
        FROM blocks
        WHERE status = 'orphaned' AND found_at > unixepoch() - 86400
      `);
      const result = stmt.get();

      if (result.orphaned_count > 0) {
        await this.triggerAlert('block_orphaned', {
          level: 'warning',
          message: `${result.orphaned_count} orphaned blocks in last 24 hours`,
          data: { orphaned_count: result.orphaned_count }
        });
      } else {
        await this.resolveAlert('block_orphaned');
      }

    } catch (err) {
      this.error(`Orphan block check failed: ${err.message}`);
    }
  }

  /**
   * Trigger an alert (or update existing one)
   */
  async triggerAlert(alertType, details) {
    try {
      const now = new Date().toISOString();

      // Check if alert already exists and is active
      const stmt = this.db.prepare(`
        SELECT id, occurrence_count FROM alerts
        WHERE type = ? AND status = 'active'
        ORDER BY triggered_at DESC LIMIT 1
      `);
      const existing = stmt.get(alertType);

      if (existing) {
        // Update existing alert
        const updateStmt = this.db.prepare(`
          UPDATE alerts
          SET occurrence_count = occurrence_count + 1, last_seen = ?
          WHERE id = ?
        `);
        updateStmt.run(now, existing.id);
        return;
      }

      // Create new alert
      const insertStmt = this.db.prepare(`
        INSERT INTO alerts (type, level, message, data, status, triggered_at, last_seen)
        VALUES (?, ?, ?, ?, 'active', ?, ?)
      `);
      const result = insertStmt.run(
        alertType,
        details.level || 'warning',
        details.message,
        JSON.stringify(details.data || {}),
        now,
        now
      );

      this.log(`Alert triggered: ${alertType} (level: ${details.level})`);

      // Deliver alert (email, webhook, etc.)
      await this.deliverAlert(result.lastInsertRowid, alertType, details);

    } catch (err) {
      this.error(`Failed to trigger alert: ${err.message}`);
    }
  }

  /**
   * Resolve an alert (mark as resolved)
   */
  async resolveAlert(alertType) {
    try {
      const stmt = this.db.prepare(`
        UPDATE alerts
        SET status = 'resolved', resolved_at = datetime('now')
        WHERE type = ? AND status = 'active'
      `);
      const result = stmt.run(alertType);

      if (result.changes > 0) {
        this.log(`Alert resolved: ${alertType}`);
      }

    } catch (err) {
      this.error(`Failed to resolve alert: ${err.message}`);
    }
  }

  /**
   * Deliver alert via configured channels
   */
  async deliverAlert(alertId, alertType, details) {
    if (!this.alertDelivery || typeof this.alertDelivery.send !== 'function') return;
    try {
      // Hand the alert to AlertDelivery, which fans out to the configured channels
      // (Discord/Slack over HTTPS; email is a documented stub pending an SMTP transport).
      // It expects data as a JSON string (formatEmailBody re-parses it).
      await this.alertDelivery.send({
        type: alertType,
        level: details.level || 'warning',
        message: details.message,
        occurrence_count: 1,
        triggered_at: new Date().toISOString(),
        data: JSON.stringify(details.data || {})
      });
    } catch (err) {
      this.error(`Alert delivery failed: ${err.message}`);
    }
  }

  /**
   * Get active alerts
   */
  getActiveAlerts() {
    try {
      const stmt = this.db.prepare(`
        SELECT * FROM alerts
        WHERE status = 'active'
        ORDER BY triggered_at DESC
      `);
      return stmt.all();
    } catch (err) {
      this.error(`Failed to get active alerts: ${err.message}`);
      return [];
    }
  }

  /**
   * Get alert history (resolved)
   */
  getResolvedAlerts(limit = 50) {
    try {
      const stmt = this.db.prepare(`
        SELECT * FROM alerts
        WHERE status = 'resolved'
        ORDER BY resolved_at DESC
        LIMIT ?
      `);
      return stmt.all(limit);
    } catch (err) {
      this.error(`Failed to get resolved alerts: ${err.message}`);
      return [];
    }
  }

  /**
   * Acknowledge alert (admin has seen it)
   */
  acknowledgeAlert(alertId) {
    try {
      const stmt = this.db.prepare(`
        UPDATE alerts
        SET acknowledged_at = datetime('now'), acknowledged_by = 'admin'
        WHERE id = ?
      `);
      stmt.run(alertId);
      this.log(`Alert ${alertId} acknowledged`);
      return true;
    } catch (err) {
      this.error(`Failed to acknowledge alert: ${err.message}`);
      return false;
    }
  }

  /**
   * Snooze alert (hide for N minutes)
   */
  snoozeAlert(alertId, snoozeMinutes = 60) {
    try {
      const snoozeUntil = new Date(Date.now() + snoozeMinutes * 60000).toISOString();
      const stmt = this.db.prepare(`
        UPDATE alerts
        SET snoozed_until = ?
        WHERE id = ?
      `);
      stmt.run(snoozeUntil, alertId);
      this.log(`Alert ${alertId} snoozed for ${snoozeMinutes} minutes`);
      return true;
    } catch (err) {
      this.error(`Failed to snooze alert: ${err.message}`);
      return false;
    }
  }

  log(msg) {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] [AlertMonitor] ${msg}`);
  }

  error(msg) {
    const timestamp = new Date().toISOString();
    console.error(`[${timestamp}] [AlertMonitor] ERROR: ${msg}`);
  }
}

module.exports = AlertMonitor;
