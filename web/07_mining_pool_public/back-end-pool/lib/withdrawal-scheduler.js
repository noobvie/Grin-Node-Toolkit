const { getDb } = require('./db');
const WalletTor = require('./wallet-tor');
const IncentivesManager = require('./incentives');

class WithdrawalScheduler {
  constructor(config, wallet = null) {
    this.config = config;
    this.db = getDb();
    this.walletTor = new WalletTor(config);
    // WalletAPI (Owner API v3) — required only for the slatepack payout rail. Tor payouts use
    // walletTor (CLI). Left null in deployments that never enable slatepack.
    this.wallet = wallet;
    this.incentives = new IncentivesManager(config);
    this.isRunning = false;
    this.checkInterval = 60000;
    // How long an unfinalized slatepack payout stays pending before it's cancelled and the
    // locked balance is returned (the miner never imported/returned the slate).
    this.slatepackTtlSeconds = (config.slatepack_ttl_hours || 24) * 3600;
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
        if (this.isFrozen()) {
          // Kill-switch engaged (auto by AlertMonitor on a critical money trip, or manual admin).
          // Skip every OUTBOUND send path; still run slatepack expiry (it only REFUNDS expired
          // slates back to miners — safe and desirable while frozen).
          await this.processSlatepackExpiry();
        } else {
          await this.processRetryQueue();
          await this.processTorChecks();
          await this.processSlatepackExpiry();
        }
      } catch (err) {
        console.error(`[ERROR] Withdrawal scheduler error: ${err.message}`);
      }

      await this.sleep(this.checkInterval);
    }
  }

  // ─── Payout kill-switch ──────────────────────────────────────────────────────
  // State lives in payout_control (single row id=1) so it survives restarts and is shared with
  // the admin API + AlertMonitor. A missing row means "not frozen".
  isFrozen() {
    try {
      const row = this.db.prepare('SELECT frozen FROM payout_control WHERE id = 1').get();
      return !!(row && row.frozen);
    } catch (e) { return false; }
  }

  // Freeze gate for every NEW fund-moving entry point (Tor create, slatepack create, slatepack
  // finalize). The scheduler loop skipping sends is NOT enough: the slatepack rail moves coins
  // synchronously in the request (create locks wallet outputs, finalize broadcasts on-chain), so
  // without this gate a miner could complete a payout end-to-end DURING a wallet_drain /
  // integrity_drift incident — the exact scenario the kill-switch exists for. Throws the same
  // shaped 4xx the routes already map (409, like the admin retry gate). Cancels and slatepack
  // expiry stay allowed while frozen — they only refund locked balances.
  _assertNotFrozen() {
    if (this.isFrozen()) {
      const e = new Error('payouts are temporarily frozen by the pool operator — try again later');
      e.code = 409;
      throw e;
    }
  }

  freeze(reason, by) {
    try {
      const now = Math.floor(Date.now() / 1000);
      this.db.prepare(`
        INSERT INTO payout_control (id, frozen, reason, frozen_by, frozen_at, updated_at)
        VALUES (1, 1, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET frozen = 1, reason = excluded.reason,
          frozen_by = excluded.frozen_by, frozen_at = excluded.frozen_at, updated_at = excluded.updated_at
      `).run(reason || null, by || null, now, now);
      console.warn(`[${new Date().toISOString()}] ⛔ PAYOUTS FROZEN by ${by || 'unknown'}: ${reason || ''}`);
      return true;
    } catch (e) { console.error(`freeze() failed: ${e.message}`); return false; }
  }

  resume(by) {
    try {
      const now = Math.floor(Date.now() / 1000);
      this.db.prepare(`
        INSERT INTO payout_control (id, frozen, reason, frozen_by, frozen_at, updated_at)
        VALUES (1, 0, NULL, ?, NULL, ?)
        ON CONFLICT(id) DO UPDATE SET frozen = 0, reason = NULL, frozen_by = excluded.frozen_by,
          frozen_at = NULL, updated_at = excluded.updated_at
      `).run(by || null, now);
      console.warn(`[${new Date().toISOString()}] ▶ PAYOUTS RESUMED by ${by || 'unknown'}`);
      return true;
    } catch (e) { console.error(`resume() failed: ${e.message}`); return false; }
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
    // grin-wallet establishes the Tor connection to the recipient's Slatepack listener as part
    // of the send, so it is the authoritative reachability check — we attempt the send directly
    // rather than pre-probing. sendWithdrawal handles the outcome: success → confirmed; failure
    // (recipient offline, etc.) → scheduleRetry, which markFailed()s once retries are exhausted.
    try {
      await this.sendWithdrawal(withdrawal.id);
    } catch (err) {
      console.error(`Error sending withdrawal ${withdrawal.id}: ${err.message}`);
    }
  }

  async initiateWithdrawal(withdrawalId) {
    try {
      const withdrawal = this.db.prepare(`
        SELECT * FROM withdrawals WHERE id = ?
      `).get(withdrawalId);

      if (!withdrawal) return;

      // Guarded transition: only a row still in retry_scheduled may be picked up. A miner
      // cancel (or a competing pass) between the retry-queue SELECT and this call would
      // otherwise be flipped back to tor_checking AFTER its lock was reversed — double-pay.
      const claimed = this.db.prepare(`
        UPDATE withdrawals SET status = 'tor_checking' WHERE id = ? AND status = 'retry_scheduled'
      `).run(withdrawalId);
      if (claimed.changes !== 1) return;

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
        await this.recordTorFee(withdrawalId, withdrawal.amount);
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

      this._releaseLockAndDebit(withdrawal);

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

  // Create a miner-initiated withdrawal with a compare-and-swap balance lock.
  // All-or-nothing in one transaction (design §8 balance model):
  //   balance −= amount ; balance_locked += amount  (only if balance ≥ amount)
  // Then the scheduler's tor_checking → tor_sending → confirmed/failed states take over.
  // Throws an Error carrying a numeric `.code` (400/404/409/429) so the route maps it to
  // the right HTTP status. fee starts at 0 and is backfilled with the REAL network fee once
  // known (recordTorFee after a successful Tor send; _slateFeeGrin at slatepack creation).
  // The fee never enters the miner's ledger math (un-lock/reverse always move `amount`) —
  // it exists so reconciliation can explain the wallet-vs-ledger gap (sender pays fees).
  createWithdrawal(grinAddress, amount, method = 'tor') {
    const fail = (msg, code) => { const e = new Error(msg); e.code = code; throw e; };

    if (!grinAddress) fail('address required', 400);
    if (method !== 'tor') fail('only Tor withdrawals are supported', 400);
    this._assertNotFrozen();

    const acct0 = this.db.prepare(
      'SELECT balance FROM miner_accounts WHERE grin_address = ?'
    ).get(grinAddress);
    if (!acct0) fail('account not found', 404);

    // Default to the full available balance when no amount is supplied.
    let amt = amount === undefined || amount === null || amount === ''
      ? acct0.balance
      : parseFloat(amount);
    if (isNaN(amt) || amt <= 0) fail('invalid amount', 400);
    amt = parseFloat(amt.toFixed(9));

    // Withdrawals are manual with an explicit amount, so only the pool-wide floor applies
    // (the per-account min_payout override was retired 2026-07-17).
    const minW = this.config.min_withdrawal || 25.0;
    if (amt < minW) fail(`amount below minimum withdrawal (${minW} GRIN)`, 400);

    const txn = this.db.transaction(() => {
      const totalPending = this.db.prepare(
        "SELECT COUNT(*) AS c FROM withdrawals WHERE status IN ('tor_checking','tor_sending','retry_scheduled')"
      ).get().c;
      if (totalPending >= this.MAX_PENDING_WITHDRAWALS) {
        fail(`pool has reached maximum pending withdrawals (${this.MAX_PENDING_WITHDRAWALS})`, 429);
      }
      // Design §8: at most ONE pending withdrawal per address.
      const userPending = this.db.prepare(
        "SELECT COUNT(*) AS c FROM withdrawals WHERE grin_address = ? AND status IN ('tor_checking','tor_sending','retry_scheduled')"
      ).get(grinAddress).c;
      if (userPending >= 1) fail('you already have a pending withdrawal', 429);

      const before = this.db.prepare(
        'SELECT balance, balance_locked FROM miner_accounts WHERE grin_address = ?'
      ).get(grinAddress);

      // CAS: the WHERE balance >= ? makes the debit atomic — a racing request that would
      // overdraw changes 0 rows and is rejected with 409.
      const locked = this.db.prepare(
        `UPDATE miner_accounts
         SET balance = balance - ?, balance_locked = balance_locked + ?, updated_at = unixepoch()
         WHERE grin_address = ? AND balance >= ?`
      ).run(amt, amt, grinAddress, amt);
      if (locked.changes !== 1) fail('insufficient balance', 409);

      const wid = this.db.prepare(
        "INSERT INTO withdrawals (grin_address, amount, fee, status) VALUES (?, ?, 0, 'tor_checking')"
      ).run(grinAddress, amt).lastInsertRowid;

      this.db.prepare(`
        INSERT INTO balance_log
        (grin_address, event_type, amount, balance_before, balance_after, locked_before, locked_after, reference_type, reference_id)
        VALUES (?, 'lock', ?, ?, ?, ?, ?, 'withdrawal', ?)
      `).run(grinAddress, amt, before.balance, before.balance - amt,
             before.balance_locked, before.balance_locked + amt, wid);

      this.db.prepare(`
        INSERT INTO withdrawal_events (withdrawal_id, from_status, to_status, triggered_by, note)
        VALUES (?, NULL, 'tor_checking', 'miner', ?)
      `).run(wid, `withdrawal requested (${amt} GRIN)`);

      return wid;
    });

    const withdrawal_id = txn();
    console.log(`[${new Date().toISOString()}] Withdrawal ${withdrawal_id} created for ${grinAddress} (${amt} GRIN, locked)`);
    return { success: true, withdrawal_id, amount: amt };
  }

  // ─── Slatepack payout (interactive, encrypted, no-Tor) ──────────────────────
  // Reinstated rail: emits a slatepack ENCRYPTED to the miner's own address so only that wallet
  // can decrypt + receive (no theft even if the IP gate is passed by a NAT co-tenant). The IP
  // gate (verified in the route) just throttles who can trigger this. Two steps:
  //   createSlatepackWithdrawal → returns the armored slate to hand to the miner (status pending)
  //   finalizeSlatepackWithdrawal → consumes the miner's response slate, finalizes, posts, confirms

  // Same balance lock + caps as createWithdrawal, but parks the row in 'slatepack_pending' and
  // generates the encrypted slate. Returns { withdrawal_id, amount, slatepack }.
  async createSlatepackWithdrawal(grinAddress, amount) {
    const fail = (msg, code) => { const e = new Error(msg); e.code = code; throw e; };
    if (!grinAddress) fail('address required', 400);
    if (!this.wallet) fail('slatepack payouts are not configured on this pool', 503);
    this._assertNotFrozen();

    const PENDING = "status IN ('tor_checking','tor_sending','retry_scheduled','slatepack_pending')";

    const acct0 = this.db.prepare(
      'SELECT balance FROM miner_accounts WHERE grin_address = ?'
    ).get(grinAddress);
    if (!acct0) fail('account not found', 404);

    let amt = amount === undefined || amount === null || amount === '' ? acct0.balance : parseFloat(amount);
    if (isNaN(amt) || amt <= 0) fail('invalid amount', 400);
    amt = parseFloat(amt.toFixed(9));

    // Pool-wide floor only (per-account min_payout retired 2026-07-17 — manual withdrawals).
    const minW = this.config.min_withdrawal || 25.0;
    if (amt < minW) fail(`amount below minimum withdrawal (${minW} GRIN)`, 400);

    // Lock the pool-side balance first (authoritative for accounting); the wallet-side output
    // lock happens during tx_lock_outputs below, and is released via cancelTx on failure.
    const txn = this.db.transaction(() => {
      const totalPending = this.db.prepare(`SELECT COUNT(*) AS c FROM withdrawals WHERE ${PENDING}`).get().c;
      if (totalPending >= this.MAX_PENDING_WITHDRAWALS) fail(`pool has reached maximum pending withdrawals (${this.MAX_PENDING_WITHDRAWALS})`, 429);
      const userPending = this.db.prepare(`SELECT COUNT(*) AS c FROM withdrawals WHERE grin_address = ? AND ${PENDING}`).get(grinAddress).c;
      if (userPending >= 1) fail('you already have a pending withdrawal', 429);

      const before = this.db.prepare('SELECT balance, balance_locked FROM miner_accounts WHERE grin_address = ?').get(grinAddress);
      const locked = this.db.prepare(
        `UPDATE miner_accounts SET balance = balance - ?, balance_locked = balance_locked + ?, updated_at = unixepoch()
         WHERE grin_address = ? AND balance >= ?`
      ).run(amt, amt, grinAddress, amt);
      if (locked.changes !== 1) fail('insufficient balance', 409);

      const wid = this.db.prepare(
        "INSERT INTO withdrawals (grin_address, amount, fee, status, method) VALUES (?, ?, 0, 'slatepack_pending', 'slatepack')"
      ).run(grinAddress, amt).lastInsertRowid;

      this.db.prepare(`
        INSERT INTO balance_log
        (grin_address, event_type, amount, balance_before, balance_after, locked_before, locked_after, reference_type, reference_id)
        VALUES (?, 'lock', ?, ?, ?, ?, ?, 'withdrawal', ?)
      `).run(grinAddress, amt, before.balance, before.balance - amt, before.balance_locked, before.balance_locked + amt, wid);

      this.db.prepare(`
        INSERT INTO withdrawal_events (withdrawal_id, from_status, to_status, triggered_by, note)
        VALUES (?, NULL, 'slatepack_pending', 'miner', ?)
      `).run(wid, `slatepack withdrawal requested (${amt} GRIN)`);

      return wid;
    });

    const withdrawalId = txn();

    // Build the encrypted slate. On any wallet failure, cancel the wallet-side tx and reverse the
    // pool balance lock so the miner's funds are never stranded.
    let slate = null;
    try {
      slate = await this.wallet.initSendTx(amt);
      await this.wallet.txLockOutputs(slate);
      const armored = await this.wallet.createSlatepackMessage(slate, [grinAddress]);
      const slateId = slate && slate.id ? slate.id : null;
      // Record the real network fee (sender-pays in Grin: the wallet spends amount + fee while
      // the ledger debits only amount). Reconciliation reads withdrawals.fee to explain the
      // wallet-vs-ledger gap — a permanent fee = 0 makes coverage erode silently.
      const feeGrin = this._slateFeeGrin(slate);
      this.db.prepare('UPDATE withdrawals SET slate_id = ?, fee = COALESCE(?, fee) WHERE id = ?')
        .run(slateId, feeGrin, withdrawalId);
      console.log(`[${new Date().toISOString()}] Slatepack withdrawal ${withdrawalId} created for ${grinAddress} (${amt} GRIN, slate ${slateId})`);
      return { success: true, withdrawal_id: withdrawalId, amount: amt, slatepack: armored };
    } catch (err) {
      try { if (slate && slate.id) await this.wallet.cancelTx(slate.id); } catch (_) { /* best-effort */ }
      this._reverseLock(withdrawalId, 'slatepack_failed', 'slatepack_pending', `slate creation failed: ${err.message}`);
      const e = new Error(`failed to create slatepack: ${err.message}`); e.code = 502; throw e;
    }
  }

  // Consume the miner's RESPONSE slatepack, finalize, broadcast, and confirm the payout.
  async finalizeSlatepackWithdrawal(grinAddress, withdrawalId, responseSlatepack) {
    const fail = (msg, code) => { const e = new Error(msg); e.code = code; throw e; };
    if (!this.wallet) fail('slatepack payouts are not configured on this pool', 503);
    // Finalize is the on-chain broadcast — it MUST honour the kill-switch too. The row stays
    // slatepack_pending, so the miner can simply re-submit the response slate after a resume
    // (or the TTL expiry refunds the lock).
    this._assertNotFrozen();
    if (!responseSlatepack || typeof responseSlatepack !== 'string') fail('response slatepack required', 400);

    const w = this.db.prepare('SELECT * FROM withdrawals WHERE id = ?').get(withdrawalId);
    if (!w) fail('withdrawal not found', 404);
    if (w.grin_address !== grinAddress) fail('withdrawal does not belong to this address', 403);
    if (w.status !== 'slatepack_pending') fail(`withdrawal is not awaiting a slatepack (status: ${w.status})`, 409);

    let finalized;
    try {
      const slate = await this.wallet.slateFromSlatepackMessage(responseSlatepack, [0]);
      // Bind the response to the slate we issued — rejects a pasted slate for a different tx.
      if (w.slate_id && slate && slate.id && slate.id !== w.slate_id) {
        fail('slatepack does not match this withdrawal', 400);
      }
      finalized = await this.wallet.finalizeTx(slate);
      await this.wallet.postTx(finalized, true);
    } catch (err) {
      if (err.code) throw err; // our own 4xx (e.g. mismatch) — surface as-is, stay pending
      const e = new Error(`failed to finalize slatepack: ${err.message}`); e.code = 502; throw e;
    }

    this._creditConfirm(withdrawalId, 'slatepack_pending', 'slatepack finalized + posted');
    return { success: true, withdrawal_id: withdrawalId, status: 'confirmed' };
  }

  // Miner-initiated cancel: frees the one-pending-per-address slot and returns the locked
  // amount to spendable balance. Only PARKED states are cancellable — retry_scheduled (Tor
  // payout waiting hours for its next attempt) and slatepack_pending (miner never returned
  // the slate). tor_checking/tor_sending are actively being sent and must settle first.
  // The status transition is a guarded UPDATE inside a transaction, so it can never race the
  // scheduler (whose pickup is likewise guarded in initiateWithdrawal) into a double-reverse.
  async cancelWithdrawal(grinAddress, withdrawalId) {
    const fail = (msg, code) => { const e = new Error(msg); e.code = code; throw e; };
    if (!grinAddress) fail('address required', 400);

    const w = this.db.prepare('SELECT * FROM withdrawals WHERE id = ?').get(withdrawalId);
    if (!w) fail('withdrawal not found', 404);
    if (w.grin_address !== grinAddress) fail('withdrawal does not belong to this address', 403);
    if (w.status !== 'retry_scheduled' && w.status !== 'slatepack_pending') {
      fail(`withdrawal cannot be cancelled while ${w.status} — wait for the current attempt to settle`, 409);
    }

    const txn = this.db.transaction(() => {
      const claimed = this.db.prepare(
        "UPDATE withdrawals SET status = 'cancelled' WHERE id = ? AND status = ?"
      ).run(withdrawalId, w.status);
      if (claimed.changes !== 1) fail('withdrawal state changed — refresh and try again', 409);

      this.db.prepare(`
        INSERT INTO withdrawal_events (withdrawal_id, from_status, to_status, triggered_by, note)
        VALUES (?, ?, 'cancelled', 'miner', 'cancelled by miner')
      `).run(withdrawalId, w.status);

      const before = this.db.prepare(
        'SELECT balance, balance_locked FROM miner_accounts WHERE grin_address = ?'
      ).get(grinAddress);
      this.db.prepare(
        'UPDATE miner_accounts SET balance = balance + ?, balance_locked = balance_locked - ?, updated_at = unixepoch() WHERE grin_address = ?'
      ).run(w.amount, w.amount, grinAddress);
      this.db.prepare(`
        INSERT INTO balance_log
        (grin_address, event_type, amount, balance_before, balance_after, locked_before, locked_after, reference_type, reference_id)
        VALUES (?, 'reversal', ?, ?, ?, ?, ?, 'withdrawal', ?)
      `).run(grinAddress, w.amount, before.balance, before.balance + w.amount,
             before.balance_locked, Math.max(0, before.balance_locked - w.amount), withdrawalId);
    });
    txn();

    // Best-effort wallet-side cleanup — a slatepack payout locked wallet outputs at creation.
    if (w.status === 'slatepack_pending' && this.wallet && w.slate_id) {
      try { await this.wallet.cancelTx(w.slate_id); }
      catch (e) { console.warn(`[cancel] cancelTx ${w.slate_id}: ${e.message}`); }
    }

    console.log(`[${new Date().toISOString()}] Withdrawal ${withdrawalId} cancelled by miner (${w.amount} GRIN returned to ${grinAddress})`);
    return { success: true, withdrawal_id: withdrawalId, status: 'cancelled', amount: w.amount };
  }

  // Cancel + reverse slatepack payouts the miner never completed within the TTL.
  async processSlatepackExpiry() {
    try {
      const cutoff = Math.floor(Date.now() / 1000) - this.slatepackTtlSeconds;
      const stale = this.db.prepare(
        "SELECT * FROM withdrawals WHERE status = 'slatepack_pending' AND created_at <= ? ORDER BY created_at ASC LIMIT 10"
      ).all(cutoff);
      for (const w of stale) {
        if (this.wallet && w.slate_id) {
          try { await this.wallet.cancelTx(w.slate_id); } catch (e) { console.warn(`[slatepack] cancelTx ${w.slate_id}: ${e.message}`); }
        }
        this._reverseLock(w.id, 'slatepack_expired', 'slatepack_pending', 'slatepack not returned within TTL — reversed');
        console.warn(`⚠️  Slatepack withdrawal ${w.id} expired (${w.amount} GRIN reversed to ${w.grin_address})`);
      }
    } catch (err) {
      console.error(`Error processing slatepack expiry: ${err.message}`);
    }
  }

  // Network fee from a slate (V4 serialises `fee` as a nanoGRIN string; older shapes nest it
  // as an object) → GRIN, or null when absent so the caller keeps the existing column value.
  _slateFeeGrin(slate) {
    if (!slate) return null;
    let f = slate.fee;
    if (f && typeof f === 'object') f = f.fee;
    const n = Number(f);
    return Number.isFinite(n) && n > 0 ? parseFloat((n / 1e9).toFixed(9)) : null;
  }

  // The Tor rail sends via the grin-wallet CLI, which doesn't report the network fee — but the
  // wallet's own tx log does. Best-effort right after a successful send: read the newest TxSent
  // whose net recipient amount matches this payout and store its fee, so reconciliation can
  // explain the wallet-vs-ledger gap. Fee stays 0 when the Owner API isn't configured.
  async recordTorFee(withdrawalId, amountGrin) {
    if (!this.wallet || typeof this.wallet.getTransactions !== 'function') return;
    try {
      const entries = await this.wallet.getTransactions(false);
      if (!Array.isArray(entries)) return;
      const feeNano = (e) => {
        if (e.fee == null) return 0;
        if (typeof e.fee === 'object') return Number(e.fee.fee || 0) || 0;
        return Number(e.fee) || 0;
      };
      let best = null;
      for (const e of entries) {
        if (!e || e.tx_type !== 'TxSent') continue;
        const fee = feeNano(e);
        if (!fee) continue;
        const recipient = (Number(e.amount_debited || 0) - Number(e.amount_credited || 0) - fee) / 1e9;
        if (Math.abs(recipient - amountGrin) > 1e-6) continue;
        if (!best || Number(e.id || 0) > Number(best.id || 0)) best = e;
      }
      if (!best) return;
      this.db.prepare('UPDATE withdrawals SET fee = ? WHERE id = ?')
        .run(parseFloat((feeNano(best) / 1e9).toFixed(9)), withdrawalId);
    } catch (e) {
      console.warn(`[fee] could not record network fee for withdrawal ${withdrawalId}: ${e.message}`);
    }
  }

  // Release the payout lock and write the matching ledger debit ATOMICALLY, debiting exactly what
  // was unlocked. If balance_locked < amount (possible only under prior corruption — a lock always
  // precedes in normal flow), BOTH the release and the logged debit are clamped: releasing less
  // while logging the full amount would make the account total fall by less than the ledger
  // records → integrity_drift → an auto-freeze the alarm itself can't explain.
  _releaseLockAndDebit(withdrawal) {
    const txn = this.db.transaction(() => {
      const acct = this.db.prepare(
        'SELECT balance_locked FROM miner_accounts WHERE grin_address = ?'
      ).get(withdrawal.grin_address);
      const lockedBefore = acct ? acct.balance_locked : 0;
      const released = Math.min(lockedBefore, withdrawal.amount);
      if (released < withdrawal.amount) {
        console.error(
          `⚠️  Withdrawal ${withdrawal.id}: balance_locked (${lockedBefore}) < amount (${withdrawal.amount}) — ` +
          `releasing only ${released}; the locked balance was corrupted BEFORE this payout, investigate`
        );
      }
      this.db.prepare(
        'UPDATE miner_accounts SET balance_locked = balance_locked - ?, updated_at = unixepoch() WHERE grin_address = ?'
      ).run(released, withdrawal.grin_address);
      this.db.prepare(`
        INSERT INTO balance_log
        (grin_address, event_type, amount, balance_before, balance_after,
         locked_before, locked_after, reference_type, reference_id)
        VALUES (?, 'debit', ?, 0, 0, ?, ?, 'withdrawal', ?)
      `).run(withdrawal.grin_address, released, lockedBefore, lockedBefore - released, withdrawal.id);
    });
    txn();
  }

  // Confirm a payout: mark confirmed, release the lock (locked −= amount = paid out), ledger debit,
  // join-bonus. Generic over fromStatus so both the Tor and slatepack rails reuse it.
  _creditConfirm(withdrawalId, fromStatus, note) {
    try {
      this.db.prepare("UPDATE withdrawals SET status = 'confirmed', confirmed_at = unixepoch() WHERE id = ?").run(withdrawalId);
      this.db.prepare(`
        INSERT INTO withdrawal_events (withdrawal_id, from_status, to_status, triggered_by, note)
        VALUES (?, ?, 'confirmed', 'scheduler', ?)
      `).run(withdrawalId, fromStatus, note);

      const w = this.db.prepare('SELECT * FROM withdrawals WHERE id = ?').get(withdrawalId);
      this._releaseLockAndDebit(w);

      console.log(`[${new Date().toISOString()}] Withdrawal ${withdrawalId} confirmed (${w.amount} GRIN to ${w.grin_address})`);
      try { this.incentives.maybePayJoinBonus(w.grin_address); }
      catch (e) { console.error(`Error paying join bonus for ${w.grin_address}: ${e.message}`); }
    } catch (err) {
      console.error(`Error confirming withdrawal ${withdrawalId}: ${err.message}`);
    }
  }

  // Reverse a locked balance back to spendable and park the withdrawal in a terminal state.
  // Generic over fromStatus/newStatus so the slatepack rail reuses the same accounting as markFailed.
  _reverseLock(withdrawalId, newStatus, fromStatus, note) {
    try {
      this.db.prepare('UPDATE withdrawals SET status = ? WHERE id = ?').run(newStatus, withdrawalId);
      this.db.prepare(`
        INSERT INTO withdrawal_events (withdrawal_id, from_status, to_status, triggered_by, note)
        VALUES (?, ?, ?, 'scheduler', ?)
      `).run(withdrawalId, fromStatus, newStatus, note);

      const w = this.db.prepare('SELECT * FROM withdrawals WHERE id = ?').get(withdrawalId);
      this.db.prepare(
        'UPDATE miner_accounts SET balance = balance + ?, balance_locked = balance_locked - ? WHERE grin_address = ?'
      ).run(w.amount, w.amount, w.grin_address);
      this.db.prepare(`
        INSERT INTO balance_log
        (grin_address, event_type, amount, balance_before, balance_after, locked_before, locked_after, reference_type, reference_id)
        VALUES (?, 'reversal', ?, 0, 0, 0, 0, 'withdrawal', ?)
      `).run(w.grin_address, w.amount, withdrawalId);
    } catch (err) {
      console.error(`Error reversing withdrawal ${withdrawalId}: ${err.message}`);
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

      const paid24 = this.db.prepare(
        "SELECT COALESCE(SUM(amount), 0) AS total FROM withdrawals WHERE status = 'confirmed' AND confirmed_at >= unixepoch() - 86400"
      ).get();
      const lastPayout = this.db.prepare(
        "SELECT MAX(confirmed_at) AS t FROM withdrawals WHERE status = 'confirmed'"
      ).get();

      return {
        running: this.isRunning,
        pending: pending.count,
        confirmed: confirmed.count,
        failed: failed.count,
        // Aliases consumed by the admin dashboard / metrics endpoints.
        pending_count: pending.count,
        confirmed_count: confirmed.count,
        failed_count: failed.count,
        total_paid_24h: paid24.total || 0,
        last_payout_time: lastPayout.t ? new Date(lastPayout.t * 1000).toISOString() : null,
        next_payout_time: null // event-driven (per-withdrawal Tor checks), no fixed schedule
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
