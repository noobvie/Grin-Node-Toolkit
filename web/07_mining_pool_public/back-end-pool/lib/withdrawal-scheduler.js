const { getDb } = require('./db');
const WalletTor = require('./wallet-tor');
const IncentivesManager = require('./incentives');

// Every status that occupies the ONE-pending-per-address slot — across ALL payout rails
// (Tor, slatepack, and any future method that reuses these states, e.g. the designed Nostr
// rail, which parks in slatepack_pending). Both create paths MUST share this list: a
// rail-specific subset re-opens the hole where a miner with a pending slatepack could start
// a Tor payout in parallel (found + fixed 2026-07-17).
//
// 'finalizing' is the short-lived claim a finalize holds while it talks to the wallet (see
// _claimForFinalize). Its coins are mid-broadcast, so it is emphatically in-flight — every
// other in-flight status list in the codebase must include it too: reconciliation's pending
// sum, AlertMonitor's inFlight (a missing row there reads as an unexplained wallet drain),
// the account-summary pending display and the admin payments view.
const PENDING_SQL = "status IN ('tor_checking','tor_sending','retry_scheduled','slatepack_pending','finalizing')";

// How long a 'finalizing' claim may stand before the sweeper reclaims it. Finalize is three
// wallet calls — seconds in the normal case — so anything past this lost its owner (process
// restart mid-finalize). Reclaim is NOT a blind revert: see reclaimStaleFinalizing.
const FINALIZING_STALE_S = 600;

// How long a payout deferred by the double-send guard waits before it is re-asked (audit
// §J4-10). A Grin transaction that was genuinely broadcast mines in minutes, so 15 min is
// long enough for the ambiguity to resolve itself and short enough that a payout which was
// never posted is not held up for the 6 h the retry ladder would cost.
const SEND_DEFER_S = 900;

// After this many consecutive deferrals (~2 h at SEND_DEFER_S) the transaction is neither
// mining nor being cancelled, which no longer looks like a timing gap. The row stays parked —
// parking is still the only safe state — but it stops being quiet about it.
const MAX_SEND_DEFERRALS = 8;

// A Tor send refused because the POOL wallet is short (grin-wallet NotEnoughFunds — usually
// outputs tied up by other payouts still settling) re-tries after SHORTFALL_RETRY_S and does NOT
// consume a rung of the miner-offline ladder (see scheduleRetry). Bounded: after
// MAX_SHORTFALL_RETRIES (~a day) a shortfall takes the ladder like any failure, so a pool that is
// simply underfunded cannot hold a miner's balance forever — the last-rung guard decides.
const SHORTFALL_RETRY_S = 3600;
const MAX_SHORTFALL_RETRIES = 24;

// Step-by-step Tor send (design §8.1): the POOL's own tor being down says nothing about the
// miner, so it re-tries after TOR_DOWN_RETRY_S without consuming a rung — the F3 pattern, with
// its own 'tor-down:' event-note counter and cap. After MAX_TOR_DOWN_RETRIES it takes the ladder.
const TOR_DOWN_RETRY_S = 900;
const MAX_TOR_DOWN_RETRIES = 24;
// A stepwise row whose post_tx failed is COMMITTED: the stale sweep posts the identical stored
// tx again, at most once per STEPWISE_REPOST_EVERY_S and MAX_STEPWISE_REPOSTS times in all, keyed
// on 'stepwise: repost' event notes. Past the cap it stays parked behind a critical alert.
const STEPWISE_REPOST_EVERY_S = 300;
const MAX_STEPWISE_REPOSTS = 24;

// How long a 'tor_sending' claim may stand before the sweeper resolves it (audit §J4-3). The
// send itself is bounded by wallet_send_timeout_ms (120 s default) and is followed by two more
// wallet round-trips before anything is written back, so this must clear all three with room —
// resolved per-instance in the constructor against the configured timeout, never a bare literal.
const TOR_SENDING_STALE_FLOOR_S = 600;

// "Marked paid but not mined" watchdog (F2, see _watchUnmined). A payout is 'confirmed' when the
// send COMMAND succeeds; a Grin tx mines in minutes, so one still without a kernel an hour later
// is overdue — usually a node restart that dropped its mempool. Deliberately not a setting.
const UNMINED_ALERT_S = 3600;
// The one automatic remedy — re-broadcasting the identical stored tx — runs at most once per row
// per REPOST_EVERY_S, for at most REPOST_MAX_PER_TICK rows per tick (each is a CLI round-trip that
// holds the scheduler loop), and stops for good after MAX_REPOSTS: a tx that a day of hourly
// reposts has not mined is not a dropped mempool, and the alert already has the operator's eye.
const REPOST_EVERY_S = 3600;
const REPOST_MAX_PER_TICK = 3;
const MAX_REPOSTS = 24;

// The pseudo-address the flat withdrawal fee is credited to — the SAME bucket the block-reward
// pool fee lands in, so both show up as one fee-income line on the transparency page.
const POOL_FEE_ADDRESS = IncentivesManager.POOL_FEE;

// Miner-facing wording for the two "not now" refusals (2026-09-24, operator decision). Payouts
// are miner-initiated with ONE pending per address, never an automatic mass run, so both states
// clear on their own as other payouts settle — telling the miner to come back in an hour is the
// whole remedy. The pool-wide cap is deliberately NOT split per rail (a slatepack sub-cap was
// considered and declined): filling it takes one funded address per slot, and a slatepack slot
// frees itself within slatepack_ttl_minutes.
const POOL_BUSY_MSG =
  'the pool is processing a lot of payouts right now — nothing was deducted from your balance; ' +
  'please try again in about an hour';
// grin-wallet's NotEnoughFunds carries the wallet's available + needed amounts. Passing it through
// told any miner with an ownership proof how much the POOL wallet can spend, as raw JSON. The
// miner gets this line; the operator log keeps the real error. The usual cause is outputs locked
// by other payouts still settling (an unanswered slatepack holds its inputs + change) — so it is
// temporary — but a pool wallet that is simply underfunded looks identical, hence the last clause.
const WALLET_SHORT_MSG =
  "the pool wallet can't cover this payout right now — part of its funds are tied up in other " +
  'payouts that are still settling. Your full balance has been returned; please try again in ' +
  'about an hour (if this keeps happening, contact the pool operator)';
const isNotEnoughFunds = (err) => /NotEnoughFunds|not enough funds/i.test(String((err && err.message) || ''));

class WithdrawalScheduler {
  constructor(config, wallet = null) {
    this.config = config;
    this.db = getDb();
    this.walletTor = new WalletTor(config);
    // WalletAPI (Owner API v3) — required only for the slatepack payout rail. Tor payouts use
    // walletTor (CLI). Left null in deployments that never enable slatepack.
    this.wallet = wallet;
    // Goblin/Nostr payout bridge (design §15) — injected by index.js AFTER construction
    // (the bridge needs a response handler that calls back into this scheduler, so the two
    // are wired post-hoc to avoid a construction cycle). Null when the feature is off.
    this.nostrBridge = null;
    this.incentives = new IncentivesManager(config);
    this.isRunning = false;
    this.checkInterval = 60000;
    // How long an unfinalized slatepack payout stays pending before it's cancelled and the
    // locked balance is returned (the miner never imported/returned the slate). Minutes, 30 by
    // default (config.slatepack_ttl_minutes). The old `slatepack_ttl_hours` was never set by
    // config.js or the settings table, so every pool ran the `|| 24` fallback. A non-number or a
    // value below the validator's floor falls back to 30 rather than to "expire at once".
    const spTtl = Number(config.slatepack_ttl_minutes);
    this.slatepackTtlSeconds = (Number.isFinite(spTtl) && spTtl >= 10 ? spTtl : 30) * 60;
    // Goblin/Nostr rows (method='nostr') expire on a much shorter clock: the wallet AutoReceives,
    // so a live miner answers in seconds — no human paste-back to wait for. Bounds a stranded
    // lock when the wallet is offline. See config.nostr_pending_ttl_minutes.
    this.nostrPendingTtlSeconds =
      (config.nostr_pending_ttl_minutes !== undefined ? config.nostr_pending_ttl_minutes : 10) * 60;
    // Age at which a 'tor_sending' row is treated as abandoned (audit §J4-3). Derived from the
    // configured send timeout so an operator who raises wallet_send_timeout_ms cannot make the
    // sweeper race a send that is still legitimately running: twice the timeout, plus two
    // minutes for recordTorFee + _captureTorSlateId, floored at 10 min.
    const sendTimeoutS = Math.ceil((Number(config.wallet_send_timeout_ms) || 120000) / 1000);
    this.torSendingStaleSeconds = Math.max(TOR_SENDING_STALE_FLOOR_S, sendTimeoutS * 2 + 120);
    this.retryDelays = config.withdrawal_retry_delays || [
      6 * 3600,
      12 * 3600,
      24 * 3600,
      48 * 3600
    ];
    // Pool-wide cap on concurrent withdrawals (DoS bound), enforced inside every create*
    // path's transaction. MAX_USER_PENDING is NOT the per-address rule — that is the hard
    // one-pending-per-address check next to it; this constant is only read by the unused
    // canInitiateWithdrawal() below.
    //
    // Read from config, which PoolSettings.applyToConfig() populates from
    // payout.max_pending_withdrawals / payout.max_user_pending. These were hardcoded until
    // 2026-08-22, so the two fields in admin → Payout wrote to the DB and changed nothing.
    // Coerced and floored at 1: a 0 or a non-numeric string reaching the cap would make the
    // guard reject every withdrawal, which looks exactly like a stuck payout queue.
    this.MAX_PENDING_WITHDRAWALS = Math.max(1, parseInt(config.max_pending_withdrawals, 10) || 100);
    this.MAX_USER_PENDING        = Math.max(1, parseInt(config.max_user_pending, 10) || 10);
    // How a Tor payout is sent (payout.tor_send_mode, design §8.1.6): 'cli' (sendWithdrawal, one
    // `grin-wallet send -d`) or 'stepwise' (sendWithdrawalStepwise, driven through the Owner
    // API). Fixed for the life of the process. Stepwise needs the Owner-API wallet; asking for it
    // without one runs the CLI rail, loudly. Rows already in tor_sending are resolved by how
    // THEIR attempt was made (the claim-event marker), never by this field.
    this.torSendMode = 'cli';
    if (String(config.tor_send_mode || '').trim().toLowerCase() === 'stepwise') {
      if (this.wallet) this.torSendMode = 'stepwise';
      else {
        console.error(
          `[tor-stepwise] tor_send_mode is 'stepwise' but no Owner-API wallet is configured — ` +
          `running the CLI Tor rail instead`
        );
      }
    }
    // Ids of stepwise attempts running in THIS process. The stale sweep never touches one of
    // them: an attempt can take ~4 min at the worst-case timeouts, and the sweep must not race it.
    this._liveStepwise = new Set();
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
        // Recover abandoned finalize claims BEFORE expiry, so a row whose finalize died mid-flight
        // is either confirmed or handed back to the pending pool rather than sitting invisible to
        // both. Runs while frozen too: it only resolves rows to the truth already on-chain.
        await this.reclaimStaleFinalizing();
        // Same job for the Tor rail, whose send window is wider and which had no sweep at all
        // until §J4-3. Also freeze-safe: it resolves rows against the wallet, it never sends.
        await this.reclaimStaleTorSending();

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
        // Read-only: attach on-chain kernel proofs to confirmed payouts, and in the same wallet
        // read flag the ones marked paid but not mined (F2). Never moves funds, so it runs
        // regardless of the freeze state — only its repost step checks the freeze itself.
        // Self-throttled + no-op when nothing's pending.
        await this.backfillKernelProofs();
        await this.backfillPaymentProofs();
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

  // ─── Flat withdrawal fee ────────────────────────────────────────────────────
  // Grin charges the SENDER a network fee by transaction WEIGHT, not by amount, so a payout
  // costs the pool the same ~0.023 GRIN whether it's 25 or 2500 GRIN. This flat fee recovers
  // that cost from the miner who triggered it. Charged identically on all three rails.
  //
  // Accounting (design §8): the miner is locked and debited the FULL requested amount; only
  // `amount − fee` goes on-chain, and the fee is credited to the pool_fee pseudo-account at
  // CONFIRM time (never at request time — see _releaseLockAndDebit). Charging on confirm is
  // what keeps every reversal path untouched: a payout that fails or expires returns the whole
  // locked amount and no fee was ever taken, so there is nothing to un-charge.
  _withdrawalFee() {
    const f = Number(this.config.withdrawal_fee);
    return Number.isFinite(f) && f > 0 ? parseFloat(f.toFixed(9)) : 0;
  }

  // Fee frozen at request time — callers store it in withdrawals.fee_charged so a later settings
  // change can't rewrite the terms of an in-flight or historical payout.
  //
  // Deliberately NOT clamped to the amount. Clamping would let a payout smaller than the fee
  // through as a dust send with the rest confiscated as "fee" (a 0.02 GRIN admin override would
  // send 1 nanogrin and keep 0.019999999). A payout that cannot cover its own fee must be
  // REJECTED — that is _netSend's job. min_withdrawal > withdrawal_fee makes this unreachable on the
  // normal path; only an adminOverride can get here, and rejecting is the right answer there too.
  _feeFor(_amount) {
    return this._withdrawalFee();
  }

  // Amount that actually goes on-chain. Guarded so a sub-threshold admin override can never
  // construct a zero/negative send (the min_withdrawal floor already covers normal requests).
  _netSend(amount, feeCharged) {
    const net = parseFloat((amount - feeCharged).toFixed(9));
    if (!(net > 0)) {
      const e = new Error(
        `amount ${amount} GRIN does not cover the ${feeCharged} GRIN withdrawal fee ` +
        `(which covers the Grin blockchain transaction fee)`
      );
      e.code = 400;
      throw e;
    }
    return net;
  }

  // Cross-rail cooldown after a reversed payout (operator decision 2026-07-17, default 30 min).
  // When a payout's lock is reversed back to balance — Tor final-failure, slatepack expiry or
  // creation failure, admin cancel — the miner must wait before requesting ANOTHER payout on
  // ANY rail. Two jobs: (1) safety margin for the known theoretical double-pay window (a Tor
  // send that looked failed may still land — see audit §E.1; the slate_id/retrieve_txs check
  // is the real fix, this narrows the race meanwhile), (2) stops rapid-fire rail-hopping after
  // failures. Configured via payout.withdrawal_cooldown_minutes (applied at startup, like
  // min_withdrawal); 0 disables.
  _assertNoRecentReversal(grinAddress) {
    // `0` disabling the cooldown is a documented operator choice. A NON-NUMBER disabling it is a
    // broken config, and used to do so silently: `'thirty' * 60` is NaN and `if (!cooldown)`
    // returned (audit §J4-6, same family as memory project_config_loader_type_traps). Fall back to
    // the default and say so once — a money guard must never switch itself off without a trace.
    const raw = this.config.withdrawal_cooldown_minutes;
    let mins = (raw === undefined || raw === null) ? 30 : Number(raw);
    if (!Number.isFinite(mins) || mins < 0) {
      if (!this._badCooldownWarned) {
        this._badCooldownWarned = true;
        console.error(
          `[payout] withdrawal_cooldown_minutes is not a number (${JSON.stringify(raw)}) — ` +
          `using the 30 min default; set it to 0 if you really mean "no cooldown"`
        );
      }
      mins = 30;
    }
    const cooldown = mins * 60;
    if (!cooldown) return;
    const row = this.db.prepare(`
      SELECT MAX(created_at) AS t FROM balance_log
      WHERE grin_address = ? AND event_type = 'reversal' AND reference_type = 'withdrawal'
    `).get(grinAddress);
    if (!row || !row.t) return;
    const remaining = cooldown - (Math.floor(Date.now() / 1000) - row.t);
    if (remaining > 0) {
      const waitMin = Math.ceil(remaining / 60);
      const e = new Error(
        `a recent payout was returned to your balance — please wait ${waitMin} min before requesting another`
      );
      e.code = 429;
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
    // tor_send_mode picks the rail (constructor); with 'cli' this is exactly the shipped path.
    //
    // The loop checks the freeze once per tick, but a tick runs up to 10 retries and 5 checks back
    // to back, each a send of up to wallet_send_timeout_ms, and AlertMonitor freezes on its own
    // timer. So the freeze is re-read per row: one that lands mid-batch stops the NEXT send. The
    // row stays in tor_checking (still pending, balance still locked) and goes out after a resume.
    // The stepwise rail re-reads it at its own claim (and again before delivery and before post).
    try {
      if (this.torSendMode === 'stepwise') await this.sendWithdrawalStepwise(withdrawal.id);
      else if (!this.isFrozen() && this._dropStepwiseSlate(withdrawal.id)) await this.sendWithdrawal(withdrawal.id);
    } catch (err) {
      console.error(`Error sending withdrawal ${withdrawal.id}: ${err.message}`);
    }
  }

  // A CLI attempt must not inherit a STEPWISE attempt's slate id (tor_send_mode switched back to
  // 'cli' while the row was on the ladder). The CLI rail reads a non-null slate_id as THIS payout's
  // send: its double-send guard, markFailed and the stale sweep look up that one slate exactly, so
  // a cancelled stepwise slate reads 'absent' and the row is sent again or refunded even when an
  // earlier CLI attempt landed — and _captureTorSlateId never overwrites it, so the kernel backfill
  // and the watchdog keep watching a cancelled slate ("NOT paid", critical). Before F5 a CLI row had
  // no slate_id until it settled; clearing restores exactly that. Only a slate the row's own journal
  // names as its stepwise slate is cleared, and that journal line stays for _stepwisePriorSlates.
  // false = could not clear, so the caller must not send on the stale id (next tick tries again).
  _dropStepwiseSlate(withdrawalId) {
    try {
      const w = this.db.prepare(
        "SELECT slate_id FROM withdrawals WHERE id = ? AND status = 'tor_checking'"
      ).get(withdrawalId);
      if (!w || !w.slate_id) return true;
      const sid = String(w.slate_id);
      const ours = this.db.prepare(
        "SELECT 1 FROM withdrawal_events WHERE withdrawal_id = ? AND note LIKE 'slate: ' || ? || ' created (stepwise)%' LIMIT 1"
      ).get(withdrawalId, sid);
      if (!ours) return true;
      this.db.transaction(() => {
        const r = this.db.prepare(
          "UPDATE withdrawals SET slate_id = NULL WHERE id = ? AND status = 'tor_checking' AND slate_id = ?"
        ).run(withdrawalId, w.slate_id);
        if (r.changes !== 1) return;
        this.db.prepare(`
          INSERT INTO withdrawal_events (withdrawal_id, from_status, to_status, triggered_by, note)
          VALUES (?, 'tor_checking', 'tor_checking', 'scheduler', ?)
        `).run(withdrawalId, `cli: cleared stepwise slate ${sid} from slate_id before a CLI attempt (its journal line stays)`);
      })();
      return true;
    } catch (e) {
      console.error(`[tor] withdrawal ${withdrawalId}: could not clear its stepwise slate id (${e.message}) — not sending this tick`);
      return false;
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

      // Has the wallet ever been handed this row before? Read from the EVENT LOG, and read it
      // BEFORE this attempt writes its own event (audit §J4-2). This arms the double-send guard
      // below. It used to be armed off `retry_count`, which the admin retry route resets to 0
      // (index.js, POST /api/admin/withdrawals/:id/retry) to give the row a fresh ladder — so the
      // button silently disarmed the guard on exactly the rows most likely to have already
      // landed: a tor_failed payout is one whose every attempt was SIGKILLed at the send timeout.
      // The event log is append-only and no admin action rewrites it.
      const priorAttempts = this.db.prepare(
        "SELECT COUNT(*) AS c FROM withdrawal_events WHERE withdrawal_id = ? AND to_status = 'tor_sending'"
      ).get(withdrawalId).c;

      // Guarded claim, same reason as everywhere else: only a row still in tor_checking may be
      // handed to the wallet, so two scheduler passes can never both spend for one payout.
      const claimed = this.db.prepare(
        "UPDATE withdrawals SET status = 'tor_sending' WHERE id = ? AND status = 'tor_checking'"
      ).run(withdrawalId);
      if (claimed.changes !== 1) return;

      const eventStmt = this.db.prepare(`
        INSERT INTO withdrawal_events
        (withdrawal_id, from_status, to_status, triggered_by)
        VALUES (?, ?, ?, 'scheduler')
      `);
      eventStmt.run(withdrawalId, 'tor_checking', 'tor_sending');

      // Send the NET amount — the flat fee stays behind in the pool wallet to cover the
      // on-chain network fee. The row keeps `amount` as the gross the miner was debited, so
      // the wallet-log lookups below must match on the net figure that actually went out.
      const netSend = this._netSend(withdrawal.amount, withdrawal.fee_charged || 0);

      // ── Double-send guard (audit §E.1, re-armed §J4-2) ──────────────────────
      // Never re-send a payout that may already be on the chain. See _priorSendLanded.
      // `priorAttempts` is the durable trigger; retry_count and slate_id are kept as belt and
      // braces, not relied on. A first attempt has none of the three, so it still pays no extra
      // wallet round-trip.
      if (priorAttempts > 0 || withdrawal.retry_count > 0 || withdrawal.slate_id) {
        const prior = await this._priorSendLanded(withdrawal, netSend);

        // ON CHAIN — the earlier attempt landed. Confirm, never re-send.
        if (prior.outcome === 'confirmed') {
          console.warn(
            `⚠️  Withdrawal ${withdrawalId}: an earlier attempt DID post and is CONFIRMED on chain ` +
            `(slate ${prior.tx.tx_slate_id}) — confirming instead of re-sending`
          );
          this.db.prepare('UPDATE withdrawals SET slate_id = COALESCE(slate_id, ?) WHERE id = ?')
            .run(String(prior.tx.tx_slate_id), withdrawalId);
          await this.recordTorFee(withdrawalId, netSend);
          await this.markConfirmed(withdrawalId, 'recovered: earlier attempt confirmed in the wallet tx log');
          return;
        }

        // UNKNOWN — the wallet holds an unconfirmed send that matches this payout. It is either
        // "locked but never posted" (re-sending is right) or "posted, not yet mined" (re-sending
        // pays twice). Neither guess is recoverable, so do neither: park the row and re-ask.
        // Audit §J4-10.
        if (prior.outcome === 'unconfirmed') {
          this._deferSend(withdrawalId, prior.tx && prior.tx.tx_slate_id);
          return;
        }

        if (!prior.checked) {
          // A row that has ALREADY been deferred is one whose outcome was declared unknown —
          // an unconfirmed send was seen, or the last rung could not read the log. That
          // statement stands until the wallet is read again; an unreadable wallet cannot
          // dissolve it, so a deferred row is re-parked, never sent blind. Only a row with no
          // deferral behind it takes the proceed-loudly branch below (brief outage on an
          // ordinary retry; nothing has said "maybe posted" about it yet).
          const everDeferred = this.db.prepare(
            "SELECT 1 FROM withdrawal_events WHERE withdrawal_id = ? AND note LIKE 'deferred:%' LIMIT 1"
          ).get(withdrawalId);
          if (everDeferred) {
            this._deferSend(withdrawalId, withdrawal.slate_id,
              'wallet tx log could not be read after an earlier deferral');
            return;
          }
          console.error(
            `⚠️  Withdrawal ${withdrawalId}: retrying WITHOUT a double-send check — the wallet tx log ` +
            `could not be read. If this payout later looks duplicated, this is where to look.`
          );
        }
        // 'absent' falls through to the send — no match, or the only match was cancelled.
      }

      const sendResult = await this.walletTor.sendToTorAddress(
        withdrawal.grin_address,
        netSend
      );

      if (sendResult.success) {
        await this.recordTorFee(withdrawalId, netSend);
        await this._captureTorSlateId(withdrawalId, netSend); // best-effort proof metadata
        // Note only — the CLI's raw stdout used to be passed here and was silently discarded
        // (the old markConfirmed ignored its second argument); it is not worth storing in an
        // event row, and can be large.
        await this.markConfirmed(withdrawalId, 'Successfully sent');
      } else {
        console.error(`Send failed for withdrawal ${withdrawalId}: ${sendResult.error}`);
        if (sendResult.torFallback) await this._releaseTorFallback(withdrawalId, sendResult.slateId);
        await this.scheduleRetry(withdrawalId, this._retryReasonFor(withdrawal, netSend, sendResult.error));
      }
    } catch (err) {
      console.error(`Error sending withdrawal ${withdrawalId}: ${err.message}`);
      // `withdrawal` / `netSend` are scoped to the try block, so only the id is known here.
      await this.scheduleRetry(withdrawalId, this._retryReasonFor({ id: withdrawalId, method: 'tor' }, null, err.message));
    }
  }

  // ─── Step-by-step Tor send (F5, design §8.1) — tor_send_mode = 'stepwise' ────────────────
  // The same payment the CLI's `send -d` makes, driven by the pool one step at a time through the
  // Owner API, so the slate id is in OUR database before any coin is locked and before any byte
  // leaves the box. Every recovery is then an exact slate-id lookup — no amount/time matching.
  //
  //   step (tor_step)      durable record written BEFORE it           the step
  //   0  claimed           claim tor_checking→tor_sending, 'stepwise: claim'
  //   1                                                              init_send_tx (proof → miner)
  //   2  initiated         slate_id + fee + 'slate: <uuid> created'   — (one guarded write)
  //   3  locked                                                      tx_lock_outputs
  //   4  delivering        freeze check                              check_version → receive_tx
  //   5  finalizing                                                  finalize_tx (never posts)
  //   6  posting           freeze check; tor_final_slate = S3        — (one guarded write)
  //   7                                                              post_tx → confirmed
  //
  // THE SAFETY LINE (§8.1.2): nothing reaches the chain except through the pool's own post_tx.
  // So every step before 6 can be CANCELLED safely, and from step 6 on the tx is COMMITTED — the
  // only action allowed is to post the identical tx again, never cancel, never rebuild.
  //
  // Two rules hold on every path below:
  //   · a row never leaves tor_sending with a live slate: cancel first, and only after the cancel
  //     succeeded is the row re-queued or put on the ladder (_stepwiseCancelThen);
  //   · every tor_step move is guarded on (status='tor_sending', tor_step=<expected>); a lost
  //     guard stops the attempt and nothing after it assumes anything.
  // A process that dies mid-attempt leaves tor_step behind; reclaimStaleTorSending's stepwise
  // branch (_reclaimStaleStepwise) finishes the job by that step.
  async sendWithdrawalStepwise(withdrawalId) {
    // Freeze checked at claim (§8.1.7), on top of the scheduler loop's own gate.
    if (this.isFrozen()) return;
    const w = this.db.prepare('SELECT * FROM withdrawals WHERE id = ?').get(withdrawalId);
    if (!w) return;

    // Read BEFORE this attempt's own claim event, exactly as sendWithdrawal does (§J4-2).
    const priorAttempts = this.db.prepare(
      "SELECT COUNT(*) AS c FROM withdrawal_events WHERE withdrawal_id = ? AND to_status = 'tor_sending'"
    ).get(withdrawalId).c;

    // Step 0 — the claim and its 'stepwise:' marker are ONE transaction: the marker is how the
    // stale sweep knows to resolve this attempt by tor_step (§8.1.4).
    const claimed = this.db.transaction(() => {
      const r = this.db.prepare(
        `UPDATE withdrawals SET status = 'tor_sending', tor_step = 'claimed', tor_final_slate = NULL
          WHERE id = ? AND status = 'tor_checking'`
      ).run(withdrawalId);
      if (r.changes !== 1) return false;
      this._stepwiseEvent(withdrawalId, 'stepwise: claim', 'tor_checking');
      return true;
    })();
    if (!claimed) return;
    console.log(`[tor-stepwise] withdrawal ${withdrawalId}: step claimed`);

    this._liveStepwise.add(Number(withdrawalId));
    try {
      await this._stepwiseAttempt(w, priorAttempts);
    } catch (err) {
      console.error(`⚠️  [tor-stepwise] withdrawal ${withdrawalId}: attempt threw (${err.message})`);
      const now = this.db.prepare('SELECT status, tor_step FROM withdrawals WHERE id = ?').get(withdrawalId);
      // Still at 'claimed': no slate was created, nothing is locked — an ordinary counted retry.
      // Any later step holds a slate, so the row stays in tor_sending for the stale sweep.
      if (now && now.status === 'tor_sending' && now.tor_step === 'claimed') {
        await this.scheduleRetry(withdrawalId, null);
      }
    } finally {
      this._liveStepwise.delete(Number(withdrawalId));
    }
  }

  async _stepwiseAttempt(w, priorAttempts) {
    const id = w.id;
    const netSend = this._netSend(w.amount, w.fee_charged || 0);

    // §8.1.5 — never start a new slate while an earlier one might still land.
    if (priorAttempts > 0 || w.slate_id) {
      if (!(await this._stepwiseReattemptGuard(w, netSend))) return;
    }

    // Steps 1–3 under the wallet's send lock: no other rail may select coins between our init
    // and our lock (§8.1.1 — lock_output does not check for an existing lock).
    let slate = null;
    const r = await this._withSendLock(async () => {
      try {
        slate = await this.wallet.initSendTx(netSend, { paymentProofRecipient: w.grin_address });
      } catch (err) {
        return { initError: err };
      }
      if (!slate || !slate.id) return { initError: new Error('init_send_tx returned no slate id') };
      const sid = String(slate.id);

      // Step 2 — persist the slate id BEFORE the lock and before any network I/O. init adds no
      // lock and no tx-log entry, so a crash before this write leaves nothing to recover.
      const persisted = this.db.transaction(() => {
        const u = this.db.prepare(
          `UPDATE withdrawals SET slate_id = ?, fee = COALESCE(?, fee), tor_step = 'initiated'
            WHERE id = ? AND status = 'tor_sending' AND tor_step = 'claimed'`
        ).run(sid, this._slateFeeGrin(slate), id);
        if (u.changes !== 1) return false;
        this._stepwiseEvent(id, `slate: ${sid} created (stepwise)`);
        return true;
      })();
      if (!persisted) return { lost: 'claimed → initiated' };
      console.log(`[tor-stepwise] withdrawal ${id}: step initiated — slate ${sid} saved, locking outputs`);

      // Step 3 — lock. TxSent entry + output locks in one wallet batch: both or neither.
      try {
        await this.wallet.txLockOutputs(slate);
      } catch (err) {
        return { lockError: err };
      }
      if (!this._stepMove(id, 'initiated', 'locked')) return { lost: 'initiated → locked' };
      return { ok: true };
    });

    if (r.initError) {
      // Nothing was locked. NotEnoughFunds → the F3 shortfall path (uncounted); anything else
      // is a counted retry.
      console.error(`[tor-stepwise] withdrawal ${id}: init_send_tx failed — ${r.initError.message}`);
      await this.scheduleRetry(id, this._retryReasonFor(w, netSend, r.initError.message));
      return;
    }
    if (r.lost) {
      console.error(`⚠️  [tor-stepwise] withdrawal ${id}: the row moved during ${r.lost} — attempt stopped`);
      return;
    }
    const sid = String(slate.id);
    if (r.lockError) {
      await this._stepwiseCancelThen(id, sid, { retry: null }, `tx_lock_outputs failed: ${r.lockError.message}`);
      return;
    }

    // Step 4 — deliver over Tor. Freeze first: a frozen pool sends nothing out.
    if (this.isFrozen()) {
      await this._stepwiseCancelThen(id, sid, { requeue: true }, 'payouts frozen before delivery');
      return;
    }
    if (!this._stepMove(id, 'locked', 'delivering')) return;
    let d;
    try {
      d = await this.walletTor.deliverSlate(w.grin_address, slate, { attemptTag: `${id}-${Date.now().toString(36)}` });
    } catch (err) {
      // deliverSlate never throws by contract; if it does, assume the worst about the wire.
      d = { ok: false, ourSide: false, requestWritten: true, reason: 'deliver_threw', detail: err.message };
    }
    if (!d || !d.ok) {
      const why = `delivery failed (${(d && d.reason) || 'unknown'}` +
        `${d && d.requestWritten ? ', after receive_tx was sent' : ''}): ${(d && d.detail) || ''}`;
      console.warn(`[tor-stepwise] withdrawal ${id}: ${why}`);
      // Our own tor down → uncounted; the miner not answering → a counted rung.
      await this._stepwiseCancelThen(id, sid, { retry: d && d.ourSide ? 'pool_tor_unavailable' : null }, why);
      return;
    }

    // Step 5 — finalize. The Owner finalize never posts, so a failure here broadcast nothing.
    if (!this._stepMove(id, 'delivering', 'finalizing')) return;
    let finalized = null;
    try {
      finalized = await this.wallet.finalizeTx(d.slate);
    } catch (err) {
      await this._stepwiseCancelThen(id, sid, { retry: null }, `finalize_tx failed: ${err.message}`);
      return;
    }
    if (!finalized || typeof finalized !== 'object') {
      await this._stepwiseCancelThen(id, sid, { retry: null }, 'finalize_tx returned no slate');
      return;
    }

    // Step 6 — the commit point. Freeze first; then S3 and 'posting' in ONE write, so the sweep
    // always has the exact tx to post again.
    if (this.isFrozen()) {
      await this._stepwiseCancelThen(id, sid, { requeue: true }, 'payouts frozen before post');
      return;
    }
    if (!this._stepMove(id, 'finalizing', 'posting', {
      finalSlate: JSON.stringify(finalized),
      note: `stepwise: posting slate ${sid} — committed, from here it is only ever posted again`,
    })) return;

    // Step 7 — post.
    try {
      await this.wallet.postTx(finalized, true);
    } catch (err) {
      console.error(
        `⚠️  [tor-stepwise] withdrawal ${id}: post_tx threw (${err.message}) — the tx is COMMITTED and is ` +
        `never cancelled; left at 'posting' for the stale sweep to post the same tx again`
      );
      return;
    }
    if (this._creditConfirm(id, 'tor_sending', 'stepwise: posted')) {
      this.db.prepare("UPDATE withdrawals SET tor_final_slate = NULL WHERE id = ? AND status = 'confirmed'").run(id);
      console.log(`[tor-stepwise] withdrawal ${id}: posted — slate ${sid}`);
    }
  }

  // Serialise init → lock with every other rail (WalletAPI.withSendLock). A wallet without it
  // (test doubles) runs fn directly.
  _withSendLock(fn) {
    return this.wallet && typeof this.wallet.withSendLock === 'function' ? this.wallet.withSendLock(fn) : fn();
  }

  // A progress event on a stepwise row. Default from/to tor_sending: only the CLAIM comes from
  // another status, and _isStepwiseAttempt reads the claim alone.
  _stepwiseEvent(withdrawalId, note, from = 'tor_sending', to = 'tor_sending') {
    this.db.prepare(`
      INSERT INTO withdrawal_events (withdrawal_id, from_status, to_status, triggered_by, note)
      VALUES (?, ?, ?, 'scheduler', ?)
    `).run(withdrawalId, from, to, String(note).slice(0, 500));
  }

  // Guarded tor_step move (+ optional tor_final_slate and journal note, same transaction).
  _stepMove(withdrawalId, from, to, { finalSlate, note } = {}) {
    const moved = this.db.transaction(() => {
      const r = finalSlate !== undefined
        ? this.db.prepare(
          `UPDATE withdrawals SET tor_step = ?, tor_final_slate = ?
            WHERE id = ? AND status = 'tor_sending' AND tor_step = ?`).run(to, finalSlate, withdrawalId, from)
        : this.db.prepare(
          `UPDATE withdrawals SET tor_step = ?
            WHERE id = ? AND status = 'tor_sending' AND tor_step = ?`).run(to, withdrawalId, from);
      if (r.changes !== 1) return false;
      if (note) this._stepwiseEvent(withdrawalId, note);
      return true;
    })();
    if (moved) console.log(`[tor-stepwise] withdrawal ${withdrawalId}: step ${to}`);
    else console.error(`⚠️  [tor-stepwise] withdrawal ${withdrawalId}: lost its step guard (${from} → ${to}) — attempt stopped`);
    return moved;
  }

  // Is the row's CURRENT attempt a stepwise one? Its newest CLAIM event (into tor_sending from
  // another status) carries the 'stepwise:' marker. The CLI claim writes no note. Progress events
  // (tor_sending → tor_sending) are not claims, so a 'slate: …' note can never hide the marker.
  _isStepwiseAttempt(withdrawalId) {
    const row = this.db.prepare(
      `SELECT note FROM withdrawal_events
        WHERE withdrawal_id = ? AND to_status = 'tor_sending'
          AND (from_status IS NULL OR from_status != 'tor_sending')
        ORDER BY created_at DESC, id DESC LIMIT 1`
    ).get(withdrawalId);
    return !!(row && typeof row.note === 'string' && row.note.startsWith('stepwise:'));
  }

  // Did this row ever have a CLI attempt (a claim without the stepwise marker)?
  _hasCliAttempt(withdrawalId) {
    return !!this.db.prepare(
      `SELECT 1 FROM withdrawal_events
        WHERE withdrawal_id = ? AND to_status = 'tor_sending'
          AND (from_status IS NULL OR from_status != 'tor_sending')
          AND (note IS NULL OR note NOT LIKE 'stepwise:%')
        LIMIT 1`
    ).get(withdrawalId);
  }

  // Cancel the attempt's slate, THEN settle the row per `next`:
  //   { requeue: true }  → back to tor_checking (not a rung) — freeze, or a crash that was ours
  //   { retry: reason }  → scheduleRetry(id, reason) — null is a counted rung
  // The order is the whole point: a row must never reach tor_checking / retry_scheduled while its
  // slate is alive, because the admin cancel route refunds those two statuses. So a cancel that
  // fails leaves the row in tor_sending at its step, and the stale sweep tries the cancel again.
  // TransactionDoesntExist is proof enough only at 'initiated' (the lock never happened).
  // Never from 'posting': that tx is committed.
  async _stepwiseCancelThen(withdrawalId, slateId, next, why) {
    const row = this.db.prepare('SELECT status, tor_step FROM withdrawals WHERE id = ?').get(withdrawalId);
    if (!row || row.status !== 'tor_sending') {
      console.warn(`[tor-stepwise] withdrawal ${withdrawalId}: left tor_sending before its cancel — nothing done`);
      return false;
    }
    if (row.tor_step === 'posting') {
      console.error(`⚠️  [tor-stepwise] withdrawal ${withdrawalId}: refusing to cancel slate ${slateId} — it is committed ('posting')`);
      return false;
    }
    try {
      await this.wallet.cancelTx(slateId);
    } catch (err) {
      const neverLocked = row.tor_step === 'initiated' &&
        /TransactionDoesntExist|transaction doesn'?t exist/i.test(String(err && err.message));
      if (!neverLocked) {
        console.warn(
          `[tor-stepwise] withdrawal ${withdrawalId}: cancel of slate ${slateId} failed (${err && err.message}) — ` +
          `left in tor_sending at '${row.tor_step}'; the stale sweep will cancel it before anything else happens`
        );
        return false;
      }
    }
    const reason = String(why || '').slice(0, 300);
    if (next && next.requeue) {
      const ok = this._stepwiseRequeue(withdrawalId, `stepwise: requeued — slate ${slateId} cancelled (${reason})`);
      if (ok) console.warn(`[tor-stepwise] withdrawal ${withdrawalId}: slate ${slateId} cancelled, back to tor_checking (${reason})`);
      return ok;
    }
    try { this._stepwiseEvent(withdrawalId, `stepwise: slate ${slateId} cancelled (${reason})`); } catch (_) { /* journal only */ }
    await this.scheduleRetry(withdrawalId, next ? (next.retry || null) : null);
    return true;
  }

  // tor_sending → tor_checking, guarded, with its event. Costs no rung: used only when the
  // attempt holds no live slate (never created, or proven cancelled).
  _stepwiseRequeue(withdrawalId, note) {
    return this.db.transaction(() => {
      const r = this.db.prepare(
        "UPDATE withdrawals SET status = 'tor_checking' WHERE id = ? AND status = 'tor_sending'"
      ).run(withdrawalId);
      if (r.changes !== 1) return false;
      this._stepwiseEvent(withdrawalId, note, 'tor_sending', 'tor_checking');
      return true;
    })();
  }

  // §8.1.5 — every slate this row has ever journaled ('slate: <uuid>' notes) plus slate_id, each
  // looked up EXACTLY in the wallet tx log. { checked, outcome: 'confirmed'|'unconfirmed'|'dead',
  // tx, journaled }. A confirmed one wins over an unconfirmed one.
  async _stepwisePriorSlates(w) {
    const journaled = [];
    for (const e of this.db.prepare(
      "SELECT note FROM withdrawal_events WHERE withdrawal_id = ? AND note LIKE 'slate: %' ORDER BY id"
    ).all(w.id)) {
      const m = /^slate: ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i.exec(String(e.note));
      if (m && !journaled.includes(m[1].toLowerCase())) journaled.push(m[1].toLowerCase());
    }
    const want = new Set(journaled);
    if (w.slate_id) want.add(String(w.slate_id).toLowerCase());
    if (!want.size) return { checked: true, outcome: 'dead', tx: null, journaled };
    if (!this.wallet || typeof this.wallet.getTransactions !== 'function') {
      return { checked: false, outcome: 'unknown', tx: null, journaled };
    }
    let txs;
    try { txs = await this.wallet.getTransactions(true); }
    catch (e) {
      console.warn(`[tor-stepwise] re-attempt guard: wallet tx log unreadable — ${e.message}`);
      return { checked: false, outcome: 'unknown', tx: null, journaled };
    }
    if (!Array.isArray(txs)) return { checked: false, outcome: 'unknown', tx: null, journaled };
    let unconfirmed = null;
    for (const t of txs) {
      if (!t || !t.tx_slate_id || String(t.tx_type) !== 'TxSent') continue;
      if (!want.has(String(t.tx_slate_id).toLowerCase())) continue;
      if (t.confirmed) return { checked: true, outcome: 'confirmed', tx: t, journaled };
      unconfirmed = unconfirmed || t;
    }
    return { checked: true, outcome: unconfirmed ? 'unconfirmed' : 'dead', tx: unconfirmed, journaled };
  }

  // Before a stepwise RE-attempt creates a new slate. true = go ahead; false = the row was
  // settled or parked here.
  async _stepwiseReattemptGuard(w, netSend) {
    const id = w.id;
    const prior = await this._stepwisePriorSlates(w);
    if (!prior.checked) {
      // Unknown is parked, never guessed (the CLI rail's proceed-loudly exists to keep money
      // moving through an outage; here init needs the same wallet, so it would fail anyway).
      this._deferSend(id, null, 'wallet tx log could not be read before a stepwise re-attempt');
      return false;
    }
    if (prior.outcome === 'confirmed') {
      const sid = String(prior.tx.tx_slate_id);
      console.warn(`⚠️  [tor-stepwise] withdrawal ${id}: an earlier slate ${sid} is CONFIRMED on chain — confirming, not re-sending`);
      this.db.prepare('UPDATE withdrawals SET slate_id = ?, fee = COALESCE(?, fee), tor_final_slate = NULL WHERE id = ?')
        .run(sid, this._txFeeGrin(prior.tx), id);
      this._creditConfirm(id, 'tor_sending', `recovered: earlier stepwise slate ${sid} confirmed in the wallet tx log`);
      return false;
    }
    if (prior.outcome === 'unconfirmed') {
      const sid = String(prior.tx.tx_slate_id);
      console.error(
        `⚠️  [tor-stepwise] withdrawal ${id}: earlier slate ${sid} is still an UNCONFIRMED TxSent. A stepwise row ` +
        `only leaves tor_sending with a dead slate, so this breaks the invariant — parking it, not re-sending.`
      );
      this._deferSend(id, sid);
      return false;
    }
    // Every stepwise slate is dead. A CLI attempt in the row's history may not have captured its
    // slate id, so its amount match (_priorSendLanded) runs too, with today's three outcomes. When
    // slate_id is one of OUR dead slates, hide it so the matcher uses its amount branch.
    if (this._hasCliAttempt(id)) {
      const ours = w.slate_id && prior.journaled.includes(String(w.slate_id).toLowerCase());
      const p = await this._priorSendLanded(ours ? Object.assign({}, w, { slate_id: null }) : w, netSend);
      if (p.outcome === 'confirmed') {
        const sid = String(p.tx.tx_slate_id);
        console.warn(`⚠️  [tor-stepwise] withdrawal ${id}: an earlier CLI attempt (slate ${sid}) is CONFIRMED — confirming, not re-sending`);
        this.db.prepare('UPDATE withdrawals SET slate_id = ? WHERE id = ?').run(sid, id);
        await this.recordTorFee(id, netSend);
        await this.markConfirmed(id, 'recovered: earlier attempt confirmed in the wallet tx log');
        return false;
      }
      if (p.outcome === 'unconfirmed') {
        this._deferSend(id, p.tx && p.tx.tx_slate_id);
        return false;
      }
      if (!p.checked) {
        const everDeferred = this.db.prepare(
          "SELECT 1 FROM withdrawal_events WHERE withdrawal_id = ? AND note LIKE 'deferred:%' LIMIT 1"
        ).get(id);
        if (everDeferred) {
          this._deferSend(id, w.slate_id, 'wallet tx log could not be read after an earlier deferral');
          return false;
        }
        console.error(
          `⚠️  Withdrawal ${id}: retrying WITHOUT a double-send check — the wallet tx log ` +
          `could not be read. If this payout later looks duplicated, this is where to look.`
        );
      }
    }
    return true;
  }

  // Network fee of a tx-log entry, in GRIN, or null.
  _txFeeGrin(t) {
    if (!t) return null;
    const f = (t.fee && typeof t.fee === 'object') ? Number(t.fee.fee || 0) : Number(t.fee || 0);
    return Number.isFinite(f) && f > 0 ? parseFloat((f / 1e9).toFixed(9)) : null;
  }

  // ─── Double-send guard (audit §E.1) ─────────────────────────────────────────
  // A `grin-wallet send` that reports failure MAY still have posted. The CLI is SIGKILLed at
  // wallet_send_timeout_ms (120 s default), and the Tor round-trip + finalize + broadcast can all
  // have completed while the pipe was still open — the kill tells us the process died, not that
  // the money stayed. Retrying blindly pays the miner twice while the ledger debits once, which
  // is unrecoverable. So before every RE-attempt, ask the wallet whether this payout already went.
  //
  // The reversal cooldown does NOT cover this: it gates a miner starting a NEW withdrawal after a
  // refund, and a retry is the same row re-entering sendWithdrawal without passing that check.
  //
  // Only runs on a re-attempt. A first attempt cannot have a predecessor, so the normal path pays
  // no extra wallet round-trip and carries no false-positive risk.
  //
  // Matching is deliberately narrow, because a false POSITIVE marks a miner paid who was not:
  //   · exact slate_id when one was captured — authoritative, no amount guessing;
  //   · otherwise a TxSent whose net-to-recipient equals this payout's net, created no earlier
  //     than the withdrawal row, and whose slate_id is not already claimed by a DIFFERENT
  //     withdrawal (two miners withdrawing the same amount must never collide).
  // 'TxSentCancelled' is excluded — a cancelled tx never reached the chain. Note this is stricter
  // than _captureTorSlateId's /Sent/ regex, which matches the cancelled form too; that one only
  // decorates a proof link, this one decides whether to spend.
  //
  // ── THREE outcomes, not two (audit §J4-10) ──────────────────────────────────
  // This used to return "did a matching TxSent exist", and treat yes as "it landed". By §J4-1's
  // premise that is wrong: a bare 'TxSent' entry is written at tx_lock_outputs, so it says the
  // outputs were RESERVED and nothing about whether the transaction was broadcast. But the fix
  // here is NOT reclaimStaleFinalizing's — there, requiring `confirmed` is strictly safer, while
  // here it flips the risk the other way: a payout genuinely broadcast but not yet mined would
  // stop matching, the retry would proceed, and that is §H1's double-pay. So the answer has to
  // carry all three states and let the caller act differently on each:
  //
  //   outcome              meaning                                   caller does
  //   ───────────────────  ────────────────────────────────────────  ─────────────────────────
  //   'confirmed'          TxSent AND confirmed → proven on chain    confirm the payout
  //   'absent'             no match, or the match is cancelled       send (safe: never posted)
  //   'unconfirmed'        TxSent, not yet confirmed → UNKNOWN       DEFER — neither, re-ask
  //   checked === false    the wallet could not be consulted at all  send, with a loud log
  //
  // 'unconfirmed' is the state that has no safe guess: it is either "locked but never posted"
  // (re-sending is correct) or "posted and not yet mined" (re-sending double-pays), and the tx
  // log cannot tell them apart. Parking costs a delay; guessing costs money in one direction or
  // the other. Same reasoning, and the same vocabulary, as reclaimStaleFinalizing.
  //
  // checked=false is deliberately NOT the same as 'unconfirmed': it means the Owner API was
  // unreadable, which is a pool-wide outage, and parking every payout on it would strand live
  // money on any pool whose wallet is briefly down. That one proceeds, loudly.
  //
  // Returns { checked, outcome, tx }.
  async _priorSendLanded(withdrawal, netSend) {
    if (!this.wallet || typeof this.wallet.getTransactions !== 'function') {
      return { checked: false, outcome: 'unknown', tx: null };
    }
    try {
      // refresh=true: this decides whether to spend, so pay the node round-trip for accuracy.
      const txs = await this.wallet.getTransactions(true);
      if (!Array.isArray(txs)) return { checked: false, outcome: 'unknown', tx: null };

      const sent = txs.filter((t) => t && t.tx_slate_id && String(t.tx_type) === 'TxSent');

      // `confirmed` is the chain evidence — the same field lib/reconciliation.js:278 and
      // reclaimStaleFinalizing both test on this exact log. kernel_excess is deliberately not
      // used as a second signal: grin-wallet writes it at lock and at finalize, i.e. before
      // post_tx (see backfillKernelProofs).
      const verdict = (tx) =>
        ({ checked: true, outcome: tx ? (tx.confirmed ? 'confirmed' : 'unconfirmed') : 'absent', tx: tx || null });

      if (withdrawal.slate_id) {
        // Authoritative lookup. A slate present as TxSentCancelled, or absent from the wallet
        // entirely, is 'absent' — it never reached the chain — which is why the filter above
        // excludes the cancelled form rather than reporting it.
        const hit = sent.find((t) => String(t.tx_slate_id) === String(withdrawal.slate_id));
        return verdict(hit);
      }

      const claimed = new Set(
        this.db.prepare('SELECT slate_id FROM withdrawals WHERE slate_id IS NOT NULL AND id != ?')
          .all(withdrawal.id).map((r) => String(r.slate_id))
      );

      const wantNano = Math.round(Number(netSend) * 1e9);
      const createdAt = Number(withdrawal.created_at) || 0;

      // The amount branch has exactly one bound on age, so it cannot run without one (audit
      // §J4-4). If NO candidate carries a parseable timestamp, this wallet build does not give us
      // the field the match depends on — report that as an unread log rather than matching every
      // same-amount send in the wallet's whole history, which would mark a miner paid who was not.
      // Per-entry nulls are handled below; this catches the systemic case.
      if (sent.length && !sent.some((t) => this._txCreatedAt(t) !== null)) {
        console.warn(
          `[double-send guard] wallet tx log carries no parseable creation_ts — cannot bound the ` +
          `amount match by age, treating the log as unread`
        );
        return { checked: false, outcome: 'unknown', tx: null };
      }

      const matches = sent.filter((t) => {
        if (claimed.has(String(t.tx_slate_id))) return false;
        // An unparseable timestamp is a MISSING OBSERVATION, not a passing test. Treating it as
        // "no opinion" removed the only age bound and let a year-old send of the same amount be
        // accepted as this payout (audit §J4-4).
        const when = this._txCreatedAt(t);
        if (when === null) return false;
        if (when < createdAt - 60) return false; // predates this payout by more than clock slack
        const feeNano = (t.fee && typeof t.fee === 'object') ? Number(t.fee.fee || 0) : Number(t.fee || 0);
        const recipientNano =
          Number(t.amount_debited || 0) - Number(t.amount_credited || 0) - (Number.isFinite(feeNano) ? feeNano : 0);
        return Math.abs(recipientNano - wantNano) <= 1000; // 1 µGRIN tolerance
      });
      // Prefer a CONFIRMED match over an unconfirmed one. The amount branch can legitimately
      // return more than one candidate (the same miner, the same net, two attempts), and if any
      // of them is on chain the payout landed — reporting 'unconfirmed' because an unconfirmed
      // sibling sorted first would park a payout that is provably settled.
      return verdict(matches.find((t) => t.confirmed) || matches[0]);
    } catch (e) {
      console.warn(`[double-send guard] wallet tx log unreadable: ${e.message}`);
      return { checked: false, outcome: 'unknown', tx: null };
    }
  }

  // grin-wallet serialises TxLogEntry timestamps as RFC3339 strings; tolerate a numeric form
  // (seconds or millis) in case a wallet build differs. null when unparseable, which the caller
  // treats as "no opinion" rather than as a mismatch.
  _txCreatedAt(t) {
    const v = t && (t.creation_ts !== undefined ? t.creation_ts : t.creation_time);
    if (v === undefined || v === null) return null;
    if (typeof v === 'number') return v > 1e11 ? Math.floor(v / 1000) : Math.floor(v);
    const ms = Date.parse(String(v));
    return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
  }

  // Park a payout the double-send guard could not resolve (audit §J4-10). Returns the row to the
  // retry ladder so the normal machinery re-asks, but does NOT consume a rung.
  //
  // That distinction is the whole point. scheduleRetry() increments retry_count, and once the
  // ladder is exhausted it calls markFailed() → _reverseLock() → the balance is refunded. For an
  // ambiguous row that turns out to have been broadcast, refunding is the double-pay this guard
  // exists to prevent, arriving four deferrals later by a different door. A deferral is not a
  // failed attempt, so it must not be counted as one.
  //
  // The balance stays locked and the row stays inside PENDING_SQL throughout, so the miner cannot
  // start a second withdrawal against money that may already be moving.
  //
  // `why` overrides the default cause in the event note (the last-rung guard parks a row whose
  // wallet could not be READ, which is not "holds an unconfirmed send"). It must keep the
  // 'deferred:' prefix — the deferral counter above is keyed on it.
  _deferSend(withdrawalId, slateId, why = null) {
    try {
      const priorDefers = this.db.prepare(
        "SELECT COUNT(*) AS c FROM withdrawal_events WHERE withdrawal_id = ? AND note LIKE 'deferred:%'"
      ).get(withdrawalId).c;

      const nextAt = Math.floor(Date.now() / 1000) + SEND_DEFER_S;
      const cause = why || `wallet holds an unconfirmed send${slateId ? ` (slate ${slateId})` : ''}`;
      const note = `deferred: ${cause} — outcome unknown`;

      const moved = this.db.transaction(() => {
        // Guarded on the status this attempt claimed, exactly like scheduleRetry: an admin
        // cancel or a confirm that landed meanwhile must not be dragged back onto the ladder.
        const claimed = this.db.prepare(
          "UPDATE withdrawals SET status = 'retry_scheduled', next_retry_at = ? WHERE id = ? AND status = 'tor_sending'"
        ).run(nextAt, withdrawalId);
        if (claimed.changes !== 1) return false;
        this.db.prepare(`
          INSERT INTO withdrawal_events (withdrawal_id, from_status, to_status, triggered_by, note)
          VALUES (?, 'tor_sending', 'retry_scheduled', 'scheduler', ?)
        `).run(withdrawalId, note);
        return true;
      })();

      if (!moved) {
        console.warn(`[double-send guard] withdrawal ${withdrawalId} left tor_sending before deferral — skipped`);
        return false;
      }

      if (priorDefers + 1 >= MAX_SEND_DEFERRALS) {
        console.error(
          `⚠️  [CRITICAL] Withdrawal ${withdrawalId} has been deferred ${priorDefers + 1} times: the wallet ` +
          `still holds an unconfirmed send${slateId ? ` (slate ${slateId})` : ''} that is neither mining nor ` +
          `cancelled. The balance stays locked — this needs a human. Check the wallet tx log and the node.`
        );
      } else {
        console.warn(
          `[double-send guard] withdrawal ${withdrawalId}: ${cause} — ` +
          `neither confirming nor re-sending, re-asking in ${SEND_DEFER_S}s (deferral ${priorDefers + 1})`
        );
      }
      return true;
    } catch (e) {
      console.error(`[double-send guard] could not defer withdrawal ${withdrawalId}: ${e.message}`);
      return false;
    }
  }

  // A Tor send that fell back to a slatepack (lib/wallet-tor.js classifySendOutput) left a
  // TxSent entry with the outputs LOCKED and nothing finalized. Left alone, that entry is exactly
  // what the double-send guard reads as 'unconfirmed' on the retry — so the row would be deferred
  // over and over until a human cleared it, while the miner waited and the pool's outputs sat
  // locked. Cancelling it is safe: only the sender finalizes, the pool never did, so no copy of
  // this transaction can reach the chain. The cancelled entry then reads as 'absent' and the
  // retry sends a fresh transaction.
  //
  // The slate id comes from this send's OWN output (the .S1.slatepack path), never from an
  // amount match — cancelling someone else's in-flight payout would be the worse bug. No id, or
  // a failed cancel → leave it; the guard parks the row (defer, no rung) rather than double-pay.
  async _releaseTorFallback(withdrawalId, slateId) {
    if (!slateId) {
      console.error(
        `⚠️  Withdrawal ${withdrawalId}: Tor send fell back to a slatepack but its slate id could not be ` +
        `read from the CLI output — the locked outputs stay locked and the retry will be deferred. ` +
        `Cancel the unfinalized TxSent in the pool wallet by hand.`
      );
      return false;
    }
    if (!this.wallet || typeof this.wallet.cancelTx !== 'function') return false;
    try {
      await this.wallet.cancelTx(slateId);
      console.warn(`[tor] withdrawal ${withdrawalId}: cancelled fallback slate ${slateId} (never finalized) before retry`);
      return true;
    } catch (e) {
      console.error(
        `⚠️  Withdrawal ${withdrawalId}: could not cancel fallback slate ${slateId} (${e.message}) — ` +
        `the retry will be deferred until it is cancelled`
      );
      return false;
    }
  }

  // A failed Tor send: 'pool_wallet_short' when grin-wallet refused for lack of POOL funds (and
  // the health card is told), otherwise null. `error` is the CLI's message.
  _retryReasonFor(withdrawal, netSend, error) {
    if (!isNotEnoughFunds({ message: error })) return null;
    this._noteWalletShort({ withdrawalId: withdrawal.id, method: withdrawal.method || 'tor', amount: netSend, error });
    return 'pool_wallet_short';
  }

  // The pool wallet could not cover a payout. The miner is told only "pool busy, try later"; the
  // real figures (grin-wallet's available/needed) belong to the operator, so they go to the log
  // and to ONE rolling `alerts` row of type 'pool_wallet_short', which /api/admin/health turns
  // into a Degraded state on the Grin Wallet card. Rolling = while the last occurrence is under
  // 24h old the row is updated in place (count + latest figures) instead of stacking one row per
  // failed attempt; an older one is resolved and a fresh row starts. Best-effort: a failure to
  // record must never change what happens to the payout.
  _noteWalletShort({ withdrawalId, method, amount, error }) {
    const amt = amount == null ? 'an unknown amount of' : amount;
    console.error(`⚠️  Payout ${withdrawalId} (${method}): pool wallet cannot cover ${amt} GRIN — ${error}`);
    try {
      const message = `Pool wallet could not cover ${method} payout #${withdrawalId} (${amt} GRIN): ${String(error).slice(0, 400)}`;
      this._rollingAlert('pool_wallet_short', 'warning', message, { withdrawal_id: withdrawalId, method, amount });
    } catch (e) {
      console.error(`[payout] failed to record pool_wallet_short alert: ${e.message}`);
    }
  }

  // ONE `alerts` row per type, rolled in place: while the active row was last seen under 24h ago
  // it is updated (count + 1, latest level/message/data) instead of stacking a row per
  // occurrence; an older one is resolved and a fresh row starts. Written straight to the table —
  // it shows on the admin Alerts list and wherever /api/admin/health reads it, but is NOT pushed
  // off-box (that is AlertMonitor.triggerAlert's job). Throws; callers decide how loud to be.
  _rollingAlert(type, level, message, data) {
    const now = new Date().toISOString();
    const dayAgo = new Date(Date.now() - 86400000).toISOString();
    const json = JSON.stringify(data);
    this.db.transaction(() => {
      const live = this.db.prepare(
        `SELECT id FROM alerts WHERE type = ? AND status = 'active' AND last_seen >= ?
         ORDER BY id DESC LIMIT 1`
      ).get(type, dayAgo);
      if (live) {
        this.db.prepare(
          `UPDATE alerts SET occurrence_count = occurrence_count + 1, last_seen = ?, level = ?, message = ?, data = ?
           WHERE id = ?`
        ).run(now, level, message, json, live.id);
        return;
      }
      this.db.prepare(
        `UPDATE alerts SET status = 'resolved', resolved_at = ? WHERE type = ? AND status = 'active'`
      ).run(now, type);
      this.db.prepare(
        `INSERT INTO alerts (type, level, message, data, status, triggered_at, last_seen)
         VALUES (?, ?, ?, ?, 'active', ?, ?)`
      ).run(type, level, message, json, now, now);
    })();
  }

  _resolveAlert(type) {
    try {
      this.db.prepare(
        `UPDATE alerts SET status = 'resolved', resolved_at = ? WHERE type = ? AND status = 'active'`
      ).run(new Date().toISOString(), type);
    } catch (e) {
      console.error(`[payout] failed to resolve ${type} alert: ${e.message}`);
    }
  }

  // `reason` is stored on the row (retry_reason) so the account page can say WHY the payout is
  // parked: 'pool_wallet_short' (the pool's own wallet could not cover it) vs NULL (anything else —
  // almost always the miner's listener not answering over Tor). Every call rewrites it, so a
  // payout that was short once and then hits an offline miner is not left saying "pool busy".
  //
  // A 'pool_wallet_short' retry is NOT counted (F3), for the same reason a deferral is not
  // (_deferSend): the ladder measures the MINER's wallet not answering, and exhausting it ends
  // in markFailed → refund. A shortfall says nothing about the miner and usually clears within
  // the hour, so it re-tries after SHORTFALL_RETRY_S with retry_count untouched — checked BEFORE
  // the exhaustion test, so a shortfall on the last rung does not refund either. The double-send
  // guard still arms on the re-attempt: it keys on the event log's tor_sending rows, not on
  // retry_count. Counted from 'shortfall:' event notes (keep the prefix), so after
  // MAX_SHORTFALL_RETRIES the shortfall falls through to the ladder below like any failure.
  async scheduleRetry(withdrawalId, reason = null) {
    try {
      const withdrawal = this.db.prepare(`
        SELECT * FROM withdrawals WHERE id = ?
      `).get(withdrawalId);

      if (!withdrawal) return;

      // Stepwise Tor send only (design §8.1.3): the POOL's tor daemon was down before any byte
      // reached the miner. Same shape as the shortfall branch below, with its own 'tor-down:'
      // counter — a broken pool tor must not walk a miner's payout down the refund ladder, but a
      // tor that stays broken for ~6 h (24 × 15 min) takes the ladder like any failure.
      if (reason === 'pool_tor_unavailable') {
        const priorDown = this.db.prepare(
          "SELECT COUNT(*) AS c FROM withdrawal_events WHERE withdrawal_id = ? AND note LIKE 'tor-down:%'"
        ).get(withdrawalId).c;
        if (priorDown < MAX_TOR_DOWN_RETRIES) {
          const nextAt = Math.floor(Date.now() / 1000) + TOR_DOWN_RETRY_S;
          const moved = this.db.transaction(() => {
            const claimed = this.db.prepare(`
              UPDATE withdrawals SET status = 'retry_scheduled', next_retry_at = ?, retry_reason = ?
              WHERE id = ? AND status = ?
            `).run(nextAt, reason, withdrawalId, withdrawal.status);
            if (claimed.changes !== 1) return false;
            this.db.prepare(`
              INSERT INTO withdrawal_events (withdrawal_id, from_status, to_status, triggered_by, note)
              VALUES (?, ?, 'retry_scheduled', 'scheduler', ?)
            `).run(
              withdrawalId, withdrawal.status,
              `tor-down: pool tor unavailable, retry ${priorDown + 1}/${MAX_TOR_DOWN_RETRIES} (not counted) at ` +
                new Date(nextAt * 1000).toISOString()
            );
            return true;
          })();
          if (!moved) {
            console.warn(`[retry] withdrawal ${withdrawalId} left ${withdrawal.status} before retry scheduling — skipped`);
            return;
          }
          console.warn(
            `[${new Date().toISOString()}] Withdrawal ${withdrawalId}: the pool's own tor is unavailable — ` +
            `retrying in ${TOR_DOWN_RETRY_S}s (tor-down ${priorDown + 1}/${MAX_TOR_DOWN_RETRIES}, not counted)`
          );
          return;
        }
        console.error(
          `⚠️  Withdrawal ${withdrawalId}: pool tor-down cap reached (${priorDown}/${MAX_TOR_DOWN_RETRIES} ` +
          `uncounted retries) — falling back to the normal retry ladder. Check the tor daemon on this box.`
        );
      }

      if (reason === 'pool_wallet_short') {
        const priorShort = this.db.prepare(
          "SELECT COUNT(*) AS c FROM withdrawal_events WHERE withdrawal_id = ? AND note LIKE 'shortfall:%'"
        ).get(withdrawalId).c;
        if (priorShort < MAX_SHORTFALL_RETRIES) {
          const nextAt = Math.floor(Date.now() / 1000) + SHORTFALL_RETRY_S;
          const moved = this.db.transaction(() => {
            const claimed = this.db.prepare(`
              UPDATE withdrawals SET status = 'retry_scheduled', next_retry_at = ?, retry_reason = ?
              WHERE id = ? AND status = ?
            `).run(nextAt, reason, withdrawalId, withdrawal.status);
            if (claimed.changes !== 1) return false;
            this.db.prepare(`
              INSERT INTO withdrawal_events (withdrawal_id, from_status, to_status, triggered_by, note)
              VALUES (?, ?, 'retry_scheduled', 'scheduler', ?)
            `).run(
              withdrawalId, withdrawal.status,
              `shortfall: pool wallet short, retry ${priorShort + 1}/${MAX_SHORTFALL_RETRIES} (not counted) at ` +
                new Date(nextAt * 1000).toISOString()
            );
            return true;
          })();
          if (!moved) {
            console.warn(`[retry] withdrawal ${withdrawalId} left ${withdrawal.status} before retry scheduling — skipped`);
            return;
          }
          console.log(
            `[${new Date().toISOString()}] Withdrawal ${withdrawalId}: pool wallet short — retrying in ` +
            `${SHORTFALL_RETRY_S}s (shortfall ${priorShort + 1}/${MAX_SHORTFALL_RETRIES}, not counted)`
          );
          return;
        }
        console.error(
          `⚠️  Withdrawal ${withdrawalId}: pool wallet shortfall cap reached (${priorShort}/${MAX_SHORTFALL_RETRIES} ` +
          `uncounted retries) — the wallet looks underfunded, not busy. Falling back to the normal retry ` +
          `ladder; top up the pool wallet.`
        );
      }

      if (withdrawal.retry_count >= this.retryDelays.length) {
        await this.markFailed(withdrawalId);
        return;
      }

      const nextRetryDelay = this.retryDelays[withdrawal.retry_count];
      const nextRetryAt = Math.floor(Date.now() / 1000) + nextRetryDelay;

      // Guarded on the status we just read: a row that reached a settled state meanwhile (the
      // double-send guard confirming it, an admin cancel) must not be dragged back onto the
      // retry ladder for another send.
      const stmt = this.db.prepare(`
        UPDATE withdrawals
        SET status = 'retry_scheduled', retry_count = retry_count + 1, next_retry_at = ?, retry_reason = ?
        WHERE id = ? AND status = ?
      `);
      if (stmt.run(nextRetryAt, reason, withdrawalId, withdrawal.status).changes !== 1) {
        console.warn(`[retry] withdrawal ${withdrawalId} left ${withdrawal.status} before retry scheduling — skipped`);
        return;
      }

      const eventStmt = this.db.prepare(`
        INSERT INTO withdrawal_events
        (withdrawal_id, from_status, to_status, triggered_by, note)
        VALUES (?, ?, ?, 'scheduler', ?)
      `);
      eventStmt.run(
        withdrawalId,
        withdrawal.status,
        'retry_scheduled',
        `Retry ${withdrawal.retry_count + 1}/${this.retryDelays.length} at ${new Date(nextRetryAt * 1000).toISOString()}` +
          (reason ? ` (${reason})` : '')
      );

      console.log(
        `[${new Date().toISOString()}] Withdrawal ${withdrawalId} scheduled for retry (attempt ${withdrawal.retry_count + 1})`
      );
    } catch (err) {
      console.error(`Error scheduling retry for withdrawal ${withdrawalId}: ${err.message}`);
    }
  }

  // ─── On-chain kernel proof (payment-proof deep-link surface) ────────────────
  // Fill in the kernel excess of each confirmed payout so the account page can deep-link it to a
  // chain explorer (grincoin.org/kernel/<excess>). READ-ONLY w.r.t. balances — it only writes
  // the proof column, never moves or unlocks funds — so it is safe to run even while payouts are
  // frozen. Requires the Owner-API wallet (this.wallet): the Tor CLI rail exposes no structured
  // kernel, so a Tor-only deployment without the Owner API simply gets no kernel column.
  //
  // Matching: the wallet's TxLogEntry carries kernel_excess and tx_slate_id. Slatepack/nostr
  // payouts store their slate_id, so they match exactly. Tor rows get their slate_id captured
  // post-send by _captureTorSlateId(), so they match the same way.
  //
  // Only a CONFIRMED entry counts. kernel_excess is NOT a mined signal: grin-wallet v5.4.1 writes
  // it at tx_lock_outputs (selection.rs lock_tx_context) and rewrites it at finalize
  // (tx.rs update_stored_tx), both before post_tx; confirming the tx never touches it. The
  // kernel column is the "paid · mined" badge and the explorer link, so it must wait for
  // `confirmed` — the same chain evidence _priorSendLanded and reclaimStaleFinalizing test.
  //
  // The same tick runs the "marked paid but not mined" watchdog (_watchUnmined) off the SAME
  // tx-log read: both ask the wallet the same question about the same rows, and the refresh is
  // the slow part. Kernels are attached first, so a payout that just mined is never flagged.
  async backfillKernelProofs() {
    if (!this.wallet) return;
    try {
      const now = Math.floor(Date.now() / 1000);
      const cutoff = now - 30 * 86400; // bound the scan to recent payouts
      const pending = this.db.prepare(
        `SELECT id, slate_id FROM withdrawals
         WHERE status = 'confirmed' AND kernel_excess IS NULL AND slate_id IS NOT NULL
           AND created_at >= ?
         ORDER BY created_at DESC LIMIT 200`
      ).all(cutoff);
      if (!pending.length && !this._unminedCandidates(now).length) {
        // Nothing paid is waiting to be seen mined — so nothing is overdue either.
        this._paidChainState = new Map();
        this._resolveAlert('payout_unmined');
        return;
      }

      // The tx scan refreshes from the node (slow); throttle to at most once every 3 min even if
      // rows linger — a just-broadcast payout isn't mined for a minute or two anyway.
      if (this._lastKernelScan && (Date.now() - this._lastKernelScan) < 180000) return;
      this._lastKernelScan = Date.now();

      // An unreadable log (throw → catch below) or an empty one leaves the alert exactly as it
      // was: "could not look" is not "nothing is wrong".
      const txs = await this.wallet.getTransactions(true);
      if (!Array.isArray(txs) || !txs.length) return;

      const bySlate = new Map();
      for (const t of txs) {
        if (t && t.confirmed === true && t.tx_slate_id && t.kernel_excess) {
          bySlate.set(String(t.tx_slate_id), t.kernel_excess);
        }
      }

      const upd = this.db.prepare(
        'UPDATE withdrawals SET kernel_excess = ? WHERE id = ? AND kernel_excess IS NULL'
      );
      let filled = 0;
      for (const w of pending) {
        const excess = bySlate.get(String(w.slate_id));
        if (excess) { upd.run(excess, w.id); filled++; }
      }
      if (filled) {
        console.log(`[${new Date().toISOString()}] kernel-proof backfill: attached ${filled} payout proof(s)`);
      }

      await this._watchUnmined(txs);
    } catch (err) {
      console.warn(`[kernel-proof] backfill skipped: ${err.message}`);
    }
  }

  // ─── "Marked paid but not mined" watchdog (F2) ──────────────────────────────
  // A payout turns 'confirmed' when the send COMMAND succeeds (Tor: the CLI returned; slatepack /
  // Goblin: finalize + post_tx returned). Nothing checked that the tx then MINED, and a Grin node
  // drops its mempool on restart — so a posted payout can vanish while the miner reads "paid",
  // and the wallet keeps its inputs locked in an unconfirmed TxSent (which can itself cause the
  // NotEnoughFunds shortfall). lib/reconciliation.js checks only the opposite direction (a
  // confirmed wallet send with no pool row).
  //
  // Candidates: confirmed, no kernel yet, marked paid over UNMINED_ALERT_S ago, created in the
  // last 30 days (the kernel backfill's window). Each is classified by its slate in the tx log:
  //   state          tx log                         alert level   automatic step
  //   ─────────────  ─────────────────────────────  ────────────  ─────────────────────────────
  //   'mined'        TxSent, confirmed              —             none (the backfill has it)
  //   'unmined'      TxSent, not confirmed          warning       repost the stored tx
  //   'cancelled'    TxSentCancelled                critical      none — the miner was NOT paid
  //   'absent'       no entry for the slate         critical      none — nothing to repost
  //   'unverifiable' the row has no slate id        warning       none — nothing to look up
  //
  // It moves no money: no status, balance or ledger write, ever. A cancelled / absent row is a
  // miner debited for a payout that (as far as this wallet knows) never left — but "the wallet
  // does not know it" is not proof it never landed (a restored or swapped wallet, a mis-captured
  // slate id), so the remedy is the operator's, by hand, with the runbook in the alert data.
  async _watchUnmined(txs) {
    const now = Math.floor(Date.now() / 1000);
    const rows = this._unminedCandidates(now);

    // Sender-side entries only. A payout slate has exactly one, as TxSent or (after cancel_tx
    // rewrote it) TxSentCancelled; prefer a confirmed TxSent should the log ever hold two.
    const sent = new Map();
    const cancelled = new Set();
    for (const t of txs) {
      if (!t || !t.tx_slate_id) continue;
      const sid = String(t.tx_slate_id);
      const type = String(t.tx_type || '');
      if (type === 'TxSent') {
        const prev = sent.get(sid);
        if (!prev || (t.confirmed && !prev.confirmed)) sent.set(sid, t);
      } else if (type === 'TxSentCancelled') {
        cancelled.add(sid);
      }
    }

    const state = new Map();
    const flagged = [];
    for (const w of rows) {
      const sid = w.slate_id ? String(w.slate_id) : null;
      let s;
      let t = null;
      if (!sid) s = 'unverifiable';
      else if (sent.has(sid)) { t = sent.get(sid); s = t.confirmed ? 'mined' : 'unmined'; }
      else s = cancelled.has(sid) ? 'cancelled' : 'absent';
      state.set(Number(w.id), s);
      if (s !== 'mined') flagged.push({ w, state: s, tx: t });
    }
    this._paidChainState = state;

    if (!flagged.length) {
      this._resolveAlert('payout_unmined');
      return;
    }
    try {
      this._raiseUnminedAlert(flagged, now);
    } catch (e) {
      console.error(`[unmined] failed to record payout_unmined alert: ${e.message}`);
    }

    // The repost moves no new money — it re-broadcasts a transaction the pool already signed and
    // debited — but the freeze is the operator's "stop everything outbound" switch, often thrown
    // because the wallet itself is suspect, so it waits for a resume like every other send path.
    if (this.isFrozen()) return;
    await this._repostUnmined(flagged.filter((f) => f.state === 'unmined'), now);
  }

  _unminedCandidates(now) {
    return this.db.prepare(
      `SELECT id, grin_address, amount, method, slate_id, COALESCE(confirmed_at, created_at) AS paid_at
         FROM withdrawals
        WHERE status = 'confirmed' AND kernel_excess IS NULL
          AND COALESCE(confirmed_at, created_at) <= ? AND created_at >= ?
        ORDER BY id ASC LIMIT 500`
    ).all(now - UNMINED_ALERT_S, now - 30 * 86400);
  }

  // ONE rolling 'payout_unmined' alert, rewritten every tick while anything is overdue (see
  // _rollingAlert) and resolved by the first tick that finds nothing. Critical rows sort first so
  // the list cap can never hide a miner who was not paid behind a merely slow one.
  _raiseUnminedAlert(flagged, now) {
    const SEVERITY = { cancelled: 0, absent: 1, unmined: 2, unverifiable: 3 };
    const WHAT = {
      unmined:      'sent, not mined',
      cancelled:    'CANCELLED in the pool wallet — the miner was NOT paid',
      absent:       'no record of this slate in the pool wallet',
      unverifiable: 'cannot verify — no slate id was captured',
    };
    const counts = { unmined: 0, cancelled: 0, absent: 0, unverifiable: 0 };
    for (const f of flagged) counts[f.state]++;
    const critical = counts.cancelled + counts.absent;
    const sorted = [...flagged].sort((a, b) => (SEVERITY[a.state] - SEVERITY[b.state]) || (a.w.id - b.w.id));
    const utc = (s) => `${new Date(s * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
    const age = (s) => { const m = Math.max(0, Math.floor(s / 60)); return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`; };

    const LIST_CAP = 10;
    const lines = sorted.slice(0, LIST_CAP).map(({ w, state }) =>
      `#${w.id} ${w.method || 'tor'}: ${WHAT[state]} ` +
      `(${w.slate_id ? `slate ${w.slate_id}, ` : ''}paid ${utc(w.paid_at)}, ${age(now - w.paid_at)} ago)`);
    const n = flagged.length;
    const message =
      `${n} payout${n === 1 ? '' : 's'} marked paid but not seen mined after ${UNMINED_ALERT_S / 3600} h` +
      (critical ? ` — ${critical} of them NOT paid as far as the pool wallet knows` : '') +
      `: ${lines.join(' · ')}${n > LIST_CAP ? ` · …+${n - LIST_CAP} more` : ''}`;

    this._rollingAlert('payout_unmined', critical ? 'critical' : 'warning', message, {
      total: n,
      counts,
      rows: sorted.slice(0, 50).map(({ w, state }) => ({
        withdrawal_id: w.id, method: w.method, slate_id: w.slate_id || null, state,
        paid_at: new Date(w.paid_at * 1000).toISOString(),
      })),
      runbook: {
        unmined: 'The pool re-broadcasts the stored transaction itself (at most hourly, ' +
          `${MAX_REPOSTS} times; see the "repost:" events on the row). If it still does not mine, check ` +
          'that the node is synced and read the repost note for the node\'s reason. `grin-wallet txs` shows ' +
          'the entry; `grin-wallet repost -i <id>` is the same step by hand.',
        cancelled: 'The pool wallet cancelled this transaction, so its inputs were released and the coins ' +
          'never left — the miner was debited but NOT paid. Confirm with `grin-wallet txs` ' +
          '(TxSentCancelled) and on the explorer, then settle it by hand: credit the balance back or pay ' +
          'again. There is no automatic refund.',
        absent: 'The pool wallet holds no entry for this slate: a restored or replaced wallet, or a slate id ' +
          'captured wrongly. Look for the payment on the wallet that actually sent it and on the explorer ' +
          'before doing anything. Never re-pay without proof it did not land.',
        unverifiable: 'No slate id was captured for this payout, so the wallet cannot be asked about it. ' +
          'Find it by amount and time in `grin-wallet txs`.',
      },
    });
  }

  // Re-broadcast the stored transaction of each "sent, not mined" payout — the one automatic
  // step, and it cannot pay twice: it is the SAME transaction (same inputs, same kernel), so the
  // chain accepts it at most once, and a node that already holds or mined it rejects the copy.
  // It never builds a new tx, never cancels, never refunds, never changes a status.
  //
  // Runs through the CLI's `grin-wallet repost -i <tx log id>` (WalletTor.repostTx), NOT Owner
  // API v3 get_stored_tx → post_tx. Over JSON-RPC get_stored_tx returns a compact V4 slate with
  // an empty `sigs` array (api/src/owner_rpc.rs get_stored_tx → VersionedSlate::into_version V4),
  // and post_tx rebuilds the kernel from `sigs` only (libwallet/src/slate.rs tx_from_slate_v4),
  // so that round-trip posts a zero kernel the node rejects. The CLI keeps the Slate in-process
  // and also refuses by itself a tx that is already confirmed or was never finalized
  // (controller/src/command.rs repost) — two checks that are the wallet's, not ours.
  //
  // Rate: once per row per REPOST_EVERY_S, REPOST_MAX_PER_TICK rows per tick, MAX_REPOSTS per row
  // ever — all keyed on the append-only event log ('repost:' notes), so a restart cannot reset
  // them. The outcome is journaled but decides nothing: the next tick's `confirmed` does.
  async _repostUnmined(candidates, now) {
    if (!candidates.length) return;
    if (!this.walletTor || typeof this.walletTor.repostTx !== 'function') return;
    const history = this.db.prepare(
      `SELECT COUNT(*) AS n, MAX(created_at) AS last FROM withdrawal_events
        WHERE withdrawal_id = ? AND note LIKE 'repost:%'`
    );
    const journal = this.db.prepare(
      `INSERT INTO withdrawal_events (withdrawal_id, from_status, to_status, triggered_by, note)
       VALUES (?, 'confirmed', 'confirmed', 'scheduler', ?)`
    );
    let done = 0;
    for (const { w, tx } of candidates) {
      if (done >= REPOST_MAX_PER_TICK) break;
      const h = history.get(w.id);
      if (h.n >= MAX_REPOSTS) {
        this._repostCapWarned = this._repostCapWarned || new Set();
        if (!this._repostCapWarned.has(w.id)) {
          this._repostCapWarned.add(w.id);
          console.error(
            `⚠️  [unmined] withdrawal ${w.id}: reposted ${h.n} times and still not mined — no more automatic ` +
            `reposts; this needs a human (see the payout_unmined alert's runbook)`
          );
        }
        continue;
      }
      if (h.last && now - Number(h.last) < REPOST_EVERY_S) continue;
      const txLogId = Number(tx && tx.id);
      if (!Number.isInteger(txLogId) || txLogId < 0) continue;

      done++;
      let outcome;
      try {
        const r = await this.walletTor.repostTx(txLogId);
        outcome = `${r && r.ok ? 'ran' : 'failed'}: ${String((r && r.output) || '').trim().slice(-200) || '(no output)'}`;
      } catch (e) {
        outcome = `failed: ${String(e.message || e).slice(0, 200)}`;
      }
      const note = `repost: slate ${w.slate_id} (tx log id ${txLogId}) ${h.n + 1}/${MAX_REPOSTS} — ${outcome}`;
      try { journal.run(w.id, note); } catch (e) { /* journal is best-effort; the rate check re-reads it */ }
      console.warn(`[unmined] withdrawal ${w.id}: marked paid but not mined — ${note}`);
    }
  }

  // Admin payments view: where a PAID row stands on chain. null for any row that is not
  // 'confirmed'. The kernel column is the proof of 'mined'; the rest comes from the watchdog's
  // last scan (in memory — empty for up to one tick after a restart, when an overdue row reads
  // 'unmined', which is still literally true: not yet SEEN mined).
  //   'mined' | 'settling' (paid < 1 h ago) | 'unmined' | 'cancelled' | 'absent' | 'unverifiable'
  // Rows older than the 30-day watch window without a kernel return null: nobody looks any more.
  chainStateOf(w, now = Math.floor(Date.now() / 1000)) {
    if (!w || w.status !== 'confirmed') return null;
    if (w.kernel_excess) return 'mined';
    if (Number(w.created_at) < now - 30 * 86400) return null;
    const seen = this._paidChainState && this._paidChainState.get(Number(w.id));
    if (seen) return seen;
    if (!w.slate_id || !this.wallet) return 'unverifiable';
    const paidAt = Number(w.confirmed_at || w.created_at) || 0;
    return now - paidAt < UNMINED_ALERT_S ? 'settling' : 'unmined';
  }

  // ─── Signed payment proofs (dispute evidence) ───────────────────────────────
  // The kernel above proves a transaction was MINED; it does not, on its own, prove WHO received
  // it — a kernel carries no addresses, so a pool could point at any kernel and write a miner's
  // address beside it. The payment proof closes that: grin-wallet's PaymentProof carries the
  // RECIPIENT's ed25519 signature over (amount ‖ excess ‖ sender address), and the recipient key
  // IS the miner's grin1 address, so it is third-party-verifiable evidence that this wallet took
  // this amount at this kernel (`grin-wallet verify_proof`, or the explorer's /proof page).
  //
  // Only the Tor rail has one: `grin-wallet send -d grin1…` requests a proof by default for a
  // slatepack destination, and the step-by-step Tor send (tor_send_mode = 'stepwise') passes the
  // miner's address as payment_proof_recipient_address itself. The slatepack/nostr rails pass
  // null (lib/wallet.js initSendTx) — turning that on changes
  // the slate every recipient wallet must sign and is a money-path change, so it is NOT done
  // here; those rows keep '' (none) and the kernel remains their evidence.
  //
  // Read-only + best-effort, like the kernel backfill: never moves funds, runs while frozen.
  // Only rows the kernel backfill has already seen CONFIRMED are asked (the wallet refuses a
  // proof for an unconfirmed tx), so the call is a local tx-log read — no node round-trip.
  // '' is a terminal answer ("the wallet holds no proof for this tx") so a row is never asked
  // twice; a transient failure leaves NULL and is retried on a later tick, logged once per row.
  async fetchAndStorePaymentProof(withdrawalId) {
    if (!this.wallet || typeof this.wallet.retrievePaymentProof !== 'function') {
      return { ok: false, reason: 'owner_api_unavailable' };
    }
    const w = this.db.prepare(
      'SELECT id, status, method, slate_id, kernel_excess, payment_proof FROM withdrawals WHERE id = ?'
    ).get(withdrawalId);
    if (!w) return { ok: false, reason: 'not_found' };
    if (w.payment_proof) return { ok: true, proof: JSON.parse(w.payment_proof), cached: true };
    if (w.payment_proof === '') return { ok: false, reason: 'none' };
    if (w.status !== 'confirmed' || !w.slate_id || !w.kernel_excess) return { ok: false, reason: 'not_confirmed' };
    if (w.method !== 'tor') {
      // The rail never requested one — record that so the backfill does not keep asking.
      this.db.prepare("UPDATE withdrawals SET payment_proof = '' WHERE id = ? AND payment_proof IS NULL").run(withdrawalId);
      return { ok: false, reason: 'none' };
    }
    try {
      const proof = await this.wallet.retrievePaymentProof(w.slate_id, false);
      if (!proof || typeof proof !== 'object' || !proof.recipient_sig || !proof.excess) {
        return { ok: false, reason: 'malformed' };
      }
      // The proof must be OUR payout: the kernel the backfill attached and the kernel the
      // wallet signed over have to agree, or a wrong slate_id (§J4-11's failure class) would
      // hand the miner a stranger's proof file.
      if (String(proof.excess).toLowerCase() !== String(w.kernel_excess).toLowerCase()) {
        console.error(
          `[payment-proof] withdrawal ${withdrawalId}: proof excess ${proof.excess} does not match the row's ` +
          `kernel ${w.kernel_excess} — NOT storing (slate_id ${w.slate_id} may be misattributed)`
        );
        return { ok: false, reason: 'kernel_mismatch' };
      }
      this.db.prepare('UPDATE withdrawals SET payment_proof = ? WHERE id = ? AND payment_proof IS NULL')
        .run(JSON.stringify(proof), withdrawalId);
      return { ok: true, proof, cached: false };
    } catch (err) {
      const msg = String(err.message || err);
      // grin-wallet's definitive "this tx has no proof" errors — terminal, stop asking.
      if (/no payment proof|does not (have|contain) a payment proof|payment proof not (present|requested|found)/i.test(msg)) {
        this.db.prepare("UPDATE withdrawals SET payment_proof = '' WHERE id = ? AND payment_proof IS NULL").run(withdrawalId);
        return { ok: false, reason: 'none' };
      }
      this._proofWarned = this._proofWarned || new Set();
      if (!this._proofWarned.has(withdrawalId)) {
        this._proofWarned.add(withdrawalId);
        console.warn(`[payment-proof] withdrawal ${withdrawalId}: could not retrieve proof (${msg}) — will retry`);
      }
      return { ok: false, reason: 'error', error: msg };
    }
  }

  async backfillPaymentProofs() {
    if (!this.wallet) return;
    try {
      // Cheap local reads, but bound the per-tick work so a wallet outage cannot turn every
      // tick into a burst of failing calls. Newest first: a fresh payout is the one a miner is
      // about to look for.
      if (this._lastProofScan && (Date.now() - this._lastProofScan) < 60000) return;
      const pending = this.db.prepare(
        `SELECT id FROM withdrawals
         WHERE status = 'confirmed' AND method = 'tor' AND payment_proof IS NULL
           AND slate_id IS NOT NULL AND kernel_excess IS NOT NULL
         ORDER BY id DESC LIMIT 20`
      ).all();
      if (!pending.length) return;
      this._lastProofScan = Date.now();
      let stored = 0;
      for (const w of pending) {
        const r = await this.fetchAndStorePaymentProof(w.id);
        if (r.ok && !r.cached) stored++;
        else if (r.reason === 'owner_api_unavailable') return;
      }
      if (stored) {
        console.log(`[${new Date().toISOString()}] payment-proof backfill: stored ${stored} signed proof(s)`);
      }
    } catch (err) {
      console.warn(`[payment-proof] backfill skipped: ${err.message}`);
    }
  }

  // After a Tor CLI send, record the slate_id of the just-broadcast tx so backfillKernelProofs()
  // can later attach its on-chain kernel excess (the CLI rail never returns a structured slate).
  // Best-effort + READ-ONLY: any failure leaves slate_id NULL (that payout just won't get a proof
  // link) and never touches the payout itself. Runs right after send when the newest sent tx in
  // the wallet log is ours (sends are serialized through the scheduler).
  // ⚠ This is best-effort PROOF METADATA, but the value it writes is not inert, which is why
  // its matching rules must be the guard's and not a second, looser copy (audit §J4-11). The
  // old version matched `/Sent/` (which also matches TxSentCancelled — a transaction that never
  // reached the chain), `>= wantNano` rather than the exact net, no time bound at all, and
  // "newest by id" as the tie-break. Observed directly: after a re-send it attached `OLD`, a
  // year-old unrelated transaction. What the wrong value then does:
  //   · it becomes the account page's kernel deep-link, so a miner is shown a STRANGER's
  //     transaction as proof of their own payment;
  //   · _priorSendLanded builds its `claimed` set from withdrawals.slate_id, so a wrong value
  //     here can shield a genuine match belonging to a DIFFERENT withdrawal;
  //   · backfillKernelProofs will attach the wrong kernel to the row.
  // Sends are serialised through the scheduler, so "newest sent tx" is normally ours — this
  // needed an unusual wallet log to bite, which is exactly the kind of bug that waits.
  async _captureTorSlateId(withdrawalId, amountGrin) {
    if (!this.wallet) return;
    try {
      const txs = await this.wallet.getTransactions(false); // local tx log — no node refresh needed
      if (!Array.isArray(txs) || !txs.length) return;

      const row = this.db.prepare('SELECT created_at FROM withdrawals WHERE id = ?').get(withdrawalId);
      const createdAt = Number(row && row.created_at) || 0;
      const wantNano = Math.round(Number(amountGrin || 0) * 1e9);
      const claimed = new Set(
        this.db.prepare('SELECT slate_id FROM withdrawals WHERE slate_id IS NOT NULL AND id != ?')
          .all(withdrawalId).map((r) => String(r.slate_id))
      );

      const candidate = txs
        // 'TxSent' exactly — never the cancelled form, which is not evidence of anything.
        .filter((t) => t && t.tx_slate_id && String(t.tx_type) === 'TxSent')
        // …not already the proof for a different payout.
        .filter((t) => !claimed.has(String(t.tx_slate_id)))
        // …created no earlier than this row, with the same clock slack the guard allows. An
        // entry with no parseable timestamp is a missing observation, not a pass (§J4-4).
        .filter((t) => { const w = this._txCreatedAt(t); return w !== null && w >= createdAt - 60; })
        // …and the EXACT net to the recipient, fee included, not merely "at least".
        .filter((t) => {
          const feeNano = (t.fee && typeof t.fee === 'object') ? Number(t.fee.fee || 0) : Number(t.fee || 0);
          const recipientNano = Number(t.amount_debited || 0) - Number(t.amount_credited || 0)
                              - (Number.isFinite(feeNano) ? feeNano : 0);
          return Math.abs(recipientNano - wantNano) <= 1000; // 1 µGRIN tolerance
        })
        .sort((a, b) => Number(b.id || 0) - Number(a.id || 0))[0];

      if (candidate) {
        this.db.prepare(
          'UPDATE withdrawals SET slate_id = ? WHERE id = ? AND slate_id IS NULL'
        ).run(String(candidate.tx_slate_id), withdrawalId);
      }
    } catch (e) { /* best-effort proof metadata — never affects the payout */ }
  }

  // Settle a successful Tor send. Delegates to the shared guarded/transactional confirm so the
  // Tor rail cannot double-settle either — the send path and a concurrent reversal both have to
  // win the same claim, and only one can.
  async markConfirmed(withdrawalId, note = null) {
    return this._creditConfirm(withdrawalId, 'tor_sending', note || 'Successfully sent');
  }

  // Terminal failure after the retry ladder is exhausted: reverse the lock and park the row.
  // Uses the shared guarded/transactional reversal — critically, this means a row the double-send
  // guard has already confirmed can never be reversed on top of it.
  //
  // ── Last-rung guard ──────────────────────────────────────────────────────────
  // The double-send guard in sendWithdrawal runs BEFORE each re-attempt, so it covers attempts
  // 0..N-1. It never covered attempt N: the final send that "failed" went straight here, and
  // here reversed the lock with no question asked. A `grin-wallet send` that reports failure
  // may still have posted (SIGKILLed at wallet_send_timeout_ms after the broadcast — §E.1), and
  // on the final rung that is not a timing accident a miner has to get lucky with: the ladder
  // is deterministic and the retry count is on their account page, so a wallet that stays dark
  // for attempts 0..N-1 and then answers attempt N slowly enough to straddle the timeout keeps
  // the coins AND gets the balance back. So the final rung makes the same three-way decision a
  // re-attempt does, against the wallet's own tx log:
  //   confirmed    → the payout landed; settle it, never refund
  //   unconfirmed  → outcome unknown; park it (balance stays locked), re-ask in SEND_DEFER_S
  //   absent       → never posted; reverse the lock — the only branch that refunds
  // A wallet that cannot be read is treated like 'unconfirmed', NOT like sendWithdrawal's
  // proceed-loudly: there, proceeding keeps live money moving through a brief outage; here the
  // only thing "proceeding" does is refund, and a refund on top of a landed send is the one
  // outcome that cannot be undone. Waiting costs the miner minutes; guessing costs the pool the
  // payout twice.
  //
  // The reversal reads the row's CURRENT status rather than assuming one. In practice this is
  // always 'tor_sending' (scheduleRetry is only ever reached from inside sendWithdrawal, after
  // the claim), NOT the 'retry_scheduled' the old event row claimed — but reading it keeps the
  // compare-and-swap honest for any future caller. Both statements are synchronous, so nothing
  // can interleave between the read and the swap; a status that changed anyway loses the swap.
  async markFailed(withdrawalId) {
    const w = this.db.prepare('SELECT * FROM withdrawals WHERE id = ?').get(withdrawalId);
    if (!w) return;

    const netSend = this._netSend(w.amount, w.fee_charged || 0);
    let prior = { checked: false, outcome: 'unknown', tx: null };
    try {
      prior = await this._priorSendLanded(w, netSend);
    } catch (e) {
      console.error(`[last-rung guard] withdrawal ${withdrawalId}: tx-log check threw (${e.message}) — treating as unknown`);
    }
    if (prior.outcome === 'confirmed') {
      const slate = prior.tx && prior.tx.tx_slate_id;
      console.warn(
        `[last-rung guard] withdrawal ${withdrawalId}: the final attempt reported failure but its send is ` +
        `CONFIRMED on chain${slate ? ` (slate ${slate})` : ''} — settling instead of refunding`
      );
      if (slate) {
        this.db.prepare('UPDATE withdrawals SET slate_id = COALESCE(slate_id, ?) WHERE id = ?')
          .run(String(slate), withdrawalId);
      }
      // Same settlement as sendWithdrawal's recovered branch: the network fee is recorded so
      // reconciliation can explain the wallet-vs-ledger gap this payout leaves.
      await this.recordTorFee(withdrawalId, netSend);
      await this.markConfirmed(withdrawalId, 'recovered on the last rung: final attempt confirmed in the wallet tx log');
      return;
    }
    if (prior.outcome === 'unconfirmed' || !prior.checked) {
      if (!prior.checked) {
        console.error(
          `⚠️  [last-rung guard] withdrawal ${withdrawalId}: the wallet tx log could not be read, so it is ` +
          `unknown whether the final attempt posted. NOT refunding — parked with the balance locked until ` +
          `the wallet answers.`
        );
      }
      this._deferSend(
        withdrawalId,
        prior.tx && prior.tx.tx_slate_id,
        prior.checked ? null : 'last rung reached but the wallet tx log could not be read'
      );
      return;
    }

    const ok = this._reverseLock(withdrawalId, 'tor_failed', w.status, 'Max retries exceeded');
    if (ok) {
      console.warn(
        `⚠️  Withdrawal ${withdrawalId} failed after max retries (${w.amount} GRIN reversed to balance)`
      );
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
  // `opts.adminOverride` (freshAdmin-gated caller only) lets the operator push a payout BELOW the
  // pool minimum — the sub-threshold "email support to withdraw" case — by sending it through this
  // same locked Tor flow instead of an out-of-band send. It bypasses ONLY the min floor and the
  // post-failure reversal cooldown; the freeze, the CAS balance lock, and the pending caps (incl.
  // the one-pending-per-address rule that prevents a double-pay) all still apply.
  // Read-only admission precheck — audit §J12-12.
  //
  // Exists so a caller that must do EXPENSIVE work before creating a withdrawal can find out
  // first whether the request is going to be refused anyway. The Tor rail's pre-flight probe
  // is the case: it built up to two fresh Tor circuits (≤6 s) BEFORE any of these checks ran,
  // so a miner holding one valid ownership proof could force 20 circuit builds a minute at the
  // `withdraw` bucket even while every withdrawal they asked for would 429 on the
  // one-pending-per-address rule.
  //
  // This is a CHEAP EARLY REFUSAL, not the gate. Every check here is repeated authoritatively
  // inside createWithdrawal's transaction, where the pending count and the balance CAS have to
  // live to be race-free. Same pattern, and the same reasoning, as the admin-count pre-check in
  // POST /api/auth/register. Never move the authoritative copy out; never let this one be the
  // only check.
  //
  // Throws the same `.code`-carrying Error the caller already maps to an HTTP status, so the
  // refusal a miner sees is identical whichever check produced it.
  precheckWithdrawable(grinAddress, opts = {}) {
    const fail = (msg, code) => { const e = new Error(msg); e.code = code; throw e; };
    const adminOverride = !!(opts && opts.adminOverride);

    if (!grinAddress) fail('address required', 400);
    this._assertNotFrozen();
    if (!adminOverride) this._assertNoRecentReversal(grinAddress);

    const acct = this.db.prepare(
      'SELECT 1 AS x FROM miner_accounts WHERE grin_address = ?'
    ).get(grinAddress);
    if (!acct) fail('account not found', 404);

    const totalPending = this.db.prepare(
      `SELECT COUNT(*) AS c FROM withdrawals WHERE ${PENDING_SQL}`
    ).get().c;
    if (totalPending >= this.MAX_PENDING_WITHDRAWALS) {
      fail(POOL_BUSY_MSG, 429);
    }
    const userPending = this.db.prepare(
      `SELECT COUNT(*) AS c FROM withdrawals WHERE grin_address = ? AND ${PENDING_SQL}`
    ).get(grinAddress).c;
    if (userPending >= 1) fail('you already have a pending withdrawal', 429);

    return true;
  }

  createWithdrawal(grinAddress, amount, method = 'tor', opts = {}) {
    const fail = (msg, code) => { const e = new Error(msg); e.code = code; throw e; };
    const adminOverride = !!(opts && opts.adminOverride);

    if (!grinAddress) fail('address required', 400);
    if (method !== 'tor') fail('only Tor withdrawals are supported', 400);
    this._assertNotFrozen();
    if (!adminOverride) this._assertNoRecentReversal(grinAddress);

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
    if (!adminOverride && amt < minW) fail(`amount below minimum withdrawal (${minW} GRIN)`, 400);

    // Freeze the fee now and prove the payout covers it BEFORE any balance is locked — an
    // adminOverride bypasses the min floor, so this is the only guard on a tiny payout.
    const feeCharged = this._feeFor(amt);
    this._netSend(amt, feeCharged);

    const txn = this.db.transaction(() => {
      const totalPending = this.db.prepare(
        `SELECT COUNT(*) AS c FROM withdrawals WHERE ${PENDING_SQL}`
      ).get().c;
      if (totalPending >= this.MAX_PENDING_WITHDRAWALS) {
        fail(POOL_BUSY_MSG, 429);
      }
      // Design §8: at most ONE pending withdrawal per address — across ALL rails.
      const userPending = this.db.prepare(
        `SELECT COUNT(*) AS c FROM withdrawals WHERE grin_address = ? AND ${PENDING_SQL}`
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
        `INSERT INTO withdrawals (grin_address, amount, fee, fee_charged, status)
         VALUES (?, ?, 0, ?, 'tor_checking')`
      ).run(grinAddress, amt, feeCharged).lastInsertRowid;

      this.db.prepare(`
        INSERT INTO balance_log
        (grin_address, event_type, amount, balance_before, balance_after, locked_before, locked_after, reference_type, reference_id)
        VALUES (?, 'lock', ?, ?, ?, ?, ?, 'withdrawal', ?)
      `).run(grinAddress, amt, before.balance, before.balance - amt,
             before.balance_locked, before.balance_locked + amt, wid);

      this.db.prepare(`
        INSERT INTO withdrawal_events (withdrawal_id, from_status, to_status, triggered_by, note)
        VALUES (?, NULL, 'tor_checking', ?, ?)
      `).run(wid, adminOverride ? 'admin_override' : 'miner',
             adminOverride ? `admin below-min Tor payout (${amt} GRIN)` : `withdrawal requested (${amt} GRIN)`);

      return wid;
    });

    const withdrawal_id = txn();
    console.log(`[${new Date().toISOString()}] Withdrawal ${withdrawal_id} created for ${grinAddress} (${amt} GRIN, fee ${feeCharged}, locked${adminOverride ? ', admin-override' : ''})`);
    return {
      success: true, withdrawal_id, amount: amt,
      fee_charged: feeCharged, net_amount: this._netSend(amt, feeCharged)
    };
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
    this._assertNoRecentReversal(grinAddress);

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

    // Flat fee frozen at request time; the slate below is built for the NET amount.
    const feeCharged = this._feeFor(amt);
    const netSend = this._netSend(amt, feeCharged);

    // Lock the pool-side balance first (authoritative for accounting); the wallet-side output
    // lock happens during tx_lock_outputs below, and is released via cancelTx on failure.
    const txn = this.db.transaction(() => {
      const totalPending = this.db.prepare(`SELECT COUNT(*) AS c FROM withdrawals WHERE ${PENDING_SQL}`).get().c;
      if (totalPending >= this.MAX_PENDING_WITHDRAWALS) fail(POOL_BUSY_MSG, 429);
      const userPending = this.db.prepare(`SELECT COUNT(*) AS c FROM withdrawals WHERE grin_address = ? AND ${PENDING_SQL}`).get(grinAddress).c;
      if (userPending >= 1) fail('you already have a pending withdrawal', 429);

      const before = this.db.prepare('SELECT balance, balance_locked FROM miner_accounts WHERE grin_address = ?').get(grinAddress);
      const locked = this.db.prepare(
        `UPDATE miner_accounts SET balance = balance - ?, balance_locked = balance_locked + ?, updated_at = unixepoch()
         WHERE grin_address = ? AND balance >= ?`
      ).run(amt, amt, grinAddress, amt);
      if (locked.changes !== 1) fail('insufficient balance', 409);

      const wid = this.db.prepare(
        `INSERT INTO withdrawals (grin_address, amount, fee, fee_charged, status, method)
         VALUES (?, ?, 0, ?, 'slatepack_pending', 'slatepack')`
      ).run(grinAddress, amt, feeCharged).lastInsertRowid;

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
      // Select + lock under the wallet's send lock (see _withSendLock) so no other rail's init
      // can pick the same coins between these two calls.
      await this._withSendLock(async () => {
        slate = await this.wallet.initSendTx(netSend);
        await this.wallet.txLockOutputs(slate);
      });
      const armored = await this.wallet.createSlatepackMessage(slate, [grinAddress]);
      const slateId = slate && slate.id ? slate.id : null;
      // Record the real network fee (sender-pays in Grin: the wallet spends netSend + fee while
      // the ledger debits the full amount). Reconciliation reads withdrawals.fee to explain the
      // wallet-vs-ledger gap — a permanent fee = 0 makes coverage erode silently. This is the
      // REAL chain fee, not the flat fee_charged we bill the miner; the two are independent.
      const feeGrin = this._slateFeeGrin(slate);
      this.db.prepare('UPDATE withdrawals SET slate_id = ?, fee = COALESCE(?, fee) WHERE id = ?')
        .run(slateId, feeGrin, withdrawalId);
      console.log(`[${new Date().toISOString()}] Slatepack withdrawal ${withdrawalId} created for ${grinAddress} (${amt} GRIN gross, ${netSend} net, slate ${slateId})`);
      // The deadline is measured from the ROW's created_at — the same clock
      // processSlatepackExpiry compares — so what the miner is told is what the sweep enforces.
      const row = this.db.prepare('SELECT created_at FROM withdrawals WHERE id = ?').get(withdrawalId);
      return {
        success: true, withdrawal_id: withdrawalId, amount: amt,
        fee_charged: feeCharged, net_amount: netSend, slatepack: armored,
        expires_at: (row ? row.created_at : Math.floor(Date.now() / 1000)) + this.slatepackTtlSeconds
      };
    } catch (err) {
      try { if (slate && slate.id) await this.wallet.cancelTx(slate.id); } catch (_) { /* best-effort */ }
      this._reverseLock(withdrawalId, 'slatepack_failed', 'slatepack_pending', `slate creation failed: ${err.message}`);
      if (isNotEnoughFunds(err)) {
        this._noteWalletShort({ withdrawalId, method: 'slatepack', amount: netSend, error: err.message });
        const e = new Error(WALLET_SHORT_MSG); e.code = 503; throw e;
      }
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

    // Take the row out of the pending pool BEFORE the first await. The status check above is a
    // read; this is the decision. Between them nothing has yielded, so the claim is the point at
    // which the expiry sweep and admin cancel can no longer touch this payout.
    if (!this._claimForFinalize(withdrawalId)) {
      fail('this payout is already being settled — refresh to see its final state', 409);
    }

    let finalized;
    let broadcastAttempted = false;
    try {
      const slate = await this.wallet.slateFromSlatepackMessage(responseSlatepack, [0]);
      // Bind the response to the slate we issued — rejects a pasted slate for a different tx.
      if (w.slate_id && slate && slate.id && slate.id !== w.slate_id) {
        fail('slatepack does not match this withdrawal', 400);
      }
      finalized = await this.wallet.finalizeTx(slate);
      broadcastAttempted = true;   // set BEFORE postTx: a throw from postTx is ambiguous, not a failure
      await this.wallet.postTx(finalized, true);
    } catch (err) {
      if (!broadcastAttempted) {
        // Failed before anything could reach the chain — safe to re-open for another attempt.
        this._releaseFinalizeClaim(withdrawalId, `finalize failed: ${err.message}`);
      } else {
        // postTx threw. It may still have landed, so re-opening the row would risk a second
        // broadcast. Leave the claim standing and let reclaimStaleFinalizing settle it against
        // the wallet tx log — the one source that knows.
        console.error(
          `⚠️  Withdrawal ${withdrawalId}: postTx threw (${err.message}) — outcome UNKNOWN, ` +
          `left claimed for the stale-finalize sweep to resolve`
        );
      }
      if (err.code) throw err; // our own 4xx (e.g. mismatch) — surface as-is
      const e = new Error(`failed to finalize slatepack: ${err.message}`); e.code = 502; throw e;
    }

    this._creditConfirm(withdrawalId, 'finalizing', 'slatepack finalized + posted');
    return { success: true, withdrawal_id: withdrawalId, status: 'confirmed' };
  }

  // ─── Goblin/Nostr payout (design §15) ───────────────────────────────────────
  // Third-party rail: the slate is delivered to the miner's registered Goblin username
  // over a Nostr DM. The route has ALREADY resolved + TOFU-verified `recipientPubHex`
  // against the stored destination and enforced the destination cooldown — this method
  // never trusts a raw username. It reuses the slatepack state machine end-to-end:
  //   • parks in 'slatepack_pending' with method='nostr' → inside PENDING_SQL (one-pending
  //     cross-rail) and processSlatepackExpiry (TTL refund) with no extra code;
  //   • the same freeze + failed-payout-cooldown gates as every other rail;
  //   • the S1 is PLAIN armor (recipients:[]) — confidentiality is the Nostr DM layer, and
  //     goblin's AutoReceive expects plain armor (verified, design §15.1). This is the ONE
  //     difference from the manual slatepack rail (which age-encrypts to the mining address).
  // On any wallet OR relay failure the balance lock is reversed so funds are never stranded.
  async createNostrWithdrawal(grinAddress, amount, recipientPubHex, note) {
    const fail = (msg, code) => { const e = new Error(msg); e.code = code; throw e; };
    if (!grinAddress) fail('address required', 400);
    if (!this.wallet) fail('slatepack payouts are not configured on this pool', 503);
    if (!this.nostrBridge || !this.nostrBridge.isEnabled()) fail('nostr payouts are not enabled on this pool', 503);
    if (!/^[0-9a-f]{64}$/.test(String(recipientPubHex || ''))) fail('invalid destination', 400);
    this._assertNotFrozen();
    this._assertNoRecentReversal(grinAddress);

    const acct0 = this.db.prepare('SELECT balance FROM miner_accounts WHERE grin_address = ?').get(grinAddress);
    if (!acct0) fail('account not found', 404);

    let amt = amount === undefined || amount === null || amount === '' ? acct0.balance : parseFloat(amount);
    if (isNaN(amt) || amt <= 0) fail('invalid amount', 400);
    amt = parseFloat(amt.toFixed(9));
    const minW = this.config.min_withdrawal || 25.0;
    if (amt < minW) fail(`amount below minimum withdrawal (${minW} GRIN)`, 400);

    // Flat fee frozen at request time; the S1 slate below is built for the NET amount.
    const feeCharged = this._feeFor(amt);
    const netSend = this._netSend(amt, feeCharged);

    // Lock the pool-side balance first (authoritative). Same CAS + caps as the other rails.
    const txn = this.db.transaction(() => {
      const totalPending = this.db.prepare(`SELECT COUNT(*) AS c FROM withdrawals WHERE ${PENDING_SQL}`).get().c;
      if (totalPending >= this.MAX_PENDING_WITHDRAWALS) fail(POOL_BUSY_MSG, 429);
      const userPending = this.db.prepare(`SELECT COUNT(*) AS c FROM withdrawals WHERE grin_address = ? AND ${PENDING_SQL}`).get(grinAddress).c;
      if (userPending >= 1) fail('you already have a pending withdrawal', 429);

      const before = this.db.prepare('SELECT balance, balance_locked FROM miner_accounts WHERE grin_address = ?').get(grinAddress);
      const locked = this.db.prepare(
        `UPDATE miner_accounts SET balance = balance - ?, balance_locked = balance_locked + ?, updated_at = unixepoch()
         WHERE grin_address = ? AND balance >= ?`
      ).run(amt, amt, grinAddress, amt);
      if (locked.changes !== 1) fail('insufficient balance', 409);

      const wid = this.db.prepare(
        `INSERT INTO withdrawals (grin_address, amount, fee, fee_charged, status, method)
         VALUES (?, ?, 0, ?, 'slatepack_pending', 'nostr')`
      ).run(grinAddress, amt, feeCharged).lastInsertRowid;

      this.db.prepare(`
        INSERT INTO balance_log
        (grin_address, event_type, amount, balance_before, balance_after, locked_before, locked_after, reference_type, reference_id)
        VALUES (?, 'lock', ?, ?, ?, ?, ?, 'withdrawal', ?)
      `).run(grinAddress, amt, before.balance, before.balance - amt, before.balance_locked, before.balance_locked + amt, wid);

      this.db.prepare(`
        INSERT INTO withdrawal_events (withdrawal_id, from_status, to_status, triggered_by, note)
        VALUES (?, NULL, 'slatepack_pending', 'miner', ?)
      `).run(wid, `nostr payout requested (${amt} GRIN)`);

      return wid;
    });

    const withdrawalId = txn();

    // Build the S1 slate (plain armor) and hand it to the bridge to wrap + publish. Any
    // failure (wallet OR no relay accepted) reverses the lock — nothing is stranded.
    let slate = null;
    try {
      await this._withSendLock(async () => {
        slate = await this.wallet.initSendTx(netSend);
        await this.wallet.txLockOutputs(slate);
      });
      const armored = await this.wallet.createSlatepackMessage(slate, []); // recipients:[] → plain armor
      const slateId = slate && slate.id ? slate.id : null;
      const feeGrin = this._slateFeeGrin(slate);
      this.db.prepare('UPDATE withdrawals SET slate_id = ?, fee = COALESCE(?, fee) WHERE id = ?')
        .run(slateId, feeGrin, withdrawalId);

      await this.nostrBridge.publishSlatepack(recipientPubHex, armored, note);

      console.log(`[${new Date().toISOString()}] Nostr payout ${withdrawalId} sent for ${grinAddress} (${amt} GRIN gross, ${netSend} net, slate ${slateId})`);
      return {
        success: true, withdrawal_id: withdrawalId, amount: amt,
        fee_charged: feeCharged, net_amount: netSend, status: 'slatepack_pending'
      };
    } catch (err) {
      try { if (slate && slate.id) await this.wallet.cancelTx(slate.id); } catch (_) { /* best-effort */ }
      this._reverseLock(withdrawalId, 'nostr_failed', 'slatepack_pending', `nostr send failed: ${err.message}`);
      if (isNotEnoughFunds(err)) {
        this._noteWalletShort({ withdrawalId, method: 'nostr', amount: netSend, error: err.message });
        const e = new Error(WALLET_SHORT_MSG); e.code = 503; throw e;
      }
      const e = new Error(`failed to send nostr payout: ${err.message}`); e.code = err.code && err.code >= 400 && err.code < 600 ? err.code : 502; throw e;
    }
  }

  // Called by the bridge when a RESPONSE (S2) slatepack arrives for a pending nostr row.
  // `senderPubHex` is the seal-verified Nostr sender — re-checked here (defence in depth)
  // against the address's registered destination before any on-chain action. Errors are
  // logged and the row is LEFT pending (goblin may resend; the TTL sweep refunds otherwise)
  // — this runs off a relay event, not a request, so throwing would only spam the log.
  async finalizeNostrWithdrawal(withdrawalId, grinAddress, responseSlatepack, senderPubHex) {
    if (!this.wallet) return;
    if (this.isFrozen()) {
      console.warn(`[nostr-payout] finalize ${withdrawalId} skipped — payouts frozen; will retry on resend/TTL`);
      return;
    }
    try {
      const w = this.db.prepare('SELECT * FROM withdrawals WHERE id = ?').get(withdrawalId);
      if (!w || w.status !== 'slatepack_pending' || w.method !== 'nostr') return;
      if (w.grin_address !== grinAddress) return;

      const acct = this.db.prepare('SELECT nostr_npub FROM miner_accounts WHERE grin_address = ?').get(grinAddress);
      if (!acct || !acct.nostr_npub || acct.nostr_npub !== senderPubHex) {
        console.warn(`[nostr-payout] finalize ${withdrawalId} rejected — sender ${senderPubHex.slice(0, 12)}… ≠ registered destination`);
        return;
      }

      // Claim before the first await. This rail is the most exposed of the three: its TTL is 10
      // minutes, not 24 hours, so a wallet that comes online late lands its response right on the
      // sweep. Relays also redeliver, so two response events for one payout are ordinary traffic —
      // the claim is what makes the second one a no-op instead of a second broadcast.
      if (!this._claimForFinalize(withdrawalId)) {
        console.warn(`[nostr-payout] finalize ${withdrawalId} skipped — already being settled`);
        return;
      }

      let broadcastAttempted = false;
      try {
        const slate = await this.wallet.slateFromSlatepackMessage(responseSlatepack, [0]);
        if (w.slate_id && slate && slate.id && slate.id !== w.slate_id) {
          console.warn(`[nostr-payout] finalize ${withdrawalId} rejected — slate ${slate && slate.id} ≠ issued ${w.slate_id}`);
          this._releaseFinalizeClaim(withdrawalId, 'response slate did not match the issued slate');
          return;
        }
        const finalized = await this.wallet.finalizeTx(slate);
        broadcastAttempted = true;
        await this.wallet.postTx(finalized, true);
      } catch (err) {
        if (!broadcastAttempted) {
          this._releaseFinalizeClaim(withdrawalId, `nostr finalize failed: ${err.message}`);
          console.warn(`[nostr-payout] finalize ${withdrawalId} failed before broadcast (back to pending): ${err.message}`);
        } else {
          console.error(
            `⚠️  Nostr payout ${withdrawalId}: postTx threw (${err.message}) — outcome UNKNOWN, ` +
            `left claimed for the stale-finalize sweep to resolve`
          );
        }
        return;
      }

      this._creditConfirm(withdrawalId, 'finalizing', 'nostr response finalized + posted');
      console.log(`[${new Date().toISOString()}] Nostr payout ${withdrawalId} confirmed (${w.amount} GRIN to ${grinAddress})`);
    } catch (err) {
      console.warn(`[nostr-payout] finalize ${withdrawalId} error (left pending): ${err.message}`);
    }
  }

  // Miner-initiated cancel: frees the one-pending-per-address slot and returns the locked
  // amount to spendable balance. NOTE: the public cancel route was removed 2026-07-17 (parked
  // states self-recover; a late cancel after a send that actually posted would double-pay), and
  // NOTHING CALLS THIS TODAY — the admin cancel (/api/admin/withdrawals/:id/cancel) carries its
  // own inline implementation in index.js. Kept as the reference implementation of a safe
  // cancel; if a support route ever needs one, call this rather than writing a third copy.
  // Only PARKED states are cancellable — retry_scheduled (Tor payout waiting hours for its next
  // attempt) and slatepack_pending (miner never returned the slate). tor_checking/tor_sending
  // are actively being sent and must settle first.
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
      const now = Math.floor(Date.now() / 1000);
      const cutoff = now - this.slatepackTtlSeconds;             // manual slatepack rail (30 min default)
      const nostrCutoff = now - this.nostrPendingTtlSeconds;     // Goblin/Nostr rail (10 min default)
      // Nostr rows expire on the shorter clock; every other pending rail uses the long TTL.
      const stale = this.db.prepare(
        `SELECT * FROM withdrawals
          WHERE status = 'slatepack_pending'
            AND ( (method = 'nostr' AND created_at <= ?)
                  OR ((method IS NULL OR method != 'nostr') AND created_at <= ?) )
          ORDER BY created_at ASC LIMIT 10`
      ).all(nostrCutoff, cutoff);
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
  //
  // The released amount is split across TWO debit rows that always sum to `released`:
  //   'withdrawal' → what the miner actually received on-chain (amount − fee_charged)
  //   'withdrawal_fee' → the flat withdrawal fee, matched by an equal credit to pool_fee
  // Splitting matters for honesty, not just tidiness: reconciliation's flow statement and the
  // public payments page both read debit/'withdrawal' as "paid to miners". Logging the gross
  // there would overstate every payout by the fee. The paired pool_fee credit keeps the
  // integrity invariant balanced (Σbalances still equals Σledger) and makes the fee visible as
  // income rather than money that silently vanished. 'withdrawal_fee' is deliberately NOT counted
  // as external money IN by reconciliation — it is an internal transfer, exactly like fee_cut.
  _releaseLockAndDebit(withdrawal) {
    const txn = this.db.transaction(() => {
      const acct = this.db.prepare(
        'SELECT balance, balance_locked FROM miner_accounts WHERE grin_address = ?'
      ).get(withdrawal.grin_address);
      const lockedBefore = acct ? acct.balance_locked : 0;
      // The settlement drains locked only, so spendable is unchanged — but record its REAL value
      // (these rows used to carry a literal 0/0, which the ledger rendered as "balance after 0").
      const spendable = acct ? acct.balance : 0;
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

      // Clamp the fee to what was actually released so the two rows can never sum to more than
      // the release (the corruption path above can shrink it); net absorbs the remainder.
      const feeCharged = Math.min(
        Math.max(0, Number(withdrawal.fee_charged) || 0),
        released
      );
      const netPaid = parseFloat((released - feeCharged).toFixed(9));

      const logDebit = this.db.prepare(`
        INSERT INTO balance_log
        (grin_address, event_type, amount, balance_before, balance_after,
         locked_before, locked_after, reference_type, reference_id)
        VALUES (?, 'debit', ?, ?, ?, ?, ?, ?, ?)
      `);
      logDebit.run(withdrawal.grin_address, netPaid, spendable, spendable, lockedBefore,
                   lockedBefore - released, 'withdrawal', withdrawal.id);

      if (feeCharged > 0) {
        logDebit.run(withdrawal.grin_address, feeCharged, spendable, spendable, lockedBefore - released,
                     lockedBefore - released, 'withdrawal_fee', withdrawal.id);

        // Matching credit to the pool_fee pseudo-account. INSERT OR IGNORE first: on a pool
        // whose fee percent is 0 the account may not exist yet, and a missing row would drop
        // the credit silently and break the invariant.
        this.db.prepare(
          'INSERT OR IGNORE INTO miner_accounts (grin_address, balance) VALUES (?, 0)'
        ).run(POOL_FEE_ADDRESS);
        this.db.prepare(
          'UPDATE miner_accounts SET balance = balance + ?, updated_at = unixepoch() WHERE grin_address = ?'
        ).run(feeCharged, POOL_FEE_ADDRESS);
        this.db.prepare(`
          INSERT INTO balance_log
          (grin_address, event_type, amount, balance_before, balance_after,
           locked_before, locked_after, reference_type, reference_id)
          VALUES (?, 'credit', ?, 0, 0, 0, 0, 'withdrawal_fee', ?)
        `).run(POOL_FEE_ADDRESS, feeCharged, withdrawal.id);
      }
    });
    txn();
  }

  // Confirm a payout: mark confirmed, release the lock (locked −= amount = paid out), ledger debit,
  // join-bonus. Generic over fromStatus so both the Tor and slatepack rails reuse it.
  //
  // Guarded + transactional for the same reason as _reverseLock: the status claim and the ledger
  // release must be one indivisible step, so a confirm and a reversal can never both land on one
  // row. Returns false when another path already settled it.
  _creditConfirm(withdrawalId, fromStatus, note) {
    try {
      let w = null;
      this.db.transaction(() => {
        const claimed = this.db.prepare(
          "UPDATE withdrawals SET status = 'confirmed', confirmed_at = unixepoch() WHERE id = ? AND status = ?"
        ).run(withdrawalId, fromStatus);
        if (claimed.changes !== 1) return;

        this.db.prepare(`
          INSERT INTO withdrawal_events (withdrawal_id, from_status, to_status, triggered_by, note)
          VALUES (?, ?, 'confirmed', 'scheduler', ?)
        `).run(withdrawalId, fromStatus, note);

        w = this.db.prepare('SELECT * FROM withdrawals WHERE id = ?').get(withdrawalId);
        this._releaseLockAndDebit(w);
      })();

      if (!w) {
        console.warn(`[confirm] withdrawal ${withdrawalId} was not in ${fromStatus} — confirm skipped (already settled elsewhere)`);
        return false;
      }

      console.log(`[${new Date().toISOString()}] Withdrawal ${withdrawalId} confirmed (${w.amount} GRIN to ${w.grin_address})`);
      try { this.incentives.maybePayJoinBonus(w.grin_address); }
      catch (e) { console.error(`Error paying join bonus for ${w.grin_address}: ${e.message}`); }
      return true;
    } catch (err) {
      console.error(`Error confirming withdrawal ${withdrawalId}: ${err.message}`);
      return false;
    }
  }

  // Reverse a locked balance back to spendable and park the withdrawal in a terminal state.
  // Generic over fromStatus/newStatus so the slatepack rail reuses the same accounting as markFailed.
  //
  // The status flip is a GUARDED claim in the SAME transaction as the balance move. Both halves
  // matter: the guard means only one caller can reverse a given row, and sharing the transaction
  // means nothing can interleave between "I won the claim" and "the balance is back". Without
  // the guard, a finalize that had already posted on-chain could be reversed alongside it — the
  // miner keeps the coins AND gets the balance back.
  _reverseLock(withdrawalId, newStatus, fromStatus, note) {
    try {
      let done = false;
      this.db.transaction(() => {
        const claimed = this.db.prepare(
          'UPDATE withdrawals SET status = ? WHERE id = ? AND status = ?'
        ).run(newStatus, withdrawalId, fromStatus);
        if (claimed.changes !== 1) return; // someone else moved it first — do NOT touch balances

        this.db.prepare(`
          INSERT INTO withdrawal_events (withdrawal_id, from_status, to_status, triggered_by, note)
          VALUES (?, ?, ?, 'scheduler', ?)
        `).run(withdrawalId, fromStatus, newStatus, note);

        const w = this.db.prepare('SELECT * FROM withdrawals WHERE id = ?').get(withdrawalId);
        const before = this.db.prepare(
          'SELECT balance, balance_locked FROM miner_accounts WHERE grin_address = ?'
        ).get(w.grin_address) || { balance: 0, balance_locked: 0 };
        this.db.prepare(
          'UPDATE miner_accounts SET balance = balance + ?, balance_locked = balance_locked - ?, updated_at = unixepoch() WHERE grin_address = ?'
        ).run(w.amount, w.amount, w.grin_address);
        this.db.prepare(`
          INSERT INTO balance_log
          (grin_address, event_type, amount, balance_before, balance_after, locked_before, locked_after, reference_type, reference_id)
          VALUES (?, 'reversal', ?, ?, ?, ?, ?, 'withdrawal', ?)
        `).run(w.grin_address, w.amount, before.balance, before.balance + w.amount,
               before.balance_locked, Math.max(0, before.balance_locked - w.amount), withdrawalId);
        done = true;
      })();
      if (!done) {
        console.warn(`[reverse] withdrawal ${withdrawalId} was not in ${fromStatus} — reversal skipped (already settled elsewhere)`);
      }
      return done;
    } catch (err) {
      console.error(`Error reversing withdrawal ${withdrawalId}: ${err.message}`);
      return false;
    }
  }

  // ─── Finalize claim (the guard against a double-settle) ─────────────────────
  // finalizeSlatepackWithdrawal / finalizeNostrWithdrawal both read the row, then `await` three
  // wallet calls before writing anything back. Node yields at every await, so the scheduler loop
  // runs INSIDE that gap — and processSlatepackExpiry / cancelWithdrawal select on exactly the
  // status the finalize just validated. The interleaving pays twice:
  //
  //   finalize reads row (pending, ok) → await yields → expiry reverses the lock (miner refunded)
  //   → finalize resumes → postTx broadcasts (miner also paid on-chain).
  //
  // Re-checking the status after the awaits is not enough; the decision to broadcast is already
  // made by then. So take the row out of the pending pool BEFORE any wallet call. 'finalizing'
  // is inside PENDING_SQL (still holds the one-pending slot, still counted as in-flight) but is
  // matched by neither the expiry sweep nor cancelWithdrawal's cancellable set.
  // The event row is not decoration: its created_at is the ONLY record of when the claim was
  // taken, and reclaimStaleFinalizing ages the claim from it. So the flip and the event are one
  // transaction — a claim without its timestamp would look infinitely old to the sweeper.
  _claimForFinalize(withdrawalId) {
    let won = false;
    this.db.transaction(() => {
      const claimed = this.db.prepare(
        "UPDATE withdrawals SET status = 'finalizing' WHERE id = ? AND status = 'slatepack_pending'"
      ).run(withdrawalId);
      if (claimed.changes !== 1) return;
      this.db.prepare(`
        INSERT INTO withdrawal_events (withdrawal_id, from_status, to_status, triggered_by, note)
        VALUES (?, 'slatepack_pending', 'finalizing', 'scheduler', 'claimed for finalize')
      `).run(withdrawalId);
      won = true;
    })();
    return won;
  }

  // Hand the row back when the wallet refused BEFORE anything was broadcast, so the miner can
  // re-submit and the TTL sweep can still refund. Only ever called on a path where postTx did
  // not run — a failure after broadcast must stay 'finalizing' for reclaimStaleFinalizing to
  // resolve from the chain, never be re-opened for a second send.
  _releaseFinalizeClaim(withdrawalId, note) {
    try {
      const back = this.db.prepare(
        "UPDATE withdrawals SET status = 'slatepack_pending' WHERE id = ? AND status = 'finalizing'"
      ).run(withdrawalId);
      if (back.changes === 1) {
        this.db.prepare(`
          INSERT INTO withdrawal_events (withdrawal_id, from_status, to_status, triggered_by, note)
          VALUES (?, 'finalizing', 'slatepack_pending', 'scheduler', ?)
        `).run(withdrawalId, note || 'finalize failed before broadcast — returned to pending');
      }
    } catch (e) {
      console.error(`[finalize] could not release claim on ${withdrawalId}: ${e.message}`);
    }
  }

  // A 'finalizing' row older than FINALIZING_STALE_S lost its owner — the process restarted
  // between the claim and the settle. It must not sit there forever (expiry skips it, cancel
  // refuses it), but it must not be blindly reverted either: if postTx already ran, reverting
  // refunds a miner who was paid.
  //
  // So ask the wallet which it was. The row carries the slate_id we issued, so this is an exact
  // lookup, not an amount heuristic — but the ANSWER IS THREE-WAY, not two (audit §J4-1):
  //   · TxSent AND confirmed         → on chain     → confirm (release lock, debit, fee)
  //   · TxSentCancelled, or absent   → never sent   → back to slatepack_pending (TTL/miner resume)
  //   · TxSent, not yet confirmed    → UNKNOWN      → leave it claimed and re-ask next tick
  //   · wallet unreachable           → UNKNOWN      → leave it and re-ask next tick
  // The third line is the one this used to get wrong: a bare 'TxSent' entry is written at
  // tx_lock_outputs, i.e. at payout CREATION on this rail, so it says the outputs were reserved
  // and nothing about whether the transaction was ever broadcast. Reading it as "it posted"
  // confirmed every stale claim — including the postTx-threw case that is deliberately ROUTED
  // here — and debited miners for coins that never left.
  // "Unknown" deliberately parks rather than guessing: both guesses lose real money, and a
  // stalled payout is recoverable while a double-pay (or a wrongly-debited balance) is not.
  async reclaimStaleFinalizing() {
    try {
      const cutoff = Math.floor(Date.now() / 1000) - FINALIZING_STALE_S;
      // Age the CLAIM, not the row. withdrawals.created_at is when the payout was REQUESTED —
      // for a slatepack row that is up to 24h before the miner responds, so ageing by it would
      // make every fresh claim look instantly stale and let this sweep race a live finalize,
      // re-opening the very double-pay the claim prevents. The claim's own timestamp is the
      // created_at of the event _claimForFinalize writes (indexed by withdrawal_id, created_at).
      // COALESCE to 0 means "claim event missing" is treated as stale — that cannot happen on a
      // fresh claim (both writes are one transaction), so only a genuinely odd row lands there,
      // and resolving it is safe: the wallet log decides, this sweep never guesses.
      // The batch bound is generous ON PURPOSE. It used to be LIMIT 10, which was safe only
      // while every selected row resolved on the tick it was selected. Since §J4-1 a row whose
      // outcome is UNKNOWN stays 'finalizing' and is re-selected every tick — so ten parked rows
      // would permanently fill the batch and starve every newer stale claim behind them,
      // including ones that ARE resolvable. That turns one node outage into a spreading stall.
      // The limit costs almost nothing to raise: the expensive part is the single
      // getTransactions() call below, which serves the whole batch however large it is, and the
      // per-row work is a synchronous DB transaction. Bounded by the pool-wide pending cap,
      // since no more rows than that can be in flight at once.
      const staleBatch = Math.max(50, this.MAX_PENDING_WITHDRAWALS);
      const stale = this.db.prepare(
        `SELECT w.id, w.slate_id, w.grin_address, w.amount FROM withdrawals w
          WHERE w.status = 'finalizing'
            AND COALESCE((SELECT MAX(e.created_at) FROM withdrawal_events e
                           WHERE e.withdrawal_id = w.id AND e.to_status = 'finalizing'), 0) <= ?
          ORDER BY w.created_at ASC LIMIT ?`
      ).all(cutoff, staleBatch);
      if (!stale.length) return;

      if (!this.wallet || typeof this.wallet.getTransactions !== 'function') {
        console.error(
          `⚠️  ${stale.length} withdrawal(s) stuck in 'finalizing' and no Owner-API wallet to check ` +
          `them against — resolve manually before resuming payouts`
        );
        return;
      }

      let txs;
      try { txs = await this.wallet.getTransactions(true); }
      catch (e) {
        console.warn(`[finalize] stale-claim sweep deferred — wallet tx log unreadable: ${e.message}`);
        return;
      }
      if (!Array.isArray(txs)) return;

      // THREE states, not two (audit §J4-1). A 'TxSent' entry means grin-wallet LOCKED the
      // outputs: it is written at tx_lock_outputs, which this rail runs at payout CREATION
      // (createSlatepackWithdrawal / createNostrWithdrawal), long before finalize and whether or
      // not post_tx ever ran. So "is it in the TxSent set" was true for every slate this pool has
      // ever issued and not cancelled — the sweep confirmed every stale claim, released the lock
      // and debited miners for coins that never left. The chain evidence is `confirmed`, which is
      // the same field lib/reconciliation.js:278 already tests on this exact log.
      //
      // kernel_excess is deliberately NOT used as a second signal: grin-wallet v5.4.1 writes it
      // at tx_lock_outputs and again at finalize, i.e. BEFORE post_tx, which is precisely the
      // window this sweep exists to judge (source-verified 2026-09-25, see backfillKernelProofs).
      const onChain = new Set();  // proven mined
      const known = new Map();    // slate_id → tx_type, for everything the wallet still holds
      for (const t of txs) {
        if (!t || !t.tx_slate_id) continue;
        const sid = String(t.tx_slate_id);
        known.set(sid, String(t.tx_type || ''));
        if (String(t.tx_type) === 'TxSent' && t.confirmed) onChain.add(sid);
      }

      for (const w of stale) {
        const sid = w.slate_id ? String(w.slate_id) : null;

        if (!sid) {
          // No slate_id means the claim died before initSendTx recorded one, so nothing can have
          // been broadcast under it — safe to re-open.
          this._releaseFinalizeClaim(w.id, 'recovered: no slate issued, returned to pending');
          continue;
        }

        const kind = known.get(sid);
        if (onChain.has(sid)) {
          console.warn(`[finalize] stale claim ${w.id}: slate ${sid} is ON CHAIN — confirming`);
          this._creditConfirm(w.id, 'finalizing', 'recovered: broadcast confirmed from wallet tx log');
        } else if (kind === undefined || kind === 'TxSentCancelled') {
          console.warn(
            `[finalize] stale claim ${w.id}: slate ${sid} ` +
            `${kind ? 'was cancelled' : 'is absent from the wallet'} — never posted, returned to pending`
          );
          this._releaseFinalizeClaim(w.id, 'recovered: no broadcast found, returned to pending');
        } else {
          // UNKNOWN. The wallet holds an unconfirmed send for this slate, which is either
          // "locked but never posted" or "posted and not yet mined" — the tx log cannot tell
          // them apart, and both guesses lose real money in opposite directions. Park it and
          // re-ask next tick: a stalled payout is recoverable, a wrong settlement is not. It
          // resolves itself once the tx mines; if it never does, it needs a human.
          console.warn(
            `⚠️  [finalize] stale claim ${w.id}: slate ${sid} is ${kind || 'pending'} but NOT yet ` +
            `confirmed on chain — outcome UNKNOWN, leaving it claimed. If this persists, check ` +
            `whether the node accepted the transaction (audit §J4-1); ${w.amount} GRIN stays ` +
            `locked for ${w.grin_address} until it resolves.`
          );
        }
      }
    } catch (err) {
      console.error(`Error reclaiming stale finalize claims: ${err.message}`);
    }
  }

  // ─── Stale 'tor_sending' sweep (audit §J4-3) ────────────────────────────────
  // The Tor rail's equivalent of reclaimStaleFinalizing, and it was missing entirely. The send
  // window is wide — up to wallet_send_timeout_ms inside sendToTorAddress, plus recordTorFee and
  // _captureTorSlateId before markConfirmed writes anything — and a restart, deploy or OOM kill
  // anywhere in it left the row in 'tor_sending' forever. Nothing selected that status: the retry
  // queue takes 'retry_scheduled', the Tor checks take 'tor_checking', expiry takes
  // 'slatepack_pending', the finalize sweep takes 'finalizing', and both admin routes 409 it.
  //
  // The cost compounds, which is why this is not cosmetic: 'tor_sending' is inside PENDING_SQL,
  // so the row holds the address's one-pending slot permanently — every future withdrawal that
  // miner requests, on any rail, 429s — while the balance stays locked, neither spendable nor
  // payable, and reconciliation counts it as in-flight for good.
  //
  // Resolution is the SAME three-way answer as everywhere else on this rail, via the same
  // matcher (_priorSendLanded), which §J4-10 made safe to reuse here:
  //   · confirmed              → on chain      → confirm (release lock, debit, fee)
  //   · absent / cancelled     → never posted  → back onto the retry ladder for a real send
  //   · unconfirmed TxSent     → UNKNOWN       → leave it in tor_sending and re-ask next tick
  //   · wallet unreadable      → UNKNOWN       → leave it
  // This runs while frozen too: it never sends, it only resolves rows against what the wallet
  // and chain already say, and the freeze still gates every outbound path behind it.
  async reclaimStaleTorSending() {
    try {
      const cutoff = Math.floor(Date.now() / 1000) - this.torSendingStaleSeconds;
      // Age the CLAIM, not the row — created_at is when the payout was requested, which for a
      // row that has been through the retry ladder is days earlier. sendWithdrawal writes the
      // tor_sending event in the same breath as the status flip, so its created_at is the age
      // of THIS attempt. Same reasoning as reclaimStaleFinalizing; same COALESCE(...,0) fallback.
      // Only CLAIM events count (into tor_sending from another status). The CLI rail writes no
      // other kind, so for it this is the same query as before; a stepwise attempt also journals
      // progress (tor_sending → tor_sending), and letting those reset the age would make every
      // 'stepwise: repost' push the next look 10 min out, silently overriding the 5-min re-post rate.
      const staleBatch = Math.max(50, this.MAX_PENDING_WITHDRAWALS);
      const stale = this.db.prepare(
        `SELECT w.* FROM withdrawals w
          WHERE w.status = 'tor_sending'
            AND COALESCE((SELECT MAX(e.created_at) FROM withdrawal_events e
                           WHERE e.withdrawal_id = w.id AND e.to_status = 'tor_sending'
                             AND (e.from_status IS NULL OR e.from_status != 'tor_sending')), 0) <= ?
          ORDER BY w.created_at ASC LIMIT ?`
      ).all(cutoff, staleBatch);
      if (!stale.length) {
        // No stale stepwise row is left to report on, so its alert (if any) is over.
        this._resolveAlert('payout_tor_stepwise');
        return;
      }

      if (!this.wallet || typeof this.wallet.getTransactions !== 'function') {
        console.error(
          `⚠️  ${stale.length} withdrawal(s) stuck in 'tor_sending' and no Owner-API wallet to check ` +
          `them against — each one holds a miner's balance locked and blocks their next payout`
        );
        return;
      }

      // A stepwise attempt (its claim carries the 'stepwise:' marker) is resolved by its own
      // recorded step (design §8.1.3), never by the CLI matcher below — which is unchanged and
      // sees only CLI attempts. An attempt still running in this process is never touched.
      const stepwise = [];
      const cliRows = [];
      for (const w of stale) {
        if (this._liveStepwise.has(Number(w.id))) continue;
        (this._isStepwiseAttempt(w.id) ? stepwise : cliRows).push(w);
      }
      await this._reclaimStaleStepwise(stepwise);

      for (const w of cliRows) {
        const netSend = this._netSend(w.amount, w.fee_charged || 0);
        const prior = await this._priorSendLanded(w, netSend);

        if (!prior.checked) {
          console.warn(`[tor-send] stale claim ${w.id}: wallet tx log unreadable — leaving it, will re-ask`);
          continue;
        }

        if (prior.outcome === 'confirmed') {
          console.warn(
            `[tor-send] stale claim ${w.id}: slate ${prior.tx.tx_slate_id} is ON CHAIN — confirming`
          );
          this.db.prepare('UPDATE withdrawals SET slate_id = COALESCE(slate_id, ?) WHERE id = ?')
            .run(String(prior.tx.tx_slate_id), w.id);
          await this.recordTorFee(w.id, netSend);
          this._creditConfirm(w.id, 'tor_sending', 'recovered: abandoned send confirmed from wallet tx log');
          continue;
        }

        if (prior.outcome === 'absent') {
          // Nothing was ever posted under this row, so the money is still the pool's and the
          // payout is still owed. Hand it back to the retry ladder rather than sending from
          // here: scheduleRetry keeps the attempt counting, the ordering, and the freeze check
          // that a send from inside a recovery sweep would bypass.
          console.warn(
            `[tor-send] stale claim ${w.id}: no matching send in the wallet — never posted, ` +
            `returning it to the retry queue`
          );
          await this.scheduleRetry(w.id);
          continue;
        }

        // UNKNOWN — same park as the finalize sweep, for the same reason.
        console.warn(
          `⚠️  [tor-send] stale claim ${w.id}: the wallet holds an unconfirmed send matching this ` +
          `payout but it is NOT yet confirmed on chain — outcome UNKNOWN, leaving it claimed. ` +
          `${w.amount} GRIN stays locked for ${w.grin_address} until it resolves.`
        );
      }
    } catch (err) {
      console.error(`Error reclaiming stale tor_sending rows: ${err.message}`);
    }
  }

  // ─── Stale stepwise attempts (design §8.1.3, "process dies" + "contradiction" rows) ────────
  // ONE tx-log read serves every row. By tor_step:
  //   claimed                         nothing created, nothing locked → back to tor_checking
  //   initiated / locked /            confirmed in the log → confirm (chain evidence wins).
  //   delivering / finalizing         A live TxSent → cancel, then back to tor_checking (a crash
  //                                   is the pool's fault, so no rung). Already cancelled, or
  //                                   never locked → back to tor_checking without a cancel.
  //   posting                         COMMITTED. Confirmed → confirm. A live TxSent → post the
  //                                   stored S3 again (≤ 1 / STEPWISE_REPOST_EVERY_S, ≤ MAX in
  //                                   all, never while frozen); an OK post confirms. Cancelled or
  //                                   absent → park + CRITICAL, never settled in either direction.
  // An unreadable log resolves only 'claimed' rows this tick. Parked rows raise ONE rolling
  // 'payout_tor_stepwise' alert (critical for a contradiction, warning while re-posting).
  async _reclaimStaleStepwise(rows) {
    if (!rows.length) {
      this._resolveAlert('payout_tor_stepwise');
      return;
    }
    let txs = null;
    try {
      const t = await this.wallet.getTransactions(true);
      if (Array.isArray(t)) txs = t;
    } catch (e) {
      console.warn(`[tor-stepwise] stale sweep: wallet tx log unreadable (${e.message}) — only 'claimed' rows resolve this tick`);
    }
    const bySlate = new Map();   // slate → { sent: TxSent entry | null, cancelled: bool }
    for (const t of txs || []) {
      if (!t || !t.tx_slate_id) continue;
      const sid = String(t.tx_slate_id).toLowerCase();
      const e = bySlate.get(sid) || { sent: null, cancelled: false };
      if (String(t.tx_type) === 'TxSent') { if (!e.sent || (t.confirmed && !e.sent.confirmed)) e.sent = t; }
      else if (String(t.tx_type) === 'TxSentCancelled') e.cancelled = true;
      bySlate.set(sid, e);
    }

    const now = Math.floor(Date.now() / 1000);
    const flagged = [];
    for (const w of rows) {
      const step = w.tor_step || 'claimed';
      const sid = w.slate_id ? String(w.slate_id).toLowerCase() : null;

      if (step === 'claimed') {
        if (this._stepwiseRequeue(w.id, 'stepwise: requeued — the attempt stopped before any slate was created')) {
          console.warn(`[tor-stepwise] stale withdrawal ${w.id}: stopped at 'claimed' (nothing locked) — back to tor_checking`);
        }
        continue;
      }
      if (!txs) continue;
      if (!sid) {
        flagged.push({ w, level: 'critical', what: `at '${step}' with no slate id — cannot be looked up` });
        continue;
      }

      const e = bySlate.get(sid);
      const sent = e && e.sent;
      if (sent && sent.confirmed) {
        console.warn(`[tor-stepwise] stale withdrawal ${w.id}: slate ${sid} is CONFIRMED (was at '${step}') — confirming`);
        if (this._creditConfirm(w.id, 'tor_sending', `recovered: stepwise slate ${sid} confirmed in the wallet tx log (was at '${step}')`)) {
          this.db.prepare("UPDATE withdrawals SET tor_final_slate = NULL WHERE id = ? AND status = 'confirmed'").run(w.id);
        }
        continue;
      }

      if (step === 'posting') {
        if (!sent) {
          const what = `${e && e.cancelled ? 'CANCELLED' : 'ABSENT'} in the pool wallet after it was committed for posting`;
          console.error(`⚠️  [CRITICAL] [tor-stepwise] withdrawal ${w.id}: slate ${sid} is ${what} — parked, NOT settled either way`);
          flagged.push({ w, level: 'critical', what });
          continue;
        }
        await this._stepwiseRepost(w, sid, now, flagged);
        continue;
      }

      // A cancellable step (initiated / locked / delivering / finalizing).
      if (!sent) {
        // No live copy in the wallet: already cancelled (the process died between the cancel and
        // the requeue) or never locked. Nothing to undo.
        if (this._stepwiseRequeue(w.id, `stepwise: requeued — slate ${sid} ${e && e.cancelled ? 'already cancelled' : 'not in the wallet'} (stale at '${step}')`)) {
          console.warn(`[tor-stepwise] stale withdrawal ${w.id}: slate ${sid} holds nothing (stale at '${step}') — back to tor_checking`);
        }
        continue;
      }
      await this._stepwiseCancelThen(w.id, sid, { requeue: true }, `stale at '${step}' — the attempt stopped mid-way`);
    }

    if (!flagged.length) {
      this._resolveAlert('payout_tor_stepwise');
      return;
    }
    try { this._raiseStepwiseAlert(flagged); }
    catch (e) { console.error(`[tor-stepwise] failed to record payout_tor_stepwise alert: ${e.message}`); }
  }

  // Post a committed stepwise tx again — the SAME transaction (same inputs, same kernel), so the
  // chain takes it at most once. Never cancels, never rebuilds, never refunds. An OK post settles
  // the row; a failure is journaled and the next sweep looks again.
  async _stepwiseRepost(w, sid, now, flagged) {
    const h = this.db.prepare(
      `SELECT COUNT(*) AS n, MAX(created_at) AS last FROM withdrawal_events
        WHERE withdrawal_id = ? AND note LIKE 'stepwise: repost%'`
    ).get(w.id);
    if (h.n >= MAX_STEPWISE_REPOSTS) {
      flagged.push({ w, level: 'critical', what: `posted again ${h.n} times and still not confirmed — no more automatic posts` });
      return;
    }
    let slate = null;
    try { slate = JSON.parse(w.tor_final_slate || ''); } catch (_) { slate = null; }
    if (!slate || typeof slate !== 'object') {
      flagged.push({ w, level: 'critical', what: "committed for posting but no stored final slate to post" });
      return;
    }
    const entry = { w, level: 'warning', what: `post_tx failed — posting the stored transaction again (${h.n}/${MAX_STEPWISE_REPOSTS} so far)` };
    flagged.push(entry);
    if (this.isFrozen()) return;
    if (h.last && now - Number(h.last) < STEPWISE_REPOST_EVERY_S) return;

    let posted = false;
    let outcome;
    try {
      await this.wallet.postTx(slate, true);
      posted = true;
      outcome = 'accepted';
    } catch (e) {
      outcome = `failed: ${String(e.message || e).slice(0, 200)}`;
    }
    try { this._stepwiseEvent(w.id, `stepwise: repost slate ${sid} ${h.n + 1}/${MAX_STEPWISE_REPOSTS} — ${outcome}`); }
    catch (_) { /* journal is best-effort; the rate check re-reads it */ }
    console.warn(`[tor-stepwise] withdrawal ${w.id}: posted slate ${sid} again (${h.n + 1}/${MAX_STEPWISE_REPOSTS}) — ${outcome}`);
    if (posted && this._creditConfirm(w.id, 'tor_sending', 'stepwise: posted (by the stale sweep)')) {
      this.db.prepare("UPDATE withdrawals SET tor_final_slate = NULL WHERE id = ? AND status = 'confirmed'").run(w.id);
      flagged.splice(flagged.indexOf(entry), 1);
    }
  }

  _raiseStepwiseAlert(flagged) {
    const critical = flagged.filter((f) => f.level === 'critical').length;
    const sorted = [...flagged].sort((a, b) =>
      ((a.level === 'critical' ? 0 : 1) - (b.level === 'critical' ? 0 : 1)) || (a.w.id - b.w.id));
    const LIST_CAP = 10;
    const lines = sorted.slice(0, LIST_CAP).map(({ w, what }) =>
      `#${w.id}: ${what} (slate ${w.slate_id || '—'}, step ${w.tor_step || '—'})`);
    const n = flagged.length;
    const message =
      `${n} step-by-step Tor payout${n === 1 ? '' : 's'} parked in tor_sending` +
      (critical ? ` — ${critical} need a human` : '') +
      `: ${lines.join(' · ')}${n > LIST_CAP ? ` · …+${n - LIST_CAP} more` : ''}`;
    this._rollingAlert('payout_tor_stepwise', critical ? 'critical' : 'warning', message, {
      total: n,
      critical,
      rows: sorted.slice(0, 50).map(({ w, level, what }) => ({
        withdrawal_id: w.id, slate_id: w.slate_id || null, tor_step: w.tor_step || null, level, what,
      })),
      runbook: {
        reposting: 'The transaction is finalized and committed; the pool posts the identical tx again at most ' +
          `every ${STEPWISE_REPOST_EVERY_S / 60} min, ${MAX_STEPWISE_REPOSTS} times. Check that the node is synced ` +
          'and read the "stepwise: repost" events for the node\'s reason. It can land only once.',
        contradiction: 'The wallet no longer holds the committed tx as a live TxSent (cancelled or absent). The row ' +
          'is deliberately NOT settled: check `grin-wallet txs` and the explorer for the kernel before crediting ' +
          'the balance back or paying again. Never re-pay without proof it did not land.',
      },
    });
  }

  // UNUSED — no caller, and deliberately not wired up: its status list predates the slatepack
  // and Goblin rails (it misses slatepack_pending and finalizing), and its 10-per-address budget
  // contradicts the one-pending-per-address rule the create* paths actually enforce inside their
  // transaction. The live caps are PENDING_SQL + the userPending >= 1 check; use those.
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
      // Use PENDING_SQL, never a hand-written list. This one had drifted: it predated both the
      // slatepack and Goblin rails, so the admin scheduler view's "pending" count silently
      // excluded every payout parked in slatepack_pending — and would have excluded finalizing too.
      const pending = this.db.prepare(
        `SELECT COUNT(*) as count FROM withdrawals WHERE ${PENDING_SQL}`
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
