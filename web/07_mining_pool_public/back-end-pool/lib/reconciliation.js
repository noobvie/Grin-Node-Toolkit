/**
 * Reconciliation — the pool's custodial money statement, computed once and shared by both the
 * admin endpoint (GET /api/admin/reconciliation) and the AlertMonitor money detectors.
 *
 * Three layers:
 *   1. Coverage — does the on-chain wallet hold at least what the ledger owes? LIQUID (spendable
 *      coins vs currently-withdrawable balances = can we pay now) vs FULL (total incl. maturing
 *      coinbase vs everything owed = long-run solvency). Both gaps are net of recorded payout
 *      network fees (withdrawals.fee) — a sender-paid cost the ledger never debits.
 *   2. Flow statement — external money IN (block rewards, fee, top-ups, admin injects) vs OUT
 *      (confirmed payouts, orphan clawbacks) over lifetime / 7d / 24h.
 *   3. Integrity invariant — SUM(balance+locked) across ALL accounts must equal the net of the
 *      append-only ledger (Σcredit − Σdebit − Σ non-withdrawal reversals). Any drift means a
 *      balance moved without a ledger row (bug or tampering).
 *
 * Ledger source: raw balance_log is kept for balance_log_keep_days (min 45d) and then pruned
 * AFTER being rolled into the never-pruned balance_log_daily (see lib/ledger-rollup.js).
 * Lifetime sums here therefore read rollup(day < H) + raw(created_at >= H), where H is the
 * rollup horizon — exact at every prune state. Short windows (7d/24h/30d) sit inside the raw
 * floor and read raw only.
 */

const { getHorizon } = require('./ledger-rollup');

const TOL = 1e-6;
const r9 = (v) => parseFloat((Number(v) || 0).toFixed(9));

// Compute the full statement. `wallet` is the Owner-API client (may be null / unreachable);
// pass forceRefresh=true to force a fresh wallet→node output scan (slow) vs the cached balance.
async function computeReconciliation(db, wallet, forceRefresh = true) {
  const now = Math.floor(Date.now() / 1000);
  const H = getHorizon(db); // balance_log_daily covers created_at < H; 0 = no rollup yet

  // External money flow over a window (cutoff=0 → lifetime). Internal transfers
  // (fee_cut / donation / streak / join_bonus / jackpot / prize_award / withdrawal lock)
  // net to zero across accounts and are excluded from IN/OUT.
  const FLOW_CASES = (amt) => `
      COALESCE(SUM(CASE WHEN event_type='credit'   AND reference_type='block'        THEN ${amt} END),0) AS in_block,
      COALESCE(SUM(CASE WHEN event_type='credit'   AND reference_type='pool_fee'     THEN ${amt} END),0) AS in_fee,
      COALESCE(SUM(CASE WHEN event_type='credit'   AND reference_type='admin_inject' THEN ${amt} END),0) AS in_inject,
      COALESCE(SUM(CASE WHEN event_type='credit'   AND reference_type='topup'        THEN ${amt} END),0) AS in_topup,
      COALESCE(SUM(CASE WHEN event_type='debit'    AND reference_type='withdrawal'   THEN ${amt} END),0) AS out_payout,
      COALESCE(SUM(CASE WHEN event_type='reversal' AND reference_type='block'        THEN ${amt} END),0) AS out_orphan`;
  const flowStmt = db.prepare(
    `SELECT ${FLOW_CASES('amount')} FROM balance_log WHERE created_at >= ?`
  );
  const flowDailyStmt = db.prepare(
    `SELECT ${FLOW_CASES('total_amount')} FROM balance_log_daily WHERE day < ?`
  );
  const payoutFeeStmt = db.prepare(
    `SELECT COALESCE(SUM(fee),0) AS fees FROM withdrawals WHERE status='confirmed' AND confirmed_at >= ?`
  );
  const flow = (cutoff) => {
    // Lifetime (cutoff=0): rollup(day < H) + raw(>= H). Windowed (7d/24h): raw only —
    // those windows sit far inside the raw keep floor (45d).
    let f;
    if (cutoff === 0 && H > 0) {
      const a = flowDailyStmt.get(H);
      const b = flowStmt.get(H);
      f = {};
      for (const k of Object.keys(b)) f[k] = (a[k] || 0) + (b[k] || 0);
    } else {
      f = flowStmt.get(cutoff);
    }
    const fees = payoutFeeStmt.get(cutoff).fees;
    const inTotal = f.in_block + f.in_fee + f.in_inject + f.in_topup;
    const outTotal = f.out_payout + f.out_orphan;
    return {
      in: { block_rewards: r9(f.in_block), pool_fee: r9(f.in_fee), admin_inject: r9(f.in_inject),
            prize_topup: r9(f.in_topup), total: r9(inTotal) },
      out: { payouts: r9(f.out_payout), payout_network_fees: r9(fees), orphan_clawback: r9(f.out_orphan),
             total: r9(outTotal) },
      net: r9(inTotal - outTotal),
    };
  };

  // ── Ledger side (SQLite = source of truth for who is owed what) ──
  const ledger = db.prepare(
    `SELECT COALESCE(SUM(balance),0) AS sum_balance, COALESCE(SUM(balance_locked),0) AS sum_locked,
            COUNT(*) AS accounts FROM miner_accounts`
  ).get();
  const minerSpendable = db.prepare(
    `SELECT COALESCE(SUM(balance),0) AS s FROM miner_accounts WHERE grin_address NOT IN ('pool_fee','prize_pool')`
  ).get().s;
  const pending = db.prepare(
    `SELECT COALESCE(SUM(amount),0) AS amt, COUNT(*) AS cnt FROM withdrawals
     WHERE status IN ('tor_checking','tor_sending','retry_scheduled','slatepack_pending')`
  ).get();

  // Bucket detail (donation + fee → contest budget). Lifetime per-address sums —
  // composite (rollup keeps grin_address as a dimension, so these stay exact).
  const composite = (rawSql, dailySql, params) => {
    const raw = db.prepare(rawSql).get(...params, H);
    if (H <= 0) return raw;
    const agg = db.prepare(dailySql).get(...params, H);
    const out = {};
    for (const k of Object.keys(raw)) out[k] = (raw[k] || 0) + (agg[k] || 0);
    return out;
  };
  const FEE_CASES = (amt) => `
    SELECT COALESCE(SUM(CASE WHEN event_type='credit' AND reference_type='pool_fee' THEN ${amt} END),0) AS collected,
           COALESCE(SUM(CASE WHEN event_type='debit'  AND reference_type='fee_cut'  THEN ${amt} END),0) AS diverted`;
  const feeAgg = composite(
    `${FEE_CASES('amount')} FROM balance_log WHERE grin_address='pool_fee' AND created_at >= ?`,
    `${FEE_CASES('total_amount')} FROM balance_log_daily WHERE grin_address='pool_fee' AND day < ?`,
    []
  );
  const PRIZE_CASES = (amt) => `
    SELECT COALESCE(SUM(CASE WHEN event_type='credit'   THEN ${amt} END),0) AS funded,
           COALESCE(SUM(CASE WHEN event_type='debit'    THEN ${amt} END),0) AS awarded,
           COALESCE(SUM(CASE WHEN event_type='credit' AND reference_type='fee_cut'  THEN ${amt} END),0) AS from_fee,
           COALESCE(SUM(CASE WHEN event_type='credit' AND reference_type='donation' THEN ${amt} END),0) AS from_donations,
           COALESCE(SUM(CASE WHEN event_type='credit' AND reference_type='topup'    THEN ${amt} END),0) AS from_topups`;
  const prizeAgg = composite(
    `${PRIZE_CASES('amount')} FROM balance_log WHERE grin_address='prize_pool' AND created_at >= ?`,
    `${PRIZE_CASES('total_amount')} FROM balance_log_daily WHERE grin_address='prize_pool' AND day < ?`,
    []
  );
  const feeBalance = db.prepare(`SELECT COALESCE(balance,0) AS b FROM miner_accounts WHERE grin_address='pool_fee'`).get().b;
  const prizeBalance = db.prepare(`SELECT COALESCE(balance,0) AS b FROM miner_accounts WHERE grin_address='prize_pool'`).get().b;

  // Immature block rewards — found but not yet matured/distributed, so NOT in `owed` yet.
  const immatureBlocks = db.prepare(
    `SELECT COUNT(*) AS cnt, COALESCE(SUM(reward),0) AS reward_sum FROM blocks WHERE status='immature'`
  ).get();

  // ── Wallet side (on-chain = source of truth for coins) ──
  let walletReachable = false;
  let walletBalance = { total: 0, spendable: 0, locked: 0, immature: 0,
                        awaiting_confirmation: 0, awaiting_finalization: 0 };
  if (wallet && typeof wallet.getBalance === 'function') {
    try {
      const summary = await wallet.getBalance(forceRefresh);
      const info = Array.isArray(summary) ? summary[1] : (summary || {});
      walletBalance = {
        total: Number(info.total || 0) / 1e9,
        spendable: Number(info.amount_currently_spendable || 0) / 1e9,
        locked: Number(info.amount_locked || 0) / 1e9,
        immature: Number(info.amount_immature || 0) / 1e9,
        awaiting_confirmation: Number(info.amount_awaiting_confirmation || 0) / 1e9,
        awaiting_finalization: Number(info.amount_awaiting_finalization || 0) / 1e9,
      };
      walletReachable = true;
    } catch (e) { walletReachable = false; }
  }

  // ── Integrity invariant: account totals vs net of the append-only log ──
  // Composite over rollup + raw. Stays exact after raw pruning because pruning is
  // verify-before-delete against the same rollup this reads (lib/ledger-rollup.js).
  const INV_CASES = (amt) => `
    SELECT COALESCE(SUM(CASE WHEN event_type='credit' THEN ${amt}
                             WHEN event_type='debit'  THEN -${amt}
                             WHEN event_type='reversal' AND reference_type != 'withdrawal' THEN -${amt}
                             ELSE 0 END),0) AS expected_total`;
  const inv = composite(
    `${INV_CASES('amount')} FROM balance_log WHERE created_at >= ?`,
    `${INV_CASES('total_amount')} FROM balance_log_daily WHERE day < ?`,
    []
  );
  const ledgerTotal = ledger.sum_balance + ledger.sum_locked;
  const integrity_drift = r9(ledgerTotal - inv.expected_total);

  // ── Coverage (wallet vs ledger) ──
  // Network fees are sender-paid in Grin: each confirmed payout spends amount + fee from the
  // wallet while the ledger debits only amount, so the wallet legitimately holds Σ(recorded
  // fees) less than raw owed. Add them back so the gap measures only the UNEXPLAINED shortfall
  // — otherwise accumulated fees slowly drag the gap negative and false-trip the
  // coverage_shortfall auto-freeze (or mask a small real shortfall of the same size).
  const network_fees_paid = payoutFeeStmt.get(0).fees;
  const spendableOwed = ledger.sum_balance;   // withdrawable now (incl. operator buckets)
  const totalOwed = ledgerTotal;
  const coverage_liquid_gap = r9(walletBalance.spendable - spendableOwed + network_fees_paid);
  const coverage_full_gap = r9(walletBalance.total - totalOwed + network_fees_paid);
  const locked_drift = r9(ledger.sum_locked - pending.amt);

  return {
    timestamp: new Date().toISOString(),
    wallet: { reachable: walletReachable, ...Object.fromEntries(
      Object.entries(walletBalance).map(([k, v]) => [k, r9(v)])) },
    ledger: {
      spendable_owed: r9(spendableOwed),
      locked_owed: r9(ledger.sum_locked),
      total_owed: r9(totalOwed),
      miner_spendable: r9(minerSpendable),
      accounts: ledger.accounts,
      buckets: {
        pool_fee: {
          balance: r9(feeBalance),
          collected: r9(feeAgg.collected),
          diverted_to_prizes: r9(feeAgg.diverted),
          operator_realized: r9(feeAgg.collected - feeAgg.diverted - feeBalance),
        },
        prize_pool: {
          balance: r9(prizeBalance),
          funded: r9(prizeAgg.funded),
          awarded: r9(prizeAgg.awarded),
          from_fee: r9(prizeAgg.from_fee),
          from_donations: r9(prizeAgg.from_donations),
          from_topups: r9(prizeAgg.from_topups),
        },
      },
    },
    immature_blocks: { count: immatureBlocks.cnt, reward_sum: r9(immatureBlocks.reward_sum) },
    pending_withdrawals: { count: pending.cnt, amount: r9(pending.amt) },
    flows: { lifetime: flow(0), d7: flow(now - 7 * 86400), d1: flow(now - 86400) },
    checks: {
      network_fees_paid: r9(network_fees_paid),
      coverage_liquid_gap,
      coverage_liquid_ok: !walletReachable ? null : coverage_liquid_gap >= -TOL,
      coverage_full_gap,
      coverage_full_ok: !walletReachable ? null : coverage_full_gap >= -TOL,
      locked_drift,
      locked_ok: Math.abs(locked_drift) <= TOL,
      integrity_drift,
      integrity_ok: Math.abs(integrity_drift) <= TOL,
    },
  };
}

/**
 * Wallet-send audit — the DIRECT out-of-band-send detector. Reads the wallet's OWN transaction
 * log (retrieve_txs) and matches every confirmed OUTBOUND send against the pool's withdrawals
 * table. Any confirmed send that matches no pool withdrawal is an out-of-band `grin-wallet send`
 * (operator sweep, or theft) — invisible to the SQLite ledger and to the integrity invariant.
 *
 * Matching is deliberately GENEROUS (bias toward NOT flagging legit payouts as unrecorded):
 *   - slate_id exact match first (slatepack payouts store it),
 *   - else amount≈ (within amount_tol) + created/confirmed within window_days.
 * Each pool withdrawal is consumed by at most one wallet tx, so N identical payouts need N rows.
 * Tor payouts DON'T store a slate_id, so amount+time is the primary path for them — that's why
 * the tolerance is loose rather than exact. Self-spends/consolidations net ~0 and are skipped.
 */
async function auditWalletSends(db, wallet, opts = {}) {
  const window_days = opts.window_days || 30;
  const amount_tol = opts.amount_tol != null ? opts.amount_tol : 0.05; // GRIN
  const min_grin = opts.min_grin != null ? opts.min_grin : 0.001;      // ignore dust/self-spends
  if (!wallet || typeof wallet.getTransactions !== 'function') {
    return { reachable: false, matched: 0, unrecorded: [], total_unrecorded: 0 };
  }

  let entries;
  try {
    entries = await wallet.getTransactions(true);
  } catch (e) {
    return { reachable: false, error: e.message, matched: 0, unrecorded: [], total_unrecorded: 0 };
  }
  if (!Array.isArray(entries)) return { reachable: false, matched: 0, unrecorded: [], total_unrecorded: 0 };

  const nowSec = Math.floor(Date.now() / 1000);
  const cutoff = nowSec - window_days * 86400;
  const tsOf = (e) => {
    const s = e.confirmation_ts || e.creation_ts;
    const t = s ? Math.floor(Date.parse(s) / 1000) : NaN;
    return Number.isFinite(t) ? t : nowSec;
  };
  const feeNano = (e) => {
    if (e.fee == null) return 0;
    if (typeof e.fee === 'object') return Number(e.fee.fee || 0) || 0;
    return Number(e.fee) || 0;
  };

  // Confirmed OUTBOUND sends within the window, with the net amount that left to the recipient.
  const sends = [];
  for (const e of entries) {
    if (!e || e.tx_type !== 'TxSent' || !e.confirmed) continue;
    const when = tsOf(e);
    if (when < cutoff) continue;
    const recipient = (Number(e.amount_debited || 0) - Number(e.amount_credited || 0) - feeNano(e)) / 1e9;
    if (!(recipient >= min_grin)) continue; // skip self-spends / consolidations (~0)
    sends.push({ tx_id: e.id, slate_id: e.tx_slate_id || null, amount: parseFloat(recipient.toFixed(9)), when });
  }

  // Candidate pool withdrawals: any row whose send was actually attempted, within the window.
  const rows = db.prepare(`
    SELECT id, amount, fee, slate_id, created_at, confirmed_at, status FROM withdrawals
    WHERE status IN ('confirmed','tor_sending','tor_failed','cancelled','slatepack_pending')
      AND (created_at >= ? OR COALESCE(confirmed_at,0) >= ?)
  `).all(cutoff, cutoff);
  const consumed = new Set();

  const matchOne = (send) => {
    // 1) slate_id exact (slatepack).
    if (send.slate_id) {
      const bySlate = rows.find((r) => !consumed.has(r.id) && r.slate_id && r.slate_id === send.slate_id);
      if (bySlate) { consumed.add(bySlate.id); return true; }
    }
    // 2) amount within tolerance, nearest in time. Generous ±window on either side.
    let best = null, bestDt = Infinity;
    for (const r of rows) {
      if (consumed.has(r.id)) continue;
      if (Math.abs(r.amount - send.amount) > amount_tol) continue;
      const rt = r.confirmed_at || r.created_at || send.when;
      const dt = Math.abs(rt - send.when);
      if (dt < bestDt) { best = r; bestDt = dt; }
    }
    if (best) { consumed.add(best.id); return true; }
    return false;
  };

  const unrecorded = [];
  let matched = 0;
  for (const s of sends) {
    if (matchOne(s)) matched++;
    else unrecorded.push(s);
  }
  const total_unrecorded = parseFloat(unrecorded.reduce((a, s) => a + s.amount, 0).toFixed(9));

  return { reachable: true, window_days, scanned: sends.length, matched, unrecorded, total_unrecorded };
}

/**
 * Wallet-identity guard — the "did the pool wallet get switched?" anchor.
 *
 * The pool trusts whatever wallet answers at the configured Owner API. If that wallet is silently
 * replaced (accidental repoint, restore of the WRONG seed, or theft), coverage/drain detectors
 * fire only if the balances also diverge — a same-value swap would slip through. This guard closes
 * that gap by pinning the wallet's slatepack address at derivation index 0 (deterministic from the
 * seed) and alerting the moment the live wallet's address stops matching the adopted one.
 *
 * A PLANNED switch legitimately changes the address, so the switch wizard calls adoptWalletIdentity
 * after the operator confirms the new wallet — that's what stops the guard from fighting an
 * intentional migration. Absence of a stored row = trust-on-first-use: the first reachable probe
 * adopts the current wallet silently (so adding this guard to a running pool doesn't false-fire).
 */
function getWalletIdentity(db) {
  return db.prepare(
    `SELECT slatepack_address, adopted_at, adopted_by FROM wallet_identity WHERE id = 1`
  ).get() || null;
}

function adoptWalletIdentity(db, address, by) {
  db.prepare(`
    INSERT INTO wallet_identity (id, slatepack_address, adopted_at, adopted_by)
    VALUES (1, ?, unixepoch(), ?)
    ON CONFLICT(id) DO UPDATE SET
      slatepack_address = excluded.slatepack_address,
      adopted_at = excluded.adopted_at,
      adopted_by = excluded.adopted_by
  `).run(String(address), by || null);
  return getWalletIdentity(db);
}

// Probe the live wallet identity and compare against the adopted anchor. Returns
// { reachable, live, expected, match, firstRun, adopted_at, adopted_by }. On first use (no stored
// row) it adopts the live address and returns firstRun:true / match:true. If the wallet is
// unreachable it returns { reachable:false } WITHOUT mutating state — a probe that can't observe
// the wallet must never be read as a mismatch.
async function probeWalletIdentity(db, wallet, opts = {}) {
  if (!wallet || typeof wallet.getSlatepackAddress !== 'function') return { reachable: false };
  let live;
  try {
    live = await wallet.getSlatepackAddress(0);
  } catch (e) {
    return { reachable: false, error: e.message };
  }
  if (!live || typeof live !== 'string') return { reachable: false };

  const row = getWalletIdentity(db);
  if (!row) {
    adoptWalletIdentity(db, live, opts.firstUseBy || 'auto_first_use');
    return { reachable: true, live, expected: live, match: true, firstRun: true };
  }
  return {
    reachable: true,
    live,
    expected: row.slatepack_address,
    match: live === row.slatepack_address,
    firstRun: false,
    adopted_at: row.adopted_at,
    adopted_by: row.adopted_by,
  };
}

module.exports = {
  computeReconciliation, auditWalletSends,
  getWalletIdentity, adoptWalletIdentity, probeWalletIdentity,
  TOL, r9,
};
