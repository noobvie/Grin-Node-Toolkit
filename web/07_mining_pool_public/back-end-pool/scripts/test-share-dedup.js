'use strict';

// One solved share earns one credit, whoever sends it and however often. A submit the node cannot
// handle never reaches it, and every block the node accepts is recorded (audit §J6-1).
//
// Drives the real parser, StratumServer.handleSubmit, ShareValidator and NodeStratumClient on an
// in-memory DB. The socket under the client is fakeGrin, which follows handle_submit in grin's
// stratumserver.rs: it keeps no record of shares, takes only the tip height, reads job ids as a
// per-height index, packs the proof before verifying it (a bad one panics), refuses a known block,
// and answers with the real "blockfound - <hash>" string. It is a model read from that source, so
// it shows what the pool does, not what a deployed node does.
// Run: node scripts/test-share-dedup.js

const { initDb, getDb, createSchema, closeDb } = require('../lib/db');
const StratumServer = require('../lib/stratum-server');
const NodeStratumClient = require('../lib/node-stratum-client');
const { parseStratumMessage } = require('../lib/stratum-protocol');

let pass = 0, fail = 0;
const say = (line) => process.stdout.write(line + '\n');
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; say(`  PASS  ${name}`); }
  else { fail++; say(`  FAIL  ${name} ${extra}`); }
};
console.log = console.warn = console.error = () => {};

const ALICE = 'grin1alice';
const MALLORY = 'grin1mallory';
const POW = Array.from({ length: 42 }, (_, i) => i + 1);
const POW2 = Array.from({ length: 42 }, (_, i) => i + 2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function minerManager() {
  const session = (id, grinAddress, workerName) => ({ sessionId: id, grinAddress, workerName, ip: '10.0.0.1', region: 'default' });
  const sessions = new Map([
    ['alice', session('alice', ALICE, 'rig')],
    ['alice2', session('alice2', ALICE, 'other')],
    ['mallory', session('mallory', MALLORY, 'rig')],
    ['flood', session('flood', MALLORY, 'flood')],
    ['fault', session('fault', ALICE, 'fault')],
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

  const manager = minerManager();
  const server = new StratumServer({ network: 'testnet', stratum_port: 0, region: 'default' }, manager);
  const client = new NodeStratumClient({}, server);

  const solutionKey = (pre, nonce, pow) => `${pre}|${nonce}|${pow.join(',')}`;
  const fakeGrin = {
    tip: null, versions: [], solved: new Set(), blocks: new Set(), chain: new Set(),
    submits: 0, unparsable: 0, panics: 0, delayMs: 0,
    reply(id, body) {
      const send = () => client.handleMessage({ id, method: 'submit', ...body });
      if (fakeGrin.delayMs) setTimeout(send, fakeGrin.delayMs); else setImmediate(send);
    },
    receive(line) {
      let req;
      try { req = JSON.parse(line); } catch (_) { fakeGrin.unparsable++; return; }
      fakeGrin.submits++;
      const { edge_bits: bits, height, job_id: jobId, pow } = req.params;
      const bare = line.match(/"nonce":(\d+)/); // JSON.parse would round a u64
      if (!bare) return fakeGrin.reply(req.id, { error: { code: -32600, message: 'Invalid request' } });
      const nonce = bare[1];
      if (height !== fakeGrin.tip) return fakeGrin.reply(req.id, { error: { code: -32503, message: 'Solution submitted too late' } });
      const pre = fakeGrin.versions[jobId];
      if (pre === undefined) return fakeGrin.reply(req.id, { error: { code: -32502, message: 'Failed to validate solution' } });
      if (pow.length !== 42 || bits >= 64 || pow[41] >= 2 ** bits) { fakeGrin.panics++; return; }
      const key = solutionKey(pre, nonce, pow);
      if (!fakeGrin.solved.has(key)) return fakeGrin.reply(req.id, { error: { code: -32502, message: 'Failed to validate solution' } });
      if (fakeGrin.blocks.has(key)) {
        if (fakeGrin.chain.has(key)) return fakeGrin.reply(req.id, { error: { code: -32502, message: 'Failed to validate solution' } });
        fakeGrin.chain.add(key);
        return fakeGrin.reply(req.id, { result: `blockfound - ${'ab'.repeat(16)}${fakeGrin.chain.size}` });
      }
      return fakeGrin.reply(req.id, { result: 'ok' });
    },
  };
  client.connected = true;
  client.socket = { destroyed: false, write: (line) => fakeGrin.receive(line.trim()) };
  server.setNodeStratumClient(client);

  const credited = [];
  let creditResult = () => ({ success: true });
  let blockFlagSeen = false;
  server.setBlockManager({
    creditBlock: async (...a) => {
      blockFlagSeen = [...server.inflight].some((e) => e.isBlock);
      credited.push(a);
      return creditResult();
    },
  });
  const alerts = [];
  server.alertMonitor = { triggerAlert: async (type, details) => { alerts.push([type, details]); } };

  // A new job as the node would push it. Job ids restart at each height, or on a reorg.
  const newJob = (height, pre, { reorg = false } = {}) => {
    if (height !== fakeGrin.tip || reorg) fakeGrin.versions = [];
    fakeGrin.tip = height;
    const preHex = pre.repeat(16);
    fakeGrin.versions.push(preHex);
    server.setNewJob({ height, difficulty: 1, pre_pow: preHex, node_job_id: fakeGrin.versions.length - 1 });
    return server.jobCounter;
  };

  // `raw` is the nonce exactly as it appears in the miner's JSON, so it runs through the real
  // parser. The solution counts as solved on the job's own work unless `solved` says otherwise.
  const send = (sessionId, { job, height, raw, pow = POW, bits = 32, solved = true, block = false }) => new Promise((resolve) => {
    const entry = server.jobIdMap.get(job);
    if (solved && entry) {
      const key = solutionKey(entry.pre_pow, String(raw).replace(/"/g, ''), Array.isArray(pow) ? pow : []);
      fakeGrin.solved.add(key);
      if (block) fakeGrin.blocks.add(key);
    }
    const socket = { write: (line) => resolve(JSON.parse(line)), destroy() { socket.destroyed = true; resolve(null); }, end() {} };
    const line = `{"id":1,"method":"submit","params":{"edge_bits":${JSON.stringify(bits)},"height":${height},"job_id":${job},"nonce":${raw},"pow":${JSON.stringify(pow)}}}`;
    server.handleSubmit(socket, parseStratumMessage(line), sessionId);
  });
  const accepted = (reply) => !!reply && !reply.error;
  const credits = (address) => db.prepare('SELECT COUNT(*) c FROM shares WHERE grin_address = ?').get(address).c;

  let job = newJob(100, 'aa');
  const here = (raw, more = {}) => ({ job, height: 100, raw, ...more });

  say('[1] the same solved share');
  ok('the first submit is credited', accepted(await send('alice', here('1000'))) && credits(ALICE) === 1);
  ok('the same address cannot send it twice', !accepted(await send('alice', here('1000'))) && credits(ALICE) === 1);
  ok('another worker on that address cannot send it', !accepted(await send('alice2', here('1000'))) && credits(ALICE) === 1);
  ok('another address cannot send it', !accepted(await send('mallory', here('1000'))) && credits(MALLORY) === 0);
  ok('quoting the nonce does not make it a new share', !accepted(await send('mallory', here('"1000"'))) && credits(MALLORY) === 0);
  const dupReply = await send('mallory', here('1000'));
  ok('the reply names a duplicate, not a database error', JSON.stringify(dupReply).includes('Duplicate share') && !JSON.stringify(dupReply).includes('UNIQUE'),
     JSON.stringify(dupReply));

  say('[2] a submit the node cannot handle stops at the pool');
  for (const raw of ['"0123"', '"00"', `"${'9'.repeat(400)}"`, '9'.repeat(400), '"18446744073709551616"', '-1', '"1e3"', '[1]', '""', 'null']) {
    const before = fakeGrin.submits;
    const reply = await send('mallory', here(raw, { solved: false }));
    ok(`nonce ${raw.slice(0, 24)} is refused and never forwarded`, !accepted(reply) && fakeGrin.submits === before, JSON.stringify(reply));
  }
  const badProofs = [
    ['one edge', { pow: [1] }],
    ['41 edges', { pow: POW.slice(0, 41) }],
    ['43 edges', { pow: [...POW, 43] }],
    ['an empty proof', { pow: [] }],
    ['an edge wider than edge_bits', { pow: [...POW.slice(0, 41), 2 ** 32] }],
    ['edges out of order', { pow: [...POW].reverse() }],
    ['a repeated edge', { pow: [...POW.slice(0, 41), 41] }],
    ['a fractional edge', { pow: [...POW.slice(0, 41), 41.5] }],
    ['edge_bits 64', { bits: 64 }],
    ['edge_bits 28', { bits: 28 }],
    ['fractional edge_bits', { bits: 31.5 }],
    ['quoted edge_bits', { bits: '32' }],
  ];
  for (const [name, more] of badProofs) {
    const before = fakeGrin.submits;
    const reply = await send('mallory', here('3000', { solved: false, ...more }));
    ok(`${name} is refused and never forwarded`, !accepted(reply) && fakeGrin.submits === before, JSON.stringify(reply));
  }
  ok('the largest u64 is accepted with its exact digits', accepted(await send('mallory', here('18446744073709551615'))) && credits(MALLORY) === 1);
  ok('its neighbour is a different share, so no rounding happened', accepted(await send('mallory', here('18446744073709551614'))) && credits(MALLORY) === 2);
  ok('the node saw no line it could not parse and no proof it could not pack', fakeGrin.unparsable === 0 && fakeGrin.panics === 0,
     `${fakeGrin.unparsable} ${fakeGrin.panics}`);

  say('[3] replaying a share through another job');
  const reissue = newJob(100, 'aa');
  ok('a re-issued template does not reopen the share',
     !accepted(await send('mallory', { job: reissue, height: 100, raw: '1000' })) && credits(MALLORY) === 2);

  newJob(100, 'c1');
  newJob(100, 'c2');
  const oldJob = newJob(100, 'c3');
  const firstTip = newJob(101, 'd1');
  newJob(101, 'd2');
  const tip = newJob(101, 'd3');
  const held = credits(ALICE);
  ok('a share is credited on the tip job', accepted(await send('alice', { job: tip, height: 101, raw: '5000' })) && credits(ALICE) === held + 1);
  ok('the job an older height held under this id is gone', !server.jobIdMap.has(oldJob - 2));
  const replay = await send('mallory', { job: oldJob, height: 101, raw: '5000', solved: false });
  ok('an older height\'s job id cannot carry it', !accepted(replay) && credits(MALLORY) === 2, JSON.stringify(replay));
  const nodeCalls = fakeGrin.submits;
  await send('mallory', { job: oldJob, height: 101, raw: '5001', solved: false });
  ok('and that submit never reaches the node', fakeGrin.submits === nodeCalls);
  ok('an unsolved share on the current height is the node\'s to refuse',
     !accepted(await send('mallory', { job: firstTip, height: 101, raw: '5000', solved: false })) && credits(MALLORY) === 2);

  const before = newJob(102, 'e1');
  const after = newJob(102, 'e2', { reorg: true });
  ok('a reorg retires the job whose id was reused', accepted(await send('alice', { job: after, height: 102, raw: '6000' }))
     && !accepted(await send('mallory', { job: before, height: 102, raw: '6000', solved: false })) && credits(MALLORY) === 2);

  say('[4] real work is still credited');
  job = newJob(103, 'ff');
  const at103 = (raw, more = {}) => ({ job, height: 103, raw, ...more });
  ok('a different nonce is a new share', accepted(await send('mallory', at103('2000'))) && credits(MALLORY) === 3);
  ok('a second cycle in one graph is a new share', accepted(await send('mallory', at103('2000', { pow: POW2 }))) && credits(MALLORY) === 4);
  job = newJob(103, 'f0');
  ok('a new template with the same nonce is a new share', accepted(await send('mallory', at103('2000'))) && credits(MALLORY) === 5);
  ok('a nonce of zero is a real nonce', accepted(await send('mallory', at103('0'))) && credits(MALLORY) === 6);
  ok('a C31 proof is forwarded', accepted(await send('mallory', at103('2001', { bits: 31 }))) && credits(MALLORY) === 7);

  say('[5] a block is recorded whatever becomes of the share');
  job = newJob(104, '11');
  const at104 = (raw, more = {}) => ({ job, height: 104, raw, block: true, ...more });
  const first = await send('alice', at104('7000'));
  ok('the real blockfound reply reaches the block record', accepted(first) && credited.length === 1 && credited[0][1].startsWith('abab'),
     JSON.stringify(first));
  ok('a replayed block earns no second record', !accepted(await send('mallory', at104('7000'))) && credited.length === 1);
  await send('alice', { job, height: 104, raw: '7100' });
  const cycle = await send('alice', at104('7100', { pow: POW2 }));
  ok('a block on a nonce that already gave a share is recorded', accepted(cycle) && credited.length === 2, JSON.stringify(cycle));

  const realInsert = server.shareValidator.submitShare;
  const insertFault = async () => ({ success: false, error: 'disk I/O error' });
  server.shareValidator.submitShare = insertFault;
  blockFlagSeen = false;
  const failed = await send('alice', at104('7200'));
  server.shareValidator.submitShare = realInsert;
  ok('a failed share insert does not lose the block', accepted(failed) && credited.length === 3, JSON.stringify(failed));
  ok('the block is tracked as one while it is recorded', blockFlagSeen);

  creditResult = () => ({ success: false, error: 'database is locked' });
  await send('alice', at104('7300'));
  creditResult = () => ({ success: true });
  ok('a block the database refuses raises the critical alert',
     alerts.length === 1 && alerts[0][0] === 'block_record_failed' && alerts[0][1].level === 'critical', JSON.stringify(alerts));

  say('[6] a block the node answers late');
  client.submitTimeoutMs = 15;
  fakeGrin.delayMs = 40;
  const creditedBefore = credited.length;
  const timedOut = await send('alice', at104('7400'));
  ok('the miner hears the timeout', !accepted(timedOut) && JSON.stringify(timedOut).includes('timeout'), JSON.stringify(timedOut));
  await sleep(70);
  ok('the late block is recorded', credited.length === creditedBefore + 1 && credited[credited.length - 1][4] === ALICE,
     JSON.stringify(credited[credited.length - 1]));
  await send('alice', { job, height: 104, raw: '7500' });
  await sleep(70);
  ok('a late plain share records no block', credited.length === creditedBefore + 1 && client.expired.size === 0);
  client.submitTimeoutMs = 15000;
  fakeGrin.delayMs = 0;

  const alertsBefore = alerts.length;
  client.handleMessage({ id: 999999, method: 'submit', result: 'blockfound - beef' });
  await sleep(5);
  ok('a block with no submit left raises the critical alert', alerts.length === alertsBefore + 1
     && alerts[alerts.length - 1][1].data.hash === 'beef', JSON.stringify(alerts[alerts.length - 1]));
  client.handleMessage({ id: 999998, method: 'submit', result: 'ok' });
  await sleep(5);
  ok('an unmatched plain reply is ignored', alerts.length === alertsBefore + 1);
  client.maxPending = 2;
  const handedOver = [];
  const realCheck = server.checkLostCandidates;
  server.checkLostCandidates = (list) => handedOver.push(...list);
  for (let i = 0; i < 5; i++) client._rememberExpired(1000 + i, { height: 1, nonce: String(i) });
  server.checkLostCandidates = realCheck;
  ok('evicted submits go to the chain check', handedOver.length === 3 && handedOver[0].nonce === '0');
  ok('kept submits stay bounded, oldest out first', client.expired.size === 2 && client.expired.has(1004), [...client.expired.keys()].join());
  client.maxPending = 20000;
  client.expired.clear();

  say('[7] the reject ceiling');
  job = newJob(105, '22');
  const at105 = (raw) => ({ job, height: 105, raw });
  await send('alice', at105('8000'));
  let dropped = false;
  for (let i = 0; i < 60 && !dropped; i++) dropped = (await send('flood', at105('8000'))) === null;
  ok('repeating one share ends in a disconnect', dropped);
  server.shareValidator.submitShare = insertFault;
  for (let i = 0; i < 60; i++) await send('fault', at105(String(9000 + i)));
  server.shareValidator.submitShare = realInsert;
  ok('a database fault does not count against the miner', !manager.getSession('fault').consecutiveRejects,
     String(manager.getSession('fault').consecutiveRejects));

  try { closeDb(); } catch (_) {}
  say(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  say(String(err && err.stack));
  process.exit(1);
});
