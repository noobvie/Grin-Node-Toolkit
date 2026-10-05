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

// Silence the scheduler's own log lines inside a case (they are asserted on where they matter).
const quiet = async (fn) => {
  const o = [console.log, console.error, console.warn];
  console.log = console.error = console.warn = () => {};
  try { return await fn(); } finally { [console.log, console.error, console.warn] = o; }
};
// Run fn and hand back what it threw (null if nothing) — a method that does not exist yet must
// read as a FAILED assertion, not crash the suite.
const thrown = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };
const evNote = db.prepare(
  'INSERT INTO withdrawal_events (withdrawal_id, from_status, to_status, triggered_by, note, created_at) VALUES (?, ?, ?, \'scheduler\', ?, ?)');
const eventsOf = (id) => db.prepare('SELECT * FROM withdrawal_events WHERE withdrawal_id = ? ORDER BY id').all(id);
const nowS = () => Math.floor(Date.now() / 1000);

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
  // (Session 4) The amount branch now counts a same-net Tor row still OPEN in tor_sending as a
  // possible owner of the tx — so each case below starts from an empty ledger, one row, one log.
  {
    reset();
    // The §J4-1 premise, stated as a test: a bare TxSent is written at tx_lock_outputs and is
    // NOT evidence of a broadcast. Before §J4-10 this exact input returned "it landed".
    const id = seedWithdrawal({ slate: null });
    const s = newScheduler([tx({ slate: 'AMT-1', confirmed: false })]);
    const r = await s._priorSendLanded(rowOf(id), 99.96);
    ok('amount branch: an unconfirmed same-amount send is "unconfirmed", not proof of a send',
      r.checked && r.outcome === 'unconfirmed', JSON.stringify(r));
  }
  {
    reset();
    const id = seedWithdrawal({ slate: null });
    const s = newScheduler([tx({ slate: 'AMT-2', confirmed: true })]);
    const r = await s._priorSendLanded(rowOf(id), 99.96);
    ok('amount branch: a confirmed same-amount send is "confirmed"', r.checked && r.outcome === 'confirmed');
  }
  {
    // Two candidates, one confirmed. Reporting the unconfirmed one would park a settled payout.
    reset();
    const id = seedWithdrawal({ slate: null });
    const s = newScheduler([tx({ slate: 'A', confirmed: false }), tx({ slate: 'B', confirmed: true })]);
    const r = await s._priorSendLanded(rowOf(id), 99.96);
    ok('amount branch: a CONFIRMED match wins over an unconfirmed sibling',
      r.outcome === 'confirmed' && r.tx.tx_slate_id === 'B', JSON.stringify(r));
  }
  {
    reset();
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

  // ═══ 2. sendWithdrawal — ONE attempt per payout (2026-09-26) ════════════════
  // A Tor payout is tried once. A row that has ANY earlier attempt on record is never handed to
  // the wallet again, whatever the tx log says — it goes to tor_held and the Held resolution
  // settles it (confirmed / refunded on proof of absence / held). The old code re-sent on 'absent'.
  console.log('\n[2] sendWithdrawal — a row with an earlier attempt is never sent again');
  for (const [label, slate, log] of [
    ['CONFIRMED on chain', 'W-CONF', [tx({ slate: 'W-CONF', confirmed: true })]],
    ['UNCONFIRMED (outcome unknown)', 'W-UNCONF', [tx({ slate: 'W-UNCONF', confirmed: false })]],
    ['ABSENT from the wallet', 'W-ABSENT', []],
  ]) {
    sends = [];
    reset();
    const id = seedWithdrawal({ status: 'tor_checking', slate, retries: 1 });
    const s = newScheduler(log);
    await quiet(() => s.sendWithdrawal(id));
    const r = rowOf(id);
    ok(`earlier attempt, tx log ${label} → NOTHING is sent`, sends.length === 0, `${sends.length} sends`);
    ok(`  …the row is tor_held, never back on a retry ladder`, r.status === 'tor_held', r.status);
    ok('  …the balance stays LOCKED (no refund, no debit)',
      acct().balance_locked === 100 && acct().balance === 0, JSON.stringify(acct()));
  }
  {
    // The Held resolution then settles the confirmed one — the old "recover, don't re-send" branch.
    sends = [];
    reset();
    const id = seedWithdrawal({ status: 'tor_checking', slate: 'W-CONF2' });
    const s = newScheduler([tx({ slate: 'W-CONF2', confirmed: true })]);
    await quiet(() => s.sendWithdrawal(id));
    await thrown(() => quiet(() => s.resolveHeldTor()));
    ok('held, then the Held check sees it CONFIRMED → confirmed, lock released, still no send',
      rowOf(id).status === 'confirmed' && acct().balance_locked === 0 && acct().balance === 0 && sends.length === 0,
      JSON.stringify({ row: rowOf(id).status, acct: acct(), sends: sends.length }));
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
    // …and the arming itself: retry_count 0 but a prior tor_sending event (exactly what the old
    // admin Retry button left behind) must still count as an earlier attempt.
    sends = [];
    reset();
    const id = seedWithdrawal({ status: 'tor_checking', retries: 0, slate: null, priorAttempt: true });
    const s = newScheduler([]);
    await quiet(() => s.sendWithdrawal(id));
    ok('§J4-2 — retry_count=0 with a prior tor_sending event is still an earlier attempt → held, not sent',
      sends.length === 0 && rowOf(id).status === 'tor_held', `sends=${sends.length} status=${rowOf(id).status}`);
  }

  // ═══ 3. reclaimStaleTorSending (§J4-3) ═════════════════════════════════════
  // A crash mid-send is outcome D: unless the wallet already shows the send CONFIRMED, the row
  // goes to tor_held — never back to a queue that would send it again.
  console.log('\n[3] §J4-3 — the stale tor_sending sweep');
  {
    // The premise: before the sweep existed, nothing selected this status at all.
    reset();
    const id = seedWithdrawal({ status: 'tor_sending', slate: 'ST-NONE' });
    const s = newScheduler([]);
    await quiet(() => s.processTorChecks());
    await quiet(() => s.processSlatepackExpiry());
    await quiet(() => s.reclaimStaleFinalizing());
    if (typeof s.resolveHeldTor === 'function') await quiet(() => s.resolveHeldTor());
    ok('premise — no other recovery pass touches a tor_sending row',
      rowOf(id).status === 'tor_sending', rowOf(id).status);
  }
  {
    sends = [];
    reset();
    const id = seedWithdrawal({ status: 'tor_sending', slate: 'ST-CONF' });
    const s = newScheduler([tx({ slate: 'ST-CONF', confirmed: true })]);
    await quiet(() => s.reclaimStaleTorSending());
    const r = rowOf(id);
    ok('confirmed on chain → the abandoned row is confirmed', r.status === 'confirmed', r.status);
    ok('…and nothing was re-sent', sends.length === 0);
    ok('…and the lock is released', acct().balance_locked === 0, JSON.stringify(acct()));
  }
  for (const [label, log, opts] of [
    ['never posted (absent)', [], {}],
    ['unconfirmed', [tx({ slate: 'ST-UNK', confirmed: false })], {}],
    ['wallet unreadable', [], { walletReadable: false }],
  ]) {
    sends = [];
    reset();
    const id = seedWithdrawal({ status: 'tor_sending', slate: label === 'unconfirmed' ? 'ST-UNK' : 'ST-GONE', retries: 1 });
    const s = newScheduler(log, opts);
    await quiet(() => s.reclaimStaleTorSending());
    const r = rowOf(id);
    ok(`${label} → tor_held (a crash mid-send is outcome D), never back on a queue`, r.status === 'tor_held', r.status);
    ok('  …no refund, no rung: balance still LOCKED, retry_count untouched',
      acct().balance_locked === 100 && acct().balance === 0 && r.retry_count === 1, JSON.stringify({ a: acct(), rc: r.retry_count }));
    ok('  …and the sweep never sends from inside itself', sends.length === 0);
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

  // ═══ 5. (removed 2026-09-26) the last-rung guard ═════════════════════════
  // There is no retry ladder any more, so there is no last rung: a Tor payout is tried ONCE and
  // its outcome is decided by [one-attempt] (A/B/C/D) and [held] below. Their cases cover what
  // this section proved — a send that reports failure but CONFIRMED is settled, an unconfirmed
  // or unreadable one is never refunded — without a ladder to reach it through.

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
    // The expiry gate reads the wallet's tx log before any refund (2026-09-27), so the stub needs
    // one: grin-wallet v5.5.0 records a locked-but-unanswered slate as TxSent / Standard1.
    const s = new WithdrawalScheduler(config, {
      async cancelTx(id) { cancelled.push(id); },
      async getTransactions() {
        return ['sp-old', 'sp-fresh'].map((id) => ({ tx_slate_id: id, tx_type: 'TxSent', tx_slate_state: 'Standard1', confirmed: false }));
      },
    });
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

  // ═══ (moved 2026-09-26) retry_reason / shortfall retries ═══
  // A pool-wallet shortfall is outcome C of the one attempt now: refunded at once with
  // fail_code pool_busy when the tx log proves nothing was sent — see [one-attempt] C1–C3, which
  // also keep the rolling pool_wallet_short alert cases. The 1 h uncounted retry (F3) is gone.

  // ═══ Kernel proof only once MINED (2026-09-25, F1) ═══
  // withdrawals.kernel_excess drives the public "<method> · mined" badge (P-05 Method column), has_kernel_proof and the
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

  // ═══ (moved 2026-09-26) exit-0 slatepack fallback ═══
  // classifySendOutput + _releaseTorFallback are unchanged; what happens AFTER the cancel is now
  // outcome B of the one attempt (refund now, fail_code from a fresh probe) — see [one-attempt] B*.

  await guarded(oneAttemptSection);
  await guarded(heldSection);
  await guarded(pauseSection);
  await guarded(cooldownSection);
  await guarded(migrationSection);
  await guarded(pendingListSection);
  await guarded(routeSection);
  await guarded(alertNoiseSection);
  await slatepackRecoverySection();
  await sendLockSection();
  await reviewSection();
  await guarded(reviewS4Section);
  await guarded(healthCardSection);
  await guarded(reviewFixesSection);
  await guarded(bindingSection);
  await guarded(expiryGateSection);
  await guarded(walletVersionSection);
  await guarded(doublePayCardSection);
  await guarded(inFlightCoverageSection);
  await guarded(paymentQueueSection);

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
      // Standard1 is what grin-wallet v5.5.0 writes at lock (selection.rs lock_tx_context).
      async txLockOutputs(slate) { w.log.push({ tx_slate_id: slate.id, tx_type: 'TxSent', tx_slate_state: 'Standard1', confirmed: false }); },
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
    w.log.push({ tx_slate_id: 'sp4', tx_type: 'TxSent', tx_slate_state: 'Standard1', confirmed: false });
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
    w.log.push({ tx_slate_id: 'sp5-a', tx_type: 'TxSent', tx_slate_state: 'Standard1', confirmed: false },
      { tx_slate_id: 'sp5-b', tx_type: 'TxSent', tx_slate_state: 'Standard1', confirmed: false });
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
    w.log.push({ tx_slate_id: 'sp6', tx_type: 'TxSent', tx_slate_state: 'Standard1', confirmed: false });
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

// ═══ [send-lock] the slatepack create path selects + locks coins under ONE lock ════════════
// The step-by-step Tor send (F5) and its [stepwise] S1–S19 cases were DELETED 2026-09-26. Its S14
// was the only case proving that a create path really runs init → lock inside WalletAPI's
// withSendLock; it lives on here as L1, rebuilt on two slatepack creates (the Goblin create shares
// the same _withSendLock call). The REAL WalletAPI with only its wire boundary (_encryptedCall)
// faked, so the real lock runs. Without it two inits interleave before either lock and can select
// the SAME coins (design §8.1.1), and one of the two transactions can never mine.
async function sendLockSection() {
  console.log('\n[send-lock] two slatepack creates cannot interleave init → lock');
  const WalletAPI = require(path.join(APP, 'lib/wallet.js'));
  const ADDR2 = 'tgrin1zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz';
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const quiet = async (fn) => {
    const o = [console.log, console.error, console.warn];
    console.log = console.error = console.warn = () => {};
    try { return await fn(); } finally { [console.log, console.error, console.warn] = o; }
  };
  const w = new WalletAPI({ network: 'testnet', wallet_dir: '/nonexistent' });
  w.sessionOpen = true; w.aesKey = Buffer.alloc(32); w.token = 'TOKEN';
  const calls = [];
  let slateSeq = 0;
  w._encryptedCall = async (method, params) => {
    const p = JSON.parse(JSON.stringify(params));
    calls.push({ method, params: p });
    // Hold both halves of the critical section, so an unlocked second create WOULD get in between.
    if (method === 'init_send_tx' || method === 'tx_lock_outputs') await sleep(40);
    switch (method) {
      case 'init_send_tx':
        return { ver: '4:3', id: `0000${String(++slateSeq).padStart(4, '0')}-0000-4000-8000-000000000000`,
                 sta: 'S1', amt: String(p.args.amount), fee: '23500000' };
      case 'create_slatepack_message': return 'BEGINSLATEPACK. x. ENDSLATEPACK.';
      default: return null;
    }
  };

  reset(); sends = [];
  db.exec('DELETE FROM payout_control');
  const fund = db.prepare(`INSERT INTO miner_accounts (grin_address, balance, balance_locked) VALUES (?, 100, 0)
                           ON CONFLICT(grin_address) DO UPDATE SET balance = 100, balance_locked = 0`);
  fund.run(ADDR); fund.run(ADDR2);
  const s = new WithdrawalScheduler(config, w);
  s.incentives = { maybePayJoinBonus() {} };
  const errs = [];
  await quiet(async () => {
    const p1 = s.createSlatepackWithdrawal(ADDR, 100).catch((e) => { errs.push(e.message); });
    await sleep(5);
    const p2 = s.createSlatepackWithdrawal(ADDR2, 30).catch((e) => { errs.push(e.message); });
    await Promise.all([p1, p2]);
  });
  const seq = calls.filter((c) => c.method === 'init_send_tx' || c.method === 'tx_lock_outputs')
    .map((c) => `${c.method}:${c.method === 'init_send_tx' ? c.params.args.amount : c.params.slate.amt}`);
  ok('L1. a second slatepack create started during the first one\'s init waits: its init_send_tx comes AFTER the first lock',
    errs.length === 0 &&
    seq.join(' ') === 'init_send_tx:99960000000 tx_lock_outputs:99960000000 init_send_tx:29960000000 tx_lock_outputs:29960000000',
    `${seq.join(' ')} ${errs.join(' | ')}`);

  db.prepare('DELETE FROM withdrawal_events WHERE withdrawal_id IN (SELECT id FROM withdrawals WHERE grin_address = ?)').run(ADDR2);
  db.prepare('DELETE FROM balance_log WHERE grin_address = ?').run(ADDR2);
  db.prepare('DELETE FROM withdrawals WHERE grin_address = ?').run(ADDR2);
  db.prepare('DELETE FROM miner_accounts WHERE grin_address = ?').run(ADDR2);
  reset();
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
  // Attempt 1 was STEPWISE (slate SW, cancelled, row back on the ladder); every later attempt is CLI.
  // slate_id still holds SW — the stepwise rail wrote it before its lock. That rail was DELETED
  // 2026-09-26, but a row it touched can still exist, so R1–R3 stay: they pin _dropStepwiseSlate.
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

  // ── R1 a stepwise row is never sent again, and its Held check does not trust the dead slate ──
  // Since 2026-09-26 a row with any earlier attempt is held, never re-sent. _dropStepwiseSlate still
  // matters: the Held check reads slate_id as THIS payout's send, so a left-over cancelled stepwise
  // slate reads "absent" and two such reads would REFUND a payout whose CLI send landed.
  for (const mined of [false, true]) {
    const id = stepwiseThenCli();
    addCliAttempt(id);
    const s = newScheduler([tx({ slate: SW, type: 'TxSentCancelled' }), tx({ slate: C1, confirmed: mined, when: nowS() - 2000 })]);
    await quiet(() => s.checkTorAndSend(rowOf(id)));
    const heldFirst = rowOf(id).status === 'tor_held';
    await thrown(() => quiet(() => s.resolveHeldTor()));
    ok(`R1. stepwise → cli: never sent again; the earlier CLI send is ${mined ? 'MINED → confirmed' : 'unconfirmed → still held'}`,
      sends.length === 0 && heldFirst && rowOf(id).status === (mined ? 'confirmed' : 'tor_held'),
      JSON.stringify({ sends: sends.length, heldFirst, row: rowOf(id) }));
  }

  // ── R2 …and two absent reads of the DEAD slate never refund it ──
  {
    const id = stepwiseThenCli();
    addCliAttempt(id);
    const s = newScheduler([tx({ slate: SW, type: 'TxSentCancelled' }), tx({ slate: C1, confirmed: false, when: nowS() - 2000 })]);
    await quiet(() => s.checkTorAndSend(rowOf(id)));
    await thrown(() => quiet(() => s.resolveHeldTor()));
    db.prepare("UPDATE withdrawal_events SET created_at = created_at - 3600 WHERE withdrawal_id = ?").run(id);
    await thrown(() => quiet(() => s.resolveHeldTor()));
    ok('R2. stepwise → cli: the unconfirmed CLI send keeps it HELD — never refunded on the cancelled stepwise slate',
      rowOf(id).status === 'tor_held' && acct().balance === 0 && acct().balance_locked === 100, JSON.stringify({ row: rowOf(id), acct: acct() }));
  }

  // ── R3 a confirmed CLI send is recorded as ITS slate, not the dead stepwise one ──
  {
    const id = stepwiseThenCli();
    addCliAttempt(id);
    const s = newScheduler([tx({ slate: SW, type: 'TxSentCancelled' }), tx({ slate: C1, confirmed: true, when: nowS() - 2000 })]);
    await quiet(() => s.checkTorAndSend(rowOf(id)));
    await thrown(() => quiet(() => s.resolveHeldTor()));
    // With SW left in place the watchdog reads the paid row as CANCELLED — a false critical alert
    // whose runbook says "credit the balance back or pay again".
    ok('R3. stepwise → cli confirmed: slate_id is the CLI send\x27s slate, so kernel proof + watchdog look at the real tx',
      rowOf(id).status === 'confirmed' && rowOf(id).slate_id === C1, JSON.stringify(rowOf(id)));
  }

  // ── R4 the freeze stops the NEXT send of a batch that is already running ──
  {
    reset(); sends = []; timeline = [];
    db.exec('DELETE FROM payout_control');
    const a = seedWithdrawal({ status: 'tor_checking', retries: 0, priorAttempt: false });
    const b = seedWithdrawal({ status: 'tor_checking', retries: 0, priorAttempt: false });
    const s = newScheduler([]);
    // AlertMonitor runs on its own timer: a critical trip can freeze payouts while one CLI send of
    // the batch is still in flight (up to wallet_send_timeout_ms each).
    s.walletTor.sendToTorAddress = async (address, amount) => {
      sends.push({ address, amount });
      if (sends.length === 1) s.freeze('wallet_drain (test)', 'alert_monitor');
      return { success: true };
    };
    await quiet(() => s.processTorChecks());
    const st = [rowOf(a).status, rowOf(b).status].sort().join(',');
    ok('R4. a freeze landing mid-batch: exactly one send, the other row waits in tor_checking unsent',
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

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// ONE ATTEMPT + HELD + TOR PAUSE (plan script07_tor_one_attempt, Session 2 — 2026-09-26)
// A Tor payout is tried ONCE. It ends Paid, Failed (balance back now — only on wallet proof that
// nothing was sent) or Held (outcome unknown: amount stays locked, never re-sent). 5 counted
// failures in 24 h pause Tor for that address. Every case below failed on the code before it.
// ═══════════════════════════════════════════════════════════════════════════════════════════════

// A section that throws (e.g. a method that does not exist yet) is ONE failure, and the rest run.
async function guarded(fn) {
  try { await fn(); }
  catch (e) { fail++; console.log(`  FAIL  ${fn.name} crashed: ${e && e.message}`); }
}
const reversalOf = (id) => db.prepare("SELECT 1 FROM balance_log WHERE reference_id = ? AND event_type = 'reversal'").get(id);
// Refunded: tor_failed, the whole 100 back in spendable, nothing locked, a reversal on the ledger.
const refundedOk = (id) => rowOf(id).status === 'tor_failed' && Math.abs(acct().balance - 100) < 1e-9 &&
  Math.abs(acct().balance_locked) < 1e-9 && !!reversalOf(id);
// Held: tor_held, the 100 still locked, no reversal.
const heldOk = (id) => rowOf(id).status === 'tor_held' && Math.abs(acct().balance) < 1e-9 &&
  Math.abs(acct().balance_locked - 100) < 1e-9 && !reversalOf(id);
const alertOf = (type) => db.prepare("SELECT * FROM alerts WHERE type = ? AND status = 'active' ORDER BY id DESC LIMIT 1").get(type);
const fund = (bal, addr = ADDR) => db.prepare(
  `INSERT INTO miner_accounts (grin_address, balance, balance_locked) VALUES (?, ?, 0)
   ON CONFLICT(grin_address) DO UPDATE SET balance = excluded.balance, balance_locked = 0`).run(addr, bal);
// A settled Tor failure `agoS` seconds ago (the tor_failed EVENT carries the time the pause counts).
const seedFailed = (code, agoS, addr = ADDR) => {
  const id = Number(db.prepare(
    `INSERT INTO withdrawals (grin_address, amount, fee_charged, status, method, fail_code, created_at)
     VALUES (?, 25, 0.04, 'tor_failed', 'tor', ?, ?)`).run(addr, code, nowS() - agoS - 30).lastInsertRowid);
  evNote.run(id, 'tor_sending', 'tor_failed', 'test: settled failure', nowS() - agoS);
  return id;
};
// A slatepack-capable fake Owner API (init → lock → message), for the Slatepack-offer cases.
const spWallet = (extra = {}) => ({
  n: 0,
  async initSendTx(a) { this.n++; return { id: `sp-offer-${seq}-${this.n}`, amt: a, fee: '23500000' }; },
  async txLockOutputs() {},
  async createSlatepackMessage() { return 'BEGINSLATEPACK. offer . ENDSLATEPACK.'; },
  async cancelTx() {},
  async getTransactions() { return []; },
  ...extra,
});

async function oneAttemptSection() {
  console.log('\n[one-attempt] the single Tor send ends A (paid) / B+C (refund on proof) / D (held)');
  const FB = '5c8a4e6b-3f1d-4a92-9b7e-0d2c1f3e4a5b';
  const OFFLINE = { online: false, reason: 'onion_unreachable' };
  const oa = ({ result, log = [], readable = true, cancelThrows = false, probe = OFFLINE } = {}) => {
    const cancels = []; const probes = [];
    const s = new WithdrawalScheduler(config, {
      async getTransactions() { timeline.push('wallet'); if (!readable) throw new Error('owner API down'); return log; },
      async cancelTx(id) {
        timeline.push('cancel'); cancels.push(id);
        if (cancelThrows) throw new Error('owner API down');
        const e = log.find((t) => t.tx_slate_id === id); if (e) e.tx_type = 'TxSentCancelled';
      },
    });
    s.walletTor = {
      async sendToTorAddress(address, amount) {
        timeline.push('send'); sends.push({ address, amount });
        if (result instanceof Error) throw result;
        return typeof result === 'function' ? result(log) : result;
      },
      async probeToronlineStatus(addr) {
        timeline.push('probe'); probes.push(addr);
        if (probe instanceof Error) throw probe;
        return probe;
      },
    };
    s.recordTorFee = async () => {};
    s.incentives = { maybePayJoinBonus() {} };
    return { s, cancels, probes };
  };
  const laddered = [];
  const first = () => {
    reset(); sends = []; timeline = [];
    db.exec('DELETE FROM payout_control');
    return seedWithdrawal({ status: 'tor_checking', retries: 0, priorAttempt: false });
  };
  const noLadder = (id, label) => {
    const ev = db.prepare("SELECT 1 FROM withdrawal_events WHERE withdrawal_id = ? AND to_status = 'retry_scheduled'").get(id);
    if (rowOf(id).status === 'retry_scheduled' || ev) laddered.push(label);
  };
  const FALLBACK = { success: false, torFallback: true, slateId: FB,
    error: 'Tor delivery failed: grin-wallet fell back to printing a slatepack — nothing was posted' };

  // ── A — sent ──
  {
    const id = first();
    db.exec("DELETE FROM alerts WHERE type = 'tor_send_path'");
    const t = new Date().toISOString();
    db.prepare("INSERT INTO alerts (type, level, message, data, status, triggered_at, last_seen) VALUES ('tor_send_path', 'warning', 'x', '{}', 'active', ?, ?)").run(t, t);
    const h = oa({ result: { success: true } });
    await quiet(() => h.s.sendWithdrawal(id));
    ok('A. "Tx sent successfully" → confirmed, ONE send, no probe, no cancel',
      rowOf(id).status === 'confirmed' && sends.length === 1 && h.probes.length === 0 && h.cancels.length === 0,
      JSON.stringify({ row: rowOf(id).status, t: timeline }));
    ok('A. …a delivered Tor send resolves an open tor_send_path alert (the pool\'s own Tor works again)', !alertOf('tor_send_path'));
    noLadder(id, 'A');
  }

  // ── B — fell back to a slatepack, its slate cancelled → refund now; ONE fresh probe names why ──
  for (const [probe, code, label] of [
    [OFFLINE, 'wallet_offline', 'probe says OFFLINE'],
    [{ online: true, reason: 'reachable' }, 'pool_send_path', 'probe says the wallet ANSWERS'],
    [{ online: null, reason: 'tor_unavailable' }, 'wallet_unreachable', 'probe could not look (null)'],
    [new Error('socks exploded'), 'wallet_unreachable', 'probe THROWS'],
  ]) {
    const id = first();
    db.exec("DELETE FROM alerts WHERE type = 'tor_send_path'");
    const h = oa({ result: FALLBACK, probe, log: [tx({ slate: FB, confirmed: false })] });
    await quiet(() => h.s.sendWithdrawal(id));
    ok(`B. fallback + cancel ok, ${label} → tor_failed, fail_code ${code}, balance back NOW`,
      refundedOk(id) && rowOf(id).fail_code === code, JSON.stringify({ row: rowOf(id), acct: acct() }));
    ok(`B. …(${code}) its own slate cancelled first, then the onion probed exactly once — nothing else`,
      h.cancels.join() === FB && h.probes.length === 1 && h.probes[0] === ADDR && timeline.join(',') === 'send,cancel,probe',
      timeline.join(','));
    const sp = alertOf('tor_send_path');
    ok(`B. …(${code}) tor_send_path alert ${code === 'pool_send_path' ? 'RAISED as a warning naming the payout' : 'not raised'}`,
      code === 'pool_send_path' ? (!!sp && sp.level === 'warning' && sp.message.includes(`#${id}`)) : !sp, JSON.stringify(sp));
    const d = rowOf(id).fail_detail;
    ok(`B. …(${code}) fail_detail keeps the CLI error for the operator, ≤ 500 chars`,
      typeof d === 'string' && d.length > 0 && d.length <= 500, String(d));
    noLadder(id, `B ${code}`);
  }
  {
    // A pool_send_path repeat rolls into the SAME alert (one rolling row, not one per payout).
    const id0 = first();
    db.exec("DELETE FROM alerts WHERE type = 'tor_send_path'");
    await quiet(() => oa({ result: FALLBACK, probe: { online: true, reason: 'reachable' }, log: [tx({ slate: FB })] }).s.sendWithdrawal(id0));
    const t0 = alertOf('tor_send_path');
    const id = first();
    await quiet(() => oa({ result: FALLBACK, probe: { online: true, reason: 'reachable' }, log: [tx({ slate: FB })] }).s.sendWithdrawal(id));
    const t1 = alertOf('tor_send_path');
    const n = db.prepare("SELECT COUNT(*) c FROM alerts WHERE type = 'tor_send_path' AND status = 'active'").get().c;
    ok('B. a second pool_send_path within 24 h rolls into the same alert', !!t0 && !!t1 && t1.id === t0.id && t1.occurrence_count === 2 && n === 1,
      JSON.stringify({ t0: t0 && t0.id, t1 }));
  }

  // ── C — refused before any tx exists (NotEnoughFunds) ──
  const SHORT = 'Command failed (code 1): Wallet command failed: Not enough funds. Required: 99.96, Available: 12.5';
  {
    const id = first();
    db.exec("DELETE FROM alerts WHERE type = 'pool_wallet_short'");
    const h = oa({ result: { success: false, error: SHORT } });
    await quiet(() => h.s.sendWithdrawal(id));
    ok('C1. NotEnoughFunds + the tx log shows no match → tor_failed, fail_code pool_busy, balance back NOW',
      refundedOk(id) && rowOf(id).fail_code === 'pool_busy', JSON.stringify({ row: rowOf(id), acct: acct() }));
    ok('C1. …the tx log was READ before the refund (proof of absence); nothing cancelled, nothing probed',
      timeline.join(',') === 'send,wallet' && h.cancels.length === 0 && h.probes.length === 0, timeline.join(','));
    const a1 = alertOf('pool_wallet_short');
    ok('C1. …ONE pool_wallet_short alert carries the real wallet figures (operator side)',
      !!a1 && /Available: 12\.5/.test(a1.message) && a1.occurrence_count === 1, a1 && a1.message);
    ok('C1. …the public fail_code is the enum only; the figures live in the admin-only fail_detail',
      rowOf(id).fail_code === 'pool_busy' && /Available: 12\.5/.test(String(rowOf(id).fail_detail)), String(rowOf(id).fail_detail));
    noLadder(id, 'C1');
    const id2 = first();
    await quiet(() => oa({ result: { success: false, error: SHORT.replace('12.5', '7.25') } }).s.sendWithdrawal(id2));
    const a2 = alertOf('pool_wallet_short');
    ok('C1. a second shortfall within 24 h rolls into the same alert (count 2, latest figures)',
      !!a1 && !!a2 && a2.id === a1.id && a2.occurrence_count === 2 && /7\.25/.test(a2.message), JSON.stringify(a2));
  }
  {
    const id = first();
    const h = oa({ result: (log) => { log.push(tx({ slate: 'C-UNCONF' })); return { success: false, error: SHORT }; } });
    await quiet(() => h.s.sendWithdrawal(id));
    ok('C2. NotEnoughFunds but the tx log holds an UNCONFIRMED match → HELD, not refunded', heldOk(id), JSON.stringify({ row: rowOf(id), acct: acct() }));
    noLadder(id, 'C2');
  }
  {
    const id = first();
    const h = oa({ result: { success: false, error: SHORT }, readable: false });
    await quiet(() => h.s.sendWithdrawal(id));
    ok('C3. NotEnoughFunds but the tx log is UNREADABLE → HELD (no proof of absence → no refund)', heldOk(id), JSON.stringify({ row: rowOf(id), acct: acct() }));
    noLadder(id, 'C3');
  }

  // ── D — anything else: the pool cannot tell → Held ──
  for (const [label, opts] of [
    ['timeout kill', { result: { success: false, error: 'grin-wallet timed out after 120000ms' } }],
    ['unrecognised exit-0 output', { result: { success: false, error: 'grin-wallet send exited 0 without reporting "Tx sent successfully" — outcome unknown' } }],
    ['any other CLI error', { result: { success: false, error: 'Command failed (code 1): LibWallet Error: Unknown' } }],
    ['fallback with NO slate id', { result: Object.assign({}, FALLBACK, { slateId: null }) }],
    ['fallback whose cancel FAILS', { result: FALLBACK, cancelThrows: true, log: [tx({ slate: FB })] }],
    ['the send call itself throws', { result: new Error('spawn grin-wallet ENOENT') }],
  ]) {
    const id = first();
    const h = oa(opts);
    await quiet(() => h.s.sendWithdrawal(id));
    ok(`D. ${label} → tor_held: amount stays locked, no refund`, heldOk(id), JSON.stringify({ row: rowOf(id), acct: acct() }));
    ok(`D. …${label}: never probed, sent exactly once, nothing cancelled but its own fallback slate`,
      h.probes.length === 0 && sends.length === 1 && h.cancels.every((c) => c === FB), JSON.stringify({ p: h.probes, c: h.cancels, t: timeline }));
    ok(`D. …${label}: the hold is journaled with a reason`,
      !!db.prepare("SELECT 1 FROM withdrawal_events WHERE withdrawal_id = ? AND to_status = 'tor_held' AND note LIKE 'held:%'").get(id));
    if (label === 'fallback whose cancel FAILS') {
      ok('D. …the un-cancelled fallback slate is recorded as THIS payout\'s slate (the Held check then looks it up exactly)',
        rowOf(id).slate_id === FB, String(rowOf(id).slate_id));
    }
    noLadder(id, `D ${label}`);
  }

  ok('no outcome of a new Tor payout writes retry_scheduled (row status or event)', laddered.length === 0, laddered.join(', '));
  const src = fs.readFileSync(path.join(APP, 'lib/withdrawal-scheduler.js'), 'utf8').replace(/^\s*\/\/.*$/gm, '');
  ok('…and no statement in the scheduler can: no SET status = \'retry_scheduled\', no event INTO it',
    !/SET\s+status\s*=\s*'retry_scheduled'/.test(src) && !/'retry_scheduled'\s*,\s*'scheduler'/.test(src) &&
    !/VALUES \(\?, \?, 'retry_scheduled'/.test(src));
  ok('…and the ladder machinery is gone (processRetryQueue, scheduleRetry, markFailed, _deferSend, retryDelays)',
    !/\basync processRetryQueue\(|\basync scheduleRetry\(|\basync markFailed\(|\b_deferSend\(|this\.retryDelays\b/.test(src));
  reset();
}

async function heldSection() {
  console.log('\n[held] Held resolution — confirm on proof; refund only on TWO absent reads ≥ 10 min apart; never re-send');
  // (Session 4) A held row's own send was locked inside its attempt — claimed at now−3600, held at
  // now−heldAgoS — so a tx that IS this row's is dated inside that span (SENT), never after the hold.
  const SENT = nowS() - 1800;
  const seedHeld = ({ slate = null, heldAgoS = 60 } = {}) => {
    const id = seedWithdrawal({ status: 'tor_held', slate, retries: 0, priorAttempt: true });
    evNote.run(id, 'tor_sending', 'tor_held', 'held: test', nowS() - heldAgoS);
    return id;
  };
  const absentReads = (id) => db.prepare("SELECT COUNT(*) c FROM withdrawal_events WHERE withdrawal_id = ? AND note LIKE 'held-check: absent%'").get(id).c;
  const age = (id, secs) => db.prepare("UPDATE withdrawal_events SET created_at = created_at - ? WHERE withdrawal_id = ? AND note LIKE 'held-check: absent%'").run(secs, id);
  const run = (s) => thrown(() => quiet(() => s.resolveHeldTor()));

  {
    reset(); sends = [];
    const id = seedHeld();
    await run(newScheduler([tx({ slate: 'H-CONF', confirmed: true, when: SENT })]));
    ok('H1. held + tx log CONFIRMED → confirmed: lock released and debited once, its slate recorded, nothing sent',
      rowOf(id).status === 'confirmed' && acct().balance === 0 && acct().balance_locked === 0 && rowOf(id).slate_id === 'H-CONF' && sends.length === 0,
      JSON.stringify({ row: rowOf(id), acct: acct() }));
  }
  {
    reset(); sends = [];
    const id = seedHeld();
    const s = newScheduler([]);
    await run(s);
    ok('H2. first ABSENT read → still held, still locked, and that read is journaled', heldOk(id) && absentReads(id) === 1,
      JSON.stringify({ row: rowOf(id).status, reads: absentReads(id) }));
    await run(s);
    ok('H3. a second absent read seconds later → STILL held (one read racing a live wallet process must not refund)', heldOk(id));
    ok('H3. …and the repeat read does not restart the streak', absentReads(id) === 1, String(absentReads(id)));
    age(id, 9 * 60);
    await run(s);
    ok('H3. …9 min apart → still held', heldOk(id));
    age(id, 65);
    await run(s);
    ok('H4. absent again ≥ 10 min after the first read → tor_failed, fail_code unknown, balance back',
      refundedOk(id) && rowOf(id).fail_code === 'unknown', JSON.stringify({ row: rowOf(id), acct: acct() }));
    ok('H4. …and nothing was ever re-sent', sends.length === 0);
    const p = typeof s.torPauseStatus === 'function' ? s.torPauseStatus(ADDR) : null;
    ok('H4. …a Held refund is NOT counted toward the Tor pause', !!p && p.failures_24h === 0, JSON.stringify(p));
  }
  {
    reset();
    const id = seedHeld();
    const log = [];
    const s = newScheduler(log);
    await run(s);                          // absent #1
    age(id, 20 * 60);
    log.push(tx({ slate: 'H-FLICKER', when: SENT }));  // an unconfirmed match shows up
    await run(s);
    log.length = 0;                        // …and is gone again
    await run(s);
    ok('H5. absent → UNCONFIRMED → absent: the earlier absent read no longer counts (streak restarts)', heldOk(id),
      JSON.stringify(eventsOf(id).map((e) => e.note)));
  }
  {
    reset();
    const id = seedHeld({ slate: 'H-CANC' });
    const s = newScheduler([tx({ slate: 'H-CANC', type: 'TxSentCancelled' })]);
    await run(s); age(id, 11 * 60); await run(s);
    ok('H6. its slate TxSentCancelled on two reads ≥ 10 min apart → refunded (a cancelled tx never reached the chain)',
      refundedOk(id) && rowOf(id).fail_code === 'unknown', JSON.stringify(rowOf(id)));
  }
  {
    reset();
    const id = seedHeld();
    const s = newScheduler([], { walletReadable: false });
    await run(s); await run(s);
    ok('H7. wallet unreadable → stays held, and no absent read is journaled from a read that never happened',
      heldOk(id) && absentReads(id) === 0);
  }
  {
    reset(); sends = [];
    db.exec("DELETE FROM alerts WHERE type = 'payout_held'");
    const id = seedHeld({ heldAgoS: 25 * 3600 });
    const s = newScheduler([tx({ slate: 'H-STUCK', when: SENT })]);
    await run(s);
    const al = alertOf('payout_held');
    ok('H8. held > 24 h and still unconfirmed → ONE rolling CRITICAL payout_held alert naming it',
      !!al && al.level === 'critical' && al.message.includes(`#${id}`), JSON.stringify(al));
    ok('H8. …still held, still locked, never sent', heldOk(id) && sends.length === 0);
    await run(s);
    ok('H8. …a second tick rolls it, never stacks', db.prepare("SELECT COUNT(*) c FROM alerts WHERE type = 'payout_held' AND status = 'active'").get().c === 1);
    reset();
    seedHeld({ heldAgoS: 3600 });
    await run(newScheduler([tx({ slate: 'H-YOUNG' })]));
    ok('H8. nothing held past 24 h → the alert is resolved', !alertOf('payout_held'));
    // Every pass of the loop, many times over: a held row is never handed to the wallet to send.
    reset(); sends = [];
    const id2 = seedHeld();
    const s2 = newScheduler([]);
    for (let i = 0; i < 3; i++) {
      await quiet(() => s2.processTorChecks());
      await quiet(() => s2.reclaimStaleTorSending());
      await run(s2);
    }
    ok('H8. …three full passes over a held row → zero sends', sends.length === 0 && rowOf(id2).status === 'tor_held');
  }
  {
    reset();
    const id = seedHeld();
    const s = newScheduler([]);
    await quiet(async () => s.freeze('test freeze', 'test'));
    await run(s); age(id, 11 * 60); await run(s);
    // Changed by the 2026-09-26 /review (#1): restore and Migrate IN freeze payouts precisely so
    // nothing moves before the operator reconciles, and a refund here is decided by reading a
    // wallet log that a restore may have replaced. Confirmations still run (see [review-fixes]).
    ok('H9. payouts FROZEN: the Held check still runs, but it never REFUNDS — that waits for a resume',
      heldOk(id), JSON.stringify(rowOf(id)));
    db.exec('DELETE FROM payout_control');
    const src = fs.readFileSync(path.join(APP, 'lib/withdrawal-scheduler.js'), 'utf8');
    const loop = src.slice(src.indexOf('async schedulerLoop()'), src.indexOf('isFrozen() {'));
    ok('H9. the loop runs resolveHeldTor BEFORE the freeze branch', loop.indexOf('await this.resolveHeldTor()') > 0 &&
      loop.indexOf('await this.resolveHeldTor()') < loop.indexOf('if (this.isFrozen())'));
  }
  {
    reset();
    const id = seedHeld();
    // Spendable 50 on top of the held 100: only the one-pending gate can refuse these requests.
    db.prepare('UPDATE miner_accounts SET balance = 50, balance_locked = 100 WHERE grin_address = ?').run(ADDR);
    const s = new WithdrawalScheduler(config, spWallet());
    s.incentives = { maybePayJoinBonus() {} };
    const e1 = await thrown(() => quiet(async () => s.createWithdrawal(ADDR, 25)));
    const e2 = await thrown(() => quiet(() => s.createSlatepackWithdrawal(ADDR, 25)));
    ok('H10. a Held payout keeps the one-pending slot: a new Tor AND a new Slatepack request both 429',
      !!e1 && e1.code === 429 && !!e2 && e2.code === 429 && rowOf(id).status === 'tor_held',
      JSON.stringify({ e1: e1 && e1.message, e2: e2 && e2.message }));
  }
  {
    // Operator forced refund: never on a CONFIRMED match, never on an unreadable log.
    reset();
    let id = seedHeld();
    let e = await thrown(() => quiet(() => newScheduler([tx({ slate: 'F-CONF', confirmed: true, when: SENT })]).forceRefundHeld(id, { adminId: 7 })));
    ok('H11. forced refund REFUSED (409) when the tx log shows a CONFIRMED match — it was paid', !!e && e.code === 409 && heldOk(id),
      e && e.message);
    e = await thrown(() => quiet(() => newScheduler([], { walletReadable: false }).forceRefundHeld(id, { adminId: 7 })));
    ok('H11. forced refund REFUSED (503) when the tx log cannot be read', !!e && e.code === 503 && heldOk(id), e && e.message);
    // Readable but UNMATCHABLE: no entry carries a creation time, so the amount match has no age
    // bound and _priorSendLanded reports checked=false (§J4-4). That is not proof of absence either.
    const noTs = { ...tx({ slate: 'F-NOTS' }) }; delete noTs.creation_ts;
    e = await thrown(() => quiet(() => newScheduler([noTs]).forceRefundHeld(id, { adminId: 7 })));
    ok('H11. forced refund REFUSED (503) when the tx log reads but cannot be matched (no creation times)',
      !!e && e.code === 503 && heldOk(id), e && e.message);
    reset();
    id = seedHeld();
    // (2026-09-26 /review #4) Only a match the wallet records as a bare lock (tx_slate_state
    // Standard1 — the CLI's slatepack fallback, never finalized) is left to the operator's
    // judgement; a round-tripped (Standard2) or unlabelled one is refused — see [review-fixes] F4.
    e = await thrown(() => quiet(() => newScheduler([{ ...tx({ slate: 'F-UNC', when: SENT }), tx_slate_state: 'Standard1' }])
      .forceRefundHeld(id, { adminId: 7, reason: 'checked the node by hand' })));
    const ev = db.prepare("SELECT * FROM withdrawal_events WHERE withdrawal_id = ? AND to_status = 'tor_failed'").get(id);
    ok('H11. an unconfirmed never-finalized match (Standard1: the operator\'s judgement) → refunded, fail_code unknown', !e && refundedOk(id) && rowOf(id).fail_code === 'unknown',
      JSON.stringify({ e: e && e.message, row: rowOf(id) }));
    ok('H11. …journaled as the ADMIN\'s act, with their id', !!ev && ev.triggered_by === 'admin' && ev.actor_id === 7, JSON.stringify(ev));
    reset();
    id = seedWithdrawal({ status: 'tor_checking', retries: 0, priorAttempt: false });
    e = await thrown(() => quiet(() => newScheduler([]).forceRefundHeld(id, { adminId: 7 })));
    ok('H11. a row that is not Held cannot be force-refunded (409)', !!e && e.code === 409 && rowOf(id).status === 'tor_checking');
  }
  reset();
}

async function pauseSection() {
  console.log('\n[pause] 5 counted Tor failures in 24 h → Tor paused for 24 h from the 5th');
  const S = new WithdrawalScheduler(config, null);
  const st = () => (typeof S.torPauseStatus === 'function' ? S.torPauseStatus(ADDR) : null);
  const H = 3600;
  {
    reset();
    for (let i = 1; i <= 4; i++) seedFailed('wallet_offline', i * H);
    const p = st();
    ok('P1. 4 counted failures → "4 of 5", not paused', !!p && p.failures_24h === 4 && p.max === 5 && p.paused_until === null, JSON.stringify(p));
    seedFailed('wallet_offline', 5 * H);
    const q = st();
    const want = nowS() - 5 * H + 86400;
    ok('P2. the 5th counted failure pauses Tor; paused_until = that 5th failure + 24 h',
      !!q && q.failures_24h === 5 && Math.abs(Number(q.paused_until) - want) <= 2, JSON.stringify({ q, want }));
  }
  {
    reset();
    for (let i = 1; i <= 4; i++) seedFailed('wallet_offline', i * H);
    for (const c of ['pool_send_path', 'wallet_unreachable', 'unknown', 'pool_busy', 'wallet_offline_cleared']) seedFailed(c, H);
    seedFailed('wallet_offline', H, 'tgrin1someoneelse');
    const p = st();
    ok('P3. only wallet_offline counts — pool-side, unknown, cleared codes and ANOTHER address do not',
      !!p && p.failures_24h === 4 && p.paused_until === null, JSON.stringify(p));
  }
  {
    reset();
    for (let i = 1; i <= 4; i++) seedFailed('wallet_offline', i * H);
    seedFailed('wallet_offline', 25 * H);
    const p = st();
    ok('P4. a failure older than 24 h has aged out → 4, not paused', !!p && p.failures_24h === 4 && p.paused_until === null, JSON.stringify(p));
    seedFailed('wallet_offline', 6 * H);
    seedFailed('wallet_offline', 5 * H);
    const q = st();
    ok('P4. six in the window → paused_until comes from the 5th MOST RECENT (5 h ago), not the oldest',
      !!q && q.failures_24h === 6 && Math.abs(Number(q.paused_until) - (nowS() - 5 * H + 86400)) <= 2, JSON.stringify(q));
  }
  {
    reset(); fund(200);
    for (let i = 1; i <= 5; i++) seedFailed('wallet_offline', i * H);
    const s = new WithdrawalScheduler(config, spWallet());
    s.incentives = { maybePayJoinBonus() {} };
    const e = await thrown(() => quiet(async () => s.createWithdrawal(ADDR, 25)));
    ok('P5. createWithdrawal (Tor) refuses a paused address: 429 tor_paused, nothing locked',
      !!e && e.code === 429 && /tor_paused/.test(e.message) && acct().balance === 200 && acct().balance_locked === 0,
      JSON.stringify({ e: e && e.message, acct: acct() }));
    const e2 = await thrown(() => quiet(() => s.createSlatepackWithdrawal(ADDR, 25)));
    ok('P5. …Slatepack is NOT paused: the same address creates a slatepack payout', !e2 &&
      !!db.prepare("SELECT 1 FROM withdrawals WHERE grin_address = ? AND status = 'slatepack_pending'").get(ADDR), e2 && e2.message);
  }
  {
    reset();
    const ids = [];
    for (let i = 1; i <= 5; i++) ids.push(seedFailed('wallet_offline', i * H));
    const r = await thrown(() => quiet(async () => S.clearTorPause(ADDR, { adminId: 7 })));
    const p = st();
    ok('P6. clearing a pause un-counts the counted rows → not paused, 0 of 5', !r && !!p && p.failures_24h === 0 && p.paused_until === null,
      JSON.stringify({ r: r && r.message, p }));
    ok('P6. …history kept: the same five rows, still tor_failed, marked wallet_offline_cleared',
      ids.every((id) => rowOf(id).status === 'tor_failed' && rowOf(id).fail_code === 'wallet_offline_cleared'),
      JSON.stringify(ids.map((id) => rowOf(id).fail_code)));
    ok('P6. …each one journaled as the admin\'s act',
      ids.every((id) => db.prepare("SELECT 1 FROM withdrawal_events WHERE withdrawal_id = ? AND triggered_by = 'admin' AND actor_id = 7").get(id)));
  }
  {
    const src = fs.readFileSync(path.join(APP, 'lib/withdrawal-scheduler.js'), 'utf8');
    ok('P7. the thresholds are module constants, not settings (5 / 24 h window / 24 h pause)',
      WithdrawalScheduler.TOR_FAIL_MAX === 5 && WithdrawalScheduler.TOR_FAIL_WINDOW_S === 86400 && WithdrawalScheduler.TOR_PAUSE_S === 86400 &&
      /const TOR_FAIL_MAX = 5;/.test(src));
  }
  reset();
}

async function cooldownSection() {
  console.log('\n[cooldown] no reversal cooldown after a Tor failure — still after a slatepack expiry / Goblin failure / admin cancel');
  const FB = '0000cd01-0000-4000-8000-000000000000';
  // One scheduler that can do both: a Tor send that falls back (slate cancelled, probe offline)
  // and a Slatepack create.
  const both = () => {
    const s = new WithdrawalScheduler(config, spWallet({ async cancelTx() {} }));
    s.walletTor = {
      async sendToTorAddress() { return { success: false, torFallback: true, slateId: FB, error: 'Tor delivery failed' }; },
      async probeToronlineStatus() { return { online: false, reason: 'onion_unreachable' }; },
    };
    s.recordTorFee = async () => {};
    s.incentives = { maybePayJoinBonus() {} };
    return s;
  };
  const torRefund = async (s) => {
    reset(); fund(100); db.exec('DELETE FROM payout_control');
    const r = await quiet(async () => s.createWithdrawal(ADDR, 100));
    await quiet(() => s.sendWithdrawal(r.withdrawal_id));
    return r.withdrawal_id;
  };
  {
    const s = both();
    const id = await torRefund(s);
    const refunded = rowOf(id).status === 'tor_failed' && rowOf(id).fail_code === 'wallet_offline' && acct().balance === 100;
    const e = await thrown(() => quiet(() => s.createSlatepackWithdrawal(ADDR, 50)));
    ok('CD1. right after a Tor refund (wallet_offline) a Slatepack create for the same address SUCCEEDS — no 429 (the offer depends on it)',
      refunded && !e && !!db.prepare("SELECT 1 FROM withdrawals WHERE grin_address = ? AND status = 'slatepack_pending'").get(ADDR),
      JSON.stringify({ refunded, e: e && e.message, row: rowOf(id) }));
  }
  {
    const s = both();
    await torRefund(s);
    const e = await thrown(() => quiet(async () => s.createWithdrawal(ADDR, 50)));
    ok('CD2. …and a NEW Tor request right away is not refused by a cooldown either', !e, e && e.message);
  }
  {
    reset(); fund(0);
    db.prepare('UPDATE miner_accounts SET balance_locked = 25 WHERE grin_address = ?').run(ADDR);
    db.prepare(`INSERT INTO withdrawals (grin_address, amount, fee, fee_charged, status, method, slate_id, created_at)
                VALUES (?, 25, 0, 0.04, 'slatepack_pending', 'slatepack', 'cd-exp', ?)`).run(ADDR, nowS() - 40 * 60);
    const s = both();
    await quiet(() => s.processSlatepackExpiry());
    const e = await thrown(() => quiet(() => s.createSlatepackWithdrawal(ADDR, 25)));
    ok('CD3. after a Slatepack EXPIRY the 30-min cooldown still applies (429)', !!e && e.code === 429 && /wait \d+ min/.test(e.message), e && e.message);
  }
  for (const [label, status, method] of [['a Goblin/Nostr failure', 'nostr_failed', 'nostr'], ['an admin cancel of a Tor row', 'cancelled', 'tor']]) {
    reset(); fund(100);
    const id = Number(db.prepare(`INSERT INTO withdrawals (grin_address, amount, fee_charged, status, method) VALUES (?, 25, 0.04, ?, ?)`)
      .run(ADDR, status, method).lastInsertRowid);
    db.prepare(`INSERT INTO balance_log (grin_address, event_type, amount, balance_before, balance_after, locked_before, locked_after, reference_type, reference_id)
                VALUES (?, 'reversal', 25, 75, 100, 25, 0, 'withdrawal', ?)`).run(ADDR, id);
    const e = await thrown(() => quiet(() => both().createSlatepackWithdrawal(ADDR, 25)));
    ok(`CD4. after ${label} the cooldown still applies (429)`, !!e && e.code === 429, e && e.message);
  }
  reset();
}

async function migrationSection() {
  console.log('\n[migration] legacy retry_scheduled Tor rows are resolved once at startup (idempotent)');
  const run = (s) => thrown(() => quiet(() => s.migrateLegacyTorRetries()));
  {
    reset(); sends = [];
    const conf = seedWithdrawal({ status: 'retry_scheduled', retries: 2, slate: 'MG-CONF' });
    const gone = seedWithdrawal({ status: 'retry_scheduled', retries: 1, slate: 'MG-GONE' });
    const unc = seedWithdrawal({ status: 'retry_scheduled', retries: 1, slate: 'MG-UNC' });
    // seedWithdrawal re-seeds the account each call: three payouts of 100 hold 300 locked.
    db.prepare('UPDATE miner_accounts SET balance = 0, balance_locked = 300 WHERE grin_address = ?').run(ADDR);
    const s = newScheduler([tx({ slate: 'MG-CONF', confirmed: true }), tx({ slate: 'MG-UNC' })]);
    const e = await run(s);
    ok('M1. confirmed on chain → confirmed (paid once, never re-sent)', !e && rowOf(conf).status === 'confirmed', e ? e.message : rowOf(conf).status);
    ok('M2. absent → tor_failed, fail_code unknown', rowOf(gone).status === 'tor_failed' && rowOf(gone).fail_code === 'unknown', JSON.stringify(rowOf(gone)));
    ok('M3. unconfirmed → tor_held', rowOf(unc).status === 'tor_held', rowOf(unc).status);
    ok('M. ledger: 100 paid, 100 back in spendable, 100 still locked — and nothing sent',
      Math.abs(acct().balance - 100) < 1e-9 && Math.abs(acct().balance_locked - 100) < 1e-9 && sends.length === 0, JSON.stringify(acct()));
    const left = db.prepare("SELECT COUNT(*) c FROM withdrawals WHERE status = 'retry_scheduled'").get().c;
    ok('M. no row is left in retry_scheduled (the idempotency proof)', left === 0, String(left));
    const snap = () => JSON.stringify([rowOf(conf), rowOf(gone), rowOf(unc), acct(),
      db.prepare('SELECT COUNT(*) c FROM withdrawal_events').get().c, db.prepare('SELECT COUNT(*) c FROM balance_log').get().c]);
    const before = snap();
    await run(s);
    ok('M. a second run changes nothing (no row, balance, event or ledger write)', snap() === before);
    const p = typeof s.torPauseStatus === 'function' ? s.torPauseStatus(ADDR) : null;
    const cd = await thrown(async () => s._assertNoRecentReversal(ADDR));
    ok('M2. …that refund is not counted toward the pause, and starts no cooldown', !!p && p.failures_24h === 0 && !cd,
      JSON.stringify({ p, cd: cd && cd.message }));
  }
  {
    reset();
    const id = seedWithdrawal({ status: 'retry_scheduled', retries: 1, slate: null });
    await run(newScheduler([], { walletReadable: false }));
    ok('M4. wallet UNREADABLE at startup → tor_held (never refunded blind, never re-sent)', heldOk(id), JSON.stringify(rowOf(id)));
  }
  {
    const src = fs.readFileSync(path.join(APP, 'lib/withdrawal-scheduler.js'), 'utf8');
    const loop = src.slice(src.indexOf('async schedulerLoop()'), src.indexOf('isFrozen() {'));
    ok('M5. the loop runs the migration once, BEFORE its first pass',
      loop.indexOf('migrateLegacyTorRetries()') > 0 && loop.indexOf('migrateLegacyTorRetries()') < loop.indexOf('while (this.isRunning)'));
  }
  reset();
}

async function pendingListSection() {
  console.log('\n[pending-lists] tor_held is in EVERY pending-status list');
  const lists = [];
  for (const f of ['index.js', 'lib/withdrawal-scheduler.js', 'lib/reconciliation.js', 'lib/alert-monitor.js']) {
    const src = fs.readFileSync(path.join(APP, f), 'utf8');
    for (const m of src.matchAll(/status\s+IN\s*\(([^)]*)\)/g)) {
      if (/'tor_sending'/.test(m[1]) && /'slatepack_pending'/.test(m[1])) lists.push({ f, held: /'tor_held'/.test(m[1]), body: m[1].trim() });
    }
  }
  const missing = lists.filter((l) => !l.held);
  ok(`every status list naming tor_sending + slatepack_pending also names tor_held (${lists.length} lists)`,
    lists.length >= 7 && missing.length === 0, missing.map((l) => `${l.f}: ${l.body}`).join(' | '));
  const recon = fs.readFileSync(path.join(APP, 'lib/reconciliation.js'), 'utf8');
  const cand = recon.match(/SELECT id, amount, fee,[^;]*?\bFROM withdrawals\s+WHERE status IN \(([^)]*)\)/);
  ok('reconciliation\'s unrecorded-send audit treats a held row as an ATTEMPTED send (it may have landed)', !!cand && /'tor_held'/.test(cand[1]));
  reset();
  seedWithdrawal({ status: 'tor_held', priorAttempt: true });
  const st = new WithdrawalScheduler(config, null).getStatus();
  ok('getStatus() counts a held row as pending', st.pending === 1, JSON.stringify(st));
  reset();
}

// ─── The real route handlers from index.js, run in-process ───────────────────────────────────
// index.js starts a server on require, so each handler's source is cut out (from its
// `app.<verb>('<path>'` to the next route registration, the same slice test-public-leakage.js
// reads) and evaluated against stubs for everything but the DB and the scheduler.
async function routeSection() {
  console.log('\n[routes] withdraw pause gate, pre-flight 409, summary, P-08, admin held/pause routes (real handlers)');
  const indexSrc = fs.readFileSync(path.join(APP, 'index.js'), 'utf8');
  const routeSrc = (verb, p) => {
    const start = indexSrc.indexOf(`app.${verb}('${p}'`);
    if (start < 0) return '';
    const next = indexSrc.slice(start + 10).search(/\n\s{0,4}app\.(get|post|put|delete|patch)\(/);
    return next < 0 ? indexSrc.slice(start) : indexSrc.slice(start, start + 10 + next);
  };
  const load = (verb, p, deps) => {
    // Only the registration itself: index.js routes close with a `});` line at two-space indent,
    // and top-level code that follows a route (other helpers) must not be evaluated with it.
    const whole = routeSrc(verb, p);
    const end = whole.indexOf('\n  });');
    const src = end < 0 ? whole : whole.slice(0, end + 6);
    if (!src) return null;
    let handler = null;
    const app = { [verb]: (_p, ...fns) => { handler = fns[fns.length - 1]; } };
    // eslint-disable-next-line no-new-func
    new Function('__d', `with (__d) {\n${src}\n}`)({ app, ...deps });
    return handler;
  };
  const call = async (h, req) => {
    const res = {
      statusCode: 200, body: undefined, destroyed: false, headers: {},
      status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; },
      setHeader(k, v) { this.headers[k] = v; }, send(b) { this.body = b; return this; },
    };
    if (!h) { res.statusCode = -1; return res; }
    await quiet(() => h({ ip: '127.0.0.1', params: {}, query: {}, body: {}, user: { user_id: 7 }, ...req }, res));
    return res;
  };
  const rateLimiter = { middleware: () => null, peek: () => ({ allowed: true }), consume() {}, sendLimited() {} };
  // admin_audit_log.admin_id REFERENCES users(id): the admin routes below act as user 7.
  db.prepare("INSERT OR IGNORE INTO users (id, username, password_hash, is_admin) VALUES (7, 'route-test-admin', 'x', 1)").run();
  const probeCalls = [];
  const withdrawDeps = (s, probe) => ({
    db, config: { tor_preflight_gate: true }, nostrBridge: null, rateLimiter,
    normalizeIp: (x) => x,
    verifyOwnerProof: async () => ({ ok: true, method: 'ip' }),
    auditOwnerProof: () => {},
    withdrawalScheduler: s,
    walletTor: { async probeToronlineStatus(a) { probeCalls.push(a); return probe; } },
  });
  const sched = (wallet = null) => { const s = new WithdrawalScheduler(config, wallet); s.incentives = { maybePayJoinBonus() {} }; return s; };

  // ── RT1 the pause is enforced BEFORE the pre-flight probe ──
  {
    reset(); fund(100); probeCalls.length = 0;
    for (let i = 1; i <= 5; i++) seedFailed('wallet_offline', i * 3600);
    const s = sched();
    let creates = 0; const orig = s.createWithdrawal.bind(s); s.createWithdrawal = (...a) => { creates++; return orig(...a); };
    const h = load('post', '/api/account/:addr/withdraw', withdrawDeps(s, { online: true, reason: 'reachable' }));
    const res = await call(h, { params: { addr: ADDR }, body: { method: 'tor', amount: 25, proof: 'x' } });
    const p = typeof s.torPauseStatus === 'function' ? s.torPauseStatus(ADDR) : {};
    ok('RT1. paused address → 429 { error: "tor_paused", paused_until }',
      res.statusCode === 429 && res.body && res.body.error === 'tor_paused' && res.body.paused_until === p.paused_until && !!p.paused_until,
      JSON.stringify({ code: res.statusCode, body: res.body }));
    ok('RT1. …decided BEFORE the probe: the probe was NOT called, nothing created, nothing locked',
      probeCalls.length === 0 && creates === 0 && acct().balance === 100 && acct().balance_locked === 0,
      JSON.stringify({ probes: probeCalls.length, creates, acct: acct() }));
  }
  {
    reset(); fund(100); probeCalls.length = 0;
    for (let i = 1; i <= 4; i++) seedFailed('wallet_offline', i * 3600);
    const s = sched();
    const h = load('post', '/api/account/:addr/withdraw', withdrawDeps(s, { online: true, reason: 'reachable' }));
    const res = await call(h, { params: { addr: ADDR }, body: { method: 'tor', amount: 25, proof: 'x' } });
    ok('RT1. control — 4 of 5: the probe runs and the payout is created', probeCalls.length === 1 && res.statusCode === 200 && res.body.status === 'tor_checking',
      JSON.stringify({ probes: probeCalls.length, body: res.body }));
  }

  // ── RT2 the pre-flight 409 body is exactly what the page keys on ──
  {
    reset(); fund(100); probeCalls.length = 0;
    const s = sched();
    const h = load('post', '/api/account/:addr/withdraw', withdrawDeps(s, { online: false, reason: 'onion_unreachable' }));
    const res = await call(h, { params: { addr: ADDR }, body: { method: 'tor', amount: 25, proof: 'x' } });
    ok('RT2. pre-flight says offline → 409 with tor_online: false and suggest: "slatepack" (unchanged), nothing locked',
      res.statusCode === 409 && res.body && res.body.tor_online === false && res.body.suggest === 'slatepack' &&
      acct().balance === 100 && acct().balance_locked === 0, JSON.stringify(res.body));
  }

  // ── RT3 the Slatepack offer after a Tor refund, through the real route ──
  {
    reset(); fund(100); db.exec('DELETE FROM payout_control');
    const s = sched(spWallet());
    s.walletTor = {
      async sendToTorAddress() { return { success: false, torFallback: true, slateId: '0000ab01-0000-4000-8000-000000000000', error: 'Tor delivery failed' }; },
      async probeToronlineStatus() { return { online: false, reason: 'onion_unreachable' }; },
    };
    s.recordTorFee = async () => {};
    const r = await quiet(async () => s.createWithdrawal(ADDR, 100));
    await quiet(() => s.sendWithdrawal(r.withdrawal_id));
    const h = load('post', '/api/account/:addr/withdraw', withdrawDeps(s, { online: true }));
    const res = await call(h, { params: { addr: ADDR }, body: { method: 'slatepack', amount: 100, proof: 'x' } });
    ok('RT3. Tor refund (wallet_offline) → the page\'s one-click Slatepack POST succeeds at once (no cooldown 429)',
      rowOf(r.withdrawal_id).fail_code === 'wallet_offline' && res.statusCode === 200 && res.body.status === 'slatepack_pending' && !!res.body.slatepack,
      JSON.stringify({ code: res.statusCode, body: res.body, row: rowOf(r.withdrawal_id) }));
  }

  // ── RT4 the account summary ──
  const summaryDeps = (s) => ({
    db, rateLimiter, PROOF_SET_MAX: 10, withdrawalScheduler: s, config: { min_withdrawal: 25, withdrawal_fee: 0.04 },
    hashrateTracker: { getMinerHashrate: () => ({ avg_hashrate: 0 }) }, minerManager: null, incentivesManager: null,
    dormancyManager: null, nostrBridge: null,
  });
  {
    reset(); fund(10);
    for (let i = 1; i <= 5; i++) seedFailed('wallet_offline', i * 3600);
    const s = new WithdrawalScheduler({ ...config, slatepack_ttl_minutes: 45 }, null);
    const h = load('get', '/api/account/:addr', summaryDeps(s));
    const res = await call(h, { params: { addr: ADDR } });
    const b = res.body || {};
    ok('RT4. summary carries slatepack_window_minutes = the live slatepack TTL (45 here)',
      res.statusCode === 200 && b.slatepack_window_minutes === 45 && s.slatepackTtlSeconds === 45 * 60, JSON.stringify({ code: res.statusCode, w: b.slatepack_window_minutes, err: b.error }));
    ok('RT4. summary carries tor_pause { failures_24h, max, paused_until } — counts and a timestamp only',
      !!b.tor_pause && b.tor_pause.failures_24h === 5 && b.tor_pause.max === 5 && Number.isInteger(b.tor_pause.paused_until) &&
      Object.keys(b.tor_pause).sort().join() === 'failures_24h,max,paused_until', JSON.stringify(b.tor_pause));
    reset(); fund(10);
    const res2 = await call(load('get', '/api/account/:addr', summaryDeps(new WithdrawalScheduler(config, null))), { params: { addr: ADDR } });
    ok('RT4. …default TTL → 30; no failures → { 0, 5, null }', res2.body && res2.body.slatepack_window_minutes === 30 &&
      JSON.stringify(res2.body.tor_pause) === '{"failures_24h":0,"max":5,"paused_until":null}', JSON.stringify(res2.body && res2.body.tor_pause));
    reset();
    seedWithdrawal({ status: 'tor_held', priorAttempt: true });
    const res3 = await call(load('get', '/api/account/:addr', summaryDeps(new WithdrawalScheduler(config, null))), { params: { addr: ADDR } });
    ok('RT4. a Held payout is the summary\'s pending_withdrawal', res3.body && res3.body.pending_withdrawals === 1 &&
      res3.body.pending_withdrawal && res3.body.pending_withdrawal.status === 'tor_held', JSON.stringify(res3.body && res3.body.pending_withdrawal));
  }

  // ── RT5 P-08 history: fail_code yes, fail_detail never ──
  {
    reset();
    const id = seedFailed('pool_send_path', 60);
    db.prepare("UPDATE withdrawals SET fail_detail = 'SECRET-CLI-OUTPUT' WHERE id = ?").run(id);
    const h = load('get', '/api/account/:addr/withdrawals', { db, rateLimiter });
    const res = await call(h, { params: { addr: ADDR } });
    const row = res.body && res.body.withdrawals && res.body.withdrawals[0];
    ok('RT5. GET /api/account/:addr/withdrawals rows carry fail_code', !!row && row.fail_code === 'pool_send_path', JSON.stringify(row));
    ok('RT5. …and never fail_detail', !!row && !('fail_detail' in row) && !JSON.stringify(res.body).includes('SECRET-CLI-OUTPUT'));
    const routes = [...indexSrc.matchAll(/\bapp\.(get|post|put|delete|patch)\('([^']+)'/g)].map((m) => [m[1], m[2]]);
    const leaks = routes.filter(([v, p]) => !p.startsWith('/api/admin') && /fail_detail/.test(routeSrc(v, p).replace(/\/\/[^\n]*/g, '')));
    ok('RT5. no non-admin route names fail_detail at all', leaks.length === 0, leaks.map((l) => l.join(' ')).join(', '));
  }

  // ── RT5b P-06/P-07 ledger rows name the payout's rail ("payout returned · Tor") ──
  // Through the real handler AND the real direction SQL, lifted from index.js, so the in/out
  // split the page reads is the one tested.
  {
    reset(); fund(100);
    const dirSrc = (indexSrc.match(/const LEDGER_DIRECTION_SQL = (\{[\s\S]*?\n  \});/) || [])[1] || 'null';
    // eslint-disable-next-line no-new-func
    const LEDGER_DIRECTION_SQL = new Function('return ' + dirSrc)();
    const OTHER = 'tgrin1zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz';
    fund(0, OTHER);
    const sp = Number(db.prepare(`INSERT INTO withdrawals (grin_address, amount, fee_charged, status, method, created_at)
      VALUES (?, 25, 0.04, 'slatepack_expired', 'slatepack', ?)`).run(ADDR, nowS() - 900).lastInsertRowid);
    const tor = seedFailed('wallet_offline', 600);
    const foreign = seedFailed('wallet_offline', 600, OTHER);
    const log = db.prepare(`INSERT INTO balance_log (grin_address, event_type, amount, balance_before, balance_after,
      locked_before, locked_after, reference_type, reference_id, created_at) VALUES (?, ?, 25, 0, 0, 0, 0, ?, ?, ?)`);
    log.run(ADDR, 'lock', 'withdrawal', sp, nowS() - 900);
    log.run(ADDR, 'reversal', 'withdrawal', sp, nowS() - 800);
    log.run(ADDR, 'lock', 'withdrawal', tor, nowS() - 700);
    log.run(ADDR, 'reversal', 'withdrawal', tor, nowS() - 600);
    log.run(ADDR, 'credit', 'block', sp, nowS() - 500);            // a block height that equals a payout id
    log.run(ADDR, 'reversal', 'withdrawal', foreign, nowS() - 400); // a payout id owned by another address
    const h = load('get', '/api/account/:addr/balance/log', { db, rateLimiter, LEDGER_DIRECTION_SQL });
    const inn = await call(h, { params: { addr: ADDR }, query: { direction: 'in' } });
    const out = await call(h, { params: { addr: ADDR }, query: { direction: 'out' } });
    const rail = (res, ev, ref) => ((res.body && res.body.log) || [])
      .filter((r) => r.event_type === ev && Number(r.reference_id) === ref).map((r) => r.payout_method);
    ok('RT5b. ledger payout rows carry payout_method — the lock (out) and the reversal (in), per rail',
      !!LEDGER_DIRECTION_SQL && inn.statusCode === 200 && out.statusCode === 200 &&
      JSON.stringify(rail(out, 'lock', sp)) === '["slatepack"]' && JSON.stringify(rail(inn, 'reversal', sp)) === '["slatepack"]' &&
      JSON.stringify(rail(out, 'lock', tor)) === '["tor"]' && JSON.stringify(rail(inn, 'reversal', tor)) === '["tor"]',
      JSON.stringify({ in: inn.body, out: out.body }));
    ok('RT5b. …null on a non-payout row whose reference_id equals a payout id, and on another address\'s payout',
      JSON.stringify(rail(inn, 'credit', sp)) === '[null]' && JSON.stringify(rail(inn, 'reversal', foreign)) === '[null]',
      JSON.stringify(inn.body && inn.body.log));
    reset(); // its payout rows first: withdrawals.grin_address references the account
    db.prepare('DELETE FROM miner_accounts WHERE grin_address = ?').run(OTHER);
  }

  // ── RT6 admin: retry removed, recheck, forced refund, pause clear, cancel ──
  const adminDeps = (s) => ({ db, secureAdmin: null, freshAdmin: null, withdrawalScheduler: s, getPayoutControl: () => ({ frozen: false }),
    hashrateTracker: { getMinerHashrate: () => ({}) }, PROOF_SET_MAX: 10 });
  const audit = (action) => db.prepare('SELECT * FROM admin_audit_log WHERE action = ? ORDER BY id DESC LIMIT 1').get(action);
  const seedHeld = () => { const id = seedWithdrawal({ status: 'tor_held', priorAttempt: true }); evNote.run(id, 'tor_sending', 'tor_held', 'held: test', nowS() - 60); return id; };
  {
    reset();
    const id = seedWithdrawal({ status: 'tor_failed', priorAttempt: true });
    const res = await call(load('post', '/api/admin/withdrawals/:id/retry', adminDeps(sched())), { params: { id: String(id) } });
    ok('RT6. POST /api/admin/withdrawals/:id/retry is gone for Tor → 410, row untouched', res.statusCode === 410 && rowOf(id).status === 'tor_failed',
      JSON.stringify({ code: res.statusCode, body: res.body }));
  }
  {
    reset();
    const id = seedHeld();
    const s = newScheduler([tx({ slate: 'RC-CONF', confirmed: true, when: nowS() - 1800 })]);
    const res = await call(load('post', '/api/admin/withdrawals/:id/recheck', adminDeps(s)), { params: { id: String(id) } });
    ok('RT6. recheck of a Held row runs the SAME resolution → confirmed', res.statusCode === 200 && rowOf(id).status === 'confirmed' &&
      res.body.status === 'confirmed', JSON.stringify({ code: res.statusCode, body: res.body }));
    ok('RT6. …with an audit row', !!audit('withdrawal_held_recheck'));
    const res2 = await call(load('post', '/api/admin/withdrawals/:id/recheck', adminDeps(s)), { params: { id: String(id) } });
    ok('RT6. recheck of a row that is not Held → 409', res2.statusCode === 409, JSON.stringify(res2.body));
  }
  {
    reset();
    const id = seedHeld();
    const s = newScheduler([]);
    const h = load('post', '/api/admin/withdrawals/:id/force-refund', adminDeps(s));
    const bad = await call(h, { params: { id: String(id) }, body: { confirm_id: String(Number(id) + 1) } });
    ok('RT6. forced refund with a mistyped payout id → 400, nothing changed', bad.statusCode === 400 && heldOk(id), JSON.stringify(bad.body));
    const good = await call(h, { params: { id: String(id) }, body: { confirm_id: String(id), reason: 'node checked' } });
    ok('RT6. forced refund with the typed id and an absent tx → refunded, audit row', good.statusCode === 200 && refundedOk(id) &&
      !!audit('withdrawal_force_refund'), JSON.stringify({ code: good.statusCode, body: good.body }));
    ok('RT6. …the route is step-up gated (freshAdmin)', /app\.post\('\/api\/admin\/withdrawals\/:id\/force-refund', freshAdmin,/.test(indexSrc));
  }
  {
    reset();
    for (let i = 1; i <= 5; i++) seedFailed('wallet_offline', i * 3600);
    const s = sched();
    const h = load('post', '/api/admin/miners/:addr/tor-pause/clear', adminDeps(s));
    const res = await call(h, { params: { addr: ADDR } });
    ok('RT6. pause clear → 200, 5 rows un-counted, not paused any more, audit row',
      res.statusCode === 200 && res.body.cleared === 5 && res.body.tor_pause && res.body.tor_pause.paused_until === null && !!audit('miner_tor_pause_clear'),
      JSON.stringify({ code: res.statusCode, body: res.body }));
    ok('RT6. …step-up gated (freshAdmin)', /app\.post\('\/api\/admin\/miners\/:addr\/tor-pause\/clear', freshAdmin,/.test(indexSrc));
    const none = await call(h, { params: { addr: 'tgrin1nobody' } });
    ok('RT6. pause clear for an unknown address → 404', none.statusCode === 404, JSON.stringify(none.body));
    for (let i = 1; i <= 5; i++) seedFailed('wallet_offline', i * 3600);
    const mv = await call(load('get', '/api/admin/miners/:addr', adminDeps(s)), { params: { addr: ADDR } });
    ok('RT6. the admin miner view shows tor_pause', mv.body && mv.body.miner && mv.body.miner.tor_pause &&
      mv.body.miner.tor_pause.failures_24h === 5 && !!mv.body.miner.tor_pause.paused_until, JSON.stringify(mv.body && mv.body.miner && mv.body.miner.tor_pause));
  }
  {
    // A Held row, and a legacy retry_scheduled one, are no longer cancellable by hand: cancel
    // refunded without asking the wallet. The Held path has its own proof-gated forced refund.
    reset();
    const h = load('post', '/api/admin/withdrawals/:id/cancel', adminDeps(sched()));
    const held = seedHeld();
    const legacy = seedWithdrawal({ status: 'retry_scheduled', priorAttempt: true });
    const r1 = await call(h, { params: { id: String(held) }, body: {} });
    const r2 = await call(h, { params: { id: String(legacy) }, body: {} });
    ok('RT6. admin cancel refuses tor_held and retry_scheduled (409) — no refund without proof',
      r1.statusCode === 409 && r2.statusCode === 409 && rowOf(held).status === 'tor_held' && rowOf(legacy).status === 'retry_scheduled',
      JSON.stringify({ r1: r1.statusCode, r2: r2.statusCode }));
    const q = seedWithdrawal({ status: 'tor_checking', retries: 0, priorAttempt: false });
    const r3 = await call(h, { params: { id: String(q) }, body: {} });
    ok('RT6. …control: a never-sent tor_checking row is still cancellable', r3.statusCode === 200 && rowOf(q).status === 'cancelled', JSON.stringify(r3.body));
  }
  {
    // A tor_failed row was refunded when it failed, so cancel had nothing to return. It only
    // relabelled the row 'cancelled', and four readers key on 'tor_failed': auditWalletSends
    // (counts 'cancelled' as recorded, which hides a double pay), the Tor pause count, the
    // pool-side payout_failed alert and the cooldown exclusion. Operator decision 2026-09-27.
    reset(); fund(100);
    const h = load('post', '/api/admin/withdrawals/:id/cancel', adminDeps(sched()));
    const failed = seedFailed('wallet_offline', 600);
    const logBefore = db.prepare('SELECT COUNT(*) AS c FROM balance_log WHERE grin_address = ?').get(ADDR).c;
    const r = await call(h, { params: { id: String(failed) }, body: {} });
    ok('RT6. admin cancel refuses tor_failed (409): it was refunded when it failed',
       r.statusCode === 409 && rowOf(failed).status === 'tor_failed' && rowOf(failed).fail_code === 'wallet_offline',
       JSON.stringify({ code: r.statusCode, body: r.body, status: rowOf(failed).status }));
    ok('RT6. …and moves no money and writes no ledger row',
       Math.abs(acct().balance - 100) < 1e-9 && Math.abs(acct().balance_locked) < 1e-9 &&
       db.prepare('SELECT COUNT(*) AS c FROM balance_log WHERE grin_address = ?').get(ADDR).c === logBefore,
       JSON.stringify(acct()));
  }

  // ── RT9 (Session 4 review, R9) a double-click on "Send as Slatepack instead" cannot make two ──
  // The page's in-flight flag only spares the second POST; the server must refuse it on its own.
  // Two POSTs through the REAL handler, concurrently, with the wallet's init held open until both
  // are in flight — so the second arrives while the first is inside its wallet awaits.
  {
    reset(); fund(200); db.exec('DELETE FROM payout_control');
    let release;
    const gate = new Promise((r) => { release = r; });
    const w = spWallet({ async initSendTx(a) { this.n++; await gate; return { id: `rt9-${this.n}`, amt: a, fee: '23500000' }; } });
    const s = sched(w);
    const h = load('post', '/api/account/:addr/withdraw', withdrawDeps(s, { online: true }));
    const mk = () => ({ statusCode: 200, body: undefined, destroyed: false, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } });
    const req = () => ({ ip: '127.0.0.1', params: { addr: ADDR }, query: {}, body: { method: 'slatepack', amount: 100, proof: 'x' } });
    const a = mk(); const b = mk();
    await quiet(async () => {
      const pa = h(req(), a);
      const pb = h(req(), b);
      await new Promise((r) => setImmediate(r));
      release();
      await Promise.all([pa, pb]);
    });
    const rows = db.prepare('SELECT id, status FROM withdrawals WHERE grin_address = ?').all(ADDR);
    const codes = [a.statusCode, b.statusCode].sort();
    ok('RT9. two concurrent Slatepack POSTs → ONE payout row, one 200 and one 429 (one-pending gate)',
      rows.length === 1 && rows[0].status === 'slatepack_pending' && codes[0] === 200 && codes[1] === 429,
      JSON.stringify({ rows, codes, a: a.body, b: b.body }));
    ok('RT9. …the wallet built ONE slate, and only 100 of the 200 is locked',
      w.n === 1 && Math.abs(acct().balance - 100) < 1e-9 && Math.abs(acct().balance_locked - 100) < 1e-9,
      JSON.stringify({ inits: w.n, acct: acct() }));
  }
  reset();
}

async function alertNoiseSection() {
  console.log('\n[alert-noise] payout_failed counts only POOL-side Tor failures');
  const AlertMonitor = require(path.join(APP, 'lib/alert-monitor.js'));
  const am = new AlertMonitor({}, {}, db);
  const fired = [];
  am.triggerAlert = async (t, d) => { fired.push({ t, d }); };
  am.resolveAlert = async (t) => { fired.push({ t, resolved: true }); };
  reset();
  for (let i = 0; i < 3; i++) seedFailed('wallet_offline', 3600);
  seedFailed('wallet_unreachable', 3600);
  await quiet(() => am.checkPayoutHealth());
  ok('AN1. four miner-side failures (wallet_offline / wallet_unreachable) → payout_failed NOT raised',
    fired.length > 0 && fired.every((f) => f.resolved), JSON.stringify(fired));
  fired.length = 0;
  seedFailed('pool_send_path', 3600);
  // A Held row resolved as refunded today, requested three days ago: counted by when it FAILED.
  const late = seedFailed('unknown', 600);
  db.prepare('UPDATE withdrawals SET created_at = ? WHERE id = ?').run(nowS() - 3 * 86400, late);
  await quiet(() => am.checkPayoutHealth());
  const hit = fired.find((f) => !f.resolved && f.t === 'payout_failed');
  ok('AN2. pool-side failures (pool_send_path, unknown) raise it, counted by the failure time', !!hit && hit.d.data.failed_count === 2,
    JSON.stringify(fired));
  reset();
}

// ═══ [review-s4] Session 4 review (2026-09-26): the amount matcher, re-derived ═══════════════
// grin-wallet v5.5.0 (libwallet selection.rs lock_tx_context) writes the sender's TxSent with
// amount_debited = Σ inputs, amount_credited = Σ change, fee = the slate's FeeFields — so
// debited − credited − fee.fee() is the recipient amount. Two things the matcher got wrong:
//   · it had only a LOWER time bound and a `claimed` set, so one Tor row could take another
//     Tor row's same-amount tx: the wrong row is marked paid, and the real owner — its tx now
//     "claimed" — reads absent twice and is REFUNDED on top of a send that landed (R1a–R1c);
//   · FeeFields serialises as the RAW u64 (fee_shift << 40 | fee) — upstream masks it with
//     .fee() before the same subtraction ("apply fee mask past HF4"); the pool did not (R1d).
async function reviewS4Section() {
  console.log('\n[review-s4] R1 — the amount match is bound to the row\'s OWN send attempts');
  const ADDR_B = 'tgrin1' + 'p'.repeat(58);
  const t0 = nowS() - 4 * 3600;
  const fresh = () => {
    reset();
    db.prepare(`INSERT INTO miner_accounts (grin_address, balance, balance_locked) VALUES (?, 0, 0)
      ON CONFLICT(grin_address) DO UPDATE SET balance = 0, balance_locked = 0`).run(ADDR_B);
  };
  const acctOf = (a) => db.prepare('SELECT balance, balance_locked FROM miner_accounts WHERE grin_address = ?').get(a);
  // A Tor row with ONE attempt: claimed at claimAt, left tor_sending (→ tor_held) at heldAt
  // (null = still open). Amount 100, fee 0.04 → net 99.96, locked on `addr`.
  const seedAttempt = (addr, { created, claimAt, heldAt = null, status = 'tor_held', slate = null }) => {
    db.prepare('UPDATE miner_accounts SET balance_locked = balance_locked + 100 WHERE grin_address = ?').run(addr);
    const id = Number(db.prepare(
      `INSERT INTO withdrawals (grin_address, amount, fee_charged, status, method, slate_id, created_at)
       VALUES (?, 100, 0.04, ?, 'tor', ?, ?)`).run(addr, status, slate, created).lastInsertRowid);
    evNote.run(id, 'tor_checking', 'tor_sending', null, claimAt);
    if (heldAt !== null) evNote.run(id, 'tor_sending', status === 'confirmed' ? 'confirmed' : 'tor_held', 'held: test', heldAt);
    return id;
  };
  const ageAbsent = () => db.prepare("UPDATE withdrawal_events SET created_at = created_at - 700 WHERE note LIKE 'held-check: absent%'").run();
  const twoReads = async (s) => { await quiet(() => s.resolveHeldTor()); ageAbsent(); await quiet(() => s.resolveHeldTor()); };
  const reversed = (id) => !!db.prepare("SELECT 1 FROM balance_log WHERE reference_id = ? AND event_type = 'reversal'").get(id);

  {
    // Y (miner B) was sent first and died before any lock; X (miner A) was sent next and its tx
    // MINED, but the CLI was killed after the post → both Held, same net, no slate id on either.
    fresh();
    const Y = seedAttempt(ADDR_B, { created: t0, claimAt: t0 + 10, heldAt: t0 + 130 });
    const X = seedAttempt(ADDR, { created: t0 + 20, claimAt: t0 + 131, heldAt: t0 + 251 });
    const s = newScheduler([tx({ slate: 'X-SLATE', confirmed: true, when: t0 + 140 })]);
    await twoReads(s);
    ok('R1a. a Held row is never confirmed by ANOTHER row\'s same-amount tx (it was locked after this row\'s attempt ended)',
      rowOf(Y).status !== 'confirmed' && rowOf(Y).slate_id !== 'X-SLATE', JSON.stringify(rowOf(Y)));
    ok('R1a. …the tx\'s real owner is confirmed by it, and NEVER refunded (miner A paid once, not twice)',
      rowOf(X).status === 'confirmed' && rowOf(X).slate_id === 'X-SLATE' && !reversed(X) &&
      Math.abs(acctOf(ADDR).balance) < 1e-9 && Math.abs(acctOf(ADDR).balance_locked) < 1e-9,
      JSON.stringify({ X: rowOf(X), A: acctOf(ADDR) }));
  }
  {
    // X's send POSTED (unconfirmed) inside its own attempt, but another Tor row Z carries X's
    // slate id (a wrong amount-inferred claim). X must never read "absent" off that.
    fresh();
    const X = seedAttempt(ADDR, { created: t0, claimAt: t0 + 10, heldAt: t0 + 130 });
    seedAttempt(ADDR_B, { created: t0 + 20, claimAt: t0 + 200, heldAt: t0 + 260, status: 'confirmed', slate: 'X-POSTED' });
    const s = newScheduler([tx({ slate: 'X-POSTED', confirmed: false, when: t0 + 60 })]);
    await twoReads(s);
    ok('R1b. a posted-but-unmined send inside the row\'s own attempt is never read "absent" because another Tor row claims its slate',
      heldOk(X), JSON.stringify({ X: rowOf(X), notes: eventsOf(X).map((e) => e.note) }));
  }
  {
    // A crash: Y's attempt never settled until the stale sweep held it (t0+700), and X was sent
    // inside that span — so ONE confirmed tx lies in both rows' windows. Either could own it.
    fresh();
    const Y = seedAttempt(ADDR_B, { created: t0, claimAt: t0 + 10, heldAt: t0 + 700 });
    const X = seedAttempt(ADDR, { created: t0 + 20, claimAt: t0 + 100, heldAt: t0 + 220 });
    const s = newScheduler([tx({ slate: 'AMBIG', confirmed: true, when: t0 + 150 })]);
    await twoReads(s);
    ok('R1c. one confirmed tx inside TWO rows\' windows → neither is confirmed from it, neither refunded (both stay held)',
      rowOf(Y).status === 'tor_held' && rowOf(X).status === 'tor_held' && !reversed(X) && !reversed(Y),
      JSON.stringify({ Y: rowOf(Y), X: rowOf(X) }));
    const eX = await thrown(() => quiet(() => s.forceRefundHeld(X, { adminId: 7 })));
    const eY = await thrown(() => quiet(() => s.forceRefundHeld(Y, { adminId: 7 })));
    ok('R1c. …and the forced refund is REFUSED (409) for both: a confirmed tx that may be theirs is on chain',
      !!eX && eX.code === 409 && !!eY && eY.code === 409 && rowOf(X).status === 'tor_held' && rowOf(Y).status === 'tor_held',
      JSON.stringify({ eX: eX && eX.message, eY: eY && eY.message }));
  }
  {
    // FeeFields with fee_shift = 1: the raw u64 is (1 << 40) | fee. The recipient amount uses fee().
    fresh();
    const X = seedAttempt(ADDR, { created: t0, claimAt: t0 + 10, heldAt: t0 + 130 });
    const feeNano = 23500000n;
    const shifted = { ...tx({ slate: 'SHIFT', confirmed: false, when: t0 + 60 }),
      amount_debited: String(99960000000n + feeNano), fee: String((1n << 40n) | feeNano) };
    await twoReads(newScheduler([shifted]));
    ok('R1d. a TxSent whose FeeFields carries a fee_shift still matches (fee masked to 40 bits) → held, not refunded',
      heldOk(X), JSON.stringify(rowOf(X)));
    fresh();
    const X2 = seedAttempt(ADDR, { created: t0, claimAt: t0 + 10, heldAt: t0 + 130 });
    await twoReads(newScheduler([{ ...shifted, confirmed: true }]));
    ok('R1d. …and the same entry CONFIRMED settles the row as paid', rowOf(X2).status === 'confirmed' && rowOf(X2).slate_id === 'SHIFT',
      JSON.stringify(rowOf(X2)));
  }
  fresh();
  db.prepare('DELETE FROM miner_accounts WHERE grin_address = ?').run(ADDR_B);

  // ── _captureTorSlateId (review finding (c), 2026-09-26): the proof-link slate id is captured by
  // the same attempt-window rule as the matcher, not by the old "created_at − 60 s" lower bound.
  // A wrong capture no longer refunds anything, but it puts another payout's kernel link on this one.
  console.log('\n[review-s4] _captureTorSlateId — only a tx locked inside THIS row\'s own attempt');
  const capture = async (txs, { claimAt = t0 + 100 } = {}) => {
    fresh();
    const id = seedAttempt(ADDR, { created: t0, claimAt, status: 'tor_sending' });
    await quiet(() => newScheduler(txs)._captureTorSlateId(id, 99.96));
    return rowOf(id).slate_id;
  };
  ok('CT1. a same-net tx locked BEFORE this row\'s attempt began (another payout\'s) is NOT captured',
    await capture([{ ...tx({ slate: 'BEFORE', when: t0 + 50 }), id: 9 }]) === null);
  ok('CT1. control: a same-net tx locked inside the open attempt is captured',
    await capture([{ ...tx({ slate: 'INSIDE', when: t0 + 150 }), id: 9 }]) === 'INSIDE');
  {
    // The crash overlap of R1c, from the capture side: the tx fits a second Tor row's attempt too.
    fresh();
    seedAttempt(ADDR_B, { created: t0 - 10, claimAt: t0 + 10, heldAt: t0 + 700 });
    const id = seedAttempt(ADDR, { created: t0, claimAt: t0 + 100, status: 'tor_sending' });
    await quiet(() => newScheduler([{ ...tx({ slate: 'BOTH', when: t0 + 150 }), id: 9 }])._captureTorSlateId(id, 99.96));
    ok('CT2. a tx that also fits ANOTHER Tor row\'s attempt is not captured (it may be that payout\'s)', rowOf(id).slate_id === null,
      JSON.stringify(rowOf(id)));
  }
  fresh();
  db.prepare('DELETE FROM miner_accounts WHERE grin_address = ?').run(ADDR_B);
}

// ═══ [health-card] the payout alerts reach the admin health page (2026-09-26) ════════════════
// payout_held (critical: a Tor payout held > 24 h) and tor_send_path (warning: the miner's wallet
// answers our probe but grin-wallet could not deliver — payout #10's symptom) used to live in the
// alerts table only. They now fold into the Grin Wallet card beside payout_unmined, through ONE
// helper the /api/admin/health route calls.
async function healthCardSection() {
  console.log('\n[health-card] payout alerts on the Grin Wallet card; the unrecorded-send audit ignores refunded Tor rows');
  const AlertMonitor = require(path.join(APP, 'lib/alert-monitor.js'));
  const fold = (card) => (typeof AlertMonitor.foldPayoutAlerts === 'function' ? AlertMonitor.foldPayoutAlerts(db, card) : card);
  const wipe = () => { reset(); db.exec("DELETE FROM alerts WHERE type IN ('payout_unmined','payout_held','tor_send_path','slate_finalized_elsewhere','slate_expiry_unverified')"); };
  const s = newScheduler([]);

  wipe();
  ok('HC0. nothing active → the card is left exactly as measured', JSON.stringify(fold({ status: 'ok', spendable_balance: 5 })) ===
    JSON.stringify({ status: 'ok', spendable_balance: 5 }));

  wipe();
  const held = seedWithdrawal({ status: 'tor_held' });
  evNote.run(held, 'tor_sending', 'tor_held', 'held: test', nowS() - 90000);
  await quiet(() => s._raiseHeldAlert(nowS()));
  const c1 = fold({ status: 'ok' });
  ok('HC1. a payout held > 24 h → the card reads CRITICAL and names it', c1.status === 'critical' && /held over 24 h/.test(c1.message || ''),
    JSON.stringify(c1));

  wipe();
  await quiet(() => s._noteTorSendPath({ id: 10 }, 'reachable'));
  const c2 = fold({ status: 'ok' });
  ok('HC2. tor_send_path → Degraded (warning) with the "check the pool wallet\'s Tor" message',
    c2.status === 'warning' && /pool wallet's Tor/.test(c2.message || ''), JSON.stringify(c2));

  wipe();
  s._rollingAlert('payout_unmined', 'critical', 'unmined test', {});
  const c3 = fold({ status: 'ok' });
  ok('HC3. payout_unmined critical still folds as before', c3.status === 'critical' && /unmined test/.test(c3.message || ''), JSON.stringify(c3));

  wipe();
  await quiet(() => s._noteTorSendPath({ id: 10 }, 'reachable'));
  s._rollingAlert('payout_held', 'critical', 'held test', {});
  const c4 = fold({ status: 'error', message: 'owner API down' });
  ok('HC4. a wallet that is DOWN stays Down (error is never masked), and both messages are appended',
    c4.status === 'error' && /owner API down/.test(c4.message) && /held test/.test(c4.message) && /pool wallet's Tor/.test(c4.message),
    JSON.stringify(c4));
  {
    // Reconciliation's out-of-band send audit (review finding (b), 2026-09-26). A tor_failed row
    // is refunded, and since the one-attempt change only on wallet proof that nothing was sent — so
    // a CONFIRMED send whose only match is such a row is a double pay, not a "recorded" payout.
    const { auditWalletSends } = require(path.join(APP, 'lib/reconciliation.js'));
    const sendOf = (slate) => ({ id: 1, tx_type: 'TxSent', confirmed: true, tx_slate_id: slate,
      creation_ts: new Date().toISOString(), amount_debited: String(99960000000), amount_credited: '0', fee: '0' });
    const audit = async (status) => {
      reset();
      const id = seedWithdrawal({ status, priorAttempt: true });
      db.prepare("UPDATE withdrawals SET fail_code = CASE WHEN ? = 'tor_failed' THEN 'unknown' ELSE NULL END WHERE id = ?").run(status, id);
      return auditWalletSends(db, { async getTransactions() { return [sendOf('LANDED')]; } }, {});
    };
    const a1 = await audit('tor_failed');
    ok('HC7. a confirmed wallet send matching only a REFUNDED Tor row (e.g. a forced refund whose tx later mined) is UNRECORDED',
      a1.reachable && a1.unrecorded.length === 1 && a1.matched === 0, JSON.stringify(a1));
    const a2 = await audit('confirmed');
    ok('HC7. control: the same send against a paid row is matched', a2.reachable && a2.matched === 1 && a2.unrecorded.length === 0,
      JSON.stringify(a2));
    const a3 = await audit('tor_held');
    ok('HC7. control: …and against a HELD row it is matched too (its send may have landed)', a3.matched === 1 && a3.unrecorded.length === 0,
      JSON.stringify(a3));
    reset();
  }
  const c5 = fold({ status: 'warning', message: 'wallet short' });
  ok('HC5. critical outranks an already-degraded card', c5.status === 'critical', JSON.stringify(c5));

  const src = fs.readFileSync(path.join(APP, 'index.js'), 'utf8');
  ok('HC6. /api/admin/health folds through AlertMonitor.foldPayoutAlerts (no second hand-written copy of the fold)',
    /AlertMonitor\.foldPayoutAlerts\(\s*db\s*,\s*services\.grin_wallet\s*\)/.test(src) &&
    !/WHERE type = 'payout_unmined' AND status = 'active'/.test(src));
  wipe();
}

// ═══ [review-fixes] the /review of 2026-09-26, findings #1–#6 ════════════════════════════════
// Every non-control case below failed on the code the review read, and was seen failing before
// the fix went in:
//   #1 a Held refund needs payouts UNFROZEN, two absent reads taken after the last resume, and a
//      wallet tx log that still carries the history mark taken at the row's first Held check;
//   #2 the Tor CLI send holds the wallet send lock, so a Slatepack/Goblin create can never select
//      the coins the CLI picked and has not locked yet (and is refused fast while it runs);
//   #3 grin-wallet's own STDOUT reaches the settlement (its NotEnoughFunds is outcome C again);
//   #4 the forced refund reads tx_slate_state; a Held row's own never-finalized fallback slate is
//      cancelled again; a Held row's own round-tripped (Standard2) send is re-broadcast hourly;
//   #5 the unrecorded-send audit compares the NET that left (amount − fee_charged);
//   #6 the default send timeout covers grin-wallet's own waits.
async function reviewFixesSection() {
  console.log('\n[review-fixes] /review 2026-09-26 — #1 frozen + history, #2 send lock, #3 CLI stdout, #4 tx state, #5 audit NET, #6 timeout');
  const WalletTor = require(path.join(APP, 'lib/wallet-tor.js'));
  const SENT = nowS() - 1800;
  const seedHeld = ({ slate = null, heldAgoS = 60 } = {}) => {
    const id = seedWithdrawal({ status: 'tor_held', slate, retries: 0, priorAttempt: true });
    evNote.run(id, 'tor_sending', 'tor_held', 'held: test', nowS() - heldAgoS);
    return id;
  };
  const absentReads = (id) => db.prepare(
    "SELECT COUNT(*) c FROM withdrawal_events WHERE withdrawal_id = ? AND note LIKE 'held-check: absent%'").get(id).c;
  const age = (id, secs) => db.prepare(
    "UPDATE withdrawal_events SET created_at = created_at - ? WHERE withdrawal_id = ? AND note LIKE 'held-check: %'").run(secs, id);
  const unfreeze = () => db.exec('DELETE FROM payout_control');
  const freeze = (s) => quiet(async () => s.freeze('review-fixes test', 'test'));
  const pass = async (s, opts) => (await quiet(() => s.resolveHeldTor(opts))) || [];
  const outcome = (r) => (r && r[0] ? r[0].outcome : null);
  // A tx-log entry the history mark can anchor on (a confirmed coinbase receipt, no slate id).
  const cb = (id, whenS) => ({ id, tx_type: 'ConfirmedCoinbase', confirmed: true, tx_slate_id: null,
    creation_ts: new Date(whenS * 1000).toISOString(), amount_credited: '60000000000', amount_debited: '0', fee: null });
  const st = (slate, state, extra = {}) => ({ ...tx({ slate, confirmed: false, when: SENT }), tx_slate_state: state, ...extra });

  // ── #1 — a Held refund waits for a resume ──
  {
    reset(); unfreeze(); sends = [];
    const id = seedHeld();
    const s = newScheduler([]);
    await freeze(s);
    const r1 = await pass(s); age(id, 11 * 60); const r2 = await pass(s);
    ok('F1a. FROZEN: an absent Held payout is NOT refunded (a restore / switch freezes; the refund waits for the resume)',
      heldOk(id), JSON.stringify(rowOf(id)));
    ok('F1a. …no absent read is journaled while frozen, and the pass says "frozen"',
      absentReads(id) === 0 && outcome(r1) === 'frozen' && outcome(r2) === 'frozen', JSON.stringify({ r1, r2, reads: absentReads(id) }));
    unfreeze();
  }
  {
    reset();
    const id = seedHeld();
    const s = newScheduler([tx({ slate: 'F1-CONF', confirmed: true, when: SENT })]);
    await freeze(s);
    await pass(s);
    ok('F1a. control: FROZEN still CONFIRMS a Held payout the chain shows paid', rowOf(id).status === 'confirmed', JSON.stringify(rowOf(id)));
    unfreeze();
  }
  {
    reset(); unfreeze();
    const id = seedHeld({ heldAgoS: 3600 });
    const s = newScheduler([]);
    await pass(s);                                   // absent read 1, unfrozen …
    age(id, 30 * 60);                                // … 30 min ago
    db.prepare(`INSERT INTO payout_control (id, frozen, reason, frozen_by, frozen_at, updated_at)
                VALUES (1, 0, NULL, 'test', NULL, ?)`).run(nowS() - 20 * 60);   // then freeze → RESUME, 20 min ago
    const r = await pass(s);
    ok('F1b. an absent read taken BEFORE the last resume does not count → still held, a fresh streak starts',
      heldOk(id) && outcome(r) === 'absent_first' && absentReads(id) === 2, JSON.stringify({ r, reads: absentReads(id) }));
    db.prepare(`UPDATE withdrawal_events SET created_at = created_at - 660
                 WHERE withdrawal_id = ? AND note LIKE 'held-check: absent%' AND created_at >= ?`).run(id, nowS() - 120);
    await pass(s);
    ok('F1b. control: two absent reads ≥ 10 min apart, both after the resume → refunded', refundedOk(id), JSON.stringify(rowOf(id)));
    unfreeze();
  }
  {
    reset(); unfreeze();
    const id = seedWithdrawal({ status: 'retry_scheduled', retries: 1, slate: null });
    const s = newScheduler([]);
    await freeze(s);
    await quiet(() => s.migrateLegacyTorRetries());
    ok('F1c. FROZEN at startup: a legacy retry row the log shows absent is HELD, not refunded on one read',
      heldOk(id), JSON.stringify(rowOf(id)));
    unfreeze();
  }

  // ── #1 — the wallet history mark ──
  {
    reset(); unfreeze();
    const id = seedHeld();
    const history = [cb(40, SENT - 600), cb(41, SENT + 60)];
    const s = newScheduler(history);
    await pass(s);
    const mark = db.prepare("SELECT note FROM withdrawal_events WHERE withdrawal_id = ? AND note LIKE 'held-check: wallet mark%'").get(id);
    ok('F1d. the first Held check records a wallet history mark (the newest tx-log entry)', !!mark && /"id":41\b/.test(mark.note), mark && mark.note);
    // The wallet is replaced — a seed recovery, a switch, an older restore: entry 41 is gone.
    history.length = 0; history.push(cb(1, nowS() - 30), cb(2, nowS() - 20));
    age(id, 11 * 60);
    const r = await pass(s);
    ok('F1d. the log no longer carries that mark → its "absent" is not proof → still held, reported "history_changed"',
      heldOk(id) && outcome(r) === 'history_changed', JSON.stringify({ r, row: rowOf(id) }));
    age(id, 3600); await pass(s);
    ok('F1d. …and it never refunds on that log, however long it waits', heldOk(id));
  }
  {
    reset(); unfreeze();
    const id = seedHeld();
    const s = newScheduler([cb(40, SENT - 600), cb(41, SENT + 60)]);
    await pass(s); age(id, 11 * 60); await pass(s);
    ok('F1d. control: the mark still in the log → two absent reads ≥ 10 min apart refund as before', refundedOk(id), JSON.stringify(rowOf(id)));
  }
  {
    // A rebuilt log can reuse an id; it cannot reuse the creation time.
    reset(); unfreeze();
    const id = seedHeld();
    const history = [cb(41, SENT + 60)];
    const s = newScheduler(history);
    await pass(s);
    history[0] = cb(41, nowS() - 5);
    age(id, 11 * 60);
    const r = await pass(s);
    ok('F1d. same entry id, different creation time (a rebuilt log) → history_changed, still held',
      heldOk(id) && outcome(r) === 'history_changed', JSON.stringify(r));
  }
  {
    reset(); unfreeze();
    const id = seedHeld();
    const s = newScheduler([cb(41, SENT + 60)]);
    await freeze(s);
    await pass(s);
    const mark = db.prepare("SELECT 1 FROM withdrawal_events WHERE withdrawal_id = ? AND note LIKE 'held-check: wallet mark%'").get(id);
    ok('F1d. FROZEN: no history mark is taken from a wallet that may be mid-switch', !mark);
    unfreeze();
  }
  {
    reset(); unfreeze();
    const id = seedHeld();
    const history = [cb(41, SENT + 60)];
    const s = newScheduler(history);
    await pass(s);
    history.length = 0; history.push(cb(1, nowS() - 30));
    let r = null; const e = await thrown(async () => { r = await quiet(() => s.forceRefundHeld(id, { adminId: 7 })); });
    ok('F1e. the forced refund stays the operator\'s override on a changed history, and says so (wallet_history "changed")',
      !e && refundedOk(id) && r && r.wallet_history === 'changed', JSON.stringify({ e: e && e.message, r }));
  }

  // ── #2 — the Tor CLI send holds the wallet send lock ──
  {
    const WalletAPI = require(path.join(APP, 'lib/wallet.js'));
    const ADDR2 = 'tgrin1' + 'z'.repeat(58);
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const mkWallet = (order) => {
      const w = new WalletAPI({ network: 'testnet', wallet_dir: '/nonexistent' });
      w.sessionOpen = true; w.aesKey = Buffer.alloc(32); w.token = 'TOKEN';
      let n = 0;
      w._encryptedCall = async (method, params) => {
        if (method === 'init_send_tx' || method === 'tx_lock_outputs') { order.push(method); await sleep(40); }
        switch (method) {
          case 'init_send_tx':
            return { ver: '4:3', id: `0000${String(++n).padStart(4, '0')}-0000-4000-8000-00000000f2f2`, sta: 'S1',
                     amt: String(params.args.amount), fee: '23500000' };
          case 'create_slatepack_message': return 'BEGINSLATEPACK. x. ENDSLATEPACK.';
          case 'retrieve_txs': return [true, []];
          default: return null;
        }
      };
      return w;
    };
    const mkSched = (order, cliDone) => {
      const s = new WithdrawalScheduler(config, mkWallet(order));
      s.incentives = { maybePayJoinBonus() {} };
      s.recordTorFee = async () => {};
      s._captureTorSlateId = async () => {};
      s.walletTor = { async sendToTorAddress() { order.push('cli start'); await cliDone; order.push('cli exit'); return { success: true }; } };
      return s;
    };
    const fund2 = () => db.prepare(`INSERT INTO miner_accounts (grin_address, balance, balance_locked) VALUES (?, 100, 0)
      ON CONFLICT(grin_address) DO UPDATE SET balance = 100, balance_locked = 0`).run(ADDR2);
    const wipe2 = () => {
      db.prepare('DELETE FROM withdrawal_events WHERE withdrawal_id IN (SELECT id FROM withdrawals WHERE grin_address = ?)').run(ADDR2);
      db.prepare('DELETE FROM balance_log WHERE grin_address = ?').run(ADDR2);
      db.prepare('DELETE FROM withdrawals WHERE grin_address = ?').run(ADDR2);
    };
    {
      reset(); unfreeze(); wipe2(); fund2();
      const order = []; let open; const cliDone = new Promise((r) => { open = r; });
      const s = mkSched(order, cliDone);
      const id = seedWithdrawal({ status: 'tor_checking', retries: 0, priorAttempt: false });
      let e = null, after = null, a2 = null, rows2 = -1, rev2 = -1, atRefusal = [];
      await quiet(async () => {
        const tor = s.sendWithdrawal(id);
        for (let i = 0; i < 200 && !order.includes('cli start'); i++) await sleep(5);
        e = await thrown(() => s.createSlatepackWithdrawal(ADDR2, 30));
        await sleep(100);   // an unrefused create would have reached init_send_tx by now
        atRefusal = order.slice();
        a2 = db.prepare('SELECT balance, balance_locked FROM miner_accounts WHERE grin_address = ?').get(ADDR2);
        rows2 = db.prepare('SELECT COUNT(*) c FROM withdrawals WHERE grin_address = ?').get(ADDR2).c;
        rev2 = db.prepare("SELECT COUNT(*) c FROM balance_log WHERE grin_address = ? AND event_type = 'reversal'").get(ADDR2).c;
        open(); await tor;
        after = await thrown(() => s.createSlatepackWithdrawal(ADDR2, 30));
      });
      ok('F2a. while the Tor CLI runs, a Slatepack create is refused at once (503) — it never selects the CLI\'s coins',
        !!e && e.code === 503 && atRefusal.join(',') === 'cli start',
        JSON.stringify({ e: e && `${e.code} ${e.message}`, atRefusal }));
      ok('F2a. …and nothing was deducted: no row, balance untouched, no reversal (so no cooldown either)',
        rows2 === 0 && !!a2 && Math.abs(a2.balance - 100) < 1e-9 && a2.balance_locked === 0 && rev2 === 0,
        JSON.stringify({ a2, rows2, rev2 }));
      ok('F2a. control: once the Tor send has returned, the same create goes through', !after && rowOf(id).status === 'confirmed',
        JSON.stringify({ e: after && after.message, row: rowOf(id).status }));
    }
    {
      reset(); unfreeze(); wipe2(); fund2();
      const order = [];
      const s = mkSched(order, Promise.resolve());
      const id = seedWithdrawal({ status: 'tor_checking', retries: 0, priorAttempt: false });
      await quiet(async () => {
        const sp = s.createSlatepackWithdrawal(ADDR2, 30).catch(() => {});
        // "Already selecting coins" = past the pre-lock wallet read (2026-10-05), which yields once.
        await new Promise((r) => setImmediate(r));
        await s.sendWithdrawal(id);
        await sp;
      });
      ok('F2b. a Slatepack create already selecting coins finishes its lock BEFORE the Tor CLI starts',
        order.join(',').startsWith('init_send_tx,tx_lock_outputs,cli start'), order.join(','));
    }
    {
      reset(); unfreeze(); wipe2(); fund2();
      const order = [];
      const s = mkSched(order, Promise.resolve());
      const id = seedWithdrawal({ status: 'tor_checking', retries: 0, priorAttempt: false });
      await quiet(async () => {
        const sp = s.createSlatepackWithdrawal(ADDR2, 30).catch(() => {});
        const tor = s.sendWithdrawal(id);
        s.freeze('lands while the Tor send waits for the lock', 'test');
        await Promise.all([sp, tor]);
      });
      const claim = db.prepare("SELECT 1 FROM withdrawal_events WHERE withdrawal_id = ? AND to_status = 'tor_sending'").get(id);
      ok('F2c. a freeze landing while the Tor send waits for the lock → no send, no claim, still tor_checking',
        !order.includes('cli start') && rowOf(id).status === 'tor_checking' && !claim, JSON.stringify({ order, st: rowOf(id).status }));
      unfreeze();
    }
    wipe2(); db.prepare('DELETE FROM miner_accounts WHERE grin_address = ?').run(ADDR2);
  }

  // ── #3 — grin-wallet's STDOUT reaches the settlement (real execWalletCommand, a node child) ──
  {
    reset(); unfreeze(); db.exec("DELETE FROM alerts WHERE type = 'pool_wallet_short'");
    const id = seedWithdrawal({ status: 'tor_checking', retries: 0, priorAttempt: false });
    const s = newScheduler([]);
    const wt = new WalletTor({ network: 'testnet', wallet_dir: os.tmpdir() });
    wt.walletBin = process.execPath;
    const script = "console.log('Wallet command failed: Not enough funds. Required: 99.96, Available: 12.5'); process.exit(1)";
    wt.execWalletCommand = () => WalletTor.prototype.execWalletCommand.call(wt, ['-e', script]);
    wt.isPayoutAddress = () => true;   // this file's fixture ADDR is 60 chars; the format is not under test here
    wt.probeToronlineStatus = async () => { throw new Error('outcome C must not probe'); };
    s.walletTor = wt;
    await quiet(() => s.sendWithdrawal(id));
    ok('F3. grin-wallet\'s NotEnoughFunds (STDOUT, exit 1) reaches outcome C → refunded now, fail_code pool_busy',
      refundedOk(id) && rowOf(id).fail_code === 'pool_busy', JSON.stringify(rowOf(id)));
    const a = alertOf('pool_wallet_short');
    ok('F3. …the pool_wallet_short alert fires with the wallet\'s figures, and fail_detail keeps the CLI\'s own line',
      !!a && /Available: 12\.5/.test(a.message) && /Not enough funds/.test(String(rowOf(id).fail_detail)),
      JSON.stringify({ a: a && a.message, d: rowOf(id).fail_detail }));
  }

  // ── #4 — the forced refund reads tx_slate_state ──
  {
    reset(); unfreeze();
    const id = seedHeld();
    const e = await thrown(() => quiet(() => newScheduler([st('F4-S2', 'Standard2', { id: 60 })]).forceRefundHeld(id, { adminId: 7 })));
    ok('F4a. forced refund REFUSED (409) when the matching unconfirmed send completed its Tor round trip (Standard2: it may be posted)',
      !!e && e.code === 409 && heldOk(id), e && e.message);
    reset();
    const id2 = seedHeld();
    const e2 = await thrown(() => quiet(() => newScheduler([tx({ slate: 'F4-NOSTATE', when: SENT })]).forceRefundHeld(id2, { adminId: 7 })));
    ok('F4a. …and when the wallet does not say (no tx_slate_state): refused too — never guessed', !!e2 && e2.code === 409 && heldOk(id2),
      e2 && e2.message);
  }
  {
    reset(); unfreeze();
    const FB1 = 'f4f4f4f4-0000-4000-8000-000000000001';
    const id = seedHeld({ slate: FB1 });
    const log = [st(FB1, 'Standard1', { id: 61 })];
    const cancels = [];
    const s = newScheduler(log);
    s.wallet.cancelTx = async (sid) => { cancels.push(sid); log[0].tx_type = 'TxSentCancelled'; };
    let r = null; const e = await thrown(async () => { r = await quiet(() => s.forceRefundHeld(id, { adminId: 7 })); });
    ok('F4b. forced refund on the row\'s OWN never-finalized fallback slate (Standard1) → that slate cancelled first, then refunded',
      !e && refundedOk(id) && cancels.join() === FB1 && !!r && r.cancelled_slate === FB1, JSON.stringify({ e: e && e.message, r, cancels }));
  }
  {
    reset(); unfreeze();
    const FB2 = 'f4f4f4f4-0000-4000-8000-000000000002';
    const id = seedHeld({ slate: FB2 });
    const s = newScheduler([st(FB2, 'Standard1', { id: 62 })]);
    s.wallet.cancelTx = async () => { throw new Error("Can't contact running Grin node. Not Cancelling."); };
    const e = await thrown(() => quiet(() => s.forceRefundHeld(id, { adminId: 7 })));
    ok('F4c. …that cancel fails (no node) → refused (503), still held', !!e && e.code === 503 && heldOk(id), e && e.message);
  }
  {
    reset(); unfreeze();
    const id = seedHeld();
    const cancels = [];
    const s = newScheduler([st('F4-AMT', 'Standard1', { id: 63 })]);
    s.wallet.cancelTx = async (sid) => { cancels.push(sid); };
    const e = await thrown(() => quiet(() => s.forceRefundHeld(id, { adminId: 7 })));
    ok('F4d. control: a Standard1 match found by AMOUNT → refunded, and nothing cancelled (never cancel on an amount match)',
      !e && refundedOk(id) && cancels.length === 0, JSON.stringify({ e: e && e.message, cancels }));
  }
  // ── #4 — the Held check cancels a fallback lock again, and re-broadcasts a round-tripped send ──
  {
    reset(); unfreeze();
    const FB3 = 'f4f4f4f4-0000-4000-8000-000000000003';
    const id = seedHeld({ slate: FB3 });
    const log = [st(FB3, 'Standard1', { id: 64 })];
    const cancels = [];
    const s = newScheduler(log);
    s.wallet.cancelTx = async (sid) => { cancels.push(sid); log[0].tx_type = 'TxSentCancelled'; };
    const r1 = await pass(s);
    ok('F4e. Held with its OWN fallback slate still locked (Standard1) → the Held check cancels it (the cancel that failed at send time)',
      cancels.join() === FB3 && outcome(r1) === 'fallback_cancelled' && heldOk(id), JSON.stringify({ r1, cancels }));
    await pass(s); age(id, 11 * 60); await pass(s);
    ok('F4e. …then two absent reads ≥ 10 min apart refund it, and it is cancelled only once', refundedOk(id) && cancels.length === 1,
      JSON.stringify({ row: rowOf(id), cancels }));
  }
  {
    reset(); unfreeze();
    const cancels = [];
    const FB4 = 'f4f4f4f4-0000-4000-8000-000000000004';
    seedHeld({ slate: FB4 });
    const s = newScheduler([st(FB4, 'Standard2', { id: 65 })]);
    s.wallet.cancelTx = async (sid) => { cancels.push(sid); };
    s.walletTor.repostTx = async () => ({ ok: true, output: '' });
    await pass(s);
    reset();
    seedHeld();
    const s2 = newScheduler([st('F4-AMT1', 'Standard1', { id: 66 })]);
    s2.wallet.cancelTx = async (sid) => { cancels.push(sid); };
    await pass(s2);
    ok('F4f. control: the Held check never cancels a Standard2 send, nor any match found by amount', cancels.length === 0,
      JSON.stringify(cancels));
  }
  {
    reset(); unfreeze();
    const reposts = [];
    const id = seedHeld();
    const s = newScheduler([st('F4-RP', 'Standard2', { id: 70 })]);
    s.walletTor.repostTx = async (txId) => { reposts.push(txId); return { ok: true, output: 'Reposted' }; };
    const r1 = await pass(s);
    const ev = db.prepare("SELECT from_status, to_status FROM withdrawal_events WHERE withdrawal_id = ? AND note LIKE 'repost:%'").all(id);
    ok('F4g. Held + its own unconfirmed Standard2 send → re-broadcast by tx-log id (the identical tx), journaled held → held',
      reposts.join() === '70' && ev.length === 1 && ev[0].from_status === 'tor_held' && ev[0].to_status === 'tor_held' &&
      outcome(r1) === 'reposted', JSON.stringify({ reposts, ev, r1 }));
    await pass(s);
    ok('F4g. …not again within the hour, and the row stays held with its amount locked', reposts.length === 1 && heldOk(id),
      JSON.stringify(reposts));
    reset();
    const id2 = seedHeld();
    const s2 = newScheduler([st('F4-RP2', 'Standard2', { id: 71 })]);
    s2.walletTor.repostTx = async (txId) => { reposts.push(txId); return { ok: true, output: '' }; };
    await freeze(s2);
    await pass(s2);
    ok('F4g. …FROZEN: no repost', reposts.length === 1 && heldOk(id2), JSON.stringify(reposts));
    unfreeze();
    reset();
    const id3 = seedHeld();
    const s3 = newScheduler([st('F4-RP3', 'Standard1', { id: 72 })]);
    s3.walletTor.repostTx = async (txId) => { reposts.push(txId); return { ok: true, output: '' }; };
    await pass(s3);
    ok('F4g. control: a Standard1 lock (never finalized) is never reposted', reposts.length === 1 && heldOk(id3), JSON.stringify(reposts));
  }
  {
    // The guards on both remedies. A LEGACY row with two attempts may own two different finalized
    // txs; landing one of them could complete a double pay, so it is never re-broadcast. And a
    // slate another row also carries is never cancelled from this one.
    reset(); unfreeze();
    const reposts = [];
    const id = seedHeld();
    evNote.run(id, 'tor_checking', 'tor_sending', null, nowS() - 1200);   // a second attempt on record
    evNote.run(id, 'tor_sending', 'tor_held', 'held: second attempt', nowS() - 1100);
    const s = newScheduler([st('F4-TWO', 'Standard2', { id: 80, creation_ts: new Date((nowS() - 1150) * 1000).toISOString() })]);
    s.walletTor.repostTx = async (txId) => { reposts.push(txId); return { ok: true, output: '' }; };
    await pass(s);
    ok('F4h. a Held row with TWO attempts on record is never re-broadcast (two finalized txs could exist)',
      reposts.length === 0 && heldOk(id), JSON.stringify(reposts));
    reset(); unfreeze();
    const cancels = [];
    const FB5 = 'f4f4f4f4-0000-4000-8000-000000000005';
    const idA = seedHeld({ slate: FB5 });
    db.prepare(`INSERT INTO withdrawals (grin_address, amount, fee_charged, status, method, slate_id, created_at)
                VALUES (?, 30, 0.04, 'slatepack_pending', 'slatepack', ?, ?)`).run(ADDR, FB5, nowS() - 100);
    const s2 = newScheduler([st(FB5, 'Standard1', { id: 81 })]);
    s2.wallet.cancelTx = async (sid) => { cancels.push(sid); };
    await pass(s2);
    ok('F4h. a slate ANOTHER row also carries is never cancelled from a Held row', cancels.length === 0 && heldOk(idA),
      JSON.stringify(cancels));
  }

  // ── #5 — the unrecorded-send audit compares the NET that left ──
  {
    const { auditWalletSends } = require(path.join(APP, 'lib/reconciliation.js'));
    const send = (net) => ({ id: 1, tx_type: 'TxSent', confirmed: true, tx_slate_id: `OTHER-${net}`,
      creation_ts: new Date().toISOString(), amount_debited: String(Math.round((net + 10) * 1e9)), amount_credited: String(10e9), fee: '0' });
    const row = (amount, feeCharged, status = 'confirmed', method = 'tor') => {
      reset();
      db.prepare(`INSERT INTO withdrawals (grin_address, amount, fee_charged, status, method, created_at, confirmed_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?)`).run(ADDR, amount, feeCharged, status, method, nowS() - 600, nowS() - 590);
    };
    const audit = (net) => auditWalletSends(db, { async getTransactions() { return [send(net)]; } }, {});
    row(50, 0.1);
    const a1 = await audit(49.9);
    ok('F5. withdrawal_fee 0.1: the NET that left (amount − fee_charged) is matched — no false "out-of-band send" freeze',
      a1.matched === 1 && a1.unrecorded.length === 0, JSON.stringify(a1));
    row(25, 0.04, 'cancelled');
    const a2 = await audit(24.98);
    ok('F5. a send 0.02 GRIN off every row\'s net is UNRECORDED (a near-amount row can no longer absorb it)',
      a2.matched === 0 && a2.unrecorded.length === 1, JSON.stringify(a2));
    row(12.5, 0, 'confirmed', 'manual');
    const a3 = await audit(12.49);
    ok('F5. control: a hand-recorded MANUAL payout keeps the human tolerance (0.05 GRIN)', a3.matched === 1, JSON.stringify(a3));
    reset();
  }

  // ── #6 — the send timeout default ──
  {
    const s = new WithdrawalScheduler({ network: 'testnet' }, null);
    ok('F6. with no wallet_send_timeout_ms set, the stale-send sweep waits past the new default (twice it + slack)',
      !!WalletTor.DEFAULT_SEND_TIMEOUT_MS && s.torSendingStaleSeconds >= Math.ceil(WalletTor.DEFAULT_SEND_TIMEOUT_MS / 1000) * 2 + 120 &&
      s.torSendingStaleSeconds >= 2 * 360 + 120, String(s.torSendingStaleSeconds));
  }
  reset(); unfreeze();
}

// ═══ [binding] a reply finalizes only the slate its OWN row was issued (2026-09-27) ═══
// Both finalize paths compared the reply's slate id with the row's only `if (w.slate_id && …)`.
// A new row sits in slatepack_pending with NO slate id while its create is inside the wallet
// calls, and a reply that decodes to no id skipped the compare as well. Either way the reply went
// to finalize_tx whichever slate it belonged to, and grin-wallet finalizes any slate whose context
// it still holds while its entry is TxSent. An expired row is refunded BEFORE its wallet cancel;
// with that cancel still owed (node down), its old reply pasted into a new, smaller payout's window
// posts the OLD amount while the ledger records the new one. Both paths now fail closed. The
// B-cases failed on the code before the fix; the C-cases are controls and passed on it too.
async function bindingSection() {
  console.log('\n[binding] a reply only finalizes the slate its own row was issued');
  const NPUB = 'cd'.repeat(32);
  const OLD = 'b0b0b0b0-0000-4000-8000-00000000000a';
  const reply = (slateId) => `BEGINSLATEPACK. reply:${slateId} . ENDSLATEPACK.`;
  // The wallet as the attack needs it: it finalizes ANY slate it is handed (the real one does, for
  // a TxSent entry whose context it still holds). `calls` records what reached it.
  const bindWallet = (hooks = {}) => {
    const w = {
      calls: [], n: 0,
      async initSendTx(a) { if (hooks.init) await hooks.init(); w.n++; return { id: `bind-${seq}-${w.n}`, amt: a, fee: '23500000' }; },
      async txLockOutputs() {},
      async createSlatepackMessage(slate) { return `BEGINSLATEPACK. S1 for ${slate.id} . ENDSLATEPACK.`; },
      async cancelTx(id) { w.calls.push(`cancel:${id}`); },
      async getTransactions() { return []; },
      async slateFromSlatepackMessage(msg) {
        const m = /reply:(\S*)/.exec(String(msg));
        return m && m[1] ? { id: m[1] } : { amount: '24960000000' };   // no id at all
      },
      async finalizeTx(slate) { w.calls.push(`finalize:${slate && slate.id}`); return slate; },
      async postTx(slate) { w.calls.push(`post:${slate && slate.id}`); },
    };
    return w;
  };
  const isSettle = (c) => /^(finalize|post):/.test(c);
  const sched = (wallet) => {
    const s = new WithdrawalScheduler(config, wallet);
    s.incentives = { maybePayJoinBonus() {} };
    return s;
  };
  const pendingId = () => (db.prepare(
    "SELECT id FROM withdrawals WHERE grin_address = ? AND status = 'slatepack_pending' ORDER BY id DESC LIMIT 1").get(ADDR) || {}).id;
  const setNpub = (npub) => db.prepare('UPDATE miner_accounts SET nostr_npub = ? WHERE grin_address = ?').run(npub, ADDR);
  // The refunded row whose wallet cancel is still owed (node down at expiry): its slate is still a
  // live TxSent in the pool wallet, and its miner kept the reply.
  const seedOwedOld = () => Number(db.prepare(
    `INSERT INTO withdrawals (grin_address, amount, fee, fee_charged, status, method, slate_id, slate_cancel_pending, created_at)
     VALUES (?, 1000, 0, 0.04, 'slatepack_expired', 'slatepack', ?, 1, ?)`).run(ADDR, OLD, nowS() - 7200).lastInsertRowid);
  const seedRow = ({ slate, method = 'slatepack', amount = 25 }) => {
    db.prepare('UPDATE miner_accounts SET balance_locked = balance_locked + ? WHERE grin_address = ?').run(amount, ADDR);
    return Number(db.prepare(
      `INSERT INTO withdrawals (grin_address, amount, fee, fee_charged, status, method, slate_id, created_at)
       VALUES (?, ?, 0, 0.04, 'slatepack_pending', ?, ?, ?)`).run(ADDR, amount, method, slate, nowS() - 60).lastInsertRowid);
  };

  // ── B1 manual rail: the old reply pasted into a NEW payout while its create is in the wallet ──
  {
    reset(); fund(1000); seq++;
    const oldId = seedOwedOld();
    let s = null;
    let inWindow = null;
    const w = bindWallet({
      async init() {
        // Inside the create's first wallet call: the row is committed, its slate_id still NULL.
        const id = pendingId();
        inWindow = { id, slate: id ? rowOf(id).slate_id : undefined };
        inWindow.err = await thrown(() => s.finalizeSlatepackWithdrawal(ADDR, id, reply(OLD)));
      },
    });
    s = sched(w);
    let created = null;
    const cErr = await thrown(() => quiet(async () => { created = await s.createSlatepackWithdrawal(ADDR, 25); }));
    const row = inWindow && inWindow.id ? rowOf(inWindow.id) : {};
    ok('B1. setup: the reply arrived while the new row was pending with NO slate id (the create\'s wallet window)',
      !!inWindow && !!inWindow.id && inWindow.slate === null, JSON.stringify(inWindow));
    ok('B1. manual rail: that reply is REFUSED (409), and finalize_tx / post_tx never run',
      !!inWindow && !!inWindow.err && inWindow.err.code === 409 && !w.calls.some(isSettle),
      JSON.stringify({ err: inWindow && inWindow.err && inWindow.err.message, calls: w.calls }));
    ok('B1. …the create is untouched: it attaches ITS OWN slate and hands that S1 out',
      !cErr && !!created && created.success === true && row.status === 'slatepack_pending' &&
      row.slate_id === `bind-${seq}-1` && created.slatepack === `BEGINSLATEPACK. S1 for bind-${seq}-1 . ENDSLATEPACK.`,
      JSON.stringify({ cErr: cErr && cErr.message, created, row }));
    ok('B1. …ledger: 25 locked for the new payout, 975 spendable, the old row still refunded and unsettled',
      Math.abs(acct().balance - 975) < 1e-9 && Math.abs(acct().balance_locked - 25) < 1e-9 &&
      rowOf(oldId).status === 'slatepack_expired', JSON.stringify({ a: acct(), old: rowOf(oldId).status }));
  }

  // ── B2 manual rail: a reply that decodes to no slate id ──
  {
    reset(); fund(0); seq++;
    const id = seedRow({ slate: 'b2-issued' });
    const w = bindWallet();
    const e = await thrown(() => quiet(() => sched(w).finalizeSlatepackWithdrawal(ADDR, id, reply(''))));
    ok('B2. manual rail: a reply that decodes to NO slate id is refused (400), never finalized',
      !!e && e.code === 400 && !w.calls.some(isSettle), JSON.stringify({ e: e && e.message, calls: w.calls }));
    ok('B2. …and the row is handed back to pending, so the right reply can still be pasted',
      rowOf(id).status === 'slatepack_pending', JSON.stringify(rowOf(id)));
  }

  // ── C1 controls, manual rail: another slate's reply is refused; the row's own reply settles ──
  {
    reset(); fund(0); seq++;
    const id = seedRow({ slate: 'c1-issued' });
    const w = bindWallet();
    const s = sched(w);
    const e = await thrown(() => quiet(() => s.finalizeSlatepackWithdrawal(ADDR, id, reply('c1-other'))));
    ok('C1. control: a reply to a DIFFERENT slate is refused (400) and the row goes back to pending',
      !!e && e.code === 400 && !w.calls.some(isSettle) && rowOf(id).status === 'slatepack_pending',
      JSON.stringify({ e: e && e.message, calls: w.calls }));
    const r = await quiet(() => s.finalizeSlatepackWithdrawal(ADDR, id, reply('c1-issued')));
    ok('C1. control: the reply to the row\'s OWN slate is finalized, posted and confirmed',
      !!r && r.status === 'confirmed' && rowOf(id).status === 'confirmed' &&
      w.calls.join(',') === 'finalize:c1-issued,post:c1-issued', JSON.stringify(w.calls));
  }

  // ── B3 Goblin rail: a DM reply arriving while the new row has no slate id ──
  // The bridge routes a DM to the sender npub's OLDEST pending Goblin row, not by slate id, so a
  // reply sent during the create lands on the new row exactly as a pasted one does.
  {
    reset(); fund(1000); seq++; setNpub(NPUB);
    seedOwedOld();
    let s = null;
    let inWindow = null;
    const w = bindWallet({
      async init() {
        const id = pendingId();
        inWindow = { id, slate: id ? rowOf(id).slate_id : undefined };
        await s.finalizeNostrWithdrawal(id, ADDR, reply(OLD), NPUB);
        inWindow.status = id ? rowOf(id).status : undefined;
      },
    });
    s = sched(w);
    const published = [];
    s.nostrBridge = { isEnabled: () => true, async publishSlatepack(pub, armored) { published.push(armored); } };
    const cErr = await thrown(() => quiet(() => s.createNostrWithdrawal(ADDR, 25, NPUB, 'test')));
    const row = inWindow && inWindow.id ? rowOf(inWindow.id) : {};
    ok('B3. Goblin rail: that reply is ignored: the row is never claimed, and finalize_tx / post_tx never run',
      !!inWindow && inWindow.slate === null && inWindow.status === 'slatepack_pending' && !w.calls.some(isSettle),
      JSON.stringify({ inWindow, calls: w.calls }));
    ok('B3. …the create attaches its own slate and publishes its S1',
      !cErr && row.status === 'slatepack_pending' && row.slate_id === `bind-${seq}-1` && published.length === 1,
      JSON.stringify({ cErr: cErr && cErr.message, row, published }));
  }

  // ── B4 Goblin rail: a reply that decodes to no slate id ──
  {
    reset(); fund(0); seq++; setNpub(NPUB);
    const id = seedRow({ slate: 'b4-issued', method: 'nostr' });
    const w = bindWallet();
    await quiet(() => sched(w).finalizeNostrWithdrawal(id, ADDR, reply(''), NPUB));
    ok('B4. Goblin rail: a reply that decodes to NO slate id is refused, never finalized, the row back to pending',
      !w.calls.some(isSettle) && rowOf(id).status === 'slatepack_pending', JSON.stringify({ calls: w.calls, row: rowOf(id) }));
  }

  // ── C2 control, Goblin rail: the row's own reply settles ──
  {
    reset(); fund(0); seq++; setNpub(NPUB);
    const id = seedRow({ slate: 'c2-issued', method: 'nostr' });
    const w = bindWallet();
    await quiet(() => sched(w).finalizeNostrWithdrawal(id, ADDR, reply('c2-issued'), NPUB));
    ok('C2. control: the Goblin reply to the row\'s OWN slate is finalized, posted and confirmed',
      rowOf(id).status === 'confirmed' && w.calls.join(',') === 'finalize:c2-issued,post:c2-issued',
      JSON.stringify({ calls: w.calls, row: rowOf(id) }));
  }
  setNpub(null);
  reset();
}

// ═══ [expiry-gate] the slatepack expiry sweep asks the wallet before it refunds (2026-09-27) ═══
// `grin-wallet receive` sends its reply straight back to the address inside the S1 over Tor, and
// the pool wallet's Foreign finalize_tx then finalizes AND posts it, never telling this backend
// (grin-wallet v5.5.0: controller/src/command.rs receive → try_slatepack_sync_workflow →
// foreign_rpc.rs finalize_tx, post_automatically = true). The old sweep refunded that row at TTL:
// paid on chain AND refunded. Each G case below states the rule for one row of the gate's table;
// G2, G4, G6 and G7 fail on the code before the gate (it refunded all four).
async function expiryGateSection() {
  console.log('\n[expiry-gate] refund only a slate the wallet shows as never finalized');
  const now = () => Math.floor(Date.now() / 1000);
  // The pool wallet as the expiry sweep sees it. `log` is the tx log retrieve_txs returns.
  const gateWallet = ({ log = [], readable = true } = {}) => {
    const w = {
      log, cancels: [], reads: 0,
      async getTransactions() { w.reads++; if (!readable) throw new Error('owner API down'); return w.log.map((t) => ({ ...t })); },
      async cancelTx(id) {
        w.cancels.push(id);
        const e = w.log.find((t) => t.tx_slate_id === id);
        if (e) e.tx_type = 'TxSentCancelled';
      },
    };
    return w;
  };
  const tx = (id, state, confirmed = false, type = 'TxSent') =>
    ({ tx_slate_id: id, tx_type: type, tx_slate_state: state, confirmed });
  const sched = (wallet) => { const s = new WithdrawalScheduler(config, wallet); s.incentives = { maybePayJoinBonus() {} }; return s; };
  const seedExpired = (slate, { ageMin = 31, amount = 25 } = {}) => {
    db.prepare('UPDATE miner_accounts SET balance_locked = balance_locked + ? WHERE grin_address = ?').run(amount, ADDR);
    return Number(db.prepare(
      `INSERT INTO withdrawals (grin_address, amount, fee, fee_charged, status, method, slate_id, created_at)
       VALUES (?, ?, 0, 0.04, 'slatepack_pending', 'slatepack', ?, ?)`
    ).run(ADDR, amount, slate, now() - ageMin * 60).lastInsertRowid);
  };
  const GATE_ALERTS = "('slate_finalized_elsewhere','slate_expiry_unverified','slate_cancel_owed','slate_refunded_but_mined')";
  const wipe = () => {
    reset(); db.exec(`DELETE FROM alerts WHERE type IN ${GATE_ALERTS}`); db.exec('DELETE FROM payout_control');
    db.prepare('UPDATE miner_accounts SET balance = 0, balance_locked = 0 WHERE grin_address = ?').run(ADDR);
  };
  const freeze = () => db.prepare(`INSERT INTO payout_control (id, frozen, reason, frozen_by, frozen_at, updated_at)
    VALUES (1, 1, 'test', 'test', ?, ?)`).run(nowS(), nowS());
  const refunded = (id) => rowOf(id).status === 'slatepack_expired' && !!reversalOf(id);
  const untouched = (id) => rowOf(id).status === 'slatepack_pending' && !reversalOf(id);
  const holdEvents = (id) => db.prepare(
    "SELECT COUNT(*) AS c FROM withdrawal_events WHERE withdrawal_id = ? AND note LIKE 'expiry-gate: held%'").get(id).c;
  const run = (s) => quiet(() => s.processSlatepackExpiry());

  // ── G1 the normal case: the miner never replied, the slate is only locked (Standard1) ──
  {
    wipe();
    const w = gateWallet({ log: [tx('g1', 'Standard1')] });
    const id = seedExpired('g1');
    await run(sched(w));
    ok('G1. Standard1 (only locked) → refunded and its slate cancelled, exactly as before the gate',
      refunded(id) && w.cancels.join() === 'g1' && Math.abs(acct().balance - 25) < 1e-9, JSON.stringify({ r: rowOf(id), c: w.cancels }));
    ok('G1. …and no gate alert', !alertOf('slate_finalized_elsewhere') && !alertOf('slate_expiry_unverified'));
  }

  // ── G2 a Tor reply finalized it behind the backend's back, not mined yet → HELD ──
  {
    wipe();
    const w = gateWallet({ log: [tx('g2', 'Standard3')] });
    const id = seedExpired('g2');
    const s = sched(w);
    await run(s);
    ok('G2. Standard3 (finalized outside the pool) → NOT refunded, NOT cancelled, amount still locked',
      untouched(id) && w.cancels.length === 0 && Math.abs(acct().balance_locked - 25) < 1e-9 && Math.abs(acct().balance) < 1e-9,
      JSON.stringify({ r: rowOf(id), c: w.cancels, a: acct() }));
    const al = alertOf('slate_finalized_elsewhere');
    ok('G2. …one CRITICAL alert naming the payout and what to look for',
      !!al && al.level === 'critical' && al.message.includes(`#${id}`) && /grin-wallet listen/.test(al.message), JSON.stringify(al));
    await run(s);
    ok('G2. …a second tick keeps holding and journals the hold ONCE, not once per minute',
      untouched(id) && holdEvents(id) === 1 && w.cancels.length === 0, String(holdEvents(id)));

    // ── G3 …the same transaction mines → settled as PAID, never refunded ──
    w.log[0].confirmed = true;
    await run(s);
    const r = rowOf(id);
    ok('G3. held slate mines → confirmed: lock released and debited, no reversal, nothing cancelled',
      r.status === 'confirmed' && !reversalOf(id) && Math.abs(acct().balance_locked) < 1e-9 && Math.abs(acct().balance) < 1e-9 &&
      w.cancels.length === 0, JSON.stringify({ r, a: acct() }));
    const al2 = alertOf('slate_finalized_elsewhere');
    ok('G3. …the alert drops to a WARNING that stays up (something can still finalize pool slates)',
      !!al2 && al2.level === 'warning' && al2.message.includes(`#${id}`), JSON.stringify(al2));
    await run(s);
    ok('G3. …and a quiet tick does not clear that warning', !!alertOf('slate_finalized_elsewhere'));
  }

  // ── G4 already mined at the first expiry read → settled as paid ──
  {
    wipe();
    const w = gateWallet({ log: [tx('g4', 'Standard3', true)] });
    const id = seedExpired('g4');
    await run(sched(w));
    ok('G4. confirmed at expiry → PAID (status confirmed), never refunded, never cancelled',
      rowOf(id).status === 'confirmed' && !reversalOf(id) && w.cancels.length === 0, JSON.stringify(rowOf(id)));
    ok('G4. …the settlement names the out-of-band finalize in the payout\'s timeline', !!db.prepare(
      "SELECT 1 FROM withdrawal_events WHERE withdrawal_id = ? AND to_status = 'confirmed' AND note LIKE 'settled at expiry:%'").get(id));
  }

  // ── G5 a wallet that does not record the slate state: refund + warning (operator option a) ──
  {
    wipe();
    const w = gateWallet({ log: [tx('g5a', null), tx('g5b', 'Unknown')] });
    const a = seedExpired('g5a'); const b = seedExpired('g5b', { ageMin: 32 });
    await run(sched(w));
    ok('G5. state not recorded (null / Unknown) → refunded, payouts keep flowing', refunded(a) && refunded(b));
    const al = alertOf('slate_expiry_unverified');
    ok('G5. …with ONE warning naming both, pointing at the grin-wallet version',
      !!al && al.level === 'warning' && al.message.includes(`#${a}`) && al.message.includes(`#${b}`) && /version/.test(al.message),
      JSON.stringify(al));
    ok('G5. …and the refund event says the check was skipped', /WITHOUT the finalize check/.test(
      db.prepare("SELECT note FROM withdrawal_events WHERE withdrawal_id = ? AND to_status = 'slatepack_expired'").get(a).note));
  }

  // ── G6 an unreadable tx log decides nothing — except for a row that never issued a slate ──
  {
    wipe();
    const w = gateWallet({ log: [tx('g6', 'Standard1')], readable: false });
    const id = seedExpired('g6');
    const noSlate = seedExpired(null, { ageMin: 33 });
    await run(sched(w));
    ok('G6. tx log unreadable → NOT refunded, NOT cancelled (never refund blind)', untouched(id) && w.cancels.length === 0,
      JSON.stringify({ r: rowOf(id), c: w.cancels }));
    ok('G6. …a row with no slate on record needs no wallet and is still refunded', refunded(noSlate), JSON.stringify(rowOf(noSlate)));
  }

  // ── G7 frozen: a missing slate waits, positive wallet evidence still decides ──
  {
    wipe(); freeze();
    const w = gateWallet({ log: [tx('g7-locked', 'Standard1'), tx('g7-mined', 'Standard3', true), tx('g7-cxl', 'Standard1', false, 'TxSentCancelled')] });
    const absent = seedExpired('g7-absent');
    const cxl = seedExpired('g7-cxl', { ageMin: 32 });
    const locked = seedExpired('g7-locked', { ageMin: 33 });
    const mined = seedExpired('g7-mined', { ageMin: 34 });
    await run(sched(w));
    ok('G7. frozen + slate absent / cancelled → WAIT (after a restore an absence proves nothing)', untouched(absent) && untouched(cxl),
      JSON.stringify([rowOf(absent).status, rowOf(cxl).status]));
    ok('G7. frozen + Standard1 → still refunded; frozen + confirmed → still settled as paid',
      refunded(locked) && rowOf(mined).status === 'confirmed' && !reversalOf(mined), JSON.stringify([rowOf(locked).status, rowOf(mined).status]));
    db.exec('DELETE FROM payout_control');
  }

  // ── G8 unfrozen, slate absent or cancelled → refunded (unchanged) ──
  {
    wipe();
    const w = gateWallet({ log: [tx('g8-cxl', 'Standard1', false, 'TxSentCancelled')] });
    const absent = seedExpired('g8-absent'); const cxl = seedExpired('g8-cxl', { ageMin: 32 });
    await run(sched(w));
    ok('G8. unfrozen: slate absent / cancelled → refunded as before', refunded(absent) && refunded(cxl));
  }

  // ── G9 only the pool's SEND entry counts ──
  {
    wipe();
    const w = gateWallet({ log: [tx('g9', 'Standard2', false, 'TxReceived'), tx('g9', 'Standard1')] });
    const id = seedExpired('g9');
    await run(sched(w));
    ok('G9. a TxReceived with the same slate id never stands in for the pool\'s own TxSent', refunded(id), JSON.stringify(rowOf(id)));
  }

  // ── G10 held rows never starve newer expiries (the batch used to be LIMIT 10) ──
  {
    wipe();
    const log = [];
    for (let i = 0; i < 12; i++) log.push(tx(`g10-h${i}`, 'Standard3'));
    log.push(tx('g10-new', 'Standard1'));
    const w = gateWallet({ log });
    for (let i = 0; i < 12; i++) seedExpired(`g10-h${i}`, { ageMin: 60 - i });
    const fresh = seedExpired('g10-new', { ageMin: 31 });
    await run(sched(w));
    ok('G10. twelve older held rows ahead of it: the newest expired row is still refunded this tick', refunded(fresh),
      JSON.stringify(rowOf(fresh)));
    ok('G10. …with ONE wallet read for the whole batch', w.reads === 1, String(w.reads));
  }

  // ── G11 a held row still takes the miner's own reply; the critical alert then clears ──
  {
    wipe();
    const w = gateWallet({ log: [tx('g11', 'Standard3')] });
    Object.assign(w, {
      async slateFromSlatepackMessage() { return { id: 'g11' }; },
      async finalizeTx(slate) { return slate; },
      async postTx() {},
    });
    const id = seedExpired('g11');
    const s = sched(w);
    await run(s);
    const r = await quiet(() => s.finalizeSlatepackWithdrawal(ADDR, id, 'BEGINSLATEPACK. s2 . ENDSLATEPACK.'));
    ok('G11. a held row still finalizes from the miner\'s paste (same inputs: at most one tx can mine)',
      r && r.status === 'confirmed' && rowOf(id).status === 'confirmed', JSON.stringify(rowOf(id)));
    await run(s);
    ok('G11. …and the next tick, with nothing held, resolves the CRITICAL alert', !alertOf('slate_finalized_elsewhere'));
  }

  // ── G12 the Health page's Grin Wallet card carries both gate alerts ──
  {
    const AlertMonitor = require(path.join(APP, 'lib/alert-monitor.js'));
    wipe();
    seedExpired('g12');
    await run(sched(gateWallet({ log: [tx('g12', 'Standard3')] })));
    const c = AlertMonitor.foldPayoutAlerts(db, { status: 'ok' });
    ok('G12. a held payout turns the Grin Wallet card CRITICAL', c.status === 'critical' && /HELD/.test(c.message || ''), JSON.stringify(c));
    wipe();
    seedExpired('g12b');
    await run(sched(gateWallet({ log: [tx('g12b', null)] })));
    const c2 = AlertMonitor.foldPayoutAlerts(db, { status: 'ok' });
    ok('G12. an unverified refund turns it Degraded (warning)', c2.status === 'warning' && /WITHOUT the finalize check/.test(c2.message || ''),
      JSON.stringify(c2));
  }
  wipe();
}

// ═══ [wallet-version] the grin-wallet the pool runs vs the version its guards were checked on ═══
// lib/grin-wallet-version.js TESTED_VERSION is a claim about grin-wallet BEHAVIOUR (no Tor onion
// from owner_api, the slate state in the tx log, the Foreign finalize posting) that the expiry gate
// depends on. Three copies of that version exist and must move together, deliberately: the
// constant, the admin note on the Payout settings page, and the toolkit's install pin. W5/W6 fail
// the moment one is bumped without the others — which is the point: bump them only after
// re-reading the three behaviours in the new release's source.
async function walletVersionSection() {
  console.log('\n[wallet-version] Health card version check + the tested-version pins');
  const V = require(path.join(APP, 'lib/grin-wallet-version.js'));
  const T = V.TESTED_VERSION;

  ok('W1. parses `grin-wallet 5.5.0`, keeps a pre-release suffix, null on junk',
    V.parseVersion('grin-wallet 5.5.0\n') === '5.5.0' && V.parseVersion('grin-wallet 5.6.0-beta.1') === '5.6.0-beta.1' &&
    V.parseVersion('error: no such flag') === null);

  const same = V.foldIntoCard({ status: 'ok', spendable_balance: 3 }, { version: T, error: null });
  ok('W2. the tested version → card unchanged (still OK, no message), version fields set',
    same.status === 'ok' && !same.message && same.wallet_version === T && same.wallet_version_tested === T, JSON.stringify(same));

  const other = V.foldIntoCard({ status: 'ok' }, { version: '9.9.9', error: null });
  ok('W3. another version → Degraded, naming both and where to re-check',
    other.status === 'warning' && other.message.includes('9.9.9') && other.message.includes(T) && /Pool wallet safety/.test(other.message),
    JSON.stringify(other));
  const crit = V.foldIntoCard({ status: 'critical', message: 'held' }, { version: '9.9.9', error: null });
  const down = V.foldIntoCard({ status: 'error' }, { version: '9.9.9', error: null });
  ok('W3. …and it never softens a critical or a down card', crit.status === 'critical' && crit.message.startsWith('held') && down.status === 'error');

  const unk = V.foldIntoCard({ status: 'ok' }, { version: null, error: 'no binary at /x/grin-wallet' });
  ok('W4. version unreadable → reported, status left as measured', unk.status === 'ok' && /could not be read/.test(unk.message) &&
    unk.wallet_version === null, JSON.stringify(unk));

  {
    let runs = 0;
    const run = async () => { runs++; return { version: T, error: null }; };
    await V.detect('/tmp/w-a', { force: true, run });
    await V.detect('/tmp/w-a', { run });
    const afterCached = runs;
    await V.detect('/tmp/w-b', { run });
    ok('W4b. the probe is cached per binary (one run for two reads), and another wallet dir re-probes',
      afterCached === 1 && runs === 2, String(runs));
  }

  const html = fs.readFileSync(path.join(APP, 'admin-panel/settings-payout.html'), 'utf8');
  const m = /data-tested-grin-wallet>v?([^<]+)</.exec(html);
  ok('W5. the Payout settings "Pool wallet safety" note states the tested version', !!m && m[1].trim() === T, m ? m[1] : 'not found');

  const sh = fs.readFileSync(path.join(APP, '../../../scripts/lib/grin_wallet_install.sh'), 'utf8');
  const pin = /GWI_DEFAULT_TAG="\$\{GWI_DEFAULT_TAG:-v?([^}"]+)\}"/.exec(sh);
  ok('W6. the toolkit\'s install pin (GWI_DEFAULT_TAG) is the tested version — a pin bump must re-check the guards first',
    !!pin && pin[1] === T, pin ? pin[1] : 'not found');
}

// ═══ [double-pay-card] the "paid twice?" alarm on the Health card, closed only by hand (2026-09-27) ═══
// slate_refunded_but_mined (retryExpiredSlateCancels) is raised once per payout and resolved by
// NOTHING automatic, so until now it sat in the alerts table where no admin page showed it. It now
// folds into the Grin Wallet card as CRITICAL with its id, and the operator closes it with "Mark
// reconciled" — a step-up-gated, audited route that refuses every alert type the code resolves itself.
async function doublePayCardSection() {
  console.log('\n[double-pay-card] slate_refunded_but_mined on the Health card + the manual resolve');
  const AlertMonitor = require(path.join(APP, 'lib/alert-monitor.js'));
  const s = newScheduler([]);
  const wipe = () => db.exec("DELETE FROM alerts WHERE type IN ('slate_refunded_but_mined','payout_held')");
  const idOf = (type) => db.prepare("SELECT id FROM alerts WHERE type = ? ORDER BY id DESC LIMIT 1").get(type).id;
  const statusOf = (id) => db.prepare('SELECT status FROM alerts WHERE id = ?').get(id).status;

  wipe();
  s._rollingAlert('slate_refunded_but_mined', 'critical', 'Expired slatepack payout #7 was REFUNDED … paid twice', { withdrawal_id: 7 });
  const id = idOf('slate_refunded_but_mined');
  const c1 = AlertMonitor.foldPayoutAlerts(db, { status: 'ok' });
  ok('D1. the alarm turns the Grin Wallet card CRITICAL and carries its id for "Mark reconciled"',
    c1.status === 'critical' && /paid twice/.test(c1.message) && Array.isArray(c1.manual_alerts) &&
    c1.manual_alerts.length === 1 && c1.manual_alerts[0].id === id, JSON.stringify(c1));
  const down = AlertMonitor.foldPayoutAlerts(db, { status: 'error', message: 'owner API down' });
  ok('D1. …and never masks a wallet that is down', down.status === 'error' && /owner API down/.test(down.message));

  s._rollingAlert('slate_refunded_but_mined', 'critical', 'Expired slatepack payout #9 was REFUNDED … paid twice', { withdrawal_id: 9 });
  const c2 = AlertMonitor.foldPayoutAlerts(db, { status: 'ok' });
  ok('D2. a second payout inside the rolling window says there were 2, not just the latest',
    /#9/.test(c2.message) && /2 occurrences/.test(c2.message), c2.message);

  const other = AlertMonitor.foldPayoutAlerts(db, { status: 'ok' });
  s._rollingAlert('payout_held', 'critical', 'held test', {});
  const heldId = idOf('payout_held');
  const withHeld = AlertMonitor.foldPayoutAlerts(db, { status: 'ok' });
  ok('D3. only a manual-resolve type gets a button: payout_held folds in with no manual_alerts entry',
    withHeld.manual_alerts.length === 1 && withHeld.manual_alerts[0].type === 'slate_refunded_but_mined' && !!other,
    JSON.stringify(withHeld.manual_alerts));

  const refused = AlertMonitor.resolveManual(db, heldId, 1);
  ok('D4. resolveManual refuses a type the code resolves itself (409), and the alert stays active',
    !refused.ok && refused.code === 409 && statusOf(heldId) === 'active', JSON.stringify(refused));
  ok('D4. …and an unknown id is a 404', AlertMonitor.resolveManual(db, 999999, 1).code === 404);

  const done = AlertMonitor.resolveManual(db, id, 42);
  const row = db.prepare('SELECT status, resolved_at, acknowledged_by FROM alerts WHERE id = ?').get(id);
  ok('D5. resolveManual closes the alarm and records who', done.ok && row.status === 'resolved' && !!row.resolved_at &&
    row.acknowledged_by === '42', JSON.stringify(row));
  const c3 = AlertMonitor.foldPayoutAlerts(db, { status: 'ok' });
  ok('D5. …the card no longer carries it (payout_held still does)', !c3.manual_alerts && !/paid twice/.test(c3.message) &&
    /held test/.test(c3.message), JSON.stringify(c3));
  const again = AlertMonitor.resolveManual(db, id, 42);
  ok('D5. …and a second close is a 409, not a silent success', !again.ok && again.code === 409);

  s._rollingAlert('slate_refunded_but_mined', 'critical', 'Expired slatepack payout #11 was REFUNDED', { withdrawal_id: 11 });
  ok('D6. a NEW double pay after the close raises a fresh active alarm', statusOf(idOf('slate_refunded_but_mined')) === 'active' &&
    idOf('slate_refunded_but_mined') !== id);
  wipe();

  // The route and the page, read from source (the admin-guards suite reads tiers the same way).
  const src = fs.readFileSync(path.join(APP, 'index.js'), 'utf8');
  const decl = /app\.post\('\/api\/admin\/alerts\/:alertId\/resolve',\s*([A-Za-z]+),/.exec(src);
  ok('D7. POST /api/admin/alerts/:alertId/resolve is freshAdmin (step-up: it silences a money alarm)',
    !!decl && decl[1] === 'freshAdmin', decl ? decl[1] : 'route not found');
  const a = src.indexOf("app.post('/api/admin/alerts/:alertId/resolve'");
  const body = a < 0 ? '' : src.slice(a, src.indexOf('\n  });', a));
  ok('D7. …it requires a note, goes through resolveManual, and writes an alert_resolve audit row',
    /if \(!note\)/.test(body) && /AlertMonitor\.resolveManual\(/.test(body) && /'alert_resolve'/.test(body));
  const html = fs.readFileSync(path.join(APP, 'admin-panel/health.html'), 'utf8');
  ok('D8. the Health page loads stepup.js and resolves through adminFetch (the step-up retry)',
    /<script src="\/js\/stepup\.js"><\/script>/.test(html) && /adminFetch\('\/api\/admin\/alerts\/' \+ id \+ '\/resolve'/.test(html));
  const acct = fs.readFileSync(path.join(APP, '../public_html/account-settings.html'), 'utf8');
  ok('D9. the account page tells a CLI miner to run `grin-wallet receive -m` (skips the Tor reply that cannot reach the pool)',
    /<code>grin-wallet receive -m<\/code>/.test(acct));
}

// ═══ [in-flight] payouts in flight never read as a shortfall or a drain (2026-10-05) ═══════════
// grin-wallet v5.5.0 retrieve_info (min_conf 1): a payout's inputs go to amount_locked, its change
// to amount_awaiting_finalization, and `total` counts NEITHER until the tx is mined. Coverage and
// the drain detector compared `total`, so two miners withdrawing their full balances from one big
// output read as a 1000-GRIN shortfall and AUTO-FROZE payouts. Both now compare HELD
// (total + locked). Every case below fails against the old `total` formula.
async function inFlightCoverageSection() {
  console.log('\n[in-flight] concurrent payouts are not a shortfall, and not a drain');
  const { computeReconciliation } = require(path.join(APP, 'lib/reconciliation.js'));
  const AlertMonitor = require(path.join(APP, 'lib/alert-monitor.js'));
  const X = 'tgrin1' + 'x'.repeat(58), Y = 'tgrin1' + 'y'.repeat(58);
  const wipe = () => {
    db.exec('DELETE FROM withdrawal_events; DELETE FROM withdrawals; DELETE FROM balance_log;');
    db.exec('UPDATE miner_accounts SET balance = 0, balance_locked = 0');
  };
  const setAcct = (addr, balance, locked) => db.prepare(
    `INSERT INTO miner_accounts (grin_address, balance, balance_locked) VALUES (?, ?, ?)
     ON CONFLICT(grin_address) DO UPDATE SET balance = excluded.balance, balance_locked = excluded.balance_locked`
  ).run(addr, balance, locked);
  // Wallet summary in nanoGRIN, the shape retrieve_summary_info returns.
  const n = (g) => String(Math.round(g * 1e9));
  const walletOf = (w) => ({ async getBalance() { return [true, {
    total: n(w.total), amount_currently_spendable: n(w.spendable || 0), amount_locked: n(w.locked || 0),
    amount_immature: '0', amount_awaiting_confirmation: '0', amount_awaiting_finalization: n(w.af || 0) }]; } });
  const recon = async (w) => (await computeReconciliation(db, walletOf(w), true)).checks;

  wipe();
  // One 1000-GRIN output; X is owed 600, Y 400.
  setAcct(X, 600, 0); setAcct(Y, 400, 0);
  let c = await recon({ total: 1000, spendable: 1000 });
  ok('IF1. baseline: one 1000 output covers 600 + 400 owed', c.coverage_full_ok === true, JSON.stringify(c));

  // Both withdraw everything. The wallet locks the whole output; total counts nothing.
  setAcct(X, 0, 600); setAcct(Y, 0, 400);
  const ins = db.prepare(`INSERT INTO withdrawals (grin_address, amount, fee, status, method, created_at, confirmed_at)
                          VALUES (?, ?, ?, ?, ?, ?, ?)`);
  const wx = ins.run(X, 600, 0, 'slatepack_pending', 'slatepack', nowS(), null).lastInsertRowid;
  ins.run(Y, 400, 0, 'tor_sending', 'tor', nowS(), null);
  c = await recon({ total: 0, locked: 1000, af: 0 });
  ok('IF2. two full-balance payouts in flight (total 0, locked 1000) are NOT a shortfall',
    c.coverage_full_ok === true && Math.abs(c.coverage_full_gap) < 1e-6, JSON.stringify(c));

  // X's payout is confirmed in the ledger (debited, fee recorded) but not yet mined.
  db.prepare("UPDATE withdrawals SET status = 'confirmed', confirmed_at = ?, fee = 0.02 WHERE id = ?").run(nowS(), wx);
  setAcct(X, 0, 0);
  c = await recon({ total: 0, locked: 1000, af: 399.98 });
  ok('IF3. confirmed-but-unmined over-reads (safe side), never a shortfall', c.coverage_full_ok === true && c.coverage_full_gap > 0,
    JSON.stringify(c));
  // Y refunded (pool_busy) and X mined: only X's change is left.
  db.prepare("UPDATE withdrawals SET status = 'tor_failed' WHERE grin_address = ?").run(Y);
  setAcct(Y, 400, 0);
  c = await recon({ total: 399.98, spendable: 399.98 });
  ok('IF4. after X mines, the change + recorded fee balance exactly', c.coverage_full_ok === true && Math.abs(c.coverage_full_gap) < 1e-6,
    JSON.stringify(c));
  c = await recon({ total: 200, spendable: 200 });
  ok('IF5. a REAL shortfall (nothing locked, 200 vs 400 owed) is still caught', c.coverage_full_ok === false, JSON.stringify(c));

  // ── The drain detector across the same sequence, at the 5-min money cadence ──
  wipe();
  setAcct(X, 600, 0); setAcct(Y, 400, 0);
  const freezes = [];
  let w = { total: 1000, spendable: 1000 };
  const am = new AlertMonitor({}, {
    wallet: { async getBalance() { return walletOf(w).getBalance(); } },
    withdrawalScheduler: { isFrozen: () => false, freeze: (reason) => freezes.push(reason) },
  }, db);
  am.triggerAlert = async () => {}; am.resolveAlert = async () => {};
  am.checkUnrecordedSends = async () => {};
  const drainFreezes = () => freezes.filter((r) => /drain|coverage/.test(r));
  // Integrity drift is expected here (balances are set without ledger rows) — only drain and
  // coverage freezes are under test.
  await quiet(() => am.checkMoneyIntegrity());                       // snapshot: held 1000
  setAcct(X, 0, 600);
  const wx2 = ins.run(X, 600, 0, 'tor_sending', 'tor', nowS(), null).lastInsertRowid;
  w = { total: 0, locked: 1000, af: 399.98 };
  await quiet(() => am.checkMoneyIntegrity());                       // in flight
  db.prepare("UPDATE withdrawals SET status = 'confirmed', confirmed_at = ?, fee = 0.02 WHERE id = ?").run(nowS() - 60, wx2);
  setAcct(X, 0, 0);
  // Next check is AFTER the confirm: the payout is older than the last snapshot when it mines.
  am.prevWalletCheckAt = nowS();
  w = { total: 399.98, spendable: 399.98 };
  await quiet(() => am.checkMoneyIntegrity());                       // mined
  ok('IF6. a 600-GRIN payout locked, confirmed, then mined across three checks: no drain or coverage freeze',
    drainFreezes().length === 0, JSON.stringify(freezes));
  // 299.98 vanishes. Inside the settle window the recent 600 payout masks it from the DRAIN
  // check (the documented cost) — but coverage compares against what is OWED and catches it.
  w = { total: 100, spendable: 100 };
  await quiet(() => am.checkMoneyIntegrity());
  ok('IF7. …an unexplained 300-GRIN drop right after it is caught by COVERAGE at once',
    drainFreezes().some((r) => /coverage shortfall/.test(r)), JSON.stringify(freezes));
  // Once the payout is older than the settle window it no longer explains anything.
  freezes.length = 0;
  db.prepare('UPDATE withdrawals SET confirmed_at = ? WHERE id = ?').run(nowS() - 7 * 3600, wx2);
  am.prevWalletTotal = 399.98;
  await quiet(() => am.checkMoneyIntegrity());
  ok('IF8. …and as a DRAIN once the payout is past the settle window',
    drainFreezes().some((r) => /drain/.test(r)), JSON.stringify(freezes));
  wipe();
}

// ═══ [queue] "Another payment is ahead" — refused before the lock, with an honest wait (2026-10-05) ═══
// A payout locks whole outputs; their change is not spendable until mined (1 conf) or 10 deep (Tor
// CLI). A second miner right behind the first used to get NotEnoughFunds — after their balance was
// locked, so the reversal also started the 30-min cooldown. The wallet is now read BEFORE the lock,
// and the wait is the LATEST release among the payouts ahead, never their sum.
async function paymentQueueSection() {
  console.log('\n[queue] payments ahead: wait = the slowest one, refused before any lock');
  const now = nowS();
  const ins = db.prepare(`INSERT INTO withdrawals (grin_address, amount, status, method, created_at, confirmed_at)
                          VALUES (?, ?, ?, ?, ?, ?)`);
  const OTHER = 'tgrin1' + 'q'.repeat(58);
  db.prepare(`INSERT INTO miner_accounts (grin_address, balance, balance_locked) VALUES (?, 0, 0)
    ON CONFLICT(grin_address) DO NOTHING`).run(OTHER);
  const minConfs = [];
  let spendable = 0, initErr = null, inits = 0;
  const wallet = {
    async getBalance(refresh, minConf) {
      minConfs.push(minConf);
      if (spendable === 'throw') throw new Error('owner API down');
      return [true, { amount_currently_spendable: String(Math.round(spendable * 1e9)) }];
    },
    async initSendTx() { inits++; if (initErr) throw initErr; return { id: 'slate-q' }; },
    async txLockOutputs() {},
    async createSlatepackMessage() { return 'BEGINSLATEPACK. x. ENDSLATEPACK.'; },
    async cancelTx() {},
  };
  const s = new WithdrawalScheduler({ ...config, slatepack_ttl_minutes: 30 }, wallet);
  const fresh = () => { reset(); db.prepare('UPDATE miner_accounts SET balance = 100 WHERE grin_address = ?').run(ADDR); };

  fresh();
  let q = s._paymentQueueWait();
  ok('Q1. nothing in flight → nothing ahead', q.ahead === 0 && q.waitSecs === 0, JSON.stringify(q));

  ins.run(OTHER, 50, 'tor_sending', 'tor', now, null);
  q = s._paymentQueueWait();
  ok('Q2. one Tor payout in flight → 1 ahead, up to 15 min', q.ahead === 1 && Math.abs(q.waitSecs - 900) <= 2, JSON.stringify(q));
  ok('Q2. …worded "Another payment is ahead of yours — … up to 15 minutes. Nothing was deducted"',
    /^Another payment is ahead of yours — please try again in up to 15 minutes\. Nothing was deducted/.test(s._queueMessage(q)),
    s._queueMessage(q));

  // Five mixed payouts: the wait is the slowest (a slatepack just created: its 30-min expiry), not 5×.
  ins.run(OTHER, 50, 'tor_checking', 'tor', now, null);
  ins.run(OTHER, 50, 'tor_held', 'tor', now - 600, null);
  ins.run(OTHER, 50, 'slatepack_pending', 'slatepack', now - 60, null);
  ins.run(OTHER, 50, 'slatepack_pending', 'nostr', now, null);
  q = s._paymentQueueWait();
  ok('Q3. 5 mixed Tor/Slatepack/Goblin payouts → 5 ahead, wait = the slowest (≈29 min), not the sum',
    q.ahead === 5 && q.waitSecs > 28 * 60 && q.waitSecs <= 30 * 60, JSON.stringify(q));
  ok('Q3. …"5 other payments are ahead of yours — … up to 30 minutes"',
    /^5 other payments are ahead of yours — please try again in up to 30 minutes\./.test(s._queueMessage(q)), s._queueMessage(q));

  // A Tor payout confirmed 5 min ago still holds its change (10 confirmations); one 20 min ago does not.
  fresh();
  ins.run(OTHER, 50, 'confirmed', 'tor', now - 900, now - 300);
  ins.run(OTHER, 50, 'confirmed', 'tor', now - 1500, now - 1200);
  q = s._paymentQueueWait();
  ok('Q4. a Tor payout confirmed 5 min ago counts (≈10 min left); one confirmed 20 min ago does not',
    q.ahead === 1 && q.waitSecs > 590 && q.waitSecs <= 600, JSON.stringify(q));

  // ── the pre-check ──
  fresh();
  ins.run(OTHER, 50, 'tor_sending', 'tor', now, null);
  spendable = 10; minConfs.length = 0;
  let e = await thrown(() => s.precheckWalletCover(ADDR, 60));
  ok('Q5. Tor request the wallet cannot cover while a payout is ahead → 503 "Another payment is ahead"',
    !!e && e.code === 503 && /^Another payment is ahead/.test(e.message) && e.retry_after >= 300, e && e.message);
  ok('Q5. …read at the Tor CLI\'s min_conf (10), from the CACHED summary', minConfs[0] === 10, JSON.stringify(minConfs));
  spendable = 100;
  ok('Q6. …and the same request passes once the wallet can cover it', (await thrown(() => s.precheckWalletCover(ADDR, 60))) === null);
  spendable = 'throw';
  ok('Q7. an unreadable wallet FAILS OPEN (grin-wallet stays the authority)', (await thrown(() => s.precheckWalletCover(ADDR, 60))) === null);
  db.exec('DELETE FROM withdrawal_events; DELETE FROM withdrawals;');
  spendable = 10;
  ok('Q8. short with NOTHING ahead is not a queue — left to the authoritative path (operator alert)',
    (await thrown(() => s.precheckWalletCover(ADDR, 60))) === null);

  // Slatepack: refused BEFORE the lock → no reversal → no cooldown on the retry.
  fresh();
  ins.run(OTHER, 50, 'tor_sending', 'tor', now, null);
  spendable = 10; inits = 0; minConfs.length = 0;
  e = await thrown(() => quiet(() => s.createSlatepackWithdrawal(ADDR, 60)));
  ok('Q9. slatepack request behind a payout → 503 queue message, read at min_conf 1',
    !!e && e.code === 503 && /^Another payment is ahead/.test(e.message) && minConfs[0] === 1, e && e.message);
  const logRows = db.prepare('SELECT COUNT(*) AS c FROM balance_log WHERE grin_address = ?').get(ADDR).c;
  ok('Q9. …nothing locked, no ledger row, no slate built', Math.abs(acct().balance - 100) < 1e-9 && acct().balance_locked === 0 &&
    logRows === 0 && inits === 0, JSON.stringify({ acct: acct(), logRows, inits }));
  ok('Q9. …so the retry is NOT blocked by the reversal cooldown', (await thrown(() => s._assertNoRecentReversal(ADDR))) === null);

  // The pre-check raced: wallet looked fine, init said NotEnoughFunds after the lock. The reversal
  // has started the 30-min cooldown, so the wait shown must not be shorter than it.
  spendable = 100; initErr = new Error('NotEnoughFunds { available: 1, needed: 59 }');
  e = await thrown(() => quiet(() => s.createSlatepackWithdrawal(ADDR, 60)));
  ok('Q10. post-lock NotEnoughFunds with a payout ahead → queue message, wait ≥ the 30-min cooldown',
    !!e && e.code === 503 && /ahead of yours — please try again in up to 30 minutes/.test(e.message), e && e.message);
  ok('Q10. …and the wallet\'s figures never reach the miner', !!e && !/available|needed|NotEnoughFunds/.test(e.message));
  reset(); db.prepare('UPDATE miner_accounts SET balance = 100 WHERE grin_address = ?').run(ADDR);
  e = await thrown(() => quiet(() => s.createSlatepackWithdrawal(ADDR, 60)));
  ok('Q11. post-lock NotEnoughFunds with NOTHING ahead keeps the "contact the pool operator" line',
    !!e && e.code === 503 && /contact the pool operator/.test(e.message), e && e.message);
  initErr = null;

  // ── change splitting: how many change outputs a payout asks for ──
  const mkSplit = (have, target) => {
    const sc = new WithdrawalScheduler({ ...config, payout_target_outputs: target },
      { async countSpendableOutputs() { if (have === 'throw') throw new Error('down'); return have; } });
    return sc._changeOutputCount(1);
  };
  const splits = [await mkSplit(1, undefined), await mkSplit(6, undefined), await mkSplit(7, undefined),
                  await mkSplit(8, undefined), await mkSplit(1, 0), await mkSplit('throw', undefined), await mkSplit(1, 'x')];
  ok('Q13. change outputs: 1 of 8 → 3, 6 → 2, 7 → 2, ≥8 → 1, target 0 → off (1), wallet error → 1, bad target → default 8',
    JSON.stringify(splits) === '[3,2,2,1,1,1,3]', JSON.stringify(splits));
  {
    let seen = null;
    const sc = new WithdrawalScheduler({ ...config }, Object.assign({}, wallet, {
      async countSpendableOutputs() { return 1; },
      async initSendTx(amt, opts) { seen = opts; return { id: 'slate-split' }; },
    }));
    reset(); db.prepare('UPDATE miner_accounts SET balance = 100 WHERE grin_address = ?').run(ADDR);
    spendable = 100;
    await thrown(() => quiet(() => sc.createSlatepackWithdrawal(ADDR, 60)));
    ok('Q14. a slatepack payout from a 1-output wallet asks init_send_tx for 3 change outputs',
      !!seen && seen.changeOutputs === 3, JSON.stringify(seen));
  }
  {
    reset();
    const st = newScheduler([]);
    st.wallet.countSpendableOutputs = async (minConf) => { st._splitMinConf = minConf; return 1; };
    let opts = null;
    st.walletTor.sendToTorAddress = async (a, amt, o) => { opts = o; return { success: true }; };
    const id = seedWithdrawal({ status: 'tor_checking', retries: 0, priorAttempt: false });
    await quiet(() => st.sendWithdrawal(id));
    ok('Q15. a Tor payout from a 1-output wallet sends with changeOutputs 3, counted at the CLI min_conf 10',
      !!opts && opts.changeOutputs === 3 && st._splitMinConf === 10, JSON.stringify({ opts, minConf: st._splitMinConf }));
  }

  // The wallet read yields: a Tor CLI send that takes the send lock DURING it must still refuse the
  // create at once (503, before the lock) — never leave it waiting out the CLI inside the request.
  reset(); db.prepare('UPDATE miner_accounts SET balance = 100 WHERE grin_address = ?').run(ADDR);
  spendable = 100; inits = 0;
  const realGet = wallet.getBalance;
  wallet.getBalance = async (...a) => { s._torSendBusy = true; return realGet(...a); };
  e = await thrown(() => quiet(() => s.createSlatepackWithdrawal(ADDR, 60)));
  wallet.getBalance = realGet; s._torSendBusy = false;
  ok('Q12. a Tor send starting during the pre-lock wallet read → the create is refused (503), nothing locked',
    !!e && e.code === 503 && /sending another payout/.test(e.message) && inits === 0 &&
    Math.abs(acct().balance - 100) < 1e-9 && acct().balance_locked === 0, e && e.message);
  reset();
}
