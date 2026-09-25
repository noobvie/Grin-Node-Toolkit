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

    // ── A shortfall retries after ~1 h and does NOT use up a rung (2026-09-25, F3) ──
    // A NotEnoughFunds usually clears within the hour as other payouts settle, so it is not the
    // miner-offline ladder's problem: it used to wait 6 h AND consume a rung, so four in a row
    // reached markFailed and refunded a payout that never reached the miner. Bounded at 24
    // uncounted retries (~a day) so an underfunded pool cannot hold a balance forever.
    const SHORT_S = 3600, SHORT_MAX = 24, RUNG0_S = 6 * 3600;
    const again = async (s, id) => {
      db.prepare("UPDATE withdrawals SET status = 'tor_checking' WHERE id = ?").run(id);
      await quiet(() => s.sendWithdrawal(id));
    };
    const near = (at, secs) => Math.abs(Number(at) - (Math.floor(Date.now() / 1000) + secs)) <= 5;
    const lastNote = (id) => db.prepare(
      'SELECT note FROM withdrawal_events WHERE withdrawal_id = ? ORDER BY id DESC LIMIT 1').get(id).note;

    reset();
    const f1 = seedWithdrawal({ status: 'tor_checking', retries: 0, priorAttempt: false });
    await quiet(() => failingScheduler(SHORT).sendWithdrawal(f1));
    ok('shortfall → retry_scheduled, retry_count NOT incremented',
      rowOf(f1).status === 'retry_scheduled' && rowOf(f1).retry_count === 0, JSON.stringify(rowOf(f1)));
    ok('…next attempt ≈ 1 h out, not the 6 h rung', near(rowOf(f1).next_retry_at, SHORT_S), JSON.stringify(rowOf(f1)));
    ok('…and the event note says so without claiming "Retry n/4"',
      /^shortfall: /.test(lastNote(f1)) && /1\/24 \(not counted\)/.test(lastNote(f1)) && !/Retry \d+\/\d+/.test(lastNote(f1)),
      lastNote(f1));

    // The old bug: every shortfall used a rung, so the 5th consecutive one reached markFailed →
    // _reverseLock → 'tor_failed' with the balance handed back.
    reset();
    const f2 = seedWithdrawal({ status: 'tor_checking', retries: 0, priorAttempt: false });
    const s2 = failingScheduler(SHORT);
    await quiet(() => s2.sendWithdrawal(f2));
    for (let i = 0; i < 5; i++) await again(s2, f2);
    ok('six shortfalls in a row never reach markFailed — still parked, balance still locked',
      rowOf(f2).status === 'retry_scheduled' && rowOf(f2).retry_count === 0 && Math.abs(acct().balance_locked - 100) < 1e-9,
      JSON.stringify({ row: rowOf(f2), acct: acct() }));

    // A shortfall retry is still a RE-attempt: retry_count stays 0 and slate_id is NULL, so the
    // double-send guard must be armed from the event log alone (priorAttempts > 0).
    reset(); timeline = []; sends = [];
    const f3 = seedWithdrawal({ status: 'tor_checking', retries: 0, priorAttempt: false });
    await quiet(() => failingScheduler(SHORT).sendWithdrawal(f3));
    ok('(precondition) after a shortfall: retry_count 0, no slate id',
      rowOf(f3).retry_count === 0 && rowOf(f3).slate_id === null, JSON.stringify(rowOf(f3)));
    db.prepare('UPDATE withdrawals SET next_retry_at = ? WHERE id = ?').run(Math.floor(Date.now() / 1000) - 1, f3);
    timeline = []; sends = [];
    const g = newScheduler([tx({ slate: 'SF-UNCONF', confirmed: false })]);
    await quiet(() => g.processRetryQueue());
    ok('the uncounted retry still runs _priorSendLanded first — an unconfirmed match parks it, no send',
      timeline[0] === 'wallet' && sends.length === 0 && rowOf(f3).status === 'retry_scheduled' && /^deferred:/.test(lastNote(f3)),
      JSON.stringify({ timeline, sends, row: rowOf(f3), note: lastNote(f3) }));

    // The cap: 24 uncounted retries, then the 25th shortfall takes the normal ladder (rung 1, 6 h),
    // so the last-rung guard eventually decides — loudly.
    reset();
    const f4 = seedWithdrawal({ status: 'tor_checking', retries: 0, priorAttempt: false });
    const s4 = failingScheduler(SHORT);
    await quiet(() => s4.sendWithdrawal(f4));
    for (let i = 1; i < SHORT_MAX; i++) await again(s4, f4);
    const shortEvents = db.prepare(
      "SELECT COUNT(*) c FROM withdrawal_events WHERE withdrawal_id = ? AND note LIKE 'shortfall:%'").get(f4).c;
    ok('24 shortfalls → 24 uncounted retries, retry_count still 0',
      shortEvents === SHORT_MAX && rowOf(f4).retry_count === 0 && near(rowOf(f4).next_retry_at, SHORT_S),
      JSON.stringify({ shortEvents, row: rowOf(f4) }));
    const errs = []; const oErr = console.error; console.error = (m) => errs.push(String(m));
    db.prepare("UPDATE withdrawals SET status = 'tor_checking' WHERE id = ?").run(f4);
    try { await s4.sendWithdrawal(f4); } finally { console.error = oErr; }
    ok('the 25th consumes a rung: retry_count 1, next attempt 6 h out, reason still pool_wallet_short',
      rowOf(f4).status === 'retry_scheduled' && rowOf(f4).retry_count === 1 && near(rowOf(f4).next_retry_at, RUNG0_S) &&
        rowOf(f4).retry_reason === 'pool_wallet_short',
      JSON.stringify(rowOf(f4)));
    ok('…with a counted "Retry 1/4" note and a console.error naming the cap',
      /^Retry 1\/4 /.test(lastNote(f4)) && errs.some((l) => /shortfall/i.test(l) && /24/.test(l)),
      JSON.stringify({ note: lastNote(f4), errs }));

    // A shortfall followed by an ordinary failure: the offline one is the ladder's, as before.
    reset();
    const f5 = seedWithdrawal({ status: 'tor_checking', retries: 0, priorAttempt: false });
    await quiet(() => failingScheduler(SHORT).sendWithdrawal(f5));
    await again(failingScheduler('Tor: recipient onion not reachable'), f5);
    ok('shortfall then miner-offline → the offline failure consumes a rung, 6 h, retry_reason NULL',
      rowOf(f5).status === 'retry_scheduled' && rowOf(f5).retry_count === 1 && near(rowOf(f5).next_retry_at, RUNG0_S) &&
        rowOf(f5).retry_reason === null && /^Retry 1\/4 /.test(lastNote(f5)),
      JSON.stringify({ row: rowOf(f5), note: lastNote(f5) }));

    // A shortfall on the LAST rung (ladder already spent by offline failures) must not refund
    // either: it takes an uncounted retry instead of markFailed.
    reset();
    const f6 = seedWithdrawal({ status: 'tor_checking', retries: 4, priorAttempt: true });
    await quiet(() => failingScheduler(SHORT).sendWithdrawal(f6));
    ok('a shortfall with the ladder exhausted → uncounted retry, not markFailed',
      rowOf(f6).status === 'retry_scheduled' && rowOf(f6).retry_count === 4 && Math.abs(acct().balance_locked - 100) < 1e-9,
      JSON.stringify({ row: rowOf(f6), acct: acct() }));
  }

  // ═══ Kernel proof only once MINED (2026-09-25, F1) ═══
  // withdrawals.kernel_excess drives the public "paid · mined" badge, has_kernel_proof and the
  // account page's explorer link, so it must mean "seen mined". grin-wallet v5.4.1 writes a tx-log
  // entry's kernel_excess at tx_lock_outputs and again at finalize (update_stored_tx) — both BEFORE
  // post_tx — so the entry's `confirmed` flag is the only chain evidence, never the excess itself.
  console.log('\n[kernel-proof] the kernel is attached only from a CONFIRMED tx-log entry');
  {
    const KX = '08' + 'ef'.repeat(32);
    const logEntry = (slate, confirmed) => ({ ...tx({ slate, confirmed }), kernel_excess: KX });
    const kernelScheduler = (txLog) => {
      const s = newScheduler(txLog);
      s.wallet.retrievePaymentProof = async (slateId) => {
        timeline.push('proof:' + slateId);
        return { ...PROOF, excess: KX };
      };
      return s;
    };
    const seedPaid = (slate) => seedWithdrawal({ status: 'confirmed', slate, priorAttempt: false, retries: 0 });

    reset(); timeline = [];
    const unmined = seedPaid('K-UNMINED');
    const s1 = kernelScheduler([logEntry('K-UNMINED', false)]);
    await s1.backfillKernelProofs();
    ok('an UNCONFIRMED entry that already carries kernel_excess → the row keeps NULL',
      rowOf(unmined).kernel_excess === null, JSON.stringify(rowOf(unmined)));
    const p = await s1.fetchAndStorePaymentProof(unmined);
    ok('…so fetchAndStorePaymentProof still refuses it (not_confirmed) without asking the wallet',
      !p.ok && p.reason === 'not_confirmed' && !timeline.some((t) => t.startsWith('proof:')), JSON.stringify(p));

    reset();
    const mined = seedPaid('K-MINED');
    await kernelScheduler([logEntry('K-MINED', true)]).backfillKernelProofs();
    ok('the same entry once CONFIRMED → kernel_excess stored', rowOf(mined).kernel_excess === KX, JSON.stringify(rowOf(mined)));

    // Mixed log in one pass: only the confirmed slate's row is filled, the other waits.
    reset();
    const a = seedPaid('K-A');
    const b = seedPaid('K-B');
    await kernelScheduler([logEntry('K-A', true), logEntry('K-B', false)]).backfillKernelProofs();
    ok('one scan: the confirmed slate gets its kernel, the unconfirmed one stays NULL',
      rowOf(a).kernel_excess === KX && rowOf(b).kernel_excess === null,
      JSON.stringify([rowOf(a).kernel_excess, rowOf(b).kernel_excess]));
  }

  // ═══ "Marked paid but not mined" watchdog + safe repost (2026-09-25, F2) ═══
  // 'confirmed' means the send COMMAND succeeded, not that the tx mined — and a node restart drops
  // its mempool. The watchdog classifies every payout still without a kernel an hour after it was
  // marked paid, raises ONE rolling admin alert, and re-broadcasts the IDENTICAL stored tx for the
  // "sent, not mined" class only. It must never move money: no status, balance or ledger change.
  console.log('\n[unmined] "marked paid but not mined" watchdog + safe repost');
  {
    const KX = '09' + 'ab'.repeat(32);
    const now = Math.floor(Date.now() / 1000);
    const reposts = [];
    const watchScheduler = (txLog, opts) => {
      const s = newScheduler(txLog, opts);
      s.walletTor.repostTx = async (txLogId) => {
        timeline.push('repost:' + txLogId);
        reposts.push(txLogId);
        return { ok: true, output: `Reposted transaction at ${txLogId}` };
      };
      return s;
    };
    // A payout the pool marked paid `agoS` seconds ago. Rail-agnostic: all three are watched.
    const seedPaidAt = ({ slate, agoS, method = 'tor' }) => {
      const id = Number(seedWithdrawal({ status: 'confirmed', slate, priorAttempt: false, retries: 0 }));
      db.prepare('UPDATE withdrawals SET confirmed_at = ?, method = ? WHERE id = ?').run(now - agoS, method, id);
      return id;
    };
    // `id` is the TxLogEntry id — what `grin-wallet repost -i` takes.
    const entry = (slate, { id, confirmed = false, type = 'TxSent' }) =>
      ({ ...tx({ slate, confirmed, type }), id, kernel_excess: KX });
    const unminedAlert = () => db.prepare(
      "SELECT * FROM alerts WHERE type = 'payout_unmined' AND status = 'active' ORDER BY id DESC LIMIT 1").get();
    const activeUnmined = () => db.prepare(
      "SELECT COUNT(*) c FROM alerts WHERE type = 'payout_unmined' AND status = 'active'").get().c;
    const moneySnap = () => JSON.stringify({
      w: db.prepare('SELECT id, status, amount, retry_count, next_retry_at FROM withdrawals ORDER BY id').all(),
      a: db.prepare('SELECT grin_address, balance, balance_locked FROM miner_accounts ORDER BY grin_address').all(),
      bl: db.prepare('SELECT COUNT(*) c FROM balance_log').get().c,
    });
    const repostEvents = (id) => db.prepare(
      "SELECT note, created_at FROM withdrawal_events WHERE withdrawal_id = ? AND note LIKE 'repost:%' ORDER BY id").all(id);
    const mentions = (msg, id) => new RegExp(`#${id}\\b`).test(String(msg || ''));
    const quiet = async (fn) => {
      const o = [console.warn, console.log, console.error];
      console.warn = console.log = console.error = () => {};
      try { return await fn(); } finally { [console.warn, console.log, console.error] = o; }
    };
    const tick = async (s) => { s._lastKernelScan = 0; await quiet(() => s.backfillKernelProofs()); };
    const wipe = () => { reset(); db.exec("DELETE FROM alerts WHERE type = 'payout_unmined'"); timeline = []; reposts.length = 0; };

    // ── every class in ONE scan ──
    wipe();
    const idSent  = seedPaidAt({ slate: 'U-SENT',  agoS: 7200 });
    const idCanc  = seedPaidAt({ slate: 'U-CANC',  agoS: 7200, method: 'slatepack' });
    const idAbs   = seedPaidAt({ slate: 'U-ABS',   agoS: 7200, method: 'nostr' });
    const idNone  = seedPaidAt({ slate: null,      agoS: 7200 });
    const idMined = seedPaidAt({ slate: 'U-MINED', agoS: 7200 });
    const idFresh = seedPaidAt({ slate: 'U-FRESH', agoS: 600 });
    const s = watchScheduler([
      entry('U-SENT',  { id: 11 }),
      entry('U-CANC',  { id: 12, type: 'TxSentCancelled' }),
      entry('U-MINED', { id: 13, confirmed: true }),
      entry('U-FRESH', { id: 14 }),
    ]);
    const before = moneySnap();
    await tick(s);

    ok('ONE getTransactions call per tick serves the kernel backfill AND the watchdog',
      timeline.filter((t) => t === 'wallet').length === 1, timeline.join(','));
    ok('…and the backfill still attached the mined kernel in that same pass', rowOf(idMined).kernel_excess === KX);
    const st = (id) => (typeof s.chainStateOf === 'function' ? s.chainStateOf(rowOf(id)) : 'no chainStateOf');
    ok('TxSent, not confirmed → "unmined"', st(idSent) === 'unmined', st(idSent));
    ok('TxSentCancelled → "cancelled"', st(idCanc) === 'cancelled', st(idCanc));
    ok('slate absent from the wallet → "absent"', st(idAbs) === 'absent', st(idAbs));
    ok('no slate id captured → "unverifiable"', st(idNone) === 'unverifiable', st(idNone));
    ok('confirmed → "mined"', st(idMined) === 'mined', st(idMined));
    ok('paid 10 min ago → "settling" (under the 1 h threshold, not flagged)', st(idFresh) === 'settling', st(idFresh));
    ok('a row that is not paid → null', typeof s.chainStateOf === 'function' &&
      s.chainStateOf({ ...rowOf(idSent), status: 'retry_scheduled' }) === null);

    const a1 = unminedAlert();
    ok('ONE active payout_unmined alert', activeUnmined() === 1, String(activeUnmined()));
    ok('…CRITICAL, because a cancelled / absent row means a miner marked paid was NOT paid',
      a1 && a1.level === 'critical', a1 && a1.level);
    ok('…listing the four overdue rows and neither the mined nor the fresh one',
      a1 && [idSent, idCanc, idAbs, idNone].every((id) => mentions(a1.message, id)) &&
      !mentions(a1.message, idMined) && !mentions(a1.message, idFresh), a1 && a1.message);
    ok('…with the slate id and a UTC time', a1 && /U-SENT/.test(a1.message) && /UTC/.test(a1.message), a1 && a1.message);
    const d1 = a1 ? JSON.parse(a1.data) : {};
    ok('…and a data blob with per-class counts and an operator runbook',
      d1.total === 4 && d1.counts && d1.counts.unmined === 1 && d1.counts.cancelled === 1 &&
      d1.counts.absent === 1 && d1.counts.unverifiable === 1 && d1.runbook && /NOT paid/.test(d1.runbook.cancelled || ''),
      a1 && a1.data);

    ok('repost ran exactly once, for the sent-not-mined row, by its tx-log id',
      reposts.length === 1 && reposts[0] === 11, JSON.stringify(reposts));
    ok('…never for cancelled / absent / unverifiable / fresh rows',
      !reposts.some((r) => r !== 11));
    ok('…and it is journaled as a "repost:" event on that row',
      repostEvents(idSent).length === 1 && repostEvents(idCanc).length === 0, JSON.stringify(repostEvents(idSent)));
    ok('no status, balance or balance_log change', moneySnap() === before);

    // ── the next tick inside the hour: rolled in place, no second repost ──
    await tick(s);
    const a2 = unminedAlert();
    ok('a second tick updates the SAME alert (count 2), no new row',
      a2 && a1 && a2.id === a1.id && a2.occurrence_count === 2 && activeUnmined() === 1, JSON.stringify(a2));
    ok('…and does NOT repost again within the hour', reposts.length === 1, JSON.stringify(reposts));
    ok('…still no money moved', moneySnap() === before);

    // ── an hour later: one more ──
    db.prepare("UPDATE withdrawal_events SET created_at = created_at - 3700 WHERE withdrawal_id = ? AND note LIKE 'repost:%'")
      .run(idSent);
    await tick(s);
    ok('once the last repost is over an hour old, it reposts again (once)',
      reposts.length === 2 && reposts[1] === 11, JSON.stringify(reposts));

    // ── bounded: after 24 reposts it stops and leaves the row to the operator ──
    const ins = db.prepare(
      `INSERT INTO withdrawal_events (withdrawal_id, from_status, to_status, triggered_by, note, created_at)
       VALUES (?, 'confirmed', 'confirmed', 'scheduler', 'repost: filler', ?)`);
    for (let i = 0; i < 24; i++) ins.run(idSent, now - 90000);
    reposts.length = 0;
    await tick(s);
    ok('after 24 reposts the row is never reposted again', reposts.length === 0, JSON.stringify(reposts));
    ok('…but it stays on the alert', mentions(unminedAlert() && unminedAlert().message, idSent));
    ok('no money moved across all four ticks', moneySnap() === before);
  }
  {
    // ── frozen: the watchdog still reports, the repost does not run ──
    const KX = '09' + 'ab'.repeat(32);
    const reposts = [];
    const now = Math.floor(Date.now() / 1000);
    const s = newScheduler([{ ...tx({ slate: 'F-SENT' }), id: 21, kernel_excess: KX }]);
    s.walletTor.repostTx = async (id) => { reposts.push(id); return { ok: true, output: '' }; };
    reset(); db.exec("DELETE FROM alerts WHERE type = 'payout_unmined'");
    const id = Number(seedWithdrawal({ status: 'confirmed', slate: 'F-SENT', priorAttempt: false, retries: 0 }));
    db.prepare('UPDATE withdrawals SET confirmed_at = ? WHERE id = ?').run(now - 7200, id);
    const o = [console.warn, console.log, console.error];
    console.warn = console.log = console.error = () => {};
    try {
      s.freeze('test', 'test');
      s._lastKernelScan = 0;
      await s.backfillKernelProofs();
    } finally { s.resume('test'); [console.warn, console.log, console.error] = o; }
    const a = db.prepare("SELECT * FROM alerts WHERE type = 'payout_unmined' AND status = 'active'").get();
    ok('frozen: NO repost (the freeze is the operator\'s stop-everything switch)', reposts.length === 0, JSON.stringify(reposts));
    ok('…but the alert is still raised (warning: sent-not-mined only)', a && a.level === 'warning' && /#\d+/.test(a.message),
      a && JSON.stringify(a));
  }
  {
    // ── resolution, and an unreadable wallet leaves the alert alone ──
    const KX = '09' + 'ab'.repeat(32);
    const now = Math.floor(Date.now() / 1000);
    const log = [{ ...tx({ slate: 'R-SENT' }), id: 31, kernel_excess: KX }];
    const mk = (opts) => { const s = newScheduler(log, opts); s.walletTor.repostTx = async () => ({ ok: true, output: '' }); return s; };
    const run = async (s) => {
      const o = [console.warn, console.log, console.error];
      console.warn = console.log = console.error = () => {};
      try { s._lastKernelScan = 0; await s.backfillKernelProofs(); } finally { [console.warn, console.log, console.error] = o; }
    };
    const active = () => db.prepare("SELECT * FROM alerts WHERE type = 'payout_unmined' AND status = 'active'").all();
    reset(); db.exec("DELETE FROM alerts WHERE type = 'payout_unmined'");
    const id = Number(seedWithdrawal({ status: 'confirmed', slate: 'R-SENT', priorAttempt: false, retries: 0 }));
    db.prepare('UPDATE withdrawals SET confirmed_at = ? WHERE id = ?').run(now - 7200, id);

    await run(mk());
    const first = active();
    ok('setup: one active alert for the sent-not-mined row', first.length === 1);

    await run(mk({ walletReadable: false }));
    const same = active();
    ok('wallet unreadable → the alert is neither resolved nor rewritten (unknown ≠ fixed)',
      same.length === 1 && same[0].id === first[0].id && same[0].occurrence_count === first[0].occurrence_count,
      JSON.stringify(same));

    log[0] = { ...log[0], confirmed: true };
    const sMined = mk();
    await run(sMined);
    ok('the tx mines → kernel attached and the alert RESOLVED',
      rowOf(id).kernel_excess === KX && active().length === 0 && first.length === 1 &&
      db.prepare('SELECT status FROM alerts WHERE id = ?').get(first[0].id).status === 'resolved');
    ok('…and the row now reads "mined"', typeof sMined.chainStateOf === 'function' && sMined.chainStateOf(rowOf(id)) === 'mined');

    timeline = [];
    await run(mk());
    ok('nothing left to watch → no wallet call at all', !timeline.includes('wallet'), timeline.join(','));
  }
  {
    // ── the field is admin-only ──
    const src = fs.readFileSync(path.join(APP, 'index.js'), 'utf8');
    const route = (verb, p) => {
      const start = src.indexOf(`app.${verb}('${p}'`);
      if (start < 0) return '';
      const next = src.slice(start + 10).search(/\n\s{0,4}app\.(get|post|put|delete|patch)\(/);
      return next < 0 ? src.slice(start) : src.slice(start, start + 10 + next);
    };
    const admin = route('get', '/api/admin/withdrawals');
    ok('GET /api/admin/withdrawals carries chain_state', /chain_state/.test(admin) && /secureAdmin/.test(admin));
    const hits = src.split('\n').filter((l) => /chainStateOf|chain_state/.test(l) && !/^\s*\/\//.test(l)).length;
    const inAdmin = admin.split('\n').filter((l) => /chainStateOf|chain_state/.test(l) && !/^\s*\/\//.test(l)).length;
    ok('…and no other route in index.js emits it (no public route)', hits > 0 && hits === inAdmin, `${hits} vs ${inAdmin}`);
  }

  // ═══ Tor send that fell back to a slatepack (exit 0) is NOT a payout (2026-09-25) ═══
  // grin-wallet `send -d` exits 0 when Tor delivery fails: outputs LOCKED, slatepack printed,
  // nothing finalized. The scheduler used to mark that row confirmed. Now it must (1) not confirm,
  // (2) cancel exactly that slate so the lock is released, and (3) send again on the retry.
  console.log('\n[tor-fallback] exit-0 slatepack fallback is a failed send, and its lock is released');
  {
    const FB = '5c8a4e6b-3f1d-4a92-9b7e-0d2c1f3e4a5b';
    const quiet = async (fn) => {
      const o = [console.error, console.warn]; console.error = () => {}; console.warn = () => {};
      try { await fn(); } finally { [console.error, console.warn] = o; }
    };
    // `log` is the wallet tx log the NEXT read returns; `cancels` records cancelTx calls in order.
    const fbScheduler = ({ result, log = [], cancelThrows = false }) => {
      const cancels = [];
      const s = new WithdrawalScheduler(config, {
        async getTransactions() { timeline.push('wallet'); return log; },
        async cancelTx(id) {
          timeline.push('cancel');
          cancels.push(id);
          if (cancelThrows) throw new Error('owner API down');
        },
      });
      s.walletTor = {
        async sendToTorAddress(address, amount) {
          timeline.push('send'); sends.push({ address, amount });
          return typeof result === 'function' ? result() : result;
        },
        async checkTorReachable() { return { online: true }; },
      };
      s.recordTorFee = async () => {};
      s.incentives = { maybePayJoinBonus() {} };
      return { s, cancels };
    };
    const FALLBACK = { success: false, torFallback: true, slateId: FB, error: 'Tor delivery failed: fell back to a slatepack' };

    // 1. First attempt falls back → not confirmed, cancelled, parked on the ladder, balance still held.
    reset();
    sends = []; timeline = [];
    let id = seedWithdrawal({ status: 'tor_checking', retries: 0, priorAttempt: false });
    let h = fbScheduler({ result: FALLBACK });
    await quiet(() => h.s.sendWithdrawal(id));
    ok('fallback → row is NOT confirmed (it was the bug: exit 0 read as paid)',
      rowOf(id).status === 'retry_scheduled', JSON.stringify(rowOf(id)));
    ok('…the fallback slate is cancelled by the id from the CLI output, exactly once',
      h.cancels.length === 1 && h.cancels[0] === FB, JSON.stringify(h.cancels));
    ok('…cancel happens after the send and before anything else touches the wallet',
      timeline.join(',') === 'send,cancel', timeline.join(','));
    ok('…and the miner\'s balance stays locked for the retry', Math.abs(acct().balance_locked - 100) < 1e-9, JSON.stringify(acct()));

    // 2. The retry: the wallet now shows that slate as TxSentCancelled → guard says 'absent' → send.
    db.prepare("UPDATE withdrawals SET status = 'tor_checking' WHERE id = ?").run(id);
    sends = []; timeline = [];
    h = fbScheduler({ result: { success: true }, log: [tx({ slate: FB, type: 'TxSentCancelled' })] });
    await quiet(() => h.s.sendWithdrawal(id));
    ok('retry after the cancel → guard reads "absent" and a fresh send goes out',
      sends.length === 1 && timeline[0] === 'wallet' && timeline[1] === 'send', timeline.join(','));
    ok('…and that one confirms', rowOf(id).status === 'confirmed', JSON.stringify(rowOf(id)));

    // CONTROL — why the cancel exists: the SAME retry with the lock left in place is parked, not
    // sent. This is what every fallback payout would have done forever without step 1's cancel.
    reset();
    sends = []; timeline = [];
    id = seedWithdrawal({ status: 'tor_checking', retries: 1, priorAttempt: true });
    h = fbScheduler({ result: { success: true }, log: [tx({ slate: FB, confirmed: false })] });
    await quiet(() => h.s.sendWithdrawal(id));
    ok('CONTROL: an un-cancelled fallback lock makes the retry DEFER, not send',
      sends.length === 0 && rowOf(id).status === 'retry_scheduled', JSON.stringify({ sends, row: rowOf(id) }));

    // 3. No slate id in the output → nothing cancelled (never guess by amount), still not confirmed.
    reset();
    sends = []; timeline = [];
    id = seedWithdrawal({ status: 'tor_checking', retries: 0, priorAttempt: false });
    h = fbScheduler({ result: Object.assign({}, FALLBACK, { slateId: null }) });
    await quiet(() => h.s.sendWithdrawal(id));
    ok('fallback without a slate id → no cancel attempted, row parked, not confirmed',
      h.cancels.length === 0 && rowOf(id).status === 'retry_scheduled', JSON.stringify({ c: h.cancels, row: rowOf(id) }));

    // 4. Cancel fails → still parked and never confirmed; the guard handles the leftover lock.
    reset();
    sends = []; timeline = [];
    id = seedWithdrawal({ status: 'tor_checking', retries: 0, priorAttempt: false });
    h = fbScheduler({ result: FALLBACK, cancelThrows: true });
    await quiet(() => h.s.sendWithdrawal(id));
    ok('cancel throws → row parked on the ladder, not confirmed, not crashed',
      h.cancels.length === 1 && rowOf(id).status === 'retry_scheduled', JSON.stringify(rowOf(id)));

    // 5. Exit 0 with no recognisable marker → failure, and NOTHING is cancelled (it may have posted).
    reset();
    sends = []; timeline = [];
    id = seedWithdrawal({ status: 'tor_checking', retries: 0, priorAttempt: false });
    h = fbScheduler({ result: { success: false, error: 'grin-wallet send exited 0 without reporting "Tx sent successfully"' } });
    await quiet(() => h.s.sendWithdrawal(id));
    ok('unrecognised exit-0 output → parked, not confirmed, and no cancel',
      h.cancels.length === 0 && rowOf(id).status === 'retry_scheduled', JSON.stringify({ c: h.cancels, row: rowOf(id) }));

    // CONTROL: a real success never cancels anything.
    reset();
    sends = []; timeline = [];
    id = seedWithdrawal({ status: 'tor_checking', retries: 0, priorAttempt: false });
    h = fbScheduler({ result: { success: true } });
    await quiet(() => h.s.sendWithdrawal(id));
    ok('CONTROL: a real send confirms and cancels nothing',
      rowOf(id).status === 'confirmed' && h.cancels.length === 0, JSON.stringify({ c: h.cancels, row: rowOf(id) }));
  }

  await slatepackRecoverySection();
  await stepwiseSection();
  await reviewSection();

  console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed\n`);
  cleanup();
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error(e); cleanup(); process.exit(1); });

// ═══ [sp-recover] a lost slatepack tab, and the expiry sweep's pool-wallet cancel (2026-09-25) ═══
// Three money-path changes, each shown to fail against the code it replaced:
//   · the manual rail stores its (encrypted) S1 so the owner can fetch it again; the Goblin rail's
//     PLAIN S1 never is; a settled row's copy goes with the settling claim;
//   · expiry refunds FIRST and cancels only a row it won — the old cancel-then-claim order
//     cancelled a slate a concurrent finalize had just broadcast;
//   · a failed expiry cancel is remembered (slate_cancel_pending) and retried against the wallet's
//     own tx log, never re-cancelling a cancelled tx and never cancelling a mined one.
async function slatepackRecoverySection() {
  console.log('\n[sp-recover] stored S1, refund-then-cancel, and the cancel retry');
  const quiet = async (fn) => {
    const o = [console.log, console.error, console.warn];
    console.log = console.error = console.warn = () => {};
    try { return await fn(); } finally { [console.log, console.error, console.warn] = o; }
  };
  const now = () => Math.floor(Date.now() / 1000);
  const S1 = (recips) => `BEGINSLATEPACK. ${recips.length ? 'enc:' + recips.join(',') : 'plain'} . ENDSLATEPACK.`;
  // A stateful fake Owner API: tx_lock_outputs writes a TxSent, cancel_tx turns it into
  // TxSentCancelled. `hooks` lets a case run code INSIDE a wallet call, which is where the
  // scheduler yields and where every race below actually happens.
  const fakeWallet = (hooks = {}) => {
    const w = {
      log: [], cancels: [], recips: [], n: 0,
      async initSendTx(amount) { if (hooks.init) await hooks.init(); w.n++; return { id: `sp-${seq}-${w.n}`, amt: amount, fee: '23500000' }; },
      async txLockOutputs(slate) { w.log.push({ tx_slate_id: slate.id, tx_type: 'TxSent', confirmed: false }); },
      async createSlatepackMessage(slate, recips) { w.recips.push(recips); if (hooks.message) await hooks.message(slate); return S1(recips); },
      async cancelTx(id) {
        w.cancels.push(id);
        if (hooks.cancel) await hooks.cancel(id);
        const e = w.log.find((t) => t.tx_slate_id === id);
        if (!e) throw new Error(`TransactionDoesntExist ${id}`);
        e.tx_type = 'TxSentCancelled';
      },
      async getTransactions() { if (hooks.log) return hooks.log(); return w.log.map((t) => ({ ...t })); },
    };
    return w;
  };
  const sched = (wallet, c = {}) => {
    const s = new WithdrawalScheduler({ ...config, ...c }, wallet);
    s.incentives = { maybePayJoinBonus() {} };
    return s;
  };
  const fund = (bal) => db.prepare('UPDATE miner_accounts SET balance = ?, balance_locked = 0 WHERE grin_address = ?').run(bal, ADDR);
  const seedPending = ({ slate, ageMin = 31, s1 = 'BEGINSLATEPACK. stored . ENDSLATEPACK.', method = 'slatepack', amount = 25 }) => {
    db.prepare('UPDATE miner_accounts SET balance_locked = balance_locked + ? WHERE grin_address = ?').run(amount, ADDR);
    return Number(db.prepare(
      `INSERT INTO withdrawals (grin_address, amount, fee, fee_charged, status, method, slate_id, slatepack_s1, created_at)
       VALUES (?, ?, 0, 0.04, 'slatepack_pending', ?, ?, ?, ?)`
    ).run(ADDR, amount, method, slate, s1, now() - ageMin * 60).lastInsertRowid);
  };
  const seedOwed = (slate) => Number(db.prepare(
    `INSERT INTO withdrawals (grin_address, amount, fee, fee_charged, status, method, slate_id, slate_cancel_pending, created_at)
     VALUES (?, 25, 0, 0.04, 'slatepack_expired', 'slatepack', ?, 1, ?)`
  ).run(ADDR, slate, now() - 3600).lastInsertRowid);
  const alertOf = (type) => db.prepare("SELECT * FROM alerts WHERE type = ? AND status = 'active' ORDER BY id DESC LIMIT 1").get(type);

  // ── SP1 the manual rail stores the S1 it hands out, encrypted to the owner ──
  {
    reset(); fund(30); seq++;
    const w = fakeWallet();
    const r = await quiet(() => sched(w).createSlatepackWithdrawal(ADDR, 25));
    const row = rowOf(r.withdrawal_id);
    ok('SP1. manual rail: the S1 returned to the miner is the one stored on the row',
      row.slatepack_s1 === r.slatepack && r.slatepack === S1([ADDR]), JSON.stringify({ s1: row.slatepack_s1, r: r.slatepack }));
    ok('SP1. …and it was encrypted to the payout address (recipients = [addr])',
      w.recips.length === 1 && w.recips[0].length === 1 && w.recips[0][0] === ADDR, JSON.stringify(w.recips));
  }

  // ── SP2 the Goblin rail never stores its PLAIN S1 ──
  {
    reset(); fund(30); seq++;
    const w = fakeWallet();
    const s = sched(w);
    const published = [];
    s.nostrBridge = { isEnabled: () => true, async publishSlatepack(pub, armored) { published.push(armored); } };
    const r = await quiet(() => s.createNostrWithdrawal(ADDR, 25, 'ab'.repeat(32), 'test'));
    const row = rowOf(r.withdrawal_id);
    ok('SP2. Goblin rail: plain S1 published, slatepack_s1 stays NULL',
      published.length === 1 && published[0] === S1([]) && row.slatepack_s1 === null && row.method === 'nostr',
      JSON.stringify({ published, s1: row.slatepack_s1 }));
  }

  // ── SP3 a row the sweep refunded while the wallet built its slate never gets that slate ──
  for (const rail of ['slatepack', 'nostr']) {
    reset(); fund(30); seq++;
    let s = null;
    const w = fakeWallet({
      async message() {
        // The TTL passes mid-build: the expiry sweep's guarded refund runs inside this await.
        const id = db.prepare("SELECT id FROM withdrawals WHERE grin_address = ? AND status = 'slatepack_pending'").get(ADDR).id;
        s._reverseLock(id, 'slatepack_expired', 'slatepack_pending', 'test: expired mid-build', { owesSlateCancel: false });
      },
    });
    s = sched(w);
    s.nostrBridge = { isEnabled: () => true, async publishSlatepack() { throw new Error('must not publish'); } };
    let err = null;
    await quiet(async () => {
      try {
        if (rail === 'slatepack') await s.createSlatepackWithdrawal(ADDR, 25);
        else await s.createNostrWithdrawal(ADDR, 25, 'ab'.repeat(32), 'test');
      } catch (e) { err = e; }
    });
    const row = db.prepare('SELECT * FROM withdrawals WHERE grin_address = ? ORDER BY id DESC LIMIT 1').get(ADDR);
    ok(`SP3. ${rail}: expired mid-build → the slate is cancelled, never attached, the create fails`,
      !!err && w.cancels.length === 1 && row.status === 'slatepack_expired' && row.slate_id === null && row.slatepack_s1 === null,
      JSON.stringify({ err: err && err.message, cancels: w.cancels, row }));
    ok(`SP3. ${rail}: …and the balance was refunded exactly once`,
      Math.abs(acct().balance - 30) < 1e-9 && Math.abs(acct().balance_locked) < 1e-9, JSON.stringify(acct()));
  }

  // ── SP4 refund FIRST: the wallet cancel only ever sees a row already refunded ──
  {
    reset(); db.exec("DELETE FROM alerts WHERE type IN ('slate_cancel_owed','slate_refunded_but_mined')");
    const w = fakeWallet();
    w.log.push({ tx_slate_id: 'sp4', tx_type: 'TxSent', confirmed: false });
    const id = seedPending({ slate: 'sp4' });
    let seenAtCancel = null;
    const s = sched({ ...w, async cancelTx(sid) { seenAtCancel = rowOf(id).status; return w.cancelTx(sid); } });
    await quiet(() => s.processSlatepackExpiry());
    const r = rowOf(id);
    ok('SP4. the row was already slatepack_expired when cancel_tx ran', seenAtCancel === 'slatepack_expired', String(seenAtCancel));
    ok('SP4. expiry clears the stored S1 and, with the cancel landed, owes nothing',
      r.status === 'slatepack_expired' && r.slatepack_s1 === null && r.slate_cancel_pending === 0, JSON.stringify(r));
  }

  // ── SP5 a finalize that wins a row mid-batch keeps its slate ──
  // Two stale rows in ONE batch. While the sweep awaits row A's cancel, the miner of row B
  // finalizes (the claim is synchronous, first thing in finalize). The old order had already
  // selected B and went on to cancel B's slate — a transaction that finalize was broadcasting.
  {
    reset();
    let s = null;
    let idB = null;
    const w = fakeWallet({ async cancel(sid) { if (sid === 'sp5-a') s._claimForFinalize(idB); } });
    w.log.push({ tx_slate_id: 'sp5-a', tx_type: 'TxSent', confirmed: false }, { tx_slate_id: 'sp5-b', tx_type: 'TxSent', confirmed: false });
    const idA = seedPending({ slate: 'sp5-a', ageMin: 40 });
    idB = seedPending({ slate: 'sp5-b', ageMin: 35 });
    s = sched(w);
    await quiet(() => s.processSlatepackExpiry());
    ok('SP5. the row finalize claimed mid-batch: its slate is NEVER cancelled',
      !w.cancels.includes('sp5-b') && rowOf(idB).status === 'finalizing', JSON.stringify({ cancels: w.cancels, b: rowOf(idB).status }));
    ok('SP5. …row A still expired + cancelled, and only A was refunded',
      rowOf(idA).status === 'slatepack_expired' && w.cancels.join(',') === 'sp5-a' &&
      Math.abs(acct().balance - 25) < 1e-9 && Math.abs(acct().balance_locked - 25) < 1e-9, JSON.stringify({ c: w.cancels, a: acct() }));
  }

  // ── SP6 a failed expiry cancel is remembered, refund untouched ──
  {
    reset();
    const w = fakeWallet({ async cancel() { throw new Error("Can't contact running Grin node. Not Cancelling."); } });
    w.log.push({ tx_slate_id: 'sp6', tx_type: 'TxSent', confirmed: false });
    const id = seedPending({ slate: 'sp6' });
    await quiet(() => sched(w).processSlatepackExpiry());
    ok('SP6. node down at expiry: refunded anyway, slate_cancel_pending = 1',
      rowOf(id).status === 'slatepack_expired' && rowOf(id).slate_cancel_pending === 1 && Math.abs(acct().balance - 25) < 1e-9,
      JSON.stringify({ r: rowOf(id), a: acct() }));
  }

  // ── SP7 the retry sweep: one decision per tx-log state ──
  {
    reset(); db.exec("DELETE FROM alerts WHERE type IN ('slate_cancel_owed','slate_refunded_but_mined')");
    const w = fakeWallet();
    w.log.push(
      { tx_slate_id: 'r-locked', tx_type: 'TxSent', confirmed: false },
      { tx_slate_id: 'r-cancelled', tx_type: 'TxSentCancelled', confirmed: false },
      { tx_slate_id: 'r-mined', tx_type: 'TxSent', confirmed: true });
    const locked = seedOwed('r-locked');
    const cancelled = seedOwed('r-cancelled');
    const absent = seedOwed('r-absent');
    const mined = seedOwed('r-mined');
    // Never selected: the flag on a row that is not slatepack_expired means nothing to this sweep.
    const other = Number(db.prepare(
      `INSERT INTO withdrawals (grin_address, amount, fee_charged, status, method, slate_id, slate_cancel_pending)
       VALUES (?, 25, 0.04, 'confirmed', 'slatepack', 'r-other', 1)`).run(ADDR).lastInsertRowid);
    await quiet(() => sched(w).retryExpiredSlateCancels());
    ok('SP7. still-locked TxSent → cancel_tx, flag cleared', w.cancels.includes('r-locked') && rowOf(locked).slate_cancel_pending === 0,
      JSON.stringify(w.cancels));
    ok('SP7. already cancelled / absent from the wallet → flag cleared WITHOUT calling cancel_tx again',
      !w.cancels.includes('r-cancelled') && !w.cancels.includes('r-absent') &&
      rowOf(cancelled).slate_cancel_pending === 0 && rowOf(absent).slate_cancel_pending === 0, JSON.stringify(w.cancels));
    ok('SP7. CONFIRMED on chain → never cancelled, critical alert raised',
      !w.cancels.includes('r-mined') && rowOf(mined).slate_cancel_pending === 0 &&
      !!alertOf('slate_refunded_but_mined') && alertOf('slate_refunded_but_mined').level === 'critical',
      JSON.stringify({ c: w.cancels, a: alertOf('slate_refunded_but_mined') }));
    ok('SP7. a flagged row in any other status is never touched', !w.cancels.includes('r-other') && rowOf(other).slate_cancel_pending === 1);
    ok('SP7. exactly one cancel_tx in the whole pass', w.cancels.length === 1, JSON.stringify(w.cancels));
  }

  // ── SP8 a node outage: quiet, then one rolling alert, then resolved ──
  {
    reset(); db.exec("DELETE FROM alerts WHERE type = 'slate_cancel_owed'");
    let down = true;
    const w = fakeWallet({ async cancel() { if (down) throw new Error("Can't contact running Grin node. Not Cancelling."); } });
    w.log.push({ tx_slate_id: 'o-1', tx_type: 'TxSent', confirmed: false }, { tx_slate_id: 'o-2', tx_type: 'TxSent', confirmed: false });
    const a = seedOwed('o-1'); const b = seedOwed('o-2');
    const s = sched(w);
    for (let i = 0; i < 4; i++) await quiet(() => s.retryExpiredSlateCancels());
    ok('SP8. four failing ticks: no alert yet, and each tick stopped at its FIRST failure',
      !alertOf('slate_cancel_owed') && w.cancels.length === 4 && w.cancels.every((x) => x === 'o-1'), JSON.stringify(w.cancels));
    await quiet(() => s.retryExpiredSlateCancels());
    const al = alertOf('slate_cancel_owed');
    ok('SP8. the fifth failing tick raises ONE warning naming both payouts',
      !!al && al.level === 'warning' && al.message.includes(`#${a}`) && al.message.includes(`#${b}`), JSON.stringify(al));
    down = false;
    await quiet(() => s.retryExpiredSlateCancels());
    ok('SP8. node back: both cancelled, both flags cleared',
      rowOf(a).slate_cancel_pending === 0 && rowOf(b).slate_cancel_pending === 0, JSON.stringify([rowOf(a), rowOf(b)]));
    await quiet(() => s.retryExpiredSlateCancels());
    ok('SP8. …and the next clean tick resolves the alert', !alertOf('slate_cancel_owed'));
  }

  // ── SP9 an unreadable wallet log decides nothing ──
  {
    reset();
    const w = fakeWallet({ async log() { throw new Error('owner API down'); } });
    const id = seedOwed('u-1');
    await quiet(() => sched(w).retryExpiredSlateCancels());
    ok('SP9. tx log unreadable → no cancel, flag kept', w.cancels.length === 0 && rowOf(id).slate_cancel_pending === 1);
  }

  // ── SP10 a finalized payout drops its stored S1 in the confirm claim ──
  {
    reset(); fund(0);
    const id = seedPending({ slate: 'sp10', ageMin: 1 });
    const s = sched({
      async slateFromSlatepackMessage() { return { id: 'sp10' }; },
      async finalizeTx(slate) { return slate; },
      async postTx() {},
    });
    const r = await quiet(() => s.finalizeSlatepackWithdrawal(ADDR, id, 'BEGINSLATEPACK. s2 . ENDSLATEPACK.'));
    ok('SP10. finalize → confirmed, slatepack_s1 cleared', r && r.status === 'confirmed' &&
      rowOf(id).status === 'confirmed' && rowOf(id).slatepack_s1 === null, JSON.stringify(rowOf(id)));
  }
  reset();
  db.exec("DELETE FROM alerts WHERE type IN ('slate_cancel_owed','slate_refunded_but_mined')");
}

// ═══ [stepwise] F5 (Part 6) — step-by-step Tor send, design §8.1 ═════════════════════════════
// The REAL WalletAPI with only its wire boundary (_encryptedCall) faked, so what is asserted is
// what goes to grin-wallet: named params, the real send lock. The fake wallet is STATEFUL like the
// real one: tx_lock_outputs writes a TxSent, cancel_tx rewrites it as TxSentCancelled (and refuses
// a slate it never locked with TransactionDoesntExist). deliverSlate is faked at the scheduler.
// One test per row of the failure matrix (§8.1.3); each is shown to fail with its guard removed.
async function stepwiseSection() {
  console.log('\n[stepwise] F5 — step-by-step Tor send (design §8.1)');
  const WalletAPI = require(path.join(APP, 'lib/wallet.js'));
  const ADDR2 = 'tgrin1zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz';
  const U = (n) => `0000${String(n).padStart(4, '0')}-0000-4000-8000-000000000000`;
  const FEE_NANO = '23500000';
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const quiet = async (fn) => {
    const o = [console.log, console.error, console.warn];
    const errs = [];
    console.log = () => {}; console.warn = () => {}; console.error = (...a) => errs.push(a.join(' '));
    try { await fn(); } finally { [console.log, console.error, console.warn] = o; }
    return errs;
  };
  const MONEY = ['init_send_tx', 'tx_lock_outputs', 'finalize_tx', 'post_tx', 'cancel_tx', 'deliver'];
  const order = (st) => st.calls.filter((c) => MONEY.includes(c.method)).map((c) => c.method).join(',');
  const notes = (id) => db.prepare('SELECT note FROM withdrawal_events WHERE withdrawal_id = ? ORDER BY id').all(id).map((e) => e.note || '');
  const ledger = () => db.prepare('SELECT COUNT(*) c FROM balance_log').get().c;
  const debits = (id) => db.prepare("SELECT COUNT(*) c FROM balance_log WHERE reference_id = ? AND event_type = 'debit' AND reference_type = 'withdrawal'").get(id).c;
  const backdate = (id, s = 3600) => db.prepare('UPDATE withdrawal_events SET created_at = created_at - ? WHERE withdrawal_id = ?').run(s, id);
  const activeAlert = () => db.prepare("SELECT level, message FROM alerts WHERE type = 'payout_tor_stepwise' AND status = 'active'").get() || null;
  db.exec('DELETE FROM payout_control');
  let slateSeq = 0;

  // A wire-level fake grin-wallet. `hooks[method]` may throw, or return a value to override;
  // `delay[method]` (ms) holds the reply. st.calls records every call with a snapshot of st.id's row.
  function stepWallet({ log = [], hooks = {}, delay = {} } = {}) {
    const w = new WalletAPI({ network: 'testnet', wallet_dir: '/nonexistent' });
    w.sessionOpen = true; w.aesKey = Buffer.alloc(32); w.token = 'TOKEN';
    const st = { log, calls: [], id: null, w };
    let logId = 1000;
    w._encryptedCall = async (method, params) => {
      const p = JSON.parse(JSON.stringify(params));
      st.calls.push({ method, params: p, row: st.id ? rowOf(st.id) : null });
      if (delay[method]) await sleep(delay[method]);
      if (hooks[method]) {
        const r = await hooks[method](p, st);
        if (r !== undefined) return r;
      }
      switch (method) {
        case 'retrieve_txs': return [true, st.log];
        case 'init_send_tx':
          return { ver: '4:3', id: U(++slateSeq), sta: 'S1', amt: String(p.args.amount), fee: FEE_NANO,
                   sigs: [{ xs: '02' + 'aa'.repeat(32), nonce: '02' + 'bb'.repeat(32) }] };
        case 'tx_lock_outputs':
          st.log.push({ id: logId++, tx_slate_id: p.slate.id, tx_type: 'TxSent', confirmed: false,
            creation_ts: new Date().toISOString(), amount_debited: String(Number(p.slate.amt) + Number(FEE_NANO)),
            amount_credited: '0', fee: FEE_NANO });
          return null;
        case 'finalize_tx': return Object.assign({}, p.slate, { sta: 'S3', tx: { kernel: 'k' } });
        case 'post_tx': return null;
        case 'cancel_tx': {
          const e = st.log.find((t) => t.tx_slate_id === p.tx_slate_id && t.tx_type === 'TxSent');
          if (!e) throw new Error(`Wallet error: {"TransactionDoesntExist":"${p.tx_slate_id}"}`);
          e.tx_type = 'TxSentCancelled';
          return null;
        }
        case 'create_slatepack_message': return 'BEGINSLATEPACK. x. ENDSLATEPACK.';
        default: return null;
      }
    };
    return st;
  }
  function stepScheduler(st, { deliver = null, mode = 'stepwise', withWallet = true } = {}) {
    const s = new WithdrawalScheduler(Object.assign({}, config, { tor_send_mode: mode }), withWallet ? st.w : null);
    s.walletTor = {
      async deliverSlate(addr, slate, o) {
        st.calls.push({ method: 'deliver', addr, slate, o, row: st.id ? rowOf(st.id) : null });
        return deliver ? deliver(slate) : { ok: true, slate: Object.assign({}, slate, { sta: 'S2' }) };
      },
      async sendToTorAddress(address, amount) { st.calls.push({ method: 'cli-send' }); sends.push({ address, amount }); return { success: true }; },
      async checkTorReachable() { return { online: true }; },
    };
    s.recordTorFee = async () => {};
    s.incentives = { maybePayJoinBonus() {} };
    return s;
  }
  // A fresh row in tor_checking with no prior tor_sending event (a first attempt).
  const fresh = (opts = {}) => {
    reset(); sends = [];
    return seedWithdrawal(Object.assign({ status: 'tor_checking', retries: 0, priorAttempt: false }, opts));
  };
  const MINER_OFF = { ok: false, ourSide: false, requestWritten: false, reason: 'onion_unreachable', detail: 'host unreachable' };

  // ── S1 happy path ──
  {
    const id = fresh();
    const st = stepWallet(); st.id = id;
    const s = stepScheduler(st);
    const froze = [];
    s.isFrozen = () => { froze.push((rowOf(id) || {}).tor_step || ''); return false; };
    await quiet(() => s.checkTorAndSend(rowOf(id)));
    const by = (m) => st.calls.find((c) => c.method === m) || {};
    ok('S1. call order init → lock → deliver → finalize → post',
      order(st) === 'init_send_tx,tx_lock_outputs,deliver,finalize_tx,post_tx', order(st));
    const keys = (m) => Object.keys(by(m).params || {}).sort().join(',');
    ok('S1. every Owner call is NAMED with exactly its v3 parameter names',
      keys('init_send_tx') === 'args,token' && keys('tx_lock_outputs') === 'slate,token' &&
      keys('finalize_tx') === 'slate,token' && keys('post_tx') === 'fluff,slate,token',
      ['init_send_tx', 'tx_lock_outputs', 'finalize_tx', 'post_tx'].map(keys).join(' | '));
    const a = (by('init_send_tx').params || {}).args || {};
    ok('S1. init: payment_proof_recipient_address = the miner address, ttl_blocks null, net amount',
      a.payment_proof_recipient_address === ADDR && a.ttl_blocks === null && a.amount === 99960000000, JSON.stringify(a));
    const lockRow = by('tx_lock_outputs').row || {};
    ok('S1. slate_id is ALREADY in the DB when tx_lock_outputs is called (tor_step initiated)',
      by('tx_lock_outputs').params && lockRow.slate_id === by('tx_lock_outputs').params.slate.id && lockRow.tor_step === 'initiated',
      JSON.stringify(lockRow));
    ok('S1. tor_step walks claimed → initiated → locked → delivering → finalizing → posting',
      (by('init_send_tx').row || {}).tor_step === 'claimed' && lockRow.tor_step === 'initiated' && froze[1] === 'locked' &&
      (by('deliver').row || {}).tor_step === 'delivering' && (by('finalize_tx').row || {}).tor_step === 'finalizing' &&
      (by('post_tx').row || {}).tor_step === 'posting', JSON.stringify(froze));
    ok('S1. the freeze is checked at claim, before delivery and before post', froze.length === 3 && froze[2] === 'finalizing', JSON.stringify(froze));
    ok('S1. tor_final_slate held S3 while posting', /"sta":"S3"/.test((by('post_tx').row || {}).tor_final_slate || ''));
    ok('S1. post_tx got the finalized S3 with fluff true',
      by('post_tx').params && by('post_tx').params.slate.sta === 'S3' && by('post_tx').params.fluff === true);
    ok('S1. deliver got the S1 slate and the miner address', by('deliver').addr === ADDR && by('deliver').slate && by('deliver').slate.sta === 'S1');
    const r = rowOf(id);
    ok('S1. ends confirmed, fee from the slate, tor_final_slate cleared',
      r.status === 'confirmed' && Math.abs(r.fee - 0.0235) < 1e-12 && r.tor_final_slate === null, JSON.stringify(r));
    const n = notes(id);
    ok('S1. the journal: claim, slate created, posting, posted',
      n[0] === 'stepwise: claim' && /^slate: [0-9a-f-]{36} created \(stepwise\)$/.test(n[1]) &&
      /^stepwise: posting slate /.test(n[2]) && n[3] === 'stepwise: posted', JSON.stringify(n));
    ok('S1. the lock was released and the miner debited once', acct().balance_locked === 0 && debits(id) === 1, JSON.stringify(acct()));
  }

  // ── S2 NotEnoughFunds at init ──
  {
    const id = fresh();
    const st = stepWallet({ hooks: { init_send_tx: () => { throw new Error('Wallet error: {"NotEnoughFunds":{"available":1,"needed":2}}'); } } });
    st.id = id;
    await quiet(() => stepScheduler(st).checkTorAndSend(rowOf(id)));
    const r = rowOf(id);
    ok('S2. NotEnoughFunds at init → F3 shortfall: retry_scheduled, retry_count 0, reason pool_wallet_short',
      r.status === 'retry_scheduled' && r.retry_count === 0 && r.retry_reason === 'pool_wallet_short' &&
      /^shortfall: /.test(notes(id).slice(-1)[0]), JSON.stringify({ r, n: notes(id) }));
    ok('S2. …no lock and no cancel', order(st) === 'init_send_tx', order(st));
  }

  // ── S3 lock throws ──
  {
    const id = fresh();
    const st = stepWallet({ hooks: { tx_lock_outputs: () => { throw new Error('Wallet error: "lmdb busy"'); } } });
    st.id = id;
    await quiet(() => stepScheduler(st).checkTorAndSend(rowOf(id)));
    const r = rowOf(id);
    const cancel = st.calls.find((c) => c.method === 'cancel_tx');
    ok('S3. lock throws → cancel(S) is tried with the saved slate id, NAMED',
      cancel && cancel.params.tx_slate_id === r.slate_id && cancel.params.tx_id === null, JSON.stringify(cancel && cancel.params));
    ok('S3. …TransactionDoesntExist at "initiated" counts as never-locked → a COUNTED retry',
      r.status === 'retry_scheduled' && r.retry_count === 1 && r.retry_reason === null, JSON.stringify(r));
    ok('S3. …and nothing was delivered', !/deliver/.test(order(st)), order(st));
  }

  // ── S4 delivery fails on the miner's side (either requestWritten) ──
  for (const written of [false, true]) {
    const id = fresh();
    const st = stepWallet(); st.id = id;
    const s = stepScheduler(st, { deliver: () => Object.assign({}, MINER_OFF, { requestWritten: written }) });
    await quiet(() => s.checkTorAndSend(rowOf(id)));
    const r = rowOf(id);
    ok(`S4. miner-side delivery failure (requestWritten ${written}) → cancel, then a COUNTED retry; no finalize/post`,
      order(st) === 'init_send_tx,tx_lock_outputs,deliver,cancel_tx' && r.status === 'retry_scheduled' && r.retry_count === 1,
      `${order(st)} ${JSON.stringify(r)}`);
    const c = st.calls.find((x) => x.method === 'cancel_tx');
    ok(`S4. …the cancel ran while the row was still tor_sending`, !!c && (c.row || {}).status === 'tor_sending');
    ok(`S4. …the wallet's TxSent is now cancelled`, st.log.length === 1 && st.log.every((t) => t.tx_type === 'TxSentCancelled'));
  }

  // ── S5 our own tor is down ──
  {
    const TOR_DOWN = { ok: false, ourSide: true, requestWritten: false, reason: 'tor_unavailable', detail: 'ECONNREFUSED' };
    let id = fresh();
    let st = stepWallet(); st.id = id;
    await quiet(() => stepScheduler(st, { deliver: () => TOR_DOWN }).checkTorAndSend(rowOf(id)));
    let r = rowOf(id);
    ok('S5. ourSide → cancel, then UNCOUNTED pool_tor_unavailable (retry_count 0, ~15 min, tor-down: note)',
      /cancel_tx$/.test(order(st)) && r.status === 'retry_scheduled' && r.retry_count === 0 &&
      r.retry_reason === 'pool_tor_unavailable' && Math.abs(r.next_retry_at - (Date.now() / 1000 + 900)) < 30 &&
      /^tor-down: pool tor unavailable, retry 1\/24 \(not counted\)/.test(notes(id).slice(-1)[0]),
      JSON.stringify({ r, n: notes(id).slice(-1) }));
    id = fresh();
    for (let i = 0; i < 24; i++) {
      db.prepare("INSERT INTO withdrawal_events (withdrawal_id, from_status, to_status, triggered_by, note) VALUES (?, 'tor_sending', 'retry_scheduled', 'scheduler', 'tor-down: x')").run(id);
    }
    st = stepWallet(); st.id = id;
    await quiet(() => stepScheduler(st, { deliver: () => TOR_DOWN }).checkTorAndSend(rowOf(id)));
    r = rowOf(id);
    ok('S5. the 25th tor-down takes a rung (retry_count 1, 6 h)',
      r.status === 'retry_scheduled' && r.retry_count === 1 && Math.abs(r.next_retry_at - (Date.now() / 1000 + 21600)) < 30,
      JSON.stringify(r));
  }

  // ── S6 cancel fails (node down) → stays tor_sending; a later sweep cancels and requeues ──
  {
    const id = fresh();
    let nodeDown = true;
    const st = stepWallet({ hooks: { cancel_tx: () => { if (nodeDown) throw new Error("Wallet error: \"Can't contact running Grin node. Not Cancelling.\""); } } });
    st.id = id;
    const s = stepScheduler(st, { deliver: () => MINER_OFF });
    const bal = JSON.stringify(acct()); const led = ledger();
    await quiet(() => s.checkTorAndSend(rowOf(id)));
    let r = rowOf(id);
    ok('S6. cancel fails → the row STAYS tor_sending at its step, never retry_scheduled',
      r.status === 'tor_sending' && r.tor_step === 'delivering' && r.retry_count === 0, JSON.stringify(r));
    ok('S15. …no balance or ledger change while parked', JSON.stringify(acct()) === bal && ledger() === led);
    ok('S6. …and its TxSent is still live (nothing pretended otherwise)', st.log.some((t) => t.tx_type === 'TxSent'));
    nodeDown = false;
    backdate(id);
    await quiet(() => s.reclaimStaleTorSending());
    r = rowOf(id);
    ok("S6. a later sweep cancels it, then requeues to tor_checking (no rung — the pool's fault)",
      r.status === 'tor_checking' && r.retry_count === 0 && st.log.every((t) => t.tx_type === 'TxSentCancelled') &&
      /^stepwise: requeued — slate .* cancelled/.test(notes(id).slice(-1)[0]), JSON.stringify({ r, n: notes(id).slice(-1) }));
  }

  // ── S7 finalize throws ──
  {
    const id = fresh();
    const st = stepWallet({ hooks: { finalize_tx: () => { throw new Error('Wallet error: "payment proof signature invalid"'); } } });
    st.id = id;
    await quiet(() => stepScheduler(st).checkTorAndSend(rowOf(id)));
    const r = rowOf(id);
    ok('S7. finalize throws → cancel, then a counted retry; post never called',
      order(st) === 'init_send_tx,tx_lock_outputs,deliver,finalize_tx,cancel_tx' && r.status === 'retry_scheduled' && r.retry_count === 1,
      `${order(st)} ${JSON.stringify(r)}`);
  }

  // ── S8 post throws → committed: never cancelled; the sweep posts again, rate-limited, freeze-aware ──
  {
    const id = fresh();
    db.exec("DELETE FROM alerts WHERE type = 'payout_tor_stepwise'");
    let postFails = true;
    const st = stepWallet({ hooks: { post_tx: () => { if (postFails) throw new Error('HTTP 500: node refused'); } } });
    st.id = id;
    const s = stepScheduler(st);
    const bal = JSON.stringify(acct()); const led = ledger();
    await quiet(() => s.checkTorAndSend(rowOf(id)));
    let r = rowOf(id);
    ok('S8. post throws → stays tor_sending/posting with the S3 stored, NOT cancelled',
      r.status === 'tor_sending' && r.tor_step === 'posting' && /"sta":"S3"/.test(r.tor_final_slate || '') &&
      !/cancel_tx/.test(order(st)), `${order(st)} ${JSON.stringify(r)}`);
    ok('S15. …no balance or ledger change while committed-but-unposted', JSON.stringify(acct()) === bal && ledger() === led);
    backdate(id);
    const posts = () => st.calls.filter((c) => c.method === 'post_tx');
    await quiet(() => s.reclaimStaleTorSending());
    ok('S8. the sweep posts the stored S3 again (the identical slate)', posts().length === 2 &&
      JSON.stringify(posts()[1].params.slate) === r.tor_final_slate, `posts=${posts().length}`);
    ok('S8. …journaled as "stepwise: repost … failed", row still posting, never cancelled',
      rowOf(id).status === 'tor_sending' && /^stepwise: repost slate .* 1\/24 — failed/.test(notes(id).slice(-1)[0]) &&
      !/cancel_tx/.test(order(st)), notes(id).slice(-1)[0]);
    ok('S8. …and a warning payout_tor_stepwise alert is up', (activeAlert() || {}).level === 'warning', JSON.stringify(activeAlert()));
    await quiet(() => s.reclaimStaleTorSending());
    ok('S8. a second sweep inside 5 min does NOT post again (rate)', posts().length === 2, `posts=${posts().length}`);
    db.prepare("UPDATE withdrawal_events SET created_at = created_at - 600 WHERE withdrawal_id = ? AND note LIKE 'stepwise: repost%'").run(id);
    s.isFrozen = () => true;
    await quiet(() => s.reclaimStaleTorSending());
    ok('S8. while frozen the sweep does not post', posts().length === 2, `posts=${posts().length}`);
    s.isFrozen = () => false;
    postFails = false;
    await quiet(() => s.reclaimStaleTorSending());
    r = rowOf(id);
    ok('S8. an OK post settles it: confirmed, S3 cleared', posts().length === 3 && r.status === 'confirmed' && r.tor_final_slate === null, JSON.stringify(r));
    await quiet(() => s.reclaimStaleTorSending());
    ok('S8. …exactly once (one debit, no further post)', posts().length === 3 && debits(id) === 1, `posts=${posts().length} debits=${debits(id)}`);
    ok('S8. …and the alert resolved', !activeAlert(), JSON.stringify(activeAlert()));
  }

  // ── S9 freeze before delivery / before post → cancel, then requeue (no rung) ──
  for (const [at, label] of [[2, 'delivery'], [3, 'post']]) {
    const id = fresh();
    const st = stepWallet(); st.id = id;
    const s = stepScheduler(st);
    let n = 0;
    s.isFrozen = () => (++n === at);
    await quiet(() => s.checkTorAndSend(rowOf(id)));
    const r = rowOf(id);
    const want = at === 2 ? 'init_send_tx,tx_lock_outputs,cancel_tx' : 'init_send_tx,tx_lock_outputs,deliver,finalize_tx,cancel_tx';
    ok(`S9. freeze before ${label} → cancel, then back to tor_checking with retry_count unchanged`,
      order(st) === want && r.status === 'tor_checking' && r.retry_count === 0 &&
      /^stepwise: requeued — slate .* cancelled \(payouts frozen before /.test(notes(id).slice(-1)[0]),
      `${order(st)} ${JSON.stringify(r)} ${notes(id).slice(-1)}`);
  }

  // ── S10 the sweep, per tor_step, plus both contradiction rows and a live row ──
  {
    reset();
    db.exec("DELETE FROM alerts WHERE type = 'payout_tor_stepwise'");
    const st = stepWallet();
    const mk = (step, slate, finalSlate = null) => {
      const id = seedWithdrawal({ status: 'tor_sending', retries: 0, priorAttempt: false, slate });
      const old = Math.floor(Date.now() / 1000) - 3600;
      db.prepare("INSERT INTO withdrawal_events (withdrawal_id, from_status, to_status, triggered_by, note, created_at) VALUES (?, 'tor_checking', 'tor_sending', 'scheduler', 'stepwise: claim', ?)").run(id, old);
      db.prepare('UPDATE withdrawals SET tor_step = ?, tor_final_slate = ? WHERE id = ?').run(step, finalSlate, id);
      return id;
    };
    const log = (slate, type, confirmed = false) => st.log.push({ id: 1, tx_slate_id: slate, tx_type: type, confirmed,
      creation_ts: new Date().toISOString(), amount_debited: '99983500000', amount_credited: '0', fee: FEE_NANO });
    const S3 = JSON.stringify({ id: U(9006), sta: 'S3' });
    const ids = {
      claimed: mk('claimed', null),
      initiatedAbsent: mk('initiated', U(9001)),
      lockedLive: mk('locked', U(9002)),
      deliveringCancelled: mk('delivering', U(9003)),
      finalizingMined: mk('finalizing', U(9004)),
      postingLive: mk('posting', U(9006), S3),
      postingCancelled: mk('posting', U(9007), S3),
      postingAbsent: mk('posting', U(9008), S3),
      live: mk('locked', U(9009)),
    };
    log(U(9002), 'TxSent'); log(U(9003), 'TxSentCancelled'); log(U(9004), 'TxSent', true);
    log(U(9006), 'TxSent'); log(U(9007), 'TxSentCancelled'); log(U(9009), 'TxSent');
    // A CLI attempt (a claim with no marker) carrying a stale tor_step left by an old stepwise one.
    const cli = seedWithdrawal({ status: 'tor_sending', retries: 0, priorAttempt: true, slate: U(9010) });
    db.prepare("UPDATE withdrawals SET tor_step = 'posting', tor_final_slate = ? WHERE id = ?").run(S3, cli);
    const s = stepScheduler(st);
    s._liveStepwise.add(Number(ids.live));
    const ledBefore = {};
    for (const k of ['postingCancelled', 'postingAbsent', 'live']) ledBefore[k] = db.prepare('SELECT COUNT(*) c FROM balance_log WHERE reference_id = ?').get(ids[k]).c;
    await quiet(() => s.reclaimStaleTorSending());
    const stat = (k) => rowOf(ids[k]).status;
    const cancels = st.calls.filter((c) => c.method === 'cancel_tx').map((c) => c.params.tx_slate_id);
    const posted = st.calls.filter((c) => c.method === 'post_tx').map((c) => c.params.slate.id);
    ok('S10. claimed → tor_checking with no cancel', stat('claimed') === 'tor_checking', stat('claimed'));
    ok('S10. initiated + slate absent (never locked) → tor_checking, no cancel',
      stat('initiatedAbsent') === 'tor_checking' && !cancels.includes(U(9001)), stat('initiatedAbsent'));
    ok('S10. locked + live TxSent → cancel, then tor_checking', stat('lockedLive') === 'tor_checking' && cancels.includes(U(9002)), stat('lockedLive'));
    ok('S10. delivering + already cancelled → tor_checking without another cancel',
      stat('deliveringCancelled') === 'tor_checking' && !cancels.includes(U(9003)), stat('deliveringCancelled'));
    ok('S10. finalizing + CONFIRMED in the log → confirmed (chain evidence wins)', stat('finalizingMined') === 'confirmed', stat('finalizingMined'));
    ok('S10. posting + live TxSent → the stored S3 is posted again → confirmed',
      stat('postingLive') === 'confirmed' && posted.includes(U(9006)), `${stat('postingLive')} ${posted}`);
    ok('S10. CONTRADICTION posting + cancelled → parked in tor_sending, never cancelled or posted',
      stat('postingCancelled') === 'tor_sending' && !cancels.includes(U(9007)) && !posted.includes(U(9007)));
    ok('S10. CONTRADICTION posting + absent → parked in tor_sending, never posted',
      stat('postingAbsent') === 'tor_sending' && !posted.includes(U(9008)));
    const alert = activeAlert() || {};
    ok('S10. …both raise ONE critical payout_tor_stepwise alert naming them', alert.level === 'critical' &&
      String(alert.message).includes(`#${ids.postingCancelled}:`) && String(alert.message).includes(`#${ids.postingAbsent}:`), JSON.stringify(alert));
    ok('S10. a row whose attempt is live in this process is never touched',
      stat('live') === 'tor_sending' && !cancels.includes(U(9009)), stat('live'));
    ok('S10. a CLI attempt with a stale tor_step goes to the CLI branch (absent → ladder), never reposted',
      rowOf(cli).status === 'retry_scheduled' && rowOf(cli).retry_count === 1 && !posted.includes(U(9010)), JSON.stringify(rowOf(cli)));
    const ledAfter = {};
    for (const k of ['postingCancelled', 'postingAbsent', 'live']) ledAfter[k] = db.prepare('SELECT COUNT(*) c FROM balance_log WHERE reference_id = ?').get(ids[k]).c;
    ok('S15. the parked and live rows moved no money', JSON.stringify(ledBefore) === JSON.stringify(ledAfter),
      `${JSON.stringify(ledBefore)} → ${JSON.stringify(ledAfter)}`);
  }

  // ── S11 re-attempt guard (§8.1.5) ──
  {
    const prior = (entries, { cliHistory = false } = {}) => {
      const id = fresh({ slate: U(9101) });
      const ev = db.prepare('INSERT INTO withdrawal_events (withdrawal_id, from_status, to_status, triggered_by, note) VALUES (?, ?, ?, \'scheduler\', ?)');
      if (cliHistory) ev.run(id, 'tor_checking', 'tor_sending', null);
      ev.run(id, 'tor_checking', 'tor_sending', 'stepwise: claim');
      ev.run(id, 'tor_sending', 'tor_sending', `slate: ${U(9101)} created (stepwise)`);
      ev.run(id, 'tor_sending', 'tor_checking', 'stepwise: requeued — x');
      const st = stepWallet({ log: entries });
      st.id = id;
      return { id, st, s: stepScheduler(st) };
    };
    const ent = (slate, type, confirmed = false, net = 99.96) => ({ id: 7, tx_slate_id: slate, tx_type: type, confirmed,
      creation_ts: new Date().toISOString(), amount_debited: String(Math.round(net * 1e9) + Number(FEE_NANO)),
      amount_credited: '0', fee: FEE_NANO });
    let h = prior([ent(U(9101), 'TxSent', false)]);
    const errs = await quiet(() => h.s.checkTorAndSend(rowOf(h.id)));
    ok('S11. a journaled slate still an UNCONFIRMED TxSent → deferred, no new init',
      rowOf(h.id).status === 'retry_scheduled' && rowOf(h.id).retry_count === 0 && /^deferred: /.test(notes(h.id).slice(-1)[0]) &&
      !/init_send_tx/.test(order(h.st)), `${order(h.st)} ${notes(h.id).slice(-1)}`);
    ok('S11. …and it says the invariant is broken, loudly', errs.some((e) => /breaks the invariant/.test(e)), errs.join(' | '));
    h = prior([ent(U(9101), 'TxSent', true)]);
    await quiet(() => h.s.checkTorAndSend(rowOf(h.id)));
    ok('S11. a journaled slate CONFIRMED → confirmed, no new init',
      rowOf(h.id).status === 'confirmed' && !/init_send_tx/.test(order(h.st)), order(h.st));
    h = prior([ent(U(9101), 'TxSentCancelled')]);
    await quiet(() => h.s.checkTorAndSend(rowOf(h.id)));
    ok('S11. every journaled slate cancelled → a NEW slate goes out',
      rowOf(h.id).status === 'confirmed' && order(h.st).startsWith('init_send_tx') && rowOf(h.id).slate_id !== U(9101),
      `${order(h.st)} ${rowOf(h.id).slate_id}`);
    // Mixed history: an earlier CLI attempt never captured its slate id, and the wallet holds an
    // unconfirmed send of exactly this payout's net. The stepwise slate is dead, but the CLI one
    // may be live — so _priorSendLanded's amount branch must be asked too.
    h = prior([ent(U(9101), 'TxSentCancelled'), ent('cli-slate-uncaptured', 'TxSent', false)], { cliHistory: true });
    await quiet(() => h.s.checkTorAndSend(rowOf(h.id)));
    ok('S11. mixed CLI history: the CLI amount match is consulted → unconfirmed → deferred, no new init',
      rowOf(h.id).status === 'retry_scheduled' && !/init_send_tx/.test(order(h.st)), `${order(h.st)} ${JSON.stringify(rowOf(h.id))}`);
    h = prior([ent(U(9101), 'TxSentCancelled')]);
    h.st.w._encryptedCall = ((orig) => async (m, p, o) => {
      if (m === 'retrieve_txs') throw new Error('owner API down');
      return orig(m, p, o);
    })(h.st.w._encryptedCall);
    await quiet(() => h.s.checkTorAndSend(rowOf(h.id)));
    ok('S11. an unreadable tx log before a re-attempt → parked (deferred), never a blind new slate',
      rowOf(h.id).status === 'retry_scheduled' && !/init_send_tx/.test(order(h.st)), order(h.st));
  }

  // ── S12 markFailed (last rung) on a stepwise row ──
  {
    const id = fresh({ retries: 4 });
    const st = stepWallet(); st.id = id;
    await quiet(() => stepScheduler(st, { deliver: () => MINER_OFF }).checkTorAndSend(rowOf(id)));
    ok('S12. last rung: the failed delivery is cancelled, markFailed reads it as absent → reversed',
      rowOf(id).status === 'tor_failed' && acct().balance_locked === 0 && acct().balance === 100,
      JSON.stringify({ r: rowOf(id), a: acct() }));
    const id2 = fresh({ retries: 4, slate: U(9201) });
    const st2 = stepWallet({ log: [{ id: 9, tx_slate_id: U(9201), tx_type: 'TxSent', confirmed: false,
      creation_ts: new Date().toISOString(), amount_debited: '99983500000', amount_credited: '0', fee: FEE_NANO }] });
    const s2 = stepScheduler(st2);
    db.prepare("UPDATE withdrawals SET status = 'tor_sending' WHERE id = ?").run(id2);
    await quiet(() => s2.markFailed(id2));
    ok('S12. last rung with the latest slate still an unconfirmed TxSent → deferred, NOT refunded',
      rowOf(id2).status === 'retry_scheduled' && acct().balance_locked === 100, JSON.stringify({ r: rowOf(id2), a: acct() }));
  }

  // ── S13 the switch ──
  {
    let id = fresh();
    let st = stepWallet(); st.id = id;
    const s = stepScheduler(st, { mode: 'cli' });
    await quiet(() => s.checkTorAndSend(rowOf(id)));
    ok("S13. mode 'cli' → the CLI send runs and no stepwise code (no init, no marker)",
      s.torSendMode === 'cli' && order(st) === '' && st.calls.some((c) => c.method === 'cli-send') &&
      !notes(id).some((x) => /^stepwise:/.test(x)), `${order(st)} ${JSON.stringify(notes(id))}`);
    id = fresh();
    st = stepWallet(); st.id = id;
    let s2 = null;
    const errs = await quiet(async () => { s2 = stepScheduler(st, { withWallet: false }); });
    ok("S13. mode 'stepwise' with no Owner-API wallet → runs 'cli' and says so",
      s2.torSendMode === 'cli' && errs.some((e) => /tor_send_mode is 'stepwise' but no Owner-API wallet/.test(e)), errs.join(' | '));
    ok("S13. mode 'stepwise' with a wallet → stepwise", stepScheduler(stepWallet()).torSendMode === 'stepwise');
  }

  // ── S14 withSendLock across rails ──
  {
    const id = fresh();
    db.prepare(`INSERT INTO miner_accounts (grin_address, balance, balance_locked) VALUES (?, 100, 0)
                ON CONFLICT(grin_address) DO UPDATE SET balance = 100, balance_locked = 0`).run(ADDR2);
    const st = stepWallet({ delay: { init_send_tx: 40, tx_lock_outputs: 40 } });
    st.id = id;
    const s = stepScheduler(st);
    let spErr = null;
    await quiet(async () => {
      const p1 = s.checkTorAndSend(rowOf(id));
      await sleep(5);
      const p2 = s.createSlatepackWithdrawal(ADDR2, 30).catch((e) => { spErr = e.message; });
      await Promise.all([p1, p2]);
    });
    const seq2 = st.calls.filter((c) => c.method === 'init_send_tx' || c.method === 'tx_lock_outputs')
      .map((c) => `${c.method}:${c.method === 'init_send_tx' ? c.params.args.amount : c.params.slate.amt}`);
    ok('S14. a slatepack create started during the stepwise init waits: its init_send_tx comes AFTER the stepwise lock',
      seq2.join(' ') === 'init_send_tx:99960000000 tx_lock_outputs:99960000000 init_send_tx:29960000000 tx_lock_outputs:29960000000',
      `${seq2.join(' ')} ${spErr || ''}`);
    db.prepare('DELETE FROM withdrawal_events WHERE withdrawal_id IN (SELECT id FROM withdrawals WHERE grin_address = ?)').run(ADDR2);
    db.prepare('DELETE FROM balance_log WHERE grin_address = ?').run(ADDR2);
    db.prepare('DELETE FROM withdrawals WHERE grin_address = ?').run(ADDR2);
    db.prepare('DELETE FROM miner_accounts WHERE grin_address = ?').run(ADDR2);
  }

  // ── S16 a lost step guard stops the attempt ──
  {
    const id = fresh();
    const st = stepWallet(); st.id = id;
    // Something else moves the row's step while delivery is in flight.
    const s = stepScheduler(st, { deliver: (slate) => {
      db.prepare("UPDATE withdrawals SET tor_step = 'posting' WHERE id = ?").run(id);
      return { ok: true, slate: Object.assign({}, slate, { sta: 'S2' }) };
    } });
    await quiet(() => s.checkTorAndSend(rowOf(id)));
    ok('S16. the delivering → finalizing guard is lost → no finalize, no post, no settle',
      order(st) === 'init_send_tx,tx_lock_outputs,deliver' && rowOf(id).status === 'tor_sending', `${order(st)} ${rowOf(id).status}`);
  }

  // ── S17–S19 (Part 8 review): guards that no earlier case could fail ──
  // A committed ('posting') row stopped by the sweep, `old` seconds after its claim.
  const committed = (st, { claimAgo = 3600 } = {}) => {
    reset();
    db.exec("DELETE FROM alerts WHERE type = 'payout_tor_stepwise'");
    const sid = U(9300 + (++slateSeq));
    const id = seedWithdrawal({ status: 'tor_sending', retries: 0, priorAttempt: false, slate: sid });
    db.prepare("INSERT INTO withdrawal_events (withdrawal_id, from_status, to_status, triggered_by, note, created_at) VALUES (?, 'tor_checking', 'tor_sending', 'scheduler', 'stepwise: claim', ?)")
      .run(id, Math.floor(Date.now() / 1000) - claimAgo);
    db.prepare('UPDATE withdrawals SET tor_step = ?, tor_final_slate = ? WHERE id = ?')
      .run('posting', JSON.stringify({ id: sid, sta: 'S3' }), id);
    st.log.push({ id: 1, tx_slate_id: sid, tx_type: 'TxSent', confirmed: false, creation_ts: new Date().toISOString(),
      amount_debited: '99983500000', amount_credited: '0', fee: FEE_NANO });
    st.id = id;
    return { id, sid };
  };
  const repostEv = (id, n, ago) => {
    const ins = db.prepare("INSERT INTO withdrawal_events (withdrawal_id, from_status, to_status, triggered_by, note, created_at) VALUES (?, 'tor_sending', 'tor_sending', 'scheduler', 'stepwise: repost slate x — failed: x', ?)");
    for (let i = 0; i < n; i++) ins.run(id, Math.floor(Date.now() / 1000) - ago);
  };
  const postsOf = (st) => st.calls.filter((c) => c.method === 'post_tx').length;
  {
    // The safety line itself: nothing is cancelled from 'posting' on. No path reaches the refusal
    // today, so it is pinned directly — a future caller must not be able to cancel a committed tx.
    const st = stepWallet();
    const { id, sid } = committed(st);
    const s = stepScheduler(st);
    let r;
    await quiet(async () => { r = await s._stepwiseCancelThen(id, sid, { requeue: true }, 'test'); });
    ok('S17. _stepwiseCancelThen on a POSTING row refuses: no cancel_tx, row stays tor_sending/posting',
      r === false && !/cancel_tx/.test(order(st)) && rowOf(id).status === 'tor_sending' && rowOf(id).tor_step === 'posting',
      `${r} ${order(st)} ${JSON.stringify(rowOf(id))}`);
  }
  for (const [n, want] of [[24, 0], [23, 1]]) {
    // Bounded: after MAX_STEPWISE_REPOSTS the sweep stops posting (the old repost events are an
    // hour old, so it is the CAP that stops it, not the 5-min rate). 23 is the control.
    const st = stepWallet();
    const { id } = committed(st);
    repostEv(id, n, 3600);
    await quiet(() => stepScheduler(st).reclaimStaleTorSending());
    ok(`S18. ${n} earlier reposts → the sweep posts ${want} more time(s)${n === 24 ? ', and the alert is critical' : ''}`,
      postsOf(st) === want && (n !== 24 || (activeAlert() || {}).level === 'critical'),
      `posts=${postsOf(st)} ${JSON.stringify(activeAlert())}`);
  }
  {
    // The stale age counts CLAIM events only: a repost 6 min ago must not push the next look out
    // to 10 min, or it silently overrides the 5-min re-post rate (Part 6 deviation b).
    const st = stepWallet({ hooks: { post_tx: () => { throw new Error('HTTP 500: node refused'); } } });
    const { id } = committed(st);
    repostEv(id, 1, 360);
    await quiet(() => stepScheduler(st).reclaimStaleTorSending());
    ok('S19. claim 1 h old + last repost 6 min ago → the sweep posts again (age is the claim, not the repost)',
      postsOf(st) === 1, `posts=${postsOf(st)}`);
  }
}

// ═══ [review] Part 8 — independent review of Parts 1–6 (2026-09-25) ═════════════════════════
// Each case failed on the code as Parts 1–6 left it.
async function reviewSection() {
  console.log('\n[review] Part 8 — independent review of Parts 1–6');
  const quiet = async (fn) => {
    const o = [console.log, console.error, console.warn];
    console.log = console.error = console.warn = () => {};
    try { return await fn(); } finally { [console.log, console.error, console.warn] = o; }
  };
  const SW = '0000a001-0000-4000-8000-000000000000';   // a stepwise slate, cancelled
  const C1 = '0000c001-0000-4000-8000-000000000000';   // a CLI send whose slate was never captured
  const ev = db.prepare(
    'INSERT INTO withdrawal_events (withdrawal_id, from_status, to_status, triggered_by, note, created_at) VALUES (?, ?, ?, \'scheduler\', ?, ?)');
  // Attempt 1 was STEPWISE (slate SW, cancelled, row back on the ladder), then the operator switched
  // tor_send_mode back to 'cli'. slate_id still holds SW — the stepwise rail wrote it before its lock.
  const stepwiseThenCli = ({ retries = 1 } = {}) => {
    reset(); sends = []; timeline = [];
    db.exec('DELETE FROM payout_control');
    const id = seedWithdrawal({ status: 'tor_checking', retries, priorAttempt: false, slate: SW });
    const t = Math.floor(Date.now() / 1000) - 3000;
    ev.run(id, 'tor_checking', 'tor_sending', 'stepwise: claim', t);
    ev.run(id, 'tor_sending', 'tor_sending', `slate: ${SW} created (stepwise)`, t);
    ev.run(id, 'tor_sending', 'tor_sending', `stepwise: slate ${SW} cancelled (delivery failed)`, t);
    ev.run(id, 'tor_sending', 'retry_scheduled', 'Retry 1/4', t);
    db.prepare("UPDATE withdrawals SET tor_step = 'delivering' WHERE id = ?").run(id);
    return id;
  };
  const addCliAttempt = (id) => {   // attempt 2: a CLI send that was SIGKILLed — but it had posted
    const t = Math.floor(Date.now() / 1000) - 2000;
    ev.run(id, 'retry_scheduled', 'tor_checking', null, t);
    ev.run(id, 'tor_checking', 'tor_sending', null, t);
    ev.run(id, 'tor_sending', 'retry_scheduled', 'Retry 2/4', t);
  };

  // ── R1 a CLI re-attempt must not trust a dead STEPWISE slate as "this payout's send" ──
  for (const mined of [false, true]) {
    const id = stepwiseThenCli();
    addCliAttempt(id);
    const s = newScheduler([tx({ slate: SW, type: 'TxSentCancelled' }), tx({ slate: C1, confirmed: mined })]);
    await quiet(() => s.checkTorAndSend(rowOf(id)));
    ok(`R1. stepwise → cli: the earlier CLI send is ${mined ? 'MINED → confirmed' : 'unconfirmed → deferred'}, never sent again`,
      sends.length === 0 && rowOf(id).status === (mined ? 'confirmed' : 'retry_scheduled'),
      JSON.stringify({ sends: sends.length, row: rowOf(id) }));
  }

  // ── R2 …nor refund on its last rung ──
  {
    const id = stepwiseThenCli({ retries: 4 });
    const log = [tx({ slate: SW, type: 'TxSentCancelled' })];
    const s = newScheduler(log);
    // The final CLI attempt is SIGKILLed after it posted, and the tx mines before the guard asks.
    s.walletTor.sendToTorAddress = async (address, amount) => {
      sends.push({ address, amount });
      log.push(tx({ slate: C1, confirmed: true }));
      return { success: false, error: 'Command timed out after 120000ms' };
    };
    await quiet(() => s.checkTorAndSend(rowOf(id)));
    ok('R2. stepwise → cli, last rung: the "failed" send is confirmed → settled, NOT refunded',
      rowOf(id).status === 'confirmed' && acct().balance === 0, JSON.stringify({ row: rowOf(id), acct: acct() }));
  }

  // ── R3 a successful CLI send records ITS slate, not the dead stepwise one ──
  {
    const id = stepwiseThenCli();
    const log = [tx({ slate: SW, type: 'TxSentCancelled' })];
    const s = newScheduler(log);
    s.walletTor.sendToTorAddress = async (address, amount) => {
      sends.push({ address, amount });
      log.push(tx({ slate: C1 }));
      return { success: true };
    };
    await quiet(() => s.checkTorAndSend(rowOf(id)));
    // With SW left in place the watchdog reads the paid row as CANCELLED — a false critical alert
    // whose runbook says "credit the balance back or pay again".
    ok('R3. stepwise → cli success: slate_id is the CLI send\'s slate, so kernel proof + watchdog look at the real tx',
      rowOf(id).status === 'confirmed' && rowOf(id).slate_id === C1, JSON.stringify(rowOf(id)));
  }

  // ── R4 the freeze stops the NEXT send of a batch that is already running ──
  {
    reset(); sends = []; timeline = [];
    db.exec('DELETE FROM payout_control');
    const due = Math.floor(Date.now() / 1000) - 60;
    const a = seedWithdrawal({ status: 'retry_scheduled', retries: 1, priorAttempt: false });
    const b = seedWithdrawal({ status: 'retry_scheduled', retries: 1, priorAttempt: false });
    db.prepare('UPDATE withdrawals SET next_retry_at = ? WHERE id IN (?, ?)').run(due, a, b);
    const s = newScheduler([]);
    // AlertMonitor runs on its own timer: a critical trip can freeze payouts while one CLI send of
    // the batch is still in flight (up to wallet_send_timeout_ms each).
    s.walletTor.sendToTorAddress = async (address, amount) => {
      sends.push({ address, amount });
      if (sends.length === 1) s.freeze('wallet_drain (test)', 'alert_monitor');
      return { success: true };
    };
    await quiet(() => s.processRetryQueue());
    const st = [rowOf(a).status, rowOf(b).status].sort().join(',');
    ok('R4. a freeze landing mid-batch: exactly one send, the other row waits in the queue unsent',
      sends.length === 1 && st === 'confirmed,tor_checking', `${sends.length} ${st}`);
    await quiet(async () => { s.resume('test'); });
    sends = [];
    await quiet(() => s.processTorChecks());
    ok('R4. …and after resume it goes out on the next pass', sends.length === 1 && [rowOf(a).status, rowOf(b).status].every((x) => x === 'confirmed'),
      `${sends.length} ${rowOf(a).status},${rowOf(b).status}`);
    db.exec('DELETE FROM payout_control');
  }

  // ── R5 F2 repost bounds that no earlier case could fail ──
  {
    const KX = '09' + 'ab'.repeat(32);
    const now = Math.floor(Date.now() / 1000);
    const reposts = [];
    const paid = (slate, logId) => {
      const id = Number(seedWithdrawal({ status: 'confirmed', slate, priorAttempt: false, retries: 0 }));
      db.prepare('UPDATE withdrawals SET confirmed_at = ? WHERE id = ?').run(now - 7200, id);
      return { id, entry: { ...tx({ slate }), id: logId, kernel_excess: KX } };
    };
    const run = async (entries) => {
      const s = newScheduler(entries);
      s.walletTor.repostTx = async (txLogId) => { reposts.push(txLogId); return { ok: true, output: '' }; };
      s._lastKernelScan = 0;
      await quiet(() => s.backfillKernelProofs());
    };
    reset(); db.exec("DELETE FROM alerts WHERE type = 'payout_unmined'"); db.exec('DELETE FROM payout_control');
    const rows = [paid('P-1', 41), paid('P-2', 42), paid('P-3', 43), paid('P-4', 44)];
    await run(rows.map((r) => r.entry));
    ok('R5. four sent-not-mined rows → at most 3 reposts in one tick (REPOST_MAX_PER_TICK)', reposts.length === 3, JSON.stringify(reposts));

    for (const [n, want] of [[24, 0], [23, 1]]) {
      reset(); db.exec("DELETE FROM alerts WHERE type = 'payout_unmined'"); reposts.length = 0;
      const r = paid('P-CAP', 51);
      const ins = db.prepare(`INSERT INTO withdrawal_events (withdrawal_id, from_status, to_status, triggered_by, note, created_at)
                              VALUES (?, 'confirmed', 'confirmed', 'scheduler', 'repost: filler', ?)`);
      for (let i = 0; i < n; i++) ins.run(r.id, now - 90000);   // all old: only the CAP can stop it
      await run([r.entry]);
      ok(`R5. ${n} earlier reposts, all a day old → ${want} more (MAX_REPOSTS, not the hourly rate)`,
        reposts.length === want, JSON.stringify(reposts));
    }
  }
}
