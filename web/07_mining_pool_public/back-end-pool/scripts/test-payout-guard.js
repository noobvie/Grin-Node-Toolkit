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

  // ═══ 5. The LAST rung asks the wallet before it refunds ═════════════════════
  // sendWithdrawal's guard runs BEFORE each re-attempt, so it covers attempts 0..N-1 and never
  // attempt N: the final send that reported failure used to go straight to markFailed → refund.
  // A send that reports failure may still have posted (SIGKILLed after the broadcast), and on
  // the final rung a miner can arrange exactly that on purpose — the ladder is deterministic and
  // the retry count is on their account page. These drive the REAL path: a row on its last rung,
  // a send that "fails" but leaves a TxSent in the wallet log, then whatever markFailed decides.
  console.log('\n[5] last-rung guard — the final failed attempt is checked before the refund');
  const LAST = new WithdrawalScheduler(config).retryDelays.length;
  // A wallet whose log the send can append to: the pre-send guard sees it empty (→ absent →
  // send), the send "fails" but leaves `landed` behind, and markFailed reads it back.
  function lastRung(landed, { walletReadable = true } = {}) {
    const log = [];
    const s = newScheduler(log, { walletReadable });
    s.walletTor = {
      async sendToTorAddress(address, amount) {
        timeline.push('send'); sends.push({ address, amount });
        if (landed) log.push(landed);
        return { success: false, error: 'killed at wallet_send_timeout_ms' };
      },
      async checkTorReachable() { return { online: true }; },
    };
    return s;
  }
  {
    sends = []; reset();
    const id = seedWithdrawal({ status: 'tor_checking', retries: LAST, slate: null });
    await lastRung(tx({ slate: 'LAST-CONF', confirmed: true })).sendWithdrawal(id);
    const r = rowOf(id);
    ok('final attempt "failed" but is CONFIRMED on chain → the payout is settled, not refunded',
      r.status === 'confirmed', r.status);
    ok('  …the miner keeps neither the balance nor a lock (paid once)',
      acct().balance === 0 && acct().balance_locked === 0, JSON.stringify(acct()));
    ok('  …and the landed slate is attached as its proof', r.slate_id === 'LAST-CONF', String(r.slate_id));
    ok('  …and the send really was attempted first (this is the real path, not a stub of it)',
      sends.length === 1, `${sends.length} sends`);
  }
  {
    sends = []; reset();
    const id = seedWithdrawal({ status: 'tor_checking', retries: LAST, slate: null });
    await lastRung(tx({ slate: 'LAST-UNCONF', confirmed: false })).sendWithdrawal(id);
    const r = rowOf(id);
    ok('final attempt "failed" but left an UNCONFIRMED send → parked, not refunded',
      r.status === 'retry_scheduled', r.status);
    ok('  …the balance stays LOCKED', acct().balance_locked > 0 && acct().balance === 0, JSON.stringify(acct()));
    ok('  …the deferral does not push retry_count past the ladder', r.retry_count === LAST, String(r.retry_count));
    ok('  …and the event log says why', !!db.prepare(
      "SELECT 1 FROM withdrawal_events WHERE withdrawal_id = ? AND note LIKE 'deferred:%'").get(id));
  }
  {
    sends = []; reset();
    const id = seedWithdrawal({ status: 'tor_checking', retries: LAST, slate: null });
    await lastRung(null).sendWithdrawal(id);
    const r = rowOf(id);
    ok('control — final attempt failed and the wallet holds NO send → refunded as before',
      r.status === 'tor_failed', r.status);
    ok('  …balance back, lock released', acct().balance === 100 && acct().balance_locked === 0, JSON.stringify(acct()));
    ok('  …with the reversal in the ledger', !!db.prepare(
      "SELECT 1 FROM balance_log WHERE reference_id = ? AND event_type = 'reversal'").get(id));
  }
  {
    // The asymmetry with sendWithdrawal's "proceed loudly": there proceeding moves live money
    // through a brief wallet outage; here proceeding can only refund, and a refund on top of a
    // landed send is unrecoverable. Unreadable must therefore park, never refund.
    sends = []; reset();
    const id = seedWithdrawal({ status: 'tor_checking', retries: LAST, slate: null });
    await lastRung(null, { walletReadable: false }).sendWithdrawal(id);
    const r = rowOf(id);
    ok('wallet UNREADABLE at the last rung → parked, NOT refunded', r.status === 'retry_scheduled', r.status);
    ok('  …the balance stays LOCKED', acct().balance_locked > 0 && acct().balance === 0, JSON.stringify(acct()));
    ok('  …and the event note says the log could not be read, not that a send was found', !!db.prepare(
      "SELECT 1 FROM withdrawal_events WHERE withdrawal_id = ? AND note LIKE 'deferred:%could not be read%'").get(id));

    // The deferral is a standing statement that the outcome is unknown. Fifteen minutes later
    // the scheduler picks the row up again through sendWithdrawal — and if the wallet is STILL
    // unreadable, the ordinary "proceed loudly" branch would send blind, paying twice if the
    // final attempt had landed. A deferred row must be re-parked instead, on every rung.
    sends = [];
    db.prepare("UPDATE withdrawals SET status = 'tor_checking' WHERE id = ?").run(id);
    await newScheduler([], { walletReadable: false }).sendWithdrawal(id);
    const r2 = rowOf(id);
    ok('  …picked up again with the wallet STILL unreadable → re-parked, not sent blind',
      r2.status === 'retry_scheduled' && sends.length === 0, `${r2.status}, ${sends.length} sends`);
    ok('  …the balance is still LOCKED', acct().balance_locked > 0 && acct().balance === 0, JSON.stringify(acct()));
    ok('  …and a second deferral is on record', db.prepare(
      "SELECT COUNT(*) AS c FROM withdrawal_events WHERE withdrawal_id = ? AND note LIKE 'deferred:%'").get(id).c === 2);
  }
  {
    // Same rule reached from an ORDINARY rung: a row deferred because an unconfirmed send was
    // seen must not be sent blind when the wallet later goes dark — the unconfirmed send is
    // still the last thing anyone knew about it.
    sends = []; reset();
    const id = seedWithdrawal({ status: 'tor_checking', retries: 1, slate: 'DEF-THEN-DARK' });
    await newScheduler([tx({ slate: 'DEF-THEN-DARK', confirmed: false })]).sendWithdrawal(id);
    ok('ordinary rung: unconfirmed send seen → deferred', rowOf(id).status === 'retry_scheduled' && sends.length === 0);
    db.prepare("UPDATE withdrawals SET status = 'tor_checking' WHERE id = ?").run(id);
    await newScheduler([], { walletReadable: false }).sendWithdrawal(id);
    ok('  …then the wallet goes dark → re-parked, NOT sent blind',
      rowOf(id).status === 'retry_scheduled' && sends.length === 0, `${rowOf(id).status}, ${sends.length} sends`);
    // Control: a row with NO deferral behind it keeps the documented proceed-loudly behaviour.
    sends = []; reset();
    const id2 = seedWithdrawal({ status: 'tor_checking', retries: 1, slate: null });
    await newScheduler([], { walletReadable: false }).sendWithdrawal(id2);
    ok('  control — never deferred + wallet unreadable → proceeds loudly (unchanged §J4 policy)',
      sends.length === 1, `${sends.length} sends`);
  }

  // ═══ 6. Signed payment proofs (§H6) — stored only when they are provably OURS ═══
  // The proof is served to the miner as "your wallet signed for this payment", so a wrong one
  // is worse than none: it would hand a miner a stranger's transaction as their receipt. The
  // guard is the kernel: the excess the wallet signed over must equal the kernel the backfill
  // attached to the row, or nothing is stored. The rest is lifecycle — '' is terminal, NULL is
  // "ask again", and non-Tor rails (which never requested a proof) are settled to '' up front.
  console.log('\n[6] §H6 signed payment proofs — fetch, store, refuse');
  const PROOF = {
    amount: '99960000000', excess: '08' + 'ab'.repeat(32),
    recipient_address: ADDR, recipient_sig: 'aa'.repeat(64),
    sender_address: 'tgrin1' + 'q'.repeat(58), sender_sig: 'bb'.repeat(64)
  };
  function proofScheduler(reply) {
    const s = newScheduler([]);
    s.wallet.retrievePaymentProof = async (slateId) => {
      timeline.push('proof:' + slateId);
      if (reply instanceof Error) throw reply;
      return reply;
    };
    return s;
  }
  const seedConfirmed = (over = {}) => {
    const id = seedWithdrawal({ status: 'confirmed', slate: 'P-' + (++seq), priorAttempt: false, retries: 0 });
    db.prepare('UPDATE withdrawals SET method = ?, kernel_excess = ?, payment_proof = ? WHERE id = ?')
      .run(over.method || 'tor', 'kernel_excess' in over ? over.kernel_excess : PROOF.excess,
           'payment_proof' in over ? over.payment_proof : null, id);
    return id;
  };
  {
    reset(); timeline = [];
    const id = seedConfirmed();
    const r = await proofScheduler(PROOF).fetchAndStorePaymentProof(id);
    ok('a confirmed Tor row whose proof matches its kernel → stored',
      r.ok && !r.cached && rowOf(id).payment_proof === JSON.stringify(PROOF), JSON.stringify(r));
    const again = await proofScheduler(PROOF).fetchAndStorePaymentProof(id);
    ok('  …and a second ask is served from the row, not the wallet',
      again.ok && again.cached && timeline.filter((t) => t.startsWith('proof:')).length === 1, timeline.join(','));
  }
  {
    reset();
    const id = seedConfirmed({ kernel_excess: '09' + 'cd'.repeat(32) });
    const r = await proofScheduler(PROOF).fetchAndStorePaymentProof(id);
    ok('a proof whose excess differs from the row\'s kernel → REFUSED, nothing stored',
      !r.ok && r.reason === 'kernel_mismatch' && rowOf(id).payment_proof === null, JSON.stringify(r));
  }
  {
    reset(); timeline = [];
    const id = seedConfirmed({ method: 'slatepack' });
    const r = await proofScheduler(PROOF).fetchAndStorePaymentProof(id);
    ok('a slatepack row is settled to \'\' (none) without asking the wallet',
      !r.ok && r.reason === 'none' && rowOf(id).payment_proof === '' && !timeline.some((t) => t.startsWith('proof:')),
      JSON.stringify(r));
  }
  {
    reset(); timeline = [];
    const id = seedConfirmed({ kernel_excess: null });
    const r = await proofScheduler(PROOF).fetchAndStorePaymentProof(id);
    ok('a row with no kernel yet is not asked — the wallet refuses proofs for unconfirmed txs',
      !r.ok && r.reason === 'not_confirmed' && !timeline.some((t) => t.startsWith('proof:')), JSON.stringify(r));
  }
  {
    reset();
    const id = seedConfirmed();
    const r = await proofScheduler(new Error('Payment proof not present in transaction')).fetchAndStorePaymentProof(id);
    ok('the wallet\'s definitive "no proof" error → \'\' so the backfill stops asking',
      !r.ok && r.reason === 'none' && rowOf(id).payment_proof === '', JSON.stringify(r));
  }
  {
    reset();
    const id = seedConfirmed();
    const r = await proofScheduler(new Error('HTTP 401: Unauthorized')).fetchAndStorePaymentProof(id);
    ok('a transient wallet error leaves NULL (retry later), never \'\'',
      !r.ok && r.reason === 'error' && rowOf(id).payment_proof === null, JSON.stringify(r));
  }
  {
    reset();
    const id = seedConfirmed({ payment_proof: '' });
    const r = await proofScheduler(PROOF).fetchAndStorePaymentProof(id);
    ok('\'\' is terminal — a settled "none" row is never re-asked', !r.ok && r.reason === 'none' && rowOf(id).payment_proof === '');
  }
  {
    // The backfill's selection: only confirmed Tor rows with a kernel and no answer yet.
    reset(); timeline = [];
    const want = seedConfirmed();
    seedConfirmed({ method: 'slatepack' });       // wrong rail
    seedConfirmed({ kernel_excess: null });        // not yet mined
    seedConfirmed({ payment_proof: '' });          // already settled: none
    const s = proofScheduler(PROOF);
    await s.backfillPaymentProofs();
    const asked = timeline.filter((t) => t.startsWith('proof:'));
    ok('backfill asks the wallet for exactly the one eligible row',
      asked.length === 1 && asked[0] === 'proof:' + rowOf(want).slate_id && rowOf(want).payment_proof === JSON.stringify(PROOF),
      asked.join(','));
  }

  // ═══ Slatepack response window (2026-09-24) ═══
  // The manual rail's expiry was a hardcoded 24h: the scheduler read `slatepack_ttl_hours`,
  // which neither config.js nor the settings table ever set. It is now slatepack_ttl_minutes,
  // 30 by default, wired end to end. Miners have no cancel, so this window is their only exit
  // from an abandoned request — and each pending one locks pool-wallet outputs until it ends.
  console.log('\n[slatepack] response window — default, config path, and the expiry sweep');
  {
    const PoolSettings = require(path.join(APP, 'lib/pool-settings.js'));
    const V = PoolSettings.validators.payout;
    const throws = (fn) => { try { fn(); return false; } catch (e) { return true; } };

    ok('settings default is 30 min', PoolSettings.defaults.payout.slatepack_ttl_minutes === 30);
    ok('validator accepts 10 and 1440, rejects 9 / 1441 / junk',
      V.slatepack_ttl_minutes('10') === 10 && V.slatepack_ttl_minutes(1440) === 1440 &&
      throws(() => V.slatepack_ttl_minutes(9)) && throws(() => V.slatepack_ttl_minutes(1441)) &&
      throws(() => V.slatepack_ttl_minutes('soon')));
    const applied = PoolSettings.applyToConfig({}, { pool_info: {}, payout: { slatepack_ttl_minutes: 45 } });
    ok('applyToConfig carries the setting into config', applied.slatepack_ttl_minutes === 45);
    // loadConfig() refuses to run without a real jwt_secret, so read the default from source.
    ok('config.js default is 30 min',
      /slatepack_ttl_minutes:\s*config\.slatepack_ttl_minutes !== undefined \? config\.slatepack_ttl_minutes : 30,/
        .test(fs.readFileSync(path.join(APP, 'lib/config.js'), 'utf8')));

    const ttlOf = (c) => new WithdrawalScheduler({ ...config, ...c }, null).slatepackTtlSeconds;
    ok('scheduler: no setting → 30 min (was the 24h fallback)', ttlOf({}) === 1800);
    ok('scheduler: 60 → 60 min', ttlOf({ slatepack_ttl_minutes: 60 }) === 3600);
    ok('scheduler: junk or below the floor → 30 min, never "expire at once"',
      ttlOf({ slatepack_ttl_minutes: 'x' }) === 1800 && ttlOf({ slatepack_ttl_minutes: 0 }) === 1800);

    // The sweep itself: 31 min old expires (cancelTx + full refund); 29 min old is left alone.
    reset();
    db.prepare('UPDATE miner_accounts SET balance = 0, balance_locked = 50 WHERE grin_address = ?').run(ADDR);
    const now = Math.floor(Date.now() / 1000);
    const seedSp = (ageMin, slate) => Number(db.prepare(
      `INSERT INTO withdrawals (grin_address, amount, fee, fee_charged, status, method, slate_id, created_at)
       VALUES (?, 25, 0, 0.04, 'slatepack_pending', 'slatepack', ?, ?)`
    ).run(ADDR, slate, now - ageMin * 60).lastInsertRowid);
    const oldId = seedSp(31, 'sp-old');
    const freshId = seedSp(29, 'sp-fresh');
    const cancelled = [];
    const s = new WithdrawalScheduler(config, { async cancelTx(id) { cancelled.push(id); } });
    await s.processSlatepackExpiry();
    ok('31-min-old slatepack expires', rowOf(oldId).status === 'slatepack_expired', rowOf(oldId).status);
    ok('…its pool-wallet tx is cancelled', cancelled.length === 1 && cancelled[0] === 'sp-old', cancelled.join(','));
    ok('…and the full amount returns to spendable', Math.abs(acct().balance - 25) < 1e-9 && Math.abs(acct().balance_locked - 25) < 1e-9,
      JSON.stringify(acct()));
    ok('29-min-old slatepack is still pending', rowOf(freshId).status === 'slatepack_pending', rowOf(freshId).status);
  }

  // ═══ "Not now" refusals say "try again in about an hour" (2026-09-24) ═══
  // Neither may leak pool internals: the cap's size, or — far worse — the pool wallet's
  // spendable balance, which grin-wallet's NotEnoughFunds carries and used to reach the miner.
  console.log('\n[busy] pool-full and wallet-short refusals');
  {
    reset();
    db.prepare('UPDATE miner_accounts SET balance = 30 WHERE grin_address = ?').run(ADDR);
    const s = new WithdrawalScheduler({ ...config, max_pending_withdrawals: 1 }, null);
    db.prepare("INSERT OR IGNORE INTO miner_accounts (grin_address, balance, balance_locked) VALUES ('tgrin1someoneelse', 0, 25)").run();
    db.prepare(`INSERT INTO withdrawals (grin_address, amount, fee, fee_charged, status, method)
                VALUES ('tgrin1someoneelse', 25, 0, 0.04, 'slatepack_pending', 'slatepack')`).run();
    let e1 = null;
    try { s.createWithdrawal(ADDR, 25); } catch (e) { e1 = e; }
    ok('pool-wide cap: 429 that says "try again in about an hour"',
      e1 && e1.code === 429 && /try again in about an hour/.test(e1.message) && !/maximum|\(\d+\)/.test(e1.message),
      e1 && e1.message);
    ok('…and nothing was locked', Math.abs(acct().balance - 30) < 1e-9 && acct().balance_locked === 0, JSON.stringify(acct()));
  }
  {
    reset();
    db.prepare('UPDATE miner_accounts SET balance = 30 WHERE grin_address = ?').run(ADDR);
    const RAW = 'Wallet error: {"NotEnoughFunds":{"available":123456789000,"available_disp":"123.456789","needed":24960000000,"needed_disp":"24.96"}}';
    const cancelled = [];
    const s = new WithdrawalScheduler(config, {
      async initSendTx() { throw new Error(RAW); },
      async cancelTx(id) { cancelled.push(id); },
    });
    const origErr = console.error; const logged = []; console.error = (m) => logged.push(String(m));
    let e2 = null;
    try { await s.createSlatepackWithdrawal(ADDR, 25); } catch (e) { e2 = e; }
    console.error = origErr;
    ok('wallet short: 503 with the friendly "about an hour" message',
      e2 && e2.code === 503 && /try again in about an hour/.test(e2.message), e2 && e2.message);
    ok('…which never carries the pool wallet balance', e2 && !/123\.456789|123456789000|NotEnoughFunds|available/.test(e2.message), e2 && e2.message);
    ok('…while the operator log keeps the real error', logged.some((l) => l.includes('NotEnoughFunds')), logged.join(' | '));
    const spAlert = db.prepare("SELECT message FROM alerts WHERE type = 'pool_wallet_short' AND status = 'active' ORDER BY id DESC LIMIT 1").get();
    ok('…and so does the admin health alert', !!spAlert && /slatepack payout/.test(spAlert.message) && /123\.456789/.test(spAlert.message),
      spAlert && spAlert.message);
    ok('…and the full balance is back', Math.abs(acct().balance - 30) < 1e-9 && Math.abs(acct().balance_locked) < 1e-9, JSON.stringify(acct()));

    // CONTROL: any OTHER wallet failure keeps its specific message (operators debug from it).
    reset();
    db.prepare('UPDATE miner_accounts SET balance = 30 WHERE grin_address = ?').run(ADDR);
    const s2 = new WithdrawalScheduler(config, {
      async initSendTx() { throw new Error('HTTP 502: Bad Gateway'); }, async cancelTx() {},
    });
    let e3 = null;
    try { await s2.createSlatepackWithdrawal(ADDR, 25); } catch (e) { e3 = e; }
    ok('CONTROL: an unrelated wallet error is still reported as-is (502)',
      e3 && e3.code === 502 && /Bad Gateway/.test(e3.message), e3 && e3.message);
  }

  // ═══ Why a Tor payout is parked: retry_reason + the admin health alert (2026-09-24) ═══
  // The account page used to say "wallet unreachable" for every retry — to a miner that means
  // THEIR wallet, which is wrong when the POOL wallet was the one short. The cause is now stored,
  // and the figures go to one rolling admin alert instead of to the miner.
  console.log('\n[retry-reason] pool-wallet shortfall vs everything else');
  {
    const shortAlert = () => db.prepare(
      "SELECT * FROM alerts WHERE type = 'pool_wallet_short' AND status = 'active' ORDER BY id DESC LIMIT 1").get();
    const failingScheduler = (error) => {
      const s = newScheduler([]);
      s.walletTor.sendToTorAddress = async () => ({ success: false, error });
      return s;
    };
    const quiet = async (fn) => { const o = console.error; console.error = () => {}; try { await fn(); } finally { console.error = o; } };
    db.exec("DELETE FROM alerts WHERE type = 'pool_wallet_short'");

    reset();
    const id = seedWithdrawal({ status: 'tor_checking', retries: 0, priorAttempt: false });
    const SHORT = 'Wallet command failed: Not enough funds. Required: 99.96, Available: 12.5';
    await quiet(() => failingScheduler(SHORT).sendWithdrawal(id));
    ok('pool wallet short → parked with retry_reason = pool_wallet_short',
      rowOf(id).status === 'retry_scheduled' && rowOf(id).retry_reason === 'pool_wallet_short', JSON.stringify(rowOf(id)));
    const a1 = shortAlert();
    ok('…and ONE admin alert carries the real figures', a1 && /Available: 12\.5/.test(a1.message) && a1.occurrence_count === 1,
      a1 && a1.message);

    // Second shortfall within 24h rolls into the same row rather than stacking a new one.
    db.prepare("UPDATE withdrawals SET status = 'tor_checking' WHERE id = ?").run(id);
    await quiet(() => failingScheduler(SHORT.replace('12.5', '7.25')).sendWithdrawal(id));
    const a2 = shortAlert();
    const activeCount = db.prepare("SELECT COUNT(*) c FROM alerts WHERE type = 'pool_wallet_short' AND status = 'active'").get().c;
    ok('a repeat within 24h updates the same alert (count 2, latest figures)',
      a2 && a2.id === a1.id && a2.occurrence_count === 2 && /Available: 7\.25/.test(a2.message) && activeCount === 1,
      JSON.stringify({ a2, activeCount }));

    // A later failure with a DIFFERENT cause must clear the reason, or the page keeps blaming the pool.
    db.prepare("UPDATE withdrawals SET status = 'tor_checking' WHERE id = ?").run(id);
    await quiet(() => failingScheduler('Tor: recipient onion not reachable').sendWithdrawal(id));
    ok('a later non-funds failure resets retry_reason to NULL',
      rowOf(id).status === 'retry_scheduled' && rowOf(id).retry_reason === null, JSON.stringify(rowOf(id)));
    ok('…and does not touch the alert', shortAlert().occurrence_count === 2);

    // CONTROL: the ordinary case — the miner is offline — never reads as "pool busy".
    reset();
    const id2 = seedWithdrawal({ status: 'tor_checking', retries: 0, priorAttempt: false });
    await quiet(() => failingScheduler('Tor: recipient onion not reachable').sendWithdrawal(id2));
    ok('CONTROL: miner unreachable → retry_reason stays NULL',
      rowOf(id2).status === 'retry_scheduled' && rowOf(id2).retry_reason === null, JSON.stringify(rowOf(id2)));

    // An alert older than 24h is resolved and a fresh one starts (the card shows only the last day).
    db.prepare("UPDATE alerts SET last_seen = ? WHERE id = ?").run(new Date(Date.now() - 2 * 86400000).toISOString(), a1.id);
    reset();
    const id3 = seedWithdrawal({ status: 'tor_checking', retries: 0, priorAttempt: false });
    await quiet(() => failingScheduler(SHORT).sendWithdrawal(id3));
    const a3 = shortAlert();
    ok('a shortfall after a quiet day starts a fresh alert and resolves the stale one',
      a3 && a3.id !== a1.id && a3.occurrence_count === 1 &&
      db.prepare('SELECT status FROM alerts WHERE id = ?').get(a1.id).status === 'resolved');
  }

  console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed\n`);
  cleanup();
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error(e); cleanup(); process.exit(1); });
