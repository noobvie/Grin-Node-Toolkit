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
//
// 'tor_held' (2026-09-26) is a Tor payout whose one send attempt has an UNKNOWN outcome: the
// amount stays locked and the row is never re-sent, so it holds the slot like any pending row.
// 'retry_scheduled' stays listed for LEGACY rows only: nothing writes it any more, and
// migrateLegacyTorRetries moves every such row out at startup — until then it is still pending.
const PENDING_SQL = "status IN ('tor_checking','tor_sending','tor_held','retry_scheduled','slatepack_pending','finalizing')";

// How long a 'finalizing' claim may stand before the sweeper reclaims it. Finalize is three
// wallet calls — seconds in the normal case — so anything past this lost its owner (process
// restart mid-finalize). Reclaim is NOT a blind revert: see reclaimStaleFinalizing.
const FINALIZING_STALE_S = 600;

// ─── One Tor attempt, then an answer (plan 2026-09-26) ─────────────────────────────────────────
// A Tor payout is sent ONCE. It ends confirmed (paid), tor_failed (balance returned — only on
// wallet proof that nothing was sent) or tor_held (outcome unknown: locked, never re-sent). There
// is no retry ladder, no shortfall retry and no automatic re-send of a payout, ever.
//
// Held resolution: a held row is refunded only when the wallet tx log shows its send absent (or
// cancelled) on two reads at least HELD_ABSENT_GAP_S apart — one read racing a wallet process
// that is still running must not decide a refund. Still unconfirmed after HELD_ALERT_S → one
// rolling critical 'payout_held' alert, and the row waits for the operator.
const HELD_ABSENT_GAP_S = 600;
const HELD_ALERT_S = 86400;

// Anti-abuse pause: TOR_FAIL_MAX counted failed Tor payouts within TOR_FAIL_WINDOW_S pause Tor for
// that address, until the TOR_FAIL_MAX-th most recent counted failure + TOR_PAUSE_S (by then the
// older ones have left the window, so the pause ends cleanly). Only TOR_COUNTED_CODE counts — the
// miner's own onion not answering a fresh probe after the send failed. Pool-side and "could not
// tell" codes never count. Constants on purpose, not settings (operator decision 2026-09-26).
const TOR_FAIL_MAX = 5;
const TOR_FAIL_WINDOW_S = 86400;
const TOR_PAUSE_S = 86400;
const TOR_COUNTED_CODE = 'wallet_offline';
const TOR_CLEARED_CODE = 'wallet_offline_cleared';   // un-counted by the operator; history kept

// withdrawals.fail_detail — the CLI error / output tail behind a fail_code. Admin-only.
const FAIL_DETAIL_MAX = 500;

// The amount match (_priorSendLanded) accepts a tx only if it was locked inside one of the row's OWN
// send attempts: from its claim event to the event that moved it out of tor_sending, widened by this
// much for timestamp flooring and clock jitter. Sends are serialised, so two rows' attempts overlap
// only across this margin or after a crash — and a tx inside two rows' windows decides neither.
const ATTEMPT_WINDOW_SLACK_S = 5;
// grin-wallet FeeFields = (fee_shift << 40) | fee, serialised as the RAW u64. The fee is the low 40
// bits — upstream derives the recipient amount with FeeFields::fee() (owner.rs, "apply fee mask").
const FEE_MOD = 2 ** 40;

// How long a 'tor_sending' claim may stand before the sweeper resolves it (audit §J4-3). The
// send itself is bounded by wallet_send_timeout_ms (WalletTor.DEFAULT_SEND_TIMEOUT_MS, 360 s, when
// unset) and is followed by two more wallet round-trips before anything is written back, so this
// must clear all three with room — resolved per-instance in the constructor against the configured
// timeout, never a bare literal.
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

// An expired slatepack is refunded even when grin-wallet's cancel_tx fails (it needs a reachable
// node), so the row carries slate_cancel_pending = 1 and retryExpiredSlateCancels re-asks every
// tick. At most SLATE_CANCEL_BATCH rows per tick, stopping at the first failure — a dead node fails
// every one of them the same way. After SLATE_CANCEL_ALERT_TICKS failing ticks in a row (~5 min)
// the operator gets one rolling admin alert, not before: a node restart must not page anyone.
const SLATE_CANCEL_BATCH = 10;
const SLATE_CANCEL_ALERT_TICKS = 5;

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
    const sendTimeoutS = Math.ceil((Number(config.wallet_send_timeout_ms) || WalletTor.DEFAULT_SEND_TIMEOUT_MS) / 1000);
    this.torSendingStaleSeconds = Math.max(TOR_SENDING_STALE_FLOOR_S, sendTimeoutS * 2 + 120);
    // True while a Tor CLI send waits for or holds the wallet send lock (sendWithdrawal) — the
    // Slatepack / Goblin creates refuse at once while it is set (_assertNoTorSend).
    this._torSendBusy = false;
    // (The Tor retry ladder, config.withdrawal_retry_delays, was removed 2026-09-26: one attempt.)
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
    // retryExpiredSlateCancels: consecutive ticks whose cancel failed, and whether the rolling
    // alert may be active (null = unknown after a restart, so the first clean tick resolves it).
    this._slateCancelFailTicks = 0;
    this._slateCancelAlerted = null;
  }

  start() {
    if (this.isRunning) return;

    this.isRunning = true;
    console.log(`[${new Date().toISOString()}] Withdrawal scheduler started`);

    this.schedulerLoop();
  }

  async schedulerLoop() {
    // Once per process, before the first pass can send anything: settle every LEGACY Tor row the
    // old retry ladder left in retry_scheduled (confirmed / refunded on proof / held). Nothing
    // re-queues those rows any more, so without this they would hold their slot forever.
    try { await this.migrateLegacyTorRetries(); }
    catch (err) { console.error(`[ERROR] legacy Tor retry migration: ${err.message}`); }

    while (this.isRunning) {
      try {
        // Recover abandoned finalize claims BEFORE expiry, so a row whose finalize died mid-flight
        // is either confirmed or handed back to the pending pool rather than sitting invisible to
        // both. Runs while frozen too: it only resolves rows to the truth already on-chain.
        await this.reclaimStaleFinalizing();
        // Same job for the Tor rail, whose send window is wider and which had no sweep at all
        // until §J4-3. Also freeze-safe: it resolves rows against the wallet, it never sends.
        await this.reclaimStaleTorSending();
        // Held Tor payouts: confirm on proof, refund on proof of absence, otherwise keep waiting.
        // Deliberately BEFORE the freeze branch: while frozen it still CONFIRMS (the chain's own
        // evidence) and still cancels a never-finalized fallback lock, but it neither refunds nor
        // re-broadcasts — a freeze (restore, Migrate IN, wallet switch) may mean the tx log it would
        // refund on is not the one the send was made from (review 2026-09-26, #1).
        await this.resolveHeldTor();

        if (this.isFrozen()) {
          // Kill-switch engaged (auto by AlertMonitor on a critical money trip, or manual admin).
          // Skip every OUTBOUND send path; still run slatepack expiry. It never sends: it refunds
          // an expired slate the wallet shows as never finalized, settles one the chain already
          // mined, and while frozen WAITS on a slate missing from the wallet (see the gate there).
          await this.processSlatepackExpiry();
        } else {
          await this.processTorChecks();
          await this.processSlatepackExpiry();
        }
        // Freeze-safe: cancel_tx only UNLOCKS pool-wallet inputs of payouts already refunded.
        await this.retryExpiredSlateCancels();
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
  // shaped 4xx the routes already map (409). Cancels, slatepack expiry and the Held check stay
  // allowed while frozen — they only refund locked balances or settle what the chain already says.
  _assertNotFrozen() {
    if (this.isFrozen()) {
      const e = new Error('payouts are temporarily frozen by the pool operator — try again later');
      e.code = 409;
      throw e;
    }
  }

  // A Tor CLI send holds the wallet send lock for its whole run (sendWithdrawal), up to
  // wallet_send_timeout_ms. A Slatepack / Goblin create is an HTTP request, so it is refused at once
  // instead of waiting that out — and BEFORE its balance lock: a refusal after the lock would be a
  // reversal, and a reversal starts the miner's cooldown. Nothing is deducted (review 2026-09-26, #2).
  _assertNoTorSend() {
    if (this._torSendBusy) {
      const e = new Error('the pool wallet is sending another payout right now — nothing was deducted; please try again in a minute');
      e.code = 503;
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
  // When a payout's lock is reversed back to balance — slatepack expiry or creation failure, a
  // Goblin/Nostr failure, admin cancel — the miner must wait before requesting ANOTHER payout on
  // ANY rail. Two jobs: (1) safety margin for the known theoretical double-pay window (a Tor
  // send that looked failed may still land — see audit §E.1; the slate_id/retrieve_txs check
  // is the real fix, this narrows the race meanwhile), (2) stops rapid-fire rail-hopping after
  // failures. Configured via payout.withdrawal_cooldown_minutes (applied at startup, like
  // min_withdrawal); 0 disables.
  //
  // A failed TOR payout (method 'tor', status 'tor_failed') no longer starts it (2026-09-26): a
  // Tor refund now happens only on wallet proof that nothing was sent — the job (1) was a stand-in
  // for — and the account page offers "Send as Slatepack instead" right after a Tor "no", which a
  // cooldown would turn into a guaranteed 429. Rapid Tor retries are bounded by the Tor pause
  // (torPauseStatus) instead. The join is LEFT and COALESCEd so a reversal whose withdrawal row
  // is missing still counts (a NULL must never switch the guard off).
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
      SELECT MAX(b.created_at) AS t FROM balance_log b
        LEFT JOIN withdrawals w ON w.id = b.reference_id
      WHERE b.grin_address = ? AND b.event_type = 'reversal' AND b.reference_type = 'withdrawal'
        AND NOT (COALESCE(w.method, '') = 'tor' AND COALESCE(w.status, '') = 'tor_failed')
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

  // (processRetryQueue + initiateWithdrawal — the retry ladder's pickup — were removed 2026-09-26.
  // A Tor payout is sent once; nothing re-queues it. Legacy retry_scheduled rows are settled by
  // migrateLegacyTorRetries at startup.)

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
    // of the send, so it is the authoritative reachability check — the request path already ran
    // the pre-flight probe, and this sends directly. sendWithdrawal makes the ONE attempt and
    // settles its outcome (confirmed / tor_failed on proof / tor_held).
    //
    // The loop checks the freeze once per tick, but a tick runs up to 5 checks back to back, each
    // a send of up to wallet_send_timeout_ms, and AlertMonitor freezes on its own timer. So the
    // freeze is re-read per row: one that lands mid-batch stops the NEXT send. The row stays in
    // tor_checking (still pending, balance still locked) and goes out after a resume.
    try {
      if (!this.isFrozen() && this._dropStepwiseSlate(withdrawal.id)) await this.sendWithdrawal(withdrawal.id);
    } catch (err) {
      console.error(`Error sending withdrawal ${withdrawal.id}: ${err.message}`);
    }
  }

  // A payout must not inherit a STEPWISE attempt's slate id. The step-by-step sender (F5,
  // tor_send_mode = 'stepwise') was DELETED 2026-09-26, but a row it touched before then may still
  // carry the slate id it wrote before its lock — this guard stays for exactly those rows. Every
  // wallet-log question on this rail (_priorSendLanded: the Held check, the stale sweep, the
  // legacy migration) reads a non-null slate_id as THIS payout's send and looks up that one slate
  // exactly, so a cancelled stepwise slate reads 'absent' — and two such reads REFUND a payout
  // whose CLI send landed. _captureTorSlateId never overwrites it either, so the kernel backfill
  // and the watchdog would keep watching a cancelled slate ("NOT paid", critical). A CLI row has
  // no slate_id until it settles; clearing restores exactly that. Only a slate the row's own
  // journal names as its stepwise slate ('slate: <uuid> created (stepwise)') is cleared, and that
  // journal line stays. `status` is the state the caller found the row in (the guarded write).
  // false = could not clear, so the caller must not act on the stale id (next tick tries again).
  _dropStepwiseSlate(withdrawalId, status = 'tor_checking') {
    try {
      const w = this.db.prepare(
        'SELECT slate_id FROM withdrawals WHERE id = ? AND status = ?'
      ).get(withdrawalId, status);
      if (!w || !w.slate_id) return true;
      const sid = String(w.slate_id);
      const ours = this.db.prepare(
        "SELECT 1 FROM withdrawal_events WHERE withdrawal_id = ? AND note LIKE 'slate: ' || ? || ' created (stepwise)%' LIMIT 1"
      ).get(withdrawalId, sid);
      if (!ours) return true;
      this.db.transaction(() => {
        const r = this.db.prepare(
          'UPDATE withdrawals SET slate_id = NULL WHERE id = ? AND status = ? AND slate_id = ?'
        ).run(withdrawalId, status, w.slate_id);
        if (r.changes !== 1) return;
        this.db.prepare(`
          INSERT INTO withdrawal_events (withdrawal_id, from_status, to_status, triggered_by, note)
          VALUES (?, ?, ?, 'scheduler', ?)
        `).run(withdrawalId, status, status, `cli: cleared stepwise slate ${sid} from slate_id before a CLI attempt (its journal line stays)`);
      })();
      return true;
    } catch (e) {
      console.error(`[tor] withdrawal ${withdrawalId}: could not clear its stepwise slate id (${e.message}) — not acting on it this tick`);
      return false;
    }
  }

  // THE one Tor send of a payout (plan 2026-09-26: one attempt, then an answer).
  //
  //   A  "Tx sent successfully"                      → confirmed (F1/F2 then watch it mine)
  //   B  fell back to a slatepack, its slate id read, cancel_tx of that slate succeeded
  //                                                  → tor_failed + refund NOW (proven absent);
  //                                                    ONE fresh onion probe names the fail_code
  //   C  refused before any tx exists (NotEnoughFunds) AND the tx log shows no match
  //                                                  → tor_failed + refund NOW, fail_code pool_busy
  //   D  anything else — timeout kill, unrecognised output, a fallback with no slate id or a
  //      failed cancel, any other error                → tor_held (amount stays locked)
  //
  // A row with ANY earlier attempt on record is never handed to the wallet again: it goes straight
  // to tor_held and resolveHeldTor settles it from the tx log. "Earlier attempt" is read from the
  // append-only event log (audit §J4-2 — retry_count was zeroed by the old admin Retry button), with
  // retry_count and slate_id kept as belt and braces. This is what makes "no automatic re-send,
  // ever" hold by construction rather than by a guard that has to read the wallet right.
  async sendWithdrawal(withdrawalId) {
    let claimed = false;
    try {
      const withdrawal = this.db.prepare(`
        SELECT * FROM withdrawals WHERE id = ?
      `).get(withdrawalId);

      if (!withdrawal) return;

      // Read BEFORE this attempt writes its own event.
      const priorAttempts = this.db.prepare(
        "SELECT COUNT(*) AS c FROM withdrawal_events WHERE withdrawal_id = ? AND to_status = 'tor_sending'"
      ).get(withdrawalId).c;
      if (priorAttempts > 0 || withdrawal.retry_count > 0 || withdrawal.slate_id) {
        this._holdTor(withdrawalId, 'tor_checking',
          'an earlier send attempt is on record — a payout is never sent twice; the Held check decides it from the wallet tx log');
        return;
      }

      // The wallet send lock, held for the CLI's WHOLE run (review 2026-09-26, #2). `grin-wallet
      // send` selects its coins at start but locks them only after the Tor round trip, and
      // lock_output never checks an existing lock (v5.5.0 selection.rs; selection takes the
      // SMALLEST coins first) — so a Slatepack / Goblin create running meanwhile picked the same
      // coins, and the chain could accept only one of the two transactions: the other payout then
      // stuck in finalizing or Held. The CLI is this process's own child, so this process's lock
      // covers it. While it is held the creates refuse at once (_assertNoTorSend).
      this._torSendBusy = true;
      let run = null;
      try {
        run = await this._withSendLock(async () => {
          // A freeze can land while this waited for the lock (a create was selecting coins).
          // Nothing is claimed yet, so the row simply stays tor_checking and goes out after a resume.
          if (this.isFrozen()) return null;
          // Guarded claim, same reason as everywhere else: only a row still in tor_checking may be
          // handed to the wallet, so two scheduler passes can never both spend for one payout.
          const won = this.db.transaction(() => {
            const r = this.db.prepare(
              "UPDATE withdrawals SET status = 'tor_sending' WHERE id = ? AND status = 'tor_checking'"
            ).run(withdrawalId);
            if (r.changes !== 1) return false;
            this.db.prepare(`
              INSERT INTO withdrawal_events (withdrawal_id, from_status, to_status, triggered_by)
              VALUES (?, 'tor_checking', 'tor_sending', 'scheduler')
            `).run(withdrawalId);
            return true;
          })();
          if (!won) return null;
          claimed = true;

          // Send the NET amount — the flat fee stays behind in the pool wallet to cover the
          // on-chain network fee. The row keeps `amount` as the gross the miner was debited, so
          // the wallet-log lookups must match on the net figure that actually went out.
          const netSend = this._netSend(withdrawal.amount, withdrawal.fee_charged || 0);
          return { netSend, sendResult: await this.walletTor.sendToTorAddress(withdrawal.grin_address, netSend) };
        });
      } finally {
        this._torSendBusy = false;
      }
      if (!run) return;
      const { netSend, sendResult } = run;

      if (sendResult && sendResult.success) {
        await this.recordTorFee(withdrawalId, netSend);
        await this._captureTorSlateId(withdrawalId, netSend); // best-effort proof metadata
        // Note only — the CLI's raw stdout is not worth storing in an event row, and can be large.
        await this.markConfirmed(withdrawalId, 'Successfully sent');
        // A delivered Tor send proves the pool's own Tor send path works again.
        this._resolveAlert('tor_send_path');
        return;
      }

      console.error(`Send failed for withdrawal ${withdrawalId}: ${sendResult && sendResult.error}`);
      await this._settleFailedTorSend(withdrawal, netSend, sendResult || {});
    } catch (err) {
      console.error(`Error sending withdrawal ${withdrawalId}: ${err.message}`);
      // After the claim, anything that throws is outcome D: the send may or may not have run.
      if (claimed) {
        this._holdTor(withdrawalId, 'tor_sending', `the send path raised an error — outcome unknown (${err.message})`,
          { detail: err.message });
      }
    }
  }

  // Outcomes B, C and D of the one attempt (see sendWithdrawal). Refunds only on proof that
  // nothing was sent; everything the pool cannot prove goes to tor_held.
  async _settleFailedTorSend(withdrawal, netSend, result) {
    const id = withdrawal.id;
    const error = String(result.error || 'send failed');

    // B — the CLI fell back to printing a slatepack. Cancelling exactly that slate (its id comes
    // from this send's OWN output, never an amount match) is the proof: only the sender finalizes,
    // the pool never did, so no copy of it can reach the chain.
    if (result.torFallback) {
      const released = await this._releaseTorFallback(id, result.slateId);
      if (!released) {
        this._holdTor(id, 'tor_sending',
          result.slateId
            ? `the send fell back to slatepack ${result.slateId} and its cancel did not go through — outcome unknown`
            : 'the send fell back to a slatepack whose id could not be read from the CLI output — outcome unknown',
          { slateId: result.slateId || null, detail: error });
        return;
      }
      // Why did it fail? ONE fresh probe of the miner's onion (never the tor-check route's cache).
      // A throw is "could not tell", like the probe's own null.
      let probe = null;
      try { probe = await this.walletTor.probeToronlineStatus(withdrawal.grin_address); }
      catch (e) { probe = { online: null, reason: `probe_error: ${e.message}` }; }
      const online = probe ? probe.online : null;
      const code = online === false ? 'wallet_offline' : online === true ? 'pool_send_path' : 'wallet_unreachable';
      const why = probe && probe.reason ? probe.reason : 'unknown';
      if (code === 'pool_send_path') this._noteTorSendPath(withdrawal, why);
      this._failTor(id, 'tor_sending', code,
        `${error} [fallback slate ${result.slateId} cancelled; probe after the failure: ${why}]`,
        `tor send failed (${code}) — fallback slate ${result.slateId} cancelled, balance returned`);
      return;
    }

    // C — grin-wallet refused for lack of POOL funds before building anything. Still ask the tx
    // log: only a log that proves no matching send exists may refund.
    if (isNotEnoughFunds({ message: error })) {
      this._noteWalletShort({ withdrawalId: id, method: withdrawal.method || 'tor', amount: netSend, error });
      const prior = await this._priorSendLanded(withdrawal, netSend);
      if (prior.checked && prior.outcome === 'absent') {
        this._failTor(id, 'tor_sending', 'pool_busy', error,
          'the pool wallet could not cover this payout — nothing was sent, balance returned');
        return;
      }
      this._holdTor(id, 'tor_sending',
        prior.checked
          ? `pool wallet short, but the tx log holds a ${prior.outcome} send matching this payout — outcome unknown`
          : 'pool wallet short, and the wallet tx log could not be read to prove nothing was sent',
        { detail: error });
      return;
    }

    // D — anything else.
    this._holdTor(id, 'tor_sending', 'the send neither reported success nor fell back to a slatepack — outcome unknown',
      { detail: error });
  }

  // → tor_held: the amount stays LOCKED and nothing ever re-sends it (resolveHeldTor decides).
  // Guarded on the status the caller found the row in. `slateId` records a slate KNOWN to be this
  // payout's (a fallback slate from its own CLI output) so the Held check looks it up exactly.
  _holdTor(withdrawalId, fromStatus, why, { slateId = null, detail = null } = {}) {
    try {
      let moved = false;
      this.db.transaction(() => {
        const r = this.db.prepare(
          "UPDATE withdrawals SET status = 'tor_held', slate_id = COALESCE(slate_id, ?), " +
          'fail_detail = COALESCE(?, fail_detail) WHERE id = ? AND status = ?'
        ).run(slateId, detail == null ? null : String(detail).slice(0, FAIL_DETAIL_MAX), withdrawalId, fromStatus);
        if (r.changes !== 1) return;
        this.db.prepare(`
          INSERT INTO withdrawal_events (withdrawal_id, from_status, to_status, triggered_by, note)
          VALUES (?, ?, 'tor_held', 'scheduler', ?)
        `).run(withdrawalId, fromStatus, `held: ${why}`);
        moved = true;
      })();
      if (moved) {
        console.warn(`⚠️  Withdrawal ${withdrawalId} HELD (${why}) — the amount stays locked; never re-sent`);
      } else {
        console.warn(`[tor] withdrawal ${withdrawalId} left ${fromStatus} before it could be held — skipped`);
      }
      return moved;
    } catch (e) {
      console.error(`[tor] could not hold withdrawal ${withdrawalId}: ${e.message}`);
      return false;
    }
  }

  // → tor_failed + refund, with the public fail_code and the admin-only fail_detail written in the
  // SAME transaction as the guarded claim and the balance move (_reverseLock).
  _failTor(withdrawalId, fromStatus, code, detail, note, { triggeredBy = 'scheduler', actorId = null } = {}) {
    const ok = this._reverseLock(withdrawalId, 'tor_failed', fromStatus, note, {
      failCode: code,
      failDetail: detail == null ? null : String(detail).slice(0, FAIL_DETAIL_MAX),
      triggeredBy,
      actorId,
    });
    if (ok) console.warn(`⚠️  Withdrawal ${withdrawalId} failed (${code}) — balance returned`);
    return ok;
  }

  // The miner's wallet answers our Tor probe, yet grin-wallet's own send could not deliver — the
  // pool's send path is broken (payout #10's symptom: the CLI's Tor, not the miner). ONE rolling
  // warning; a delivered Tor send resolves it. Not counted against the miner.
  _noteTorSendPath(withdrawal, probeReason) {
    try {
      this._rollingAlert('tor_send_path', 'warning',
        `Tor payout #${withdrawal.id} could not be delivered, but the miner's wallet answers our Tor probe ` +
        `(${probeReason}) — check the pool wallet's Tor (grin-wallet's own tor, not the probe's). The payout ` +
        'was refunded and the miner offered Slatepack.',
        { withdrawal_id: withdrawal.id, probe: probeReason });
    } catch (e) {
      console.error(`[tor] failed to record tor_send_path alert: ${e.message}`);
    }
  }

  // Serialise coin selection → lock across every rail (WalletAPI.withSendLock): the Slatepack and
  // Goblin creates take it around init → lock, and the Tor rail around its whole CLI send. A wallet
  // without it (test doubles) runs fn directly.
  _withSendLock(fn) {
    return this.wallet && typeof this.wallet.withSendLock === 'function' ? this.wallet.withSendLock(fn) : fn();
  }

  // ─── "Did this payout's send land?" (audit §E.1) ────────────────────────────
  // A `grin-wallet send` that reports failure MAY still have posted. The CLI is SIGKILLed at
  // wallet_send_timeout_ms (360 s default), and the Tor round-trip + finalize + broadcast can all
  // have completed while the pipe was still open — the kill tells us the process died, not that
  // the money stayed. Refunding it, or sending it again, pays the miner twice while the ledger
  // debits once, which is unrecoverable. Since 2026-09-26 nothing re-sends a Tor payout at all;
  // this matcher decides whether a Held / failed / abandoned payout is CONFIRMED (settle it), proven
  // ABSENT (the only answer that may refund) or UNKNOWN (keep it locked). Callers: the Held check
  // (resolveHeldTor), outcome C of the one attempt, the stale tor_sending sweep, the legacy
  // migration and the operator's forced refund.
  //
  // Matching is deliberately narrow, because a false POSITIVE marks a miner paid who was not:
  //   · exact slate_id when one was captured — authoritative, no amount guessing;
  //   · otherwise a TxSent whose net-to-recipient equals this payout's net and which was locked
  //     inside one of THIS row's send attempts (_torAttemptWindows), not held by a Slatepack /
  //     Goblin row. Two miners withdrawing the same amount must never collide: a match that another
  //     Tor row also holds or also fits (a crash overlap) is `ambiguous` — it neither confirms nor
  //     counts as absent, so the row stays held (Session 4 review 2026-09-26, R1: with only a
  //     lower time bound, a row that never locked was confirmed by the next miner's tx, and that
  //     miner — their tx now "claimed" — read absent twice and was refunded on top of it).
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
  //   'absent'             no match, or the match is cancelled       may refund (proof of absence;
  //                                                                  the Held check wants it twice)
  //   'unconfirmed'        TxSent, not yet confirmed → UNKNOWN       hold — neither, re-ask
  //   checked === false    the wallet could not be consulted at all  hold — never refund blind
  //
  // 'unconfirmed' is the state that has no safe guess: it is either "locked but never posted"
  // (refunding would be right) or "posted and not yet mined" (refunding double-pays), and the tx
  // log cannot tell them apart. Holding costs a delay; guessing costs money in one direction or
  // the other. Same reasoning, and the same vocabulary, as reclaimStaleFinalizing.
  //
  // `txs` (optional): a tx log the caller already read with refresh=true, so one pass over many
  // rows costs one node round-trip. Omitted → this reads it.
  //
  // Returns { checked, outcome, tx, txs } — `txs` is every candidate the match considered (the
  // forced refund checks the tx_slate_state of each, not just the first), plus `ambiguous` when a
  // candidate may belong to another Tor payout.
  async _priorSendLanded(withdrawal, netSend, preRead = null) {
    if (!preRead && (!this.wallet || typeof this.wallet.getTransactions !== 'function')) {
      return { checked: false, outcome: 'unknown', tx: null };
    }
    try {
      // refresh=true: this decides whether money moves, so pay the node round-trip for accuracy.
      const txs = preRead || await this.wallet.getTransactions(true);
      if (!Array.isArray(txs)) return { checked: false, outcome: 'unknown', tx: null };

      const sent = txs.filter((t) => t && t.tx_slate_id && String(t.tx_type) === 'TxSent');

      // `confirmed` is the chain evidence — the same field lib/reconciliation.js:278 and
      // reclaimStaleFinalizing both test on this exact log. kernel_excess is deliberately not
      // used as a second signal: grin-wallet writes it at lock and at finalize, i.e. before
      // post_tx (see backfillKernelProofs).
      const verdict = (tx, all = null) => ({
        checked: true, outcome: tx ? (tx.confirmed ? 'confirmed' : 'unconfirmed') : 'absent', tx: tx || null,
        txs: all || (tx ? [tx] : []),
      });

      if (withdrawal.slate_id) {
        // Authoritative lookup. A slate present as TxSentCancelled, or absent from the wallet
        // entirely, is 'absent' — it never reached the chain — which is why the filter above
        // excludes the cancelled form rather than reporting it.
        const hit = sent.find((t) => String(t.tx_slate_id) === String(withdrawal.slate_id));
        return verdict(hit);
      }

      // slate → the method of the OTHER row holding it. A Slatepack / Goblin row's slate id comes
      // from its own init_send_tx, so its tx is provably not this payout's. A Tor row's slate id may
      // have been INFERRED by this same amount match (capture, an earlier confirm) — so a tx another
      // Tor row holds is contended, never silently dropped: dropping it is how a landed send read
      // "absent" and was refunded (Session 4 review, R1b).
      const claimedBy = new Map(
        this.db.prepare('SELECT slate_id, method FROM withdrawals WHERE slate_id IS NOT NULL AND id != ?')
          .all(withdrawal.id).map((r) => [String(r.slate_id), String(r.method || 'tor')])
      );

      const wantNano = Math.round(Number(netSend) * 1e9);
      const createdAt = Number(withdrawal.created_at) || 0;
      // The row's own send attempts. Only a row never handed to the wallet (no claim event) falls
      // back to the old open-ended bound — and such a row has no send to find.
      const wins = this._torAttemptWindows(withdrawal.id);
      const inOwn = (when) => (wins.length
        ? wins.some((w) => when >= w.from - ATTEMPT_WINDOW_SLACK_S && when <= w.to + ATTEMPT_WINDOW_SLACK_S)
        : when >= createdAt - 60);

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
        const holder = claimedBy.get(String(t.tx_slate_id));
        if (holder && holder !== 'tor') return false;
        // An unparseable timestamp is a MISSING OBSERVATION, not a passing test. Treating it as
        // "no opinion" removed the only age bound and let a year-old send of the same amount be
        // accepted as this payout (audit §J4-4).
        const when = this._txCreatedAt(t);
        if (when === null) return false;
        // Locked outside every attempt of this row → it is some other send (R1a: a lower bound
        // alone let a row that never locked be confirmed by the NEXT miner's same-amount tx).
        if (!inOwn(when)) return false;
        return Math.abs(this._txRecipientNano(t) - wantNano) <= 1000; // 1 µGRIN tolerance
      });
      // A match another Tor payout may own — it holds the slate, or the tx also lies inside one of
      // its attempts (a crash leaves an attempt open until the stale sweep) — settles NEITHER row:
      // not confirmed (the other one may be the payee), not absent (this one may be). The row stays
      // held; `ambiguous` tells the forced refund to refuse while such a tx is confirmed.
      const contended = (t) => claimedBy.get(String(t.tx_slate_id)) === 'tor' ||
        this._otherTorAttemptAt(withdrawal.id, wantNano, this._txCreatedAt(t));
      const own = matches.filter((t) => !contended(t));
      // Prefer a CONFIRMED match over an unconfirmed one. The amount branch can legitimately
      // return more than one candidate (the same miner, the same net, two attempts), and if any
      // of them is on chain the payout landed — reporting 'unconfirmed' because an unconfirmed
      // sibling sorted first would park a payout that is provably settled.
      const paid = own.find((t) => t.confirmed);
      if (paid) return verdict(paid, own);
      if (own.length === matches.length) return verdict(matches[0], matches);
      return { checked: true, outcome: 'unconfirmed', tx: matches.find((t) => t.confirmed) || matches[0], txs: matches, ambiguous: true };
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

  // Net to the recipient of a TxSent entry, in nanogrin. grin-wallet v5.5.0 lock_tx_context
  // (libwallet selection.rs) writes amount_debited = Σ inputs and amount_credited = Σ change, so
  // debited − credited − fee is exactly the amount sent. `fee` is FeeFields serialised as its RAW
  // u64 string — fee_shift sits above bit 40 — hence the mask (upstream: FeeFields::fee()).
  _txRecipientNano(t) {
    const raw = (t.fee && typeof t.fee === 'object') ? Number(t.fee.fee || 0) : Number(t.fee || 0);
    const fee = Number.isFinite(raw) && raw > 0 ? raw % FEE_MOD : 0;
    return Number(t.amount_debited || 0) - Number(t.amount_credited || 0) - fee;
  }

  // Every Tor send attempt of a row as { from, to } (unix seconds): from its claim event (into
  // tor_sending from another status) to the first later event that moves it OUT of tor_sending;
  // `to` is Infinity while the attempt is open (in flight, or a crash the stale sweep has not held
  // yet). A lock can only happen inside the CLI process of an attempt, and that process is spawned
  // after the claim and gone before the row leaves tor_sending — so this is the whole span in which
  // that attempt's TxSent entry can have been created. [] = the row was never handed to the wallet.
  _torAttemptWindows(withdrawalId) {
    const events = this.db.prepare(
      'SELECT from_status, to_status, created_at FROM withdrawal_events WHERE withdrawal_id = ? ORDER BY id ASC'
    ).all(withdrawalId);
    const wins = [];
    let open = null;
    for (const e of events) {
      if (e.to_status === 'tor_sending' && e.from_status !== 'tor_sending') {
        if (open) wins.push(open);               // a claim with no exit on record stays open-ended
        open = { from: Number(e.created_at), to: Infinity };
      } else if (open && e.from_status === 'tor_sending' && e.to_status !== 'tor_sending') {
        open.to = Number(e.created_at);
        wins.push(open);
        open = null;
      }
    }
    if (open) wins.push(open);
    return wins;
  }

  // Does ANOTHER Tor row with no slate of its own and the same net have a send attempt spanning
  // `when`? Then a tx locked at `when` could be that row's, and the amount match must not pick an
  // owner. Rows are read with their events, so a row still in flight counts too.
  _otherTorAttemptAt(withdrawalId, wantNano, when) {
    if (when === null) return false;
    // Same net (±2 µGRIN in SQL, exact 1 µGRIN below) and requested no later than `when` — an attempt
    // is claimed after its row exists — so the event reads stay few on a long history.
    const rows = this.db.prepare(
      `SELECT id, amount, fee_charged FROM withdrawals
        WHERE method = 'tor' AND slate_id IS NULL AND id != ? AND created_at <= ?
          AND ABS((amount - COALESCE(fee_charged, 0)) - ?) < 0.000002`
    ).all(withdrawalId, when + ATTEMPT_WINDOW_SLACK_S, wantNano / 1e9);
    return rows.some((r) => {
      const net = Math.round((Number(r.amount) - (Number(r.fee_charged) || 0)) * 1e9);
      if (Math.abs(net - wantNano) > 1000) return false;
      return this._torAttemptWindows(r.id).some((w) =>
        when >= w.from - ATTEMPT_WINDOW_SLACK_S && when <= w.to + ATTEMPT_WINDOW_SLACK_S);
    });
  }

  // (_deferSend — "park it on the retry ladder without a rung" — was removed 2026-09-26: an
  // unknown outcome is tor_held now, and resolveHeldTor re-asks the wallet instead.)

  // A Tor send that fell back to a slatepack (lib/wallet-tor.js classifySendOutput) left a
  // TxSent entry with the outputs LOCKED and nothing finalized. Left alone, that entry is exactly
  // what the tx-log check reads as 'unconfirmed' — the payout could never be proven absent, and
  // the pool's outputs would sit locked. Cancelling it is safe: only the sender finalizes, the pool
  // never did, so no copy of this transaction can reach the chain. A successful cancel is outcome
  // B's proof of absence: the payout is refunded at once (_settleFailedTorSend).
  //
  // The slate id comes from this send's OWN output (the .S1.slatepack path), never from an
  // amount match — cancelling someone else's in-flight payout would be the worse bug. No id, or
  // a failed cancel → leave it; the row is HELD (amount locked) rather than refunded on a guess.
  async _releaseTorFallback(withdrawalId, slateId) {
    if (!slateId) {
      console.error(
        `⚠️  Withdrawal ${withdrawalId}: Tor send fell back to a slatepack but its slate id could not be ` +
        `read from the CLI output — the locked outputs stay locked and the payout is HELD. ` +
        `Cancel the unfinalized TxSent in the pool wallet by hand.`
      );
      return false;
    }
    if (!this.wallet || typeof this.wallet.cancelTx !== 'function') return false;
    try {
      await this.wallet.cancelTx(slateId);
      console.warn(`[tor] withdrawal ${withdrawalId}: cancelled fallback slate ${slateId} (never finalized) — nothing can post from it`);
      return true;
    } catch (e) {
      console.error(
        `⚠️  Withdrawal ${withdrawalId}: could not cancel fallback slate ${slateId} (${e.message}) — ` +
        `the payout is HELD until it is cancelled or proven absent`
      );
      return false;
    }
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

  // (scheduleRetry — the 6/12/24/48 h ladder, the 1 h shortfall retry and their caps — was removed
  // 2026-09-26. A Tor payout is sent once; see sendWithdrawal and _settleFailedTorSend.)

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
  // kernel column is the "<method> · mined" badge and the explorer link, so it must wait for
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
  // `status` is the row's status for the journal line: 'confirmed' here, 'tor_held' from the Held
  // check (a Held row's own round-tripped send — resolveHeldTor). Returns the ids it reposted.
  async _repostUnmined(candidates, now, status = 'confirmed') {
    const ran = new Set();
    if (!candidates.length) return ran;
    if (!this.walletTor || typeof this.walletTor.repostTx !== 'function') return ran;
    const history = this.db.prepare(
      `SELECT COUNT(*) AS n, MAX(created_at) AS last FROM withdrawal_events
        WHERE withdrawal_id = ? AND note LIKE 'repost:%'`
    );
    const journal = this.db.prepare(
      `INSERT INTO withdrawal_events (withdrawal_id, from_status, to_status, triggered_by, note)
       VALUES (?, ?, ?, 'scheduler', ?)`
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
      const note = `repost: slate ${w.slate_id || (tx && tx.tx_slate_id)} (tx log id ${txLogId}) ${h.n + 1}/${MAX_REPOSTS} — ${outcome}`;
      try { journal.run(w.id, status, status, note); } catch (e) { /* journal is best-effort; the rate check re-reads it */ }
      ran.add(Number(w.id));
      console.warn(status === 'tor_held'
        ? `[held] withdrawal ${w.id}: its round-tripped Tor send has not mined — ${note}`
        : `[unmined] withdrawal ${w.id}: marked paid but not mined — ${note}`);
    }
    return ran;
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
  // slatepack destination. The slatepack/nostr rails pass null (lib/wallet.js initSendTx) —
  // turning that on changes
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
      // The same attempt-window rule as _priorSendLanded (2026-09-26, review finding (c)): this is
      // called right after the send, while the row's attempt is still open. The old bound
      // (created_at − 60 s, no upper bound) could take another payout's same-amount tx and put its
      // kernel link on this one. Only a row never claimed keeps the old bound.
      const wins = this._torAttemptWindows(withdrawalId);
      const inOwn = (when) => (wins.length
        ? wins.some((w) => when >= w.from - ATTEMPT_WINDOW_SLACK_S && when <= w.to + ATTEMPT_WINDOW_SLACK_S)
        : when >= createdAt - 60);

      const candidate = txs
        // 'TxSent' exactly — never the cancelled form, which is not evidence of anything.
        .filter((t) => t && t.tx_slate_id && String(t.tx_type) === 'TxSent')
        // …not already the proof for a different payout.
        .filter((t) => !claimed.has(String(t.tx_slate_id)))
        // …locked inside one of this row's own send attempts. An entry with no parseable
        // timestamp is a missing observation, not a pass (§J4-4).
        .filter((t) => { const w = this._txCreatedAt(t); return w !== null && inOwn(w); })
        // …and the EXACT net to the recipient, fee included, not merely "at least".
        .filter((t) => Math.abs(this._txRecipientNano(t) - wantNano) <= 1000) // 1 µGRIN tolerance
        // …and not one that also fits another Tor payout's attempt (a crash overlap): it may be
        // that payout's, and no link beats a wrong link.
        .filter((t) => !this._otherTorAttemptAt(withdrawalId, wantNano, this._txCreatedAt(t)))
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

  // (markFailed — the ladder's terminal refund and its last-rung guard — was removed 2026-09-26.
  // A refund now needs proof of absence on every path: _settleFailedTorSend (B, C),
  // resolveHeldTor (two absent reads), migrateLegacyTorRetries, forceRefundHeld.)

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
    // The Tor pause. The route checks it first (before the pre-flight probe, with the end time in
    // the 429 body); this copy keeps any other caller honest. An admin below-min payout is the
    // operator's own act and is not paused. Slatepack / Goblin never are.
    if (!adminOverride) {
      const pause = this.torPauseStatus(grinAddress);
      if (pause.paused_until) {
        const e = new Error('tor_paused'); e.code = 429; e.paused_until = pause.paused_until; throw e;
      }
    }

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
    this._assertNoTorSend();
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
      // The armored S1 is kept so a miner who closed the tab can fetch it again (the ownership-
      // gated /withdraw/:id/slatepack route). It is ENCRYPTED to grinAddress above, so a copy at
      // rest opens only in the owner's wallet. Only this rail writes it: the Goblin rail's S1 is
      // plain armor and must never be stored or re-served.
      // Guarded on the status: the row sat in slatepack_pending across three wallet awaits, and a
      // wallet slow enough to outlast the TTL lets the expiry sweep refund it first — with no
      // slate_id to cancel yet. Attaching a live slate to that refunded row would strand its
      // inputs, so a lost guard throws into the catch below, which cancels this slate.
      const attached = this.db.prepare(
        "UPDATE withdrawals SET slate_id = ?, fee = COALESCE(?, fee), slatepack_s1 = ? WHERE id = ? AND status = 'slatepack_pending'"
      ).run(slateId, feeGrin, typeof armored === 'string' && armored ? armored : null, withdrawalId);
      if (attached.changes !== 1) throw new Error('the payout expired while its slate was being built');
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
    // No slate id = the create is still inside its wallet calls, so nobody holds an S1 for THIS
    // row yet, and the binding below would have nothing to compare with. Refuse before the claim,
    // so the create still attaches normally. Accepting here finalized whatever slate the reply
    // belonged to: an expired row's, refunded while its wallet cancel was still owed, paid twice
    // (audit roll-up note "Slatepack finalize binding").
    if (!w.slate_id) fail('this payout has no slate on record yet, so a reply cannot be matched to it', 409);

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
      // Bind the response to the slate we issued — rejects a pasted slate for a different tx, and
      // one that decodes to no id at all. Fails closed: nothing unmatched reaches finalize_tx.
      if (!slate || !slate.id || slate.id !== w.slate_id) {
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
    this._assertNoTorSend();
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
      // Guarded like the manual rail (createSlatepackWithdrawal) — and this rail's TTL is only 10
      // min. A row the expiry sweep refunded while the wallet built the slate is never published
      // to: the throw lands in the catch below, which cancels the slate. The S1 is NOT stored —
      // it is plain armor.
      const attached = this.db.prepare(
        "UPDATE withdrawals SET slate_id = ?, fee = COALESCE(?, fee) WHERE id = ? AND status = 'slatepack_pending'"
      ).run(slateId, feeGrin, withdrawalId);
      if (attached.changes !== 1) throw new Error('the payout expired while its slate was being built');

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
      // Same fail-closed rule as the manual rail: the create attaches the slate id BEFORE it
      // publishes, so a row without one has sent nothing a genuine reply could answer. The bridge
      // routes a DM to the sender's oldest pending row, not by slate id, so without this check a
      // reply sent during the create landed on the new row.
      if (!w.slate_id) {
        console.warn(`[nostr-payout] finalize ${withdrawalId} rejected — the row has no slate on record yet`);
        return;
      }

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
        if (!slate || !slate.id || slate.id !== w.slate_id) {
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
  // Only slatepack_pending is cancellable (the miner never returned the slate; only the pool can
  // finalize, so nothing was broadcast). The Tor rail has NO cancellable state since 2026-09-26:
  // tor_checking/tor_sending are being sent, and tor_held is exactly the payout whose outcome is
  // unknown — refunding it needs wallet proof (resolveHeldTor / forceRefundHeld), never a cancel.
  // (retry_scheduled was cancellable here; that refunded a Tor payout with no wallet check.)
  // The status transition is a guarded UPDATE inside a transaction, so it can never race a
  // finalize claim into a double-reverse.
  async cancelWithdrawal(grinAddress, withdrawalId) {
    const fail = (msg, code) => { const e = new Error(msg); e.code = code; throw e; };
    if (!grinAddress) fail('address required', 400);

    const w = this.db.prepare('SELECT * FROM withdrawals WHERE id = ?').get(withdrawalId);
    if (!w) fail('withdrawal not found', 404);
    if (w.grin_address !== grinAddress) fail('withdrawal does not belong to this address', 403);
    if (w.status !== 'slatepack_pending') {
      fail(`withdrawal cannot be cancelled while ${w.status} — wait for the current attempt to settle`, 409);
    }

    const txn = this.db.transaction(() => {
      const claimed = this.db.prepare(
        "UPDATE withdrawals SET status = 'cancelled', slatepack_s1 = NULL WHERE id = ? AND status = ?"
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

  // Reverse + cancel slatepack payouts the miner never completed within the TTL.
  //
  // REFUND FIRST, CANCEL SECOND. The refund is the guarded claim (slatepack_pending →
  // slatepack_expired), so it is also the decision: only a row this sweep actually won gets its
  // slate cancelled. The old order cancelled first and claimed after. This batch is selected once
  // and then walked with an await per row, so a miner finalizing row 3 while rows 1–2 were being
  // cancelled won the claim and BROADCAST — and the sweep then cancelled that posted transaction
  // anyway, unlocking inputs that were already spent in the mempool (the refund itself was
  // correctly skipped, so the ledger stayed right; the pool wallet's view did not).
  //
  // A cancel that fails (grin-wallet refuses without a reachable node) no longer vanishes into a
  // log line: the refund transaction set slate_cancel_pending, and retryExpiredSlateCancels keeps
  // asking until the wallet's inputs are free.
  //
  // ASK THE WALLET BEFORE REFUNDING (expiry gate, 2026-09-27). The pool is not the only thing that
  // can finalize a slate it issued. Every S1 carries the pool wallet's address (sender_index 0), and
  // `grin-wallet receive` sends its reply straight back to that address over Tor, calling the
  // pool wallet's Foreign API finalize_tx, which finalizes AND posts (foreign_rpc.rs finalize_tx →
  // post_automatically = true; grin-wallet v5.5.0, source-read). That never reaches this backend:
  // the row stays slatepack_pending, and the old sweep then refunded a payout the chain had
  // already paid. It cannot happen as the toolkit ships the wallet — `owner_api` never publishes an
  // onion, only `listen` does — but one `grin-wallet listen` on the pool wallet dir, or a torrc
  // line pointing at its port, would open it, and so would an operator's hand `grin-wallet
  // finalize`. So the refund now waits for the wallet's own record of the slate:
  //
  //   tx log entry for the row's slate_id        decision
  //   ─────────────────────────────────────────  ─────────────────────────────────────────────────
  //   none, or TxSentCancelled                   refund (while FROZEN: wait — after a restore or a
  //                                              wallet switch an absent slate proves nothing)
  //   TxSent, confirmed                          PAID: settle as confirmed, never refund
  //   TxSent, tx_slate_state Standard1           refund: the coins were only reserved, nothing has
  //                                              finalized the slate (the normal "no reply" case)
  //   TxSent, any later state (Standard3 …)      HOLD: something finalized it outside this backend,
  //                                              so it may be posted. Stays pending, critical alert,
  //                                              re-read every tick — settles itself once mined
  //   TxSent, state not recorded                 refund + warning: a wallet build that does not
  //                                              record the state cannot be checked (operator
  //                                              decision 2026-09-27: keep payouts flowing)
  //   tx log unreadable                          wait: never refund blind
  //
  // Standard1 → Standard3 is grin-wallet's own bookkeeping: lock_tx_context writes the slate's state
  // (Standard1) at tx_lock_outputs, and finalize_tx — Owner or Foreign, it is one function —
  // rewrites it to Standard3 before it posts (libwallet foreign.rs finalize_tx). A row held here
  // can still be finalized by the miner's own paste: re-finalizing a slate spends the same inputs,
  // so at most one transaction can ever be mined. The only double pay is refund + chain, which is
  // what this gate refuses.
  async processSlatepackExpiry() {
    try {
      const now = Math.floor(Date.now() / 1000);
      const cutoff = now - this.slatepackTtlSeconds;             // manual slatepack rail (30 min default)
      const nostrCutoff = now - this.nostrPendingTtlSeconds;     // Goblin/Nostr rail (10 min default)
      // Nostr rows expire on the shorter clock; every other pending rail uses the long TTL.
      // The batch is generous ON PURPOSE (it was LIMIT 10): a row the gate holds stays
      // slatepack_pending and is re-selected every tick, so ten held rows would starve every newer
      // expiry behind them — the trap reclaimStaleFinalizing documents. One wallet read serves the
      // whole batch, and no more rows than the pool-wide pending cap can exist.
      const stale = this.db.prepare(
        `SELECT * FROM withdrawals
          WHERE status = 'slatepack_pending'
            AND ( (method = 'nostr' AND created_at <= ?)
                  OR ((method IS NULL OR method != 'nostr') AND created_at <= ?) )
          ORDER BY created_at ASC LIMIT ?`
      ).all(nostrCutoff, cutoff, Math.max(50, this.MAX_PENDING_WITHDRAWALS));

      // Read the tx log ONCE, refreshed from the node — `confirmed` decides whether a payout is
      // already paid, so it must be current. Only a row that issued a slate needs it.
      let bySlate = null;
      let logErr = null;
      if (this.wallet && stale.some((w) => w.slate_id)) {
        try {
          if (typeof this.wallet.getTransactions !== 'function') throw new Error('this wallet client has no tx log reader');
          const txs = await this.wallet.getTransactions(true);
          if (!Array.isArray(txs)) throw new Error('the tx log came back in an unexpected shape');
          bySlate = new Map();
          // The SEND side only: the pool never receives its own slate, and a TxReceived with the
          // same id must not stand in for the pool's own entry.
          for (const t of txs) {
            if (t && t.tx_slate_id && /^TxSent/.test(String(t.tx_type || ''))) bySlate.set(String(t.tx_slate_id), t);
          }
        } catch (e) {
          logErr = e.message;
        }
      }
      const frozen = this.isFrozen();

      const held = [];
      const settled = [];
      const unverified = [];
      for (const w of stale) {
        const v = this._expiryVerdict(w, bySlate, logErr, frozen);
        if (v.action === 'wait') {
          console.warn(`[slatepack] withdrawal ${w.id} is past its window but NOT refunded this tick — ${v.why}`);
          continue;
        }
        if (v.action === 'settle') {
          // The chain already paid it. _creditConfirm is guarded on slatepack_pending, so a
          // finalize that claimed the row after the batch was read keeps it.
          if (this._creditConfirm(w.id, 'slatepack_pending',
            `settled at expiry: slate ${w.slate_id} is CONFIRMED on chain per the pool wallet's tx log, ` +
            'but this backend never finalized it — something else did (a Tor reply to the pool wallet, or a hand finalize)')) {
            console.error(`⚠️  Slatepack withdrawal ${w.id}: slate ${w.slate_id} was finalized OUTSIDE the pool and is mined — settled as paid, NOT refunded`);
            settled.push(w);
          }
          continue;
        }
        if (v.action === 'hold') {
          held.push({ w, state: v.state });
          this._journalExpiryHold(w, v.state);
          continue;
        }

        // refund
        const owes = !!(this.wallet && w.slate_id);
        const won = this._reverseLock(w.id, 'slatepack_expired', 'slatepack_pending',
          v.unverified
            ? 'slatepack not returned within TTL — reversed WITHOUT the finalize check (the wallet does not record the slate state)'
            : 'slatepack not returned within TTL — reversed', { owesSlateCancel: owes });
        // Lost the claim: a finalize took this row after the batch was selected. Its slate now
        // belongs to that settlement — never cancel it from here.
        if (!won) continue;
        if (v.unverified) unverified.push(w);
        console.warn(`⚠️  Slatepack withdrawal ${w.id} expired (${w.amount} GRIN reversed to ${w.grin_address})`);
        if (owes) await this._cancelExpiredSlate(w.id, w.slate_id);
      }
      this._noteExpiryGate(held, settled, unverified);
    } catch (err) {
      console.error(`Error processing slatepack expiry: ${err.message}`);
    }
  }

  // One expired row → { action: refund | settle | hold | wait, … }. Pure: reads nothing but its
  // arguments, so the table above is the whole rule.
  _expiryVerdict(w, bySlate, logErr, frozen) {
    // No slate issued (the create died before attaching one), or no Owner API: nothing of this
    // row is reserved in the wallet, so nothing can have been finalized under it.
    if (!w.slate_id || !this.wallet) return { action: 'refund' };
    if (logErr) return { action: 'wait', why: `the pool wallet's tx log is unreadable (${logErr}) — never refund blind` };
    const t = bySlate.get(String(w.slate_id));
    if (!t || String(t.tx_type) === 'TxSentCancelled') {
      return frozen
        ? { action: 'wait', why: 'payouts are frozen, and while frozen a slate missing from the wallet proves nothing (restore / wallet switch)' }
        : { action: 'refund' };
    }
    if (t.confirmed === true) return { action: 'settle' };
    const state = t.tx_slate_state == null ? null : String(t.tx_slate_state);
    if (state === 'Standard1') return { action: 'refund' };
    if (state === null || state === 'Unknown') return { action: 'refund', unverified: true };
    return { action: 'hold', state };
  }

  // One event per held row, not one per tick: the row is re-read every minute and the timeline
  // must stay readable. The note's prefix is how the next tick knows — grep before renaming it.
  _journalExpiryHold(w, state) {
    try {
      const seen = this.db.prepare(
        "SELECT 1 FROM withdrawal_events WHERE withdrawal_id = ? AND note LIKE 'expiry-gate: held%' LIMIT 1"
      ).get(w.id);
      if (seen) return;
      this.db.prepare(`
        INSERT INTO withdrawal_events (withdrawal_id, from_status, to_status, triggered_by, note)
        VALUES (?, 'slatepack_pending', 'slatepack_pending', 'scheduler', ?)
      `).run(w.id,
        `expiry-gate: held — the pool wallet's tx log shows slate ${w.slate_id} as ${state}, i.e. finalized, ` +
        'but this backend never finalized it. It may be posted, so it is NOT refunded; it settles itself once mined.');
      console.error(`⚠️  Slatepack withdrawal ${w.id}: slate ${w.slate_id} is ${state} in the pool wallet but was never finalized by the pool — HELD, not refunded`);
    } catch (e) {
      console.error(`[slatepack] could not journal the expiry hold on ${w.id}: ${e.message}`);
    }
  }

  // The gate's two admin alerts, both folded into the Health page's Grin Wallet card
  // (AlertMonitor.foldPayoutAlerts):
  //   slate_finalized_elsewhere — CRITICAL while a row is held; WARNING for a day after a row was
  //     settled as paid from the wallet's log. Either way something finalized a pool slate outside
  //     this backend, and the operator has to find out what (Payout settings → Pool wallet safety).
  //   slate_expiry_unverified   — WARNING for a day after a refund the gate could not check.
  // A critical line describes rows that are held NOW, so it resolves the tick nothing is held; a
  // warning describes something that already happened, so it stays up for a day of quiet.
  _noteExpiryGate(held, settled, unverified) {
    try {
      const ids = (rows) => rows.map((w) => `#${w.id} (${w.amount} GRIN, slate ${w.slate_id})`).join(' · ');
      if (held.length) {
        this._rollingAlert('slate_finalized_elsewhere', 'critical',
          `${held.length} expired slatepack payout${held.length === 1 ? ' is' : 's are'} HELD, not refunded: the pool ` +
          `wallet shows ${held.length === 1 ? 'its slate' : 'their slates'} finalized, but this backend never finalized ` +
          `${held.length === 1 ? 'it' : 'them'} — ${ids(held.map((h) => h.w))}. Each settles itself once mined. Never ` +
          'refund one by hand. Find what finalized it: a Tor onion on the pool wallet (`grin-wallet listen`, or a torrc ' +
          'line pointing at its port) or a hand `grin-wallet finalize`.' +
          (settled.length ? ` Also settled as paid this tick: ${ids(settled)}.` : ''),
          { held: held.map((h) => ({ withdrawal_id: h.w.id, slate_id: h.w.slate_id, state: h.state })),
            settled: settled.map((w) => ({ withdrawal_id: w.id, slate_id: w.slate_id })) });
      } else if (settled.length) {
        this._rollingAlert('slate_finalized_elsewhere', 'warning',
          `Expired slatepack payout${settled.length === 1 ? '' : 's'} ${ids(settled)} ${settled.length === 1 ? 'was' : 'were'} ` +
          'finalized OUTSIDE the pool and mined — settled as paid, not refunded, so no money was lost. Something can ' +
          'finalize pool slates without this backend: check for a Tor onion on the pool wallet (`grin-wallet listen`, or a ' +
          'torrc line pointing at its port) or a hand `grin-wallet finalize`.',
          { settled: settled.map((w) => ({ withdrawal_id: w.id, slate_id: w.slate_id })) });
      } else {
        this._resolveQuietAlert('slate_finalized_elsewhere');
      }

      if (unverified.length) {
        this._rollingAlert('slate_expiry_unverified', 'warning',
          `Expired slatepack payout${unverified.length === 1 ? '' : 's'} ${ids(unverified)} ${unverified.length === 1 ? 'was' : 'were'} ` +
          'refunded WITHOUT the finalize check: this grin-wallet build does not record the slate state (tx_slate_state), ' +
          'so the pool cannot tell a slate someone else finalized from one nobody answered. Check the grin-wallet ' +
          'version on this card against the tested one (Payout settings → Pool wallet safety).',
          { refunded: unverified.map((w) => ({ withdrawal_id: w.id, slate_id: w.slate_id })) });
      } else {
        this._resolveQuietAlert('slate_expiry_unverified');
      }
    } catch (e) {
      console.error(`[slatepack] failed to record an expiry-gate alert: ${e.message}`);
    }
  }

  // Resolve `type` now if it is critical, else once it has been quiet for a day (see _noteExpiryGate).
  _resolveQuietAlert(type) {
    try {
      const now = new Date().toISOString();
      const dayAgo = new Date(Date.now() - 86400000).toISOString();
      this.db.prepare(
        `UPDATE alerts SET status = 'resolved', resolved_at = ?
          WHERE type = ? AND status = 'active' AND (level = 'critical' OR last_seen < ?)`
      ).run(now, type, dayAgo);
    } catch (e) {
      console.error(`[payout] failed to resolve ${type} alert: ${e.message}`);
    }
  }

  // Cancel one refunded row's slate in the pool wallet and clear its slate_cancel_pending flag.
  // Only ever called for a row already in slatepack_expired (the guarded refund above, or the
  // retry sweep below), i.e. one no finalize can claim any more. Returns true when the wallet
  // accepted the cancel; a failure leaves the flag set for the retry sweep.
  async _cancelExpiredSlate(withdrawalId, slateId) {
    try {
      await this.wallet.cancelTx(slateId);
    } catch (e) {
      console.warn(`[slatepack] withdrawal ${withdrawalId}: cancelTx ${slateId} failed (${e.message}) — will retry`);
      return false;
    }
    this._clearSlateCancel(withdrawalId);
    return true;
  }

  _clearSlateCancel(withdrawalId) {
    try {
      this.db.prepare(
        "UPDATE withdrawals SET slate_cancel_pending = 0 WHERE id = ? AND status = 'slatepack_expired'"
      ).run(withdrawalId);
    } catch (e) {
      console.error(`[slatepack] could not clear slate_cancel_pending on ${withdrawalId}: ${e.message}`);
    }
  }

  // Retry the pool-wallet cancel for expired slatepacks whose first cancel failed (see
  // processSlatepackExpiry). Without this, one node blip at expiry left the slate's inputs AND its
  // change locked in the pool wallet until someone ran `grin-wallet cancel` by hand, which shrinks
  // what every later payout can spend and surfaces as "pool wallet short".
  //
  // The wallet's own tx log (local read, no node round-trip) decides each row, so a row whose
  // cancel already landed — say the process died between cancel_tx and the flag clear — is
  // settled without calling cancel_tx on a cancelled tx again:
  //   · absent / TxSentCancelled → nothing is locked            → clear the flag
  //   · confirmed                → the refunded payout is MINED → never cancel; critical alert
  //   · anything else            → still locked                 → cancel_tx, clear on success
  // Every row here is slatepack_expired: refunded through the guarded claim, so no finalize can
  // take it and the pool never posts its slate. Cancelling is therefore always the right move;
  // the "confirmed" branch exists only to shout if that invariant is ever broken.
  async retryExpiredSlateCancels() {
    try {
      const rows = this.db.prepare(
        `SELECT id, slate_id, grin_address, amount FROM withdrawals
          WHERE status = 'slatepack_expired' AND slate_cancel_pending = 1
          ORDER BY id ASC LIMIT ?`
      ).all(SLATE_CANCEL_BATCH);
      if (!rows.length) {
        this._slateCancelFailTicks = 0;
        if (this._slateCancelAlerted !== false) {
          this._resolveAlert('slate_cancel_owed');
          this._slateCancelAlerted = false;
        }
        return;
      }
      if (!this.wallet || typeof this.wallet.cancelTx !== 'function' ||
          typeof this.wallet.getTransactions !== 'function') return;

      let txs;
      try { txs = await this.wallet.getTransactions(false); }
      catch (e) { this._noteSlateCancelFailure(rows, `wallet tx log unreadable: ${e.message}`); return; }
      if (!Array.isArray(txs)) return;
      const bySlate = new Map();
      for (const t of txs) if (t && t.tx_slate_id) bySlate.set(String(t.tx_slate_id), t);

      for (const w of rows) {
        const sid = w.slate_id ? String(w.slate_id) : null;
        const t = sid ? bySlate.get(sid) : undefined;
        if (!t || String(t.tx_type) === 'TxSentCancelled') {
          this._clearSlateCancel(w.id);
          console.warn(`[slatepack] withdrawal ${w.id}: slate ${sid || '(none)'} ${t ? 'already cancelled' : 'not in the wallet'} — nothing locked`);
          continue;
        }
        if (t.confirmed) {
          this._clearSlateCancel(w.id);
          const msg = `Expired slatepack payout #${w.id} was REFUNDED (${w.amount} GRIN to ${w.grin_address}) ` +
            `but its slate ${sid} is CONFIRMED on chain — the miner may have been paid twice. Reconcile by hand.`;
          console.error(`⚠️  ${msg}`);
          try { this._rollingAlert('slate_refunded_but_mined', 'critical', msg, { withdrawal_id: w.id, slate_id: sid }); }
          catch (e) { console.error(`[slatepack] failed to record slate_refunded_but_mined alert: ${e.message}`); }
          continue;
        }
        let err = null;
        try { await this.wallet.cancelTx(sid); } catch (e) { err = e; }
        if (err) {
          // One failure means the wallet or its node is down; the rest would fail identically.
          this._noteSlateCancelFailure(rows, `cancelTx ${sid} for #${w.id}: ${err.message}`);
          return;
        }
        this._clearSlateCancel(w.id);
        console.warn(`[slatepack] withdrawal ${w.id}: expired slate ${sid} cancelled on retry — pool-wallet inputs released`);
      }
      this._slateCancelFailTicks = 0;
    } catch (err) {
      console.error(`Error retrying expired-slate cancels: ${err.message}`);
    }
  }

  _noteSlateCancelFailure(rows, why) {
    this._slateCancelFailTicks += 1;
    console.warn(`[slatepack] ${rows.length} expired slate(s) still owe a pool-wallet cancel — ${why}`);
    if (this._slateCancelFailTicks < SLATE_CANCEL_ALERT_TICKS) return;
    const ids = rows.map((r) => `#${r.id}`).join(', ');
    const message =
      `Expired slatepack payout(s) ${ids} were refunded to the miner, but the pool wallet could not ` +
      `cancel their slates for ${this._slateCancelFailTicks} minutes (${String(why).slice(0, 300)}). ` +
      `Their inputs stay locked in the pool wallet until cancelled — check that the node is reachable; ` +
      `retried every minute. No miner funds are affected.`;
    try {
      this._rollingAlert('slate_cancel_owed', 'warning', message, { withdrawal_ids: rows.map((r) => r.id) });
      this._slateCancelAlerted = true;
    } catch (e) {
      console.error(`[slatepack] failed to record slate_cancel_owed alert: ${e.message}`);
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
        // slatepack_s1 goes with the claim: a settled payout's S1 has nothing left to do.
        const claimed = this.db.prepare(
          "UPDATE withdrawals SET status = 'confirmed', confirmed_at = unixepoch(), slatepack_s1 = NULL WHERE id = ? AND status = ?"
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
  // Generic over fromStatus/newStatus: every rail's refund (Tor failure, slatepack expiry, …) uses it.
  //
  // The status flip is a GUARDED claim in the SAME transaction as the balance move. Both halves
  // matter: the guard means only one caller can reverse a given row, and sharing the transaction
  // means nothing can interleave between "I won the claim" and "the balance is back". Without
  // the guard, a finalize that had already posted on-chain could be reversed alongside it — the
  // miner keeps the coins AND gets the balance back.
  //
  // `owesSlateCancel` (expiry sweep): mark, in this same transaction, that the pool wallet still
  // has to cancel the row's slate. The refund lands first and the cancel is attempted after it, so
  // a failed cancel — or a crash between the two — is remembered rather than lost.
  // `failCode` / `failDetail` (Tor rail, _failTor): the public reason and the admin-only detail,
  // written with the claim so a refunded row can never lack its reason. `triggeredBy` / `actorId`
  // name who did it on the event row ('admin' + their id for the operator's forced refund).
  _reverseLock(withdrawalId, newStatus, fromStatus, note,
    { owesSlateCancel = false, failCode = null, failDetail = null, triggeredBy = 'scheduler', actorId = null } = {}) {
    try {
      let done = false;
      this.db.transaction(() => {
        const claimed = this.db.prepare(
          'UPDATE withdrawals SET status = ?, slatepack_s1 = NULL, ' +
          'slate_cancel_pending = CASE WHEN ? THEN 1 ELSE slate_cancel_pending END, ' +
          'fail_code = COALESCE(?, fail_code), fail_detail = COALESCE(?, fail_detail) ' +
          'WHERE id = ? AND status = ?'
        ).run(newStatus, owesSlateCancel ? 1 : 0, failCode, failDetail, withdrawalId, fromStatus);
        if (claimed.changes !== 1) return; // someone else moved it first — do NOT touch balances

        this.db.prepare(`
          INSERT INTO withdrawal_events (withdrawal_id, from_status, to_status, triggered_by, actor_id, note)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(withdrawalId, fromStatus, newStatus, triggeredBy, actorId, note);

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
  // The Tor rail's equivalent of reclaimStaleFinalizing. The send window is wide — up to
  // wallet_send_timeout_ms inside sendToTorAddress, plus recordTorFee and _captureTorSlateId before
  // markConfirmed writes anything — and a restart, deploy or OOM kill anywhere in it leaves the row
  // in 'tor_sending'. Nothing else selects that status, and it is inside PENDING_SQL, so the row
  // would hold the address's one-pending slot and its locked balance forever.
  //
  // A crash mid-send is outcome D of the one attempt (plan 2026-09-26):
  //   · confirmed in the tx log  → on chain → confirm (release lock, debit, fee)
  //   · anything else            → tor_held — absent, unconfirmed, unreadable, or no Owner API
  // An abandoned send is NEVER put back on a queue that would send it again, and never refunded
  // from here: "absent" on one read is not proof (the CLI process of the dead attempt may outlive
  // its parent), so the Held check asks again — twice, ≥ HELD_ABSENT_GAP_S apart — before any refund.
  // This runs while frozen too: it never sends.
  async reclaimStaleTorSending() {
    try {
      const cutoff = Math.floor(Date.now() / 1000) - this.torSendingStaleSeconds;
      // Age the CLAIM, not the row — created_at is when the payout was requested. sendWithdrawal
      // writes the tor_sending event in the same transaction as the status flip, so its created_at
      // is the age of THIS attempt. Same reasoning as reclaimStaleFinalizing; same
      // COALESCE(...,0) fallback. Only CLAIM events count (into tor_sending from another status):
      // the filter dates from the deleted step-by-step sender, whose progress events
      // (tor_sending → tor_sending) must not reset the age of a row it left behind.
      const staleBatch = Math.max(50, this.MAX_PENDING_WITHDRAWALS);
      const stale = this.db.prepare(
        `SELECT w.* FROM withdrawals w
          WHERE w.status = 'tor_sending'
            AND COALESCE((SELECT MAX(e.created_at) FROM withdrawal_events e
                           WHERE e.withdrawal_id = w.id AND e.to_status = 'tor_sending'
                             AND (e.from_status IS NULL OR e.from_status != 'tor_sending')), 0) <= ?
          ORDER BY w.created_at ASC LIMIT ?`
      ).all(cutoff, staleBatch);
      if (!stale.length) return;

      let txs = null;
      if (this.wallet && typeof this.wallet.getTransactions === 'function') {
        try { txs = await this.wallet.getTransactions(true); }
        catch (e) { console.warn(`[tor-send] stale sweep: wallet tx log unreadable (${e.message}) — holding without a read`); }
      }

      for (const w of stale) {
        let prior = { checked: false, outcome: 'unknown', tx: null };
        if (Array.isArray(txs)) {
          try { prior = await this._priorSendLanded(w, this._netSend(w.amount, w.fee_charged || 0), txs); }
          catch (e) { prior = { checked: false, outcome: 'unknown', tx: null }; }
        }

        if (prior.outcome === 'confirmed') {
          console.warn(`[tor-send] stale claim ${w.id}: slate ${prior.tx.tx_slate_id} is ON CHAIN — confirming`);
          this.db.prepare('UPDATE withdrawals SET slate_id = COALESCE(slate_id, ?) WHERE id = ?')
            .run(String(prior.tx.tx_slate_id), w.id);
          await this.recordTorFee(w.id, this._netSend(w.amount, w.fee_charged || 0));
          this._creditConfirm(w.id, 'tor_sending', 'recovered: abandoned send confirmed from wallet tx log');
          continue;
        }

        const seen = !prior.checked
          ? (Array.isArray(txs) ? 'the wallet tx log could not be matched' : 'the wallet tx log could not be read')
          : (prior.outcome === 'absent' ? 'the wallet shows no send yet' : 'the wallet holds an unconfirmed send matching it');
        this._holdTor(w.id, 'tor_sending', `abandoned mid-send (a restart?) — ${seen}; the Held check decides`);
      }
    } catch (err) {
      console.error(`Error reclaiming stale tor_sending rows: ${err.message}`);
    }
  }

  // ─── Held Tor payouts (plan 2026-09-26) ─────────────────────────────────────
  // A tor_held payout's one send has an unknown outcome. Every scheduler tick asks the wallet tx
  // log — ONE refreshed read serves every held row:
  //   · confirmed                                   → confirmed (Paid) — frozen or not
  //   · absent / cancelled on two reads ≥ HELD_ABSENT_GAP_S apart, both taken while UNFROZEN and
  //     after the last resume, from a log that still carries the row's history mark
  //                                                 → tor_failed + refund, fail_code 'unknown'
  //                                                   (not counted toward the pause, no cooldown)
  //   · unconfirmed                                 → stays held; it resets an absent streak
  //   · unreadable                                  → stays held; decides nothing
  // Still held HELD_ALERT_S after it was held → ONE rolling critical 'payout_held' alert.
  //
  // Why two reads: the first "absent" can race a wallet process that is still running (a CLI
  // send orphaned by a restart can outlive the backend), and a refund on top of a send that then
  // lands is the one outcome that cannot be undone.
  //
  // Why not while frozen, and why the history mark (review 2026-09-26, #1): "absent" is only proof
  // if the log is the history the send was made against. Restore, Migrate IN, the wallet-switch
  // wizard and an identity mismatch all FREEZE — and a seed recovery, an older wallet backup or a
  // different wallet each read "absent" for a send that landed. So while frozen an absence is not
  // even journaled, a streak must be built after the last resume (_lastResumeAt), and the first
  // unfrozen check records the newest tx-log entry as the row's mark: once the log stops carrying
  // that exact entry (same id, same creation time) its absences prove nothing and the row waits for
  // the operator ('history_changed').
  //
  // Two remedies run here too, neither able to pay twice (review #4):
  //   · the row's OWN fallback slate, still a bare lock (tx_slate_state Standard1 — nothing ever
  //     finalizes it), is cancelled again: its cancel at send time needs a live node and may have
  //     failed; the next reads then decide the refund;
  //   · the row's OWN send that got past its Tor round trip (Standard2: it may have been posted,
  //     then dropped) is re-broadcast hourly via the CLI, like F2 — the identical transaction, and
  //     only for a row with exactly one attempt and one matching tx.
  // The reads are journaled as event notes:
  //   'held-check: absent …'      — the first absent read of a streak (its created_at is the clock)
  //   'held-check: unconfirmed …' — an unconfirmed read that ended a streak
  //   'held-check: wallet mark {…}' — the history mark (parsed by _heldMark)
  // Renaming any prefix silently changes when a refund happens — grep before touching them.
  //
  // `id` restricts the pass to one row (the admin "Re-check now" — the SAME rules, no force).
  // Returns [{ id, outcome }] with outcome confirmed | refunded | absent_first | absent_wait | held |
  // unknown | frozen | history_changed | fallback_cancelled | reposted.
  async resolveHeldTor({ id = null } = {}) {
    const out = [];
    try {
      const now = Math.floor(Date.now() / 1000);
      const frozen = this.isFrozen();
      const rows = id === null
        ? this.db.prepare("SELECT * FROM withdrawals WHERE status = 'tor_held' ORDER BY id ASC LIMIT ?")
          .all(Math.max(50, this.MAX_PENDING_WITHDRAWALS))
        : this.db.prepare("SELECT * FROM withdrawals WHERE id = ? AND status = 'tor_held'").all(id);
      if (!rows.length) {
        if (id === null) this._resolveAlert('payout_held');
        return out;
      }

      let txs = null;
      if (this.wallet && typeof this.wallet.getTransactions === 'function') {
        try { txs = await this.wallet.getTransactions(true); }
        catch (e) { console.warn(`[held] wallet tx log unreadable (${e.message}) — ${rows.length} held payout(s) wait`); }
      } else if (!this._heldNoWalletWarned) {
        this._heldNoWalletWarned = true;
        console.error(`⚠️  [held] ${rows.length} held Tor payout(s) and no Owner-API wallet to check them against — they need the operator`);
      }

      const cancels = [];   // { w, slate, i } — the row's own fallback slate, still a bare lock
      const reposts = [];   // { w, tx, i }    — the row's own round-tripped send, not yet mined
      for (const row of rows) {
        this._dropStepwiseSlate(row.id, 'tor_held');
        const w = this.db.prepare("SELECT * FROM withdrawals WHERE id = ? AND status = 'tor_held'").get(row.id);
        if (!w) continue;
        if (!Array.isArray(txs)) { out.push({ id: w.id, outcome: 'unknown' }); continue; }

        let netSend;
        let prior;
        try {
          netSend = this._netSend(w.amount, w.fee_charged || 0);
          prior = await this._priorSendLanded(w, netSend, txs);
        } catch (e) {
          prior = { checked: false, outcome: 'unknown', tx: null };
        }

        if (prior.outcome === 'confirmed') {
          this.db.prepare('UPDATE withdrawals SET slate_id = COALESCE(slate_id, ?) WHERE id = ?')
            .run(String(prior.tx.tx_slate_id), w.id);
          await this.recordTorFee(w.id, netSend);
          const done = this._creditConfirm(w.id, 'tor_held', `held → confirmed: slate ${prior.tx.tx_slate_id} is confirmed on chain`);
          out.push({ id: w.id, outcome: done ? 'confirmed' : 'unknown' });
          continue;
        }

        if (!prior.checked) { out.push({ id: w.id, outcome: 'unknown' }); continue; }

        // The history mark: taken at the first UNFROZEN check (a frozen pool may be mid-switch).
        const mark = this._heldMark(w.id);
        if (!mark && !frozen) this._recordHeldMark(w.id, txs);

        const since = this._heldAbsentSince(w.id);
        if (prior.outcome === 'absent') {
          if (frozen) { out.push({ id: w.id, outcome: 'frozen' }); continue; }
          if (mark && !this._markIntact(mark, txs)) {
            this._warnHistoryChanged(w.id, mark);
            out.push({ id: w.id, outcome: 'history_changed' });
            continue;
          }
          if (since === null) {
            this._heldCheckEvent(w.id, 'held-check: absent — no matching send in the wallet tx log (read 1 of 2)');
            out.push({ id: w.id, outcome: 'absent_first' });
          } else if (now - since < HELD_ABSENT_GAP_S) {
            out.push({ id: w.id, outcome: 'absent_wait' });
          } else {
            const ok = this._failTor(w.id, 'tor_held', 'unknown',
              `wallet tx log showed no send for this payout on two reads ${Math.round((now - since) / 60)} min apart`,
              'held → refunded: the wallet tx log proved no send on two reads ≥ 10 min apart');
            out.push({ id: w.id, outcome: ok ? 'refunded' : 'unknown' });
          }
          continue;
        }

        // 'unconfirmed' — the send may be on its way. Any absent streak is void.
        if (since !== null) {
          this._heldCheckEvent(w.id, `held-check: unconfirmed — the tx log holds an unconfirmed matching send (slate ${prior.tx && prior.tx.tx_slate_id}); absent streak reset`);
        }
        const i = out.push({ id: w.id, outcome: 'held' }) - 1;
        // The two remedies (see the header). Only this row's OWN tx, never a contended one.
        if (!prior.ambiguous && prior.tx && Array.isArray(prior.txs) && prior.txs.length === 1) {
          const state = String(prior.tx.tx_slate_state || '');
          const ownSlate = w.slate_id && String(prior.tx.tx_slate_id) === String(w.slate_id);
          if (state === 'Standard1' && ownSlate && !this._slateHeldByOther(w.id, w.slate_id)) {
            cancels.push({ w, slate: String(w.slate_id), i });
          } else if (state === 'Standard2' && this._torAttemptWindows(w.id).length === 1) {
            // One attempt, one tx: re-broadcasting it can only pay this payout once. With two
            // attempts on record (a legacy row) two DIFFERENT finalized txs could exist, and landing
            // one of them could complete a double pay — that row is the operator's.
            reposts.push({ w, tx: prior.tx, i });
          }
        }
      }

      // A fallback slate the send could not cancel (cancel_tx needs a live node). A bare lock is
      // never finalized by anything, so cancelling it is always safe, frozen or not — it only
      // unlocks the pool's own inputs. One failure means the node is down: the rest wait a tick.
      for (const c of cancels) {
        try { await this.wallet.cancelTx(c.slate); }
        catch (e) {
          console.warn(`[held] withdrawal ${c.w.id}: could not cancel its fallback slate ${c.slate} (${e.message}) — retried next tick`);
          break;
        }
        this._heldCheckEvent(c.w.id, `held-check: cancelled its never-finalized fallback slate ${c.slate} (Standard1) — the next reads decide`);
        console.warn(`[held] withdrawal ${c.w.id}: cancelled its never-finalized fallback slate ${c.slate}`);
        out[c.i].outcome = 'fallback_cancelled';
      }
      // Re-broadcast, hourly and capped (the F2 limits), never while frozen — the freeze is the
      // operator's "nothing goes out" switch, even the identical transaction.
      if (reposts.length && !frozen) {
        const ran = await this._repostUnmined(reposts, now, 'tor_held');
        for (const r of reposts) if (ran.has(Number(r.w.id))) out[r.i].outcome = 'reposted';
      }

      if (id === null) this._raiseHeldAlert(now);
    } catch (err) {
      console.error(`Error resolving held Tor payouts: ${err.message}`);
    }
    return out;
  }

  _heldCheckEvent(withdrawalId, note) {
    this.db.prepare(`
      INSERT INTO withdrawal_events (withdrawal_id, from_status, to_status, triggered_by, note)
      VALUES (?, 'tor_held', 'tor_held', 'scheduler', ?)
    `).run(withdrawalId, note);
  }

  // created_at of the first absent read of the CURRENT streak, or null. A streak ends at an
  // unconfirmed read, starts over at every (re-)entry into tor_held, and never reaches back past
  // the last resume of payouts: a read from before it may have come from the wallet the freeze was
  // about (review 2026-09-26, #1).
  _heldAbsentSince(withdrawalId) {
    const r = this.db.prepare(`
      SELECT created_at FROM withdrawal_events
       WHERE withdrawal_id = ? AND note LIKE 'held-check: absent%'
         AND created_at >= ?
         AND id > COALESCE((SELECT MAX(id) FROM withdrawal_events
                             WHERE withdrawal_id = ?
                               AND (note LIKE 'held-check: unconfirmed%'
                                    OR (to_status = 'tor_held' AND (from_status IS NULL OR from_status != 'tor_held')))), 0)
       ORDER BY id ASC LIMIT 1
    `).get(withdrawalId, this._lastResumeAt(), withdrawalId);
    return r ? Number(r.created_at) : null;
  }

  // When payouts were last resumed (unix s): payout_control's updated_at while it reads unfrozen
  // (resume() writes it), 0 when the pool was never frozen. While frozen nothing is refunded anyway.
  _lastResumeAt() {
    try {
      const r = this.db.prepare('SELECT frozen, updated_at FROM payout_control WHERE id = 1').get();
      return r && !r.frozen ? (Number(r.updated_at) || 0) : 0;
    } catch (e) { return 0; }
  }

  // ── The wallet history mark (review 2026-09-26, #1) ──
  // The newest entry of a tx log as { id, ts }: its TxLogEntry id and creation time, the two fields
  // grin-wallet never rewrites (cancel changes the type, a refresh the confirmation). A wallet
  // rebuilt from its seed, an older backup or another wallet cannot carry that exact entry — so a
  // log that has lost it no longer proves a send absent. null when no entry has both fields.
  _walletMark(txs) {
    let best = null;
    for (const t of Array.isArray(txs) ? txs : []) {
      if (!t || t.creation_ts === undefined || t.creation_ts === null) continue;
      const id = Number(t.id);
      if (!Number.isInteger(id) || id < 0) continue;
      if (!best || id > best.id) best = { id, ts: String(t.creation_ts) };
    }
    return best;
  }

  _markIntact(mark, txs) {
    return (Array.isArray(txs) ? txs : []).some((t) => t && Number(t.id) === mark.id && String(t.creation_ts) === mark.ts);
  }

  _recordHeldMark(withdrawalId, txs) {
    const mark = this._walletMark(txs);
    if (!mark) return;
    this._heldCheckEvent(withdrawalId, `held-check: wallet mark ${JSON.stringify(mark)} — the newest tx-log entry at the first ` +
      'Held check; an "absent" read counts only while the log still carries it');
  }

  // The row's history mark, or null (none recorded yet, or a legacy row).
  _heldMark(withdrawalId) {
    const r = this.db.prepare(
      "SELECT note FROM withdrawal_events WHERE withdrawal_id = ? AND note LIKE 'held-check: wallet mark %' ORDER BY id ASC LIMIT 1"
    ).get(withdrawalId);
    const m = r && /^held-check: wallet mark (\{[^}]*\})/.exec(String(r.note));
    if (!m) return null;
    try {
      const v = JSON.parse(m[1]);
      return Number.isInteger(v.id) && typeof v.ts === 'string' ? v : null;
    } catch (_) { return null; }
  }

  _warnHistoryChanged(withdrawalId, mark) {
    this._historyWarned = this._historyWarned || new Set();
    if (this._historyWarned.has(withdrawalId)) return;
    this._historyWarned.add(withdrawalId);
    console.error(
      `⚠️  [held] withdrawal ${withdrawalId}: the wallet tx log no longer carries the entry it had at the first Held check ` +
      `(id ${mark.id}, ${mark.ts}) — a restored, recovered or different wallet. Its "absent" proves nothing, so the payout ` +
      'stays HELD: find the send on the wallet that made it or on the explorer, then use the forced refund only on proof'
    );
  }

  // Does any OTHER withdrawal row carry this slate id? (A slate is one payout's; never touch another's.)
  _slateHeldByOther(withdrawalId, slateId) {
    return !!this.db.prepare('SELECT 1 FROM withdrawals WHERE slate_id = ? AND id != ? LIMIT 1').get(String(slateId), withdrawalId);
  }

  // One rolling CRITICAL alert while any payout has been held longer than HELD_ALERT_S; resolved
  // by the first pass that finds none. Stored like every _rollingAlert (not pushed off-box).
  _raiseHeldAlert(now) {
    try {
      const rows = this.db.prepare(`
        SELECT w.id, w.grin_address, w.amount, w.slate_id,
               (SELECT MAX(e.created_at) FROM withdrawal_events e
                 WHERE e.withdrawal_id = w.id AND e.to_status = 'tor_held'
                   AND (e.from_status IS NULL OR e.from_status != 'tor_held')) AS held_at
          FROM withdrawals w WHERE w.status = 'tor_held' ORDER BY w.id ASC
      `).all();
      const old = rows.filter((r) => (Number(r.held_at) || 0) <= now - HELD_ALERT_S);
      if (!old.length) { this._resolveAlert('payout_held'); return; }
      const utc = (s) => `${new Date(s * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
      const list = old.slice(0, 10).map((r) =>
        `#${r.id} (${r.amount} GRIN${r.slate_id ? `, slate ${r.slate_id}` : ''}, held since ${r.held_at ? utc(r.held_at) : 'unknown'})`);
      this._rollingAlert('payout_held', 'critical',
        `${old.length} Tor payout${old.length === 1 ? '' : 's'} held over ${HELD_ALERT_S / 3600} h with an unknown outcome — ` +
        `amounts stay locked, nothing is re-sent: ${list.join(' · ')}${old.length > 10 ? ` · …+${old.length - 10} more` : ''}`,
        {
          rows: old.slice(0, 50).map((r) => ({ withdrawal_id: r.id, slate_id: r.slate_id || null, held_at: r.held_at })),
          runbook: 'Each payout is still unresolved after 24 h. Usually the wallet tx log holds an UNCONFIRMED send ' +
            'matching it: if it mines, the pool confirms it by itself — UNLESS two held payouts of the same amount both ' +
            'fit that one tx (a crash mid-send): then the pool will not guess, and the tx\'s payment proof ' +
            '(receiver_address in `grin-wallet txs`) says whose it is. A send that got past its Tor round trip ' +
            '(tx_slate_state Standard2) is re-broadcast hourly by the pool (see the row\'s "repost:" events); a ' +
            'never-finalized fallback lock (Standard1) is cancelled by the pool itself once the node answers. If the row ' +
            'reads "history_changed", the wallet behind the Owner API is not the one the send was made from (a restore, ' +
            'a seed recovery, a switch): look for the send on the old wallet and on the explorer. While payouts are ' +
            'frozen a Held payout is never refunded. "Re-check now" runs the same check; the forced refund (step-up, ' +
            'typed id) refuses a send that may have been posted, and is for a tx you have proven never reached the ' +
            'chain. Never pay again by hand.',
        });
    } catch (e) {
      console.error(`[held] failed to record payout_held alert: ${e.message}`);
    }
  }

  // The operator's forced refund of a Held payout (step-up + typed id at the route). Allowed only
  // when the wallet tx log can be read AND shows no CONFIRMED match — a confirmed match is a paid
  // payout, and refunding it pays twice. An UNCONFIRMED match is allowed only as a bare lock
  // (tx_slate_state Standard1: the CLI's slatepack fallback, which nothing finalizes); one that got
  // past its Tor round trip (Standard2) may have been posted and can still be mined after a refund,
  // so it is refused, and so is one whose state the wallet does not record (review 2026-09-26, #4).
  // The row's OWN fallback slate is cancelled before the refund. A changed wallet history does not
  // block this override — the operator is the authority here — but it is reported and journaled.
  // Never a re-send. Throws coded errors.
  async forceRefundHeld(withdrawalId, { adminId = null, reason = null } = {}) {
    const fail = (msg, code) => { const e = new Error(msg); e.code = code; throw e; };
    const w = this.db.prepare('SELECT * FROM withdrawals WHERE id = ?').get(withdrawalId);
    if (!w) fail('withdrawal not found', 404);
    if (w.status !== 'tor_held') fail(`only a Held payout can be force-refunded (status: ${w.status})`, 409);
    if (!this.wallet || typeof this.wallet.getTransactions !== 'function') {
      fail('the wallet Owner API is not configured — the tx log cannot be checked, so the refund is refused', 503);
    }
    let txs;
    try { txs = await this.wallet.getTransactions(true); }
    catch (e) { fail(`the wallet tx log could not be read (${e.message}) — refusing to refund blind`, 503); }
    const netSend = this._netSend(w.amount, w.fee_charged || 0);
    const prior = await this._priorSendLanded(w, netSend, Array.isArray(txs) ? txs : null);
    if (!prior.checked) fail('the wallet tx log could not be matched — refusing to refund blind', 503);
    if (prior.outcome === 'confirmed') {
      fail(`the wallet tx log shows this payout CONFIRMED on chain (slate ${prior.tx.tx_slate_id}) — it was paid; use Re-check`, 409);
    }
    // A confirmed tx that fits this payout's send AND another Tor payout's (_priorSendLanded's
    // `ambiguous`): it may be this one's, so refunding could pay twice. Decide which payout it paid
    // first (its payment proof in `grin-wallet txs` names the recipient).
    if (prior.tx && prior.tx.confirmed) {
      fail(`a CONFIRMED send (slate ${prior.tx.tx_slate_id}) matches this payout and another Tor payout of the same amount — ` +
        'it may be this one; refusing to refund', 409);
    }
    let cancelledSlate = null;
    if (prior.outcome === 'unconfirmed') {
      const matched = Array.isArray(prior.txs) && prior.txs.length ? prior.txs : (prior.tx ? [prior.tx] : []);
      const live = matched.find((t) => String((t && t.tx_slate_state) || '') !== 'Standard1');
      if (live) {
        fail(`the wallet holds a matching send (slate ${live.tx_slate_id}, state ${live.tx_slate_state || 'not recorded'}) that ` +
          'got past its Tor round trip — it may have been finalized and posted, and a posted tx can still be mined after a ' +
          'refund. The pool re-broadcasts it hourly. Once you have proven it can never mine (its inputs spent by another ' +
          `tx), cancel it in the pool wallet (grin-wallet cancel -t ${live.tx_slate_id}) — then Re-check, or refund`, 409);
      }
      // Bare locks only. The row's OWN fallback slate is cancelled first, or its inputs would stay
      // locked in the pool wallet; a lock found only by amount is never cancelled from here.
      if (w.slate_id && matched.length === 1 && String(matched[0].tx_slate_id) === String(w.slate_id) &&
          !this._slateHeldByOther(w.id, w.slate_id)) {
        try { await this.wallet.cancelTx(String(w.slate_id)); }
        catch (e) { fail(`its never-finalized fallback slate ${w.slate_id} could not be cancelled (${e.message}) — try again once the node answers`, 503); }
        cancelledSlate = String(w.slate_id);
      }
    }
    const mark = this._heldMark(w.id);
    const history = !mark ? 'unknown' : (this._markIntact(mark, Array.isArray(txs) ? txs : []) ? 'intact' : 'changed');
    const seen = (prior.outcome === 'absent' ? 'no matching send' : `an UNCONFIRMED never-finalized lock (slate ${prior.tx && prior.tx.tx_slate_id})`) +
      (cancelledSlate ? ', cancelled first' : '') +
      (history === 'changed' ? '; the wallet history CHANGED since the first Held check' : '');
    const ok = this._failTor(withdrawalId, 'tor_held', 'unknown',
      `forced refund by admin #${adminId}${reason ? `: ${String(reason).slice(0, 200)}` : ''} — tx log showed ${seen}`,
      `held → refunded by the operator (forced; tx log showed ${seen})`,
      { triggeredBy: 'admin', actorId: adminId });
    if (!ok) fail('the payout changed state meanwhile — refresh and look again', 409);
    return { success: true, withdrawal_id: withdrawalId, tx_log: prior.outcome,
             slate_id: (prior.tx && prior.tx.tx_slate_id) || null, amount: w.amount,
             wallet_history: history, cancelled_slate: cancelledSlate };
  }

  // ─── Legacy retry_scheduled rows (startup, once, idempotent) ────────────────
  // Tor rows the old retry ladder parked. Nothing re-queues them any more, so each is settled from
  // ONE refreshed tx-log read: confirmed → confirmed; absent → tor_failed + refund (fail_code
  // 'unknown': not counted, no cooldown); anything else, or no readable log → tor_held. One read is
  // enough HERE, unlike the Held check: a retry_scheduled row was parked AFTER its last send
  // returned, and this runs before this process has started any send, so no wallet process of
  // ours can still be running for it. Idempotent by construction: every branch moves the row out
  // of retry_scheduled with a guarded write, so a second run finds nothing. While payouts are
  // FROZEN (a restore or Migrate IN just ran — both freeze) an absent row is held, not refunded:
  // the log it would be refunded on may not be the one its send was made from (review #1). The Held
  // check then decides it after the resume.
  async migrateLegacyTorRetries() {
    const res = { confirmed: 0, refunded: 0, held: 0 };
    const rows = this.db.prepare("SELECT * FROM withdrawals WHERE status = 'retry_scheduled' ORDER BY id ASC").all();
    if (!rows.length) return res;
    const frozen = this.isFrozen();

    let txs = null;
    if (this.wallet && typeof this.wallet.getTransactions === 'function') {
      try { txs = await this.wallet.getTransactions(true); }
      catch (e) { console.warn(`[migrate] wallet tx log unreadable (${e.message}) — every legacy row is held`); }
    }

    for (const row of rows) {
      this._dropStepwiseSlate(row.id, 'retry_scheduled');
      const w = this.db.prepare("SELECT * FROM withdrawals WHERE id = ? AND status = 'retry_scheduled'").get(row.id);
      if (!w) continue;
      let prior = { checked: false, outcome: 'unknown', tx: null };
      let netSend = null;
      if (Array.isArray(txs)) {
        try {
          netSend = this._netSend(w.amount, w.fee_charged || 0);
          prior = await this._priorSendLanded(w, netSend, txs);
        } catch (e) { prior = { checked: false, outcome: 'unknown', tx: null }; }
      }
      if (prior.outcome === 'confirmed') {
        this.db.prepare('UPDATE withdrawals SET slate_id = COALESCE(slate_id, ?) WHERE id = ?')
          .run(String(prior.tx.tx_slate_id), w.id);
        await this.recordTorFee(w.id, netSend);
        if (this._creditConfirm(w.id, 'retry_scheduled', 'legacy retry row → confirmed: its send is confirmed on chain')) res.confirmed++;
      } else if (prior.checked && prior.outcome === 'absent' && !frozen) {
        if (this._failTor(w.id, 'retry_scheduled', 'unknown', 'legacy retry row: the wallet tx log shows no send for it',
          'legacy retry row → refunded: no send in the wallet tx log (one-attempt migration)')) res.refunded++;
      } else if (this._holdTor(w.id, 'retry_scheduled',
        !prior.checked ? 'legacy retry row, wallet tx log unreadable (one-attempt migration)'
          : prior.outcome === 'absent' ? 'legacy retry row, no send in the wallet tx log but payouts are FROZEN — the Held check decides after a resume (one-attempt migration)'
            : 'legacy retry row with an unconfirmed matching send (one-attempt migration)')) {
        res.held++;
      }
    }
    console.warn(`[migrate] ${rows.length} legacy retry_scheduled Tor row(s): ${res.confirmed} confirmed, ${res.refunded} refunded, ${res.held} held`);
    return res;
  }

  // ─── Tor pause (anti-abuse) ─────────────────────────────────────────────────
  // { failures_24h, max, paused_until | null } for an address — counts and a timestamp only, so it
  // is safe on the public account summary. Counted = tor_failed rows with fail_code
  // TOR_COUNTED_CODE, timed by their tor_failed EVENT (when the attempt failed, not when it was
  // requested). paused_until = the TOR_FAIL_MAX-th most recent counted failure + TOR_PAUSE_S.
  torPauseStatus(grinAddress, now = Math.floor(Date.now() / 1000)) {
    const times = this.db.prepare(`
      SELECT MAX(e.created_at) AS failed_at
        FROM withdrawals w
        JOIN withdrawal_events e ON e.withdrawal_id = w.id AND e.to_status = 'tor_failed'
       WHERE w.grin_address = ? AND w.status = 'tor_failed' AND w.fail_code = ?
       GROUP BY w.id
      HAVING MAX(e.created_at) > ?
       ORDER BY failed_at DESC
    `).all(grinAddress, TOR_COUNTED_CODE, now - TOR_FAIL_WINDOW_S).map((r) => Number(r.failed_at));
    let pausedUntil = null;
    if (times.length >= TOR_FAIL_MAX) {
      const until = times[TOR_FAIL_MAX - 1] + TOR_PAUSE_S;
      if (until > now) pausedUntil = until;
    }
    return { failures_24h: times.length, max: TOR_FAIL_MAX, paused_until: pausedUntil };
  }

  // The operator's "this pause was the pool's fault": un-count the address's counted failures in
  // the window by re-coding them TOR_CLEARED_CODE. History stays — nothing is deleted, each row gets
  // an admin event. Returns how many rows were un-counted.
  clearTorPause(grinAddress, { adminId = null } = {}) {
    const now = Math.floor(Date.now() / 1000);
    const ids = this.db.prepare(`
      SELECT w.id FROM withdrawals w
        JOIN withdrawal_events e ON e.withdrawal_id = w.id AND e.to_status = 'tor_failed'
       WHERE w.grin_address = ? AND w.status = 'tor_failed' AND w.fail_code = ?
       GROUP BY w.id
      HAVING MAX(e.created_at) > ?
    `).all(grinAddress, TOR_COUNTED_CODE, now - TOR_FAIL_WINDOW_S).map((r) => r.id);
    let cleared = 0;
    this.db.transaction(() => {
      for (const id of ids) {
        const r = this.db.prepare(
          "UPDATE withdrawals SET fail_code = ? WHERE id = ? AND status = 'tor_failed' AND fail_code = ?"
        ).run(TOR_CLEARED_CODE, id, TOR_COUNTED_CODE);
        if (r.changes !== 1) continue;
        this.db.prepare(`
          INSERT INTO withdrawal_events (withdrawal_id, from_status, to_status, triggered_by, actor_id, note)
          VALUES (?, 'tor_failed', 'tor_failed', 'admin', ?, ?)
        `).run(id, adminId, 'tor-pause: cleared by the operator — no longer counted toward the Tor pause');
        cleared++;
      }
    })();
    return cleared;
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

      // Tor payouts whose one attempt has an unknown outcome (amount locked, never re-sent).
      const held = this.db.prepare(
        "SELECT COUNT(*) as count FROM withdrawals WHERE status = 'tor_held'"
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
        held_count: held.count,
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
module.exports.TOR_FAIL_MAX = TOR_FAIL_MAX;
module.exports.TOR_FAIL_WINDOW_S = TOR_FAIL_WINDOW_S;
module.exports.TOR_PAUSE_S = TOR_PAUSE_S;
module.exports.HELD_ABSENT_GAP_S = HELD_ABSENT_GAP_S;
