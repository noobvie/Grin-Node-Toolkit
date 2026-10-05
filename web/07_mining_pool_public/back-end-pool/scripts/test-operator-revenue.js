// Operator revenue regression tests (2026-10-05) — the pool_fee bucket's way out, and the
// network-fee booking that makes its balance honest.
//
// Before this, the bucket grew by the full flat withdrawal fee on every payout while the pool
// wallet had already spent ~0.023 of it on the chain fee, and nothing ever debited that cost. So
// `pool_fee.balance` overstated what the operator owns by Σ fees, and reconciliation added the
// same Σ back to its coverage gaps — draining the bucket would have shorted miners with no alarm.
// It also had no exit at all: a raw `grin-wallet send` trips a coverage freeze.
//
// Runs the REAL WithdrawalScheduler and computeReconciliation against a throwaway SQLite file in
// the OS temp dir; only the wallet CLI / Owner API are stubbed (the process boundaries).
// Run: node scripts/test-operator-revenue.js
const path = require('path');
const fs = require('fs');
const os = require('os');

const APP = path.resolve(__dirname, '..');
const dbFile = path.join(os.tmpdir(), `pool-revenue-${Date.now()}.sqlite`);

const { initDb, getDb, createSchema, closeDb } = require(path.join(APP, 'lib/db.js'));
initDb(dbFile);
const db = getDb();
createSchema();

const WithdrawalScheduler = require(path.join(APP, 'lib/withdrawal-scheduler.js'));
const { computeReconciliation } = require(path.join(APP, 'lib/reconciliation.js'));
const PoolSettings = require(path.join(APP, 'lib/pool-settings.js'));
const { MIN_WITHDRAWAL_FEE } = require(path.join(APP, 'lib/config.js'));

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name} ${extra}`); }
};
const cleanup = () => {
  try { closeDb(); } catch (_) {}
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(dbFile + suffix); } catch (_) {}
  }
};
const near = (a, b) => Math.abs(Number(a) - Number(b)) < 1e-9;

const MINER = 'tgrin1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq';
const OPERATOR = 'tgrin1zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz';
const config = { network: 'testnet', withdrawal_fee: 0.04, min_withdrawal: 25, wallet_send_timeout_ms: 120000 };

let sends = [];
function newScheduler() {
  const s = new WithdrawalScheduler(config, { async getTransactions() { return []; } });
  s.walletTor = {
    async sendToTorAddress(address, amount) { sends.push({ address, amount }); return { success: true }; },
    async probeToronlineStatus() { return { online: true }; },
  };
  s.recordTorFee = async () => {};
  s.incentives = { maybePayJoinBonus() {} };
  return s;
}

// A ledger the integrity invariant agrees with: every balance below has a matching balance_log
// credit, exactly as rewards.js / the scheduler would have written it.
function credit(addr, amount, type) {
  db.prepare(`INSERT INTO miner_accounts (grin_address, balance) VALUES (?, 0)
              ON CONFLICT(grin_address) DO NOTHING`).run(addr);
  const b = db.prepare('SELECT balance FROM miner_accounts WHERE grin_address = ?').get(addr).balance;
  db.prepare('UPDATE miner_accounts SET balance = balance + ? WHERE grin_address = ?').run(amount, addr);
  db.prepare(`INSERT INTO balance_log (grin_address, event_type, amount, balance_before, balance_after,
              locked_before, locked_after, reference_type, reference_id)
              VALUES (?, 'credit', ?, ?, ?, 0, 0, ?, 0)`).run(addr, amount, b, b + amount, type);
}
// A miner payout that already confirmed: the scheduler's own confirm writes the split debit +
// the withdrawal_fee credit to pool_fee, and the wallet paid `fee` on chain.
function confirmedMinerPayout(amount, chainFee) {
  const s = newScheduler();
  const r = s.createWithdrawal(MINER, amount, 'tor');
  db.prepare("UPDATE withdrawals SET status = 'tor_sending', fee = ? WHERE id = ?").run(chainFee, r.withdrawal_id);
  s._creditConfirm(r.withdrawal_id, 'tor_sending', 'test');
  return r.withdrawal_id;
}
const poolFee = () => db.prepare("SELECT balance, balance_locked FROM miner_accounts WHERE grin_address = 'pool_fee'").get();

(async () => {
  try {
    // ═══ 1. The fee floor ═══
    console.log('\n[1] withdrawal_fee is never below MIN_WITHDRAWAL_FEE');
    const v = PoolSettings.validators.payout;
    ok('MIN_WITHDRAWAL_FEE is 0.04', MIN_WITHDRAWAL_FEE === 0.04);
    const throws = (fn) => { try { fn(); return false; } catch (_) { return true; } };
    ok('validator rejects 0 (the old "pool absorbs it")', throws(() => v.withdrawal_fee('0')));
    ok('validator rejects 0.03', throws(() => v.withdrawal_fee('0.03')));
    ok('validator rejects a non-number', throws(() => v.withdrawal_fee('abc')));
    ok('validator accepts 0.04', v.withdrawal_fee('0.04') === 0.04);
    ok('validator accepts 0.1', v.withdrawal_fee('0.1') === 0.1);
    ok('min_withdrawal below 1 GRIN is rejected (it must stay above the fee)', throws(() => v.min_withdrawal('0.5')));
    const all = (fee, minW) => ({ pool_info: {}, payout: { withdrawal_fee: fee, min_withdrawal: minW } });
    ok('applyToConfig raises a stored 0 to the floor (a pre-floor DB row never stops a pool)',
      PoolSettings.applyToConfig({}, all(0, 25)).withdrawal_fee === 0.04);
    ok('applyToConfig raises a stored 0.02 to the floor',
      PoolSettings.applyToConfig({}, all(0.02, 25)).withdrawal_fee === 0.04);
    ok('applyToConfig keeps a valid 0.06', PoolSettings.applyToConfig({}, all(0.06, 25)).withdrawal_fee === 0.06);
    ok('applyToConfig: fee >= min_withdrawal falls back to the floor, never to 0',
      PoolSettings.applyToConfig({}, all(30, 25)).withdrawal_fee === 0.04);

    // ═══ 2. Network fees are unbooked until the operator withdraws ═══
    console.log('\n[2] the bucket overstates revenue until network fees are booked');
    credit(MINER, 200, 'block');
    credit('pool_fee', 2, 'pool_fee');
    const w1 = confirmedMinerPayout(50, 0.023);
    const w2 = confirmedMinerPayout(60, 0.025);
    const s = newScheduler();
    let st = s.revenueStatus();
    ok('bucket = block fee + two flat fees (2 + 0.08)', near(st.balance, 2.08), JSON.stringify(st));
    ok('unbooked = the two REAL chain fees (0.048)', near(st.unbooked_network_fees, 0.048));
    ok('available = balance − unbooked (2.032)', near(st.available, 2.032));
    const wallet = { async getBalance() {
      // What the chain really holds: everything credited minus what left (net to miners + fees).
      const held = 202 - (50 - 0.04) - (60 - 0.04) - 0.048;
      return [true, { total: String(Math.round(held * 1e9)), amount_currently_spendable: String(Math.round(held * 1e9)), amount_locked: '0' }];
    } };
    let rc = await computeReconciliation(db, wallet, false);
    ok('reconciliation: integrity holds before booking', rc.checks.integrity_ok === true, String(rc.checks.integrity_drift));
    ok('reconciliation: coverage gap is 0 with the unbooked fees added back', near(rc.checks.coverage_full_gap, 0), String(rc.checks.coverage_full_gap));
    ok('reconciliation reports the unbooked fees', near(rc.checks.network_fees_unbooked, 0.048));

    // ═══ 3. Guards — nothing is booked when the withdrawal is refused ═══
    console.log('\n[3] a refused revenue withdrawal changes nothing');
    const refused = (fn) => { try { fn(); return null; } catch (e) { return e; } };
    let e = refused(() => s.createRevenueWithdrawal(1, null));
    ok('no address → 400', e && e.code === 400);
    e = refused(() => s.createRevenueWithdrawal(1, 'pool_fee'));
    ok('the bucket itself is not an address → 400', e && e.code === 400);
    e = refused(() => s.createRevenueWithdrawal(0, OPERATOR));
    ok('zero amount → 400', e && e.code === 400);
    e = refused(() => s.createRevenueWithdrawal(2.05, OPERATOR));
    ok('more than available (2.05 > 2.032) → 409', e && e.code === 409, e && e.message);
    ok('…and the 409 rolled the fee booking back (nothing booked, no network_fee row)',
      near(s.revenueStatus().unbooked_network_fees, 0.048) &&
      db.prepare("SELECT COUNT(*) AS c FROM balance_log WHERE reference_type = 'network_fee'").get().c === 0);
    db.prepare('INSERT INTO payout_control (id, frozen, reason) VALUES (1, 1, ?) ON CONFLICT(id) DO UPDATE SET frozen = 1').run('test');
    e = refused(() => s.createRevenueWithdrawal(1, OPERATOR));
    ok('frozen → 409', e && e.code === 409);
    db.prepare('UPDATE payout_control SET frozen = 0 WHERE id = 1').run();

    // ═══ 4. The withdrawal itself ═══
    console.log('\n[4] createRevenueWithdrawal books the fees, then locks what is left');
    const r = s.createRevenueWithdrawal(2, OPERATOR);
    ok('created', r.success && r.withdrawal_id > 0);
    ok('reports the fees it booked (0.048)', near(r.network_fees_booked, 0.048));
    const row = db.prepare('SELECT * FROM withdrawals WHERE id = ?').get(r.withdrawal_id);
    ok('row: grin_address is the bucket, dest_address the operator', row.grin_address === 'pool_fee' && row.dest_address === OPERATOR);
    ok('row: no flat fee on the operator\'s own withdrawal', row.fee_charged === 0);
    ok('both miner payouts are now fully booked',
      db.prepare('SELECT COUNT(*) AS c FROM withdrawals WHERE id IN (?, ?) AND fee_booked = fee').get(w1, w2).c === 2);
    const nf = db.prepare("SELECT amount, grin_address FROM balance_log WHERE reference_type = 'network_fee'").all();
    ok('one network_fee debit of 0.048 from pool_fee', nf.length === 1 && near(nf[0].amount, 0.048) && nf[0].grin_address === 'pool_fee');
    let pf = poolFee();
    ok('bucket: 2.08 − 0.048 − 2 locked = 0.032 spendable, 2 locked', near(pf.balance, 0.032) && near(pf.balance_locked, 2), JSON.stringify(pf));
    ok('journal names it an admin_revenue withdrawal',
      db.prepare("SELECT triggered_by FROM withdrawal_events WHERE withdrawal_id = ?").get(r.withdrawal_id).triggered_by === 'admin_revenue');
    e = refused(() => s.createRevenueWithdrawal(0.01, OPERATOR));
    ok('a second one while the first is in flight → 429', e && e.code === 429);
    st = s.revenueStatus();
    ok('revenueStatus shows the in-flight withdrawal', st.pending && st.pending.id === r.withdrawal_id);

    // ═══ 5. Sent to the operator, debited as operator revenue ═══
    console.log('\n[5] the send goes to dest_address and confirms as operator_withdrawal');
    sends = [];
    await s.sendWithdrawal(r.withdrawal_id);
    ok('sent exactly once', sends.length === 1);
    ok('…to the operator\'s address, never to "pool_fee"', sends[0] && sends[0].address === OPERATOR, JSON.stringify(sends));
    ok('…the full amount (no flat fee taken)', sends[0] && near(sends[0].amount, 2));
    ok('confirmed', db.prepare('SELECT status FROM withdrawals WHERE id = ?').get(r.withdrawal_id).status === 'confirmed');
    const deb = db.prepare("SELECT reference_type, amount FROM balance_log WHERE reference_id = ? AND event_type = 'debit'").all(r.withdrawal_id);
    ok('debit is operator_withdrawal (not withdrawal), and there is no withdrawal_fee row',
      deb.length === 1 && deb[0].reference_type === 'operator_withdrawal' && near(deb[0].amount, 2), JSON.stringify(deb));
    pf = poolFee();
    ok('bucket after: 0.032 spendable, nothing locked', near(pf.balance, 0.032) && near(pf.balance_locked, 0));

    // ═══ 6. Reconciliation after ═══
    console.log('\n[6] reconciliation reads the booked fees and the operator outflow');
    const wallet2 = { async getBalance() {
      const held = 202 - (50 - 0.04) - (60 - 0.04) - 0.048 - 2;
      return [true, { total: String(Math.round(held * 1e9)), amount_currently_spendable: String(Math.round(held * 1e9)), amount_locked: '0' }];
    } };
    rc = await computeReconciliation(db, wallet2, false);
    ok('integrity still holds', rc.checks.integrity_ok === true, String(rc.checks.integrity_drift));
    ok('nothing unbooked any more', near(rc.checks.network_fees_unbooked, 0));
    ok('coverage gap still exactly 0 (booked fees are NOT added back twice)', near(rc.checks.coverage_full_gap, 0), String(rc.checks.coverage_full_gap));
    const life = rc.flows.lifetime.out;
    ok('flows: operator withdrawal on its own line', near(life.operator_withdrawals, 2));
    ok('flows: "payouts" is still miners only (net 49.96 + 59.96)', near(life.payouts, 109.92), String(life.payouts));
    const fb = rc.ledger.buckets.pool_fee;
    ok('bucket detail: booked 0.048, withdrawn 2, available 0.032',
      near(fb.network_fees_booked, 0.048) && near(fb.operator_realized, 2) && near(fb.available, 0.032), JSON.stringify(fb));

    // ═══ 7. A later payout's fee is booked by the NEXT withdrawal only ═══
    console.log('\n[7] fees incurred after a withdrawal wait for the next one');
    confirmedMinerPayout(40, 0.02);
    st = s.revenueStatus();
    ok('new fee is unbooked (0.02); available = 0.072 − 0.02', near(st.unbooked_network_fees, 0.02) && near(st.available, 0.052), JSON.stringify(st));

    // ═══ 8. Review 2026-10-05: a ledger bucket is never a miner payout's address ═══
    console.log('\n[8] miner payout paths refuse pool_fee / prize_pool');
    credit('prize_pool', 30, 'topup');
    const countBefore = db.prepare('SELECT COUNT(*) AS c FROM withdrawals').get().c;
    for (const bucket of ['pool_fee', 'prize_pool']) {
      e = null; try { s.createWithdrawal(bucket, 0.01, 'tor', { adminOverride: true }); } catch (x) { e = x; }
      ok(`createWithdrawal(${bucket}) with adminOverride → 400`, e && e.code === 400, e && e.message);
      e = null; try { s.precheckWithdrawable(bucket, { adminOverride: true }); } catch (x) { e = x; }
      ok(`precheckWithdrawable(${bucket}) → 400`, e && e.code === 400, e && e.message);
      e = null; try { await s.createSlatepackWithdrawal(bucket, 1); } catch (x) { e = x; }
      ok(`createSlatepackWithdrawal(${bucket}) → 400`, e && e.code === 400, e && e.message);
      e = null; try { await s.createNostrWithdrawal(bucket, 1, 'a'.repeat(64), ''); } catch (x) { e = x; }
      ok(`createNostrWithdrawal(${bucket}) → 400`, e && e.code === 400, e && e.message);
    }
    ok('…and no row was written', db.prepare('SELECT COUNT(*) AS c FROM withdrawals').get().c === countBefore);

    // ═══ 9. Review 2026-10-05: the address-change alarm cannot be silenced during the hold ═══
    console.log('\n[9] address-change alert is locked for the 24 h hold');
    const AlertMonitor = require(path.join(APP, 'lib/alert-monitor.js'));
    const { REVENUE_ADDRESS_HOLD_S } = require(path.join(APP, 'lib/config.js'));
    const now = Math.floor(Date.now() / 1000);
    db.prepare(`INSERT INTO operator_revenue (id, address, set_at) VALUES (1, ?, ?)
                ON CONFLICT(id) DO UPDATE SET address = excluded.address, set_at = excluded.set_at`).run(OPERATOR, now);
    const aid = db.prepare(`INSERT INTO alerts (type, level, message, data, status, triggered_at, last_seen)
                            VALUES ('operator_revenue_address_changed', 'critical', 'changed', '{}', 'active', ?, ?)`)
      .run(new Date().toISOString(), new Date().toISOString()).lastInsertRowid;
    ok('closeLockedUntil = set_at + hold while the hold runs',
      AlertMonitor.closeLockedUntil(db, 'operator_revenue_address_changed') === now + REVENUE_ADDRESS_HOLD_S);
    ok('…and 0 for any other alert type', AlertMonitor.closeLockedUntil(db, 'slate_refunded_but_mined') === 0);
    let rm = AlertMonitor.resolveManual(db, aid, 1);
    ok('"It was me" during the hold → 409, alert still active',
      !rm.ok && rm.code === 409 && db.prepare('SELECT status FROM alerts WHERE id = ?').get(aid).status === 'active', JSON.stringify(rm));
    db.prepare('UPDATE operator_revenue SET set_at = ? WHERE id = 1').run(now - REVENUE_ADDRESS_HOLD_S - 1);
    ok('after the hold the lock is gone', AlertMonitor.closeLockedUntil(db, 'operator_revenue_address_changed') === 0);
    rm = AlertMonitor.resolveManual(db, aid, 1);
    ok('…and "It was me" closes it', rm.ok && db.prepare('SELECT status FROM alerts WHERE id = ?').get(aid).status === 'resolved', JSON.stringify(rm));
  } catch (err) {
    fail++;
    console.log(`  FAIL  harness threw: ${err.stack}`);
  } finally {
    cleanup();
    console.log(fail ? `\nFAILURES — ${pass} passed, ${fail} failed` : `\nALL PASS — ${pass} passed, 0 failed`);
    process.exit(fail ? 1 : 0);
  }
})();
