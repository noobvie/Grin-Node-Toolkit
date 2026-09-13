// Payout-guard regression tests — the Tor rail's double-send guard and its recovery sweep.
//
// Guards audit §H1, §J4-1, §J4-2, §J4-3 and §J4-10. Every one of these decides whether real
// GRIN leaves the wallet a second time, or whether a miner's locked balance is ever released,
// so each gets an executable test rather than a comment. §J17 found that the §J4 pass verified
// all of this with scratchpad harnesses that were never committed — this file is that gap.
//
// Runs the REAL WithdrawalScheduler against a throwaway SQLite file in the OS temp dir; only
// the wallet (Owner API), walletTor (CLI) and the Tor pre-flight probe are stubbed, because
// those are the process boundaries. Never touches the pool DB.
// Run: node scripts/test-payout-guard.js
const path = require('path');
const fs = require('fs');
const os = require('os');

const APP = path.resolve(__dirname, '..');
const dbFile = path.join(os.tmpdir(), `pool-guard-${Date.now()}.sqlite`);

const { initDb, getDb, createSchema, closeDb } = require(path.join(APP, 'lib/db.js'));
initDb(dbFile);
const db = getDb();
createSchema();

const WithdrawalScheduler = require(path.join(APP, 'lib/withdrawal-scheduler.js'));

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

const ADDR = 'tgrin1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq';
const config = { network: 'testnet', withdrawal_fee: 0.04, wallet_send_timeout_ms: 120000 };

// ─── Harness ─────────────────────────────────────────────────────────────────
// walletTor.sendToTorAddress is counted, never executed: a test that lets a send "succeed"
// proves nothing about a guard whose entire job is to stop the send happening.
//
// `timeline` records wallet reads and sends IN ORDER, because "did the guard run" is a question
// about ordering, not about a count: sendWithdrawal also reads the tx log AFTER a successful
// send (_captureTorSlateId, for proof metadata), so a bare call counter says "consulted" on the
// clean first-attempt path too and proves nothing.
let sends = [];
let timeline = [];
function newScheduler(txLog, { walletReadable = true } = {}) {
  const s = new WithdrawalScheduler(config, {
    async getTransactions() {
      timeline.push('wallet');
      if (!walletReadable) throw new Error('owner API down');
      return txLog;
    },
  });
  s.walletTor = {
    async sendToTorAddress(address, amount) {
      timeline.push('send');
      sends.push({ address, amount });
      return { success: true };
    },
    async checkTorReachable() { return { online: true }; },
  };
  // recordTorFee asks the wallet CLI for the real network fee; irrelevant here and it would
  // reach for a binary that does not exist on this machine.
  s.recordTorFee = async () => {};
  s.incentives = { maybePayJoinBonus() {} };
  return s;
}

const seedAccount = () => {
  db.prepare(
    `INSERT INTO miner_accounts (grin_address, balance, balance_locked)
     VALUES (?, 0, 0)
     ON CONFLICT(grin_address) DO UPDATE SET balance = 0, balance_locked = 0`
  ).run(ADDR);
};

// A withdrawal mid-attempt: locked balance, and (unless told otherwise) a prior tor_sending
// event so the guard is armed exactly as a real retry arms it (§J4-2 — the trigger is the
// event log, not retry_count, because the admin Retry button zeroes retry_count).
let seq = 0;
function seedWithdrawal({ status = 'tor_sending', amount = 100, slate = null, retries = 1, priorAttempt = true } = {}) {
  seedAccount();
  db.prepare(
    'UPDATE miner_accounts SET balance_locked = balance_locked + ? WHERE grin_address = ?'
  ).run(amount, ADDR);
  const created = Math.floor(Date.now() / 1000) - 3600;
  const info = db.prepare(
    `INSERT INTO withdrawals (grin_address, amount, fee_charged, status, method, slate_id, retry_count, created_at)
     VALUES (?, ?, 0.04, ?, 'tor', ?, ?, ?)`
  ).run(ADDR, amount, status, slate, retries, created);
  const id = info.lastInsertRowid;
  if (priorAttempt) {
    // Backdated well past torSendingStaleSeconds so the sweep sees it as abandoned.
    db.prepare(
      `INSERT INTO withdrawal_events (withdrawal_id, from_status, to_status, triggered_by, created_at)
       VALUES (?, 'tor_checking', 'tor_sending', 'scheduler', ?)`
    ).run(id, created);
  }
  seq++;
  return id;
}

// The sweep selects EVERY stale tor_sending row, so rows left behind by an earlier case would
// be re-resolved inside the next one — harmless for the assertions (they name an id) but it
// makes the output unreadable and lets one case's fixture change another's state. Each sweep
// case starts from an empty ledger instead.
const reset = () => {
  db.exec('DELETE FROM withdrawal_events; DELETE FROM withdrawals; DELETE FROM balance_log;');
  db.prepare('UPDATE miner_accounts SET balance = 0, balance_locked = 0 WHERE grin_address = ?').run(ADDR);
};

const rowOf = (id) => db.prepare('SELECT * FROM withdrawals WHERE id = ?').get(id);
const acct = () => db.prepare('SELECT balance, balance_locked FROM miner_accounts WHERE grin_address = ?').get(ADDR);

// A wallet tx-log entry. amount_debited − amount_credited − fee is the net to the recipient,
// which is what the amount branch matches on.
const tx = ({ slate, net = 99.96, confirmed = false, type = 'TxSent', when = Date.now() / 1000 }) => ({
  tx_slate_id: slate,
  tx_type: type,
  confirmed,
  creation_ts: new Date(when * 1000).toISOString(),
  amount_debited: String(Math.round(net * 1e9)),
  amount_credited: '0',
  fee: '0',
});

// ═══ 1. _priorSendLanded returns THREE states (§J4-10) ═══════════════════════
console.log('\n[1] §J4-10 — the matcher has three outcomes, not two');
(async () => {
  {
    const id = seedWithdrawal({ slate: 'S-CONF' });
    const s = newScheduler([tx({ slate: 'S-CONF', confirmed: true })]);
    const r = await s._priorSendLanded(rowOf(id), 99.96);
    ok('slate branch: a CONFIRMED TxSent → outcome "confirmed"', r.checked && r.outcome === 'confirmed', JSON.stringify(r));
  }
  {
    const id = seedWithdrawal({ slate: 'S-UNCONF' });
    const s = newScheduler([tx({ slate: 'S-UNCONF', confirmed: false })]);
    const r = await s._priorSendLanded(rowOf(id), 99.96);
    ok('slate branch: an UNCONFIRMED TxSent → outcome "unconfirmed", NOT confirmed',
      r.checked && r.outcome === 'unconfirmed', JSON.stringify(r));
  }
  {
    const id = seedWithdrawal({ slate: 'S-GONE' });
    const s = newScheduler([tx({ slate: 'SOMETHING-ELSE', confirmed: true })]);
    const r = await s._priorSendLanded(rowOf(id), 99.96);
    ok('slate branch: absent from the wallet → outcome "absent"', r.checked && r.outcome === 'absent', JSON.stringify(r));
  }
  {
    const id = seedWithdrawal({ slate: 'S-CANC' });
    const s = newScheduler([tx({ slate: 'S-CANC', type: 'TxSentCancelled', confirmed: false })]);
    const r = await s._priorSendLanded(rowOf(id), 99.96);
    ok('slate branch: TxSentCancelled → "absent" (a cancelled tx never reached the chain)',
      r.checked && r.outcome === 'absent', JSON.stringify(r));
  }
  {
    // The §J4-1 premise, stated as a test: a bare TxSent is written at tx_lock_outputs and is
    // NOT evidence of a broadcast. Before §J4-10 this exact input returned "it landed".
    const id = seedWithdrawal({ slate: null });
    const s = newScheduler([tx({ slate: 'AMT-1', confirmed: false })]);
    const r = await s._priorSendLanded(rowOf(id), 99.96);
    ok('amount branch: an unconfirmed same-amount send is "unconfirmed", not proof of a send',
      r.checked && r.outcome === 'unconfirmed', JSON.stringify(r));
  }
  {
    const id = seedWithdrawal({ slate: null });
    const s = newScheduler([tx({ slate: 'AMT-2', confirmed: true })]);
    const r = await s._priorSendLanded(rowOf(id), 99.96);
    ok('amount branch: a confirmed same-amount send is "confirmed"', r.checked && r.outcome === 'confirmed');
  }
  {
    // Two candidates, one confirmed. Reporting the unconfirmed one would park a settled payout.
    const id = seedWithdrawal({ slate: null });
    const s = newScheduler([tx({ slate: 'A', confirmed: false }), tx({ slate: 'B', confirmed: true })]);
    const r = await s._priorSendLanded(rowOf(id), 99.96);
    ok('amount branch: a CONFIRMED match wins over an unconfirmed sibling',
      r.outcome === 'confirmed' && r.tx.tx_slate_id === 'B', JSON.stringify(r));
  }
  {
    const id = seedWithdrawal({ slate: null });
    const s = newScheduler([tx({ slate: 'OLD', confirmed: true, when: Date.now() / 1000 - 86400 * 30 })]);
    const r = await s._priorSendLanded(rowOf(id), 99.96);
    ok('amount branch: §J4-4 age bound survives — a month-old send is not this payout',
      r.outcome === 'absent', JSON.stringify(r));
  }
  {
    const id = seedWithdrawal({ slate: 'S-X' });
    const s = newScheduler([], { walletReadable: false });
    const r = await s._priorSendLanded(rowOf(id), 99.96);
    ok('wallet unreadable → checked=false, and that is NOT the same as "unconfirmed"',
      r.checked === false && r.outcome === 'unknown', JSON.stringify(r));
  }

  // ═══ 2. sendWithdrawal acts differently on each of the three ════════════════
  console.log('\n[2] §J4-10 — sendWithdrawal: confirm / defer / send');
  {
    sends = [];
    reset();
    const id = seedWithdrawal({ status: 'tor_checking', slate: 'W-CONF' });
    const s = newScheduler([tx({ slate: 'W-CONF', confirmed: true })]);
    await s.sendWithdrawal(id);
    const r = rowOf(id);
    ok('confirmed → the payout is confirmed', r.status === 'confirmed', r.status);
    ok('confirmed → NOTHING was sent', sends.length === 0, `${sends.length} sends`);
    ok('confirmed → the locked balance is released, not refunded', acct().balance_locked === 0, JSON.stringify(acct()));
  }
  {
    sends = [];
    reset();
    const id = seedWithdrawal({ status: 'tor_checking', slate: 'W-UNCONF', retries: 2 });
    const before = rowOf(id).retry_count;
    const s = newScheduler([tx({ slate: 'W-UNCONF', confirmed: false })]);
    await s.sendWithdrawal(id);
    const r = rowOf(id);
    ok('unconfirmed → DEFERRED, not sent', sends.length === 0, `${sends.length} sends`);
    ok('unconfirmed → parked on the retry ladder', r.status === 'retry_scheduled', r.status);
    ok('unconfirmed → the deferral does NOT consume a retry rung', r.retry_count === before,
      `${before} → ${r.retry_count}`);
    ok('unconfirmed → the balance stays LOCKED (no refund, no debit)',
      acct().balance_locked > 0 && acct().balance === 0, JSON.stringify(acct()));
    ok('unconfirmed → an audit event records why', !!db.prepare(
      "SELECT 1 FROM withdrawal_events WHERE withdrawal_id = ? AND note LIKE 'deferred:%'").get(id));
  }
  {
    sends = [];
    reset();
    const id = seedWithdrawal({ status: 'tor_checking', slate: 'W-ABSENT' });
    const s = newScheduler([]);
    await s.sendWithdrawal(id);
    ok('absent → the send proceeds', sends.length === 1, `${sends.length} sends`);
    ok('absent → and it settles', rowOf(id).status === 'confirmed', rowOf(id).status);
  }
  {
    // §J4-2's regression: a FIRST attempt has no prior event, no retry_count and no slate, so
    // the guard must not run at all — the normal path pays no extra wallet round-trip BEFORE
    // the send. (It reads the log after, for _captureTorSlateId's proof link, which is why this
    // asserts on ORDER: the first thing that happens must be the send itself.)
    sends = []; timeline = [];
    reset();
    const id = seedWithdrawal({ status: 'tor_checking', retries: 0, priorAttempt: false });
    await newScheduler([]).sendWithdrawal(id);
    ok('§J4-2 — a first attempt sends without consulting the wallet log first',
      sends.length === 1 && timeline[0] === 'send', `sends=${sends.length} timeline=${timeline.join(',')}`);
  }
  {
    // …and the arming itself: retry_count 0 but a prior tor_sending event (exactly what the
    // admin Retry button leaves behind) must still arm the guard.
    sends = [];
    reset();
    const id = seedWithdrawal({ status: 'tor_checking', retries: 0, slate: null, priorAttempt: true });
    const s = newScheduler([tx({ slate: 'RETRY-1', confirmed: true })]);
    await s.sendWithdrawal(id);
    ok('§J4-2 — retry_count=0 with a prior attempt still arms the guard (admin Retry)',
      sends.length === 0 && rowOf(id).status === 'confirmed', `sends=${sends.length} status=${rowOf(id).status}`);
  }

  // ═══ 3. reclaimStaleTorSending (§J4-3) ═════════════════════════════════════
  console.log('\n[3] §J4-3 — the stale tor_sending sweep');
  {
    // The premise: before the sweep existed, nothing selected this status at all.
    reset();
    const id = seedWithdrawal({ status: 'tor_sending', slate: 'ST-NONE' });
    const s = newScheduler([]);
    await s.processRetryQueue();
    await s.processTorChecks();
    await s.processSlatepackExpiry();
    await s.reclaimStaleFinalizing();
    ok('premise — no other recovery pass touches a tor_sending row',
      rowOf(id).status === 'tor_sending', rowOf(id).status);
  }
  {
    sends = [];
    reset();
    const id = seedWithdrawal({ status: 'tor_sending', slate: 'ST-CONF' });
    const s = newScheduler([tx({ slate: 'ST-CONF', confirmed: true })]);
    await s.reclaimStaleTorSending();
    const r = rowOf(id);
    ok('confirmed on chain → the abandoned row is confirmed', r.status === 'confirmed', r.status);
    ok('…and nothing was re-sent', sends.length === 0);
    ok('…and the lock is released', acct().balance_locked === 0, JSON.stringify(acct()));
  }
  {
    sends = [];
    reset();
    const id = seedWithdrawal({ status: 'tor_sending', slate: 'ST-GONE', retries: 1 });
    const s = newScheduler([]);
    await s.reclaimStaleTorSending();
    const r = rowOf(id);
    ok('never posted → returned to the retry queue', r.status === 'retry_scheduled', r.status);
    ok('…and this one DOES consume a rung (it was a real failed attempt)', r.retry_count === 2, String(r.retry_count));
    ok('…and the sweep never sends from inside itself', sends.length === 0);
  }
  {
    reset();
    const id = seedWithdrawal({ status: 'tor_sending', slate: 'ST-UNK' });
    const s = newScheduler([tx({ slate: 'ST-UNK', confirmed: false })]);
    await s.reclaimStaleTorSending();
    ok('unconfirmed → parked in tor_sending, re-asked next tick', rowOf(id).status === 'tor_sending');
    ok('…with the balance still locked', acct().balance_locked > 0, JSON.stringify(acct()));
  }
  {
    reset();
    const id = seedWithdrawal({ status: 'tor_sending', slate: 'ST-DOWN' });
    const s = newScheduler([], { walletReadable: false });
    await s.reclaimStaleTorSending();
    ok('wallet unreadable → left alone, never guessed', rowOf(id).status === 'tor_sending');
  }
  {
    // A send that is still legitimately running must NOT be swept out from under itself.
    reset();
    const id = seedWithdrawal({ status: 'tor_sending', slate: 'ST-FRESH', priorAttempt: false });
    db.prepare(
      `INSERT INTO withdrawal_events (withdrawal_id, from_status, to_status, triggered_by, created_at)
       VALUES (?, 'tor_checking', 'tor_sending', 'scheduler', unixepoch())`
    ).run(id);
    const s = newScheduler([]);
    await s.reclaimStaleTorSending();
    ok('a FRESH claim is not swept (ages the claim, not the row)', rowOf(id).status === 'tor_sending');
  }
  {
    const s = newScheduler([]);
    ok('the stale threshold clears twice the send timeout plus slack',
      s.torSendingStaleSeconds >= 120 * 2 + 120, String(s.torSendingStaleSeconds));
    const slow = new WithdrawalScheduler({ ...config, wallet_send_timeout_ms: 600000 }, null);
    ok('…and follows a raised wallet_send_timeout_ms', slow.torSendingStaleSeconds >= 600 * 2 + 120,
      String(slow.torSendingStaleSeconds));
  }

  // ═══ 4. _captureTorSlateId uses the guard's rules, not a looser copy (§J4-11) ═══
  console.log('\n[4] §J4-11 — the proof-metadata capture cannot attach a stranger\'s slate');
  {
    reset();
    // The exact log that produced the observed bug: a year-old unrelated send, larger than
    // this payout. Old rules (/Sent/, >= amount, no time bound, newest-by-id) took it.
    const id = seedWithdrawal({ status: 'tor_checking', priorAttempt: false, retries: 0 });
    const s = newScheduler([
      { ...tx({ slate: 'OLD', net: 500, confirmed: true, when: Date.now() / 1000 - 86400 * 365 }), id: 99 },
    ]);
    await s.sendWithdrawal(id);
    ok('a year-old, larger send is NOT attached as this payout\'s proof', rowOf(id).slate_id === null,
      String(rowOf(id).slate_id));
  }
  {
    reset();
    const id = seedWithdrawal({ status: 'tor_checking', priorAttempt: false, retries: 0 });
    const s = newScheduler([{ ...tx({ slate: 'CANC', type: 'TxSentCancelled' }), id: 5 }]);
    await s.sendWithdrawal(id);
    ok('a CANCELLED transaction is not proof of anything', rowOf(id).slate_id === null, String(rowOf(id).slate_id));
  }
  {
    reset();
    // A slate already recorded as another withdrawal's proof must not be re-used — that is what
    // could shield a genuine _priorSendLanded match belonging to the other row.
    const other = seedWithdrawal({ status: 'confirmed', slate: 'TAKEN', priorAttempt: false });
    const id = seedWithdrawal({ status: 'tor_checking', priorAttempt: false, retries: 0 });
    const s = newScheduler([{ ...tx({ slate: 'TAKEN' }), id: 7 }]);
    await s.sendWithdrawal(id);
    ok('a slate already claimed by another withdrawal is not re-used',
      rowOf(id).slate_id === null && rowOf(other).slate_id === 'TAKEN', String(rowOf(id).slate_id));
  }
  {
    reset();
    const id = seedWithdrawal({ status: 'tor_checking', priorAttempt: false, retries: 0 });
    const s = newScheduler([{ ...tx({ slate: 'MINE' }), id: 3 }]);
    await s.sendWithdrawal(id);
    ok('control — the pool\'s OWN matching send is still captured', rowOf(id).slate_id === 'MINE',
      String(rowOf(id).slate_id));
  }

  console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed\n`);
  cleanup();
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error(e); cleanup(); process.exit(1); });
