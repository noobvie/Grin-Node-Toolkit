// /api/admin/* money routes — withdrawals and the payout queue (Held re-check, forced refund,
// cancel), the payout kill-switch, wallet ↔ ledger reconciliation, abandoned-balance disposition,
// operator revenue, the wallet-send audit + wallet-identity switch, the financial CSV exports and
// the payout-request audit. Every money-moving POST is freshAdmin (step-up).
// Moved verbatim out of routes/index.js (code-layout refactor P6); registrations stay at 2-space
// indent and write FULL paths. Instances/state come from ctx; the guard chains are the ONE
// createGuards(ctx) instance routes/index.js built (I7), handed in as `guards`.

const express = require('express');
const { REVENUE_ADDRESS_HOLD_S } = require('../../lib/config');
const { computeReconciliation, auditWalletSends, probeWalletIdentity, adoptWalletIdentity } = require('../../lib/reconciliation');
const { getHorizon: getLedgerRollupHorizon } = require('../../lib/ledger-rollup');
const { verifyOwnerProof, auditOwnerProof } = require('../../lib/owner-proof');
const geoip = require('../../lib/geoip');
const AlertMonitor = require('../../lib/alert-monitor');
const createCsv = require('../_shared/csv');
const { GRIN_ADDR_RE } = require('../_shared/grin-address');

module.exports = function createAdminPayoutsRoutes(ctx, guards) {
  const {
    config, db, wallet, withdrawalScheduler, dormancyManager, alertMonitor, alertDelivery, poolSettings,
  } = ctx;
  const { secureAdmin, freshAdmin } = guards;
  const router = express.Router();

  // REMOVED: /api/test/initiate-withdrawal endpoint
  // Reason: Test endpoint disabled in production. Allowed admin to initiate arbitrary withdrawals.
  // Use /api/admin/withdrawals to view and manage withdrawal scheduler instead.
  // For testing: drive withdrawalScheduler.sendWithdrawal() directly in backend tests.

  // `limit` is honoured (1–500, default 100). The dashboard's "Recent Withdrawals" widget
  // asks for 10 and was silently getting the full 100 back — every admin page load shipped
  // and rendered 10× the rows it displays.
  router.get('/api/admin/withdrawals', secureAdmin, (req, res) => {
    try {
      const status = req.query.status || null;
      const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);

      const rows = status
        ? db.prepare('SELECT * FROM withdrawals WHERE status = ? ORDER BY created_at DESC LIMIT ?').all(status, limit)
        : db.prepare('SELECT * FROM withdrawals ORDER BY created_at DESC LIMIT ?').all(limit);
      // The signed proof is a ~600-byte blob per row; the list carries a flag and the per-row
      // route below serves the document.
      // chain_state (paid rows only, else null): 'mined' | 'settling' | 'unmined' | 'cancelled' |
      // 'absent' | 'unverifiable' — the "marked paid but not mined" watchdog's view
      // (withdrawal-scheduler chainStateOf). Admin-only: no public route carries it.
      const now = Math.floor(Date.now() / 1000);
      const chainState = (r) => (withdrawalScheduler ? withdrawalScheduler.chainStateOf(r, now) : null);
      // tor_final_slate (the step-by-step Tor send, deleted 2026-09-26; nothing writes it now) can
      // hold a complete signed transaction on an old row — never served. tor_step (equally inert)
      // stays. slatepack_s1 (the manual rail's stored S1) is
      // served by exactly one route — the owner's ownership-gated re-fetch — and not here either.
      res.json(rows.map((r) => {
        const { payment_proof, ...rest } = r;
        delete rest.tor_final_slate;
        delete rest.slatepack_s1;
        return { ...rest, has_payment_proof: !!payment_proof, chain_state: chainState(r) };
      }));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // The signed payment proof for ONE payout — the document that settles "I never received it"
  // in front of a third party (the recipient's own key signed for this amount at this kernel;
  // see withdrawal-scheduler.fetchAndStorePaymentProof). Read-only and secureAdmin: it moves no
  // money, and the list above already shows this admin the address, slate and kernel. The id
  // is the only input and the slate it resolves to comes from OUR row, never the request, so
  // this cannot be used to look up arbitrary transactions in the wallet. If the backfill has
  // not stored it yet the route asks the wallet once (one local tx-log read) — that is the
  // operator's "fetch it now" for a fresh dispute.
  router.get('/api/admin/withdrawals/:id/payment-proof', secureAdmin, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'bad withdrawal id' });
      const w = db.prepare(
        'SELECT id, grin_address, amount, fee_charged, method, status, slate_id, kernel_excess, confirmed_at FROM withdrawals WHERE id = ?'
      ).get(id);
      if (!w) return res.status(404).json({ error: 'withdrawal not found' });
      if (!withdrawalScheduler) return res.status(503).json({ error: 'withdrawal scheduler not running' });
      const r = await withdrawalScheduler.fetchAndStorePaymentProof(id);
      if (!r.ok) {
        const why = {
          none: 'this payout carries no signed proof (only the Tor rail requests one) - the kernel is its evidence',
          not_confirmed: 'proof is only available once the payout is confirmed and its kernel is on record',
          owner_api_unavailable: 'the wallet Owner API is not configured on this pool',
          kernel_mismatch: 'the wallet proof does not match the kernel on this row - check the slate attribution before relying on either',
          malformed: 'the wallet returned an unexpected proof shape',
          error: r.error || 'the wallet could not be read'
        }[r.reason] || r.reason;
        return res.status(r.reason === 'error' || r.reason === 'owner_api_unavailable' ? 503 : 409)
          .json({ error: why, reason: r.reason, withdrawal: w });
      }
      res.json({ withdrawal: w, proof: r.proof, cached: !!r.cached,
                 verify: 'grin-wallet verify_proof <file> - or the chain explorer /proof page' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/api/admin/withdrawal-scheduler', secureAdmin, (req, res) => {
    res.json(withdrawalScheduler.getStatus());
  });

  // ─── PAYOUT QUEUE CONTROL (Admin) ──────────────────────────────────
  // Since 2026-09-26 a Tor payout is tried ONCE and ends confirmed, tor_failed (balance already
  // returned — the miner simply requests again) or tor_held (outcome unknown, amount locked). So
  // there is nothing to "retry": the operator's tools are Re-check (the Held resolution, now) and
  // a forced refund of a Held payout (step-up + typed id + audit, refused on a confirmed match).
  // Cancel stays for a row that was never sent (tor_checking) and for recording a tor_failed one.
  //
  // Funds model (see withdrawal-scheduler.js): tor_checking / tor_held keep the amount in
  // balance_locked; tor_failed has already reversed it back to spendable balance.

  // REMOVED 2026-09-26: re-queuing a Tor payout. It re-sent a payout on the operator's click —
  // for a tor_failed row after re-locking the balance, for a retry_scheduled one as-is — and a
  // refunded miner now just requests again. Kept as a 410 so a stale admin page says why instead
  // of failing obscurely; nothing else ever used it (the Slatepack / Goblin rails have no retry).
  router.post('/api/admin/withdrawals/:id/retry', secureAdmin, (req, res) => {
    res.status(410).json({
      error: 'Retry was removed: a Tor payout is tried once. A failed one is already refunded (the miner requests again); ' +
        'a Held one is settled by Re-check or, with proof, a forced refund.',
    });
  });

  // Re-check ONE Held payout now: the scheduler's own Held resolution for that row — confirmed on a
  // confirmed tx, refunded only on its second absent read ≥ 10 min after the first, otherwise
  // still held. No force, no send. Audited, because it can settle money.
  router.post('/api/admin/withdrawals/:id/recheck', secureAdmin, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'bad withdrawal id' });
      if (!withdrawalScheduler) return res.status(503).json({ error: 'withdrawal scheduler not running' });
      const w = db.prepare('SELECT id, grin_address, amount, status FROM withdrawals WHERE id = ?').get(id);
      if (!w) return res.status(404).json({ error: 'withdrawal not found' });
      if (w.status !== 'tor_held') return res.status(409).json({ error: `only a Held payout can be re-checked (status: ${w.status})` });

      const r = await withdrawalScheduler.resolveHeldTor({ id });
      const after = db.prepare('SELECT status, fail_code FROM withdrawals WHERE id = ?').get(id);
      const outcome = (r[0] && r[0].outcome) || 'unknown';
      db.prepare(`
        INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, details, ip)
        VALUES (?, 'withdrawal_held_recheck', 'withdrawal', ?, ?, ?)
      `).run(req.user.user_id, String(id), JSON.stringify({ address: w.grin_address, amount: w.amount, outcome, status: after.status }), req.ip);
      res.json({ success: true, id, outcome, status: after.status, fail_code: after.fail_code });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Forced refund of a Held payout — the operator's call when they have proven the send never
  // reached the chain. Step-up, the payout id typed back (confirm_id), an audit row, and the
  // scheduler still refuses when the wallet tx log shows a CONFIRMED match or cannot be read.
  // Never a re-send.
  router.post('/api/admin/withdrawals/:id/force-refund', freshAdmin, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'bad withdrawal id' });
      if (String((req.body && req.body.confirm_id) || '').trim() !== String(id)) {
        return res.status(400).json({ error: 'type the payout id to confirm a forced refund' });
      }
      if (!withdrawalScheduler) return res.status(503).json({ error: 'withdrawal scheduler not running' });
      const reason = String((req.body && req.body.reason) || '').slice(0, 280) || null;
      const r = await withdrawalScheduler.forceRefundHeld(id, { adminId: req.user.user_id, reason });
      db.prepare(`
        INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, details, ip)
        VALUES (?, 'withdrawal_force_refund', 'withdrawal', ?, ?, ?)
      `).run(req.user.user_id, String(id), JSON.stringify({ amount: r.amount, tx_log: r.tx_log, slate_id: r.slate_id,
        wallet_history: r.wallet_history, cancelled_slate: r.cancelled_slate, reason }), req.ip);
      res.json(r);
    } catch (err) {
      res.status(err.code && err.code >= 400 && err.code < 600 ? err.code : 500).json({ error: err.message });
    }
  });

  // Cancel a never-sent withdrawal (tor_checking). tor_held is deliberately NOT cancellable (its one
  // send may have landed — see force-refund above), and neither is a legacy retry_scheduled row:
  // cancelling refunded it with no wallet check, and the startup migration settles those.
  // tor_failed is not cancellable either (2026-09-27, operator decision): it was refunded when it
  // failed, so there is nothing to return. Cancel only relabelled it 'cancelled', and four readers
  // key on 'tor_failed' — auditWalletSends (counts 'cancelled' as recorded, hiding a double pay),
  // the Tor pause, the pool-side payout_failed alert and _assertNoRecentReversal's exclusion.
  router.post('/api/admin/withdrawals/:id/cancel', freshAdmin, (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const reason = String((req.body && req.body.reason) || '').slice(0, 280) || null;
      const w = db.prepare('SELECT * FROM withdrawals WHERE id = ?').get(id);
      if (!w) return res.status(404).json({ error: 'withdrawal not found' });
      if (w.status === 'tor_sending') return res.status(409).json({ error: 'cannot cancel a withdrawal that is currently sending' });
      if (w.status === 'tor_held') {
        return res.status(409).json({ error: 'a Held payout cannot be cancelled — use Re-check, or a forced refund once the wallet shows no confirmed send' });
      }
      if (w.status === 'tor_failed') {
        return res.status(409).json({ error: 'this payout failed and was already refunded to the miner — there is nothing to cancel' });
      }
      if (w.status !== 'tor_checking') {
        return res.status(409).json({ error: `cannot cancel a withdrawal in status '${w.status}'` });
      }

      db.transaction(() => {
        // tor_checking still holds the amount in balance_locked → release it.
        const before = db.prepare('SELECT balance, balance_locked FROM miner_accounts WHERE grin_address = ?').get(w.grin_address);
        db.prepare(
          `UPDATE miner_accounts SET balance = balance + ?, balance_locked = CASE WHEN balance_locked >= ? THEN balance_locked - ? ELSE 0 END, updated_at = unixepoch()
           WHERE grin_address = ?`
        ).run(w.amount, w.amount, w.amount, w.grin_address);
        db.prepare(`
          INSERT INTO balance_log (grin_address, event_type, amount, balance_before, balance_after, locked_before, locked_after, reference_type, reference_id)
          VALUES (?, 'reversal', ?, ?, ?, ?, ?, 'withdrawal', ?)
        `).run(w.grin_address, w.amount, before.balance, before.balance + w.amount, before.balance_locked, Math.max(0, before.balance_locked - w.amount), id);
        db.prepare('UPDATE withdrawals SET status = ?, cancelled_by = ?, cancel_reason = ? WHERE id = ?')
          .run('cancelled', req.user.user_id, reason, id);
        db.prepare(`
          INSERT INTO withdrawal_events (withdrawal_id, from_status, to_status, triggered_by, note)
          VALUES (?, ?, 'cancelled', 'admin', ?)
        `).run(id, w.status, reason || 'cancelled by admin');
      })();

      db.prepare(`
        INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, details, ip)
        VALUES (?, 'withdrawal_cancel', 'withdrawal', ?, ?, ?)
      `).run(req.user.user_id, String(id), JSON.stringify({ address: w.grin_address, amount: w.amount, from_status: w.status, reason }), req.ip);

      res.json({ success: true, id, refunded: true, amount: w.amount });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Read the payout kill-switch state (single row id=1; absence = not frozen).
  const getPayoutControl = () => {
    const row = db.prepare('SELECT frozen, reason, frozen_by, frozen_at FROM payout_control WHERE id = 1').get();
    return {
      frozen: !!(row && row.frozen),
      reason: row ? row.reason : null,
      frozen_by: row ? row.frozen_by : null,
      frozen_at: row ? row.frozen_at : null,
    };
  };

  // ─── WALLET ↔ LEDGER RECONCILIATION (Admin) ────────────────────────
  // The pool's custodial money statement (coverage, flow, buckets, integrity invariant). The
  // full computation lives in lib/reconciliation.js so the AlertMonitor money detectors and
  // this endpoint share one source of truth. Forces a fresh wallet→node scan (slow) — the admin
  // page polls it on its own 3-min cadence, never the fast liveness loops.
  router.get('/api/admin/reconciliation', secureAdmin, async (req, res) => {
    try {
      const recon = await computeReconciliation(db, wallet, true);
      res.json({ success: true, ...recon, payout_control: getPayoutControl() });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── PAYOUT KILL-SWITCH (Admin) ────────────────────────────────────
  // Emergency freeze of the withdrawal scheduler. Set automatically by AlertMonitor on a critical
  // money trip (coverage shortfall / integrity drift / wallet drain) and manually here. Reading is
  // secureAdmin (surfaced on every admin Payouts page); mutating is freshAdmin (step-up — it's money-control).
  router.get('/api/admin/payouts/control', secureAdmin, (req, res) => {
    try { res.json({ success: true, ...getPayoutControl() }); }
    catch (err) { res.status(500).json({ error: err.message }); }
  });

  router.post('/api/admin/payouts/freeze', freshAdmin, (req, res) => {
    try {
      const reason = (req.body && req.body.reason || '').toString().slice(0, 500) || 'manual admin freeze';
      if (withdrawalScheduler && withdrawalScheduler.freeze) withdrawalScheduler.freeze(reason, `admin:${req.user.username}`);
      db.prepare(`INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, details, ip)
                  VALUES (?, 'payouts_freeze', 'payouts', 'payouts', ?, ?)`)
        .run(req.user.user_id, JSON.stringify({ reason }), req.ip);
      res.json({ success: true, ...getPayoutControl() });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  router.post('/api/admin/payouts/resume', freshAdmin, (req, res) => {
    try {
      if (withdrawalScheduler && withdrawalScheduler.resume) withdrawalScheduler.resume(`admin:${req.user.username}`);
      db.prepare(`INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, details, ip)
                  VALUES (?, 'payouts_resume', 'payouts', 'payouts', ?, ?)`)
        .run(req.user.user_id, JSON.stringify({}), req.ip);
      res.json({ success: true, ...getPayoutControl() });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ─── ABANDONED-BALANCE DISPOSITION (Admin) ─────────────────────────
  // Status + dry-run preview + the dormant list (UNMASKED for the operator) + disposition history.
  // Reading is secureAdmin; the run and manual-payout mutate money → freshAdmin (step-up).
  router.get('/api/admin/dormancy', secureAdmin, (req, res) => {
    try {
      if (!dormancyManager) return res.status(503).json({ error: 'dormancy manager not ready' });
      res.json({
        success: true,
        status: dormancyManager.status(),
        preview: dormancyManager.preview(),
        dormant: dormancyManager.listDormant({ mask: false, limit: 500 }),
        history: dormancyManager.history({ limit: 100 }),
      });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Trigger a disposition pass now (respects the disabled/frozen/grandfather gates internally).
  router.post('/api/admin/dormancy/run', freshAdmin, (req, res) => {
    try {
      if (!dormancyManager) return res.status(503).json({ error: 'dormancy manager not ready' });
      const result = dormancyManager.runOnce({ triggeredBy: req.user.user_id });
      db.prepare(`INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, details, ip)
                  VALUES (?, 'dormancy_run', 'dormancy', ?, ?, ?)`)
        .run(req.user.user_id, String(result.disposition_id || 'none'), JSON.stringify(result), req.ip);
      res.json({ success: true, result });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Was this address's ownership successfully verified by an admin in the last `windowSec`? Reads
  // the audit trail auditOwnerProof() writes ('owner_proof:admin_verify:ok'). Gate for the money
  // endpoints below so a payout can't be pushed without a recent ownership check —
  // unless the operator explicitly acknowledges verifying by other means (verified_ack, for a
  // no-proof-on-record account where verifyOwnerProof can never match).
  const ownerRecentlyVerified = (addr, windowSec = 900) => {
    try {
      const row = db.prepare(
        `SELECT created_at FROM admin_audit_log
         WHERE action = 'owner_proof:admin_verify:ok' AND target_id = ?
         ORDER BY created_at DESC LIMIT 1`
      ).get(addr);
      if (!row) return false;
      return (Math.floor(Date.now() / 1000) - Number(row.created_at)) <= windowSec;
    } catch (e) { return false; }
  };

  // Verify a miner's CLAIMED ownership proof (IP or stratum password) against what's on record —
  // for the operator handling a sub-threshold "email support to withdraw" request. Returns a
  // match/no-match ONLY (the stored proofs are salted-scrypt hashes; nothing is ever revealed).
  router.post('/api/admin/dormancy/verify-owner', secureAdmin, async (req, res) => {
    try {
      const addr = String((req.body && req.body.address) || '').trim();
      const submitted = String((req.body && req.body.proof) || '');
      if (!addr) return res.status(400).json({ error: 'address required' });
      const proof = await verifyOwnerProof(db, addr, submitted);
      auditOwnerProof(db, { action: 'admin_verify', grinAddress: addr, ip: req.ip, ok: proof.ok, details: { by: req.user.username } });
      res.json({ success: true, match: !!proof.ok, method: proof.method || null, reason: proof.reason });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Record an out-of-band manual payout (the admin already sent the coins by Tor/slatepack at the
  // OS level after verifying the owner). Writes a confirmed withdrawals row + 'withdrawal' debit so
  // coverage stays correct and the wallet-send audit matches it. Honours the payout freeze.
  router.post('/api/admin/dormancy/manual-payout', freshAdmin, (req, res) => {
    try {
      if (!dormancyManager) return res.status(503).json({ error: 'dormancy manager not ready' });
      if (getPayoutControl().frozen) {
        return res.status(409).json({ error: 'payouts are frozen — resume payouts before recording a manual payout' });
      }
      const b = req.body || {};
      const addr = String(b.address || '').trim();
      if (!ownerRecentlyVerified(addr) && b.verified_ack !== true) {
        return res.status(428).json({ error: 'verify the address owner first (no successful verification in the last 15 min)', reason: 'verify_required' });
      }
      const result = dormancyManager.manualPayout({
        grinAddress: b.address,
        amount: b.amount,
        fee: b.fee || 0,
        kernelExcess: b.kernel_excess || null,
        slateId: b.slate_id || null,
        note: b.note || null,
        adminId: req.user.user_id,
        allowAboveMin: b.allow_above_min === true,
      });
      if (!result.ok) return res.status(400).json({ error: result.reason, ...result });
      db.prepare(`INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, details, ip)
                  VALUES (?, 'manual_payout', 'miner', ?, ?, ?)`)
        .run(req.user.user_id, String(b.address || ''), JSON.stringify({ withdrawal_id: result.withdrawal_id, amount: result.balance_after, fee: b.fee || 0 }), req.ip);
      res.json({ success: true, ...result });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Backend-INITIATED below-minimum payout (the convenient sub-threshold path). Instead of the
  // operator sending coins out-of-band and recording it, the pool sends over Tor through the SAME
  // locked withdrawal flow a miner uses — atomic lock, real fee/kernel captured by the scheduler,
  // recorded automatically. adminOverride bypasses only the min floor + reversal cooldown; freeze
  // and the one-pending-per-address cap (double-pay guard) still apply. Needs the miner's wallet
  // listener reachable over Tor (the scheduler declines + reverses the lock if it isn't).
  router.post('/api/admin/dormancy/send-payout', freshAdmin, (req, res) => {
    try {
      if (!withdrawalScheduler) return res.status(503).json({ error: 'withdrawal scheduler not ready' });
      if (getPayoutControl().frozen) {
        return res.status(409).json({ error: 'payouts are frozen — resume payouts before sending' });
      }
      const b = req.body || {};
      const addr = String(b.address || '').trim();
      if (!ownerRecentlyVerified(addr) && b.verified_ack !== true) {
        return res.status(428).json({ error: 'verify the address owner first (no successful verification in the last 15 min)', reason: 'verify_required' });
      }
      let result;
      try {
        result = withdrawalScheduler.createWithdrawal(addr, b.amount, 'tor', { adminOverride: true });
      } catch (e) {
        return res.status(e.code && e.code >= 400 && e.code < 500 ? e.code : 500).json({ error: e.message });
      }
      db.prepare(`INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, details, ip)
                  VALUES (?, 'admin_send_payout', 'miner', ?, ?, ?)`)
        .run(req.user.user_id, addr, JSON.stringify({ withdrawal_id: result.withdrawal_id, amount: result.amount, override: 'below_min' }), req.ip);
      res.json({ success: true, ...result });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ─── Operator revenue (2026-10-05) ──────────────────────────────────────────
  // The pool_fee bucket had no way out: the account page refuses the pseudo-address, no admin
  // route debited it, and a raw `grin-wallet send` from the pool wallet drops the wallet without
  // touching the ledger — reconciliation then reads a coverage shortfall and freezes every miner
  // payout. These routes send it through the normal locked Tor flow instead
  // (WithdrawalScheduler.createRevenueWithdrawal), to ONE saved address:
  //   · the address is never typed into the withdraw form — the route reads the saved one;
  //   · changing it needs step-up, writes an audit row, raises a critical alert, and starts a
  //     24 h hold before any withdrawal may go to it. A stolen admin session can repoint it, but
  //     cannot drain in the same sitting, and the operator hears about it at once.
  const REVENUE_HOLD_S = REVENUE_ADDRESS_HOLD_S;
  const revenueAddressRow = () =>
    db.prepare('SELECT address, set_at, set_by, prev_address FROM operator_revenue WHERE id = 1').get() || null;
  // The network's own prefix: a mainnet pool paying a tgrin1 address (or the reverse) would hand
  // grin-wallet a destination it cannot reach, and the payout would end Held or failed.
  const revenueAddrOk = (a) => GRIN_ADDR_RE.test(a) &&
    (config.network === 'testnet' ? a.startsWith('tgrin1') : a.startsWith('grin1'));

  router.get('/api/admin/revenue', secureAdmin, (req, res) => {
    try {
      const now = Math.floor(Date.now() / 1000);
      const row = revenueAddressRow();
      const usableAt = row ? Number(row.set_at) + REVENUE_HOLD_S : null;
      const status = withdrawalScheduler ? withdrawalScheduler.revenueStatus() : null;
      const history = db.prepare(`
        SELECT id, amount, fee, status, dest_address, created_at, confirmed_at, kernel_excess
        FROM withdrawals WHERE grin_address = 'pool_fee' ORDER BY id DESC LIMIT 10
      `).all();
      const addressAlert = db.prepare(`
        SELECT id, message, triggered_at FROM alerts
        WHERE type = 'operator_revenue_address_changed' AND status = 'active' ORDER BY id DESC LIMIT 1
      `).get() || null;
      res.json({
        success: true,
        address: row ? row.address : null,
        prev_address: row ? row.prev_address : null,
        set_at: row ? row.set_at : null,
        usable_at: usableAt,
        hold_remaining_s: usableAt ? Math.max(0, usableAt - now) : 0,
        network: config.network === 'testnet' ? 'testnet' : 'mainnet',
        withdrawal_fee: Number(config.withdrawal_fee) || 0,
        frozen: !!getPayoutControl().frozen,
        // Which off-box channels the address-change alarm is pushed to. None = the hold only
        // helps if someone opens this panel within 24 h; the page says so in red.
        alert_channels: alertDelivery && typeof alertDelivery.configuredChannels === 'function'
          ? alertDelivery.configuredChannels() : {},
        address_alert_locked_until: AlertMonitor.closeLockedUntil(db, 'operator_revenue_address_changed') || null,
        ...(status || {}),
        history,
        address_alert: addressAlert,
      });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  router.post('/api/admin/revenue/address', freshAdmin, async (req, res) => {
    try {
      const addr = String((req.body && req.body.address) || '').trim();
      const net = config.network === 'testnet' ? 'testnet (tgrin1…)' : 'mainnet (grin1…)';
      if (!revenueAddrOk(addr)) {
        return res.status(400).json({ error: `not a valid ${net} Grin address` });
      }
      const prev = revenueAddressRow();
      if (prev && prev.address === addr) {
        // Re-saving the same address must not restart the hold (or raise a second alarm).
        return res.status(409).json({ error: 'that is already the revenue address — nothing changed' });
      }
      const now = Math.floor(Date.now() / 1000);
      db.prepare(`
        INSERT INTO operator_revenue (id, address, set_at, set_by, prev_address) VALUES (1, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET address = excluded.address, set_at = excluded.set_at,
          set_by = excluded.set_by, prev_address = excluded.prev_address
      `).run(addr, now, req.user.user_id, prev ? prev.address : null);
      db.prepare(`INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, details, ip)
                  VALUES (?, 'revenue_address_set', 'operator_revenue', '1', ?, ?)`)
        .run(req.user.user_id, JSON.stringify({ from: prev ? prev.address : null, to: addr }), req.ip);
      const usableAt = now + REVENUE_HOLD_S;
      // One alert per change: close the previous change's alarm first, so this one is delivered
      // (triggerAlert only bumps a counter on an alert type that is already active).
      if (alertMonitor && typeof alertMonitor.triggerAlert === 'function') {
        try {
          await alertMonitor.resolveAlert('operator_revenue_address_changed');
          await alertMonitor.triggerAlert('operator_revenue_address_changed', {
            level: 'critical',
            message: `Operator revenue address ${prev ? `changed from ${prev.address} to ${addr}` : `set to ${addr}`} ` +
                     `by admin ${req.user.username}. Revenue withdrawals to it are blocked until ` +
                     `${new Date(usableAt * 1000).toISOString()}. If this was not you, set it back at once and ` +
                     `change every admin password.`,
            data: { from: prev ? prev.address : null, to: addr, by: req.user.username, usable_at: usableAt }
          });
        } catch (e) { console.error(`[revenue] address-change alert failed: ${e.message}`); }
      }
      res.json({ success: true, address: addr, usable_at: usableAt });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  router.post('/api/admin/revenue/withdraw', freshAdmin, async (req, res) => {
    try {
      if (!withdrawalScheduler) return res.status(503).json({ error: 'withdrawal scheduler not ready' });
      if (getPayoutControl().frozen) {
        return res.status(409).json({ error: 'payouts are frozen — resume payouts before withdrawing revenue' });
      }
      const row = revenueAddressRow();
      if (!row) return res.status(400).json({ error: 'set an operator revenue address first' });
      if (!revenueAddrOk(row.address)) {
        return res.status(400).json({ error: 'the saved revenue address is not valid for this network — set it again' });
      }
      // The page echoes the address it showed. A mismatch means it changed since that page loaded
      // (another admin, or another tab) — never send to an address the operator did not just see.
      const shown = String((req.body && req.body.address) || '').trim();
      if (shown !== row.address) {
        return res.status(409).json({ error: 'the revenue address changed since this page loaded — reload and check it' });
      }
      const usableAt = Number(row.set_at) + REVENUE_HOLD_S;
      const now = Math.floor(Date.now() / 1000);
      if (now < usableAt) {
        return res.status(409).json({
          error: `the revenue address was set less than 24 hours ago — withdrawals to it unlock at ${new Date(usableAt * 1000).toISOString()}`,
          reason: 'address_hold', usable_at: usableAt
        });
      }
      const amount = parseFloat(req.body && req.body.amount);
      if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: 'enter a positive amount' });
      try { await withdrawalScheduler._assertWalletCanCover(amount, 'tor'); }
      catch (e) { return res.status(e.code || 503).json({ error: e.message }); }
      let result;
      try {
        result = withdrawalScheduler.createRevenueWithdrawal(amount, row.address);
      } catch (e) {
        return res.status(e.code && e.code >= 400 && e.code < 500 ? e.code : 500).json({ error: e.message });
      }
      db.prepare(`INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, details, ip)
                  VALUES (?, 'revenue_withdraw', 'withdrawal', ?, ?, ?)`)
        .run(req.user.user_id, String(result.withdrawal_id),
             JSON.stringify({ amount: result.amount, to: row.address, network_fees_booked: result.network_fees_booked }), req.ip);
      res.json({ ...result, to: row.address });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Wallet-send audit — matches the wallet's OWN confirmed outbound sends against the pool's
  // withdrawals. Any unmatched send is an out-of-band `grin-wallet send` (invisible to the
  // ledger). Forces a fresh wallet scan (slow) → the admin Treasury page polls on the 3-min cadence.
  router.get('/api/admin/payouts/wallet-audit', secureAdmin, async (req, res) => {
    try {
      const audit = await auditWalletSends(db, wallet, {});
      res.json({ success: true, ...audit });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── WALLET-IDENTITY GUARD + SWITCH WIZARD (Admin) ─────────────────
  // The pool pins its wallet's slatepack address (index 0, seed-deterministic). AlertMonitor
  // freezes payouts if the live wallet stops matching. A PLANNED switch re-adopts the new wallet
  // here so the guard doesn't fight an intentional migration. Reading is secureAdmin (forces a
  // fresh owner-API call → the wizard polls it); adopting moves the trust anchor → freshAdmin.
  router.get('/api/admin/wallet/identity', secureAdmin, async (req, res) => {
    try {
      const id = await probeWalletIdentity(db, wallet);
      res.json({ success: true, ...id });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Adopt the CURRENTLY-connected wallet as the pool's identity anchor (step 4 of the switch
  // wizard). Resolves the wallet_identity_changed alert; does NOT auto-resume payouts (resume is a
  // deliberate separate step). Refuses if the wallet is unreachable — you must not adopt a phantom.
  router.post('/api/admin/wallet/adopt-identity', freshAdmin, async (req, res) => {
    try {
      const id = await probeWalletIdentity(db, wallet);
      if (!id.reachable) return res.status(503).json({ error: 'wallet unreachable — cannot adopt an unconfirmed wallet identity' });
      const prev = id.firstRun ? null : id.expected;
      adoptWalletIdentity(db, id.live, `admin:${req.user.username}`);
      if (alertMonitor && typeof alertMonitor.resolveAlert === 'function') {
        await alertMonitor.resolveAlert('wallet_identity_changed');
      }
      db.prepare(`INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, details, ip)
                  VALUES (?, 'wallet_adopt_identity', 'wallet', 'wallet', ?, ?)`)
        .run(req.user.user_id, JSON.stringify({ previous: prev, adopted: id.live }), req.ip);
      res.json({ success: true, adopted: id.live, previous: prev });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  const { sendCsv, ADMIN_CSV_MAX_ROWS, adminCsvGate, adminCsvBefore, adminCsvPage } = createCsv(ctx);

  // All confirmed payouts.
  router.get('/api/admin/export/payouts.csv', secureAdmin, (req, res) => {
    try {
      if (!adminCsvGate(req, res)) return;
      const before = adminCsvBefore(req);
      // LIMIT is MAX_ROWS + 1 so the extra row IS the truncation signal — a plain LIMIT can
      // never tell "exactly a full page" from "there is more after this".
      const rows = before === null
        ? db.prepare(
            `SELECT id, grin_address, dest_address, amount, fee, status, created_at, confirmed_at
             FROM withdrawals WHERE status = 'confirmed'
             ORDER BY confirmed_at DESC, id DESC LIMIT ?`).all(ADMIN_CSV_MAX_ROWS + 1)
        : db.prepare(
            `SELECT id, grin_address, dest_address, amount, fee, status, created_at, confirmed_at
             FROM withdrawals WHERE status = 'confirmed' AND confirmed_at <= ?
             ORDER BY confirmed_at DESC, id DESC LIMIT ?`).all(before, ADMIN_CSV_MAX_ROWS + 1);
      const { page, note } = adminCsvPage(res, rows, (last) => last.confirmed_at);
      const iso = (t) => (t ? new Date(t * 1000).toISOString() : '');
      sendCsv(res, `payouts-${config.network}.csv`,
        // dest_address: where an operator revenue withdrawal went (its grin_address is the
        // 'pool_fee' bucket); blank on every miner payout, whose grin_address IS the destination.
        ['id', 'grin_address', 'dest_address', 'amount_grin', 'fee_grin', 'status', 'created_at', 'confirmed_at'],
        page.map((r) => [r.id, r.grin_address, r.dest_address || '', r.amount, r.fee, r.status, iso(r.created_at), iso(r.confirmed_at)]),
        note);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Pool-fee revenue per found block (reward × pool_fee_percent). An honest, derived report —
  // the pool's cut of each block, not a separately stored figure.
  router.get('/api/admin/export/fee-revenue.csv', secureAdmin, (req, res) => {
    try {
      const feePct = parseFloat(config.pool_fee_percent != null ? config.pool_fee_percent : 1.0) || 0;
      if (!adminCsvGate(req, res)) return;
      const before = adminCsvBefore(req);
      const rows = before === null
        ? db.prepare(
            `SELECT height, hash, reward, status, found_at FROM blocks
             ORDER BY height DESC LIMIT ?`).all(ADMIN_CSV_MAX_ROWS + 1)
        : db.prepare(
            `SELECT height, hash, reward, status, found_at FROM blocks WHERE height <= ?
             ORDER BY height DESC LIMIT ?`).all(before, ADMIN_CSV_MAX_ROWS + 1);
      const { page, note } = adminCsvPage(res, rows, (last) => last.height);
      const iso = (t) => (t ? new Date(t * 1000).toISOString() : '');
      sendCsv(res, `fee-revenue-${config.network}.csv`,
        ['height', 'hash', 'reward_grin', 'pool_fee_percent', 'pool_cut_grin', 'status', 'found_at'],
        page.map((r) => [r.height, r.hash, r.reward, feePct,
          parseFloat((r.reward * feePct / 100).toFixed(9)), r.status, iso(r.found_at)]),
        note);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Operator revenue statement, one row per UTC day (2026-10-05) — the export an accountant asks
  // for. fee-revenue.csv above is per BLOCK and multiplies by TODAY's fee %, so it is an estimate;
  // this one reads what was actually booked:
  //   income      pool_fee credits from block rewards + flat withdrawal fees (the ledger)
  //   diverted    fee cut moved to the prize pool (not the operator's)
  //   network     real chain fees the pool wallet paid on that day's payouts (withdrawals.fee,
  //               by confirm day — when the cost was INCURRED, not when it was booked)
  //   withdrawn   revenue sent to the operator's wallet that day (confirmed revenue withdrawals)
  // Ledger rows older than the rollup horizon live in balance_log_daily, which keeps the day and
  // reference_type, so the daily figures stay exact after pruning. Withdrawals are never pruned.
  router.get('/api/admin/export/operator-revenue.csv', secureAdmin, (req, res) => {
    try {
      if (!adminCsvGate(req, res)) return;
      const DAY = 86400;
      const H = getLedgerRollupHorizon(db);
      const byDay = new Map();
      const slot = (d) => {
        let s = byDay.get(d);
        if (!s) { s = { block: 0, wfee: 0, diverted: 0, network: 0, withdrawn: 0, n: 0 }; byDay.set(d, s); }
        return s;
      };
      const LED = (amt) => `
        COALESCE(SUM(CASE WHEN event_type='credit' AND reference_type='pool_fee'       THEN ${amt} END),0) AS block,
        COALESCE(SUM(CASE WHEN event_type='credit' AND reference_type='withdrawal_fee' THEN ${amt} END),0) AS wfee,
        COALESCE(SUM(CASE WHEN event_type='debit'  AND reference_type='fee_cut'        THEN ${amt} END),0) AS diverted`;
      const add = (r) => { const s = slot(r.d); s.block += r.block; s.wfee += r.wfee; s.diverted += r.diverted; };
      if (H > 0) {
        db.prepare(`SELECT day AS d, ${LED('total_amount')} FROM balance_log_daily
                    WHERE grin_address = 'pool_fee' AND day < ? GROUP BY day`).all(H).forEach(add);
      }
      db.prepare(`SELECT CAST(created_at / ${DAY} AS INTEGER) * ${DAY} AS d, ${LED('amount')} FROM balance_log
                  WHERE grin_address = 'pool_fee' AND created_at >= ? GROUP BY d`).all(H).forEach(add);
      db.prepare(`
        SELECT CAST(confirmed_at / ${DAY} AS INTEGER) * ${DAY} AS d,
               COALESCE(SUM(fee),0) AS network,
               COALESCE(SUM(CASE WHEN grin_address = 'pool_fee' THEN amount END),0) AS withdrawn,
               COUNT(CASE WHEN grin_address = 'pool_fee' THEN 1 END) AS n
        FROM withdrawals WHERE status = 'confirmed' AND confirmed_at IS NOT NULL GROUP BY d
      `).all().forEach((r) => { const s = slot(r.d); s.network += r.network; s.withdrawn += r.withdrawn; s.n += r.n; });
      const r9 = (v) => parseFloat((Number(v) || 0).toFixed(9));
      const rows = Array.from(byDay.entries()).sort((a, b) => b[0] - a[0]).map(([d, s]) => [
        new Date(d * 1000).toISOString().slice(0, 10),
        r9(s.block), r9(s.wfee), r9(s.diverted), r9(s.network),
        r9(s.block + s.wfee - s.diverted - s.network),
        r9(s.withdrawn), s.n,
      ]);
      sendCsv(res, `operator-revenue-${config.network}.csv`,
        ['day_utc', 'pool_fee_from_blocks_grin', 'withdrawal_fees_grin', 'diverted_to_prizes_grin',
         'network_fees_paid_grin', 'net_revenue_grin', 'withdrawn_to_operator_grin', 'operator_withdrawals'],
        rows);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── Payout request audit (money actions only) ──────────────────────────────────────────
  // The ownership-gated money surface, both ACCEPTED and DENIED, so the operator can see a
  // brute-force / spam run against the payout button rather than inferring it from nginx logs.
  // Sourced from the same admin_audit_log rows auditOwnerProof() writes (admin_id IS NULL).
  //
  // `ip` is the COARSENED network prefix (/24, /48) — see lib/owner-proof.js coarsenIp(). That
  // is deliberate and is enough for this view's purpose: repeated attempts from one origin still
  // group together. `geo` is the country resolved from the full IP at write time (details.geo).
  //
  // Bounded by BOTH the requested window and database.audit_log_keep_days — asking for 365 days
  // when retention is 180 cannot surface rows that were already pruned, so the response reports
  // the effective window and lets the UI say so instead of implying the gap means "no attempts".
  router.get('/api/admin/payments/audit', secureAdmin, (req, res) => {
    try {
      const reqDays = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 3650);
      const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 200, 1), 1000);
      const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
      const only = String(req.query.result || 'all').toLowerCase(); // all | deny | ok

      let keepDays = 180;
      try { keepDays = Math.max(30, parseInt(poolSettings.getSection('database').audit_log_keep_days, 10) || 180); }
      catch (e) { /* fall back to the documented default */ }
      const effDays = Math.min(reqDays, keepDays);
      const cutoff = Math.floor(Date.now() / 1000) - effDays * 86400;

      // Money actions only. A LIKE over the action prefix keeps this in step with owner-proof.js
      // without duplicating its action list here.
      // slatepack\_% = finalize + reshow (the S1 re-fetch moves no money, but it spends the same
      // proof check, so a guessing run against it belongs in this view too).
      const MONEY = "(a.action LIKE 'owner_proof:withdraw\\_%' ESCAPE '\\'" +
                    " OR a.action LIKE 'owner_proof:slatepack\\_%' ESCAPE '\\'" +
                    " OR a.action LIKE 'owner_proof:nostr\\_destination\\_%' ESCAPE '\\')";
      const resultClause = only === 'deny' ? " AND a.action LIKE '%:deny'"
                         : only === 'ok'   ? " AND a.action LIKE '%:ok'" : '';

      const rows = db.prepare(
        `SELECT a.id, a.action, a.target_id AS grin_address, a.details, a.ip, a.created_at
         FROM admin_audit_log a
         WHERE a.admin_id IS NULL AND ${MONEY} AND a.created_at >= ?${resultClause}
         ORDER BY a.id DESC LIMIT ? OFFSET ?`
      ).all(cutoff, limit, offset);

      const events = rows.map(r => {
        let d = {};
        try { d = r.details ? JSON.parse(r.details) : {}; } catch (_) { d = {}; }
        // 'owner_proof:withdraw_tor:deny' → rail 'withdraw_tor', outcome 'deny'
        const parts = String(r.action || '').split(':');
        const outcome = parts[parts.length - 1] === 'ok' ? 'ok' : 'deny';
        const { geo, ...rest } = d;
        return {
          id: r.id,
          at: r.created_at,
          action: parts.slice(1, -1).join(':') || r.action,
          outcome,
          grin_address: r.grin_address,
          ip_prefix: r.ip || null,
          country_code: geo || null,
          country: geo ? geoip.countryName(geo) : null,
          reason: rest.reason || null,
          amount: typeof rest.amount === 'number' ? rest.amount : null,
          withdrawal_id: rest.withdrawal_id || null,
        };
      });

      // Denial concentration over the SAME window — the signal that separates "a miner mistyped
      // their password twice" from "one origin is sweeping addresses". Computed in SQL over the
      // whole window, not over the returned page, so paging can't hide a burst.
      const topDenied = db.prepare(
        `SELECT a.ip AS ip_prefix, COUNT(*) AS denials,
                COUNT(DISTINCT a.target_id) AS addresses, MAX(a.created_at) AS last_at
         FROM admin_audit_log a
         WHERE a.admin_id IS NULL AND ${MONEY} AND a.created_at >= ?
           AND a.action LIKE '%:deny' AND a.ip IS NOT NULL
         GROUP BY a.ip HAVING denials > 1
         ORDER BY denials DESC, addresses DESC LIMIT 10`
      ).all(cutoff);

      const totals = db.prepare(
        `SELECT SUM(CASE WHEN a.action LIKE '%:ok' THEN 1 ELSE 0 END) AS ok,
                SUM(CASE WHEN a.action LIKE '%:deny' THEN 1 ELSE 0 END) AS deny,
                COUNT(DISTINCT a.ip) AS origins
         FROM admin_audit_log a
         WHERE a.admin_id IS NULL AND ${MONEY} AND a.created_at >= ?`
      ).get(cutoff);

      res.json({
        requested_days: reqDays,
        window_days: effDays,
        retention_days: keepDays,
        truncated_by_retention: reqDays > keepDays,
        geo_available: geoip.available(),
        totals: { ok: totals.ok || 0, deny: totals.deny || 0, origins: totals.origins || 0 },
        top_denied_origins: topDenied,
        count: events.length,
        events,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};
