const { getDb } = require('./db');
const WalletTor = require('./wallet-tor');
const IncentivesManager = require('./incentives');

class WithdrawalScheduler {
  constructor(config) {
    this.config = config;
    this.db = getDb();
    this.walletTor = new WalletTor(config);
    this.incentives = new IncentivesManager(config);
    this.isRunning = false;
    this.checkInterval = 60000;
    this.retryDelays = config.withdrawal_retry_delays || [
      6 * 3600,
      12 * 3600,
      24 * 3600,
      48 * 3600
    ];
    // FIX #7: Limit concurrent withdrawals to prevent DoS
    this.MAX_PENDING_WITHDRAWALS = 100;
    this.MAX_USER_PENDING = 10;
  }

  start() {
    if (this.isRunning) return;

    this.isRunning = true;
    console.log(`[${new Date().toISOString()}] Withdrawal scheduler started`);

    this.schedulerLoop();
  }

  async schedulerLoop() {
    while (this.isRunning) {
      try {
        await this.processRetryQueue();
        await this.processTorChecks();
      } catch (err) {
        console.error(`[ERROR] Withdrawal scheduler error: ${err.message}`);
      }

      await this.sleep(this.checkInterval);
    }
  }

  async processRetryQueue() {
    try {
      const now = Math.floor(Date.now() / 1000);

      const stmt = this.db.prepare(`
        SELECT * FROM withdrawals
        WHERE status = 'retry_scheduled' AND next_retry_at <= ?
        ORDER BY next_retry_at ASC
        LIMIT 10
      `);

      const pendingRetries = stmt.all(now);

      for (const withdrawal of pendingRetries) {
        await this.initiateWithdrawal(withdrawal.id);
      }
    } catch (err) {
      console.error(`Error processing retry queue: ${err.message}`);
    }
  }

  async processTorChecks() {
    try {
      const stmt = this.db.prepare(`
        SELECT * FROM withdrawals
        WHERE status = 'tor_checking'
        ORDER BY created_at ASC
        LIMIT 5
      `);

      const checking = stmt.all();

      for (const withdrawal of checking) {
        await this.checkTorAndSend(withdrawal);
      }
    } catch (err) {
      console.error(`Error processing Tor checks: ${err.message}`);
    }
  }

  async checkTorAndSend(withdrawal) {
    try {
      const torStatus = await this.walletTor.probeToronlineStatus(
        withdrawal.grin_address,
        this.config.tor_check_timeout_ms
      );

      const stmt = this.db.prepare(`
        UPDATE withdrawals SET tor_check_result = ? WHERE id = ?
      `);
      stmt.run(torStatus.online ? 'online' : 'offline', withdrawal.id);

      if (torStatus.online) {
        await this.sendWithdrawal(withdrawal.id);
      } else {
        if (withdrawal.retry_count < this.retryDelays.length) {
          await this.scheduleRetry(withdrawal.id);
        } else {
          await this.markFailed(withdrawal.id);
        }
      }
    } catch (err) {
      console.error(`Error checking Tor for withdrawal ${withdrawal.id}: ${err.message}`);
    }
  }

  async initiateWithdrawal(withdrawalId) {
    try {
      const withdrawal = this.db.prepare(`
        SELECT * FROM withdrawals WHERE id = ?
      `).get(withdrawalId);

      if (!withdrawal) return;

      const stmt = this.db.prepare(`
        UPDATE withdrawals SET status = 'tor_checking' WHERE id = ?
      `);
      stmt.run(withdrawalId);

      const eventStmt = this.db.prepare(`
        INSERT INTO withdrawal_events
        (withdrawal_id, from_status, to_status, triggered_by)
        VALUES (?, ?, ?, 'scheduler')
      `);
      eventStmt.run(withdrawalId, 'retry_scheduled', 'tor_checking');

      console.log(
        `[${new Date().toISOString()}] Withdrawal ${withdrawalId} moved to tor_checking (retry #${withdrawal.retry_count})`
      );

      await this.checkTorAndSend(withdrawal);
    } catch (err) {
      console.error(`Error initiating withdrawal ${withdrawalId}: ${err.message}`);
    }
  }

  async sendWithdrawal(withdrawalId) {
    try {
      const withdrawal = this.db.prepare(`
        SELECT * FROM withdrawals WHERE id = ?
      `).get(withdrawalId);

      if (!withdrawal) return;

      const stmt = this.db.prepare(`
        UPDATE withdrawals SET status = 'tor_sending' WHERE id = ?
      `);
      stmt.run(withdrawalId);

      const eventStmt = this.db.prepare(`
        INSERT INTO withdrawal_events
        (withdrawal_id, from_status, to_status, triggered_by)
        VALUES (?, ?, ?, 'scheduler')
      `);
      eventStmt.run(withdrawalId, 'tor_checking', 'tor_sending');

      const sendResult = await this.walletTor.sendToTorAddress(
        withdrawal.grin_address,
        withdrawal.amount
      );

      if (sendResult.success) {
        await this.markConfirmed(withdrawalId, sendResult.output);
      } else {
        console.error(`Send failed for withdrawal ${withdrawalId}: ${sendResult.error}`);
        await this.scheduleRetry(withdrawalId);
      }
    } catch (err) {
      console.error(`Error sending withdrawal ${withdrawalId}: ${err.message}`);
      await this.scheduleRetry(withdrawalId);
    }
  }

  async scheduleRetry(withdrawalId) {
    try {
      const withdrawal = this.db.prepare(`
        SELECT * FROM withdrawals WHERE id = ?
      `).get(withdrawalId);

      if (!withdrawal) return;

      if (withdrawal.retry_count >= this.retryDelays.length) {
        await this.markFailed(withdrawalId);
        return;
      }

      const nextRetryDelay = this.retryDelays[withdrawal.retry_count];
      const nextRetryAt = Math.floor(Date.now() / 1000) + nextRetryDelay;

      const stmt = this.db.prepare(`
        UPDATE withdrawals
        SET status = 'retry_scheduled', retry_count = retry_count + 1, next_retry_at = ?
        WHERE id = ?
      `);
      stmt.run(nextRetryAt, withdrawalId);

      const eventStmt = this.db.prepare(`
        INSERT INTO withdrawal_events
        (withdrawal_id, from_status, to_status, triggered_by, note)
        VALUES (?, ?, ?, 'scheduler', ?)
      `);
      eventStmt.run(
        withdrawalId,
        withdrawal.status,
        'retry_scheduled',
        `Retry ${withdrawal.retry_count + 1}/${this.retryDelays.length} at ${new Date(nextRetryAt * 1000).toISOString()}`
      );

      console.log(
        `[${new Date().toISOString()}] Withdrawal ${withdrawalId} scheduled for retry (attempt ${withdrawal.retry_count + 1})`
      );
    } catch (err) {
      console.error(`Error scheduling retry for withdrawal ${withdrawalId}: ${err.message}`);
    }
  }

  async markConfirmed(withdrawalId, txOutput = null) {
    try {
      const stmt = this.db.prepare(`
        UPDATE withdrawals SET status = 'confirmed', confirmed_at = unixepoch() WHERE id = ?
      `);
      stmt.run(withdrawalId);

      const eventStmt = this.db.prepare(`
        INSERT INTO withdrawal_events
        (withdrawal_id, from_status, to_status, triggered_by, note)
        VALUES (?, ?, ?, 'scheduler', ?)
      `);
      eventStmt.run(withdrawalId, 'tor_sending', 'confirmed', 'Successfully sent');

      const withdrawal = this.db.prepare(
        'SELECT * FROM withdrawals WHERE id = ?'
      ).get(withdrawalId);

      const balanceStmt = this.db.prepare(`
        UPDATE miner_accounts
        SET balance_locked = CASE
          WHEN balance_locked >= ? THEN balance_locked - ?
          ELSE 0
        END
        WHERE grin_address = ?
      `);
      balanceStmt.run(withdrawal.amount, withdrawal.amount, withdrawal.grin_address);

      const logStmt = this.db.prepare(`
        INSERT INTO balance_log
        (grin_address, event_type, amount, balance_before, balance_after,
         locked_before, locked_after, reference_type, reference_id)
        VALUES (?, 'debit', ?, 0, 0, 0, 0, 'withdrawal', ?)
      `);
      logStmt.run(withdrawal.grin_address, withdrawal.amount, withdrawalId);

      console.log(
        `[${new Date().toISOString()}] Withdrawal ${withdrawalId} confirmed (${withdrawal.amount} GRIN to ${withdrawal.grin_address})`
      );

      // First successful withdrawal qualifies the address for the one-time join bonus
      // (anti-Sybil gate: spammers never reach a real payout). No-op unless enabled / funded.
      try {
        this.incentives.maybePayJoinBonus(withdrawal.grin_address);
      } catch (e) {
        console.error(`Error paying join bonus for ${withdrawal.grin_address}: ${e.message}`);
      }
    } catch (err) {
      console.error(`Error marking withdrawal as confirmed: ${err.message}`);
    }
  }

  async markFailed(withdrawalId) {
    try {
      const stmt = this.db.prepare(`
        UPDATE withdrawals SET status = 'tor_failed' WHERE id = ?
      `);
      stmt.run(withdrawalId);

      const eventStmt = this.db.prepare(`
        INSERT INTO withdrawal_events
        (withdrawal_id, from_status, to_status, triggered_by, note)
        VALUES (?, ?, ?, 'scheduler', ?)
      `);
      eventStmt.run(withdrawalId, 'retry_scheduled', 'tor_failed', 'Max retries exceeded');

      const withdrawal = this.db.prepare(
        'SELECT * FROM withdrawals WHERE id = ?'
      ).get(withdrawalId);

      const balanceStmt = this.db.prepare(`
        UPDATE miner_accounts SET balance = balance + ?, balance_locked = balance_locked - ?
        WHERE grin_address = ?
      `);
      balanceStmt.run(withdrawal.amount, withdrawal.amount, withdrawal.grin_address);

      const logStmt = this.db.prepare(`
        INSERT INTO balance_log
        (grin_address, event_type, amount, balance_before, balance_after,
         locked_before, locked_after, reference_type, reference_id)
        VALUES (?, 'reversal', ?, 0, 0, 0, 0, 'withdrawal', ?)
      `);
      logStmt.run(withdrawal.grin_address, withdrawal.amount, withdrawalId);

      console.warn(
        `⚠️  Withdrawal ${withdrawalId} failed after max retries (${withdrawal.amount} GRIN reversed to balance)`
      );
    } catch (err) {
      console.error(`Error marking withdrawal as failed: ${err.message}`);
    }
  }

  // FIX #7: Check withdrawal rate limits to prevent DoS
  async canInitiateWithdrawal(grinAddress) {
    try {
      // Check total pending withdrawals
      const totalPending = this.db.prepare(
        "SELECT COUNT(*) as count FROM withdrawals WHERE status IN ('tor_checking', 'tor_sending', 'retry_scheduled')"
      ).get();

      if (totalPending.count >= this.MAX_PENDING_WITHDRAWALS) {
        throw new Error(`Pool has reached maximum pending withdrawals (${this.MAX_PENDING_WITHDRAWALS}). Try again later.`);
      }

      // Check user's pending withdrawals
      const userPending = this.db.prepare(
        "SELECT COUNT(*) as count FROM withdrawals WHERE grin_address = ? AND status IN ('tor_checking', 'tor_sending', 'retry_scheduled')"
      ).get(grinAddress);

      if (userPending.count >= this.MAX_USER_PENDING) {
        throw new Error(`You have too many pending withdrawals (${this.MAX_USER_PENDING}). Wait for them to complete.`);
      }

      return true;
    } catch (err) {
      throw err;
    }
  }

  getStatus() {
    try {
      const pending = this.db.prepare(
        "SELECT COUNT(*) as count FROM withdrawals WHERE status IN ('tor_checking', 'tor_sending', 'retry_scheduled')"
      ).get();

      const confirmed = this.db.prepare(
        "SELECT COUNT(*) as count FROM withdrawals WHERE status = 'confirmed'"
      ).get();

      const failed = this.db.prepare(
        "SELECT COUNT(*) as count FROM withdrawals WHERE status = 'tor_failed'"
      ).get();

      return {
        running: this.isRunning,
        pending: pending.count,
        confirmed: confirmed.count,
        failed: failed.count
      };
    } catch (err) {
      return {
        running: this.isRunning,
        error: err.message
      };
    }
  }

  stop() {
    this.isRunning = false;
    console.log(`[${new Date().toISOString()}] Withdrawal scheduler stopped`);
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = WithdrawalScheduler;
