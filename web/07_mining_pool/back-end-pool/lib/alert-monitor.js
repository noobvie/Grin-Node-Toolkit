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

class AlertMonitor {
  constructor(config, modules, db) {
    this.config = config;
    this.blockMonitor = modules.blockMonitor;
    this.walletTor = modules.walletTor;
    this.stratumServer = modules.stratumServer;
    this.withdrawalScheduler = modules.withdrawalScheduler;
    this.db = db;

    this.monitorInterval = null;
    this.checkIntervalMs = (config.alert_check_interval_secs || 60) * 1000;

    // Track previous states to avoid duplicate alerts
    this.previousStates = {
      node_status: 'unknown',
      wallet_status: 'unknown',
      stratum_status: 'unknown'
    };

    // Alert thresholds (from config or defaults)
    this.thresholds = {
      wallet_balance_warning_grin: config.alert_thresholds?.wallet_balance_warning_grin || 50,
      rejection_rate_warning_percent: config.alert_thresholds?.rejection_rate_warning_percent || 1.0,
      error_rate_warning_percent: config.alert_thresholds?.error_rate_warning_percent || 5.0,
      difficulty_change_warning_percent: config.alert_thresholds?.difficulty_change_warning_percent || 20.0
    };

    // Alert enablement
    this.enabledAlerts = config.alert_types_enabled || {
      node_down: true,
      wallet_offline: true,
      wallet_balance_low: true,
      block_orphaned: true,
      payout_failed: true,
      high_rejection_rate: true,
      high_error_rate: false,
      tor_unreachable: true,
      difficulty_spike: false,
      connection_surge: false
    };

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

    } catch (err) {
      this.error(`Health check failed: ${err.message}`);
    }
  }

  /**
   * Check if node is reachable and synced
   */
  async checkNodeHealth() {
    try {
      const status = await this.blockMonitor.grinNode.getStatus();
      const isSynced = status.sync_status === 'Synced';
      const peerCount = status.connected_peers || 0;

      if (!isSynced) {
        // Node not synced — could be catching up (temporary) or stuck
        await this.triggerAlert('node_down', {
          level: 'warning',
          message: `Node not synced. Height: ${status.height}, Network: ${status.network_height}`,
          data: { height: status.height, network_height: status.network_height }
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
    try {
      const walletStatus = await this.walletTor.checkHealth();

      if (!walletStatus.online) {
        // Wallet offline
        await this.triggerAlert('wallet_offline', {
          level: 'critical',
          message: `Wallet offline: ${walletStatus.error || 'No response'}`,
          data: { error: walletStatus.error }
        });
      } else {
        // Wallet online — check balance
        const balance = walletStatus.balance || 0;

        if (balance < this.thresholds.wallet_balance_warning_grin) {
          await this.triggerAlert('wallet_balance_low', {
            level: 'warning',
            message: `Wallet balance ${balance.toFixed(2)} GRIN below warning threshold (${this.thresholds.wallet_balance_warning_grin} GRIN)`,
            data: { balance, threshold: this.thresholds.wallet_balance_warning_grin }
          });
        } else {
          // Wallet healthy
          await this.resolveAlert('wallet_offline');
          await this.resolveAlert('wallet_balance_low');
        }

        // Check Tor connectivity
        if (this.enabledAlerts.tor_unreachable && !walletStatus.tor_reachable) {
          await this.triggerAlert('tor_unreachable', {
            level: 'warning',
            message: 'Tor proxy unreachable — payouts may fail',
            data: { tor_status: walletStatus.tor_status }
          });
        } else {
          await this.resolveAlert('tor_unreachable');
        }
      }

    } catch (err) {
      await this.triggerAlert('wallet_offline', {
        level: 'critical',
        message: `Wallet health check failed: ${err.message}`,
        data: { error: err.message }
      });
    }
  }

  /**
   * Check stratum metrics (rejection rate, errors)
   */
  async checkStratumHealth() {
    try {
      const stats = this.stratumServer.getStats();
      const sharesAccepted = stats.shares_accepted_1h || 0;
      const sharesRejected = stats.shares_rejected_1h || 0;
      const totalShares = sharesAccepted + sharesRejected;

      if (totalShares > 0) {
        const rejectionRate = (sharesRejected / totalShares) * 100;

        if (rejectionRate > this.thresholds.rejection_rate_warning_percent) {
          await this.triggerAlert('high_rejection_rate', {
            level: 'warning',
            message: `High share rejection rate: ${rejectionRate.toFixed(2)}% (threshold: ${this.thresholds.rejection_rate_warning_percent}%)`,
            data: { rejection_rate: rejectionRate, accepted: sharesAccepted, rejected: sharesRejected }
          });
        } else {
          await this.resolveAlert('high_rejection_rate');
        }
      }

      // Check error rate
      const connectionErrors = stats.connection_errors_1h || 0;
      const totalConnections = (stats.successful_connections_1h || 0) + connectionErrors;

      if (totalConnections > 0) {
        const errorRate = (connectionErrors / totalConnections) * 100;

        if (errorRate > this.thresholds.error_rate_warning_percent) {
          await this.triggerAlert('high_error_rate', {
            level: 'warning',
            message: `High error rate: ${errorRate.toFixed(2)}% (threshold: ${this.thresholds.error_rate_warning_percent}%)`,
            data: { error_rate: errorRate, errors: connectionErrors, total: totalConnections }
          });
        } else {
          await this.resolveAlert('high_error_rate');
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
      const stmt = this.db.prepare(`
        SELECT COUNT(*) as failed_count, MAX(updated_at) as last_failure
        FROM withdrawals
        WHERE status = 'failed' AND updated_at > datetime('now', '-24 hours')
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
      const stmt = this.db.prepare(`
        SELECT COUNT(*) as orphaned_count
        FROM blocks
        WHERE status = 'orphaned' AND found_at > datetime('now', '-24 hours')
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
    try {
      const level = details.level || 'warning';

      // Email delivery (if configured)
      if (this.config.alert_email_address) {
        // Stub — implement email delivery
        this.log(`Would send email to ${this.config.alert_email_address} for ${alertType}`);
      }

      // Discord webhook (if configured)
      if (this.config.discord_webhook_url) {
        // Stub — implement Discord delivery
        this.log(`Would send Discord message for ${alertType}`);
      }

      // Slack webhook (if configured)
      if (this.config.slack_webhook_url) {
        // Stub — implement Slack delivery
        this.log(`Would send Slack message for ${alertType}`);
      }

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
