// Block-finder jackpot queue, jackpot reversal by block, and the loyalty-streak updater.
//
// Pins: a jackpot due at maturity that the prize pool cannot cover is recorded in jackpot_pending
// (never lost), once per block, at the amount in force at maturity; the queue pays strictly oldest
// first and only while incentives + jackpot are on; a pending jackpot is dropped when its block
// orphans; a crash mid-payment or after the credit never pays twice; the maturity path and the
// queue never both pay one block; orphaning one of two pool blocks at a height keeps the confirmed
// block's jackpot AND its PPLNS / pool-fee credits; a jackpot that throws rolls its confirm claim
// back; jackpot_amount stays below one block reward; reconciliation stays balanced with jackpots
// waiting (they are not liabilities).
// Streaks: counted from hashrate_history (or the daily rollup for a rolled day) for yesterday then
// today, idempotent across restarts, repeat runs and the scan overlap, late-day mining counts, a
// gap day restarts at 1, last_active_day never moves back and a future one is stale, and a sliced
// catch-up ends where one full call does.
//
// Runs the real modules (BlockMonitor's maturity sweep included) against a throwaway SQLite file
// and a fake node. Never touches the pool DB, starts no server.
// Run: node scripts/test-jackpot-streak.js
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

const APP = path.resolve(__dirname, '..');
const dbFile = path.join(os.tmpdir(), `pool-jackpot-streak-${Date.now()}.sqlite`);

const { initDb, getDb, createSchema, closeDb } = require(path.join(APP, 'lib/db.js'));
initDb(dbFile);
const db = getDb();
createSchema();

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name} ${extra}`); }
};
const near = (a, b) => Math.abs(a - b) < 1e-9;

const cleanup = () => {
  try { closeDb(); } catch (_) {}
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(dbFile + suffix); } catch (_) {}
  }
};

// The payers log every pending/paid/dropped event; keep the test output readable.
const realLog = console.log;
const realWarn = console.warn;
const realError = console.error;
const mute = () => { console.log = console.warn = console.error = () => {}; };
const unmute = () => { console.log = realLog; console.warn = realWarn; console.error = realError; };
const quiet = (fn) => { mute(); try { return fn(); } finally { unmute(); } };
const quietAsync = async (fn) => { mute(); try { return await fn(); } finally { unmute(); } };

const config = {
  network: 'testnet',
  pool_fee_percent: 1,
  pool_fee_address: 'pool_fee',
  confirm_depth_testnet: 100,
  node_api_url: 'http://127.0.0.1:13413',
  node_api_secret: 'stub',
  node_foreign_api_secret: 'stub',
};

let tipHeight = 10000;
const hashAt = (h) => crypto.createHash('sha256').update(`block-${h}`).digest('hex');
const fakeNode = {
  async getTip() { return { height: tipHeight, hash: hashAt(tipHeight) }; },
  async getHeader(h) {
    if (h > tipHeight) { const e = new Error('height not found'); e.nodeReplied = true; e.notFound = true; throw e; }
    return { height: h, hash: hashAt(h) };
  },
};

const addr = (tag) => `grin1${tag.padEnd(58, 'q')}`;
const account = (a) => db.prepare('INSERT OR IGNORE INTO miner_accounts (grin_address, balance) VALUES (?, 0)').run(a);
const balOf = (a) => { const r = db.prepare('SELECT balance FROM miner_accounts WHERE grin_address = ?').get(a); return r ? r.balance : 0; };
let blockSeq = 0;
// onChain: the stored hash matches the fake chain's header at that height, so the sweep confirms it.
const block = (height, finder, onChain = true) => {
  account(finder);
  const hash = onChain ? hashAt(height) : crypto.createHash('sha256').update(`stale-${height}-${++blockSeq}`).digest('hex');
  const r = db.prepare(`
    INSERT INTO blocks (height, hash, nonce, reward, status, found_by, found_at)
    VALUES (?, ?, '1', 60, 'immature', ?, unixepoch())
  `).run(height, hash, finder);
  return db.prepare('SELECT * FROM blocks WHERE id = ?').get(Number(r.lastInsertRowid));
};
const jackpotCredits = (a, h) => db.prepare(
  "SELECT COUNT(*) c, COALESCE(SUM(amount),0) s FROM balance_log WHERE grin_address=? AND reference_type='jackpot' AND event_type='credit' AND reference_id=?").get(a, h);
const jackpotReversals = (h) => db.prepare(
  "SELECT COUNT(*) c FROM balance_log WHERE reference_type='jackpot' AND event_type='reversal' AND reference_id=?").get(h).c;
const pending = () => db.prepare('SELECT * FROM jackpot_pending ORDER BY created_at, block_id').all();
// Spread created_at so FIFO order is the order the test recorded them in.
let pendingClock = 1700000000;
const ageLatestPending = () => db.prepare(
  'UPDATE jackpot_pending SET created_at = ? WHERE block_id = (SELECT MAX(block_id) FROM jackpot_pending)').run(++pendingClock);

const PoolSettings = require(path.join(APP, 'lib/pool-settings.js'));
const IncentivesManager = require(path.join(APP, 'lib/incentives.js'));
const BlockMonitor = require(path.join(APP, 'lib/block-monitor.js'));
const { computeReconciliation } = require(path.join(APP, 'lib/reconciliation.js'));

db.prepare("INSERT INTO users (username, password_hash, is_admin, is_active) VALUES ('t','x',1,1)").run();
const uid = db.prepare("SELECT id FROM users WHERE username='t'").get().id;
const ps = new PoolSettings(db);
const setInc = (patch) => ps.updateSection('incentives', patch, uid);

const monitor = new BlockMonitor(config);
monitor.grinNode = fakeNode;
monitor.orphanDetector.grinNode = fakeNode;
const inc = monitor.orphanDetector.incentives;     // the instance the maturity sweep uses
const sweep = () => quietAsync(() => monitor.checkImmatureBlocks());
const drainPrizePool = () => {
  const b = inc.prizePoolBalance();
  if (b > 0) inc._move('prize_pool', -b, 'debit', 'prize_award', 0);
};

(async () => {
  setInc({ incentives_enabled: 'true', jackpot_enabled: 'true', jackpot_amount: 5 });

  // ═══ 1. Short at maturity → pending, not lost ═══
  console.log('\n[1] a jackpot the prize pool cannot cover at maturity is recorded as pending');
  const A = addr('alice');
  const b1 = block(9000, A);
  await sweep();
  ok('the block confirmed', db.prepare('SELECT status FROM blocks WHERE id=?').get(b1.id).status === 'confirmed');
  ok('no jackpot credit while the prize pool is empty', jackpotCredits(A, 9000).c === 0);
  let p = pending();
  ok('one pending row, keyed to the block, at the amount in force at maturity',
     p.length === 1 && p[0].block_id === b1.id && p[0].block_height === 9000 && p[0].grin_address === A && near(p[0].amount, 5),
     JSON.stringify(p));
  ok('a repeat call for the same block records nothing more (idempotent per block)',
     quiet(() => inc.payBlockFinderJackpot(b1)) === false && pending().length === 1);
  ok('pendingJackpotSummary reports it', (() => { const s = inc.pendingJackpotSummary(); return s.count === 1 && near(s.amount, 5); })());

  // ═══ 2. Not paid while switched off ═══
  console.log('\n[2] the queue pays nothing while incentives or the jackpot are off');
  inc.creditPrizePool(100, 'topup', 0);
  setInc({ jackpot_enabled: 'false' });
  let r = quiet(() => inc.payPendingJackpots());
  ok('jackpot off: nothing paid, row kept', r.paid === 0 && r.waiting === 1 && pending().length === 1 && jackpotCredits(A, 9000).c === 0);
  setInc({ jackpot_enabled: 'true', incentives_enabled: 'false' });
  r = quiet(() => inc.payPendingJackpots());
  ok('incentives off: nothing paid, row kept', r.paid === 0 && pending().length === 1);
  ok('a quoted "false" is off too', (() => { setInc({ incentives_enabled: '"false"' }); return quiet(() => inc.payPendingJackpots()).paid === 0; })());
  setInc({ incentives_enabled: 'true' });

  // ═══ 3. Paid once covered, same ledger shape ═══
  console.log('\n[3] once covered it is paid with the maturity-path ledger shape, and the row goes');
  const pool0 = inc.prizePoolBalance();
  r = quiet(() => inc.payPendingJackpots());
  ok('paid one', r.paid === 1 && pending().length === 0, JSON.stringify(r));
  ok('miner credited 5 under jackpot / block height', jackpotCredits(A, 9000).c === 1 && near(jackpotCredits(A, 9000).s, 5));
  ok('prize pool debited 5 under jackpot / block height', near(inc.prizePoolBalance(), pool0 - 5) &&
     db.prepare("SELECT COUNT(*) c FROM balance_log WHERE grin_address='prize_pool' AND event_type='debit' AND reference_type='jackpot' AND reference_id=9000").get().c === 1);
  ok('a second sweep pays nothing', quiet(() => inc.payPendingJackpots()).paid === 0 && jackpotCredits(A, 9000).c === 1);

  // ═══ 4. Strict FIFO ═══
  console.log('\n[4] pending jackpots are paid oldest first, and the first that cannot be covered stops the queue');
  drainPrizePool();
  const B = addr('bob'); const C = addr('carol'); const D = addr('dave');
  const b2 = block(9010, B); setInc({ jackpot_amount: 5 }); await sweep(); ageLatestPending();
  const b3 = block(9011, C); setInc({ jackpot_amount: 10 }); await sweep(); ageLatestPending();
  const b4 = block(9012, D); setInc({ jackpot_amount: 3 }); await sweep(); ageLatestPending();
  p = pending();
  ok('three pending, each at its own maturity-time amount',
     p.length === 3 && p.map((x) => x.block_id).join() === [b2.id, b3.id, b4.id].join() && p.map((x) => x.amount).join() === '5,10,3',
     JSON.stringify(p.map((x) => [x.block_id, x.amount])));
  inc.creditPrizePool(12, 'topup', 0);
  r = quiet(() => inc.payPendingJackpots());
  ok('12 GRIN pays the oldest (5) and stops at the 10 — the 3 behind it waits (strict FIFO)',
     r.paid === 1 && r.waiting === 2 && jackpotCredits(B, 9010).c === 1 && jackpotCredits(C, 9011).c === 0 && jackpotCredits(D, 9012).c === 0,
     JSON.stringify(r));
  ok('prize pool holds the 7 left', near(inc.prizePoolBalance(), 7));

  // A block maturing while others wait joins the back even if it alone could be covered.
  const E = addr('erin');
  setInc({ jackpot_amount: 1 });
  const b5 = block(9013, E); await sweep(); ageLatestPending();
  ok('a new jackpot that fits the balance still queues behind older ones',
     jackpotCredits(E, 9013).c === 0 && pending().length === 3 && pending()[2].block_id === b5.id);

  const bal = quiet(() => inc.manualTopup(10));   // 17: pays 10, 3, 1 → 3 left
  ok('a manual top-up pays the queue in order at once', jackpotCredits(C, 9011).c === 1 && jackpotCredits(D, 9012).c === 1 &&
     jackpotCredits(E, 9013).c === 1 && pending().length === 0);
  ok('manualTopup returns the balance after those payments', near(bal, 3) && near(inc.prizePoolBalance(), 3), String(bal));
  const order = db.prepare(`SELECT reference_id FROM balance_log WHERE reference_type='jackpot' AND event_type='credit'
                            AND reference_id IN (9010, 9011, 9012, 9013) ORDER BY id`).all().map((x) => x.reference_id).join();
  ok('ledger order is maturity order', order === '9010,9011,9012,9013', order);

  // ═══ 5. Orphan while pending ═══
  console.log('\n[5] a pending jackpot is dropped when its block orphans');
  drainPrizePool();
  setInc({ jackpot_amount: 5 });
  const F = addr('frank');
  const b6 = block(9020, F, false);              // will NOT match the chain
  quiet(() => inc.payBlockFinderJackpot(b6));     // queued (empty prize pool)
  ok('queued', pending().some((x) => x.block_id === b6.id));
  await sweep();                                  // mismatch → orphanBlock → reverseBlockPayouts
  ok('the block orphaned', db.prepare('SELECT status FROM blocks WHERE id=?').get(b6.id).status === 'orphaned');
  ok('its pending row is gone and nothing was paid or reversed',
     !pending().some((x) => x.block_id === b6.id) && jackpotCredits(F, 9020).c === 0 && jackpotReversals(9020) === 0);
  // A row the reversal hook missed (hand-inserted here) is dropped by the sweep instead of paid.
  db.prepare("INSERT INTO jackpot_pending (block_id, block_height, grin_address, amount) VALUES (?, 9020, ?, 5)").run(b6.id, F);
  inc.creditPrizePool(50, 'topup', 0);
  r = quiet(() => inc.payPendingJackpots());
  ok('the sweep drops a pending row whose block is orphaned, paying nothing', r.dropped === 1 && r.paid === 0 && jackpotCredits(F, 9020).c === 0);

  // ═══ 6. Crash idempotence ═══
  console.log('\n[6] a crash mid-payment or after the credit never pays twice');
  drainPrizePool();
  const G = addr('grace');
  const b7 = block(9030, G); await sweep();
  inc.creditPrizePool(20, 'topup', 0);
  const realMove = inc._move.bind(inc);
  inc._move = (address, ...rest) => { if (address === G) throw new Error('simulated crash'); return realMove(address, ...rest); };
  let threw = false;
  try { quiet(() => inc.payPendingJackpots()); } catch (e) { threw = true; }
  inc._move = realMove;
  ok('a crash between the prize-pool debit and the credit rolls the whole payment back',
     threw && near(inc.prizePoolBalance(), 20) && jackpotCredits(G, 9030).c === 0 && pending().some((x) => x.block_id === b7.id));
  r = quiet(() => inc.payPendingJackpots());
  ok('the retry pays it exactly once', r.paid === 1 && jackpotCredits(G, 9030).c === 1 && near(inc.prizePoolBalance(), 15));
  // Credit landed but the row survived (e.g. restored from an older backup): delete, never re-pay.
  db.prepare("INSERT INTO jackpot_pending (block_id, block_height, grin_address, amount) VALUES (?, 9030, ?, 5)").run(b7.id, G);
  const gBal = balOf(G);
  r = quiet(() => inc.payPendingJackpots());
  ok('a row whose credit is already on the ledger is deleted without paying',
     pending().length === 0 && jackpotCredits(G, 9030).c === 1 && near(balOf(G), gBal) && near(inc.prizePoolBalance(), 15));

  // ═══ 7. Maturity path and queue never both pay ═══
  console.log('\n[7] the maturity path and the queue never both pay one block');
  const H = addr('heidi');
  const b8 = block(9040, H); await sweep();
  ok('covered and queue empty: paid at maturity, nothing queued', jackpotCredits(H, 9040).c === 1 && pending().length === 0);
  ok('calling the maturity payer again is a no-op', quiet(() => inc.payBlockFinderJackpot(b8)) === false && jackpotCredits(H, 9040).c === 1 && pending().length === 0);
  db.prepare("INSERT INTO jackpot_pending (block_id, block_height, grin_address, amount) VALUES (?, 9040, ?, 5)").run(b8.id, H);
  quiet(() => inc.payPendingJackpots());
  ok('a stray pending row for a block paid at maturity is cleared, not paid', jackpotCredits(H, 9040).c === 1 && pending().length === 0);

  // ═══ 8. Two pool blocks at one height ═══
  console.log('\n[8] orphaning one of two pool blocks at a height keeps the confirmed block\'s jackpot');
  inc.creditPrizePool(50, 'topup', 0);
  const I = addr('ivan'); const J = addr('judy');
  // Same finder: both blocks credit the same address at the same height.
  const win1 = block(9050, I, true);
  const lose1 = block(9050, I, false);
  await sweep();
  ok('one confirmed, one orphaned', db.prepare('SELECT status FROM blocks WHERE id=?').get(win1.id).status === 'confirmed' &&
     db.prepare('SELECT status FROM blocks WHERE id=?').get(lose1.id).status === 'orphaned');
  ok('same finder: the confirmed block\'s jackpot is kept (no reversal)', jackpotCredits(I, 9050).c === 1 && jackpotReversals(9050) === 0);
  // Different finders.
  const win2 = block(9051, I, true);
  const lose2 = block(9051, J, false);
  await sweep();
  ok('different finder: the winner keeps it, the loser was never paid',
     jackpotCredits(I, 9051).c === 1 && jackpotCredits(J, 9051).c === 0 && jackpotReversals(9051) === 0);
  // The orphan reached later (another tick, after the winner was distributed) still keeps it.
  db.prepare("UPDATE blocks SET status='paid' WHERE id=?").run(win2.id);
  quiet(() => monitor.orphanDetector.reverseBlockPayouts(lose2.id));
  ok('a repeat reversal of the losing block after the winner is paid still keeps the jackpot', jackpotReversals(9051) === 0);
  // A block's OWN paid jackpot is still clawed back if that block orphans.
  const self = block(9060, J, true); await sweep();
  ok('paid at maturity', jackpotCredits(J, 9060).c === 1);
  db.prepare("UPDATE blocks SET status='orphaned' WHERE id=?").run(self.id);
  const poolBefore = inc.prizePoolBalance();
  quiet(() => monitor.orphanDetector.reverseBlockPayouts(self.id));
  ok('the jackpot that block itself earned is reversed into the prize pool',
     jackpotReversals(9060) === 1 && near(inc.prizePoolBalance(), poolBefore + 5));
  quiet(() => monitor.orphanDetector.reverseBlockPayouts(self.id));
  ok('…once', jackpotReversals(9060) === 1);

  // ═══ 9. Reconciliation ═══
  console.log('\n[9] reconciliation balances with jackpots waiting (they are not liabilities until paid)');
  drainPrizePool();
  const K = addr('kim');
  block(9070, K); await sweep();
  block(9071, K); await sweep();
  ok('two jackpots waiting', pending().length === 2);
  inc.creditPrizePool(7, 'topup', 0);             // covers one of the two 5s
  const heldNow = () => db.prepare('SELECT COALESCE(SUM(balance + balance_locked),0) s FROM miner_accounts').get().s;
  const walletFor = (held) => ({ async getBalance() {
    const n = String(Math.round(held * 1e9));
    return [true, { total: n, amount_currently_spendable: n, amount_locked: '0' }];
  } });
  let rc = await computeReconciliation(db, walletFor(heldNow()), false);
  ok('integrity holds with jackpots pending', rc.checks.integrity_ok === true, String(rc.checks.integrity_drift));
  ok('coverage gap is 0: pending jackpots add nothing to what is owed', near(rc.checks.coverage_full_gap, 0), String(rc.checks.coverage_full_gap));
  ok('the prize-pool figure is the bucket balance, pending not deducted', near(rc.ledger.buckets.prize_pool.balance, 7),
     JSON.stringify(rc.ledger.buckets.prize_pool));
  const heldBefore = heldNow();
  r = quiet(() => inc.payPendingJackpots());
  ok('paying one moves GRIN between accounts and leaves what is owed unchanged', r.paid === 1 && near(heldNow(), heldBefore));
  rc = await computeReconciliation(db, walletFor(heldNow()), false);
  ok('integrity and coverage still hold after the payment', rc.checks.integrity_ok === true && near(rc.checks.coverage_full_gap, 0),
     `${rc.checks.integrity_drift} / ${rc.checks.coverage_full_gap}`);

  // ═══ 9b. Block-reward reversal of a same-height sibling ═══
  console.log('\n[9b] orphaning a same-height sibling never reverses the winner\'s PPLNS / pool-fee credits');
  {
    const RewardDistributor = require(path.join(APP, 'lib/rewards.js'));
    setInc({ jackpot_enabled: 'false' });
    const W = addr('winner'); const L = addr('loser');
    account(W); account(L);
    const HS = 9100;
    const win = block(HS, W, true);
    const lose = block(HS, L, false);
    db.prepare(`INSERT INTO shares (grin_address, worker_name, difficulty, block_height, share_hash) VALUES (?, 'w', 300, ?, 'sib-1')`).run(W, HS);
    db.prepare(`INSERT INTO shares (grin_address, worker_name, difficulty, block_height, share_hash) VALUES (?, 'w', 100, ?, 'sib-2')`).run(L, HS);
    // The node drops between the two getHeader(HS) calls: the winner confirms, the sweep aborts
    // before the loser, distribution then credits the winner, and the loser orphans next tick.
    let calls = 0;
    const realGetHeader = fakeNode.getHeader;
    fakeNode.getHeader = async (h) => { calls++; if (h === HS && calls === 2) throw new Error('ECONNREFUSED'); return realGetHeader(h); };
    await quietAsync(() => monitor.checkImmatureBlocks());
    fakeNode.getHeader = realGetHeader;
    const rd = new RewardDistributor(config, fakeNode);
    monitor.setRewardDistributor(rd);
    await quietAsync(() => monitor.distributeConfirmedBlocks());
    monitor.setRewardDistributor(null);
    const credited = db.prepare("SELECT COUNT(*) c FROM balance_log WHERE reference_type IN ('block','pool_fee') AND event_type='credit' AND reference_id=?").get(HS).c;
    ok('the winner was confirmed and distributed, the loser is still immature',
       db.prepare('SELECT status FROM blocks WHERE id=?').get(win.id).status === 'paid' &&
       db.prepare('SELECT status FROM blocks WHERE id=?').get(lose.id).status === 'immature' && credited > 0, String(credited));
    const wBal = balOf(W); const lBal = balOf(L); const fBal = balOf('pool_fee');
    await quietAsync(() => monitor.checkImmatureBlocks());
    ok('the loser orphaned on the next tick', db.prepare('SELECT status FROM blocks WHERE id=?').get(lose.id).status === 'orphaned');
    ok('no reversal at that height: winner, its PPLNS miners and pool_fee keep their credits',
       db.prepare("SELECT COUNT(*) c FROM balance_log WHERE event_type='reversal' AND reference_id=?").get(HS).c === 0 &&
       near(balOf(W), wBal) && near(balOf(L), lBal) && near(balOf('pool_fee'), fBal));
    quiet(() => monitor.orphanDetector.reverseBlockPayouts(lose.id));
    ok('a repeat reversal of the loser changes nothing', db.prepare("SELECT COUNT(*) c FROM balance_log WHERE event_type='reversal' AND reference_id=?").get(HS).c === 0);
    setInc({ jackpot_enabled: 'true' });
  }

  // ═══ 9c. Confirm claim and jackpot are one transaction ═══
  console.log('\n[9c] a jackpot that throws rolls the confirm back, and the next tick retries both');
  {
    drainPrizePool();
    inc.creditPrizePool(20, 'topup', 0);
    quiet(() => inc.payPendingJackpots());         // clear the jackpot left waiting by [9]
    setInc({ jackpot_amount: 5 });
    const M = addr('mallory');
    const bm = block(9200, M);
    const realPay = inc.payBlockFinderJackpot;
    inc.payBlockFinderJackpot = () => { throw new Error('simulated jackpot failure'); };
    await quietAsync(() => monitor.checkImmatureBlocks());
    inc.payBlockFinderJackpot = realPay;
    ok('the block is still immature and nothing was paid or queued',
       db.prepare('SELECT status FROM blocks WHERE id=?').get(bm.id).status === 'immature' &&
       jackpotCredits(M, 9200).c === 0 && !pending().some((x) => x.block_id === bm.id));
    await sweep();
    ok('the retry confirms it and pays the jackpot once',
       db.prepare('SELECT status FROM blocks WHERE id=?').get(bm.id).status === 'confirmed' && jackpotCredits(M, 9200).c === 1);
  }

  // ═══ 9d. Jackpot amount bound ═══
  console.log('\n[9d] jackpot_amount must stay below one block reward');
  {
    const V = PoolSettings.validators;
    const throws = (fn) => { try { fn(); return false; } catch (_) { return true; } };
    ok('60 GRIN is refused', throws(() => V.incentives.jackpot_amount('60')));
    ok('1000 GRIN is refused', throws(() => V.incentives.jackpot_amount('1000')));
    ok('59.99 GRIN and 0 are accepted', V.incentives.jackpot_amount('59.99') === 59.99 && V.incentives.jackpot_amount('0') === 0);
    ok('the limit is the giveaway\'s block reward', PoolSettings.JACKPOT_GRIN_LIMIT === PoolSettings.GIVEAWAY_GRIN_LIMIT);
    ok('a save over the limit is refused', throws(() => setInc({ jackpot_amount: 75 })));
    const page = fs.readFileSync(path.join(APP, 'admin-panel/settings-incentives.html'), 'utf8');
    ok('the admin input and helper text name the same limit',
       /id="jackpot_amount"[^>]*max="59\.99"/.test(page) && page.includes(`below ${PoolSettings.JACKPOT_GRIN_LIMIT} GRIN (one block reward). Credited when the block matures`));
  }

  // ═══ 10. Loyalty streaks ═══
  console.log('\n[10] loyalty streaks — yesterday then today, from hashrate_history, idempotent');
  const DAY = 86400;
  const T = Math.floor(Date.now() / 1000 / DAY) * DAY;   // today 00:00 UTC (real clock: streakMultiplier reads it)
  const td = T / DAY;
  const hr = (a, at, gps = 10) => { account(a); db.prepare('INSERT INTO hashrate_history (grin_address, hashrate_gps, window_seconds, recorded_at) VALUES (?, ?, 60, ?)').run(a, gps, at); };
  const st = (a) => db.prepare('SELECT streak_days, last_active_day FROM miner_incentives WHERE grin_address = ?').get(a) || {};
  const setRow = (a, days, last) => { account(a); db.prepare('INSERT OR REPLACE INTO miner_incentives (grin_address, streak_days, last_active_day) VALUES (?, ?, ?)').run(a, days, last); };
  const resetMark = () => db.prepare("DELETE FROM pool_config WHERE section = '_state' AND key = 'streak_scan_mark'").run();
  const setMark = (v) => db.prepare(`INSERT INTO pool_config (section, key, value, value_type) VALUES ('_state', 'streak_scan_mark', ?, 'string')
                                     ON CONFLICT(section, key) DO UPDATE SET value = excluded.value`).run(String(v));
  setInc({ streak_enabled: 'true', streak_bonus_per_week_percent: 1, streak_max_percent: 5 });

  // Restart + repeat runs.
  resetMark();
  const S1 = addr('streak1');
  hr(S1, T - DAY + 3600);
  inc.updateStreaks(T - DAY + 7200);
  ok('yesterday\'s mining counts: streak 1, last active yesterday', st(S1).streak_days === 1 && st(S1).last_active_day === td - 1, JSON.stringify(st(S1)));
  const restarted = new IncentivesManager(config);
  restarted.updateStreaks(T - DAY + 7300);
  restarted.updateStreaks(T - DAY + 7300);
  ok('a restart and a repeat run the same day do not double-count', st(S1).streak_days === 1);
  hr(S1, T + 600);
  restarted.updateStreaks(T + 3600);
  ok('the next day extends it to 2', st(S1).streak_days === 2 && st(S1).last_active_day === td, JSON.stringify(st(S1)));
  restarted.updateStreaks(T + 3600);
  new IncentivesManager(config).updateStreaks(T + 7200);
  ok('repeat runs and another restart leave it at 2', st(S1).streak_days === 2);

  // Late-day mining after the last run of that day.
  resetMark();
  const S2 = addr('streak2');
  inc.updateStreaks(T - DAY + 23 * 3600);         // last run of yesterday, S2 not mining yet
  hr(S2, T - DAY + 23 * 3600 + 1800);             // starts at 23:30
  inc.updateStreaks(T + 1800);                    // first run of today
  ok('mining after yesterday\'s last run still counts for yesterday', st(S2).streak_days === 1 && st(S2).last_active_day === td - 1, JSON.stringify(st(S2)));

  // Gap day.
  resetMark();
  const S3 = addr('streak3');
  setRow(S3, 5, td - 2);
  hr(S3, T + 100);
  inc.updateStreaks(T + 3600);
  ok('a missed day restarts the streak at 1', st(S3).streak_days === 1 && st(S3).last_active_day === td, JSON.stringify(st(S3)));

  // Never backwards.
  resetMark();
  const S4 = addr('streak4');
  setRow(S4, 3, td);
  hr(S4, T - DAY + 100);                          // a yesterday sample seen only now
  inc.updateStreaks(T + 3600);
  ok('a day before last_active_day never moves it back or re-counts', st(S4).streak_days === 3 && st(S4).last_active_day === td, JSON.stringify(st(S4)));

  // Zero-work samples do not count.
  resetMark();
  const S5 = addr('streak5');
  hr(S5, T + 100, 0);
  inc.updateStreaks(T + 3600);
  ok('a zero-hashrate sample is not activity', st(S5).last_active_day === undefined || st(S5).last_active_day === null);

  // Long outage: the scan never walks past the start of yesterday.
  const S6 = addr('streak6');
  setRow(S6, 4, td - 4);
  hr(S6, T - 3 * DAY + 100);
  setMark(T - 5 * DAY);
  inc.updateStreaks(T + 3600);
  ok('after a long outage days before yesterday are not walked', st(S6).streak_days === 4 && st(S6).last_active_day === td - 4);
  hr(S6, T - DAY + 500);
  resetMark();
  inc.updateStreaks(T + 3700);
  ok('…and the next active day restarts at 1', st(S6).streak_days === 1 && st(S6).last_active_day === td - 1, JSON.stringify(st(S6)));

  // A scan mark from the future is not trusted.
  const S7 = addr('streak7');
  hr(S7, T + 200);
  setMark(T + 10 * DAY);
  inc.updateStreaks(T + 3600);
  ok('a scan mark ahead of the clock is ignored (rescan from yesterday)', st(S7).streak_days === 1 && st(S7).last_active_day === td);
  ok('the mark is reset to the run time', Number(db.prepare("SELECT value FROM pool_config WHERE section='_state' AND key='streak_scan_mark'").get().value) === T + 3600);

  // A full week, one run a day at varying times.
  resetMark();
  const S8 = addr('streak8');
  for (let d = 6; d >= 0; d--) {
    hr(S8, T - d * DAY + 1000 + d * 3000);
    inc.updateStreaks(T - d * DAY + 1000 + d * 3000 + 600);
  }
  ok('seven consecutive days → streak 7', st(S8).streak_days === 7 && st(S8).last_active_day === td, JSON.stringify(st(S8)));

  // streakMultiplier agrees: active today or yesterday, a full week, capped.
  ok('streakMultiplier: 7 days, active today → +1%', near(inc.streakMultiplier(S8), 0.01));
  const S9 = addr('streak9'); setRow(S9, 7, td - 1);
  ok('streakMultiplier: active yesterday, not yet today → still +1%', near(inc.streakMultiplier(S9), 0.01));
  const S10 = addr('streak10'); setRow(S10, 70, td - 2);
  ok('streakMultiplier: last active two days ago → 0 (broken)', inc.streakMultiplier(S10) === 0);
  const S11 = addr('streak11'); setRow(S11, 70, td);
  ok('streakMultiplier: capped at streak_max_percent', near(inc.streakMultiplier(S11), 0.05));

  // The overlap re-reads a few minutes before the last run; a day already counted stays counted.
  resetMark();
  const S12 = addr('streak12');
  setRow(S12, 3, td - 1);
  hr(S12, T + 7000);
  inc.updateStreaks(T + 7200);
  ok('overlap: counted today → 4', st(S12).streak_days === 4 && st(S12).last_active_day === td);
  hr(S12, T + 7200 - 100);                        // inside the overlap window of the next run
  inc.updateStreaks(T + 10800);
  ok('a sample re-read by the overlap on an already-counted day leaves the streak alone', st(S12).streak_days === 4, JSON.stringify(st(S12)));
  // A sample stamped just before the last run but written after it is only seen thanks to the overlap.
  const S13 = addr('streak13');
  setRow(S13, 4, td - 1);
  inc.updateStreaks(T + 14400);                   // S13 has no sample yet
  hr(S13, T + 14400 - 100);
  inc.updateStreaks(T + 18000);
  ok('the overlap catches a sample stamped just before the last run', st(S13).streak_days === 5 && st(S13).last_active_day === td, JSON.stringify(st(S13)));

  // A clock that ran ahead must not keep a streak alive.
  const S14 = addr('streak14');
  setRow(S14, 30, td + 3);
  ok('streakMultiplier: last_active_day after today is stale → 0', inc.streakMultiplier(S14) === 0);
  resetMark();
  hr(S14, T + 100);
  inc.updateStreaks(T + 3600);
  ok('updateStreaks: last_active_day after today is stale → restarts at 1 today', st(S14).streak_days === 1 && st(S14).last_active_day === td, JSON.stringify(st(S14)));

  // Completed yesterday comes from the daily rollup once it exists.
  resetMark();
  const S15 = addr('streak15'); const S16 = addr('streak16');
  setRow(S15, 2, td - 2); setRow(S16, 2, td - 2);
  db.prepare('INSERT INTO miner_hashrate_daily (day, grin_address, gps_seconds, sample_count) VALUES (?, ?, ?, 1)').run(T - DAY, S15, 600);
  db.prepare('INSERT INTO miner_hashrate_daily (day, grin_address, gps_seconds, sample_count) VALUES (?, ?, ?, 1)').run(T - DAY, S16, 0);
  hr(S16, T - DAY + 500);                         // raw row the rollup says had no work: not read
  db.prepare(`INSERT INTO pool_config (section, key, value, value_type) VALUES ('_state', 'miner_hashrate_day_horizon', ?, 'string')
              ON CONFLICT(section, key) DO UPDATE SET value = excluded.value`).run(String(T));
  inc.updateStreaks(T + 600);
  ok('a rolled-up yesterday is read from miner_hashrate_daily', st(S15).streak_days === 3 && st(S15).last_active_day === td - 1, JSON.stringify(st(S15)));
  ok('…where gps_seconds 0 is not activity (the raw table is not read for that day)', st(S16).streak_days === 2, JSON.stringify(st(S16)));
  db.prepare("DELETE FROM pool_config WHERE section = '_state' AND key = 'miner_hashrate_day_horizon'").run();

  // Read in slices (as index.js does), the catch-up reaches the same result as one full call.
  resetMark();
  const S17 = addr('streak17'); const S18 = addr('streak18');
  setRow(S17, 5, td - 2); setRow(S18, 2, td - 2);
  hr(S17, T - DAY + 20 * 3600); hr(S17, T + 10 * 3600);
  hr(S18, T - DAY + 3600);
  let calls = 0; let res;
  do { res = inc.updateStreaks(T + 12 * 3600, 2 * 3600); calls++; } while (!res.caughtUp && calls < 100);
  ok('a sliced catch-up takes several calls and finishes', res.caughtUp === true && calls > 5, String(calls));
  ok('…with the same streaks as one full call (yesterday then today, in order)',
     st(S17).streak_days === 7 && st(S17).last_active_day === td && st(S18).streak_days === 3 && st(S18).last_active_day === td - 1,
     JSON.stringify([st(S17), st(S18)]));

  // Reserved pseudo-addresses never get a streak.
  resetMark();
  hr('prize_pool', T + 100);
  inc.updateStreaks(T + 3600);
  ok('reserved addresses are skipped', !db.prepare("SELECT 1 FROM miner_incentives WHERE grin_address='prize_pool'").get());

  cleanup();
  console.log('\n' + (fail ? 'FAILURES' : 'ALL PASS') + ` — ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  unmute();
  console.error(e);
  cleanup();
  process.exit(1);
});
