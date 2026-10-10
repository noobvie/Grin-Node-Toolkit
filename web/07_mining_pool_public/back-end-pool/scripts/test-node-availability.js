// Node availability regression tests — design §20 (lib/node-availability.js).
//
// What this pins:
//   [1] origin classification from TAGS, end to end through the real GrinNodeAPI against
//       in-process listeners: refused, timeout, auth (401/403), other (5xx, non-JSON) and a
//       node-replied -32601 envelope error. The 401 must stay 'offline' on the public lamp.
//   [2] the 2-strike rule, backdating, class notes, auth-is-not-downtime, stratum drops and the
//       pool-restart recovery, through the module with a scripted node and an injected clock;
//   [3] recorder ledger ingest: malformed lines (dropped, ONE log line per file per hour), a
//       partial trailing line, truncation replay (no duplicates), rename rotation, and the
//       mapping of down / up / reclass / stop / start / gap to rows;
//   [4] availability maths (sweep precedence, uptime %, MTBF);
//   [5] the public `up_days`: source order, staleness, the UTC-day quantisation, null (never 0)
//       for unknown — and that /api/pool/status can carry no timestamp;
//   [6] the homepage lamp (public_html/js/reactor-dashboard.js): fmtUpDays run on its own for
//       0 / 1 / 59 / 60 / 400 / 800 / null and the malformed values, plus the lamp wiring.
//
// In-process only: listeners bind 127.0.0.1 on ephemeral ports and are closed; the DB is
// :memory:; the fake /opt/grin/node-events lives in os.tmpdir() and is removed. Nothing is left
// running. Run: node scripts/test-node-availability.js
const fs = require('fs');
const os = require('os');
const net = require('net');
const http = require('http');
const path = require('path');
const { readAppSource, routeSource } = require('./lib/app-source');
const fetch = require('node-fetch');

const APP = path.resolve(__dirname, '..');
const GrinNodeAPI = require(path.join(APP, 'lib/grin-node.js'));
const NodeAvailability = require(path.join(APP, 'lib/node-availability.js'));
const { classifyProbe, stepProbe, upDaysFrom, parseLedgerLine, sweep, summarise } = NodeAvailability;
const { initDb, getDb, closeDb } = require(path.join(APP, 'lib/db.js'));

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${extra ? ' — ' + extra : ''}`); }
};

const listenHttp = (handler) => new Promise((resolve) => {
  const srv = http.createServer(handler);
  srv.listen(0, '127.0.0.1', () => resolve(srv));
});
const listenTcp = (onConn) => new Promise((resolve) => {
  const srv = net.createServer(onConn);
  srv.listen(0, '127.0.0.1', () => resolve(srv));
});
const close = (srv) => new Promise((resolve) => srv.close(() => resolve()));
const api = (port) => new GrinNodeAPI({
  node_api_url: `http://127.0.0.1:${port}`, network: 'mainnet',
  node_api_secret: 'test-secret', node_foreign_api_secret: 'test-secret',
});

const D0 = Date.UTC(2026, 9, 3) / 1000;   // 2026-10-03 00:00 UTC
const quiet = () => {};

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pool-node-avail-'));
  initDb(':memory:');
  const db = getDb();
  try {
    // ───────────────────────────────────────────────────────────────────────────────────────────
    console.log('\n[1] origin classification from tags (real GrinNodeAPI, in-process listeners)\n');

    const answer = (status, body, type = 'application/json') => (req, res) => {
      req.resume();
      req.on('end', () => { res.writeHead(status, { 'Content-Type': type }); res.end(body); });
    };
    const s401 = await listenHttp(answer(401, 'Unauthorized', 'text/plain'));
    const s403 = await listenHttp(answer(403, 'Forbidden', 'text/plain'));
    const s502 = await listenHttp(answer(502, '<html>Bad Gateway</html>', 'text/html'));
    const sHtml = await listenHttp(answer(200, '<html>parked domain</html>', 'text/html'));
    const sEnv = await listenHttp(answer(200, JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'Method not found' } })));
    const sErr = await listenHttp(answer(200, JSON.stringify({ jsonrpc: '2.0', id: 1, result: { Err: { Internal: 'chain error' } } })));
    const sOk = await listenHttp(answer(200, JSON.stringify({ jsonrpc: '2.0', id: 1, result: { Ok: { tip: { height: 7, total_difficulty: 1 }, sync_status: 'no_sync', connections: '8' } } })));
    const refusedPort = await (async () => { const s = await listenTcp(() => {}); const p = s.address().port; await close(s); return p; })();

    const st = {};
    for (const [k, srv] of Object.entries({ s401, s403, s502, sHtml, sEnv, sErr, sOk })) st[k] = await api(srv.address().port).getStatus();
    st.refused = await api(refusedPort).getStatus();

    ok('401 → transport auth, http_status 401, nodeReplied false',
      st.s401.transport === 'auth' && st.s401.http_status === 401 && st.s401.nodeReplied === false, JSON.stringify(st.s401));
    ok('403 → transport auth', st.s403.transport === 'auth' && st.s403.http_status === 403);
    ok('502 → transport other with http_status 502', st.s502.transport === 'other' && st.s502.http_status === 502);
    ok('a 200 non-JSON page → other, no http_status', st.sHtml.transport === 'other' && st.sHtml.http_status === null && st.sHtml.nodeReplied === false);
    ok('refused → transport refused', st.refused.transport === 'refused' && st.refused.nodeReplied === false);
    ok('-32601 envelope → nodeReplied true (transport stays other, as before)',
      st.sEnv.nodeReplied === true && st.sEnv.transport === 'other', JSON.stringify(st.sEnv));
    ok('result.Err → nodeReplied true', st.sErr.nodeReplied === true);
    ok('Ok → ok:true', st.sOk.ok === true && st.sOk.height === 7);

    // Timeout: provoke the real node-fetch error shape quickly (the API's own timeout is 10 s).
    const held = [];
    const silent = await listenTcp((sock) => { held.push(sock); });
    let tErr = null;
    try { await fetch(`http://127.0.0.1:${silent.address().port}/v2/owner`, { method: 'POST', body: '{}', timeout: 300 }); } catch (e) { tErr = e; }
    ok('a silent listener is classified timeout', tErr && GrinNodeAPI.classifyTransport(tErr) === 'timeout');
    ok('a plain HTTP-looking Error with no httpStatus tag is other, never auth',
      GrinNodeAPI.classifyTransport(new Error('HTTP 401: Unauthorized')) === 'other');
    for (const s of held) s.destroy();   // server.close() waits for open sockets
    await close(silent);

    const c = (s, d) => classifyProbe(s, d);
    ok('verdict: ok', c(st.sOk).kind === 'ok');
    ok('verdict: 401 → auth / origin auth (not a failure)', c(st.s401).kind === 'auth' && c(st.s401).origin === 'auth');
    ok('verdict: timeout → fail transport/timeout', JSON.stringify(c({ ok: false, transport: 'timeout' })) === JSON.stringify({ kind: 'fail', origin: 'transport', cls: 'timeout' }));
    ok('verdict: refused + starting → class starting', c(st.refused, 'starting').cls === 'starting');
    ok('verdict: refused + offline → class refused', c(st.refused, 'offline').cls === 'refused');
    ok('verdict: 502 → transport/other', c(st.s502).origin === 'transport' && c(st.s502).cls === 'other');
    ok('verdict: -32601 → node_reply/node_error', c(st.sEnv).origin === 'node_reply' && c(st.sEnv).cls === 'node_error');
    ok('verdict never reads the message: a message saying "401" with transport timeout is timeout',
      c({ ok: false, transport: 'timeout', error: 'HTTP 401 auth Method not found' }).cls === 'timeout');

    const lampNode = api(1);
    lampNode.procRoot = path.join(tmp, 'no-proc');
    ok('downState(auth) is still offline — the public lamp does not move',
      await lampNode.downState(st.s401) === 'offline');

    for (const s of [s401, s403, s502, sHtml, sEnv, sErr, sOk]) await close(s);

    // ───────────────────────────────────────────────────────────────────────────────────────────
    console.log('\n[2] pool probe: 2 strikes, backdating, auth, stratum, restart recovery\n');

    let p = { strikes: 0, firstFailTs: null, downOpen: false, faultOpen: false };
    let r = stepProbe(p, { kind: 'fail', origin: 'transport', cls: 'timeout' }, 100);
    ok('one failed probe is not an outage', r.ops.length === 0 && r.next.strikes === 1 && r.next.firstFailTs === 100);
    r = stepProbe(r.next, { kind: 'ok' }, 130);
    ok('a blip then ok: strikes reset, still no outage', r.ops.length === 0 && r.next.strikes === 0);
    r = stepProbe(r.next, { kind: 'fail', origin: 'transport', cls: 'refused' }, 160);
    r = stepProbe(r.next, { kind: 'fail', origin: 'transport', cls: 'refused' }, 190);
    ok('two consecutive failures open DOWN backdated to the first',
      r.ops.length === 1 && r.ops[0].op === 'open_down' && r.ops[0].at === 160 && r.next.downOpen);
    r = stepProbe(r.next, { kind: 'auth', origin: 'auth', cls: 'auth' }, 220);
    ok('auth while down closes the outage (the node answered) and opens a fault',
      r.ops.map((o) => o.op).join(',') === 'close_down,open_fault' && !r.next.downOpen && r.next.faultOpen);
    r = stepProbe({ strikes: 1, firstFailTs: 50, downOpen: false, faultOpen: false }, { kind: 'auth', origin: 'auth', cls: 'auth' }, 60);
    ok('auth never counts as a strike', r.next.strikes === 0 && !r.ops.some((o) => o.op === 'open_down'));

    // Through the module, scripted node + injected clock.
    let clock = D0 + 3600;
    const script = [];
    const fakeNode = {
      getStatus: async () => script.shift(),
      downState: async (s) => (s && s.transport === 'refused' && s._proc ? 'starting' : 'offline'),
    };
    const eventsDir = path.join(tmp, 'node-events');
    const mk = () => new NodeAvailability({ network: 'mainnet', node_events_dir: eventsDir }, db, fakeNode,
      { now: () => clock, log: quiet, warn: quiet });
    const na = mk();
    const OK = { ok: true }, TO = { ok: false, transport: 'timeout', nodeReplied: false },
      RF = { ok: false, transport: 'refused', nodeReplied: false }, RFP = { ok: false, transport: 'refused', nodeReplied: false, _proc: true },
      AU = { ok: false, transport: 'auth', nodeReplied: false, http_status: 401 },
      ENV = { ok: false, transport: 'other', nodeReplied: true };
    const probeAt = async (s, t) => { clock = t; script.push(s); await na.probeOnce(); };
    const poolRows = () => db.prepare("SELECT * FROM node_events WHERE source = 'pool' ORDER BY id").all();

    await probeAt(OK, D0 + 3600);
    await probeAt(TO, D0 + 3630);
    await probeAt(OK, D0 + 3660);
    ok('steady + one blip: no pool rows', poolRows().length === 0);
    await probeAt(RF, D0 + 3690);
    await probeAt(RFP, D0 + 3720);
    let rows = poolRows();
    ok('two failures: one DOWN row, backdated, class from the tipping probe, origin transport',
      rows.length === 1 && rows[0].state === 'down' && rows[0].started_at === D0 + 3690 && rows[0].class === 'starting' &&
      rows[0].origin === 'transport' && rows[0].ended_at === null, JSON.stringify(rows));
    ok('detail is our own words, never err.message', /node process for this network is running/.test(rows[0].detail));
    na.noteStratumLink(false);
    await probeAt(TO, D0 + 3750);
    await probeAt(OK, D0 + 3780);
    rows = poolRows();
    ok('recovery closes it with the duration and the classes seen + the stratum drop',
      rows[0].ended_at === D0 + 3780 && rows[0].duration_s === 90 && /seen: starting → timeout/.test(rows[0].detail) &&
      /node stratum dropped ×1/.test(rows[0].detail), JSON.stringify(rows[0]));
    ok('the pool reachable-since is the end of that outage', na.poolReachableSince() === D0 + 3780);

    await probeAt(AU, D0 + 3810);
    rows = poolRows();
    ok('auth opens a FAULT row (origin auth), never a down row',
      rows.length === 2 && rows[1].state === 'fault' && rows[1].class === 'auth' && rows[1].origin === 'auth' && /HTTP 401/.test(rows[1].detail));
    await probeAt(OK, D0 + 3840);
    ok('ok closes the fault', poolRows()[1].ended_at === D0 + 3840);

    await probeAt(ENV, D0 + 3870);
    await probeAt(ENV, D0 + 3900);
    rows = poolRows();
    ok('a -32601 envelope error ×2 → DOWN origin node_reply / node_error',
      rows[2].state === 'down' && rows[2].origin === 'node_reply' && rows[2].class === 'node_error');
    ok('reachable-since is null while the pool\'s own outage is open', na.poolReachableSince() === null);
    await probeAt(OK, D0 + 3930);

    clock = D0 + 3940;
    na.noteStratumLink(false);
    rows = poolRows();
    ok('a stratum drop with the API up → a degraded stratum_drop row',
      rows[3].state === 'degraded' && rows[3].class === 'stratum_drop' && rows[3].ended_at === null);
    clock = D0 + 3950;
    na.noteStratumLink(true);
    ok('…closed on reconnect', poolRows()[3].ended_at === D0 + 3950 && poolRows()[3].duration_s === 10);

    ok('alert-monitor gets the fresh probe instead of a second call', na.recentStatus() === OK);

    // Pool restart: an open outage closes at the last heartbeat; the gap is unobserved.
    await probeAt(TO, D0 + 4000);
    await probeAt(TO, D0 + 4030);
    clock = D0 + 4040;
    await na.tick();                    // heartbeat at 4040 (no ledger yet → recorder absent)
    ok('no ledger file → recorder state absent, not an error', na.recorder.state === 'absent');
    na.stop();
    clock = D0 + 4040 + 1800;           // the pool was gone for 30 min
    const na2 = mk();
    na2._recoverOnBoot();
    rows = poolRows();
    const reopened = rows.find((x) => x.started_at === D0 + 4000);
    ok('restart: the open outage is closed at the last heartbeat', reopened && reopened.ended_at === D0 + 4040 && /pool restarted/.test(reopened.detail));
    const gap = rows[rows.length - 1];
    ok('restart: the time the pool was not running is an unobserved row',
      gap.state === 'unobserved' && gap.started_at === D0 + 4040 && gap.ended_at === D0 + 5840);
    script.push(OK); clock = D0 + 5850; await na2.probeOnce();
    ok('a gap longer than GAP_RESET_S resets reachable-since to its end', na2.poolReachableSince() === D0 + 5840);

    // ───────────────────────────────────────────────────────────────────────────────────────────
    console.log('\n[3] recorder ledger ingest\n');

    const nd = path.join(eventsDir, 'mainnet');
    fs.mkdirSync(nd, { recursive: true });
    const ledger = path.join(nd, 'ledger.jsonl');
    const T = D0 + 10000;
    let seq = 0;
    const L = (o) => JSON.stringify(Object.assign({ v: 1, net: 'mainnet', id: `mainnet-${o.ts}-${seq++}` }, o));
    const recRows = () => db.prepare("SELECT * FROM node_events WHERE source = 'recorder' ORDER BY id").all();
    const warns = [];
    const ing = new NodeAvailability({ network: 'mainnet', node_events_dir: eventsDir }, db, fakeNode,
      { now: () => clock, log: quiet, warn: (m) => warns.push(m) });
    clock = T + 5000;

    const downLine = L({ ts: T, event: 'down', state: 'down', class: 'crashed', class_initial: 'unexplained_stop', sub: 'rc=101', started_at: T - 30, rc: 101, evidence: '20261003T024640Z_crashed', reason: 'node exited; peer 203.0.113.7:3414 dropped' });
    const downId = JSON.parse(downLine).id;
    const partial = L({ ts: T + 60, event: 'restart_by_watchdog', outage_id: downId, by: 'grin-node-sync-watchdog', reason: 'not responding' });
    fs.writeFileSync(ledger, L({ ts: T - 100, event: 'recorder_start', state: 'unknown' }) + '\n' + downLine + '\n' + partial.slice(0, 20));
    await ing.ingestOnce();
    rows = recRows();
    ok('complete lines ingested; the partial trailing line waits',
      rows.length === 2 && rows[1].state === 'down' && rows[1].recorder_event_id === downId, JSON.stringify(rows.map((x) => x.state)));
    ok('down row: backdated started_at, refined class, detail names the initial class + evidence',
      rows[1].started_at === T - 30 && rows[1].class === 'crashed' && /initially unexplained_stop/.test(rows[1].detail) && /evidence: 20261003T024640Z_crashed/.test(rows[1].detail));
    ok('an IP in the recorder reason is masked in detail', !/203\.0\.113\.7/.test(rows[1].detail) && /x\.x\.x\.x/.test(rows[1].detail));
    const offAfterPartial = parseInt(db.prepare("SELECT value FROM node_availability_meta WHERE network='mainnet' AND key='rec_offset'").get().value, 10);
    ok('the cursor stops at the last newline', offAfterPartial === Buffer.byteLength(fs.readFileSync(ledger, 'utf8')) - 20);

    fs.appendFileSync(ledger, partial.slice(20) + '\n');
    await ing.ingestOnce();
    rows = recRows();
    ok('the completed line is picked up next tick (a restart row)', rows.length === 3 && rows[2].state === 'restart');

    const bad = [
      'not json at all',
      JSON.stringify({ v: 2, net: 'mainnet', id: `mainnet-${T}-99`, ts: T, event: 'up' }),
      JSON.stringify({ v: 1, net: 'testnet', id: `testnet-${T}-99`, ts: T, event: 'up' }),
      JSON.stringify({ v: 1, net: 'mainnet', id: 'mainnet-1-x', ts: T, event: 'up' }),
      JSON.stringify({ v: 1, net: 'mainnet', id: `mainnet-${T}-98`, ts: T + 0.5, event: 'up' }),
      `{"v":1,"net":"mainnet","id":"mainnet-${T}-97","ts":18446744073709551615,"event":"up"}`,
      JSON.stringify({ v: 1, net: 'mainnet', id: `mainnet-${T}-96`, ts: T, event: 'rm -rf' }),
      '[1,2,3]',
      JSON.stringify({ v: 1, net: 'mainnet', id: `mainnet-${T}-95`, ts: T, event: 'info', __proto__: { x: 1 } }),
      'x'.repeat(3000),
    ];
    fs.appendFileSync(ledger, bad.join('\n') + '\n');
    await ing.ingestOnce();
    ok('ten malformed lines: none inserted', recRows().length === 3);
    ok('…and exactly ONE log line for the file', warns.filter((w) => /malformed/.test(w)).length === 1 && /dropped 10 malformed/.test(warns.find((w) => /malformed/.test(w)) || ''),
      JSON.stringify(warns));
    fs.appendFileSync(ledger, 'still junk\n');
    await ing.ingestOnce();
    ok('more junk within the hour → no second log line', warns.filter((w) => /malformed/.test(w)).length === 1);

    const u64 = `{"v":1,"net":"mainnet","id":"mainnet-${T + 90}-0","ts":${T + 90},"event":"probe_error","pid":12345678901234567890,"duration_s":1e400}`;
    fs.appendFileSync(ledger, u64 + '\n');
    await ing.ingestOnce();
    rows = recRows();
    ok('a u64 pid / huge number in an OPTIONAL field is nulled, the line is kept, nothing throws',
      rows.length === 4 && rows[3].state === 'info');

    fs.appendFileSync(ledger, L({ ts: T + 200, event: 'reclass', state: 'down', class: 'corrupted', class_initial: 'crashed', outage_id: downId }) + '\n');
    fs.appendFileSync(ledger, L({ ts: T + 600, event: 'up', state: 'up', outage_id: downId, duration_s: 630 }) + '\n');
    await ing.ingestOnce();
    const down = db.prepare('SELECT * FROM node_events WHERE recorder_event_id = ?').get(downId);
    ok('reclass updates the outage class', down.class === 'corrupted' && /reclassified from crashed/.test(down.detail));
    ok('up closes the outage at started_at + duration_s', down.ended_at === T - 30 + 630 && down.duration_s === 630);

    const nBefore = recRows().length;
    // Truncation: the file is rewritten shorter (same inode) → offset resets, replay is absorbed.
    const all = fs.readFileSync(ledger, 'utf8').split('\n');
    fs.writeFileSync(ledger, all.slice(0, 2).join('\n') + '\n');
    await ing.ingestOnce();
    ok('truncation replay inserts no duplicates', recRows().length === nBefore);
    ok('…and a replayed down line does not reopen the closed outage',
      db.prepare('SELECT ended_at FROM node_events WHERE recorder_event_id = ?').get(downId).ended_at === T - 30 + 630);

    // Rename rotation: an unread tail in the old file + a new file.
    const tailLine = L({ ts: T + 700, event: 'stop', state: 'stopped', by: '01_build_new_grin_node.sh', reason: 'rebuild' });
    fs.appendFileSync(ledger, tailLine + '\n');
    fs.renameSync(ledger, ledger + '.1');
    fs.writeFileSync(ledger, L({ ts: T + 800, event: 'start', state: 'starting', by: '01_build_new_grin_node.sh' }) + '\n' +
      L({ ts: T + 1200, event: 'up', state: 'up' }) + '\n' +
      L({ ts: T + 1300, event: 'gap', state: 'up', observed_gap_s: 400 }) + '\n');
    await ing.ingestOnce();
    rows = recRows();
    const stopRow = rows.find((x) => x.recorder_event_id === JSON.parse(tailLine).id);
    ok('rotation: the unread tail of ledger.jsonl.1 is finished first', !!stopRow, JSON.stringify(rows.map((x) => x.state)));
    ok('stop → a planned row, closed by the next up', stopRow && stopRow.state === 'planned' && stopRow.ended_at === T + 1200);
    ok('start outside an outage → a planned point row', rows.some((x) => x.state === 'planned' && x.started_at === T + 800 && x.ended_at === T + 800));
    ok('gap → an unobserved interval', rows.some((x) => x.state === 'unobserved' && x.started_at === T + 900 && x.ended_at === T + 1300));

    // R2: a recorder_start after earlier lines (a ledger restored by 089, or a re-install that lost
    // status.json) means nobody watched since the previous line — 086's dgr_availability counts that
    // span unobserved, and so must the pool, or a 40-day hole reads as 40 days up. Its own network
    // (testnet), so the mainnet rows the [4] maths pins are untouched.
    {
      const tnd = path.join(eventsDir, 'testnet');
      fs.mkdirSync(tnd, { recursive: true });
      const TL = (ts, event, state) => JSON.stringify({ v: 1, net: 'testnet', id: `testnet-${ts}-0`, ts, event, state });
      const t0 = T - 60 * 86400;
      fs.writeFileSync(path.join(tnd, 'ledger.jsonl'), [TL(t0, 'recorder_start', 'unknown'), TL(t0 + 60, 'up', 'up'),
        TL(t0 + 10 * 86400, 'probe_error', 'up'), TL(t0 + 50 * 86400, 'recorder_start', 'unknown'),
        TL(t0 + 50 * 86400 + 60, 'up', 'up')].join('\n') + '\n');
      const tna = new NodeAvailability({ network: 'testnet', node_events_dir: eventsDir }, db, fakeNode, { now: () => clock, log: quiet, warn: quiet });
      await tna.ingestOnce();
      const trows = db.prepare("SELECT * FROM node_events WHERE network = 'testnet' AND source = 'recorder' ORDER BY id").all();
      ok('recorder_start after earlier lines → unobserved from the previous line to it',
        trows.some((x) => x.state === 'unobserved' && x.started_at === t0 + 10 * 86400 && x.ended_at === t0 + 50 * 86400),
        JSON.stringify(trows.map((x) => [x.state, x.started_at - t0, x.ended_at - t0])));
      ok('…the FIRST recorder_start (nothing before it) stays an info point',
        trows[0].state === 'info' && trows[0].started_at === t0 && trows[0].ended_at === t0);
      db.prepare("DELETE FROM node_events WHERE network = 'testnet'").run();
      db.prepare("DELETE FROM node_availability_meta WHERE network = 'testnet'").run();
    }

    // ───────────────────────────────────────────────────────────────────────────────────────────
    console.log('\n[4] availability maths\n');

    const segs = sweep([
      { a: 10, b: 50, cat: 'down' }, { a: 40, b: 60, cat: 'unobserved' },
      { a: 70, b: 80, cat: 'planned' }, { a: 75, b: 90, cat: 'down' },
    ], 0, 100);
    const sum = summarise(segs, 0, 100);
    // 0-10 up · 10-40 down · 40-60 unobserved (beats down) · 60-70 up · 70-75 planned ·
    // 75-90 down (beats planned) · 90-100 up
    ok('precedence unobserved > down > planned > up', sum.down_s === 30 + 15 && sum.unobserved_s === 20 && sum.planned_s === 5 && sum.up_s === 30,
      JSON.stringify(sum));
    ok('uptime % = up ÷ (up + down), floored', sum.uptime_pct === 40);
    ok('a non-round % is floored, so a real outage never shows 100.00',
      summarise(sweep([{ a: 0, b: 1, cat: 'down' }], 0, 100000), 0, 100000).uptime_pct === 99.99);
    ok('no observed time → uptime null, never 100', summarise(sweep([{ a: 0, b: 10, cat: 'unobserved' }], 0, 10), 0, 10).uptime_pct === null);

    clock = T + 2000;
    fs.writeFileSync(path.join(nd, 'status.json'), JSON.stringify({ v: 1, net: 'mainnet', updated: clock - 10, state: 'up', up_since: T + 1200 }));
    ing._statusMemo = { at: 0, val: null };
    const av = ing.availability(7 * 86400);
    const rec = av.sources.recorder;
    // The stop (T+700) is planned until the up (T+1200), but the gap [T+900, T+1300] is
    // unobserved and wins, so planned is T+700..T+900 = 200 s.
    ok('recorder source: one corrupted outage; planned excluded from the %',
      rec.outages === 1 && rec.by_class.corrupted === 1 && rec.down_s === 630 && rec.planned_s === 200 &&
      rec.uptime_pct === Math.floor(rec.up_s * 10000 / (rec.up_s + 630)) / 100, JSON.stringify({ ...rec, daily: undefined }));
    ok('pool and recorder are reported side by side, never merged', av.sources.pool && av.sources.recorder && av.sources.pool.outages !== undefined);
    ok('MTBF = up ÷ outages started', rec.mtbf_s === Math.floor(rec.up_s / rec.outages));
    ok('daily series covers every UTC day of the range', rec.daily.length === 8 && /^\d{4}-\d{2}-\d{2}$/.test(rec.daily[0].day));
    ok('range parser: 7d/30d/90d/1y, default 30d, junk → null',
      NodeAvailability.parseRange('1y').secs === 365 * 86400 && NodeAvailability.parseRange(undefined).key === '30d' &&
      NodeAvailability.parseRange('toString') === null && NodeAvailability.parseRange('5d') === null);

    // ───────────────────────────────────────────────────────────────────────────────────────────
    console.log('\n[5] public up_days\n');

    ok('upDaysFrom: came up today → 0', upDaysFrom(D0 + 60, D0 + 3600) === 0);
    ok('upDaysFrom: up since one second before today\'s midnight → 0 (flips only at 00:00 UTC)', upDaysFrom(D0 - 1, D0 + 80000) === 0);
    ok('upDaysFrom: a full day before midnight → 1', upDaysFrom(D0 - 86400, D0 + 10) === 1);
    ok('upDaysFrom: 400 days', upDaysFrom(D0 - 400 * 86400, D0 + 5) === 400);
    ok('upDaysFrom: future / invalid → null', upDaysFrom(D0 + 10, D0) === null && upDaysFrom(null, D0) === null && upDaysFrom(1.5, D0) === null);

    clock = D0 + 20 * 86400 + 3600;
    const writeStatus = (o) => { fs.writeFileSync(path.join(nd, 'status.json'), JSON.stringify(Object.assign({ v: 1, net: 'mainnet' }, o))); ing._statusMemo = { at: 0, val: null }; };
    writeStatus({ updated: clock - 30, state: 'up', up_since: D0 - 5 * 86400 });
    ing.lastVerdict = null;
    ok('source 1: a fresh recorder status that is up → its up_since (25 d)', ing.upDaysPublic(true) === 25);
    ok('not reachable right now → null, whatever the history', ing.upDaysPublic(false) === null);
    writeStatus({ updated: clock - 121, state: 'up', up_since: D0 - 5 * 86400 });
    ok('a stale status (>120 s) is ignored; no pool probe yet → null, never 0', ing.upDaysPublic(true) === null);
    writeStatus({ updated: clock - 30, state: 'down', up_since: D0 - 5 * 86400 });
    ok('a recorder status that is not up is ignored', ing.upDaysPublic(true) === null);
    writeStatus({ updated: clock - 30, state: 'up', up_since: clock + 999 });
    ok('a recorder up_since in the future is rejected', ing.upDaysPublic(true) === null);
    // Source 2: the same instance has no first probe in its own meta? It shares the mainnet meta
    // with the probes above, whose last outage ended at D0 + 5840 (the long pool gap).
    ing.lastVerdict = { at: Date.now(), kind: 'ok' };
    writeStatus({ updated: clock - 500, state: 'up', up_since: D0 - 5 * 86400 });
    // reachable-since = D0 + 5840 (end of the long pool gap, day 0 01:37); now = day 20 01:00 →
    // 19 whole days before today's 00:00 UTC.
    ok('source 2: stale recorder → the pool\'s own reachable-since (19 d)', ing.upDaysPublic(true) === 19, String(ing.upDaysPublic(true)));
    ing.lastVerdict = { at: Date.now(), kind: 'fail' };
    ok('source 2 is null while the pool\'s own probe is failing', ing.upDaysPublic(true) === null);
    fs.writeFileSync(path.join(nd, 'status.json'), '{"v":1,"net":"mainnet","updated":');
    ing._statusMemo = { at: 0, val: null };
    ok('a garbled status.json never throws out of upDaysPublic', ing.upDaysPublic(true) === null);
    ok('upDaysPublic returns only an integer or null', [true, false].every((x) => { const v = ing.upDaysPublic(x); return v === null || Number.isSafeInteger(v); }));

    // The public route: the node object can carry no timestamp.
    const indexSrc = readAppSource();
    const a0 = indexSrc.indexOf('const buildPoolStatus = async () => {');
    // The builder sits directly above its route in routes/pool.js; the route's own source is the end marker.
    const routeText = routeSource('get', '/api/pool/status');   // throws if absent
    const a1 = indexSrc.indexOf(routeText);
    const builder = indexSrc.slice(a0, a1);
    ok('buildPoolStatus found', a0 > 0 && a1 > a0);
    const keys = new Set((builder.match(/^\s+([a-z_]+):/gm) || []).map((k) => k.trim().replace(':', '')));
    const allowed = new Set(['pool', 'ok', 'node', 'reachable', 'state', 'synced', 'peers', 'height', 'up_days', 'wallet']);
    ok('the public status builder emits only the allowed keys (no *_at, since, timestamp, class, error)',
      [...keys].every((k) => allowed.has(k)), JSON.stringify([...keys]));
    ok('up_days comes from upDaysPublic and defaults to null in every shape',
      /up_days: nodeAvailability \? nodeAvailability\.upDaysPublic\(true\) : null/.test(builder) &&
      (indexSrc.match(/height: 0, up_days: null \}/g) || []).length === 2);
    ok('the admin routes sit behind secureAdmin',
      /app\.get\('\/api\/admin\/node-events', secureAdmin/.test(indexSrc) && /app\.get\('\/api\/admin\/node-availability', secureAdmin/.test(indexSrc));
    ok('the node_down alert reuses the fresh probe', /nodeAvailability\.recentStatus\(\)/.test(fs.readFileSync(path.join(APP, 'lib/alert-monitor.js'), 'utf8')));
    const naSrc = fs.readFileSync(path.join(APP, 'lib/node-availability.js'), 'utf8');
    ok('node-availability never classifies on message text', !/\.message\.includes|\.error\.includes|status\.error/.test(naSrc));
    ok('node-availability never touches block-monitor or a money module',
      !/require\(['"]\.\/(block-monitor|rewards|orphan-detector|withdrawal-scheduler|reconciliation|wallet)/.test(naSrc));

    // ───────────────────────────────────────────────────────────────────────────────────────────
    console.log('\n[6] homepage lamp: up_days → text (Part 8)\n');

    // The formatter is lifted out of the page and run on its own, like test-connect-suggest's
    // pickRecommended. The web root deploys apart from the app, so a deployed app dir has no
    // public_html/ → SKIP there; from the repo a missing function is a FAIL.
    const PAGE = path.resolve(APP, '../public_html/js/reactor-dashboard.js');
    if (!fs.existsSync(PAGE)) {
      console.log(`  SKIP  ${PAGE} not present (a deployed app dir has no public_html/) — run from the repo`);
    } else {
      const pageSrc = fs.readFileSync(PAGE, 'utf8');
      const fm = /\n( *)function fmtUpDays\(days\) \{[\s\S]*?\n\1\}\n/.exec(pageSrc);
      ok('the page defines fmtUpDays(days)', !!fm);
      let fmt = null;
      try { fmt = fm ? new Function(`${fm[0]}; return fmtUpDays;`)() : null; } catch (e) { fmt = null; }
      ok('fmtUpDays is self-contained (evaluates on its own)', typeof fmt === 'function');
      if (typeof fmt === 'function') {
        const shown = (d) => { const r = fmt(d); return r === null ? null : r.short.replace(/\u00a0/g, ' '); };
        const cases = [[0, 'up <1 d'], [1, 'up 1 d'], [59, 'up 59 d'], [60, 'up 1 mo'], [400, 'up 13 mo'],
          [729, 'up 23 mo'], [730, 'up 1.9 y'], [800, 'up 2.1 y'], [1461, 'up 4.0 y'], [null, null]];
        for (const [d, want] of cases) ok(`up_days ${d} → ${want === null ? 'no text (null)' : '"' + want + '"'}`, shown(d) === want, String(shown(d)));
        ok('unknown or malformed → null, never "up 0 d": undefined, -1, 1.5, "12", NaN, Infinity',
          [undefined, -1, 1.5, '12', NaN, Infinity].every((d) => fmt(d) === null));
        ok('the short form has no breakable space (it must never split across the lamp\'s rows)',
          [0, 7, 100, 5000].every((d) => !/ /.test(fmt(d).short)));
        ok('the hover is the long form: "at least N days", singular for 1, its own wording for 0',
          fmt(12).long === 'Node continuously available for at least 12 days (counted in whole UTC days)' &&
          / 1 day /.test(fmt(1).long) && /yesterday or today/.test(fmt(0).long));
      }
      // The wiring around it. Static, because the lamp code reads the live DOM.
      const ls = pageSrc.slice(pageSrc.indexOf('async function loadStatus()'), pageSrc.indexOf('// Fuel rods:'));
      ok('uptime is shown only on a synced node (dropped while "· sync" holds the row)',
        /var nodeUp = nodeSynced \? fmtUpDays\(s\.node\.up_days\) : null;/.test(ls));
      ok('the uptime is its own .lamp-up row, written with textContent',
        /upLine\.className = 'lamp-up';/.test(ls) && /upLine\.textContent = ' ' \+ nodeUp\.short;/.test(ls) && !/innerHTML/.test(ls));
      ok('the lamp title is set from the long form and cleared on every other path, including the catch',
        /nodeLampEl\.title = nodeUp\.long;/.test(ls) && /nodeLampEl\.removeAttribute\('title'\)/.test(ls) &&
        /nodeLampErr\.removeAttribute\('title'\)/.test(ls));
      const css = fs.readFileSync(path.resolve(APP, '../public_html/css/reactor.css'), 'utf8');
      ok('reactor.css makes .lamp-up a block row', /\.lamp-up\s*\{\s*display:\s*block;/.test(css));
    }

    // ───────────────────────────────────────────────────────────────────────────────────────────
    console.log('\n[7] R2 review regressions (testnet rows, isolated from the sections above)\n');
    {
      const tRows = (src) => db.prepare('SELECT * FROM node_events WHERE network = \'testnet\' AND source = ? ORDER BY id').all(src);
      const mkT = () => new NodeAvailability({ network: 'testnet', node_events_dir: eventsDir }, db, fakeNode,
        { now: () => clock, log: quiet, warn: quiet });
      const probeT = async (inst, s, t) => { clock = t; script.push(s); await inst.probeOnce(); };
      const T7 = D0 + 20000;

      // A short pool restart keeps the outage it interrupted: one outage, not two with a fake up gap.
      const ta = mkT();
      await probeT(ta, TO, T7);
      await probeT(ta, TO, T7 + 30);
      const downId = ta.openPool.down;
      ok('setup: two strikes opened a pool outage', !!downId);
      ta.stop();                                   // heartbeat at T7 + 30
      clock = T7 + 30 + 45;                        // back 45 s later (≤ UNOBSERVED_MIN_S)
      const tb = mkT();
      tb._recoverOnBoot();
      ok('short restart: the open outage is re-adopted, not closed at the heartbeat',
        tb.openPool.down === downId && tRows('pool').find((x) => x.id === downId).ended_at === null);
      await probeT(tb, OK, T7 + 120);
      const downs = tRows('pool').filter((x) => x.state === 'down');
      ok('…and the first ok probe closes it: ONE outage spanning the restart',
        downs.length === 1 && downs[0].started_at === T7 && downs[0].ended_at === T7 + 120, JSON.stringify(downs));

      // Retention pruning the last pool outage row must not move "reachable since" back to the first probe.
      ok('setup: reachable since = the outage end', tb.poolReachableSince() === T7 + 120);
      db.prepare("DELETE FROM node_events WHERE network = 'testnet' AND source = 'pool' AND state = 'down'").run();
      ok('pruned outage row: reachable since still the outage end (pool_reach_floor), not the first probe',
        tb.poolReachableSince() === T7 + 120);

      // An `up` closes an orphaned recorder outage whose own closing line was never ingested.
      const tnd = path.join(eventsDir, 'testnet');
      fs.mkdirSync(tnd, { recursive: true });
      const TL = (o) => JSON.stringify(Object.assign({ v: 1, net: 'testnet' }, o));
      fs.writeFileSync(path.join(tnd, 'ledger.jsonl'), [
        TL({ id: `testnet-${T7}-0`, ts: T7, event: 'down', state: 'down', class: 'hung', started_at: T7 - 30 }),
        TL({ id: `testnet-${T7 + 900}-0`, ts: T7 + 900, event: 'up', state: 'up' }),   // no outage_id
      ].join('\n') + '\n');
      clock = T7 + 1000;
      await tb.ingestOnce();
      const orphan = tRows('recorder').find((x) => x.state === 'down');
      ok('an up with no matching outage_id still closes the open recorder outage at its ts',
        orphan && orphan.ended_at === T7 + 900 && /closed by a later up line/.test(orphan.detail), JSON.stringify(orphan));

      // A status.json read error is logged, but never flips the LEDGER state the page keys on.
      tb.recorder = { state: 'ok', since: T7 };
      tb._noteUnreadable({ code: 'EACCES' }, tb.statusPath, false);
      ok('status.json unreadable → ledger state untouched', tb.recorder.state === 'ok');
      ok('readRecorderStatus passes ledger=false', /_noteUnreadable\(e, this\.statusPath, false\)/.test(
        fs.readFileSync(path.join(APP, 'lib/node-availability.js'), 'utf8')));

      // availability() reads only counted states, so a flood of info points cannot push an old
      // open span past a LIMIT and turn it into up time.
      db.prepare("DELETE FROM node_events WHERE network = 'testnet'").run();
      const ins = db.prepare(`INSERT INTO node_events (network, source, started_at, ended_at, duration_s, state)
                              VALUES ('testnet', 'recorder', ?, ?, 0, 'info')`);
      const now7 = T7 + 300 * 86400;
      db.prepare(`INSERT INTO node_events (network, source, started_at, state, class)
                  VALUES ('testnet', 'recorder', ?, 'down', 'hung')`).run(now7 - 200 * 86400);
      db.transaction(() => { for (let i = 0; i < 20005; i++) ins.run(now7 - 1000 - i, now7 - 1000 - i); })();
      clock = now7;
      // A fresh status.json, or the tail after the last ingested line is (rightly) unobserved.
      fs.writeFileSync(path.join(tnd, 'status.json'), JSON.stringify({ v: 1, net: 'testnet', updated: now7 - 10, state: 'down', class: 'hung' }));
      tb._statusMemo = { at: 0, val: null };
      const av7 = tb.availability(365 * 86400).sources.recorder;
      ok('20 000+ info rows: the 200-day-old open outage is still counted down to now',
        av7.open_outage === true && av7.down_s === 200 * 86400, JSON.stringify({ down_s: av7.down_s, open: av7.open_outage }));

      db.prepare("DELETE FROM node_events WHERE network = 'testnet'").run();
      db.prepare("DELETE FROM node_availability_meta WHERE network = 'testnet'").run();
    }
  } finally {
    try { closeDb(); } catch (_) { /* ignore */ }
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
