'use strict';

// One solved share earns one credit, whoever sends it and however often, a bad nonce never reaches
// the node, and a block the node accepts is always recorded (audit §J6-1).
//
// Drives the real parser, StratumServer.handleSubmit, ShareValidator and the node client's
// serialiser on an in-memory DB. fakeNode follows grin's handle_submit where that decides the
// result: it keeps no record of shares, and a job id means the newest job holding it. Every line it
// is sent is parsed as JSON first, because a line the node cannot parse ends the connection.
// Run: node scripts/test-share-dedup.js

const { initDb, getDb, createSchema, closeDb } = require('../lib/db');
const StratumServer = require('../lib/stratum-server');
const NodeStratumClient = require('../lib/node-stratum-client');
const { parseStratumMessage } = require('../lib/stratum-protocol');

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name} ${extra}`); }
};

const ALICE = 'grin1alice';
const MALLORY = 'grin1mallory';
const POW = Array.from({ length: 42 }, (_, i) => i + 1);
const POW2 = Array.from({ length: 42 }, (_, i) => i + 2);

function minerManager() {
  const sessions = new Map([
    ['alice', { sessionId: 'alice', grinAddress: ALICE, workerName: 'rig', ip: '10.0.0.1', region: 'default' }],
    ['alice2', { sessionId: 'alice2', grinAddress: ALICE, workerName: 'other', ip: '10.0.0.1', region: 'default' }],
    ['mallory', { sessionId: 'mallory', grinAddress: MALLORY, workerName: 'rig', ip: '10.0.0.2', region: 'default' }],
  ]);
  return {
    getSession: (id) => sessions.get(id),
    recordShare() {}, recordMinerCountry() {}, recordOwnerEvidence() {},
  };
}

(async () => {
  initDb(':memory:');
  const db = getDb();
  createSchema();
  for (const a of [ALICE, MALLORY]) {
    db.prepare('INSERT INTO miner_accounts (grin_address, balance) VALUES (?, 0)').run(a);
  }

  const log = console.log;
  const server = new StratumServer({ network: 'testnet', stratum_port: 0, region: 'default' }, minerManager());

  const wire = new NodeStratumClient({}, server);
  const fakeNode = {
    sent: 0,
    badLines: 0,
    blockHash: null,
    async forwardSubmit(params) {
      fakeNode.sent++;
      try { JSON.parse(wire._serialize({ id: 1, method: 'submit', params })); } catch (_) { fakeNode.badLines++; }
      return { accepted: true, blockHash: fakeNode.blockHash, error: null };
    },
  };
  server.setNodeStratumClient(fakeNode);
  const credited = [];
  server.setBlockManager({ creditBlock: async (...a) => { credited.push(a); return { success: true }; } });

  // Resolves with the pool's reply; the submit path answers asynchronously. `raw` is the nonce
  // exactly as it appears in the miner's JSON, so it runs through the real parser.
  const send = (sessionId, { job, height, raw, pow = POW }) => new Promise((resolve) => {
    const socket = { write: (line) => resolve(JSON.parse(line)), destroy() {}, end() {} };
    const line = `{"id":1,"method":"submit","params":{"edge_bits":32,"height":${height},"job_id":${job},"nonce":${raw},"pow":${JSON.stringify(pow)}}}`;
    console.log = () => {};
    server.handleSubmit(socket, parseStratumMessage(line), sessionId);
  }).finally(() => { console.log = log; });
  const accepted = (reply) => !reply.error;
  const credits = (address) => db.prepare('SELECT COUNT(*) c FROM shares WHERE grin_address = ?').get(address).c;
  const newJob = (height, pre, nodeId) => {
    console.log = () => {};
    server.setNewJob({ height, difficulty: 1, pre_pow: pre.repeat(16), node_job_id: nodeId });
    console.log = log;
    return server.jobCounter;
  };

  let job = newJob(100, 'aa', 7);
  const here = (raw, pow) => ({ job, height: 100, raw, pow });

  console.log('[1] the same solved share');
  ok('the first submit is credited', accepted(await send('alice', here('1000'))) && credits(ALICE) === 1);
  ok('the same address cannot send it twice', !accepted(await send('alice', here('1000'))) && credits(ALICE) === 1);
  ok('another worker on that address cannot send it', !accepted(await send('alice2', here('1000'))) && credits(ALICE) === 1);
  ok('another address cannot send it', !accepted(await send('mallory', here('1000'))) && credits(MALLORY) === 0);
  ok('quoting the nonce does not make it a new share', !accepted(await send('mallory', here('"1000"'))) && credits(MALLORY) === 0);

  console.log('[2] a nonce the node cannot read stops at the pool');
  for (const raw of ['"0123"', '"00"', `"${'9'.repeat(400)}"`, '9'.repeat(400), '"18446744073709551616"', '-1', '"1e3"', '[1]', '""', 'null']) {
    const before = fakeNode.sent;
    const reply = await send('mallory', here(raw));
    ok(`${raw.slice(0, 24)} is refused and never forwarded`, !accepted(reply) && fakeNode.sent === before, JSON.stringify(reply));
  }
  ok('the largest u64 is accepted with its exact digits', accepted(await send('mallory', here('18446744073709551615'))) && credits(MALLORY) === 1);
  ok('its neighbour is a different share, so no rounding happened', accepted(await send('mallory', here('18446744073709551614'))) && credits(MALLORY) === 2);
  ok('every line sent to the node was valid JSON', fakeNode.badLines === 0, String(fakeNode.badLines));

  console.log('[3] replaying a share through another job');
  let reissue = newJob(100, 'aa', 8);
  ok('a re-issued template does not reopen the share',
     !accepted(await send('mallory', { job: reissue, height: 100, raw: '1000' })) && credits(MALLORY) === 2);

  const oldJob = newJob(100, 'cc', 5);
  const tip = newJob(101, 'dd', 0);
  const held = credits(ALICE);
  ok('the share is credited on the tip job', accepted(await send('alice', { job: tip, height: 101, raw: '5000' })) && credits(ALICE) === held + 1);
  const replay = await send('mallory', { job: oldJob, height: 101, raw: '5000' });
  ok('an older height\'s job id cannot carry it', !accepted(replay) && credits(MALLORY) === 2, JSON.stringify(replay));
  const nodeCalls = fakeNode.sent;
  await send('mallory', { job: oldJob, height: 101, raw: '5001' });
  ok('and that submit never reaches the node', fakeNode.sent === nodeCalls);

  // A reorg brings one height back with new work, and the node restarts its job ids.
  const before = newJob(102, 'e1', 0);
  const after = newJob(102, 'e2', 0);
  ok('a reorg retires the job whose id was reused', accepted(await send('alice', { job: after, height: 102, raw: '6000' }))
     && !accepted(await send('mallory', { job: before, height: 102, raw: '6000' })) && credits(MALLORY) === 2);

  console.log('[4] real work is still credited');
  job = newJob(103, 'ff', 1);
  const at103 = (raw, pow) => ({ job, height: 103, raw, pow });
  ok('a different nonce is a new share', accepted(await send('mallory', at103('2000'))) && credits(MALLORY) === 3);
  ok('a second cycle in one graph is a new share', accepted(await send('mallory', at103('2000', POW2))) && credits(MALLORY) === 4);
  job = newJob(103, 'f0', 2);
  ok('a new template with the same nonce is a new share', accepted(await send('mallory', at103('2000'))) && credits(MALLORY) === 5);
  ok('a nonce of zero is a real nonce', accepted(await send('mallory', at103('0'))) && credits(MALLORY) === 6);

  console.log('[5] a block is recorded whatever becomes of the share');
  job = newJob(104, '11', 0);
  fakeNode.blockHash = 'b1'.repeat(32);
  const first = await send('alice', { job, height: 104, raw: '7000' });
  ok('an ordinary block is credited', accepted(first) && credited.length === 1 && credited[0][1] === 'b1'.repeat(32));
  fakeNode.blockHash = 'b2'.repeat(32);
  const realInsert = server.shareValidator.submitShare;
  server.shareValidator.submitShare = async () => ({ success: false, error: 'disk I/O error' });
  const failed = await send('alice', { job, height: 104, raw: '7001' });
  server.shareValidator.submitShare = realInsert;
  ok('a failed share insert does not lose the block', accepted(failed) && credited.length === 2 && credited[1][1] === 'b2'.repeat(32),
     JSON.stringify(failed));
  ok('the miner is told it was a block', failed.result === 'blockfound' || JSON.stringify(failed).includes('b2'), JSON.stringify(failed));
  fakeNode.blockHash = 'b3'.repeat(32);
  const dup = await send('alice', { job, height: 104, raw: '7000' });
  ok('a repeated key with a block is still recorded', credited.length === 3 && credited[2][1] === 'b3'.repeat(32), JSON.stringify(dup));
  fakeNode.blockHash = null;
  const held5 = credited.length;
  await send('alice', { job, height: 104, raw: '7000' });
  ok('a repeat that is no block records none', credited.length === held5);

  try { closeDb(); } catch (_) {}
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.log = console.info;
  console.log(err);
  process.exit(1);
});
