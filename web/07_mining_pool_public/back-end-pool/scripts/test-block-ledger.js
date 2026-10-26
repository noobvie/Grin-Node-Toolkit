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
  ok('orphans_24h counts only orphans found in the last 24h', stats.orphans_24h === 1, JSON.stringify(stats));
  db.prepare("UPDATE blocks SET found_at = unixepoch() - 90000 WHERE height = 605").run();
  ok('orphans_24h drops an orphan found >24h ago', bm.getPoolStats().orphans_24h === 0);
  db.prepare("UPDATE blocks SET found_at = unixepoch() WHERE height = 605").run();
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
  ok("J5-1 the rebuild keeps fee_percent (migrateBlocks adds it before the copy)",
     db.prepare("PRAGMA table_info(blocks)").all().some(c => c.name === 'fee_percent'));
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

  // ═══ 10. blocks.html — expected blocks (P-02) + UTC weekday×hour heatmap ═══
  console.log('\n[10] getBlocksHistory — expected blocks per period and the UTC hour grid');

  // Earlier sections' blocks carry reward/ledger rows (FK), so move them out of the window
  // rather than deleting them.
  db.prepare('UPDATE blocks SET found_at = found_at - 400 * 86400').run();
  db.prepare('DELETE FROM pool_metrics_hourly').run();
  const DAY = 86400, HR = 3600;
  const D = Math.floor((Math.floor(Date.now() / 1000) - 5 * DAY) / DAY) * DAY; // a whole UTC day, in the month window
  const putHour = db.prepare('INSERT INTO pool_metrics_hourly (bucket_start, pool_hashrate_gps, network_hashrate_gps) VALUES (?, ?, ?)');
  for (let h = 0; h < 24; h++) {
    putHour.run(D + h * HR, 10, h === 3 ? null : 1000); // share 1% → 0.6 blocks/hour; hour 3 has no sample
    putHour.run(D - DAY + h * HR, 10, null);            // a day with NO network sample at all
    putHour.run(D - 2 * DAY + h * HR, 0, 1000);         // a day the pool had no hashrate
    putHour.run(D - 3 * DAY + h * HR, 0, null);         // an outage: catch-up rows, no hashrate, no sample
    putHour.run(D - 4 * DAY + h * HR, h < 12 ? 10 : 0, null); // no sample; mining, then down
  }
  putHour.run(D - 40 * DAY, 10, 1000);                   // outside the month window
  db.prepare("INSERT INTO miner_accounts (grin_address, balance) VALUES ('grin1heat', 0)").run();
  const putBlock = db.prepare(`INSERT INTO blocks (height, hash, nonce, reward, status, found_by, found_at)
                               VALUES (?, ?, '1', 60, ?, 'grin1heat', ?)`);
  putBlock.run(1001, 'c1'.repeat(32), 'confirmed', D + 14 * HR + 60);
  putBlock.run(1002, 'c2'.repeat(32), 'orphaned',  D + 14 * HR + 900);
  putBlock.run(1003, 'c3'.repeat(32), 'immature',  D + 3 * HR + 5);

  const hh = bm.getBlocksHistory('month');
  const at = (t) => hh.points.find(p => p.t === t);
  const wd = new Date(D * 1000).getUTCDay();
  ok('expected sums share × 60 per hour, a missing sample borrowing the bucket mean',
     at(D) && at(D).blocks === 3 && Math.abs(at(D).expected - 14.4) < 1e-9, JSON.stringify(at(D)));
  ok('a bucket with no network sample of its own reports expected null, not 0',
     at(D - DAY) && at(D - DAY).blocks === 0 && at(D - DAY).expected === null, JSON.stringify(at(D - DAY)));
  ok('a covered bucket with no finds is still a point (a zero column)',
     at(D - 2 * DAY) && at(D - 2 * DAY).blocks === 0 && at(D - 2 * DAY).expected === 0, JSON.stringify(at(D - 2 * DAY)));
  ok('a no-sample bucket in which the pool had NO hashrate expects 0, not null',
     at(D - 3 * DAY) && at(D - 3 * DAY).expected === 0, JSON.stringify(at(D - 3 * DAY)));
  ok('one unknown hour keeps its bucket null, even when zero-hashrate hours follow it',
     at(D - 4 * DAY) && at(D - 4 * DAY).expected === null, JSON.stringify(at(D - 4 * DAY)));
  ok('rollup rows before the window are ignored', !at(Math.floor((D - 40 * DAY) / DAY) * DAY));
  ok('points stay oldest → newest', hh.points.every((p, i, a) => i === 0 || a[i - 1].t < p.t));
  ok('hour grid counts every status by UTC weekday × hour',
     hh.hours.found[wd][14] === 2 && hh.hours.found[wd][3] === 1 &&
     hh.hours.found.flat().reduce((a, b) => a + b, 0) === 3, JSON.stringify(hh.hours.found[wd]));
  ok('hour grid expected uses the same borrowing, and skips sample-less buckets',
     Math.abs(hh.hours.expected[wd][3] - 0.6) < 1e-9 && hh.hours.expected_hours === 48 + 24 + 12, // zero-hashrate hours are known (0)
     JSON.stringify({ e3: hh.hours.expected[wd][3], n: hh.hours.expected_hours }));
  db.prepare('DELETE FROM pool_metrics_hourly').run();
  const bare = bm.getBlocksHistory('month');
  ok('no rollup rows: expected is null everywhere, found blocks still bucketed',
     bare.hours.expected === null && bare.points.length === 1 && bare.points[0].blocks === 3 &&
     bare.points[0].expected === null,
     JSON.stringify(bare.points));

  // ═══ 11. blocks.html P-04 — time between blocks, and the placard's 24h / 7d rewards ═══
  console.log('\n[11] getBlocksHistory — time between consecutive blocks');

  // Every earlier block moves far back, so the newest of them is the predecessor of the first
  // block below — a predecessor from before the window, which is the case that needs a query.
  db.prepare('UPDATE blocks SET found_at = found_at - 800 * 86400').run();
  const oldNewest = db.prepare('SELECT MAX(found_at) AS t FROM blocks').get().t;
  const D2 = Math.floor((Math.floor(Date.now() / 1000) - 3 * DAY) / DAY) * DAY;
  // Share 1% (0.6 blocks/h → a 6000 s mean gap) except hours 5–6 at 2% (3000 s). Hour 2 has
  // no network sample and borrows the day's; its pool GPS is 30, so borrowing it and skipping
  // it give different answers. Nothing after hour 8 is rolled up.
  for (let h = -2; h <= 8; h++) {
    putHour.run(D2 + h * HR, (h === 5 || h === 6) ? 20 : (h === 2 ? 30 : 10), h === 2 ? null : 1000);
  }
  putBlock.run(2001, 'd1'.repeat(32), 'confirmed', D2);
  putBlock.run(2002, 'd2'.repeat(32), 'confirmed', D2 + 1800);
  putBlock.run(2003, 'd3'.repeat(32), 'orphaned',  D2 + 1800);          // same second as 2002
  putBlock.run(2004, 'd4'.repeat(32), 'confirmed', D2 + 5 * HR);
  putBlock.run(2005, 'd5'.repeat(32), 'confirmed', D2 + 6 * HR);
  putBlock.run(2006, 'd6'.repeat(32), 'immature',  D2 + 7.5 * HR);
  putBlock.run(2007, 'd7'.repeat(32), 'immature',  D2 + 30 * HR);

  const gh = bm.getBlocksHistory('month');
  const iv = gh.intervals;
  const byH = (h) => iv.find(x => x.height === h) || {};
  ok('one interval per block in the window, oldest → newest',
     iv.length === 7 && iv.map(x => x.height).join() === '2001,2002,2003,2004,2005,2006,2007' &&
     gh.intervals_truncated === false, JSON.stringify(iv));
  ok('the first block in the window measures from a predecessor before the window',
     byH(2001).gap === D2 - oldNewest && byH(2001).expected === null, JSON.stringify(byH(2001)));
  ok('gap and expected at a steady 1% share (6000 s)',
     byH(2002).gap === 1800 && byH(2002).expected === 6000, JSON.stringify(byH(2002)));
  ok('two blocks in the same second: gap 0, expected null (orphans count as found)',
     byH(2003).gap === 0 && byH(2003).expected === null, JSON.stringify(byH(2003)));
  ok('an orphaned block keeps its place and is flagged; the others are not',
     byH(2003).orphaned === true && iv.filter(x => x.orphaned).length === 1, JSON.stringify(iv.map(x => x.orphaned)));
  // 0.5 h × 0.6 + 0.6 + 1.8 (hour 2: 30 ÷ the day's 1000 × 60) + 0.6 + 0.6 = 3.9 blocks in 16200 s.
  ok('a sample-less hour borrows the day mean, a partial first hour is weighted by overlap',
     byH(2004).gap === 5 * HR - 1800 && byH(2004).expected === Math.round(16200 / 3.9), JSON.stringify(byH(2004)));
  ok('a doubled share halves the expected gap',
     byH(2005).expected === 3000, JSON.stringify(byH(2005)));
  ok('a stretch over two shares weights each hour by its overlap (1.5 blocks in 5400 s)',
     byH(2006).gap === 1.5 * HR && byH(2006).expected === 3600, JSON.stringify(byH(2006)));
  ok('under half of the stretch rolled up: expected null, never a guess',
     byH(2007).gap === 22.5 * HR && byH(2007).expected === null, JSON.stringify(byH(2007)));

  const ga = bm.getBlocksHistory('all');
  const total = db.prepare('SELECT COUNT(*) AS c FROM blocks').get().c;
  ok("'all' starts at the pool's first block, which has no gap",
     ga.intervals.length === total - 1, `${ga.intervals.length} vs ${total - 1}`);
  ok('a block\'s expected gap does not change with the timeframe',
     [2002, 2004, 2005, 2006].every(h => (ga.intervals.find(x => x.height === h) || {}).expected === byH(h).expected));

  const savedCap = BlockManager.INTERVAL_CAP;
  BlockManager.INTERVAL_CAP = 3;
  const gc = bm.getBlocksHistory('month');
  BlockManager.INTERVAL_CAP = savedCap;
  ok('the cap keeps the NEWEST intervals and says it truncated',
     gc.intervals_truncated === true && gc.intervals.map(x => x.height).join() === '2005,2006,2007' &&
     gc.intervals[0].gap === HR, JSON.stringify(gc.intervals));

  // Placard sub-lines: reward_24h / reward_7d use blocks_24h / blocks_7d's predicate exactly.
  db.prepare('UPDATE blocks SET created_at = unixepoch() - 3 * 86400 WHERE height = 2002').run();
  db.prepare('UPDATE blocks SET reward = 60.25 WHERE height = 2004').run();
  const ps = bm.getPoolStats();
  const sumWhere = (secs) => db.prepare(
    "SELECT COALESCE(SUM(reward), 0) AS r FROM blocks WHERE status != 'orphaned' AND created_at > unixepoch() - ?"
  ).get(secs).r;
  ok('reward_24h / reward_7d sum the non-orphaned blocks behind blocks_24h / blocks_7d',
     Math.abs(ps.reward_24h - sumWhere(86400)) < 1e-9 && Math.abs(ps.reward_7d - sumWhere(7 * 86400)) < 1e-9 &&
     Math.abs(ps.reward_7d - ps.reward_24h - 60) < 1e-9 && ps.blocks_7d - ps.blocks_24h === 1,
     JSON.stringify({ r24: ps.reward_24h, r7: ps.reward_7d, b24: ps.blocks_24h, b7: ps.blocks_7d }));

  // ═══ 12. P-04 — outages, unknown days, window start; the history cache ═══
  console.log('\n[12] getBlocksHistory — outages, unknown days, window start, cache');

  db.prepare('UPDATE blocks SET found_at = found_at - 800 * 86400').run();
  db.prepare('DELETE FROM pool_metrics_hourly').run();
  const D3 = Math.floor((Math.floor(Date.now() / 1000) - 6 * DAY) / DAY) * DAY;
  for (let h = 0; h < 24; h++) {
    putHour.run(D3 + h * HR, 10, 1000);                           // day 0: 1% share
    putHour.run(D3 + DAY + h * HR, 0, null);                      // day 1: down all day (catch-up rows)
    putHour.run(D3 + 2 * DAY + h * HR, 10, 1000);                 // day 2: back
    putHour.run(D3 + 3 * DAY + h * HR, 10, null);                 // day 3: mining, no sample anywhere
    putHour.run(D3 + 4 * DAY + h * HR, 10, h < 12 ? 1000 : null); // day 4: samples only before noon
  }
  putBlock.run(3001, 'e1'.repeat(32), 'confirmed', D3);
  putBlock.run(3002, 'e2'.repeat(32), 'confirmed', D3 + 2 * DAY + 6 * HR);
  putBlock.run(3003, 'e3'.repeat(32), 'confirmed', D3 + 3 * DAY + 12 * HR);
  putBlock.run(3004, 'e4'.repeat(32), 'confirmed', D3 + 4 * DAY + 14 * HR);
  putBlock.run(3005, 'e5'.repeat(32), 'immature',  D3 + 4 * DAY + 20 * HR);

  const oh = bm.getBlocksHistory('month').intervals;
  const byO = (h, list) => (list || oh).find(x => x.height === h) || {};
  // 54 h: 24 h × 0.6 + 24 h down + 6 h × 0.6 = 18 blocks → 10800 s. Dropping the down day as
  // "unknown" would give 30 h ÷ 18 = 6000 s and read the outage as bad luck.
  ok('a whole UTC day of downtime (zero hashrate, no sample) counts as zero rate, not unknown',
     byO(3002).gap === 54 * HR && byO(3002).expected === 10800, JSON.stringify(byO(3002)));
  // 30 h: 18 h known at 0.6, 12 h on a day with no sample → 18 h × 3600 ÷ 10.8 = 6000 s.
  ok('hours on a day with no sample are left out of the stretch, not counted as covered',
     byO(3003).gap === 30 * HR && byO(3003).expected === 6000, JSON.stringify(byO(3003)));
  ok("an afternoon with no sample borrows its day's morning samples",
     byO(3005).expected === 6000, JSON.stringify(byO(3005)));
  // A window starting between 3004 and 3005 makes 3004 the predecessor (rows[0]); the rollup
  // read must still start at the top of its DAY, or the afternoon has nothing to borrow.
  const late = bm._blockIntervals(D3 + 4 * DAY + 15 * HR).intervals;
  ok("a block's expected gap does not depend on where the window starts",
     byO(3005, late).expected === byO(3005).expected && late.length === 1, JSON.stringify(late));

  const realIv = bm._blockIntervals;
  bm._blockIntervals = () => { throw new Error('boom'); };
  const bad = bm.getBlocksHistory('month');
  bm._blockIntervals = realIv;
  ok('a failure in the interval code blanks P-04 only, not the other charts',
     bad.intervals.length === 0 && bad.intervals_truncated === false && bad.points.length > 0 &&
     bad.bucket_seconds === DAY, JSON.stringify({ n: bad.intervals.length, p: bad.points.length }));

  const c1 = bm.getBlocksHistoryCached('month');
  putBlock.run(3006, 'e6'.repeat(32), 'immature', D3 + 5 * DAY);
  const c2 = bm.getBlocksHistoryCached('month');
  ok('the public history is reused within the TTL, per range',
     c2 === c1 && bm.getBlocksHistoryCached('week') !== c1 && !c2.intervals.some(x => x.height === 3006));
  const savedTtl = BlockManager.HISTORY_TTL_MS;
  BlockManager.HISTORY_TTL_MS = 0;
  const c3 = bm.getBlocksHistoryCached('month');
  BlockManager.HISTORY_TTL_MS = savedTtl;
  ok('an expired entry is recomputed', c3 !== c1 && c3.intervals.some(x => x.height === 3006));
  await bm.creditBlock(3007, 'e7'.repeat(32), '7', 60, 'grin1heat');
  const c4 = bm.getBlocksHistoryCached('month');
  ok('crediting a block clears the cache at once',
     c4 !== c3 && c4.intervals.some(x => x.height === 3007), JSON.stringify(c4.intervals.map(x => x.height)));

  // ═══ 11. The fee a block is split at is the rate when it was FOUND ═══
  console.log("\n[11] blocks.js + rewards.js — a fee change never re-prices a found block");

  db.prepare("DELETE FROM blocks").run();
  db.prepare("INSERT OR IGNORE INTO miner_accounts (grin_address, balance) VALUES ('grin1fee', 0)").run();
  const savedFee = config.pool_fee_percent;
  const feeHashes = new Map();
  const feeNode = { async getHeader(h) { return { height: h, hash: feeHashes.get(h), nonce: 1 }; } };
  const feeRd = new RewardDistributor(config, feeNode);
  const shareAt = (h) => db.prepare(`INSERT INTO shares (grin_address, worker_name, difficulty, block_height, share_hash)
                                     VALUES ('grin1fee', 'rig', 1, ?, ?)`).run(h, 'fs' + h);
  const feeCredit = (h) => db.prepare(
    "SELECT COALESCE(SUM(amount), 0) AS s FROM balance_log WHERE reference_type = 'pool_fee' AND reference_id = ?"
  ).get(h).s;
  const minerCredit = (h) => db.prepare(
    "SELECT COALESCE(SUM(amount), 0) AS s FROM balance_log WHERE grin_address = 'grin1fee' AND reference_type = 'block' AND reference_id = ?"
  ).get(h).s;
  const feeOf = (h) => db.prepare('SELECT fee_percent FROM blocks WHERE height = ?').get(h).fee_percent;
  const mature = async (h) => {
    db.prepare("UPDATE blocks SET status = 'confirmed' WHERE height = ?").run(h);
    return feeRd.distributeRewards(db.prepare('SELECT id FROM blocks WHERE height = ?').get(h).id);
  };

  config.pool_fee_percent = 0;
  feeHashes.set(4100, 'f1'.repeat(32));
  await bm.creditBlock(4100, feeHashes.get(4100), '1', 60, 'grin1fee');
  ok('a block found during a 0% promotion records fee_percent 0', feeOf(4100) === 0, String(feeOf(4100)));

  config.pool_fee_percent = 1;
  feeHashes.set(4200, 'f2'.repeat(32));
  await bm.creditBlock(4200, feeHashes.get(4200), '2', 60, 'grin1fee');
  ok('a block found at 1% records fee_percent 1', feeOf(4200) === 1, String(feeOf(4200)));

  // A fee saved while creditBlock awaits the node (up to 10 s on a slow one) must not land on
  // the block: the rate is taken before those fetches, or passed in from the submit.
  const slowBm = new BlockManager(config);
  slowBm._fetchNetworkDifficulty = async () => { config.pool_fee_percent = 0; return null; };
  config.pool_fee_percent = 1;
  await slowBm.creditBlock(4250, 'f5'.repeat(32), '5', 60, 'grin1fee');
  ok('a fee saved during the node fetches does not re-price the block being credited',
     feeOf(4250) === 1, String(feeOf(4250)));
  config.pool_fee_percent = 1;
  await slowBm.creditBlock(4260, 'f6'.repeat(32), '6', 60, 'grin1fee', 0);
  ok('the rate snapshotted at submit wins over the live rate at credit time',
     feeOf(4260) === 0, String(feeOf(4260)));
  await slowBm.creditBlock(4270, 'f7'.repeat(32), '7', 60, 'grin1fee', null);
  ok('a missing rate is stored NULL ("not on record"), never as a 0% block',
     feeOf(4270) === null, String(feeOf(4270)));
  config.pool_fee_percent = 1;
  db.prepare('DELETE FROM blocks WHERE height IN (4250, 4260, 4270)').run();

  // The promotion ended (fee back to 1%) while 4100 was still maturing.
  shareAt(4100);
  const r4100 = await mature(4100);
  ok('a 0% block that matures after the fee went back to 1% is still split at 0%',
     r4100.success === true && r4100.fee_percent === 0 && feeCredit(4100) === 0 &&
     Math.abs(minerCredit(4100) - 60) < 1e-9, JSON.stringify({ r4100, fee: feeCredit(4100), miner: minerCredit(4100) }));

  // And the other way: a 1% block that matures after the fee dropped to 0% keeps its 1%.
  config.pool_fee_percent = 0;
  shareAt(4200);
  const r4200 = await mature(4200);
  ok('a 1% block that matures after the fee dropped to 0% is still split at 1%',
     r4200.success === true && Math.abs(feeCredit(4200) - 0.6) < 1e-9 &&
     Math.abs(minerCredit(4200) - 59.4) < 1e-9, JSON.stringify({ fee: feeCredit(4200), miner: minerCredit(4200) }));

  // A row from before the column: the live rate, and that rate is written onto the row.
  config.pool_fee_percent = 2;
  feeHashes.set(4300, 'f3'.repeat(32));
  db.prepare(`INSERT INTO blocks (height, hash, nonce, reward, status, found_by, found_at)
              VALUES (4300, ?, '3', 60, 'immature', 'grin1fee', unixepoch())`).run(feeHashes.get(4300));
  shareAt(4300);
  await mature(4300);
  ok('a legacy block with no recorded rate is split at the live rate, and the rate is recorded',
     Math.abs(feeCredit(4300) - 1.2) < 1e-9 && feeOf(4300) === 2,
     JSON.stringify({ fee: feeCredit(4300), pct: feeOf(4300) }));
  config.pool_fee_percent = savedFee;

  // The one-time backfill when the column is first added: a settled block's rate is recovered
  // from its booked pool-fee credit; anything it cannot prove stays NULL.
  db.prepare("UPDATE blocks SET fee_percent = NULL").run();
  db.prepare(`INSERT INTO blocks (height, hash, nonce, reward, status, found_by, found_at)
              VALUES (4400, ?, '4', 60, 'immature', 'grin1fee', unixepoch())`).run('f4'.repeat(32));
  db.exec('ALTER TABLE blocks DROP COLUMN fee_percent');
  createSchema();
  ok('backfill: a paid 1% block gets 1 back from its pool-fee credit', feeOf(4200) === 1, String(feeOf(4200)));
  ok('backfill: a paid 2% block gets 2 back from its pool-fee credit', feeOf(4300) === 2, String(feeOf(4300)));
  ok('backfill: a paid block with no pool-fee credit stays NULL (0% and "not recorded" look the same)',
     feeOf(4100) === null, String(feeOf(4100)));
  ok('backfill: an unsettled block stays NULL', feeOf(4400) === null, String(feeOf(4400)));

  // The next boot records the boot rate on that unsettled legacy block, so a fee saved live
  // afterwards (a 0% promotion switched on right after the deploy) cannot re-price it.
  config.pool_fee_percent = 1;
  new BlockManager(config);
  ok('boot: an unsettled legacy block records the rate the process booted with', feeOf(4400) === 1, String(feeOf(4400)));
  ok('boot: a settled block with no recovered rate is not stamped', feeOf(4100) === null, String(feeOf(4100)));
  config.pool_fee_percent = 0;
  shareAt(4400);
  feeHashes.set(4400, 'f4'.repeat(32));
  await mature(4400);
  ok('boot: that block is split at its recorded 1% after the fee is saved as 0',
     Math.abs(feeCredit(4400) - 0.6) < 1e-9, String(feeCredit(4400)));
  config.pool_fee_percent = savedFee;

  console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
  cleanup();
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error(e); cleanup(); process.exit(1); });
