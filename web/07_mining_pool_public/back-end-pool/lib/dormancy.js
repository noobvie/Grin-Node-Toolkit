const { getDb } = require('./db');
const PoolSettings = require('./pool-settings');
const { RESERVED_ADDRESSES } = require('./incentives');

// Abandoned-balance disposition.
//
// Policy (operator-configurable, OFF by default, disclosed in the ToS + the payout-page banner):
// an address with NO activity — no accepted share AND no successful payout — for `dormancy_months`
// (default 24), still holding a balance, is considered abandoned. Its balance is swept and
// REDISTRIBUTED to miners active in the last `dormancy_active_window_days` (default 30), weighted
// by their recent sustained work (hashrate_history — the same durable "sustained work" source the
// lottery uses; the raw shares table prunes within ~a day so it can't back a 30-day window).
//
// Two invariants make this safe to bolt onto the custodial ledger:
//   1. Disposition is an INTERNAL transfer — Σ debited from sources == Σ credited to recipients
//      (remainder included), so reconciliation's integrity invariant nets to exactly zero and the
//      swept coins never leave the wallet. Fresh reference_types ('dormant_sweep' debit,
//      'dormant_payout' credit) keep it OUT of the external IN/OUT flow statement. It is NEVER
//      operator revenue.
//   2. Disposition is FINAL and only reachable after a long, GRANDFATHERED window: the clock counts
//      from max(last_activity, dormancy_policy_effective_at), and the first enabled run stamps that
//      anchor to "now" and disposes nobody — so every address gets a full window of runway after the
//      policy goes live. The owner can reclaim any time BEFORE disposition (the account page shows a
//      per-address countdown); after disposition there is nothing to reclaim.
//
// This module also records the operator's out-of-band manual payouts (the sub-threshold
// "email support, admin sends by Tor/slatepack" path): manualPayout() writes a confirmed
// withdrawals row (method='manual') + a 'withdrawal' debit so the money leaves the ledger through
// the SAME taxonomy as an automated payout — which is what keeps coverage correct AND stops the
// wallet-send audit (reconciliation.auditWalletSends) from flagging the operator's own send as an
// unrecorded/out-of-band transfer.

const MONTH_SECONDS = 2629800; // 30.4375 days — integer months × this
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // disposition is not time-critical; a no-op when idle
const r9 = (v) => parseFloat((Number(v) || 0).toFixed(9));
const floor9 = (v) => Math.floor((Number(v) || 0) * 1e9) / 1e9;
const flag = (v) => v === true || v === 'true';

// Mask a grin address for public display: enough for the real owner to recognise their own,
// not a clean targeting list. grin1qxy…mn4p
function maskAddress(addr) {
  const a = String(addr || '');
  if (a.length <= 14) return a;
  return a.slice(0, 9) + '…' + a.slice(-4);
}

class DormancyManager {
  constructor(config) {
    this.config = config || {};
    this.db = getDb();
    this.settings = new PoolSettings(this.db);
    this.timer = null;
    this.lastRun = null;
    this.lastResult = null;
  }

  // ── Config view ──────────────────────────────────────────────────────────────
  _cfg() {
    const s = this.settings.getSection('payout');
    return {
      enabled: flag(s.dormancy_enabled),
      months: Math.max(12, parseInt(s.dormancy_months, 10) || 24),
      windowDays: Math.max(1, parseInt(s.dormancy_active_window_days, 10) || 30),
      effectiveAt: Math.max(0, parseInt(s.dormancy_policy_effective_at, 10) || 0),
    };
  }

  isFrozen() {
    try {
      const row = this.db.prepare('SELECT frozen FROM payout_control WHERE id = 1').get();
      return !!(row && row.frozen);
    } catch (e) { return false; }
  }

  _reservedPlaceholders() {
    return RESERVED_ADDRESSES.map(() => '?').join(',');
  }

  // ── Candidate query ──────────────────────────────────────────────────────────
  // Every non-reserved, non-banned address holding a balance, with its durable last-activity
  // anchor. last_activity = latest of {last_seen_at (online tracking), account creation, last
  // successful payout}. Shares prune within ~a day so they are deliberately NOT used here — an
  // address that mines keeps last_seen_at fresh (miners.js), which is what we key off.
  _candidates() {
    const ph = this._reservedPlaceholders();
    return this.db.prepare(`
      SELECT ma.grin_address AS grin_address,
             ma.balance      AS balance,
             MAX(
               COALESCE(ma.last_seen_at, 0),
               ma.created_at,
               COALESCE(w.last_payout, 0)
             ) AS last_activity
      FROM miner_accounts ma
      LEFT JOIN (
        SELECT grin_address, MAX(confirmed_at) AS last_payout
        FROM withdrawals WHERE status = 'confirmed' GROUP BY grin_address
      ) w ON w.grin_address = ma.grin_address
      WHERE ma.balance > 0
        AND ma.is_banned = 0
        AND ma.grin_address NOT IN (${ph})
      ORDER BY last_activity ASC
    `).all(...RESERVED_ADDRESSES);
  }

  // Miners active in the redistribution window, weighted by recent sustained work. Excludes the
  // reserved buckets and any address in `excludeSet` (the sources being swept — inactive by
  // definition, but excluded explicitly so a source can never also receive).
  _activeRecipients(now, windowDays, excludeSet) {
    const ph = this._reservedPlaceholders();
    const rows = this.db.prepare(`
      SELECT hh.grin_address AS grin_address, SUM(hh.hashrate_gps) AS weight
      FROM hashrate_history hh
      JOIN miner_accounts ma ON ma.grin_address = hh.grin_address
      WHERE hh.recorded_at >= ?
        AND ma.is_banned = 0
        AND hh.grin_address NOT IN (${ph})
      GROUP BY hh.grin_address
      HAVING weight > 0
    `).all(now - windowDays * 86400, ...RESERVED_ADDRESSES);
    return rows.filter((r) => !excludeSet.has(r.grin_address) && Number(r.weight) > 0);
  }

  // ── Public / admin read: dormant countdown list ──────────────────────────────
  // idle-with-balance addresses approaching (or past) disposition. `mask` hides addresses for the
  // public transparency section; the admin panel passes mask=false. `limit` caps the row list;
  // totals always cover the full set.
  listDormant({ mask = true, limit = 100 } = {}) {
    const { enabled, months, windowDays, effectiveAt } = this._cfg();
    const now = Math.floor(Date.now() / 1000);
    const windowSecs = months * MONTH_SECONDS;
    const activeCutoff = now - windowDays * 86400; // "not currently active" boundary

    const rows = this._candidates();
    let totalCount = 0;
    let totalAmount = 0;
    let oldestActivity = null;
    const list = [];
    for (const row of rows) {
      // Only surface addresses that are clearly idle (past the active window). A fresh miner with a
      // balance is not "dormant".
      if (row.last_activity > activeCutoff) continue;
      totalCount += 1;
      totalAmount += Number(row.balance) || 0;
      if (oldestActivity === null || row.last_activity < oldestActivity) oldestActivity = row.last_activity;

      const effStart = Math.max(row.last_activity, effectiveAt);
      const disposeAt = (enabled && effectiveAt > 0) ? effStart + windowSecs : null;
      list.push({
        address: mask ? maskAddress(row.grin_address) : row.grin_address,
        balance: r9(row.balance),
        last_activity_at: row.last_activity,
        idle_days: Math.floor((now - row.last_activity) / 86400),
        dispose_at: disposeAt,
        days_until_disposal: disposeAt !== null ? Math.ceil((disposeAt - now) / 86400) : null,
        eligible: disposeAt !== null ? disposeAt <= now : false,
      });
    }

    return {
      enabled,
      dormancy_months: months,
      active_window_days: windowDays,
      policy_effective_at: effectiveAt || null,
      totals: {
        count: totalCount,
        amount: r9(totalAmount),
        oldest_activity_at: oldestActivity,
      },
      list: list.slice(0, Math.max(1, limit)),
    };
  }

  // Per-address state for the account-page countdown. Returns disposed history if the address was
  // ever swept, else its live countdown (or 'active'/'disabled').
  statusFor(grinAddress) {
    const addr = String(grinAddress || '').trim();
    if (!addr) return { state: 'unknown' };
    if (RESERVED_ADDRESSES.includes(addr)) return { state: 'reserved' };

    const { enabled, months, windowDays, effectiveAt } = this._cfg();
    const now = Math.floor(Date.now() / 1000);

    // Was it ever disposed? (most recent disposition of this address)
    const disp = this.db.prepare(`
      SELECT s.amount AS amount, s.created_at AS disposed_at, s.disposition_id AS disposition_id
      FROM dormancy_disposed_sources s
      WHERE s.grin_address = ? ORDER BY s.created_at DESC LIMIT 1
    `).get(addr);

    const acct = this.db.prepare(
      'SELECT balance, last_seen_at, created_at, is_banned FROM miner_accounts WHERE grin_address = ?'
    ).get(addr);

    // A disposed address with no NEW balance since is terminal (final policy).
    if (disp && (!acct || (Number(acct.balance) || 0) <= 0)) {
      return {
        state: 'disposed',
        disposed_at: disp.disposed_at,
        disposed_amount: r9(disp.amount),
        disposition_id: disp.disposition_id,
      };
    }
    if (!acct) return { state: 'unknown' };

    const balance = Number(acct.balance) || 0;
    const payout = this.db.prepare(
      "SELECT MAX(confirmed_at) AS t FROM withdrawals WHERE grin_address = ? AND status = 'confirmed'"
    ).get(addr);
    const lastActivity = Math.max(
      Number(acct.last_seen_at) || 0, Number(acct.created_at) || 0, Number(payout && payout.t) || 0
    );

    if (balance <= 0) return { state: 'no_balance', last_activity_at: lastActivity };
    if (now - lastActivity <= windowDays * 86400) return { state: 'active', last_activity_at: lastActivity, balance: r9(balance) };
    if (!enabled || effectiveAt <= 0) {
      return { state: 'idle', last_activity_at: lastActivity, balance: r9(balance) };
    }
    const disposeAt = Math.max(lastActivity, effectiveAt) + months * MONTH_SECONDS;
    return {
      state: disposeAt <= now ? 'eligible' : 'counting',
      last_activity_at: lastActivity,
      balance: r9(balance),
      dispose_at: disposeAt,
      days_until_disposal: Math.ceil((disposeAt - now) / 86400),
      dormancy_months: months,
    };
  }

  // ── Disposition history (public U-03 ledger + admin) ─────────────────────────
  history({ limit = 50 } = {}) {
    const batches = this.db.prepare(`
      SELECT id, total_swept, remainder, source_count, recipient_count,
             dormancy_months, active_window_days, triggered_by, created_at
      FROM dormancy_dispositions ORDER BY created_at DESC LIMIT ?
    `).all(Math.max(1, Math.min(500, limit)));
    const totals = this.db.prepare(`
      SELECT COALESCE(SUM(total_swept),0) AS swept, COUNT(*) AS batches,
             COALESCE(SUM(source_count),0) AS sources, COALESCE(SUM(recipient_count),0) AS recipients
      FROM dormancy_dispositions
    `).get();
    return {
      totals: {
        total_disposed: r9(totals.swept),
        batches: totals.batches,
        sources: totals.sources,
        recipients: totals.recipients,
      },
      batches: batches.map((b) => ({
        id: b.id,
        total_swept: r9(b.total_swept),
        remainder: r9(b.remainder),
        source_count: b.source_count,
        recipient_count: b.recipient_count,
        dormancy_months: b.dormancy_months,
        active_window_days: b.active_window_days,
        automatic: b.triggered_by === null,
        created_at: b.created_at,
      })),
    };
  }

  // ── Dry run: what a disposition NOW would sweep/redistribute (no mutation) ────
  preview() {
    const { enabled, months, windowDays, effectiveAt } = this._cfg();
    const now = Math.floor(Date.now() / 1000);
    const idleCutoff = now - months * MONTH_SECONDS;
    const sources = (effectiveAt > 0)
      ? this._candidates().filter((r) => Math.max(r.last_activity, effectiveAt) <= idleCutoff)
      : [];
    const excludeSet = new Set(sources.map((s) => s.grin_address));
    const recipients = sources.length ? this._activeRecipients(now, windowDays, excludeSet) : [];
    const totalSwept = r9(sources.reduce((a, s) => a + (Number(s.balance) || 0), 0));
    return {
      enabled,
      frozen: this.isFrozen(),
      policy_effective_at: effectiveAt || null,
      dormancy_months: months,
      active_window_days: windowDays,
      would_sweep: { count: sources.length, amount: totalSwept },
      would_credit: { recipients: recipients.length },
      blocked: !enabled ? 'disabled'
        : this.isFrozen() ? 'payouts_frozen'
        : effectiveAt <= 0 ? 'awaiting_effective_anchor'
        : sources.length === 0 ? 'no_eligible_sources'
        : recipients.length === 0 ? 'no_active_recipients'
        : null,
    };
  }

  // ── The disposition pass ─────────────────────────────────────────────────────
  // Freeze-aware, grandfathered, atomic. `triggeredBy` = admin user id for a manual run, null for
  // the scheduled pass (recorded as `automatic` on the batch).
  runOnce({ triggeredBy = null } = {}) {
    const now = Math.floor(Date.now() / 1000);
    const { enabled, months, windowDays, effectiveAt } = this._cfg();
    const result = { ran_at: now, enabled, disposed: false, swept: 0, sources: 0, recipients: 0, skipped: null };

    if (!enabled) { result.skipped = 'disabled'; this._remember(result); return result; }
    if (this.isFrozen()) { result.skipped = 'payouts_frozen'; this._remember(result); return result; }

    // Grandfather anchor: first enabled run stamps "now" and disposes nobody, so every address
    // gets a full window of runway from the moment the policy goes live.
    if (effectiveAt <= 0) {
      try { this.settings.updateSection('payout', { dormancy_policy_effective_at: now }, null); }
      catch (e) { console.error(`[dormancy] failed to stamp effective anchor: ${e.message}`); }
      result.skipped = 'effective_anchor_initialised';
      this._remember(result);
      return result;
    }

    const idleCutoff = now - months * MONTH_SECONDS;
    const sources = this._candidates().filter((r) => Math.max(r.last_activity, effectiveAt) <= idleCutoff);
    if (sources.length === 0) { result.skipped = 'no_eligible_sources'; this._remember(result); return result; }

    const totalSwept = r9(sources.reduce((a, s) => a + (Number(s.balance) || 0), 0));
    if (!(totalSwept > 0)) { result.skipped = 'nothing_to_sweep'; this._remember(result); return result; }

    const excludeSet = new Set(sources.map((s) => s.grin_address));
    const recipients = this._activeRecipients(now, windowDays, excludeSet);
    // Never sweep into the void: with no active miners to receive, DEFER — the balances stay put
    // and reclaimable until there's someone to redistribute to.
    if (recipients.length === 0) { result.skipped = 'no_active_recipients'; this._remember(result); return result; }

    // Split totalSwept across recipients by weight; floor each to the nanogrin, then hand the
    // rounding remainder to the largest-weight recipient so Σcredited == totalSwept exactly.
    const totalWeight = recipients.reduce((a, r) => a + Number(r.weight), 0);
    let topIdx = 0;
    for (let i = 1; i < recipients.length; i++) if (Number(recipients[i].weight) > Number(recipients[topIdx].weight)) topIdx = i;
    const credited = recipients.map((r) => floor9(totalSwept * (Number(r.weight) / totalWeight)));
    let sumCredited = r9(credited.reduce((a, v) => a + v, 0));
    const remainder = r9(totalSwept - sumCredited);
    credited[topIdx] = r9(credited[topIdx] + remainder);

    const insBatch = this.db.prepare(`
      INSERT INTO dormancy_dispositions
        (total_swept, remainder, source_count, recipient_count, dormancy_months, active_window_days, triggered_by)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const insSource = this.db.prepare(`
      INSERT INTO dormancy_disposed_sources (disposition_id, grin_address, amount, last_activity_at)
      VALUES (?, ?, ?, ?)
    `);
    const debit = this.db.prepare('UPDATE miner_accounts SET balance = balance - ?, updated_at = unixepoch() WHERE grin_address = ?');
    const credit = this.db.prepare('UPDATE miner_accounts SET balance = balance + ?, updated_at = unixepoch() WHERE grin_address = ?');
    const logRow = this.db.prepare(`
      INSERT INTO balance_log
        (grin_address, event_type, amount, balance_before, balance_after, locked_before, locked_after, reference_type, reference_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const readBal = this.db.prepare('SELECT balance, balance_locked FROM miner_accounts WHERE grin_address = ?');

    const tx = this.db.transaction(() => {
      const info = insBatch.run(totalSwept, remainder, sources.length, recipients.length, months, windowDays, triggeredBy);
      const batchId = Number(info.lastInsertRowid);

      for (const src of sources) {
        const cur = readBal.get(src.grin_address);
        const before = Number(cur.balance) || 0;
        const locked = Number(cur.balance_locked) || 0;
        debit.run(before, src.grin_address); // debit the exact current balance → 0
        logRow.run(src.grin_address, 'debit', r9(before), r9(before), 0, r9(locked), r9(locked), 'dormant_sweep', batchId);
        insSource.run(batchId, src.grin_address, r9(before), src.last_activity);
      }
      for (let i = 0; i < recipients.length; i++) {
        const amt = credited[i];
        if (!(amt > 0)) continue;
        const addr = recipients[i].grin_address;
        const cur = readBal.get(addr);
        const before = Number(cur.balance) || 0;
        const locked = Number(cur.balance_locked) || 0;
        credit.run(amt, addr);
        logRow.run(addr, 'credit', amt, r9(before), r9(before + amt), r9(locked), r9(locked), 'dormant_payout', batchId);
      }

      this._audit(triggeredBy, batchId, { total_swept: totalSwept, sources: sources.length, recipients: recipients.length, remainder });
      return batchId;
    });

    let batchId;
    try {
      batchId = tx();
    } catch (e) {
      console.error(`[dormancy] disposition failed: ${e.message}`);
      result.skipped = 'error';
      result.error = e.message;
      this._remember(result);
      return result;
    }

    result.disposed = true;
    result.disposition_id = batchId;
    result.swept = totalSwept;
    result.sources = sources.length;
    result.recipients = recipients.length;
    result.remainder = remainder;
    console.warn(`[dormancy] disposed ${totalSwept} GRIN from ${sources.length} abandoned address(es) → ${recipients.length} active miner(s) (batch ${batchId})`);
    this._remember(result);
    return result;
  }

  // ── Manual out-of-band payout recorder (sub-threshold email flow) ────────────
  // The admin has ALREADY sent the coins by Tor/slatepack at the OS level after verifying the
  // owner. This records that spend through the same taxonomy as an automated payout: a confirmed
  // withdrawals row (method='manual') + a 'withdrawal' debit. That keeps coverage correct AND lets
  // the wallet-send audit match the operator's send instead of flagging it as unrecorded.
  // Returns { ok, withdrawal_id, balance_after } or { ok:false, reason }.
  manualPayout({ grinAddress, amount, fee = 0, kernelExcess = null, slateId = null, note = null, adminId = null, allowAboveMin = false }) {
    const addr = String(grinAddress || '').trim();
    const amt = r9(amount);
    const netFee = r9(fee);
    if (!addr) return { ok: false, reason: 'address_required' };
    if (RESERVED_ADDRESSES.includes(addr)) return { ok: false, reason: 'reserved_address' };
    if (!(amt > 0)) return { ok: false, reason: 'amount_must_be_positive' };
    if (netFee < 0) return { ok: false, reason: 'fee_negative' };

    // Self-check the freeze (finding #3): the endpoint already gates on it, but guarding here too
    // means any caller inherits it — recording a payout while payouts are frozen is never right.
    if (this.isFrozen()) return { ok: false, reason: 'payouts_frozen' };

    // At/above-minimum guard (finding #2). The recorder is for a send you ALREADY made out-of-band;
    // if the amount is ≥ the pool minimum and payouts aren't frozen, the auto-payout scheduler could
    // ALSO pay this balance in the gap → double-pay. Force an explicit ack (the caller re-submits
    // with allowAboveMin) so an at-threshold record is a conscious choice, and steer to the Tor path.
    const minW = Number(this.config && this.config.min_withdrawal)
      || Number((this.settings.getSection('payout') || {}).min_withdrawal) || 25;
    if (!allowAboveMin && amt >= minW - 1e-9) {
      return { ok: false, reason: 'above_min_needs_ack', min: r9(minW) };
    }

    const acct = this.db.prepare('SELECT balance, balance_locked FROM miner_accounts WHERE grin_address = ?').get(addr);
    if (!acct) return { ok: false, reason: 'account_not_found' };
    const before = Number(acct.balance) || 0;
    const locked = Number(acct.balance_locked) || 0;
    if (amt > r9(before) + 1e-9) return { ok: false, reason: 'amount_exceeds_balance', balance: r9(before) };

    const now = Math.floor(Date.now() / 1000);

    // Double-submit / double-record guard (finding #1). A resubmit (double-click, slow-response
    // retry) would otherwise write a second confirmed withdrawal + debit for one real send —
    // over-debiting the miner AND making the wallet-send audit see an unmatched payout. A given
    // kernel/slate is a real on-chain identifier and can only be recorded once; and an identical
    // (address, amount) manual record inside a short window is treated as the same click.
    if (kernelExcess) {
      const dupK = this.db.prepare("SELECT id FROM withdrawals WHERE kernel_excess = ? LIMIT 1").get(kernelExcess);
      if (dupK) return { ok: false, reason: 'duplicate_kernel', withdrawal_id: dupK.id };
    }
    if (slateId) {
      const dupS = this.db.prepare("SELECT id FROM withdrawals WHERE slate_id = ? LIMIT 1").get(slateId);
      if (dupS) return { ok: false, reason: 'duplicate_slate', withdrawal_id: dupS.id };
    }
    const dupRecent = this.db.prepare(
      "SELECT id FROM withdrawals WHERE grin_address = ? AND method = 'manual' AND amount = ? AND created_at >= ? LIMIT 1"
    ).get(addr, amt, now - 60);
    if (dupRecent) return { ok: false, reason: 'duplicate_recent', withdrawal_id: dupRecent.id };
    const insWithdrawal = this.db.prepare(`
      INSERT INTO withdrawals (grin_address, amount, fee, status, method, slate_id, kernel_excess, created_at, confirmed_at)
      VALUES (?, ?, ?, 'confirmed', 'manual', ?, ?, ?, ?)
    `);
    const debit = this.db.prepare('UPDATE miner_accounts SET balance = balance - ?, updated_at = unixepoch() WHERE grin_address = ?');
    const logRow = this.db.prepare(`
      INSERT INTO balance_log
        (grin_address, event_type, amount, balance_before, balance_after, locked_before, locked_after, reference_type, reference_id)
      VALUES (?, 'debit', ?, ?, ?, ?, ?, 'withdrawal', ?)
    `);
    const insEvent = this.db.prepare(`
      INSERT INTO withdrawal_events (withdrawal_id, from_status, to_status, triggered_by, actor_id, note)
      VALUES (?, NULL, 'confirmed', 'admin_manual', ?, ?)
    `);

    let wid;
    try {
      const tx = this.db.transaction(() => {
        const info = insWithdrawal.run(addr, amt, netFee, slateId || null, kernelExcess || null, now, now);
        const id = Number(info.lastInsertRowid);
        debit.run(amt, addr);
        logRow.run(addr, amt, r9(before), r9(before - amt), r9(locked), r9(locked), id);
        insEvent.run(id, adminId, note ? String(note).slice(0, 500) : 'manual out-of-band payout');
        return id;
      });
      wid = tx();
    } catch (e) {
      console.error(`[dormancy] manualPayout failed for ${addr}: ${e.message}`);
      return { ok: false, reason: 'db_error', error: e.message };
    }

    this._auditManual(adminId, addr, { withdrawal_id: wid, amount: amt, fee: netFee });
    return { ok: true, withdrawal_id: wid, balance_after: r9(before - amt) };
  }

  // ── Audit helpers (best-effort; never throw into the caller) ─────────────────
  _audit(adminId, batchId, details) {
    try {
      this.db.prepare(`
        INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, details)
        VALUES (?, 'dormancy_disposition', 'dormancy', ?, ?)
      `).run(adminId, String(batchId), JSON.stringify(details || {}));
    } catch (e) { /* audit is best-effort */ }
  }

  _auditManual(adminId, addr, details) {
    try {
      this.db.prepare(`
        INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, details)
        VALUES (?, 'manual_payout', 'miner', ?, ?)
      `).run(adminId, addr, JSON.stringify(details || {}));
    } catch (e) { /* best-effort */ }
  }

  _remember(result) { this.lastRun = result.ran_at; this.lastResult = result; }

  status() {
    const { enabled, months, windowDays, effectiveAt } = this._cfg();
    return {
      enabled,
      dormancy_months: months,
      active_window_days: windowDays,
      policy_effective_at: effectiveAt || null,
      last_run: this.lastRun,
      last_result: this.lastResult,
    };
  }

  // ── Scheduler ────────────────────────────────────────────────────────────────
  start() {
    if (this.timer) return;
    // First pass a minute after boot (lets the DB/settings settle), then every 6h. Each pass is a
    // no-op when disabled / frozen / nothing eligible.
    setTimeout(() => { try { this.runOnce(); } catch (e) { console.error(`[dormancy] ${e.message}`); } }, 60 * 1000);
    this.timer = setInterval(() => {
      try { this.runOnce(); } catch (e) { console.error(`[dormancy] ${e.message}`); }
    }, CHECK_INTERVAL_MS);
    if (this.timer.unref) this.timer.unref();
  }

  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }
}

module.exports = DormancyManager;
module.exports.maskAddress = maskAddress;
