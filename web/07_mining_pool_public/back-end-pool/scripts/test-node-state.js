// Node display-state regression tests — the homepage "Node sync" lamp.
//
// A node opening a rebuilt chain_data refuses the API port for minutes (ECONNREFUSED), then
// times out while it catches up. Both must not render as a red "offline" while the node
// process was healthy (seen live 2026-09-30 after a chain_data rebuild). getStatus()
// carries the transport failure kind and downState() maps it to starting | busy | offline.
//
// What this pins:
//   [1] the node-fetch 2 error shapes we classify on are REAL, not assumed — refused and
//       timeout are provoked against in-process listeners, and getStatus() is run end to end;
//   [2] which command lines count as "a grin node for this network" — narrow on purpose:
//       an unprovable network must never turn a dead node amber;
//   [3] the /proc scan against a fake proc tree, and downState() on every branch — a 401
//       (bad secret) must stay 'offline', never 'busy';
//   [4] the route and the lamp actually use it;
//   [5] a secret repaired, rotated or moved after startup is picked up on the next 401.
//
// In-process only: the listeners bind 127.0.0.1 on an ephemeral port and are closed before
// exit; the fake /proc and the temp secret dir live in os.tmpdir() and are removed. Nothing is
// left running.
// Run: node scripts/test-node-state.js
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { readAppSource } = require('./lib/app-source');
const fetch = require('node-fetch');

const APP = path.resolve(__dirname, '..');
const GrinNodeAPI = require(path.join(APP, 'lib/grin-node.js'));
const { isNodeCmdline, nodeProcessRunning, classifyTransport } = GrinNodeAPI;

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${extra ? ' — ' + extra : ''}`); }
};

const listen = (onConn) => new Promise((resolve) => {
  const srv = net.createServer(onConn);
  srv.listen(0, '127.0.0.1', () => resolve(srv));
});
const close = (srv) => new Promise((resolve) => srv.close(() => resolve()));
// A closed port (ours until the server closes): connecting to it is refused.
const closedPort = async () => {
  const srv = await listen(() => {});
  const { port } = srv.address();
  await close(srv);
  return port;
};
const api = (url, network = 'mainnet') => new GrinNodeAPI({
  node_api_url: url, network,
  node_api_secret: 'test-secret', node_foreign_api_secret: 'test-secret',
});

(async () => {
  const sockets = [];

  console.log('\n[1] transport classification against real node-fetch errors\n');

  const refusedPort = await closedPort();
  let refusedErr = null;
  try { await fetch(`http://127.0.0.1:${refusedPort}/v2/owner`, { method: 'POST', body: '{}', timeout: 2000 }); }
  catch (e) { refusedErr = e; }
  ok('a closed port yields a FetchError classified as refused',
    refusedErr && classifyTransport(refusedErr) === 'refused',
    refusedErr && JSON.stringify({ type: refusedErr.type, code: refusedErr.code }));

  // Accepts the connection, never answers — what a node catching up looks like from outside.
  const silent = await listen((sock) => { sockets.push(sock); });
  let timeoutErr = null;
  try { await fetch(`http://127.0.0.1:${silent.address().port}/v2/owner`, { method: 'POST', body: '{}', timeout: 300 }); }
  catch (e) { timeoutErr = e; }
  ok('a silent listener yields a FetchError classified as timeout',
    timeoutErr && classifyTransport(timeoutErr) === 'timeout',
    timeoutErr && JSON.stringify({ type: timeoutErr.type, code: timeoutErr.code }));
  ok('the timeout message is the one the VPS log shows',
    timeoutErr && /^network timeout at: /.test(timeoutErr.message), timeoutErr && timeoutErr.message);

  ok('an HTTP 401 (our own thrown Error) is other, never busy',
    classifyTransport(new Error('HTTP 401: Unauthorized')) === 'other');
  ok('no cause at all is other', classifyTransport(undefined) === 'other');

  const st = await api(`http://127.0.0.1:${refusedPort}`).getStatus();
  ok('getStatus() end to end: ok:false carries transport refused',
    st.ok === false && st.transport === 'refused', JSON.stringify(st));

  for (const s of sockets) s.destroy();
  await close(silent);

  console.log('\n[2] which command lines are a grin node for the network\n');

  const cases = [
    // [argv, network, expected, why]
    [['/opt/grin/node/mainnet-prune/grin', 'server', 'run'], 'mainnet', true, 'toolkit launch, mainnet prune'],
    [['/opt/grin/node/mainnet-full/grin', 'server', 'run'], 'mainnet', true, 'toolkit launch, mainnet archive'],
    [['/opt/grin/node/testnet-prune/grin', 'server', 'run'], 'testnet', true, 'toolkit launch, testnet'],
    [['/opt/grin/node/mainnet-prune/grin'], 'mainnet', true, 'TUI (no subcommand) by absolute path'],
    [['/opt/grin/node/testnet-prune/grin', 'server', 'run'], 'mainnet', false, 'a booting TESTNET node never turns mainnet amber'],
    [['/opt/grin/node/mainnet-prune/grin', 'server', 'run'], 'testnet', false, 'and the reverse'],
    [['./grin', 'server', 'run'], 'mainnet', false, 'relative path: network unprovable'],
    [['grin', 'server', 'run'], 'mainnet', false, 'bare name: network unprovable'],
    [['./grin', '--testnet', 'server', 'run'], 'testnet', true, '--testnet proves testnet'],
    [['./grin', '--testnet', 'server', 'run'], 'mainnet', false, '--testnet is not mainnet'],
    [['/opt/grin/node/mainnet-prune/grin', 'client', 'status'], 'mainnet', false, '`grin client` is a query, not a node'],
    [['/opt/grin/node/mainnet-prune/grin-wallet', 'listen'], 'mainnet', false, 'grin-wallet is not grin'],
    [['/usr/bin/node', '/opt/grin/node/mainnet-prune/grin'], 'mainnet', false, 'grin as an ARGUMENT is not grin'],
    [[], 'mainnet', false, 'empty argv (kernel thread)'],
  ];
  for (const [argv, netw, want, why] of cases) {
    ok(`${why}: ${JSON.stringify(argv)} @${netw} → ${want}`, isNodeCmdline(argv, netw) === want);
  }

  console.log('\n[3] /proc scan and downState()\n');

  const proc = fs.mkdtempSync(path.join(os.tmpdir(), 'pool-node-state-'));
  try {
    const addPid = (pid, argv) => {
      fs.mkdirSync(path.join(proc, String(pid)));
      fs.writeFileSync(path.join(proc, String(pid), 'cmdline'), argv.join('\0') + '\0');
    };
    addPid(1, ['/sbin/init']);
    addPid(648, ['/usr/bin/node', '/opt/grin/pool/index.js']);
    addPid(900, ['/opt/grin/node/testnet-prune/grin', 'server', 'run']);
    fs.mkdirSync(path.join(proc, 'self'));              // non-numeric entries are skipped
    fs.mkdirSync(path.join(proc, '1234'));              // a PID with no cmdline (exited mid-scan)

    ok('no mainnet node in the tree → false', await nodeProcessRunning('mainnet', proc) === false);
    ok('the testnet node is found for testnet', await nodeProcessRunning('testnet', proc) === true);
    ok('an unreadable proc root → false, never a throw',
      await nodeProcessRunning('mainnet', path.join(proc, 'missing')) === false);

    const node = api('http://127.0.0.1:1', 'mainnet');
    node.procRoot = proc;
    ok('refused + no node process → offline', await node.downState({ ok: false, transport: 'refused' }) === 'offline');
    addPid(1500, ['/opt/grin/node/mainnet-prune/grin', 'server', 'run']);
    ok('refused + node process running → starting', await node.downState({ ok: false, transport: 'refused' }) === 'starting');
    ok('timeout → busy', await node.downState({ ok: false, transport: 'timeout' }) === 'busy');
    ok('other (e.g. 401) → offline even with the process running',
      await node.downState({ ok: false, transport: 'other' }) === 'offline');
    ok('a status with no transport field → offline', await node.downState({ ok: false }) === 'offline');
  } finally {
    fs.rmSync(proc, { recursive: true, force: true });
  }

  console.log('\n[4] the route and the lamp use it\n');

  const indexSrc = readAppSource();
  const lampSrc = fs.readFileSync(path.join(APP, '..', 'public_html', 'js', 'reactor-dashboard.js'), 'utf8');
  ok('/api/pool/status sets node.state from downState()',
    /out\.node\.state\s*=\s*await blockMonitor\.grinNode\.downState\(status\)/.test(indexSrc));
  ok('reachable stays true only for state ok', /reachable: true,\s*state: 'ok'/.test(indexSrc));
  ok('the lamp paints starting/busy amber (warn), not alarm',
    /nodeState === 'starting' \|\| nodeState === 'busy'/.test(lampSrc) &&
    /setLamp\('an-node', 'warn', nodeState\)/.test(lampSrc));

  console.log('\n[5] a secret repaired after startup is picked up on the next 401\n');

  // A node that accepts one credential and counts every call.
  const http = require('http');
  let calls = 0;
  const nodeSrv = http.createServer((req, res) => {
    calls++;
    req.resume();
    req.on('end', () => {
      const good = req.headers.authorization === `Basic ${Buffer.from('grin:right-secret').toString('base64')}`;
      res.statusCode = good ? 200 : 401;
      res.end(good ? JSON.stringify({ id: 1, result: { Ok: { tip: { height: 5 } } } }) : '');
    });
  });
  await new Promise((resolve) => nodeSrv.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${nodeSrv.address().port}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grin-secret-'));
  const ownerFile = path.join(dir, '.api_secret');
  const foreignFile = path.join(dir, '.foreign_api_secret');
  const fromFiles = () => new GrinNodeAPI({
    node_api_url: url, network: 'mainnet',
    node_api_secret_path: ownerFile, node_foreign_api_secret_path: foreignFile,
  });
  const realWarn = console.error, realLog = console.log;
  try {
    console.error = () => {};
    const node = fromFiles();                 // the files are missing: the boot-time gap
    console.error = realWarn;
    ok('a pool started without its secret holds none', node.secret === '');

    calls = 0;
    const warnings = [];
    console.error = (line) => warnings.push(line);
    const refused = await node.getStatus();
    await node.getStatus();
    console.error = realWarn;
    ok('still unreadable → auth fault, no retry', refused.transport === 'auth' && calls === 2);
    ok('a failed re-read warns once, not on every call',
      warnings.length === 1 && warnings[0].includes(ownerFile));

    fs.writeFileSync(ownerFile, 'right-secret\n');
    fs.writeFileSync(foreignFile, 'right-secret\n');
    calls = 0;
    console.log = () => {};
    const healed = await node.getStatus();
    console.log = realLog;
    ok('repaired file → the same call succeeds', healed.ok === true && calls === 2);
    calls = 0;
    await node.getStatus();
    ok('the reloaded secret is kept: one call, no 401', calls === 1);

    calls = 0;
    console.log = () => {};
    const foreign = await node._foreignRpcCall('get_tip', []);
    console.log = realLog;
    ok('the foreign secret reloads on its own', foreign.tip.height === 5 && calls === 2);

    console.error = () => {};
    fs.rmSync(ownerFile);
    const racing = fromFiles();
    console.error = realWarn;
    fs.writeFileSync(ownerFile, 'right-secret');
    console.log = () => {};
    const both = await Promise.all([racing.getStatus(), racing.getStatus()]);
    console.log = realLog;
    ok('overlapping refused calls both recover', both.every((s) => s.ok === true));

    const movedDir = path.join(dir, 'moved');
    fs.mkdirSync(movedDir);
    fs.writeFileSync(path.join(movedDir, '.api_secret'), 'right-secret');
    console.error = () => {};
    const moving = new GrinNodeAPI({ node_api_url: url, network: 'mainnet' });
    console.error = realWarn;
    moving._detectNodeDir = () => movedDir;   // the node came up in the other dir
    console.log = () => {};
    const followed = await moving.getStatus();
    console.log = realLog;
    ok('a secret that moved to the other node dir is found', followed.ok === true);

    fs.writeFileSync(ownerFile, 'wrong-secret');
    fs.writeFileSync(foreignFile, 'wrong-secret');
    const wrong = fromFiles();
    calls = 0;
    const unchanged = await wrong.getStatus();
    ok('an unchanged wrong secret is not retried', unchanged.transport === 'auth' && calls === 1);

    fs.writeFileSync(ownerFile, 'right-secret');
    const pinned = new GrinNodeAPI({
      node_api_url: url, network: 'mainnet',
      node_api_secret: 'pinned-value', node_api_secret_path: ownerFile,
    });
    calls = 0;
    const kept = await pinned.getStatus();
    ok('an explicit pool.json value is never replaced from a file',
      kept.transport === 'auth' && pinned.secret === 'pinned-value' && calls === 1);
  } finally {
    console.error = realWarn; console.log = realLog;
    fs.rmSync(dir, { recursive: true, force: true });
    await new Promise((resolve) => nodeSrv.close(resolve));
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
