// Money-path regression tests — block-reward distribution, the commit-reveal lottery, and the
// per-share donation (design §18.2).
//
// Guards the audit §I3–I6 and §I8 fixes. Each of these was a real bug that moved (or failed
// to move) real GRIN, so they get a test rather than a comment. Runs against a throwaway
// SQLite file in the OS temp dir — never the pool DB. Run: node scripts/test-money-path.js
const path = require('path');
const fs = require('fs');
const os = require('os');

const APP = path.resolve(__dirname, '..');
const dbFile = path.join(os.tmpdir(), `pool-verify-${Date.now()}.sqlite`);

const { initDb, getDb, createSchema, closeDb } = require(path.join(APP, 'lib/db.js'));
initDb(dbFile);
const db = getDb();
createSchema();

const config = {
  network: 'testnet',
  pool_fee_percent: 1,
  pool_fee_address: 'pool_fee',
  confirm_depth_testnet: 100,
  incentives_enabled: 'true',
};

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name} ${extra}`); }
};

// WAL mode leaves -wal and -shm sidecars, and SQLite holds all three until the handle is
// closed — unlinking only the .sqlite (and only that) left three files per run in the temp
// dir. Close first, then remove all three.
const cleanup = () => {
  try { closeDb(); } catch (_) {}
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(dbFile + suffix); } catch (_) {}
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Fake node: header lookup keyed by height, tip movable.
const chain = new Map();
let tipHeight = 1000;
const fakeNode = {
  async getTip() { return { height: tipHeight, hash: chain.get(tipHeight)?.hash || 'aa'.repeat(32) }; },
  async getHeader(h) {
    if (h > tipHeight) throw new Error('height not found');
    const e = chain.get(h);
    if (!e) throw new Error('height not found');
    return e;
  },
};
const mine = (h, hash, nonce) => chain.set(h, { height: h, hash, nonce, timestamp: h });

// ═══ 1. Rewards: verification is live, and settlement is atomic + replay-proof ═══
console.log('\n[1] rewards.js — chain verification + double-credit protection');
const RewardDistributor = require(path.join(APP, 'lib/rewards.js'));

const H = 900;
const GOOD_HASH = 'ab'.repeat(32), NONCE = 12345;
mine(H, GOOD_HASH, NONCE);

db.prepare("INSERT INTO miner_accounts (grin_address, balance) VALUES ('grin1miner', 0)").run();
// String(NONCE): blocks.nonce is TEXT and node:sqlite binds a JS number as a double, which
// lands '12345.0' in the column. Production binds a string (blocks.js#creditBlock); fixtures
// must too, or they are not testing the same row shape. Audit §J5-1.
db.prepare(`INSERT INTO blocks (height, hash, nonce, reward, status, found_by, found_at)
            VALUES (?, ?, ?, 60, 'confirmed', 'grin1miner', unixepoch())`).run(H, GOOD_HASH, String(NONCE));
const blockId = db.prepare('SELECT id FROM blocks WHERE height = ?').get(H).id;
db.prepare(`INSERT INTO shares (grin_address, worker_name, difficulty, block_height, share_hash)
            VALUES ('grin1miner','w1', 100, ?, 'h1')`).run(H);

(async () => {
  // 1a. Without a node, it must REFUSE (used to warn and credit anyway).
  const noNode = new RewardDistributor(config, null);
  const r0 = await noNode.distributeRewards(blockId);
  ok('refuses to distribute with no node client', r0.success === false && /chain verification/i.test(r0.error || ''), JSON.stringify(r0));
  ok('block left confirmed after refusal',
     db.prepare('SELECT status FROM blocks WHERE id=?').get(blockId).status === 'confirmed');

  // 1b. A different block at this height must block the payout. The comparator is HASH-first
  // (lib/block-identity.js, audit §J5-3) — the nonce is only consulted when a hash is not
  // available on both sides, because JSON.parse has already rounded the node's u64.
  const rd = new RewardDistributor(config, fakeNode);
  mine(H, 'cd'.repeat(32), NONCE);            // chain says a different block at this height
  const rBad = await rd.distributeRewards(blockId);
  ok('rejects a block whose chain hash differs',
     rBad.success === false && /does not match the chain \(hash\)/i.test(rBad.error || ''), JSON.stringify(rBad));
  ok('nothing credited on mismatch',
     db.prepare("SELECT balance FROM miner_accounts WHERE grin_address='grin1miner'").get().balance === 0);

  // A matching hash settles it: the nonce is an input to the hash, so "same hash, different
  // nonce" cannot occur on a real chain and must NOT be treated as a mismatch.
  mine(H, GOOD_HASH, 999);
  const rHashWins = await rd.distributeRewards(blockId);
  ok('a matching hash is authoritative — a differing nonce does not veto it', rHashWins.success === true,
     JSON.stringify(rHashWins));
  // Undo it so the happy path below starts from the same state as before.
  db.prepare("UPDATE blocks SET status='confirmed' WHERE id=?").run(blockId);
  db.prepare("UPDATE miner_accounts SET balance=0 WHERE grin_address='grin1miner'").run();
  db.prepare("DELETE FROM balance_log WHERE reference_id=?").run(H);
  db.prepare("UPDATE miner_accounts SET balance=0 WHERE grin_address='pool_fee'").run();

  // The nonce fallback still has teeth where it is the only comparator available: a stored
  // hash that is not 64-hex forces block-identity.js onto the nonce leg.
  db.prepare("UPDATE blocks SET hash='not-a-real-hash' WHERE id=?").run(blockId);
  mine(H, GOOD_HASH, 999);
  const rNonce = await rd.distributeRewards(blockId);
  ok('falls back to the nonce when the hash is not comparable, and rejects a mismatch',
     rNonce.success === false && /does not match the chain \(nonce\)/i.test(rNonce.error || ''), JSON.stringify(rNonce));

  // And a block that can be compared by NEITHER must refuse, not credit (fail closed).
  db.prepare("UPDATE blocks SET nonce='' WHERE id=?").run(blockId);
  const rUnknown = await rd.distributeRewards(blockId);
  ok('refuses to credit a block it cannot verify at all (fail closed)',
     rUnknown.success === false && /could not be verified/i.test(rUnknown.error || ''), JSON.stringify(rUnknown));
  db.prepare("UPDATE blocks SET hash=?, nonce=? WHERE id=?").run(GOOD_HASH, String(NONCE), blockId);

  // 1c. Happy path.
  mine(H, GOOD_HASH, NONCE);
  const rGood = await rd.distributeRewards(blockId);
  ok('distributes a verified block', rGood.success === true, JSON.stringify(rGood));
  const bal = db.prepare("SELECT balance FROM miner_accounts WHERE grin_address='grin1miner'").get().balance;
  ok('miner credited 60 - 1% fee = 59.4', Math.abs(bal - 59.4) < 1e-9, `got ${bal}`);
  ok('block flipped to paid', db.prepare('SELECT status FROM blocks WHERE id=?').get(blockId).status === 'paid');

  // 1d. THE §I4 REGRESSION TEST: replaying the same block must not credit twice.
  const rReplay = await rd.distributeRewards(blockId);
  ok('replay refused (already settled)', rReplay.success === false, JSON.stringify(rReplay));
  const bal2 = db.prepare("SELECT balance FROM miner_accounts WHERE grin_address='grin1miner'").get().balance;
  ok('balance UNCHANGED after replay', Math.abs(bal2 - 59.4) < 1e-9, `got ${bal2}`);

  // 1e. §I5 — ledger rows carry real before/after, not zeros.
  const led = db.prepare("SELECT * FROM balance_log WHERE grin_address='grin1miner' AND event_type='credit'").get();
  ok('credit ledger row has real balance_after', led && Math.abs(led.balance_after - 59.4) < 1e-9, JSON.stringify(led));
  ok('credit ledger row has real balance_before', led && led.balance_before === 0);

  // 1f. §I4 ATOMICITY, directly. Make a late step of the distribution throw and assert that
  // NOTHING committed: not the credits, not the confirmed→paid flip. Before the fix these
  // were separate write units, so a failure here left miners credited with the block still
  // 'confirmed' — and the next monitor tick credited them all over again.
  const H2 = 901, HASH2 = 'ef'.repeat(32);
  mine(H2, HASH2, 777);
  db.prepare(`INSERT INTO blocks (height, hash, nonce, reward, status, found_by, found_at)
              VALUES (?, ?, 777, 60, 'confirmed', 'grin1miner', unixepoch())`).run(H2, HASH2);
  const bid2 = db.prepare('SELECT id FROM blocks WHERE height=?').get(H2).id;
  db.prepare(`INSERT INTO shares (grin_address, worker_name, difficulty, block_height, share_hash)
              VALUES ('grin1miner','w1', 100, ?, 'h2')`).run(H2);

  const balPre = db.prepare("SELECT balance FROM miner_accounts WHERE grin_address='grin1miner'").get().balance;
  const realApply = rd.incentives.applyToDistribution.bind(rd.incentives);
  rd.incentives.enabled = () => true;
  rd.incentives.applyToDistribution = () => { throw new Error('simulated crash mid-distribution'); };
  const rBoom = await rd.distributeRewards(bid2);
  rd.incentives.applyToDistribution = realApply;

  ok('a mid-distribution failure is reported', rBoom.success === false, JSON.stringify(rBoom));
  ok('ROLLBACK: block still confirmed after mid-distribution failure',
     db.prepare('SELECT status FROM blocks WHERE id=?').get(bid2).status === 'confirmed');
  ok('ROLLBACK: no balance moved after mid-distribution failure',
     db.prepare("SELECT balance FROM miner_accounts WHERE grin_address='grin1miner'").get().balance === balPre);
  ok('ROLLBACK: no orphan ledger row written',
     db.prepare("SELECT COUNT(*) c FROM balance_log WHERE reference_type='block' AND reference_id=?").get(H2).c === 0);

  // And the retry after the transient failure clears succeeds exactly once.
  const rRetry = await rd.distributeRewards(bid2);
  ok('retry after the failure succeeds', rRetry.success === true, JSON.stringify(rRetry));
  ok('retry credited exactly once',
     Math.abs(db.prepare("SELECT balance FROM miner_accounts WHERE grin_address='grin1miner'").get().balance - (balPre + 59.4)) < 1e-9);

  // ═══ 2. Lottery: commit-reveal ═══
  console.log('\n[2] lottery.js — commit-reveal seed');
  const LotteryManager = require(path.join(APP, 'lib/lottery.js'));

  // Enable incentives + lottery through pool_settings.
  const PoolSettings = require(path.join(APP, 'lib/pool-settings.js'));
  const ps = new PoolSettings(db);
  // updateSection writes an admin_audit_log row FK'd to users(id) — give it a real admin.
  db.prepare("INSERT INTO users (username, password_hash, is_admin, is_active) VALUES ('t','x',1,1)").run();
  const uid = db.prepare("SELECT id FROM users WHERE username='t'").get().id;
  ps.updateSection('incentives', { incentives_enabled: 'true', lottery_enabled: 'true' }, uid);

  // Fund the prize pool and give two addresses hashrate history.
  const IncentivesManager = require(path.join(APP, 'lib/incentives.js'));
  const inc = new IncentivesManager(config);
  inc.creditPrizePool(100, 'test', 0);
  const nowS = Math.floor(Date.now() / 1000);
  for (const [addr, gps] of [['grin1alpha', 500], ['grin1beta', 100]]) {
    db.prepare("INSERT OR IGNORE INTO miner_accounts (grin_address, balance) VALUES (?, 0)").run(addr);
    for (let d = 0; d < 3; d++) {
      db.prepare(`INSERT INTO hashrate_history (grin_address, hashrate_gps, window_seconds, recorded_at)
                  VALUES (?, ?, 600, ?)`).run(addr, gps, nowS - d * 86400 - 100);
    }
  }

  const lot = new LotteryManager(config, fakeNode);
  tipHeight = 2000;
  const commit = await lot.runDraw('weekly', {});
  ok('draw commits without paying', commit.success === true && commit.committed === true && commit.winners.length === 0, JSON.stringify(commit));
  ok('seed height is AHEAD of the tip at commit', commit.seed_height > 2000, `seed ${commit.seed_height} tip 2000`);
  ok('draw row is status=committed with NO seed_hash', (() => {
    const d = db.prepare('SELECT status, seed_hash FROM lottery_draws WHERE id=?').get(commit.draw_id);
    return d.status === 'committed' && d.seed_hash === null;
  })());
  ok('entry set frozen into lottery_entries',
     db.prepare('SELECT COUNT(*) c FROM lottery_entries WHERE draw_id=?').get(commit.draw_id).c === 2);
  const potBefore = inc.prizePoolBalance();

  // Reveal must be a no-op until the seed block exists.
  const early = await lot.resolveCommittedDraws();
  ok('reveal is a no-op before the seed block is mined', early.length === 0);
  ok('prize pool untouched while pending', inc.prizePoolBalance() === potBefore);

  // Mine the committed block, then reveal.
  mine(commit.seed_height, '77'.repeat(32), 42);
  tipHeight = commit.seed_height;
  const revealed = await lot.resolveCommittedDraws();
  ok('reveal resolves once the seed block exists', revealed.length === 1, JSON.stringify(revealed));
  ok('winners recorded', revealed[0] && revealed[0].winners.length > 0, JSON.stringify(revealed[0]));
  ok('seed_hash stamped from the committed height',
     db.prepare('SELECT seed_hash FROM lottery_draws WHERE id=?').get(commit.draw_id).seed_hash === '77'.repeat(32));
  ok('prize pool debited', inc.prizePoolBalance() < potBefore, `${inc.prizePoolBalance()} vs ${potBefore}`);

  // Re-running the reveal must not pay twice.
  const potAfter = inc.prizePoolBalance();
  const again = await lot.resolveCommittedDraws();
  ok('second reveal pays nothing', again.length === 0 && inc.prizePoolBalance() === potAfter);

  // §I5 for the incentives mover.
  const lotLed = db.prepare("SELECT * FROM balance_log WHERE reference_type='lottery' AND event_type='credit'").get();
  ok('lottery ledger row has non-zero before/after',
     lotLed && !(lotLed.balance_before === 0 && lotLed.balance_after === 0), JSON.stringify(lotLed));

  // ═══ 3. Donations are per SHARE (design §18.2) ═══
  // A `donateN` tag on a share's worker name donates N % of the credit THAT share earns. Nothing
  // is stored per address: the v1 miner_incentives.donation_percent column is dead, and case (f)
  // proves it by setting it to 100 on an address that mines untagged.
  console.log('\n[3] per-share donation — rewards.js → incentives.applyToDistribution');
  tipHeight = 100000;
  const near = (a, b) => Math.abs(a - b) < 1e-9;
  const balOf = (a) => (db.prepare('SELECT balance FROM miner_accounts WHERE grin_address = ?').get(a) || { balance: 0 }).balance;
  const debitAt = (a, h) => db.prepare(`SELECT COALESCE(SUM(amount),0) s, COUNT(*) c FROM balance_log
    WHERE grin_address = ? AND event_type = 'debit' AND reference_type = 'donation' AND reference_id = ?`).get(a, h);
  const creditAt = (a, h) => db.prepare(`SELECT COALESCE(SUM(amount),0) s FROM balance_log
    WHERE grin_address = ? AND event_type = 'credit' AND reference_type = 'block' AND reference_id = ?`).get(a, h).s;
  const potDonationsAt = (h) => db.prepare(`SELECT COALESCE(SUM(amount),0) s FROM balance_log
    WHERE grin_address = 'prize_pool' AND event_type = 'credit' AND reference_type = 'donation' AND reference_id = ?`).get(h).s;
  let shareSeq = 0;
  // A matured block at height h with the given [address, worker, difficulty] shares. Heights are
  // ≥ 100 apart so no PPLNS window (60) overlaps another case or the §1 shares.
  const settleBlock = async (h, shares) => {
    const hash = (h % 256).toString(16).padStart(2, '0').repeat(32);
    mine(h, hash, h);
    // Accounts first: blocks.found_by is a foreign key to miner_accounts.
    for (const [addr] of shares) {
      db.prepare('INSERT OR IGNORE INTO miner_accounts (grin_address, balance) VALUES (?, 0)').run(addr);
    }
    db.prepare(`INSERT INTO blocks (height, hash, nonce, reward, status, found_by, found_at)
                VALUES (?, ?, ?, 60, 'confirmed', ?, unixepoch())`).run(h, hash, String(h), shares[0][0]);
    const id = db.prepare('SELECT id FROM blocks WHERE height = ?').get(h).id;
    for (const [addr, worker, diff] of shares) {
      db.prepare(`INSERT INTO shares (grin_address, worker_name, difficulty, block_height, share_hash)
                  VALUES (?, ?, ?, ?, ?)`).run(addr, worker, diff, h, `don-${++shareSeq}`);
    }
    return rd.distributeRewards(id);
  };
  // Miner reward is 60 − 1 % fee = 59.4, split by difficulty over the block's shares.
  ps.updateSection('incentives', { incentives_enabled: 'true', allow_miner_donations: 'true' }, uid);
  const A = 'grin1donorA', B = 'grin1donorB', C = 'grin1donorC', V = 'grin1victim', D = 'grin1oldcol';
  // Σ difficulty = 1000 → one unit of difficulty earns 0.0594.
  const HD = 5000;
  const rD = await settleBlock(HD, [
    [A, 'riga-donate10', 100], [A, 'rigb', 100],                                  // (a) one tagged rig of two
    [B, 'donate100', 100],                                                         // (b) whole-name donate100
    [C, 'r1-donate5', 100], [C, 'r2-donate20', 300],                               // (c) mixed pcts
    [V, 'rig1', 100], [V, 'stranger-donate100', 100],                              // (d) stranger tags the victim
    [D, 'rig1', 100],                                                              // (f) dead column set to 100
  ]);
  ok('the per-share block distributes', rD.success === true, JSON.stringify(rD));
  const u = 59.4 / 1000;
  // Only the tagged rig's credit donates: 100 × u × 10 % — rigb's 100 × u is untouched.
  ok('(a) one tagged rig of two: donation = only that rig’s share credit × 10 %',
     near(debitAt(A, HD).s, 100 * u * 0.10) && debitAt(A, HD).c === 1, JSON.stringify(debitAt(A, HD)));
  ok('(a) the address keeps the untagged rig’s credit and 90 % of the tagged one',
     near(balOf(A), 200 * u - 100 * u * 0.10), `got ${balOf(A)}`);
  ok('(b) donate100: donated == gross exactly, one debit row',
     debitAt(B, HD).s === creditAt(B, HD) && debitAt(B, HD).c === 1, `${debitAt(B, HD).s} vs ${creditAt(B, HD)}`);
  ok('(b) donate100: the balance is untouched net', near(balOf(B), 0), `got ${balOf(B)}`);
  ok('(c) mixed 5 % + 20 %: donation = Σ each share’s credit × its own %',
     near(debitAt(C, HD).s, 100 * u * 0.05 + 300 * u * 0.20), JSON.stringify(debitAt(C, HD)));
  ok('(d) a stranger’s donate100 share on the victim’s address moves ONLY that share’s credit',
     near(debitAt(V, HD).s, 100 * u) && near(balOf(V), 100 * u), `debit ${debitAt(V, HD).s} bal ${balOf(V)}`);

  // (f) The v1 column, set to 100 on an address that mines untagged, must move NOTHING.
  db.prepare('INSERT OR IGNORE INTO miner_incentives (grin_address) VALUES (?)').run(D);
  db.prepare('UPDATE miner_incentives SET donation_percent = 100 WHERE grin_address = ?').run(D);
  const HF = 5100;
  await settleBlock(HF, [[D, 'rig1', 100]]);
  ok('(f) miner_incentives.donation_percent = 100 with NO tagged share donates NOTHING',
     debitAt(D, HF).c === 0 && near(balOf(D), 100 * u + 59.4), `debit ${JSON.stringify(debitAt(D, HF))} bal ${balOf(D)}`);

  // Invariants over every address in both blocks: donated ≤ gross, and the prize pool receives
  // exactly what the donors were debited (the ledger shape reconciliation.js relies on).
  for (const h of [HD, HF]) {
    const addrs = db.prepare(`SELECT DISTINCT grin_address a FROM balance_log
      WHERE reference_id = ? AND reference_type IN ('block','donation') AND grin_address != 'prize_pool'`).all(h).map((r) => r.a);
    ok(`height ${h}: donated ≤ gross for every address (${addrs.length})`,
       addrs.every((a) => debitAt(a, h).s <= creditAt(a, h)));
    const debits = addrs.reduce((s, a) => s + debitAt(a, h).s, 0);
    ok(`height ${h}: prize-pool donation credits == Σ donor debits`, near(potDonationsAt(h), debits),
       `${potDonationsAt(h)} vs ${debits}`);
  }

  // (e) Donations OFF: a tagged share donates nothing.
  ps.updateSection('incentives', { allow_miner_donations: 'false' }, uid);
  const HE = 5200;
  const balE = balOf(A);
  await settleBlock(HE, [[A, 'riga-donate50', 100]]);
  ok('(e) donations OFF: a tagged share moves nothing', debitAt(A, HE).c === 0 && near(balOf(A), balE + 59.4),
     `debit ${JSON.stringify(debitAt(A, HE))}`);
  ps.updateSection('incentives', { allow_miner_donations: 'true' }, uid);

  // (e2) Master switch OFF too: applyToDistribution never runs the donation leg.
  ps.updateSection('incentives', { incentives_enabled: 'false' }, uid);
  const HE2 = 5300;
  const balE2 = balOf(A);
  await settleBlock(HE2, [[A, 'donate100', 100]]);
  ok('(e2) incentives OFF: even donate100 moves nothing', debitAt(A, HE2).c === 0 && near(balOf(A), balE2 + 59.4));
  ps.updateSection('incentives', { incentives_enabled: 'true' }, uid);

  // A typo is a plain name at distribution exactly as it is at login (one parser).
  const HT = 5400;
  await settleBlock(HT, [[C, 'rig-donate101', 100], [C, 'donatexx', 100]]);
  ok('an out-of-range or malformed tag donates nothing', debitAt(C, HT).c === 0);

  console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
  cleanup();
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('HARNESS ERROR:', e); cleanup(); process.exit(2); });
