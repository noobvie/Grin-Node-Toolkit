// Block/reward-ledger regression tests — audit §J5.
//
// Covers the reward + orphan ledger: how a found block is classified against the chain, how a
// status transition claims the block before money moves, and how a failed share read is
// reported. Every case below was a real defect found in §J5, so it gets a test rather than a
// comment. Runs against a throwaway SQLite file in the OS temp dir — never the pool DB.
// Run: node scripts/test-block-ledger.js
const path = require('path');
const fs = require('fs');
const os = require('os');
const Module = require('module');

const APP = path.resolve(__dirname, '..');
const dbFile = path.join(os.tmpdir(), `pool-blockledger-${Date.now()}.sqlite`);

// Stub node-fetch BEFORE lib/grin-node.js is required, so the classification cases below can
// hand it an exact JSON-RPC body without any network.
let RPC_BODY = null;
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) {
  if (req === 'node-fetch') return '__stub_fetch__';
  return origResolve.call(this, req, ...rest);
};
require.cache['__stub_fetch__'] = {
  id: '__stub_fetch__', filename: '__stub_fetch__', loaded: true,
  // RPC_BODY may be a fixed reply object, or a function (method, params) => reply, so a test
  // can answer get_tip and get_header differently within one sweep.
  exports: async (_url, opts) => ({
    ok: true, status: 200, statusText: 'OK',
    json: async () => {
      if (typeof RPC_BODY !== 'function') return RPC_BODY;
      const req = JSON.parse((opts && opts.body) || '{}');
      return RPC_BODY(req.method, req.params || []);
    },
  }),
};

const { initDb, getDb, createSchema, closeDb } = require(path.join(APP, 'lib/db.js'));
initDb(dbFile);
const db = getDb();
createSchema();

const GrinNodeAPI = require(path.join(APP, 'lib/grin-node.js'));
const OrphanDetector = require(path.join(APP, 'lib/orphan-detector.js'));
const BlockManager = require(path.join(APP, 'lib/blocks.js'));
const RewardDistributor = require(path.join(APP, 'lib/rewards.js'));
const { compareBlockToHeader } = require(path.join(APP, 'lib/block-identity.js'));

const config = {
  network: 'testnet',
  pool_fee_percent: 1,
  pool_fee_address: 'pool_fee',
  confirm_depth_testnet: 100,
  node_api_url: 'http://127.0.0.1:13413',
  node_api_secret: 'stub',
  node_foreign_api_secret: 'stub',
  incentives_enabled: 'false',
};

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

const node = new GrinNodeAPI(config);
const detector = new OrphanDetector(config, node);

(async () => {

  // ═══ 1. §J5-2 — only the node's OWN Err about the chain may condemn a block ═══
  console.log('\n[1] grin-node.js — a JSON-RPC envelope error is not a statement about the chain');

  // verifyBlockOnChain RETURNS (rather than throwing) only when it is willing to ORPHAN the
  // block and reverse its payouts. A rethrow means "we do not know" — the caller aborts the
  // sweep and the block stays immature for the next tick.
  const probeBlock = { height: 900, hash: 'aa'.repeat(32), nonce: '123' };
  const orphans = async (body) => {
    RPC_BODY = body;
    try {
      const v = await detector.verifyBlockOnChain(probeBlock);
      return v.onChain === false;
    } catch (e) { return false; }
  };

  ok('CONTROL: the node\'s own NotFound Err DOES orphan the block',
     await orphans({ jsonrpc: '2.0', id: 1, result: { Err: 'NotFound' } }));
  ok('§J5-2 envelope -32601 "Method not found" does NOT orphan',
     (await orphans({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'Method not found' } })) === false);
  ok('§J5-2 envelope -32602 "Invalid params" does NOT orphan',
     (await orphans({ jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'Invalid params' } })) === false);
  ok('a node Err that is not NotFound does NOT orphan',
     (await orphans({ jsonrpc: '2.0', id: 1, result: { Err: { Internal: 'db error' } } })) === false);

  RPC_BODY = { jsonrpc: '2.0', id: 1, result: { Ok: null } };
  ok('§J5-7 a falsy Ok is unwrapped, not returned as the {Ok:…} wrapper',
     (await node.validateChain()) === null);

  // ═══ 2. §J5-1/§J5-3 — a real Grin u64 nonce survives, and the comparator copes ═══
  console.log("\n[2] blocks.nonce — a real Grin u64 round-trips (§J5-1) and compares (§J5-3)");

  const bm = new BlockManager(config);
  db.prepare("INSERT INTO miner_accounts (grin_address, balance) VALUES ('grin1u64', 0)").run();
  // stratum-protocol.js carries the nonce as a decimal STRING precisely so a u64 is not rounded.
  const U64 = '4611686018427387904';                    // 2^62 — an ordinary Grin nonce
  const U64_HASH = 'ee'.repeat(32);
  await bm.creditBlock(4242, U64_HASH, U64, 60, 'grin1u64');

  const row = db.prepare('SELECT * FROM blocks WHERE height = 4242').get();
  ok('§J5-1 a block with a real u64 nonce is readable via SELECT * (this used to throw)',
     row && row.height === 4242, JSON.stringify(row));
  ok('§J5-1 the nonce round-trips EXACTLY, as text', row && row.nonce === U64, `got ${row && row.nonce}`);
  ok('§J5-1 the column is TEXT, so no row can poison the table again',
     db.prepare("SELECT typeof(nonce) AS t FROM blocks WHERE height = 4242").get().t === 'text');

  // §J5-3: the node's copy of that same nonce is ALREADY rounded by JSON.parse. An exact
  // comparison can therefore never succeed — the shared comparator must not treat that as a
  // mismatch, because the orphan path's mismatch branch reverses miner credits.
  const nodeRoundedNonce = JSON.parse(`{"n":${U64}}`).n;
  ok("CONTROL: the node's nonce really is lossy", String(nodeRoundedNonce) !== U64);
  ok('§J5-3 hash-first: the rounded node nonce does not veto a matching hash',
     compareBlockToHeader(row, { hash: U64_HASH, nonce: nodeRoundedNonce }).verdict === 'match');
  ok('§J5-3 nonce fallback normalises both sides through the same rounding',
     compareBlockToHeader({ hash: 'not-hex', nonce: U64 },
                          { hash: 'not-hex', nonce: nodeRoundedNonce }).verdict === 'match');
  ok('§J5-3 a genuinely different block at the height is still a mismatch',
     compareBlockToHeader(row, { hash: 'ab'.repeat(32), nonce: nodeRoundedNonce }).verdict === 'mismatch');
  ok('§J5-3 an uncomparable pair is UNKNOWN, never a mismatch',
     compareBlockToHeader({ hash: 'not-hex', nonce: '' },
                          { hash: 'not-hex', nonce: nodeRoundedNonce }).verdict === 'unknown');

  // An unknown must abort the sweep, not orphan the block.
  RPC_BODY = { jsonrpc: '2.0', id: 1, result: { Ok: { height: 4242, hash: 'not-hex', nonce: 7 } } };
  let unknownThrew = false;
  try { await detector.verifyBlockOnChain({ height: 4242, hash: 'not-hex', nonce: '' }); }
  catch (e) { unknownThrew = true; }
  ok('§J5-3 verifyBlockOnChain THROWS on unknown rather than returning onChain:false', unknownThrew);

  db.prepare('DELETE FROM blocks WHERE height = 4242').run();

  // ═══ 3. §J5-6 — the status flip is the claim; money moves only if it lands ═══
  console.log('\n[3] orphan-detector.js — CAS on the status transition + reversal idempotency');

  db.prepare("INSERT INTO miner_accounts (grin_address, balance) VALUES ('grin1cas', 0)").run();
  db.prepare(`INSERT INTO blocks (height, hash, nonce, reward, status, found_by, found_at)
              VALUES (500, ?, '77', 60, 'immature', 'grin1cas', unixepoch())`).run('ff'.repeat(32));
  const casId = db.prepare('SELECT id FROM blocks WHERE height = 500').get().id;

  ok('confirmBlock claims an immature block once', detector.confirmBlock(casId) === true);
  ok('confirmBlock refuses to re-claim an already-confirmed block', detector.confirmBlock(casId) === false);
  ok('orphanBlock refuses a block that is no longer immature', detector.orphanBlock(casId, 'test') === false);

  // Reversal idempotency: credit the height, then reverse twice.
  db.prepare("UPDATE blocks SET status = 'orphaned' WHERE id = ?").run(casId);
  db.prepare("UPDATE miner_accounts SET balance = 10 WHERE grin_address = 'grin1cas'").run();
  db.prepare(`INSERT INTO balance_log
    (grin_address, event_type, amount, balance_before, balance_after, locked_before, locked_after,
     reference_type, reference_id)
    VALUES ('grin1cas', 'credit', 10, 0, 10, 0, 0, 'block', 500)`).run();

  detector.reverseBlockPayouts(casId);
  const afterFirst = db.prepare("SELECT balance FROM miner_accounts WHERE grin_address='grin1cas'").get().balance;
  ok('first reversal claws back the credited amount', Math.abs(afterFirst - 0) < 1e-9, `got ${afterFirst}`);

  db.prepare("UPDATE miner_accounts SET balance = 10 WHERE grin_address = 'grin1cas'").run();
  detector.reverseBlockPayouts(casId);
  const afterSecond = db.prepare("SELECT balance FROM miner_accounts WHERE grin_address='grin1cas'").get().balance;
  ok('§J5-6 a second reversal for the same height is a no-op', Math.abs(afterSecond - 10) < 1e-9, `got ${afterSecond}`);

  // ═══ 4. §J5-4 — 'paid' is confirmed-and-distributed, not maturing ═══
  console.log('\n[4] blocks.js — pool stats count the terminal paid status');

  db.prepare('DELETE FROM blocks').run();
  db.prepare("INSERT INTO miner_accounts (grin_address, balance) VALUES ('grin1stat', 0)").run();
  const mk = (h, status) => db.prepare(
    `INSERT INTO blocks (height, hash, nonce, reward, status, found_by, found_at)
     VALUES (?, ?, '5', 60, ?, 'grin1stat', unixepoch())`
  ).run(h, String(h).repeat(32).slice(0, 64), status);
  mk(601, 'paid'); mk(602, 'paid'); mk(603, 'confirmed'); mk(604, 'immature'); mk(605, 'orphaned');

  const stats = bm.getPoolStats();
  ok('§J5-4 confirmed_blocks counts paid + confirmed', stats.confirmed_blocks === 3, JSON.stringify(stats));
  ok('§J5-4 confirmed_reward counts paid + confirmed', Math.abs(stats.confirmed_reward - 180) < 1e-9, JSON.stringify(stats));
  ok('§J5-4 immature_blocks excludes paid AND orphaned', stats.immature_blocks === 1, JSON.stringify(stats));
  const hist = bm.getBlocksHistory('month');
  ok('§J5-4 the history doughnut puts paid under confirmed',
     hist.status.confirmed === 3 && hist.status.immature === 1 && hist.status.orphaned === 1,
     JSON.stringify(hist.status));

  // ═══ 5. §J5-5 — a failed share read must not settle the block ═══
  console.log('\n[5] rewards.js — a share-query failure leaves the block retryable');

  db.prepare('DELETE FROM blocks').run();
  const GOOD = 'ab'.repeat(32);
  db.prepare(`INSERT INTO blocks (height, hash, nonce, reward, status, found_by, found_at)
              VALUES (700, ?, '4242', 60, 'confirmed', 'grin1stat', unixepoch())`).run(GOOD);
  const payId = db.prepare('SELECT id FROM blocks WHERE height = 700').get().id;

  const fakeNode = { async getHeader(h) { return { height: h, hash: GOOD, nonce: 4242 }; } };
  const rd = new RewardDistributor(config, fakeNode);

  // Break the share read the way a real fault would (a prepare-time throw).
  db.exec('ALTER TABLE shares RENAME TO shares_hidden');
  const broken = await rd.distributeRewards(payId);
  db.exec('ALTER TABLE shares_hidden RENAME TO shares');

  ok('§J5-5 a share-query failure is reported as a failure, not "no shares"',
     broken.success === false && broken.reason !== 'no_shares_found', JSON.stringify(broken));
  ok('§J5-5 the block stays confirmed and is retried, not settled as paid',
     db.prepare('SELECT status FROM blocks WHERE id=?').get(payId).status === 'confirmed');
  ok('§J5-5 nothing was credited on the failed read',
     db.prepare("SELECT COUNT(*) AS c FROM balance_log WHERE reference_type='block' AND reference_id=700").get().c === 0);

  // CONTROL: a genuinely empty share window still settles the block (that path is unchanged).
  const empty = await rd.distributeRewards(payId);
  ok('CONTROL: a genuinely empty share window still marks the block paid',
     empty.reason === 'no_shares_found' &&
     db.prepare('SELECT status FROM blocks WHERE id=?').get(payId).status === 'paid',
     JSON.stringify(empty));

  // ═══ 6. §J5-11 — the reversal must reach LOCKED balance, and say so ═══
  console.log("\n[6] orphan-detector.js — reversal reaches locked balance and alerts");

  db.prepare("DELETE FROM blocks").run();
  db.prepare("INSERT INTO miner_accounts (grin_address, balance, balance_locked) VALUES ('grin1lock', 1, 9)").run();
  db.prepare(`INSERT INTO blocks (height, hash, nonce, reward, status, found_by, found_at)
              VALUES (800, ?, '11', 60, 'orphaned', 'grin1lock', unixepoch())`).run('cc'.repeat(32));
  const lockId = db.prepare("SELECT id FROM blocks WHERE height = 800").get().id;
  db.prepare(`INSERT INTO balance_log
    (grin_address, event_type, amount, balance_before, balance_after, locked_before, locked_after,
     reference_type, reference_id)
    VALUES ('grin1lock', 'credit', 10, 0, 10, 0, 0, 'block', 800)`).run();

  detector.reverseBlockPayouts(lockId);
  const lockAcct = db.prepare("SELECT balance, balance_locked FROM miner_accounts WHERE grin_address='grin1lock'").get();
  ok("J5-11 the reversal drains spendable first", Math.abs(lockAcct.balance - 0) < 1e-9, JSON.stringify(lockAcct));
  ok("J5-11 and takes the remainder from LOCKED (this used to be silently skipped)",
     Math.abs(lockAcct.balance_locked - 0) < 1e-9, JSON.stringify(lockAcct));
  const revRow = db.prepare("SELECT amount, locked_before, locked_after FROM balance_log WHERE event_type='reversal' AND reference_id=800").get();
  ok("J5-11 the ledger row records the FULL clawback and the real locked snapshots",
     Math.abs(revRow.amount - 10) < 1e-9 && revRow.locked_before === 9 && revRow.locked_after === 0,
     JSON.stringify(revRow));
  ok("J5-11 taking locked funds raises a critical alert",
     db.prepare("SELECT COUNT(*) AS c FROM alerts WHERE type='orphan_clawback_locked' AND level='critical'").get().c === 1);

  // ═══ 7. §J5-8 — a stalled distribution pipeline is detected ═══
  console.log("\n[7] alert-monitor.js — blocks found but never credited");

  const AlertMonitor = require(path.join(APP, "lib/alert-monitor.js"));
  const am = new AlertMonitor({ ...config, network: "testnet", confirm_depth_testnet: 100 },
                              { wallet: null, walletTor: null }, db);

  db.prepare("DELETE FROM alerts").run();
  db.prepare("DELETE FROM blocks").run();
  db.prepare("INSERT OR IGNORE INTO miner_accounts (grin_address, balance) VALUES ('grin1stall', 0)").run();
  db.prepare(`INSERT INTO shares (grin_address, worker_name, difficulty, block_height, share_hash)
              VALUES ('grin1stall','w',1,5000,'stall-share')`).run();

  await am.checkDistributionStalled();
  ok("J5-8 no alert when there is nothing stuck",
     db.prepare("SELECT COUNT(*) AS c FROM alerts WHERE type='distribution_stalled'").get().c === 0);

  // A block 'immature' far past twice the confirm depth = the maturity sweep is not running.
  db.prepare(`INSERT INTO blocks (height, hash, nonce, reward, status, found_by, found_at)
              VALUES (1000, ?, '1', 60, 'immature', 'grin1stall', unixepoch())`).run('11'.repeat(32));
  // A block 'confirmed' but undistributed for an hour = distribution is failing.
  db.prepare(`INSERT INTO blocks (height, hash, nonce, reward, status, found_by, found_at, confirmed_at)
              VALUES (1001, ?, '2', 60, 'confirmed', 'grin1stall', unixepoch(), unixepoch() - 3600)`).run('22'.repeat(32));

  await am.checkDistributionStalled();
  const stall = db.prepare("SELECT level, message, data FROM alerts WHERE type='distribution_stalled'").get();
  ok("J5-8 a stalled pipeline raises a critical alert", stall && stall.level === "critical", JSON.stringify(stall));
  ok("J5-8 the alert names BOTH stall shapes and the uncredited amount",
     stall && /immature/.test(stall.message) && /confirmed/.test(stall.message) && /120 GRIN/.test(stall.message),
     stall && stall.message);
  db.prepare("UPDATE blocks SET status='paid' WHERE height IN (1000,1001)").run();
  await am.checkDistributionStalled();
  ok("J5-8 it resolves once the blocks are settled",
     db.prepare("SELECT status FROM alerts WHERE type='distribution_stalled'").get().status === "resolved");

  // ═══ 8. §J5-1 — the legacy INTEGER->TEXT migration ═══
  console.log("\n[8] db.js — migrating a legacy blocks.nonce INTEGER column");

  // Rebuild the table in its PRE-J5 shape and fill it the way the old code did, then let
  // createSchema() run the real migration over it. The rows are inserted and inspected with
  // SQL only: reading them through JS is exactly what was broken.
  db.exec("DROP TABLE blocks");
  db.exec(`CREATE TABLE blocks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    height INTEGER NOT NULL,
    hash TEXT NOT NULL UNIQUE,
    nonce INTEGER NOT NULL,
    reward REAL NOT NULL,
    status TEXT NOT NULL DEFAULT 'immature',
    found_by TEXT NOT NULL REFERENCES miner_accounts(grin_address),
    found_at INTEGER NOT NULL,
    confirmed_at INTEGER DEFAULT NULL,
    network_difficulty REAL DEFAULT NULL,
    round_shares REAL DEFAULT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`);
  const legacyIns = db.prepare(
    "INSERT INTO blocks (height, hash, nonce, reward, found_by, found_at) VALUES (?, ?, ?, 60, 'grin1stall', unixepoch())"
  );
  legacyIns.run(9001, '91'.repeat(32), '12345');                 // small -> INTEGER, exact
  legacyIns.run(9002, '92'.repeat(32), '4611686018427387904');   // 2^62  -> INTEGER, the poison row
  legacyIns.run(9003, '93'.repeat(32), '18446744073709551615');  // 2^64-1 -> REAL, already destroyed

  let preThrew = false;
  try { db.prepare("SELECT * FROM blocks").all(); } catch (e) { preThrew = e.code === 'ERR_OUT_OF_RANGE'; }
  ok("CONTROL: the legacy table really does throw before migrating", preThrew);

  createSchema();   // idempotent; runs migrateBlocks -> migrateBlocksNonceToText

  ok("J5-1 the migrated column is TEXT",
     db.prepare("PRAGMA table_info(blocks)").all().find(c => c.name === 'nonce').type === 'TEXT');
  const migrated = db.prepare("SELECT height, nonce, hash, reward, status FROM blocks WHERE height >= 9001 ORDER BY height").all();
  ok("J5-1 every legacy row survives and is now readable", migrated.length === 3, JSON.stringify(migrated));
  ok("J5-1 a small nonce migrates exactly", migrated[0].nonce === '12345', migrated[0].nonce);
  ok("J5-1 the poison row's nonce migrates EXACTLY (it was never lost, only unreadable)",
     migrated[1].nonce === '4611686018427387904', migrated[1].nonce);
  ok("J5-1 a nonce destroyed by REAL storage becomes blank, not a wrong number",
     migrated[2].nonce === '', JSON.stringify(migrated[2].nonce));
  ok("J5-1 a blank nonce is UNKNOWN to the comparator, never a mismatch",
     compareBlockToHeader({ hash: 'not-hex', nonce: '' }, { hash: 'not-hex', nonce: 5 }).verdict === 'unknown');
  ok("J5-1 that row still verifies by HASH, which survived intact",
     compareBlockToHeader(migrated[2], { hash: '93'.repeat(32), nonce: 5 }).verdict === 'match');
  ok("J5-1 the indexes are rebuilt with the table",
     db.prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE type='index' AND tbl_name='blocks' AND name LIKE 'idx_block_%'").get().c === 3);
  ok("J5-1 foreign keys are back ON after the rebuild",
     db.pragma('foreign_keys', { simple: true }) === 1);
  ok("J5-1 re-running the migration is a no-op",
     (createSchema(),
      db.prepare("SELECT COUNT(*) AS c FROM blocks WHERE height >= 9001").get().c === 3));

  // ═══ 9. §J5-3 self-review — one unverifiable block must not stall every other block ═══
  console.log("\n[9] orphan-detector.js — an unverifiable row skips, it does not abort the sweep");

  db.prepare("DELETE FROM blocks").run();
  db.prepare("DELETE FROM alerts").run();
  const OK_HASH = 'dd'.repeat(32);
  // A legacy row the pre-J5 column destroyed: hash not 64-hex AND nonce blank => unverifiable.
  db.prepare(`INSERT INTO blocks (height, hash, nonce, reward, status, found_by, found_at)
              VALUES (2000, 'legacy-not-a-hash', '', 60, 'immature', 'grin1stall', unixepoch())`).run();
  // A perfectly ordinary block sitting right behind it.
  db.prepare(`INSERT INTO blocks (height, hash, nonce, reward, status, found_by, found_at)
              VALUES (2001, ?, '4611686018427387904', 60, 'immature', 'grin1stall', unixepoch())`).run(OK_HASH);

  RPC_BODY = (method, params) => {
    if (method === 'get_tip') return { jsonrpc: '2.0', id: 1, result: { Ok: { height: 9000, hash: OK_HASH } } };
    const h = params[0];
    if (h === 2001) return { jsonrpc: '2.0', id: 1, result: { Ok: { height: h, hash: OK_HASH, nonce: 4611686018427387904 } } };
    return { jsonrpc: '2.0', id: 1, result: { Ok: { height: h, hash: 'also-not-a-hash', nonce: 0 } } };
  };

  const sweep = await detector.detectOrphans();
  ok("J5-3 the sweep completes instead of aborting", sweep.aborted !== true, JSON.stringify(sweep));
  ok("J5-3 the unverifiable row is counted and skipped, not orphaned",
     sweep.unverifiable === 1 && sweep.orphaned === 0, JSON.stringify(sweep));
  ok("J5-3 it is left immature for a later tick, with its credits untouched",
     db.prepare("SELECT status FROM blocks WHERE height = 2000").get().status === 'immature');
  ok("J5-3 the healthy block behind it is still confirmed",
     sweep.confirmed === 1 &&
     db.prepare("SELECT status FROM blocks WHERE height = 2001").get().status === 'confirmed',
     JSON.stringify(sweep));

  // CONTROL: a node-level failure must still abort the whole sweep.
  db.prepare("UPDATE blocks SET status = 'immature' WHERE height = 2001").run();
  RPC_BODY = (method) => (method === 'get_tip'
    ? { jsonrpc: '2.0', id: 1, result: { Ok: { height: 9000, hash: OK_HASH } } }
    : { jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'Invalid params' } });
  const aborted = await detector.detectOrphans();
  ok("CONTROL: a node-level failure still aborts the sweep", aborted.aborted === true, JSON.stringify(aborted));
  ok("CONTROL: and orphans nothing on the way out",
     aborted.orphaned === 0 &&
     db.prepare("SELECT COUNT(*) AS c FROM blocks WHERE status='orphaned'").get().c === 0);

  console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
  cleanup();
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error(e); cleanup(); process.exit(1); });
