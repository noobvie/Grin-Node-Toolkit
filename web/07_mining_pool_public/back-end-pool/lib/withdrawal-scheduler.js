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

// How long a 'tor_sending' claim may stand before the sweeper resolves it (audit §J4-3). The
// send itself is bounded by wallet_send_timeout_ms (120 s default) and is followed by two more
// wallet round-trips before anything is written back, so this must clear all three with room —
// resolved per-instance in the constructor against the configured timeout, never a bare literal.
const TOR_SENDING_STALE_FLOOR_S = 600;

// The pseudo-address the flat withdrawal fee is credited to — the SAME bucket the block-reward
// pool fee lands in, so both show up as one fee-income line on the transparency page.
const POOL_FEE_ADDRESS = IncentivesManager.POOL_FEE;

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
    // locked balance is returned (the miner never imported/returned the slate).
    this.slatepackTtlSeconds = (config.slatepack_ttl_hours || 24) * 3600;
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
        // Read-only: attach on-chain kernel proofs to confirmed payouts. Never moves funds, so
        // it runs regardless of the freeze state. Self-throttled + no-op when nothing's pending.
        await this.backfillKernelProofs();
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
        await this.scheduleRetry(withdrawalId);
      }
    } catch (err) {
      console.error(`Error sending withdrawal ${withdrawalId}: ${err.message}`);
      await this.scheduleRetry(withdrawalId);
    }
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
      // used as a second signal: it can be populated at finalize, i.e. before post_tx.
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
  _deferSend(withdrawalId, slateId) {
    try {
      const priorDefers = this.db.prepare(
        "SELECT COUNT(*) AS c FROM withdrawal_events WHERE withdrawal_id = ? AND note LIKE 'deferred:%'"
      ).get(withdrawalId).c;

      const nextAt = Math.floor(Date.now() / 1000) + SEND_DEFER_S;
      const note = `deferred: wallet holds an unconfirmed send${slateId ? ` (slate ${slateId})` : ''} — outcome unknown`;

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
          `[double-send guard] withdrawal ${withdrawalId}: an unconfirmed send matches this payout — ` +
          `neither confirming nor re-sending, re-asking in ${SEND_DEFER_S}s (deferral ${priorDefers + 1})`
        );
      }
      return true;
    } catch (e) {
      console.error(`[double-send guard] could not defer withdrawal ${withdrawalId}: ${e.message}`);
      return false;
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

      // Guarded on the status we just read: a row that reached a settled state meanwhile (the
      // double-send guard confirming it, an admin cancel) must not be dragged back onto the
      // retry ladder for another send.
      const stmt = this.db.prepare(`
        UPDATE withdrawals
        SET status = 'retry_scheduled', retry_count = retry_count + 1, next_retry_at = ?
        WHERE id = ? AND status = ?
      `);
      if (stmt.run(nextRetryAt, withdrawalId, withdrawal.status).changes !== 1) {
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
        `Retry ${withdrawal.retry_count + 1}/${this.retryDelays.length} at ${new Date(nextRetryAt * 1000).toISOString()}`
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
  // chain explorer (scan.grin.money/kernel/<excess>). READ-ONLY w.r.t. balances — it only writes
  // the proof column, never moves or unlocks funds — so it is safe to run even while payouts are
  // frozen. Requires the Owner-API wallet (this.wallet): the Tor CLI rail exposes no structured
  // kernel, so a Tor-only deployment without the Owner API simply gets no kernel column.
  //
  // Matching: the wallet's TxLogEntry carries kernel_excess (populated once the tx mines) and
  // tx_slate_id. Slatepack/nostr payouts store their slate_id, so they match exactly. Tor rows
  // get their slate_id captured post-send by _captureTorSlateId(), so they match the same way.
  async backfillKernelProofs() {
    if (!this.wallet) return;
    try {
      const cutoff = Math.floor(Date.now() / 1000) - 30 * 86400; // bound the scan to recent payouts
      const pending = this.db.prepare(
        `SELECT id, slate_id FROM withdrawals
         WHERE status = 'confirmed' AND kernel_excess IS NULL AND slate_id IS NOT NULL
           AND created_at >= ?
         ORDER BY created_at DESC LIMIT 200`
      ).all(cutoff);
      if (!pending.length) return;

      // The tx scan refreshes from the node (slow); throttle to at most once every 3 min even if
      // rows linger — a just-broadcast payout's kernel isn't mined for a minute or two anyway.
      if (this._lastKernelScan && (Date.now() - this._lastKernelScan) < 180000) return;
      this._lastKernelScan = Date.now();

      const txs = await this.wallet.getTransactions(true);
      if (!Array.isArray(txs) || !txs.length) return;

      const bySlate = new Map();
      for (const t of txs) {
        if (t && t.tx_slate_id && t.kernel_excess) bySlate.set(String(t.tx_slate_id), t.kernel_excess);
      }
      if (!bySlate.size) return;

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
    } catch (err) {
      console.warn(`[kernel-proof] backfill skipped: ${err.message}`);
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
  // The guard reads the row's CURRENT status rather than assuming one. In practice this is always
  // 'tor_sending' (scheduleRetry is only ever reached from inside sendWithdrawal, after the claim),
  // NOT the 'retry_scheduled' the old event row claimed — but reading it keeps the compare-and-swap
  // honest for any future caller. Both statements are synchronous, so nothing can interleave
  // between the read and the swap; a status that changed anyway loses the swap and is skipped.
  async markFailed(withdrawalId) {
    const w = this.db.prepare('SELECT amount, status FROM withdrawals WHERE id = ?').get(withdrawalId);
    if (!w) return;
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
      fail(`pool has reached maximum pending withdrawals (${this.MAX_PENDING_WITHDRAWALS})`, 429);
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
        fail(`pool has reached maximum pending withdrawals (${this.MAX_PENDING_WITHDRAWALS})`, 429);
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
      if (totalPending >= this.MAX_PENDING_WITHDRAWALS) fail(`pool has reached maximum pending withdrawals (${this.MAX_PENDING_WITHDRAWALS})`, 429);
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
      slate = await this.wallet.initSendTx(netSend);
      await this.wallet.txLockOutputs(slate);
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
      return {
        success: true, withdrawal_id: withdrawalId, amount: amt,
        fee_charged: feeCharged, net_amount: netSend, slatepack: armored
      };
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
      if (totalPending >= this.MAX_PENDING_WITHDRAWALS) fail(`pool has reached maximum pending withdrawals (${this.MAX_PENDING_WITHDRAWALS})`, 429);
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
      slate = await this.wallet.initSendTx(netSend);
      await this.wallet.txLockOutputs(slate);
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
      const cutoff = now - this.slatepackTtlSeconds;             // manual slatepack rail (24h default)
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
        VALUES (?, 'debit', ?, 0, 0, ?, ?, ?, ?)
      `);
      logDebit.run(withdrawal.grin_address, netPaid, lockedBefore,
                   lockedBefore - released, 'withdrawal', withdrawal.id);

      if (feeCharged > 0) {
        logDebit.run(withdrawal.grin_address, feeCharged, lockedBefore - released,
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
      // kernel_excess is deliberately NOT used as a second signal: it may be populated at
      // finalize, i.e. BEFORE post_tx, which is precisely the window this sweep exists to judge.
      // Do not add it without verifying against a live wallet.
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
      const staleBatch = Math.max(50, this.MAX_PENDING_WITHDRAWALS);
      const stale = this.db.prepare(
        `SELECT w.* FROM withdrawals w
          WHERE w.status = 'tor_sending'
            AND COALESCE((SELECT MAX(e.created_at) FROM withdrawal_events e
                           WHERE e.withdrawal_id = w.id AND e.to_status = 'tor_sending'), 0) <= ?
          ORDER BY w.created_at ASC LIMIT ?`
      ).all(cutoff, staleBatch);
      if (!stale.length) return;

      if (!this.wallet || typeof this.wallet.getTransactions !== 'function') {
        console.error(
          `⚠️  ${stale.length} withdrawal(s) stuck in 'tor_sending' and no Owner-API wallet to check ` +
          `them against — each one holds a miner's balance locked and blocks their next payout`
        );
        return;
      }

      for (const w of stale) {
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
