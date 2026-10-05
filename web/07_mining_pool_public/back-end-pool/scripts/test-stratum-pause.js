'use strict';

// Stratum pause regression tests — design §21 (lib/stratum-pause.js + the mechanism in
// lib/stratum-server.js).
//
// What this pins:
//   [1] pause closes EVERY listener — public and each region — and no new connection is accepted
//       on any of them; connected miners are dropped; the row is persisted with settled_at.
//   [2] an in-flight submit settles before the sockets go: the miner gets its reply, and a block
//       candidate in flight is credited.
//   [3] past the settle bound nothing is abandoned: a block whose creditBlock is still running is
//       counted (blocks_in_flight), STILL recorded after its socket is gone, and settled_at is
//       stamped late.
//   [4] the paused guards: a submit/login parsed during a pause is REJECTED and never counted
//       (no _stat → no high_rejection_rate); broadcastJob sends nothing but the job is tracked.
//   [5] hot-bind while paused does not bind (deferred) and IS bound on resume.
//   [6] resume reports a failed bind (EADDRINUSE) — accepting anyway, last_result persisted,
//       stratum_bind_failed raised — and a later re-bind brings it up and resolves the alert.
//   [7] boot: expired `until` resumes (stratum_resume_expired_at_boot); future `until` stays
//       paused with NOTHING bound, then auto-resumes on the tick; an unreadable row fails closed.
//   [8] planned window: starts and ends on the tick, merges with a manual pause, a window missed
//       entirely while down is dropped and audited.
//   [9] caps + state conflicts (400 / 409), the transition guard, stop() while paused, and the
//       settings tables' wholesale writes cannot touch the pause.
//
// In-process only: every listener binds 127.0.0.1 on a free port and is closed; the DB is
// :memory:. Nothing is left running. Run: node scripts/test-stratum-pause.js

const net = require('net');
const path = require('path');

const APP = path.resolve(__dirname, '..');
const StratumServer = require(path.join(APP, 'lib/stratum-server.js'));
const StratumPause = require(path.join(APP, 'lib/stratum-pause.js'));
const { StratumPauseError, FAIL_CLOSED_S, WINDOW_LEAD_S } = StratumPause;
const { initDb, getDb, closeDb } = require(path.join(APP, 'lib/db.js'));
const { validateUsername } = require(path.join(APP, 'lib/stratum-protocol.js'));

// The server logs every transition; quiet() mutes that, so ok() prints through the saved logger.
const realLog = console.log;
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; realLog(`  PASS  ${name}`); }
  else { fail++; realLog(`  FAIL  ${name}${extra ? ' — ' + extra : ''}`); }
};

const ADDR = 'tgrin1xtxavwfgs48ckf3gk8wwgcndmn0nt4tvkl8a7ltyejjcy2mc6nfs9gm2lp';
const POW = Array.from({ length: 42 }, (_, i) => i + 1);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tick = () => new Promise((r) => setImmediate(r));

const quiet = (fn) => async (...a) => {
  console.log = () => {}; const w = console.warn, e = console.error;
  console.warn = () => {}; console.error = () => {};
  try { return await fn(...a); } finally { console.log = realLog; console.warn = w; console.error = e; }
};

const freePort = () => new Promise((resolve) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
});

// 'ok' when a TCP connect succeeds (closed again at once), else the error code.
const tryConnect = (port) => new Promise((resolve) => {
  const s = net.connect(port, '127.0.0.1');
  s.once('connect', () => { s.destroy(); resolve('ok'); });
  s.once('error', (e) => resolve(e.code || e.message));
});

function client(port) {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, '127.0.0.1');
    const msgs = [];
    let buf = '';
    const closed = new Promise((r) => s.once('close', r));
    s.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        try { msgs.push(JSON.parse(line)); } catch (e) { /* ignore */ }
      }
    });
    s.on('error', (e) => reject(e));   // after connect: harmless (ECONNRESET on a server destroy)
    s.once('connect', () => resolve({ s, msgs, closed, send: (o) => s.write(JSON.stringify(o) + '\n') }));
  });
}

async function waitFor(cond, ms = 3000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (cond()) return true; await sleep(10); }
  return cond();
}

function stubMinerManager() {
  const sessions = new Map();
  let n = 0;
  return {
    sessions,
    isBanned: () => false,
    ensureMinerExists: () => {},
    createSession(addr, worker, ip, region, pass) {
      const id = `s${++n}`;
      sessions.set(id, { sessionId: id, grinAddress: addr, workerName: worker, ip, region, pass, difficulty: 1 });
      return id;
    },
    getSession: (id) => sessions.get(id),
    closeSession: (id) => { sessions.delete(id); },
    touchSession() {},
    setSessionDifficulty(id, d) { const s = sessions.get(id); if (s) s.difficulty = d; },
    recordShare() {}, recordMinerCountry() {}, recordOwnerEvidence() {},
    pruneInactiveSessions: () => 0,
    getActiveSessions: () => [...sessions.values()],
    getActiveMinersCount: () => sessions.size,
  };
}

// A server on three free 127.0.0.1 ports: public + regions eu, us. `node` and `credit` control
// the submit path's two awaits.
async function makeServer({ nodeDelay = 0, blockHash = null, creditDelay = 0 } = {}) {
  const [pub, eu, us] = [await freePort(), await freePort(), await freePort()];
  const config = {
    network: 'testnet', stratum_port: pub, region: 'default',
    region_listen_host: '127.0.0.1', region_ports: { eu, us },
  };
  const server = new StratumServer(config, stubMinerManager());
  server.publicHost = '127.0.0.1';
  const recorded = [];
  const credited = [];
  server.shareValidator = {
    generateShareHash: () => `h${Math.random()}`,
    submitShare: async (...a) => { recorded.push(a); return { success: true }; },
  };
  server.setNodeStratumClient({
    forwardSubmit: () => new Promise((r) => setTimeout(() => r({ accepted: true, blockHash, error: null }), nodeDelay)),
  });
  server.setBlockManager({
    creditBlock: async (...a) => { await sleep(creditDelay); credited.push(a); return { success: true }; },
  });
  return { server, config, ports: { pub, eu, us }, recorded, credited };
}

function auditActions(db) {
  return db.prepare(`SELECT action, admin_id, details FROM admin_audit_log WHERE target_type = 'stratum' ORDER BY id`).all();
}
function resetDb(db) {
  db.exec('DELETE FROM stratum_control; DELETE FROM admin_audit_log;');
}
function stubAlerts() {
  const calls = [];
  return {
    calls,
    triggerAlert: async (type, details) => { calls.push(['trigger', type, details]); },
    resolveAlert: async (type) => { calls.push(['resolve', type]); },
  };
}

async function loginAndSubmit(port, server) {
  const c = await client(port);
  c.send({ id: 1, jsonrpc: '2.0', method: 'login', params: { login: `${ADDR}.rig1`, pass: 'x', agent: 't' } });
  await waitFor(() => c.msgs.some((m) => m.id === 1));
  c.send({ id: 2, jsonrpc: '2.0', method: 'submit',
    params: { edge_bits: 32, height: 100, job_id: server.jobCounter, nonce: 123, pow: POW } });
  return c;
}

(async () => {
  initDb(':memory:');
  const db = getDb();
  let NOW = 1800000000;
  const now = () => NOW;

  ok('fixture address is a valid testnet login', !!validateUsername(ADDR, 'testnet'));

  // ── [1] pause closes every listener; nothing new gets in ───────────────────────────────────
  console.log('[1] pause closes public + every region listener');
  await quiet(async () => {
    resetDb(db);
    const { server, ports } = await makeServer();
    await server.start();
    const before = await Promise.all([tryConnect(ports.pub), tryConnect(ports.eu), tryConnect(ports.us)]);
    const c = await client(ports.eu);
    await waitFor(() => server.sockets.size >= 1);
    const sp = new StratumPause({ db, stratumServer: server, now, settleMs: 2000 });
    sp.load();
    const r = await sp.pause({ reason: 'restore test', durationMin: 30, by: 'admin:alice', adminId: null, ip: '10.0.0.1' });
    const after = await Promise.all([tryConnect(ports.pub), tryConnect(ports.eu), tryConnect(ports.us)]);
    await Promise.race([c.closed, sleep(2000)]);
    const row = db.prepare('SELECT * FROM stratum_control WHERE id = 1').get();
    const audit = auditActions(db);

    ok('all three listeners accepted before the pause', before.every((x) => x === 'ok'), before.join(','));
    ok('pause reports all three listeners closed (public + eu + us)',
      r.listeners_closed.length === 3 &&
      ['default', 'eu', 'us'].every((reg) => r.listeners_closed.some((l) => l.region === reg)),
      JSON.stringify(r.listeners_closed));
    ok('no new connection is accepted on ANY stratum port while paused',
      after.every((x) => x === 'ECONNREFUSED'), after.join(','));
    ok('the connected miner was dropped', c.s.destroyed && server.sockets.size === 0, `destroyed=${c.s.destroyed} sockets=${server.sockets.size} closed=${r.sockets_closed}`);
    ok('server holds no listener and no port claim', server.servers.length === 0 && server.boundPorts.size === 0 &&
      server.listenerView().length === 0);
    ok('acceptState = paused, isRefusing()', server.acceptState === 'paused' && server.isRefusing());
    ok('settled:true with nothing in flight', r.settled === true && r.inflight_left === 0 && r.sockets_closed === 1);
    ok('row persisted: paused, manual, until = now + 30 min, settled_at set',
      row && row.paused === 1 && row.source === 'manual' && row.until === NOW + 1800 &&
      row.since === NOW && row.settled_at === NOW && row.paused_by === 'admin:alice' && row.reason === 'restore test');
    ok('response says persisted', r.persisted === true && r.state.paused === true);
    ok('audit row stratum_pause with reason + until, target stratum',
      audit.length === 1 && audit[0].action === 'stratum_pause' &&
      JSON.parse(audit[0].details).until === NOW + 1800 && JSON.parse(audit[0].details).reason === 'restore test');
    server.stop();
  })();

  // ── [2] in-flight submit settles: reply delivered, block credited ──────────────────────────
  console.log('[2] an in-flight block candidate settles before the sockets go');
  await quiet(async () => {
    resetDb(db);
    const { server, ports, credited, recorded } = await makeServer({ nodeDelay: 300, blockHash: 'b10c' });
    await server.start();
    server.setNewJob({ height: 100, difficulty: 1, pre_pow: '00ab', node_job_id: 7 });
    const c = await loginAndSubmit(ports.pub, server);
    await waitFor(() => server.inflight.size === 1);
    const inflightBefore = server.inflight.size;
    const r = await server.pause({ settleMs: 3000 });
    await Promise.race([c.closed, sleep(2000)]);
    const reply = c.msgs.find((m) => m.id === 2);

    ok('the submit was in flight when the pause began', inflightBefore === 1);
    ok('pause settled (in-flight drained inside the bound)', r.settled === true && r.inflight_left === 0);
    ok('the block candidate was credited', credited.length === 1 && credited[0][1] === 'b10c');
    ok('the share was recorded', recorded.length === 1);
    ok('the miner received its submit reply BEFORE being dropped', !!reply && !reply.error,
      JSON.stringify(reply));
    ok('settle_ms reflects the wait (≥ ~250 ms)', r.settle_ms >= 250, String(r.settle_ms));
    server.stop();
  })();

  // ── [3] past the bound: nothing abandoned ──────────────────────────────────────────────────
  console.log('[3] past the settle bound a block in flight is still recorded');
  await quiet(async () => {
    resetDb(db);
    const { server, ports, credited } = await makeServer({ nodeDelay: 20, blockHash: 'b10c2', creditDelay: 500 });
    await server.start();
    server.setNewJob({ height: 100, difficulty: 1, pre_pow: '00cd', node_job_id: 8 });
    const c = await loginAndSubmit(ports.pub, server);
    await waitFor(() => [...server.inflight].some((e) => e.isBlock));
    const sp = new StratumPause({ db, stratumServer: server, now, settleMs: 50 });
    sp.load();
    const r = await sp.pause({ reason: 'bound test', durationMin: 15, by: 'admin:alice' });
    const rowEarly = db.prepare('SELECT settled_at FROM stratum_control WHERE id = 1').get();
    await Promise.race([c.closed, sleep(2000)]);
    const socketGone = c.s.destroyed;
    const creditedAtPause = credited.length;
    await server.waitSettled(3000);
    await tick(); await tick();
    const rowLate = db.prepare('SELECT settled_at FROM stratum_control WHERE id = 1').get();

    ok('settled:false, one in flight, one BLOCK in flight', r.settled === false && r.inflight_left === 1 &&
      r.blocks_in_flight === 1, JSON.stringify({ s: r.settled, i: r.inflight_left, b: r.blocks_in_flight }));
    ok('the miner socket was destroyed anyway', socketGone && r.sockets_closed === 1);
    ok('block not yet credited at pause return', creditedAtPause === 0);
    ok('…and STILL credited after its socket was gone', credited.length === 1 && credited[0][1] === 'b10c2');
    ok('settled_at NULL at pause return, stamped once the submit landed',
      rowEarly.settled_at === null && rowLate.settled_at === NOW);
    ok('audit row carries blocks_in_flight', JSON.parse(auditActions(db)[0].details).blocks_in_flight === 1);
    server.stop();
  })();

  // ── [4] paused guards ──────────────────────────────────────────────────────────────────────
  console.log('[4] paused guards: rejection never counted; no job broadcast');
  await quiet(async () => {
    const server = new StratumServer({ network: 'testnet', stratum_port: 1 }, stubMinerManager());
    const sid = server.minerManager.createSession(ADDR, 'rig', '1.2.3.4', 'default', '');
    const writes = [];
    const fakeSock = { destroyed: false, write: (s) => { writes.push(JSON.parse(s)); return true; } };
    server.acceptState = 'pausing';
    server.handleMessage(fakeSock, { id: 5, method: 'submit', params: {} }, '1.2.3.4', () => {}, () => sid, 'default');
    server.handleMessage(fakeSock, { id: 6, method: 'login', params: { login: ADDR } }, '1.2.3.4', () => {}, () => null, 'default');
    const sess = server.minerManager.getSession(sid);
    ok('submit while pausing → rejected "Pool paused"', writes[0] && writes[0].id === 5 &&
      JSON.stringify(writes[0]).includes('Pool paused'));
    ok('…and NOT counted (no rejected / consecutiveRejects)', !sess.rejected && !sess.consecutiveRejects);
    ok('login while pausing → refused, no session created', writes[1] && writes[1].id === 6 &&
      JSON.stringify(writes[1]).includes('Pool paused') && server.minerManager.sessions.size === 1);

    server.acceptState = 'paused';
    const bsock = { destroyed: false, write: (s) => { writes.push(s); return true; } };
    server.sockets.set(bsock, null);
    const n = writes.length;
    server.setNewJob({ height: 200, difficulty: 2, pre_pow: 'ff', node_job_id: 9 });
    ok('setNewJob while paused tracks the job but broadcasts nothing',
      writes.length === n && server.currentJob.height === 200 && server.jobIdMap.has(server.jobCounter));
    server.acceptState = 'accepting';
    server.broadcastJob();
    ok('…and broadcasts again once accepting', writes.length === n + 1);
    server.acceptState = 'resuming';
    ok('pause() while resuming → ESTATE', await server.pause().then(() => false, (e) => e.code === 'ESTATE'));
    ok('resume() while resuming → ESTATE', await server.resume().then(() => false, (e) => e.code === 'ESTATE'));
    ok('isRefusing() is false while resuming (live listeners serve)', server.isRefusing() === false);
  })();

  // ── [5] hot-bind while paused ──────────────────────────────────────────────────────────────
  console.log('[5] hot-bind while paused is deferred, then bound on resume');
  await quiet(async () => {
    resetDb(db);
    const { server, config, ports } = await makeServer();
    await server.start();
    const sp = new StratumPause({ db, stratumServer: server, now, settleMs: 500 });
    sp.load();
    await sp.pause({ reason: 'hub move', durationMin: 60, by: 'admin:alice' });
    const ap = await freePort();
    config.region_ports.ap = ap;   // the pairing route writes this BEFORE calling bindRegionListener
    const hb = await server.bindRegionListener('ap', ap);
    const whilePaused = await tryConnect(ap);
    const r = await sp.resume({ by: 'admin:alice' });
    const apRes = r.results.find((x) => x.region === 'ap');
    const afterResume = await Promise.all([tryConnect(ports.pub), tryConnect(ports.eu), tryConnect(ports.us), tryConnect(ap)]);

    ok('bindRegionListener while paused → deferred, not bound', hb.deferred === true && hb.bound === false && !hb.error);
    ok('the deferred port is NOT listening while paused', whilePaused === 'ECONNREFUSED', whilePaused);
    ok('resume binds it (from config.region_ports as it is NOW)', apRes && apRes.bound === true);
    ok('every listener accepts after resume, the new region included', afterResume.every((x) => x === 'ok'), afterResume.join(','));
    ok('resume result: 4 listeners, none failed', r.results.length === 4 && r.failed === 0 && r.rebind === false);
    ok('row cleared, last_result kept', (() => {
      const row = db.prepare('SELECT * FROM stratum_control WHERE id = 1').get();
      return row.paused === 0 && row.until === null && row.source === null && JSON.parse(row.last_result).results.length === 4;
    })());
    ok('hot-bind while accepting binds normally again', await (async () => {
      const p2 = await freePort();
      const res = await server.bindRegionListener('sa', p2);
      return res.bound === true && (await tryConnect(p2)) === 'ok';
    })());
    server.stop();
  })();

  // ── [6] resume reports a failed bind ───────────────────────────────────────────────────────
  console.log('[6] resume reports a failed bind; re-bind recovers');
  await quiet(async () => {
    resetDb(db);
    const { server, ports } = await makeServer();
    await server.start();
    const alerts = stubAlerts();
    const sp = new StratumPause({ db, stratumServer: server, now, settleMs: 500, alertMonitor: alerts });
    sp.load();
    await sp.pause({ reason: 'port test', durationMin: 15, by: 'admin:alice' });
    // Something else takes the eu port while the pool is paused.
    const blocker = net.createServer();
    await new Promise((r) => blocker.listen(ports.eu, '127.0.0.1', r));
    const r = await sp.resume({ by: 'admin:alice' });
    const eu = r.results.find((x) => x.region === 'eu');
    const row = db.prepare('SELECT * FROM stratum_control WHERE id = 1').get();
    const lr = JSON.parse(row.last_result);

    ok('resume result marks eu NOT bound with EADDRINUSE', eu && eu.bound === false && eu.code === 'EADDRINUSE' &&
      /EADDRINUSE/.test(eu.error), JSON.stringify(eu));
    ok('failed = 1, the others up', r.failed === 1 && r.results.filter((x) => x.bound).length === 2);
    ok('accepting anyway (the operator asked for service)', server.acceptState === 'accepting' && row.paused === 0);
    ok('last_result persisted with the failure', lr.results.some((x) => x.region === 'eu' && x.bound === false));
    ok('stratum_bind_failed raised, critical, naming the port',
      alerts.calls.some((c) => c[0] === 'trigger' && c[1] === 'stratum_bind_failed' && c[2].level === 'critical' &&
        c[2].message.includes(`:${ports.eu}`)));
    ok('the public port serves meanwhile', (await tryConnect(ports.pub)) === 'ok');

    await new Promise((res) => blocker.close(res));
    const r2 = await sp.resume({ by: 'admin:alice' });
    const eu2 = r2.results.find((x) => x.region === 'eu');
    ok('resume while accepting = re-bind: eu now bound, the others already', r2.rebind === true && eu2.bound === true &&
      !eu2.already && r2.results.filter((x) => x.already).length === 2);
    ok('eu accepts after the re-bind', (await tryConnect(ports.eu)) === 'ok');
    ok('the alert is resolved', alerts.calls.some((c) => c[0] === 'resolve' && c[1] === 'stratum_bind_failed'));
    ok('audit: stratum_pause, stratum_resume, stratum_rebind',
      auditActions(db).map((a) => a.action).join(',') === 'stratum_pause,stratum_resume,stratum_rebind');
    server.stop();
  })();

  // ── [7] boot re-derive ─────────────────────────────────────────────────────────────────────
  console.log('[7] boot: expired resumes, future stays paused (nothing bound), unreadable fails closed');
  await quiet(async () => {
    resetDb(db);
    db.prepare(`INSERT INTO stratum_control (id, paused, source, reason, paused_by, since, until)
                VALUES (1, 1, 'manual', 'old', 'admin:alice', ?, ?)`).run(NOW - 3600, NOW - 10);
    const { server, ports } = await makeServer();
    const sp = new StratumPause({ db, stratumServer: server, now, settleMs: 500, tickMs: 60000 });
    const bootPaused = sp.load();
    const startRes = await server.start({ paused: bootPaused });
    const whileBooting = await tryConnect(ports.pub);
    await sp.start();
    const after = await Promise.all([tryConnect(ports.pub), tryConnect(ports.eu)]);
    const audit = auditActions(db);
    ok('expired: load() says paused, start({paused}) binds nothing', bootPaused === true && startRes.length === 0 &&
      whileBooting === 'ECONNREFUSED');
    ok('expired: the boot evaluate resumes', server.acceptState === 'accepting' && after.every((x) => x === 'ok'));
    ok('expired: audit stratum_resume_expired_at_boot (system row, admin_id NULL)',
      audit.length === 1 && audit[0].action === 'stratum_resume_expired_at_boot' && audit[0].admin_id === null);
    ok('expired: row cleared', db.prepare('SELECT paused FROM stratum_control WHERE id = 1').get().paused === 0);
    sp.stop(); server.stop();
  })();

  await quiet(async () => {
    resetDb(db);
    db.prepare(`INSERT INTO stratum_control (id, paused, source, reason, paused_by, since, until)
                VALUES (1, 1, 'restore', 'restored', 'system:restore', ?, ?)`).run(NOW - 60, NOW + 3600);
    const { server, ports } = await makeServer();
    const sp = new StratumPause({ db, stratumServer: server, now, settleMs: 500, tickMs: 60000 });
    server.start({ paused: sp.load() });
    await sp.start();
    const conns = await Promise.all([tryConnect(ports.pub), tryConnect(ports.eu), tryConnect(ports.us)]);
    ok('future: stays paused after the boot evaluate', server.acceptState === 'paused' && sp.isPaused() &&
      sp.status().source === 'restore');
    ok('future: NO port was ever opened', conns.every((x) => x === 'ECONNREFUSED') && server.servers.length === 0,
      conns.join(','));
    ok('future: nothing audited at boot', auditActions(db).length === 0);
    ok('future: a row paused with no settled_at is stamped settled at boot (nothing can be in flight)',
      sp.status().settled_at === NOW &&
      db.prepare('SELECT settled_at FROM stratum_control WHERE id = 1').get().settled_at === NOW);
    NOW += 3601;
    const ev = await sp.evaluate();
    ok('future: the tick auto-resumes at until', ev.actions.includes('resume') && server.acceptState === 'accepting' &&
      (await tryConnect(ports.pub)) === 'ok');
    ok('future: audit stratum_auto_resume', auditActions(db).map((a) => a.action).join(',') === 'stratum_auto_resume');
    sp.stop(); server.stop();
  })();

  await quiet(async () => {
    const server = new StratumServer({ network: 'testnet', stratum_port: 1 }, stubMinerManager());
    const brokenDb = { prepare() { throw new Error('database disk image is malformed'); } };
    const sp = new StratumPause({ db: brokenDb, stratumServer: server, now });
    const paused = sp.load();
    const st = sp.status();
    ok('unreadable row: fails CLOSED — paused, until = now + 2 h', paused === true && st.until === NOW + FAIL_CLOSED_S &&
      st.paused_by === 'system:db_error');
    ok('unreadable row: persisted:false (a restart re-derives again)', st.persisted === false);
    ok('unreadable row: the alert is queued until a monitor exists',
      sp._pendingAlerts.length === 1 && sp._pendingAlerts[0].type === 'stratum_state_unreadable');
    const alerts = stubAlerts();
    server.alertMonitor = alerts;
    sp._flushAlerts();
    ok('…and delivered once the AlertMonitor attaches', alerts.calls.length === 1 && alerts.calls[0][1] === 'stratum_state_unreadable');
  })();

  // ── [8] planned window ─────────────────────────────────────────────────────────────────────
  console.log('[8] planned window: start, end, merge, missed');
  await quiet(async () => {
    resetDb(db);
    const { server, ports } = await makeServer();
    await server.start();
    const sp = new StratumPause({ db, stratumServer: server, now, settleMs: 500, tickMs: 60000 });
    sp.load();
    const start = NOW + WINDOW_LEAD_S + 60;
    const end = start + 600;
    await sp.scheduleWindow({ start, end, reason: 'node upgrade', by: 'admin:bob' });
    ok('window scheduled, stratum still accepting', sp.status().planned.start === start && server.acceptState === 'accepting');
    await sp.evaluate();
    ok('before start: the tick does nothing', server.acceptState === 'accepting');
    NOW = start + 5;
    await sp.evaluate();
    const st = sp.status();
    ok('at start: paused, source planned, until = planned_end, window consumed',
      server.acceptState === 'paused' && st.source === 'planned' && st.until === end && st.planned === null &&
      st.paused_by === 'system:planned' && st.reason === 'node upgrade');
    ok('at start: no listener', (await tryConnect(ports.pub)) === 'ECONNREFUSED');
    ok('cancel while running → 409 "use resume"', await sp.cancelWindow({ by: 'admin:bob' })
      .then(() => false, (e) => e.status === 409 && /resume/.test(e.message)));
    NOW = end;
    await sp.evaluate();
    ok('at end: resumed by the tick', server.acceptState === 'accepting' && (await tryConnect(ports.pub)) === 'ok');
    ok('audit: schedule, window_start, auto_resume',
      auditActions(db).map((a) => a.action).join(',') === 'stratum_window_schedule,stratum_window_start,stratum_auto_resume');

    // Merge: a manual pause running when a window starts runs on to the window's end.
    resetDb(db);
    const s2 = NOW + WINDOW_LEAD_S + 60, e2 = s2 + 3 * 3600;
    await sp.scheduleWindow({ start: s2, end: e2, reason: 'long job', by: 'admin:bob' });
    NOW = s2 - 60;
    await sp.pause({ reason: 'early start', durationMin: 15, by: 'admin:alice' });
    NOW = s2;
    await sp.evaluate();
    ok('merge: until = max(manual until, planned_end), source planned, still paused',
      sp.status().until === e2 && sp.status().source === 'planned' && server.acceptState === 'paused' &&
      sp.status().reason === 'early start');
    ok('merge: audited with merged:true', JSON.parse(auditActions(db).pop().details).merged === true);
    NOW = s2 + 20 * 60;
    await sp.evaluate();
    ok('merge: the manual 15 min no longer ends it', server.acceptState === 'paused');
    ok('resume during a running window ends it', (await sp.resume({ by: 'admin:alice' })).failed === 0 &&
      server.acceptState === 'accepting' && sp.status().planned === null);
    sp.stop(); server.stop();
  })();

  await quiet(async () => {
    resetDb(db);
    const { server } = await makeServer();
    const sp0 = new StratumPause({ db, stratumServer: server, now, tickMs: 60000 });
    sp0.load();
    const start = NOW + WINDOW_LEAD_S + 60;
    await sp0.scheduleWindow({ start, end: start + 600, reason: 'missed one', by: 'admin:bob' });
    NOW = start + 3600;   // the process was down across the whole window
    const sp = new StratumPause({ db, stratumServer: server, now, tickMs: 60000 });
    server.start({ paused: sp.load() });
    const ev = await sp.start();
    ok('missed window: dropped, not paused, audited stratum_window_missed',
      ev.actions.join(',') === 'window_missed' && server.acceptState === 'accepting' && sp.status().planned === null &&
      auditActions(db).pop().action === 'stratum_window_missed');
    ok('missed window: the drop is persisted', db.prepare('SELECT planned_start FROM stratum_control WHERE id = 1').get().planned_start === null);
    sp.stop(); server.stop();

    // A window that started while down but has NOT ended converts at boot.
    resetDb(db);
    const { server: srv2, ports: p2 } = await makeServer();
    const sp1 = new StratumPause({ db, stratumServer: srv2, now, tickMs: 60000 });
    sp1.load();
    const st2 = NOW + WINDOW_LEAD_S + 60;
    await sp1.scheduleWindow({ start: st2, end: st2 + 3600, reason: 'convert me', by: 'admin:bob' });
    NOW = st2 + 600;
    const sp2 = new StratumPause({ db, stratumServer: srv2, now, settleMs: 200, tickMs: 60000 });
    srv2.start({ paused: sp2.load() });
    await sp2.start();
    ok('window started while down, not ended: converted to a pause at boot, nothing ever bound',
      srv2.acceptState === 'paused' && sp2.status().until === st2 + 3600 && (await tryConnect(p2.pub)) === 'ECONNREFUSED');
    sp2.stop(); srv2.stop();
  })();

  // ── [9] caps, conflicts, guard, stop, settings isolation ───────────────────────────────────
  console.log('[9] caps, 409s, transition guard, stop() while paused, settings isolation');
  await quiet(async () => {
    resetDb(db);
    const { server } = await makeServer();
    await server.start();
    const sp = new StratumPause({ db, stratumServer: server, now, settleMs: 200, tickMs: 60000 });
    sp.load();
    const status = (p) => p.then(() => 0, (e) => (e instanceof StratumPauseError ? e.status : -1));

    ok('reason too short → 400', await status(sp.pause({ reason: 'ab', durationMin: 15 })) === 400);
    ok('reason over 300 chars → 400', await status(sp.pause({ reason: 'x'.repeat(301), durationMin: 15 })) === 400);
    ok('duration not in {15,30,60,120} → 400', await status(sp.pause({ reason: 'abc', durationMin: 45 })) === 400 &&
      await status(sp.pause({ reason: 'abc', durationMin: 240 })) === 400);
    ok('extend while not paused → 409', await status(sp.extend({ durationMin: 15 })) === 409);
    ok('cancel with no window → 409', await status(sp.cancelWindow({})) === 409);
    const w = (s, e) => status(sp.scheduleWindow({ start: s, end: e, reason: 'abc' }));
    ok('window lead < 15 min → 400', await w(NOW + 600, NOW + 1800) === 400);
    ok('window shorter than 5 min → 400', await w(NOW + 3600, NOW + 3600 + 240) === 400);
    ok('window longer than 6 h → 400', await w(NOW + 3600, NOW + 3600 + 6 * 3600 + 1) === 400);
    ok('window beyond 30 days → 400', await w(NOW + 31 * 86400, NOW + 31 * 86400 + 600) === 400);
    ok('window times not integers → 400', await w(String(NOW + 3600), NOW + 4200) === 400 &&
      await w(NOW + 3600.5, NOW + 4200) === 400);

    // Two pauses in the same tick: the guard lets exactly one through.
    const [a, b] = await Promise.all([
      status(sp.pause({ reason: 'first', durationMin: 15, by: 'admin:a' })),
      status(sp.pause({ reason: 'second', durationMin: 15, by: 'admin:b' })),
    ]);
    ok('two concurrent pauses: one succeeds, the other 409', [a, b].sort().join(',') === '0,409', `${a},${b}`);
    ok('pause while paused → 409 (use extend)', await status(sp.pause({ reason: 'again', durationMin: 15 })) === 409);
    NOW += 60;
    const ext = await sp.extend({ durationMin: 120, by: 'admin:a' });
    ok('extend sets until = now + duration', ext.state.until === NOW + 7200);
    ok('evaluate during a transition is skipped, never 409', await (async () => {
      const p = sp.resume({ by: 'admin:a' });
      const ev = await sp.evaluate();
      await p;
      return ev.skipped === true;
    })());

    await sp.pause({ reason: 'stop test', durationMin: 15, by: 'admin:a' });
    let threw = false;
    try { server.stop(); sp.stop(); } catch (e) { threw = true; }
    ok('stop() works while paused (and clears the prune timer)', !threw && server._pruneTimer === null);

    // §21.1: the settings tables are written wholesale (section Save / restore / resetAll); none
    // of them can reach the pause row.
    db.exec('DELETE FROM pool_config');
    const sp3 = new StratumPause({ db, stratumServer: new StratumServer({ stratum_port: 1 }, stubMinerManager()), now });
    ok('a wiped pool_config leaves the pause in force', sp3.load() === true);
  })();

  closeDb();
  console.log(fail === 0 ? `ALL PASS — ${pass} passed, 0 failed` : `${fail} FAILED — ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((err) => {
  console.log = realLog;
  console.error('test crashed:', err);
  process.exit(1);
});
