// Payout-rail wire tests — what the pool actually puts on the wire for each miner payout rail.
//
// The slatepack rail (and the Goblin/Nostr rail, which shares its wallet call) shipped broken:
// lib/wallet.js sent create_slatepack_message POSITIONAL as [token, sender_index, recipients,
// slate] while grin-wallet Owner v3 wants (token, slate, sender_index, recipients), so the wallet
// read the number 0 as the slate and every payout failed with
// `InvalidArgStructure "slate" at position 1`. Nothing tested the wire shape, so nothing caught it.
//
// No network, no wallet: the real WalletAPI is constructed and only _encryptedCall (the ECDH
// wire boundary) and initSession are stubbed. Each wire call is deep-copied as it is captured,
// because _call fills the token into the SAME params object again on a session retry.
// Run: node scripts/test-payout-rails.js
//
// The Tor section drives lib/wallet-tor.js's reachability probe — the same probe that is the
// withdraw pre-flight gate, where a wrong `false` is an HTTP 409 that refuses a payout. Unit
// cases inject connect/checkVersion (no tor). The "real sockets" cases run the real socks5.js +
// check_version path against a fake SOCKS5 proxy on 127.0.0.1:<ephemeral>, in THIS process,
// closed before exit — that is the only way to reproduce the exact failure the old `socks`-lib
// probe mis-scored (a proxy that accepts and never answers).
const fs = require('fs');
const net = require('net');
const path = require('path');

const APP = path.resolve(__dirname, '..');
const WalletAPI = require(path.join(APP, 'lib/wallet.js'));
const WalletTor = require(path.join(APP, 'lib/wallet-tor.js'));

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name} ${extra}`); }
};
const section = (title) => console.log(`\n[${title}]`);
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// A slate fixture shaped like a VersionedSlate (v4): the `id` is what the scheduler binds on.
const SLATE = {
  ver: '4:3',
  id: '0436430c-2b02-624c-2032-570501212b00',
  sta: 'S1',
  off: 'd202964900000000d302964900000000d402964900000000d502964900000000',
  amt: '1000000000',
  fee: '8000000',
  sigs: [{ xs: '02e89cce4499ac1e9bb498dab9e3fab93cc40cd3d26c04a0292e00f4bf272499ec', nonce: '02' + 'ab'.repeat(32) }],
};
const RECIPIENT = 'tgrin1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq';

// Harness: a WalletAPI with an "open" session whose wire calls are recorded, not sent.
// `failFirst` makes the first wire call throw (to drive _call's session-retry branch).
function harness({ failFirst = null } = {}) {
  const w = new WalletAPI({ network: 'testnet', wallet_dir: '/nonexistent' });
  w.sessionOpen = true;
  w.aesKey = Buffer.alloc(32);
  w.token = 'TOKEN-A';
  const wire = [];
  let inits = 0;
  w.initSession = async () => { inits++; w.token = 'TOKEN-B'; w.sessionOpen = true; };
  w._encryptedCall = async (method, params, opts) => {
    wire.push({ method, params: JSON.parse(JSON.stringify(params)), opts: opts || null });
    if (failFirst && wire.length === 1) throw new Error(failFirst);
    return method === 'create_slatepack_message' ? 'BEGINSLATEPACK. xyz. ENDSLATEPACK.' : 'ok';
  };
  return { w, wire, inits: () => inits };
}

// ─── Tor probe fixtures ──────────────────────────────────────────────────────
// A real, checksum-valid testnet Slatepack address (06d's test-wallet-check.js fixture).
const TOR_ADDR = 'tgrin1xtxavwfgs48ckf3gk8wwgcndmn0nt4tvkl8a7ltyejjcy2mc6nfs9gm2lp';
const CHECK_VERSION_OK = JSON.stringify({ id: 1, jsonrpc: '2.0',
  result: { Ok: { foreign_api_version: 2, supported_slate_versions: ['V4'] } } });

// Errors shaped exactly as lib/socks5.js raises them (SocksError: numeric reply code or null,
// proxyResponded flag), plus the one the OLD `socks` npm lib raised on a timeout.
const socksErr = (message, { code = null, responded = false, syscall = null } = {}) => {
  const e = new Error(message);
  e.code = code; e.proxyResponded = responded;
  if (syscall) e.syscallCode = syscall;
  return e;
};
const ERR_REFUSED = () => socksErr('SOCKS proxy connection failed: connect ECONNREFUSED 127.0.0.1:9050 — is tor running and listening on 127.0.0.1:9050?', { syscall: 'ECONNREFUSED' });
const ERR_SILENT_TIMEOUT = () => socksErr('timed out after 8000ms connecting through the Tor SOCKS proxy');
const ERR_HOST_UNREACH = () => socksErr('host unreachable (onion descriptor not found, or the service is offline)', { code: 4, responded: true });
const ERR_ONION_TIMEOUT = () => socksErr('timed out after 8000ms connecting through the Tor SOCKS proxy', { responded: true });

// A probe with injected connect/checkVersion. `steps` is consumed one per attempt: an Error →
// connect rejects with it; { status, body } → tunnel built, check_version answers that;
// 'hang' → tunnel built, check_version throws (no reply).
function torHarness(steps, config = {}) {
  const calls = [];
  const sockets = [];
  const deps = {
    connect: async (opts) => {
      calls.push(opts);
      const step = steps[calls.length - 1];
      if (step instanceof Error) throw step;
      const sock = { destroyed: 0, destroy() { this.destroyed++; }, step };
      sockets.push(sock);
      return sock;
    },
    checkVersion: async (sock) => {
      if (sock.step === 'hang') throw new Error('no reply within 8000ms');
      return sock.step;
    },
  };
  const t = new WalletTor(Object.assign({ network: 'testnet' }, config), deps);
  return { t, calls, sockets };
}

// A minimal fake SOCKS5 proxy. `plan(i)` picks what connection #i does:
//   'silent'  — accept the TCP connection, never write a byte (a stuck tor)
//   <number>  — full handshake, then CONNECT reply code <number> (4 = host unreachable)
//   { status, body } — CONNECT succeeds, then answer the HTTP request with that
//   'garbage' — something that is NOT a SOCKS5 proxy answers on the port (an HTTP server)
//   { drip: ms } — CONNECT succeeds, then the "wallet" feeds an HTTP reply ONE byte every
//                  `ms` and never finishes (the far end is the address holder's own onion)
// Records each connection's SOCKS username and the raw HTTP request it received.
function startFakeSocks(plan) {
  const seen = [];
  const conns = new Set();
  const drips = new Set();
  const server = net.createServer((sock) => {
    conns.add(sock);
    sock.on('close', () => conns.delete(sock));
    sock.on('error', () => {});
    const idx = seen.length;
    const rec = { user: null, host: null, http: '' };
    seen.push(rec);
    const mode = plan(idx);
    if (mode === 'silent') return;
    if (mode === 'garbage') {
      sock.once('data', () => sock.end('HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n'));
      return;
    }
    let buf = Buffer.alloc(0);
    let state = 'greet';
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        if (state === 'greet') {
          if (buf.length < 2 || buf.length < 2 + buf[1]) return;
          const methods = [...buf.subarray(2, 2 + buf[1])];
          buf = buf.subarray(2 + buf[1]);
          if (methods.includes(2)) { sock.write(Buffer.from([5, 2])); state = 'auth'; }
          else { sock.write(Buffer.from([5, 0])); state = 'connect'; }
        } else if (state === 'auth') {
          if (buf.length < 2) return;
          const ul = buf[1];
          if (buf.length < 3 + ul) return;
          const pl = buf[2 + ul];
          if (buf.length < 3 + ul + pl) return;
          rec.user = buf.subarray(2, 2 + ul).toString();
          buf = buf.subarray(3 + ul + pl);
          sock.write(Buffer.from([1, 0]));
          state = 'connect';
        } else if (state === 'connect') {
          if (buf.length < 5 || buf.length < 5 + buf[4] + 2) return;
          rec.host = buf.subarray(5, 5 + buf[4]).toString() + ':' + buf.readUInt16BE(5 + buf[4]);
          buf = buf.subarray(5 + buf[4] + 2);
          const rep = typeof mode === 'number' ? mode : 0;
          sock.write(Buffer.from([5, rep, 0, 1, 0, 0, 0, 0, 0, 0]));
          if (rep !== 0) { sock.end(); return; }
          state = 'http';
          if (mode && mode.drip) {
            const reply = 'HTTP/1.1 200 OK\r\nX-Pad: ' + 'a'.repeat(4096);
            let i = 0;
            const t = setInterval(() => {
              if (sock.destroyed) { clearInterval(t); drips.delete(t); return; }
              sock.write(reply[i++ % reply.length]);
            }, mode.drip);
            drips.add(t);
            state = 'done';
            return;
          }
        } else if (state === 'http') {
          rec.http += buf.toString(); buf = Buffer.alloc(0);
          const head = rec.http.indexOf('\r\n\r\n');
          if (head === -1) return;
          const len = Number((/content-length:\s*(\d+)/i.exec(rec.http) || [])[1] || 0);
          if (rec.http.length < head + 4 + len) return;
          rec.body = rec.http.slice(head + 4, head + 4 + len);
          // { reply: fn } (stepwise tests): fn(requestBody) picks the answer per REQUEST —
          // { status, body } | 'drop' (close without a reply) | { drip: ms } (trickle forever).
          const out = typeof mode.reply === 'function' ? mode.reply(rec.body) : mode;
          if (out === 'drop') { sock.destroy(); state = 'done'; return; }
          if (out && out.drip) {
            const reply = 'HTTP/1.1 200 OK\r\nX-Pad: ' + 'a'.repeat(4096);
            let i = 0;
            const t = setInterval(() => {
              if (sock.destroyed) { clearInterval(t); drips.delete(t); return; }
              sock.write(reply[i++ % reply.length]);
            }, out.drip);
            drips.add(t);
            state = 'done';
            return;
          }
          const body = out.body || '';
          sock.end(`HTTP/1.1 ${out.status} X\r\nContent-Type: application/json\r\n` +
            `Content-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
          state = 'done';
          return;
        } else return;
      }
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    port: server.address().port,
    seen,
    close: () => new Promise((r) => {
      for (const t of drips) clearInterval(t);
      for (const c of conns) c.destroy();
      server.close(() => r());
    }),
  })));
}

async function torProbeSection() {
  // Guarded so that, run against a wallet-tor.js without these exports (the revert-proof), the
  // cases FAIL instead of throwing and hiding the real-socket regression cases below.
  const classify = (e) => (typeof WalletTor.classifyProbeError === 'function'
    ? WalletTor.classifyProbeError(e) : { online: undefined, reason: 'classifyProbeError not exported' });
  const REASONS = WalletTor.REASONS || {};
  section('Tor probe — classification (injected connect, no tor)');
  {
    const { t, calls } = torHarness([ERR_REFUSED(), ERR_REFUSED()]);
    const r = await t.probeToronlineStatus(TOR_ADDR);
    ok('a. proxy refused → online null, reason tor_unavailable', r.online === null && r.reason === 'tor_unavailable', JSON.stringify(r));
    ok('a. …and no second attempt (our tor is down; retrying only spends time)', calls.length === 1, `attempts=${calls.length}`);
  }
  {
    const { t, calls } = torHarness([ERR_SILENT_TIMEOUT(), ERR_SILENT_TIMEOUT()]);
    const r = await t.probeToronlineStatus(TOR_ADDR);
    ok('b. timeout with ZERO proxy bytes → online null (never a confident offline)', r.online === null && r.reason === 'tor_unavailable', JSON.stringify(r));
    ok('b. …and stops after one attempt', calls.length === 1, `attempts=${calls.length}`);
  }
  {
    const { t, calls } = torHarness([ERR_HOST_UNREACH(), ERR_HOST_UNREACH()]);
    const r = await t.probeToronlineStatus(TOR_ADDR);
    ok('c. tor replied "host unreachable" (reply 0x04) → online false, onion_unreachable', r.online === false && r.reason === 'onion_unreachable', JSON.stringify(r));
    ok('c. …after trying every attempt', calls.length === 2, `attempts=${calls.length}`);
    const { t: t2 } = torHarness([ERR_ONION_TIMEOUT(), ERR_ONION_TIMEOUT()]);
    const r2 = await t2.probeToronlineStatus(TOR_ADDR);
    ok('c. tor greeted us, then the onion timed out → online false, onion_timeout', r2.online === false && r2.reason === 'onion_timeout', JSON.stringify(r2));
  }
  {
    const { t, calls } = torHarness([{ status: 200, body: CHECK_VERSION_OK }]);
    const r = await t.probeToronlineStatus(TOR_ADDR);
    ok('d. tunnel + HTTP 200 with a check_version result → online true, reachable', r.online === true && r.reason === 'reachable', JSON.stringify(r));
    ok('d. …on the first attempt, to onion:80 via 127.0.0.1:9050',
      calls.length === 1 && calls[0].port === 80 && calls[0].socksHost === '127.0.0.1' && calls[0].socksPort === 9050 &&
      calls[0].host === t.deriveOnionAddress(TOR_ADDR), JSON.stringify(calls[0]));
    const { t: t2 } = torHarness([{ status: 200, body: JSON.stringify({ id: 1, jsonrpc: '2.0', error: { code: -32601, message: 'Method not found' } }) }]);
    const r2 = await t2.probeToronlineStatus(TOR_ADDR);
    ok('d. a JSON-RPC error (old wallet without check_version) is still a wallet → true', r2.online === true, JSON.stringify(r2));
  }
  {
    const { t } = torHarness([{ status: 401, body: '' }]);
    const r = await t.probeToronlineStatus(TOR_ADDR);
    ok('e. tunnel + HTTP 401 → online true, reachable_auth', r.online === true && r.reason === 'reachable_auth', JSON.stringify(r));
  }
  {
    const { t, calls } = torHarness([{ status: 200, body: '<html>hello</html>' }, { status: 200, body: CHECK_VERSION_OK }]);
    const r = await t.probeToronlineStatus(TOR_ADDR);
    ok('f. tunnel + HTTP 200 non-JSON → online false, not_wallet', r.online === false && r.reason === 'not_wallet', JSON.stringify(r));
    ok('f. …with NO second attempt (a stable fact about the far end)', calls.length === 1, `attempts=${calls.length}`);
    const { t: t2 } = torHarness([{ status: 200, body: '{"hello":"world"}' }]);
    ok('f. JSON that is not JSON-RPC → not_wallet', (await t2.probeToronlineStatus(TOR_ADDR)).reason === 'not_wallet');
    const { t: t3 } = torHarness([{ status: 502, body: '' }]);
    ok('f. a non-2xx, non-401 status → not_wallet', (await t3.probeToronlineStatus(TOR_ADDR)).reason === 'not_wallet');
  }
  {
    const { t, calls } = torHarness([ERR_ONION_TIMEOUT(), { status: 200, body: CHECK_VERSION_OK }]);
    const r = await t.probeToronlineStatus(TOR_ADDR);
    ok('g. attempt 1 onion timeout, attempt 2 answers → online true', r.online === true && r.reason === 'reachable', JSON.stringify(r));
    ok('g. …and the two attempts used DIFFERENT isolation tags (fresh circuit per retry)',
      calls.length === 2 && calls[0].isolationTag && calls[1].isolationTag && calls[0].isolationTag !== calls[1].isolationTag,
      JSON.stringify(calls.map((c) => c.isolationTag)));
  }
  {
    // h (unit). The exact error the OLD `socks` lib raised on a timeout — no reply code, no
    // proxyResponded. The old probe scored it online:false and the gate refused the payout.
    const r = classify(new Error('Proxy connection timed out'));
    ok('h. REGRESSION: \'Proxy connection timed out\' (zero proxy bytes) is NOT online:false',
      r.online !== false, JSON.stringify(r));
    ok('h. …it is null / tor_unavailable', r.online === null && r.reason === 'tor_unavailable', JSON.stringify(r));
  }
  {
    const { t, calls } = torHarness([{ status: 200, body: CHECK_VERSION_OK }]);
    const bad = await t.probeToronlineStatus('grin1notanaddress');
    ok('i. invalid address → online false, invalid_format (nothing can ever be sent there)',
      bad.online === false && bad.reason === 'invalid_format', JSON.stringify(bad));
    const typo = TOR_ADDR.slice(0, -1) + (TOR_ADDR.slice(-1) === 'q' ? 'p' : 'q');
    const r2 = await t.probeToronlineStatus(typo);
    ok('i. shape-valid but checksum-broken → online null, derivation_failed (no probe made)',
      r2.online === null && r2.reason === 'derivation_failed', JSON.stringify(r2));
    ok('i. …and neither case opened a connection', calls.length === 0, `connects=${calls.length}`);
  }
  {
    const { t, calls, sockets } = torHarness(['hang', 'hang']);
    const r = await t.probeToronlineStatus(TOR_ADDR);
    ok('tunnel built but no HTTP reply → online false, no_answer, retried', r.online === false && r.reason === 'no_answer' && calls.length === 2, JSON.stringify(r));
    ok('every tunnelled socket is destroyed after its attempt (no leak per probe)',
      sockets.length === 2 && sockets.every((s) => s.destroyed >= 1), JSON.stringify(sockets.map((s) => s.destroyed)));
  }
  {
    // Every reason code is in the tri-state table — a typo would come back as probe_failed/null.
    const codes = Object.keys(REASONS);
    ok('every REASONS entry is true | false | null', codes.length >= 10 && codes.every((k) => [true, false, null].includes(REASONS[k])), `codes=${codes.length}`);
    ok('an unknown error shape is null / probe_failed, never false',
      same(classify(new Error('something odd')), { online: null, reason: 'probe_failed' }));
    ok('"rejected" wins over an errno in the same message (tor answered)',
      classify(new Error('Socks5 proxy rejected connection - ECONNREFUSED')).online === false);
  }

  section('Tor probe — defaults');
  {
    const t = new WalletTor({ network: 'testnet' });
    ok('WalletTor default timeout is 8000 ms and retries 2', t.torCheckTimeoutMs === 8000 && t.torCheckRetries === 2,
      `${t.torCheckTimeoutMs}/${t.torCheckRetries}`);
    const cfgSrc = fs.readFileSync(path.join(APP, 'lib/config.js'), 'utf8');
    ok('config.js default tor_check_timeout_ms is 8000', /tor_check_timeout_ms:\s*config\.tor_check_timeout_ms \|\| 8000\b/.test(cfgSrc));
    ok('config.js default tor_check_retries is 2', /tor_check_retries:\s*config\.tor_check_retries \|\| 2\b/.test(cfgSrc));
    const torSrc = fs.readFileSync(path.join(APP, 'lib/wallet-tor.js'), 'utf8');
    ok('wallet-tor.js no longer requires the `socks` npm lib', !/require\(['"]socks['"]\)/.test(torSrc));
  }

  section('Tor probe — tor-check route ?fresh=1 (source checks)');
  {
    const idx = fs.readFileSync(path.join(APP, 'index.js'), 'utf8');
    ok('a 10 s fresh floor constant sits beside the 60 s TTL',
      /const TOR_PROBE_TTL_MS = 60000;[\s\S]{0,200}const TOR_PROBE_FRESH_FLOOR_MS = 10000;/.test(idx));
    ok('the route passes ?fresh=1 into the cache', /torProbeCached\(addr, req\.query\.fresh === '1'\)/.test(idx));
    ok('fresh lowers the cache age to the floor, never to zero',
      /const ttl = fresh \? TOR_PROBE_FRESH_FLOOR_MS : TOR_PROBE_TTL_MS;/.test(idx));
    const route = idx.slice(idx.indexOf("app.get('/api/account/:addr/tor-check'"));
    ok('the route still sits behind the torcheck rate bucket',
      /app\.get\('\/api\/account\/:addr\/tor-check', rateLimiter\.middleware\('torcheck'\)/.test(idx));
    ok('the 404-for-unknown-address check still runs BEFORE the probe',
      route.indexOf('no mining account for this address') > 0 &&
      route.indexOf('no mining account for this address') < route.indexOf('torProbeCached('));
  }

  section('Tor probe — real sockets (fake SOCKS5 proxy on 127.0.0.1, in-process)');
  // Fast timeouts: these exercise the same code paths as the 8 s default, only sooner.
  const FAST = { tor_check_timeout_ms: 400, tor_check_retries: 2 };
  {
    // h (end-to-end). A proxy that accepts the TCP connection and never says a word — the
    // exact situation the old probe turned into online:false and a refused payout.
    const px = await startFakeSocks(() => 'silent');
    try {
      const t = new WalletTor(Object.assign({ network: 'testnet', tor_socks_port: px.port }, FAST));
      const r = await t.probeToronlineStatus(TOR_ADDR);
      ok('h. REGRESSION (real socket): a silent proxy yields online null, NOT a confident offline',
        r.online === null, JSON.stringify(r));
      ok('h. …reason tor_unavailable, one attempt only', r.reason === 'tor_unavailable' && px.seen.length === 1,
        `${r.reason} attempts=${px.seen.length}`);
    } finally { await px.close(); }
  }
  {
    // Nothing listening at all (a freshly closed ephemeral port) — tor not running.
    const px = await startFakeSocks(() => 'silent');
    const deadPort = px.port;
    await px.close();
    const t = new WalletTor(Object.assign({ network: 'testnet', tor_socks_port: deadPort }, FAST));
    const r = await t.probeToronlineStatus(TOR_ADDR);
    ok('a. (real socket) nothing on the SOCKS port → online null, tor_unavailable', r.online === null && r.reason === 'tor_unavailable', JSON.stringify(r));
  }
  {
    // g (end-to-end). First circuit: tor says host unreachable. Second: the wallet answers.
    const px = await startFakeSocks((i) => (i === 0 ? 4 : { status: 200, body: CHECK_VERSION_OK }));
    try {
      const t = new WalletTor(Object.assign({ network: 'testnet', tor_socks_port: px.port }, FAST));
      const r = await t.probeToronlineStatus(TOR_ADDR);
      ok('g. (real socket) unreachable then answered → online true, reachable', r.online === true && r.reason === 'reachable', JSON.stringify(r));
      ok('g. (real socket) each attempt authenticated with a DIFFERENT SOCKS username',
        px.seen.length === 2 && px.seen[0].user && px.seen[1].user && px.seen[0].user !== px.seen[1].user,
        JSON.stringify(px.seen.map((s) => s.user)));
      const onion = t.deriveOnionAddress(TOR_ADDR);
      ok('d. (real socket) CONNECT went to <derived onion>:80', px.seen[1].host === onion + ':80', px.seen[1].host);
      const req = px.seen[1].http;
      ok('d. (real socket) the wallet was asked a real check_version on POST /v2/foreign',
        /^POST \/v2\/foreign HTTP\/1\.1\r\n/.test(req) && /"method":"check_version"/.test(req), JSON.stringify(req.slice(0, 80)));
      ok('d. (real socket) exactly one Host header, naming the onion',
        (req.match(/^host:/gim) || []).length === 1 && new RegExp('^Host: ' + onion.replace(/\./g, '\\.') + '\\r$', 'm').test(req));
    } finally { await px.close(); }
  }
  {
    // c (end-to-end). tor answers, onion unreachable on every circuit → confident offline.
    const px = await startFakeSocks(() => 4);
    try {
      const t = new WalletTor(Object.assign({ network: 'testnet', tor_socks_port: px.port }, FAST));
      const r = await t.probeToronlineStatus(TOR_ADDR);
      ok('c. (real socket) reply 0x04 on every attempt → online false, onion_unreachable',
        r.online === false && r.reason === 'onion_unreachable' && px.seen.length === 2, `${JSON.stringify(r)} attempts=${px.seen.length}`);
    } finally { await px.close(); }
  }
  {
    // f (end-to-end). Something is there, and it is a web server, not a wallet.
    const px = await startFakeSocks(() => ({ status: 200, body: '<!doctype html><title>hi</title>' }));
    try {
      const t = new WalletTor(Object.assign({ network: 'testnet', tor_socks_port: px.port }, FAST));
      const r = await t.probeToronlineStatus(TOR_ADDR);
      ok('f. (real socket) an HTML 200 → not_wallet, one attempt', r.online === false && r.reason === 'not_wallet' && px.seen.length === 1,
        `${JSON.stringify(r)} attempts=${px.seen.length}`);
    } finally { await px.close(); }
  }

  section('Tor probe — review fixes (Part 5)');
  {
    // R1. The far end of the check_version socket is the ADDRESS HOLDER's own onion. An idle
    //     timeout alone (req.setTimeout) is reset by every byte, so a reply fed one byte at a
    //     time held a probe — and, in the gate, a withdraw request and a pool socket — for as
    //     long as Node's 16 KB header cap allowed (~a day at 1 byte / 7 s). The reply phase
    //     needs an ABSOLUTE deadline. Bounded here at 2 attempts × (connect + reply) + slack.
    const px = await startFakeSocks(() => ({ drip: 100 }));
    try {
      const t = new WalletTor(Object.assign({ network: 'testnet', tor_socks_port: px.port }, FAST));
      const t0 = Date.now();
      const CAP_MS = 4000;
      const r = await Promise.race([
        t.probeToronlineStatus(TOR_ADDR),
        new Promise((res) => setTimeout(() => res({ online: 'STILL PENDING', reason: `after ${CAP_MS} ms` }), CAP_MS)),
      ]);
      const took = Date.now() - t0;
      ok('R1. a drip-fed reply cannot hold the probe past its budget (settles within 2 × 2 × timeout + slack)',
        r.online !== 'STILL PENDING' && took < 2 * 2 * FAST.tor_check_timeout_ms + 800, `${JSON.stringify(r)} took=${took}ms`);
      ok('R1. …and it is a confident offline (tunnel built, no complete answer) → no_answer',
        r.online === false && r.reason === 'no_answer', JSON.stringify(r));
    } finally { await px.close(); }
  }
  {
    // R2. Something that is not a SOCKS5 proxy on tor_socks_port (a mis-set port: tor's
    //     ControlPort, an HTTP proxy) is OUR side broken — we could not look. It used to come
    //     back online:false (it "responded"), which the pre-flight gate turns into a 409 on
    //     EVERY Tor payout: the misconfigured-box brick the fail-open contract exists to prevent.
    const px = await startFakeSocks(() => 'garbage');
    try {
      const t = new WalletTor(Object.assign({ network: 'testnet', tor_socks_port: px.port }, FAST));
      const r = await t.probeToronlineStatus(TOR_ADDR);
      ok('R2. (real socket) a non-SOCKS5 answer on the SOCKS port → online null, tor_unavailable',
        r.online === null && r.reason === 'tor_unavailable', JSON.stringify(r));
      ok('R2. …after one attempt (our side is broken; retrying only spends time)', px.seen.length === 1, `attempts=${px.seen.length}`);
    } finally { await px.close(); }
    // The same for every error lib/socks5.js raises about the PROXY itself rather than the
    // destination (message text verbatim from that file; proxyResponded is true on all of them).
    for (const m of [
      'SOCKS proxy answered version 72, expected 5',
      'SOCKS proxy rejected every authentication method we offered',
      'SOCKS proxy rejected the isolation credential (status 1)',
      'SOCKS proxy selected unsupported method 3',
      'SOCKS reply had version 0, expected 5',
    ]) {
      const r = classify(socksErr(m, { responded: true }));
      ok(`R2. "${m.slice(0, 44)}…" → null / tor_unavailable`, r.online === null && r.reason === 'tor_unavailable', JSON.stringify(r));
    }
    ok('R2. a destination failure after the greeting is still a confident offline',
      classify(ERR_ONION_TIMEOUT()).online === false && classify(ERR_HOST_UNREACH()).online === false);
  }
}

// ─── The withdraw pre-flight gate: a requester that left must not get a payout ─────────────
// nginx gives /api/ `proxy_read_timeout 30s`; the gate's probe can take ~32 s at the defaults.
// Past 30 s nginx answers the browser 504 ("Withdrawal failed") and closes the upstream socket —
// but Express keeps running the handler, so the gate used to pass and createWithdrawal LOCKED the
// balance and queued a payout the miner had just been told failed.
// ─── Tor rail — what `grin-wallet send` printed, not what it exited with ─────
// The CLI exits 0 when Tor delivery fails: it locks the outputs, prints a slatepack and stops.
// The pool used to read that exit 0 as "paid". Fixtures below reproduce the exact println!
// sequence of upstream controller/src/command.rs `send` / `output_slatepack` (v5.4.1 = v5.5.0).
const FB_ID = '5c8a4e6b-3f1d-4a92-9b7e-0d2c1f3e4a5b';
const FALLBACK_OUT = [
  `/opt/grin/pool-testnet/wallet/slatepack/${FB_ID}.S1.slatepack`,
  '',
  'Slatepack data follows. Please provide this output to the other party',
  '',
  '--- CUT BELOW THIS LINE ---',
  '',
  'BEGINSLATEPACK. 4H1qx1wHe668tFW yC2gfL8PPd8kSgv pcXQhyRkHbyKHZg GN75o7uWoT3dkib R2tj1fFGN2FoRLY GWmtgsneoXf7N4D uVWuyZSamPhfF1u AHRaYWvhF7jQvKx wNJAc7qmVm9JVcm NJLEw4k5BU7jY6S eb. ENDSLATEPACK.',
  '--- CUT ABOVE THIS LINE ---',
  '',
  'Slatepack data was also output to',
  '',
  `/opt/grin/pool-testnet/wallet/slatepack/${FB_ID}.S1.slatepack`,
  '',
  'The slatepack data is encrypted for the recipient only',
  '',
].join('\n');
const SENT_OUT = 'Tx sent successfully\n';

async function torSendSection() {
  section('Tor send — classify the CLI output, never trust exit 0');
  const classify = (s) => (typeof WalletTor.classifySendOutput === 'function'
    ? WalletTor.classifySendOutput(s) : { outcome: 'classifySendOutput not exported', slateId: null });
  {
    const r = classify(SENT_OUT);
    ok('a. `Tx sent successfully` → sent', r.outcome === 'sent', JSON.stringify(r));
  }
  {
    const r = classify(FALLBACK_OUT);
    ok('b. slatepack fallback (exit 0) → slatepack_fallback, NOT sent', r.outcome === 'slatepack_fallback', JSON.stringify(r));
    ok('b. …and the slate id is read from the .S1.slatepack path', r.slateId === FB_ID, JSON.stringify(r));
  }
  {
    // Windows-style separators and an upper-case uuid still parse (the id is normalised).
    const r = classify(`C:\\grin\\slatepack\\${FB_ID.toUpperCase()}.S1.slatepack\nSlatepack data follows.\n`);
    ok('c. backslash path + upper-case uuid → same id, lower-cased', r.outcome === 'slatepack_fallback' && r.slateId === FB_ID, JSON.stringify(r));
  }
  {
    const r = classify('Slatepack data follows. Please provide this output to the other party\n');
    ok('d. fallback with no file path → fallback, slateId null (caller must not guess)', r.outcome === 'slatepack_fallback' && r.slateId === null, JSON.stringify(r));
  }
  {
    const r = classify('');
    ok('e. empty output → unrecognised, never sent', r.outcome === 'unrecognised', JSON.stringify(r));
  }
  {
    // A log line that merely MENTIONS the phrase is not the println! marker.
    const r = classify('20260925 10:00:00.000 WARN grin_wallet - Tx sent successfully? retrying\n');
    ok('f. a timestamped log line containing the phrase is NOT a send', r.outcome !== 'sent', JSON.stringify(r));
  }
  {
    // Ordering: if both markers were ever present, "sent" must win — the caller CANCELS a
    // fallback, and cancelling a posted tx unlocks outputs it already spent.
    const r = classify(FALLBACK_OUT + SENT_OUT);
    ok('g. both markers → sent wins (a posted tx is never treated as cancellable)', r.outcome === 'sent', JSON.stringify(r));
  }

  section('Tor send — sendToTorAddress maps each outcome (CLI stubbed)');
  const runSend = async (stdout) => {
    const t = new WalletTor({ network: 'testnet', wallet_dir: '/nonexistent' });
    t.execWalletCommand = async () => stdout;
    return t.sendToTorAddress(TOR_ADDR, 1.5);
  };
  {
    const r = await runSend(SENT_OUT);
    ok('h. sent → success:true', r.success === true && !r.torFallback, JSON.stringify(r));
  }
  {
    const r = await runSend(FALLBACK_OUT);
    ok('i. fallback → success:false, torFallback:true, slateId carried',
      r.success === false && r.torFallback === true && r.slateId === FB_ID, JSON.stringify(r));
  }
  {
    const r = await runSend('some future wording\n');
    ok('j. unrecognised exit-0 output → success:false, no torFallback (nothing to cancel)',
      r.success === false && !r.torFallback, JSON.stringify(r));
  }
  {
    const t = new WalletTor({ network: 'testnet', wallet_dir: '/nonexistent' });
    t.execWalletCommand = async () => { throw new Error('Command failed (code 1): Tx sent fail'); };
    const r = await t.sendToTorAddress(TOR_ADDR, 1.5);
    ok('k. non-zero exit → success:false with the CLI error, unchanged', r.success === false && /code 1/.test(r.error), JSON.stringify(r));
  }
}

// ─── F5 (Part 6): the step-by-step send's Tor delivery (WalletTor.deliverSlate) ──────────────
// Real socks5.js + real http over a fake SOCKS5 proxy whose far end plays the MINER's Foreign API
// (127.0.0.1:0, this process, closed in finally). The request body picks the answer.
async function stepwiseTransportSection() {
  section('stepwise-transport');
  const S1 = JSON.parse(JSON.stringify(SLATE));
  const S2 = Object.assign({}, S1, { sta: 'S2' });
  const rpc = (result) => JSON.stringify({ id: 1, jsonrpc: '2.0', result });
  const CV_OK = { status: 200, body: CHECK_VERSION_OK };
  const RECV_OK = { status: 200, body: rpc({ Ok: S2 }) };
  const methodOf = (body) => { try { return JSON.parse(body).method; } catch (_) { return null; } };
  // A wallet: answer check_version with `cv`, receive_tx with `recv`.
  const wallet = (cv, recv) => () => ({ reply: (body) => (methodOf(body) === 'check_version' ? cv : recv) });
  const FAST = { tor_check_timeout_ms: 400, tor_send_connect_timeout_ms: 400, tor_send_receive_timeout_ms: 400 };
  const mk = (port) => {
    const t = new WalletTor(Object.assign({ network: 'testnet', tor_socks_port: port }, FAST));
    t.torSendCheckTimeoutMs = 400;
    return t;
  };
  const deliver = typeof WalletTor.prototype.deliverSlate === 'function'
    ? (t, ...a) => t.deliverSlate(...a)
    : async () => ({ ok: 'deliverSlate not implemented' });

  {
    const px = await startFakeSocks(wallet(CV_OK, RECV_OK));
    try {
      const t = mk(px.port);
      const r = await deliver(t, TOR_ADDR, S1, { attemptTag: '7-1' });
      ok('T1. happy path → ok, S2 returned', r.ok === true && r.slate && r.slate.id === S1.id && r.slate.sta === 'S2', JSON.stringify(r).slice(0, 200));
      const reqs = px.seen.map((s) => { try { return JSON.parse(s.body); } catch (_) { return null; } });
      ok('T1. two requests, check_version THEN receive_tx', reqs.length === 2 && reqs[0] && reqs[0].method === 'check_version' &&
        reqs[1] && reqs[1].method === 'receive_tx', JSON.stringify(reqs.map((q) => q && q.method)));
      const body = reqs[1] || {};
      ok('T1. receive_tx body is exactly {jsonrpc, method, id, params:[S1, null, null]} (positional)',
        same(Object.keys(body).sort(), ['id', 'jsonrpc', 'method', 'params']) && body.jsonrpc === '2.0' &&
        Array.isArray(body.params) && body.params.length === 3 && same(body.params[0], S1) &&
        body.params[1] === null && body.params[2] === null, JSON.stringify(body).slice(0, 200));
      ok('T1. both connections to <derived onion>:80 on the SAME isolation tag grinpool-send-<attemptTag>',
        px.seen.every((s) => s.host === t.deriveOnionAddress(TOR_ADDR) + ':80') &&
        px.seen.every((s) => s.user === 'grinpool-send-7-1'), JSON.stringify(px.seen.map((s) => [s.host, s.user])));
    } finally { await px.close(); }
  }
  {
    const oldWallet = { status: 200, body: rpc({ Ok: { foreign_api_version: 2, supported_slate_versions: ['V3'] } }) };
    const px = await startFakeSocks(wallet(oldWallet, RECV_OK));
    try {
      const r = await deliver(mk(px.port), TOR_ADDR, S1, { attemptTag: 't2' });
      ok("T2. no 'V4' in supported_slate_versions → incompatible_wallet", r.ok === false && r.reason === 'incompatible_wallet', JSON.stringify(r));
      ok('T2. …and no receive_tx request was made', px.seen.every((s) => methodOf(s.body) !== 'receive_tx') && px.seen.length === 1,
        `connections=${px.seen.length}`);
    } finally { await px.close(); }
  }
  {
    const px = await startFakeSocks(() => 4);
    try {
      const r = await deliver(mk(px.port), TOR_ADDR, S1, { attemptTag: 't3' });
      ok('T3. SOCKS reply 0x04 → failed, ourSide:false, requestWritten:false',
        r.ok === false && r.ourSide === false && r.requestWritten === false, JSON.stringify(r));
      ok('T3. …after exactly one retry on a fresh circuit (different tag)',
        px.seen.length === 2 && px.seen[0].user !== px.seen[1].user, JSON.stringify(px.seen.map((s) => s.user)));
    } finally { await px.close(); }
  }
  {
    const px = await startFakeSocks(() => 'silent');
    const dead = px.port;
    await px.close();
    const r = await deliver(mk(dead), TOR_ADDR, S1, { attemptTag: 't4' });
    ok('T4. ECONNREFUSED on the SOCKS port (our tor is down) → ourSide:true, requestWritten:false',
      r.ok === false && r.ourSide === true && r.requestWritten === false && r.reason === 'tor_unavailable', JSON.stringify(r));
  }
  {
    const px = await startFakeSocks(wallet(CV_OK, 'drop'));
    try {
      const r = await deliver(mk(px.port), TOR_ADDR, S1, { attemptTag: 't5' });
      ok('T5. connection dropped after the receive_tx write → requestWritten:true, ourSide:false',
        r.ok === false && r.requestWritten === true && r.ourSide === false, JSON.stringify(r));
      ok('T5. …and receive_tx was NOT sent a second time',
        px.seen.filter((s) => methodOf(s.body) === 'receive_tx').length === 1, `receive_tx requests=${px.seen.filter((s) => methodOf(s.body) === 'receive_tx').length}`);
    } finally { await px.close(); }
  }
  {
    const px = await startFakeSocks(wallet(CV_OK, { drip: 50 }));
    try {
      const t0 = Date.now();
      const CAP_MS = 4000;
      const r = await Promise.race([
        deliver(mk(px.port), TOR_ADDR, S1, { attemptTag: 't6' }),
        new Promise((res) => setTimeout(() => res({ ok: 'STILL PENDING' }), CAP_MS)),
      ]);
      const took = Date.now() - t0;
      ok('T6. a drip-fed receive_tx reply ends by the ABSOLUTE deadline (bounded wall time)',
        r.ok === false && took < 400 * 3 + 800, `${JSON.stringify(r)} took=${took}ms`);
      ok('T6. …as requestWritten:true (the miner may hold S1)', r.requestWritten === true, JSON.stringify(r));
    } finally { await px.close(); }
  }
  {
    const pad = 'a'.repeat(1024 * 1024);
    const huge = { status: 200, body: rpc({ Ok: Object.assign({}, S2, { pad }) }) };
    const px = await startFakeSocks(wallet(CV_OK, huge));
    try {
      const t = mk(px.port);
      t.torSendReceiveTimeoutMs = 5000;
      const r = await deliver(t, TOR_ADDR, S1, { attemptTag: 't7' });
      ok('T7. a receive_tx reply over 1 MiB → failed (never parsed as S2)', r.ok === false && r.requestWritten === true, JSON.stringify(r).slice(0, 200));
    } finally { await px.close(); }
  }
  {
    const wrong = { status: 200, body: rpc({ Ok: Object.assign({}, S2, { id: '11111111-2222-3333-4444-555555555555' }) }) };
    const px = await startFakeSocks(wallet(CV_OK, wrong));
    try {
      const r = await deliver(mk(px.port), TOR_ADDR, S1, { attemptTag: 't8' });
      ok('T8. an S2 whose id ≠ S1.id → failed, bad_reply', r.ok === false && r.reason === 'bad_reply' && r.requestWritten === true, JSON.stringify(r));
    } finally { await px.close(); }
  }
  {
    // A JSON-RPC error from receive_tx (e.g. TransactionAlreadyReceived) is a refusal, not an S2.
    const refused = { status: 200, body: rpc({ Err: { TransactionAlreadyReceived: S1.id } }) };
    const px = await startFakeSocks(wallet(CV_OK, refused));
    try {
      const r = await deliver(mk(px.port), TOR_ADDR, S1, { attemptTag: 't8b' });
      ok('T8. receive_tx answering result.Err → failed, receive_refused', r.ok === false && r.reason === 'receive_refused', JSON.stringify(r));
    } finally { await px.close(); }
  }
  {
    // T9. The probe's check_version kept its limits through the refactor: 16 KB body cap.
    const px = await startFakeSocks(() => ({ status: 200, body: '{"result":{"Ok":"' + 'x'.repeat(20000) + '"}}' }));
    try {
      const socket = await require(path.join(APP, 'lib/socks5.js')).connect({
        socksHost: '127.0.0.1', socksPort: px.port, host: 'x.onion', port: 80, timeoutMs: 2000 });
      const ans = await WalletTor.checkVersionOverSocket(socket, { onion: 'x.onion', port: 80, timeoutMs: 2000 });
      ok('T9. checkVersionOverSocket still caps the body at 16 KB', ans.body.length === 16 * 1024 && ans.truncated === true,
        `len=${ans.body.length}`);
      ok('T9. …and still sends check_version with params []', /"method":"check_version","params":\[\]/.test(px.seen[0].http));
    } finally { await px.close(); }
  }
}

async function preflightRequesterGoneSection() {
  section('Tor pre-flight gate — requester gone during the probe (Part 5)');
  const http = require('http');
  {
    // The primitive, proven on this Node: after the client disconnects mid-handler, res.destroyed
    // is true; for a client still waiting it is false. req.destroyed is NOT usable — Node ≥ 16
    // sets it once the body has been read, for every request.
    const seen = [];
    const server = http.createServer((req, res) => {
      req.resume();
      req.on('end', async () => {
        await new Promise((r) => setTimeout(r, 250));
        seen.push({ resDestroyed: res.destroyed, reqDestroyed: req.destroyed });
        if (!res.destroyed) res.end('ok');
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    const send = (leaveAfterMs) => new Promise((resolve) => {
      const s = net.connect(port, '127.0.0.1', () => {
        s.write('POST /w HTTP/1.1\r\nHost: t\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}');
        if (leaveAfterMs) setTimeout(() => { s.destroy(); resolve(); }, leaveAfterMs);
      });
      s.on('data', () => { s.destroy(); resolve(); });
      s.on('error', () => resolve());
    });
    try {
      await send(0);
      await send(60);
      await new Promise((r) => setTimeout(r, 400));
    } finally { await new Promise((r) => server.close(r)); }
    ok('gate primitive: res.destroyed is false for a requester still waiting', seen[0] && seen[0].resDestroyed === false, JSON.stringify(seen));
    ok('gate primitive: res.destroyed is true once the requester has gone', seen[1] && seen[1].resDestroyed === true, JSON.stringify(seen));
    ok('gate primitive: req.destroyed cannot tell them apart (never use it for this)',
      seen[0] && seen[1] && seen[0].reqDestroyed === true && seen[1].reqDestroyed === true, JSON.stringify(seen));
  }
  {
    const idx = fs.readFileSync(path.join(APP, 'index.js'), 'utf8');
    const route = idx.slice(idx.indexOf("app.post('/api/account/:addr/withdraw', "));
    const probeAt = route.indexOf('await walletTor.probeToronlineStatus(addr)');
    const createAt = route.indexOf('withdrawalScheduler.createWithdrawal(addr');
    const between = probeAt > 0 && createAt > probeAt ? route.slice(probeAt, createAt) : '';
    ok('the gate checks res.destroyed AFTER the probe and BEFORE createWithdrawal',
      /if \(res\.destroyed\)/.test(between), `probe@${probeAt} create@${createAt}`);
    const guard = between.slice(between.indexOf('if (res.destroyed)'));
    ok('…and that branch returns without creating anything',
      /^if \(res\.destroyed\) \{[\s\S]*?\breturn;\s*\}/.test(guard) && !/createWithdrawal/.test(guard.slice(0, guard.indexOf('return;'))),
      JSON.stringify(guard.slice(0, 120)));
  }
}

(async () => {
  // ─── Slatepack rail (and Goblin/Nostr, same wallet call) ──────────────────
  section('Slatepack rail — create_slatepack_message wire shape');
  {
    // a. The encrypted-to-miner call used by the slatepack rail.
    const { w, wire } = harness();
    const slate = JSON.parse(JSON.stringify(SLATE));
    const out = await w.createSlatepackMessage(slate, [RECIPIENT]);
    const p = wire[0] && wire[0].params;
    ok('a. exactly one wire call, to create_slatepack_message',
      wire.length === 1 && wire[0].method === 'create_slatepack_message', JSON.stringify(wire.map((c) => c.method)));
    ok('a. params go out as a NAMED object, not a positional array', isPlainObject(p), JSON.stringify(p));
    ok('a. token is the live session token', p && p.token === 'TOKEN-A', p && String(p.token));
    ok('a. slate is deep-equal to the input slate', p && same(p.slate, SLATE));
    ok('a. sender_index is 0 (the response comes back encrypted to the pool\'s index-0 address)',
      p && p.sender_index === 0, p && String(p.sender_index));
    ok('a. recipients are passed through as given', p && same(p.recipients, [RECIPIENT]));
    ok('a. no key outside the v3 parameter names (a stray or misspelt key is an ExtraNamedParameter error)',
      p && same(Object.keys(p).sort(), ['recipients', 'sender_index', 'slate', 'token']), p && Object.keys(p).join(','));
    ok('a. the armored string is returned unchanged', out === 'BEGINSLATEPACK. xyz. ENDSLATEPACK.');
  }
  {
    // b. The Goblin/Nostr rail's call: plain armor, recipients [].
    const { w, wire } = harness();
    await w.createSlatepackMessage(JSON.parse(JSON.stringify(SLATE)), []);
    const p = wire[0] && wire[0].params;
    ok('b. Goblin call: same named shape', isPlainObject(p) && p.token === 'TOKEN-A' && same(p.slate, SLATE) && p.sender_index === 0,
      JSON.stringify(p));
    ok('b. Goblin call: recipients is an empty array (plain armor)', p && Array.isArray(p.recipients) && p.recipients.length === 0);
  }
  {
    // e. The guard that would have caught THIS bug: what the wallet reads as `slate` is a slate.
    const { w, wire } = harness();
    await w.createSlatepackMessage(JSON.parse(JSON.stringify(SLATE)), [RECIPIENT]);
    const p = wire[0] && wire[0].params;
    const wireSlate = isPlainObject(p) ? p.slate : (Array.isArray(p) ? p[1] : undefined);
    ok('e. the value in the wallet\'s `slate` slot is an object carrying the slate id',
      isPlainObject(wireSlate) && wireSlate.id === SLATE.id, `got ${JSON.stringify(wireSlate)}`);
  }

  section('Slatepack rail — _call token fill (both sites)');
  {
    // c. Session retry must refill the ROTATED token into an object param too. The first wire
    //    call fails the way a stale mask does after a wallet restart / watchdog re-unlock.
    const { w, wire, inits } = harness({ failFirst: 'Wallet error: "Supplied keychain mask is invalid"' });
    await w.createSlatepackMessage(JSON.parse(JSON.stringify(SLATE)), [RECIPIENT]);
    ok('c. the session was re-established exactly once', inits() === 1, `inits=${inits()}`);
    ok('c. two wire calls: the failed one and the retry', wire.length === 2, `calls=${wire.length}`);
    ok('c. first call carried the old token', wire[0] && wire[0].params.token === 'TOKEN-A');
    ok('c. retry carries the ROTATED token in params.token',
      wire[1] && isPlainObject(wire[1].params) && wire[1].params.token === 'TOKEN-B', wire[1] && JSON.stringify(wire[1].params.token));
    ok('c. retry did not grow an array-style "0" key on the object',
      wire[1] && isPlainObject(wire[1].params) && !Object.prototype.hasOwnProperty.call(wire[1].params, '0'));
  }
  {
    // d. The positional path is not regressed: array calls still get the token in params[0].
    const { w, wire } = harness();
    await w.getSlatepackAddress(0);
    ok('d. an array call (get_slatepack_address) still gets params[0] === token',
      wire[0] && Array.isArray(wire[0].params) && wire[0].params[0] === 'TOKEN-A' && wire[0].params[1] === 0,
      wire[0] && JSON.stringify(wire[0].params));
  }
  {
    // d (retry). The array path's retry branch still refills params[0]. (This used cancelTx until
    // F5 moved cancel_tx to named params; retrieve_payment_proof is still positional.)
    const { w, wire } = harness({ failFirst: 'HTTP 401: Unauthorized' });
    await w.retrievePaymentProof(SLATE.id);
    ok('d. an array call\'s session retry refills params[0] with the rotated token',
      wire.length === 2 && Array.isArray(wire[1].params) && wire[1].params[0] === 'TOKEN-B' &&
      same(wire[1].params.slice(1), [false, null, SLATE.id]), wire[1] && JSON.stringify(wire[1].params));
  }

  // ─── F5 (Part 6): the send-path Owner v3 calls go out NAMED ───────────────
  // Names from owner_rpc.rs, identical in v5.4.1 and v5.5.0. A positional call here is how the
  // slatepack rail was broken for weeks (memory reference_grinwallet_owner_v3_params).
  section('Owner v3 send path — named params (init / lock / finalize / post / cancel)');
  {
    const { w, wire } = harness();
    await w.initSendTx(1.5, { paymentProofRecipient: TOR_ADDR });
    await w.txLockOutputs(JSON.parse(JSON.stringify(SLATE)));
    await w.finalizeTx(JSON.parse(JSON.stringify(SLATE)));
    await w.postTx(JSON.parse(JSON.stringify(SLATE)), true);
    await w.cancelTx(SLATE.id);
    const by = (m) => wire.find((c) => c.method === m) || {};
    const keys = (m) => (isPlainObject(by(m).params) ? Object.keys(by(m).params).sort().join(',') : 'NOT AN OBJECT');
    ok('init_send_tx → { token, args }', keys('init_send_tx') === 'args,token', keys('init_send_tx'));
    const a = (by('init_send_tx').params || {}).args || {};
    ok('init_send_tx args: amount in nanogrin, payment_proof_recipient_address = the miner address',
      a.amount === 1500000000 && a.payment_proof_recipient_address === TOR_ADDR, JSON.stringify(a));
    ok('init_send_tx args: ttl_blocks null and late_lock null (design §8.1.2)', a.ttl_blocks === null && a.late_lock === null);
    ok('init_send_tx carries a 60 s timeout (v5.5.0 refreshes from the node inside init)',
      by('init_send_tx').opts && by('init_send_tx').opts.timeoutMs === 60000, JSON.stringify(by('init_send_tx').opts));
    ok('tx_lock_outputs → { token, slate }', keys('tx_lock_outputs') === 'slate,token' && same(by('tx_lock_outputs').params.slate, SLATE),
      keys('tx_lock_outputs'));
    ok('finalize_tx → { token, slate }', keys('finalize_tx') === 'slate,token' && same(by('finalize_tx').params.slate, SLATE),
      keys('finalize_tx'));
    ok('post_tx → { token, slate, fluff }', keys('post_tx') === 'fluff,slate,token' && by('post_tx').params.fluff === true,
      keys('post_tx'));
    ok('cancel_tx → { token, tx_id: null, tx_slate_id }',
      keys('cancel_tx') === 'token,tx_id,tx_slate_id' && by('cancel_tx').params.tx_id === null &&
      by('cancel_tx').params.tx_slate_id === SLATE.id, JSON.stringify(by('cancel_tx').params));
    ok('every one of them carries the live session token',
      ['init_send_tx', 'tx_lock_outputs', 'finalize_tx', 'post_tx', 'cancel_tx'].every((m) => by(m).params && by(m).params.token === 'TOKEN-A'));
    ok('the other calls keep the default timeout (no opts)', ['tx_lock_outputs', 'finalize_tx', 'post_tx', 'cancel_tx'].every((m) => by(m).opts === null));
  }
  {
    // The slatepack rail's init is unchanged apart from the shape: no proof requested.
    const { w, wire } = harness();
    await w.initSendTx(2);
    const a = (wire[0] && wire[0].params && wire[0].params.args) || {};
    ok('initSendTx with no recipient still sends payment_proof_recipient_address null',
      Object.prototype.hasOwnProperty.call(a, 'payment_proof_recipient_address') && a.payment_proof_recipient_address === null, JSON.stringify(a));
  }
  {
    // withSendLock: strictly serial, and a throw releases the lock.
    const { w } = harness();
    const order = [];
    const slow = (name, ms, boom) => w.withSendLock(async () => {
      order.push(name + ':in'); await new Promise((r) => setTimeout(r, ms)); order.push(name + ':out');
      if (boom) throw new Error('boom');
      return name;
    });
    const results = await Promise.allSettled([slow('A', 40, true), slow('B', 5), slow('C', 1)]);
    ok('withSendLock runs each fn only after the previous one settles',
      order.join(' ') === 'A:in A:out B:in B:out C:in C:out', order.join(' '));
    ok('…a throwing fn rejects its own caller and still releases the lock',
      results[0].status === 'rejected' && results[1].value === 'B' && results[2].value === 'C');
  }

  // ─── Tor rail — the reachability probe (and withdraw pre-flight gate) ─────
  await torProbeSection();
  await preflightRequesterGoneSection();
  await torSendSection();
  await stepwiseTransportSection();

  console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
