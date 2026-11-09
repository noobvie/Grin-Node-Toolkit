// Lost-block regression tests — a block the node took while its reply was lost.
//
// What this pins:
//   [1] LostBlockCheck: one header read per height, a rounded nonce still matches, a miss ends
//       quietly, a node that cannot answer is retried and then reported;
//   [2] NodeStratumClient: a link drop and the late-reply window both hand their submits to the
//       check, and a timed-out submit holds plain values rather than a closure;
//   [3] StratumServer: a chain match raises the alert unless the block is already recorded, and
//       pause reports submits that could still become a block;
//   [4] AlertMonitor: unrecorded shares and an invalid giveaway raise and clear their alerts.
//
// In-process only: no socket is opened and no timer outlives the run.
// Run: node scripts/test-lost-blocks.js
'use strict';

const path = require('path');

const APP = path.resolve(__dirname, '..');
const LostBlockCheck = require(path.join(APP, 'lib/lost-block-check.js'));
const NodeStratumClient = require(path.join(APP, 'lib/node-stratum-client.js'));
const StratumServer = require(path.join(APP, 'lib/stratum-server.js'));
const AlertMonitor = require(path.join(APP, 'lib/alert-monitor.js'));

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${extra ? ' — ' + extra : ''}`); }
};
const quiet = async (fn) => {
  const saved = [console.log, console.warn, console.error];
  console.log = console.warn = console.error = () => {};
  try { return await fn(); } finally { [console.log, console.warn, console.error] = saved; }
};

// A u64 that JSON.parse cannot hold: this is how the node's header nonce reaches the pool.
const NONCE = '12345678901234567891';
const ROUNDED = JSON.parse(NONCE);

function checker(getHeader, opts = {}) {
  const found = [], gaveUp = [];
  const check = new LostBlockCheck({
    getHeader,
    onFound: (c, h) => found.push({ c, h }),
    onGaveUp: (heights, why, dropped) => gaveUp.push({ heights, why, dropped }),
    retryMs: 1,
    ...opts,
  });
  return { check, found, gaveUp };
}

(async () => {
  console.log('\n[1] the chain check\n');
  {
    ok('the fixture really is rounded', String(ROUNDED) !== NONCE);

    let reads = 0;
    const { check, found } = checker(async () => { reads++; return { nonce: ROUNDED, hash: 'aa' }; });
    check.heights.clear();
    check._schedule = () => {};
    check.add([
      { height: 100, nonce: NONCE, miner: 'grin1a', feePercent: 1 },
      { height: 100, nonce: '7', miner: 'grin1b', feePercent: 1 },
    ]);
    await check.run();
    ok('two submits at one height cost one header read', reads === 1);
    ok('a rounded header nonce matches the exact string', found.length === 1 && found[0].c[0].miner === 'grin1a');
    ok('the height is finished with', check.size === 0);
  }
  {
    const { check, found, gaveUp } = checker(async () => ({ nonce: 5, hash: 'bb' }));
    check._schedule = () => {};
    check.add([{ height: 101, nonce: '9' }]);
    await check.run();
    ok('someone else\'s block ends quietly', found.length === 0 && gaveUp.length === 0 && check.size === 0);
  }
  {
    let up = false;
    const { check, found } = checker(async () => {
      if (!up) throw new Error('refused');
      return { nonce: 9, hash: 'cc' };
    });
    check._schedule = () => {};
    check.add([{ height: 102, nonce: '9' }]);
    await check.run();
    ok('a node that cannot answer keeps the height', check.size === 1 && found.length === 0);
    up = true;
    await check.run();
    ok('the retry finds the block', found.length === 1 && check.size === 0);
  }
  {
    const { check, gaveUp } = checker(async () => { throw new Error('refused'); }, { maxAttempts: 2 });
    check._schedule = () => {};
    check.add([{ height: 103, nonce: '1' }, { height: 103, nonce: '2' }]);
    await check.run();
    ok('no report before the attempts run out', gaveUp.length === 0);
    await check.run();
    ok('giving up is reported, with the submit count',
      gaveUp.length === 1 && gaveUp[0].heights[0].height === 103 && gaveUp[0].heights[0].submits === 2 &&
      check.size === 0 && check.total === 0);
  }
  {
    const { check, gaveUp } = checker(async () => { throw new Error('refused'); }, { maxAttempts: 1 });
    check._schedule = () => {};
    check.add([{ height: 110, nonce: '1' }, { height: 111, nonce: '2' }]);
    await check.run();
    ok('several heights give up in one report', gaveUp.length === 1 && gaveUp[0].heights.length === 2);
  }
  {
    // Neighbouring nonces above 2^53 share one key. The proof must pick the block's submit.
    const near = String(BigInt(NONCE) + 1n);
    ok('the neighbours really collide', Number(near) === Number(NONCE));
    const { check, found } = checker(async () => ({ nonce: ROUNDED, hash: 'ff', cuckoo_solution: [3, 4] }));
    check._schedule = () => {};
    check.add([
      { height: 120, nonce: near, pow: [1, 2], miner: 'grin1share' },
      { height: 120, nonce: NONCE, pow: [3, 4], miner: 'grin1block' },
    ]);
    await check.run();
    ok('the proof picks the exact submit', found[0].c.length === 1 && found[0].c[0].miner === 'grin1block');
  }
  {
    const { check, found } = checker(async () => ({ nonce: ROUNDED, hash: 'ff' }));
    check._schedule = () => {};
    check.add([{ height: 121, nonce: NONCE, pow: [1] }, { height: 121, nonce: String(BigInt(NONCE) + 1n), pow: [2] }]);
    await check.run();
    ok('with no proof in the reply, every possible submit is reported', found[0].c.length === 2);
  }
  {
    const { check, found } = checker(async () => ({ nonce: 9, hash: 'ff', cuckoo_solution: [7] }));
    check._schedule = () => {};
    check.add([{ height: 122, nonce: '9', pow: [8] }]);
    await check.run();
    ok('a proof that matches nothing still reports, never drops', found.length === 1);
  }
  {
    let fails = 1;
    const reported = [];
    const check = new LostBlockCheck({
      getHeader: async () => ({ nonce: 9, hash: 'ff' }),
      onFound: async (c) => { if (fails-- > 0) throw new Error('alert down'); reported.push(c); },
      onGaveUp: () => {},
    });
    check._schedule = () => {};
    check.add([{ height: 123, nonce: '9' }]);
    await check.run();
    ok('a report that throws keeps the height', check.size === 1);
    await check.run();
    ok('and is delivered on the retry', reported.length === 1 && check.size === 0);
  }
  {
    const { check } = checker(async () => { throw new Error('refused'); }, { maxAttempts: 2 });
    check._schedule = () => {};
    check.add([{ height: 124, nonce: '1' }]);
    await check.run();
    check.add([{ height: 124, nonce: '2' }]);
    ok('a newcomer resets the retry budget', check.heights.get(124).attempts === 0);
  }
  {
    const { check, gaveUp } = checker(async () => ({ nonce: 0, hash: 'ff' }), { maxCandidates: 2 });
    check._schedule = () => {};
    check.add([{ height: 125, nonce: '1' }, { height: 125, nonce: '2' }, { height: 125, nonce: '3' }]);
    ok('held submits stay under the cap', check.total === 2);
    await check.run();
    ok('and the count falls when a height finishes', check.total === 0);
    ok('submits past the cap are reported, not only logged', gaveUp.length === 1 && gaveUp[0].dropped === 1);
    await check.run();
    ok('and reported once', gaveUp.length === 1);
  }
  {
    let reads = 0;
    const { check } = checker(async () => {
      reads++;
      const e = new Error('refused'); e.nodeReplied = false; throw e;
    });
    check._schedule = () => {};
    check.add([{ height: 130, nonce: '1' }, { height: 131, nonce: '1' }, { height: 132, nonce: '1' }]);
    await check.run();
    ok('a node that is down costs one read per pass', reads === 1);
    ok('and every height still spends an attempt', [...check.heights.values()].every((e) => e.attempts === 1));
  }
  {
    const { check, found } = checker(async () => ({ nonce: 9, hash: 'same' }));
    check._schedule = () => {};
    check.add([{ height: 133, nonce: '9' }]);
    await check.run();
    check.add([{ height: 133, nonce: '9' }]);
    await check.run();
    ok('a repeat of a reported block is not a second alert', found.length === 1);
  }
  {
    const given = [];
    const check = new LostBlockCheck({
      getHeader: async () => ({ nonce: 9, hash: 'kept' }),
      onFound: async () => { throw new Error('db locked'); },
      onGaveUp: async (h) => given.push(h),
      maxAttempts: 1,
    });
    check._schedule = () => {};
    check.add([{ height: 135, nonce: '9' }]);
    await quiet(() => check.run());
    await quiet(() => check.run());
    ok('a block on chain is never downgraded to a give-up', given.length === 0 && check.size === 1);
  }
  {
    let late = null;
    const check = new LostBlockCheck({
      getHeader: async () => { throw new Error('refused'); },
      onFound: () => {},
      onGaveUp: async () => { late(); },
      maxAttempts: 1,
    });
    check._schedule = () => {};
    late = () => check.add([{ height: 136, nonce: '2' }]);
    check.add([{ height: 136, nonce: '1' }]);
    await check.run();
    ok('a submit added during the report keeps its height', check.size === 1);
  }
  {
    let reportFails = true;
    const reports = [];
    const check = new LostBlockCheck({
      getHeader: async () => { throw new Error('refused'); },
      onFound: () => {},
      onGaveUp: async (h) => { if (reportFails) throw new Error('db locked'); reports.push(h); },
      maxAttempts: 1,
    });
    check._schedule = () => {};
    check.add([{ height: 134, nonce: '1' }]);
    await quiet(() => check.run());
    ok('a give-up report that fails keeps the height', check.size === 1);
    reportFails = false;
    await check.run();
    ok('and is sent on the next pass', reports.length === 1 && check.size === 0);
  }
  {
    const { check } = checker(async () => { throw new Error('refused'); });
    check.add([{ height: 126, nonce: '1' }]);
    check.stop();
    await check.run();
    ok('stop leaves no timer behind, even after a run', check.timer === null);
  }
  {
    const { check } = checker(async () => ({ nonce: 1, hash: 'dd' }));
    check._schedule = () => {};
    check.add([null, { height: 'x', nonce: '1' }]);
    ok('a malformed candidate is ignored', check.size === 0);
  }

  console.log('\n[2] the stratum client hands over what it can no longer hear about\n');
  const fakeServer = () => {
    const s = { lost: [], late: [] };
    s.checkLostCandidates = (list) => s.lost.push(...list);
    s.recordLateBlock = (c, hash) => { s.late.push({ c, hash }); return Promise.resolve(); };
    s.reportUnmatchedBlock = () => {};
    return s;
  };
  const wired = (server) => {
    const client = new NodeStratumClient({ pool_address: 'grin1x', network: 'mainnet' }, server);
    client.connected = true;
    client.socket = { destroyed: false, write() {}, removeAllListeners() {}, destroy() {} };
    return client;
  };
  {
    const server = fakeServer();
    const client = wired(server);
    client.submitTimeoutMs = 1;
    const candidate = { height: 200, nonce: '5', miner: 'grin1a', feePercent: 1 };
    const res = await client.forwardSubmit({ nonce: '5' }, { candidate });
    ok('a timeout still fails the submit', res.accepted === false);
    const [id, entry] = [...client.expired][0];
    ok('the timed-out submit holds plain values', entry.candidate === candidate && !('onLateBlock' in entry));
    client.handleMessage({ id, result: 'blockfound - abc123' });
    ok('a late blockfound records the block', server.late.length === 1 && server.late[0].hash === 'abc123');
    ok('and the submit is no longer held', client.expired.size === 0);
    client.stop();
  }
  {
    const server = fakeServer();
    const client = wired(server);
    client.stopping = true;   // no reconnect from this test
    client.expired.set(1, { at: Date.now(), candidate: { height: 201, nonce: '1' } });
    let settled = null;
    client.pending.set(2, {
      resolve: (r) => { settled = r; },
      timer: setTimeout(() => {}, 1000),
      candidate: { height: 201, nonce: '2' },
    });
    await quiet(() => client._linkClosed());
    ok('a link drop hands over expired and pending submits',
      server.lost.length === 2 && client.expired.size === 0 && client.pending.size === 0);
    ok('a pending submit still gets its answer', settled && settled.accepted === false);
    client.stop();
  }
  {
    const server = fakeServer();
    const client = wired(server);
    const now = Date.now();
    client.expired.set(1, { at: now - 11 * 60 * 1000, candidate: { height: 202, nonce: '1' } });
    client.expired.set(2, { at: now, candidate: { height: 202, nonce: '2' } });
    client._sweepExpired(now);
    ok('an entry past the window goes to the chain check', server.lost.length === 1 && server.lost[0].nonce === '1');
    ok('a fresh entry stays', client.expired.size === 1);
    client.maxPending = 1;
    client._sweepExpired(now);
    ok('the timer does not trim a full map while replies can still arrive', client.expired.size === 1);
    client.stop();
  }

  console.log('\n[3] the stratum server reports, and pause counts\n');
  const server = () => {
    const s = Object.create(StratumServer.prototype);
    s.alerts = [];
    s.alertMonitor = { triggerAlert: async (type, d) => { s.alerts.push({ type, d }); } };
    s.blockManager = { getBlockByHeight: async () => null };
    return s;
  };
  {
    const s = server();
    await quiet(() => s._reportLostBlock(
      [{ height: 300, nonce: NONCE, miner: 'grin1a', feePercent: 1.5 }], { hash: 'ee', nonce: ROUNDED }
    ));
    ok('a chain match raises the critical alert',
      s.alerts.length === 1 && s.alerts[0].type === 'block_record_failed' && s.alerts[0].d.level === 'critical');
    ok('the alert carries what a by-hand entry needs',
      s.alerts[0].d.data.height === 300 && s.alerts[0].d.data.hash === 'ee' &&
      s.alerts[0].d.data.nonce === NONCE && s.alerts[0].d.data.found_by === 'grin1a' &&
      s.alerts[0].d.data.fee_percent === 1.5);
    ok('it stands alone: a second block must not fold into the first alert', s.alerts[0].d.separate === true);
    ok('the message asks for the coinbase to be confirmed', s.alerts[0].d.message.includes('coinbase'));
  }
  {
    const s = server();
    const full = 'grin1' + 'q'.repeat(57);
    await quiet(() => s._reportLostBlock([{ height: 305, nonce: '1', miner: full, feePercent: 1 }], { hash: 'mm', nonce: 1 }));
    ok('the message masks the address, and the stored data keeps it',
      !s.alerts[0].d.message.includes(full) && s.alerts[0].d.data.found_by === full);
  }
  {
    const s = server();
    s.lostBlocks = { reported: new Set(['dup']), size: 0 };
    await quiet(() => s.reportUnmatchedBlock('dup'));
    ok('a late reply for a block already reported is not a second alert', s.alerts.length === 0);
    await quiet(() => s.reportUnmatchedBlock('other'));
    ok('any other unmatched block still alerts', s.alerts.length === 1);
  }
  {
    const s = server();
    await quiet(() => s._reportLostBlock([
      { height: 310, nonce: '1', miner: 'grin1a', feePercent: 1 },
      { height: 310, nonce: '2', miner: 'grin1b', feePercent: 2 },
    ], { hash: 'gg', nonce: 1 }));
    ok('an ambiguous match names no single finder',
      s.alerts[0].d.data.found_by === null && s.alerts[0].d.data.nonce === null && s.alerts[0].d.data.candidates.length === 2);
  }
  {
    const s = server();
    s.alertMonitor = null;
    let threw = false;
    await quiet(async () => {
      try { await s._reportLostBlock([{ height: 311, nonce: '1', miner: 'grin1a' }], { hash: 'hh', nonce: 1 }); }
      catch (_) { threw = true; }
    });
    ok('with no alert monitor yet the report throws, so the height is retried', threw);
    s.alertMonitor = { triggerAlert: async () => false };
    threw = false;
    await quiet(async () => {
      try { await s._reportLostBlock([{ height: 311, nonce: '1', miner: 'grin1a' }], { hash: 'hh', nonce: 1 }); }
      catch (_) { threw = true; }
    });
    ok('an alert that was not stored throws too', threw);
  }
  {
    const s = server();
    s.blockManager = { getBlockByHeight: async () => ({ hash: 'ee' }) };
    await quiet(() => s._reportLostBlock([{ height: 301, nonce: '1', miner: 'grin1a' }], { hash: 'ee', nonce: 1 }));
    ok('a block already recorded is not reported again', s.alerts.length === 0);
  }
  {
    const s = server();
    await quiet(() => s._reportCheckGaveUp([{ height: 302, submits: 3 }, { height: 303, submits: 1 }], 'refused'));
    ok('an unfinished check raises one warning naming every height',
      s.alerts.length === 1 && s.alerts[0].type === 'block_check_incomplete' && s.alerts[0].d.level === 'warning' &&
      s.alerts[0].d.message.includes('302, 303') && s.alerts[0].d.data.submits === 4);
    const off = server();
    off.alertMonitor.enabledAlerts = { block_check_incomplete: false };
    await quiet(() => off._reportCheckGaveUp([{ height: 1, submits: 1 }], 'x'));
    ok('the alert switch is honoured', off.alerts.length === 0);
  }
  {
    const s = server();
    s.nodeStratumClient = { expired: new Map([[1, {}], [2, {}]]) };
    s.lostBlocks = { size: 1 };
    ok('pause counts timed-out submits and heights under check', s._possibleLateBlocks() === 3);
    s.nodeStratumClient = null;
    s.lostBlocks = null;
    ok('no client wired counts as none', s._possibleLateBlocks() === 0);
  }

  console.log('\n[4] the alert monitor watches what the miner stats cannot show\n');
  const monitor = (modules) => {
    const m = Object.create(AlertMonitor.prototype);
    Object.assign(m, modules, { prevUnrecordedShares: 0, quietShareChecks: 0, unrecordedSinceAlert: 0, raised: [], cleared: [] });
    m.triggerAlert = async (type, d) => { m.raised.push({ type, d }); };
    m.resolveAlert = async (type) => { m.cleared.push(type); };
    return m;
  };
  {
    const stratumServer = { unrecordedShares: 3 };
    const m = monitor({ stratumServer });
    await m.checkShareRecording();
    ok('unrecorded shares raise the alert with the fresh count',
      m.raised.length === 1 && m.raised[0].type === 'share_record_failed' && m.raised[0].d.data.unrecorded === 3);
    await m.checkShareRecording();
    ok('one quiet check does not clear it', m.cleared.length === 0);
    for (let i = 0; i < 4; i++) await m.checkShareRecording();
    ok('five quiet checks clear it', m.raised.length === 1 && m.cleared[0] === 'share_record_failed');
    stratumServer.unrecordedShares = 4;
    await m.checkShareRecording();
    ok('a new fault starts a new count', m.raised.length === 2 && m.raised[1].d.data.unrecorded === 1);
    stratumServer.unrecordedShares = 9;
    await m.checkShareRecording();
    ok('the count runs on while the alert is open', m.raised[2].d.data.unrecorded === 6 && m.raised[2].d.refresh === true);
  }
  {
    const daily = { on: true, good: null, enabled() { return this.on; }, rules() { return this.good; } };
    const m = monitor({ lotteryManager: { daily } });
    await m.checkGiveawayRules();
    ok('an enabled giveaway with invalid rules raises the alert',
      m.raised.length === 1 && m.raised[0].type === 'giveaway_rules_invalid');
    daily.good = { max_grin: 5 };
    await m.checkGiveawayRules();
    ok('valid rules clear it', m.raised.length === 1 && m.cleared[0] === 'giveaway_rules_invalid');
    daily.on = false; daily.good = null;
    await m.checkGiveawayRules();
    ok('a disabled giveaway never alerts', m.raised.length === 1);
    const none = monitor({ lotteryManager: null });
    await none.checkGiveawayRules();
    ok('no lottery wired is a no-op', none.raised.length === 0);
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
