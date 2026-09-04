'use strict';

// Grin stratum server.
// Protocol reference: https://github.com/mimblewimble/grin/blob/master/doc/stratum.md
// Flow:
//   1. Miner connects via TCP
//   2. Miner sends "login" (grin_address[.worker_name])
//   3. Server replies "ok" and immediately pushes current job
//   4. Server pushes "job" to ALL miners whenever NodeStratumClient calls setNewJob()
//   5. Miner sends "submit" with { edge_bits, height, job_id, nonce, pow: [...] }
//   6. Miner may also send "getjobtemplate" or "status" at any time

const net = require('net');
const {
  parseStratumMessage,
  validateUsername,
  createJobNotification,
  createLoginResponse,
  createSubmitResponse,
  createJobTemplateResponse,
  createStatusResponse
} = require('./stratum-protocol');
const ShareValidator = require('./shares');
const MinerManager = require('./miners');
const IncentivesManager = require('./incentives');
// Shared with the public feeds so the journal masks addresses the same way they do —
// one shape (grin1qxy…mn4p) rather than a second, divergent redaction (audit §J8-5).
const { maskAddress } = require('./dormancy');
const { PASS_MAX } = require('./owner-proof');

// How many old job IDs remain valid for submit (avoids instant stale on slow networks)
const JOB_WINDOW = 10;

// Accepted shares one session must produce before it may DISPLACE an ownership proof this
// address already has on record (audit §J3-4). It gates rotation only — never first capture,
// which still happens on share 1 — so it cannot strand a rig that reconnects too often to
// reach it. Kept low on purpose: any working rig clears it in seconds at the node's minimum
// share difficulty, while an attacker evicting both window slots must now donate this much
// hashrate to the victim twice over. This raises the cost of eviction; the thing that makes
// eviction survivable is the write-once anchor in owner-proof.js.
const PROOF_MIN_SHARES = 4;

// Attack-surface caps for the raw TCP stratum port (:3333 is public + pre-auth).
// MAX_LINE_BYTES: a single newline-terminated stratum message. A Grin submit with a
//   42-element pow[] is well under 1 KB; 16 KB is generous. A client that streams bytes
//   with no '\n' would otherwise grow lineBuffer without bound → OOM. Destroy on breach.
// MSG_RATE_PER_SEC / MSG_BURST: per-connection message token bucket. A real miner sends
//   one login then a few submits per second at most; 25/s sustained (burst 100) is far
//   above any legitimate rate but bounds a submit/login/pre-login flood (each submit costs
//   an upstream node round-trip). Covers the pre-login getjobtemplate/status amplification.
const MAX_LINE_BYTES    = 16 * 1024;
const MSG_RATE_PER_SEC  = 25;
const MSG_BURST         = 100;

// Consecutive node-rejected submits, with no accept in between, before the socket is dropped
// (audit §J6-5). Nothing used to penalise a session that produced only rejects: `session.rejected`
// was counted and then only ever DISPLAYED, and banMiner has exactly one caller (the admin route).
// Every such submit costs the Grin node a full Cuckatoo verification and writes a log line, so one
// address inside the documented budget (25 msg/s × 320 conns) could force ~8,000 PoW verifications
// and ~1 MB/s of journal per second. A real rig's reject rate is ~1%, so 50 IN A ROW never happens
// legitimately — the counter resets on every accepted share.
const MAX_CONSECUTIVE_REJECTS = 50;

// One warn line per session per key per this interval; the suppressed count is folded into the
// next one (audit §J6-5). The rejection path must stay diagnosable without being a log amplifier.
const WARN_THROTTLE_MS = 60000;

// A connection must complete `login` within this long of being accepted, or it is destroyed
// (audit §J6-8). Before this the ONLY thing that closed an unauthenticated socket was
// socket.setTimeout(600000) — Node's INACTIVITY timer, which restarts on every byte received —
// so one newline every nine minutes held a slot in the global ceiling forever, with no login and
// no proof of anything, while that ceiling refuses REAL miners once reached. A rig logs in
// immediately; 60s is generous for a slow link.
const LOGIN_DEADLINE_MS = 60000;

// Pure token-bucket step (extracted so it can be unit-tested without a socket — see
// scripts/test-stratum-guards.js). Refills `tokens` for the time elapsed since `lastMs`
// (capped at `burst`), then tries to spend one. Returns the new token count and whether the
// message is allowed. A flooder drives tokens below 1 and is refused; a legit miner never does.
function tokenBucketStep(tokens, lastMs, nowMs, ratePerSec, burst) {
  const refilled = Math.min(burst, tokens + ((nowMs - lastMs) / 1000) * ratePerSec);
  if (refilled < 1) return { tokens: refilled, allowed: false };
  return { tokens: refilled - 1, allowed: true };
}

// Grin's block EMISSION is a fixed 60 GRIN (no halving). This is not the whole coinbase:
// the finder is also paid the block's transaction fees, so creditBlock() adds them on top
// after reading the block's kernels from the node (audit §J5-10). Pass the emission here and
// let BlockManager compute the total — never treat this constant as the reward.
// Under Model C all regions submit here, so this box always credits.
const GRIN_BLOCK_REWARD = 60;

// PROXY-protocol v2 12-byte signature: "\r\n\r\n\0\r\nQUIT\n".
// Regional gateways (HAProxy `send-proxy-v2`) prepend this binary header to each forwarded
// stratum connection so the central box recovers the REAL miner IP instead of the tunnel IP.
const PROXY_V2_SIG = Buffer.from([0x0D, 0x0A, 0x0D, 0x0A, 0x00, 0x0D, 0x0A, 0x51, 0x55, 0x49, 0x54, 0x0A]);

// Largest PROXY v2 header we will buffer before deciding. A basic `send-proxy-v2` TCP header
// is 16 + 12 (IPv4) or 16 + 36 (IPv6) bytes; 256 leaves generous room for small TLVs while
// capping a junk/slowloris header that matches the signature but never completes.
const PROXY_V2_MAX = 256;

// Parse a PROXY-protocol v2 header from the front of `buf` (pure JS, no native module).
// Returns one of:
//   { state: 'need-more' }               — not enough bytes yet to decide or complete
//   { state: 'absent' }                  — present bytes are NOT a PROXY v2 header (direct miner)
//   { state: 'parsed', ip, consumed }    — header consumed; `ip` = real client IP (null for LOCAL/
//                                          unknown family → keep the socket's own address)
function parseProxyV2Header(buf) {
  // Reject as soon as any known signature byte mismatches — a real stratum client's first byte
  // is '{' (0x7B) ≠ 0x0D, so direct connections decide 'absent' on byte 0.
  const cmp = Math.min(buf.length, PROXY_V2_SIG.length);
  for (let i = 0; i < cmp; i++) {
    if (buf[i] !== PROXY_V2_SIG[i]) return { state: 'absent' };
  }
  if (buf.length < 16) return { state: 'need-more' };       // need the full fixed header

  const verCmd = buf[12];
  if ((verCmd & 0xF0) !== 0x20) return { state: 'absent' }; // high nibble must be version 2
  const command  = verCmd & 0x0F;                            // 0 = LOCAL, 1 = PROXY
  const family   = (buf[13] & 0xF0) >> 4;                    // 1 = AF_INET, 2 = AF_INET6
  const addrLen  = buf.readUInt16BE(14);
  const total    = 16 + addrLen;
  if (buf.length < total) return { state: 'need-more' };

  // LOCAL (e.g. a health probe) carries no meaningful address — keep the socket's own IP.
  if (command === 0) return { state: 'parsed', ip: null, consumed: total };

  let ip = null;
  if (family === 1 && addrLen >= 12) {
    // IPv4 address block: src(4) dst(4) sport(2) dport(2)
    ip = `${buf[16]}.${buf[17]}.${buf[18]}.${buf[19]}`;
  } else if (family === 2 && addrLen >= 36) {
    // IPv6 address block: src(16) dst(16) sport(2) dport(2)
    const parts = [];
    for (let i = 0; i < 16; i += 2) parts.push(buf.readUInt16BE(16 + i).toString(16));
    ip = parts.join(':');
  }
  // AF_UNIX / unknown family → leave ip null (caller falls back to socket.remoteAddress).
  return { state: 'parsed', ip, consumed: total };
}

class StratumServer {
  constructor(config) {
    this.config = config;
    this.port = config.stratum_port || 3333;
    // Connection-flood caps. Global ceiling bounds total sockets; the per-IP cap
    // applies ONLY to the public listener keyed on the real direct IP — region listeners are
    // trusted WireGuard tunnels where one peer IP fronts a whole region, so they are exempt.
    // Defaults sized with 5× headroom over a ~1000-miner target (miners run several rigs, so
    // connections ≈ 3–5× miners) to avoid re-tuning as the pool grows. Both stay well under the
    // service's LimitNOFILE=65535 (see the systemd unit in 07_grin_mining_public_pool.sh).
    // The per-IP default is deliberately generous so shared-NAT / CGNAT / farm miners aren't
    // collateral-blocked; the gateway edge (HAProxy stick-table) is the finer per-IP control.
    this.maxConnTotal  = config.max_stratum_connections || 25000;
    this.maxConnPerIp  = config.max_connections_per_ip  || 320;
    // Map<ip, count> of live PUBLIC-listener connections, for the per-IP cap.
    this.connectionsByIp = new Map();
    // One net.Server per listener: the public stratum_port (direct/local miners) plus one
    // internal port per region (Model C gateways). All share the socket registry + job below.
    this.servers = [];
    // Ports this process has CLAIMED, updated synchronously by _listen and consulted by
    // bindRegionListener's idempotency check (audit §J6-12). It cannot be derived from
    // `this.servers`: net.Server#address() returns null until the asynchronous listen has
    // completed, and _listen pushes the server object before that — so a re-pair issued before
    // the previous bind settled read null, skipped the match and bound the same port twice.
    this.boundPorts = new Set();
    this.shareValidator = new ShareValidator(config);
    this.minerManager = new MinerManager(config);
    this.incentives = new IncentivesManager(config);
    // Map<socket, sessionId|null> — authoritative socket registry for broadcasting
    this.sockets = new Map();
    // Current job pushed by NodeStratumClient via setNewJob()
    this.currentJob = null;
    this.jobCounter = 0;
    // Map<pool job_id, node job_id> for every job in the valid window. Miners submit
    // OUR job_id; the node only accepts ITS OWN (the block-version index it re-issues
    // every ~15s). Forwarding without this translation makes the node call every share
    // stale. Per-job (not latest-only): a submit may race a fresh job push.
    this.jobIdMap = new Map();
    // Set by index.js after both are constructed
    this.nodeStratumClient = null;
    // Set by index.js (setBlockManager) so found blocks are credited to the local DB.
    this.blockManager = null;
  }

  // Wire the upstream node stratum client so submits can be forwarded for PoW validation.
  setNodeStratumClient(client) {
    this.nodeStratumClient = client;
  }

  // Wire the block manager so found blocks are recorded locally.
  setBlockManager(bm) {
    this.blockManager = bm;
  }

  start() {
    // Public listener: direct + local miners. Region = config.region (default single-box).
    // isPublic=true → per-IP connection cap applies (untrusted direct clients).
    this._listen(this.port, '0.0.0.0', this.config.region || 'default', true);

    // Model C: one internal listener per region, bound to the WireGuard interface only.
    // Regional gateways tunnel here with a PROXY-v2 header; the listener's region label is
    // stamped on every share that arrives on it. Empty region_ports = single-box (no-op).
    const regionPorts = this.config.region_ports || {};
    const host = this.config.region_listen_host || '127.0.0.1';
    for (const [region, rawPort] of Object.entries(regionPorts)) {
      const p = parseInt(rawPort, 10);
      if (!p || p === this.port) {
        console.error(`[ERROR] Invalid or duplicate region port for "${region}": ${rawPort} — skipped`);
        continue;
      }
      this._listen(p, host, region, false); // trusted tunnel — exempt from per-IP cap
    }

    setInterval(() => this.pruneInactiveSessions(), 60000);
  }

  // Runtime region-listener add (design §13.3 hot-bind): the admin-panel pairing
  // flow lives in THIS process, so it can't restart the service to pick up a new
  // region_ports entry — it calls this instead. Same accept/stamp logic as the
  // boot-time loop; idempotent (a port that is already served is left alone), so
  // re-pairing an existing region is a no-op. Caller updates config.region_ports
  // first (the helper already persisted it to pool.json for the next boot).
  // Returns a Promise resolving to { bound, already, port, error } — the REAL outcome, not an
  // unconditional true (audit §J6-12). _listen's error handler only logged and there was no way
  // to report a failed bind, so the admin panel reported a successful pairing for a listener
  // that was not listening. The caller (index.js gateway-pair route) surfaces this now.
  bindRegionListener(region, rawPort) {
    const p = parseInt(rawPort, 10);
    if (!p || p === this.port) {
      return Promise.resolve({ bound: false, already: false, port: p || null,
        error: `Invalid or reserved region port: ${rawPort}` });
    }
    if (this.boundPorts.has(p)) {
      return Promise.resolve({ bound: false, already: true, port: p, error: null });
    }
    const host = this.config.region_listen_host || '127.0.0.1';
    return new Promise((resolve) => {
      // hot-added region = trusted tunnel, per-IP-cap exempt
      this._listen(p, host, region, false, (err) => {
        resolve(err
          ? { bound: false, already: false, port: p, error: err.message }
          : { bound: true,  already: false, port: p, error: null });
      });
    });
  }

  // Bind one TCP stratum listener. `region` is the static label stamped on every share that
  // arrives on this socket (so attribution is bound by the tunnel wiring, not a typed string).
  // `isPublic` gates the per-IP connection cap: true only for the untrusted public :3333 port.
  // `done(err|null)` is called EXACTLY once, on the first of listening/error. The port is claimed
  // in boundPorts synchronously (before the async listen settles) and released on failure, so the
  // idempotency check in bindRegionListener can never race a bind in flight (audit §J6-12).
  _listen(port, host, region, isPublic, done) {
    const server = net.createServer((socket) => this.handleNewConnection(socket, region, isPublic));
    let settled = false;
    const settle = (err) => {
      if (settled) return;
      settled = true;
      if (err) {
        this.boundPorts.delete(port);
        const i = this.servers.indexOf(server);
        if (i >= 0) this.servers.splice(i, 1);   // don't leave a dead listener in the registry
      }
      if (typeof done === 'function') done(err || null);
    };
    this.boundPorts.add(port);
    server.listen(port, host, () => {
      console.log(`[${new Date().toISOString()}] Stratum listener ${host}:${port} (region=${region})`);
      settle(null);
    });
    server.on('error', (err) => {
      console.error(`[ERROR] Stratum listener ${host}:${port} (region=${region}): ${err.message}`);
      settle(err);
    });
    this.servers.push(server);
  }

  // Called by NodeStratumClient whenever the node pushes a new job.
  // job = { height: number, difficulty: number, pre_pow: string, node_job_id: number }
  setNewJob(job) {
    this.jobCounter++;
    this.currentJob = {
      job_id:     this.jobCounter,
      height:     job.height,
      difficulty: job.difficulty,
      pre_pow:    job.pre_pow
    };
    // Remember which node job this pool job wraps AND its pre_pow. The pre_pow is the identity
    // of the actual work: the node re-issues many job_ids for one identical pre_pow (~every 15s),
    // so the share dedup key is derived from pre_pow, not the pool job_id (otherwise the same
    // solved (nonce,pow) could be credited once per wrapping job_id). Drop entries older
    // than the submit window (keys ascend in insertion order, so stop at the first keeper).
    this.jobIdMap.set(this.jobCounter, { node: job.node_job_id, pre_pow: job.pre_pow });
    for (const k of this.jobIdMap.keys()) {
      if (k >= this.jobCounter - JOB_WINDOW) break;
      this.jobIdMap.delete(k);
    }
    console.log(`[${new Date().toISOString()}] New job #${this.jobCounter} height=${job.height} diff=${job.difficulty}`);
    this.broadcastJob();
  }

  broadcastJob() {
    if (!this.currentJob) return;
    const msg = JSON.stringify(createJobNotification(
      this.currentJob.job_id,
      this.currentJob.height,
      this.currentJob.difficulty,
      this.currentJob.pre_pow
    )) + '\n';
    for (const socket of this.sockets.keys()) {
      if (!socket.destroyed) socket.write(msg);
    }
  }

  handleNewConnection(socket, region, isPublic) {
    // `ip` may be overwritten below by the PROXY-v2 header (real miner IP behind a gateway) —
    // but only on a REGION listener; see the PROXY phase below.
    let ip = socket.remoteAddress || 'unknown';
    // The address observed at ACCEPT time, frozen. This is the key the per-IP cap counts, and it
    // must never move (audit §J6-3b): `cleanup` used to decrement `this.connectionsByIp.get(ip)`
    // — the MUTABLE binding — so a connection whose `ip` had been rewritten decremented a key
    // holding nothing and left the real address counted for the life of the process. 320
    // connect-header-disconnect cycles then permanently exhausted one source address's budget,
    // which is self-inflicted for a lone attacker and a denial of service against everyone else
    // when the address is shared (CGNAT, mining-farm NAT) — precisely the population the cap's
    // generous default exists to protect. Keep the increment and the decrement on THIS constant.
    const cappedIp = ip;

    // Global socket ceiling: refuse once the process is at capacity so a
    // connection flood can't exhaust file descriptors / memory.
    if (this.sockets.size >= this.maxConnTotal) {
      socket.destroy();
      return;
    }

    // Per-IP connection cap (public listener only; region tunnels are trusted and
    // one peer IP fronts a whole region). Keyed on the real direct IP known at accept time.
    let ipCounted = false;
    if (isPublic) {
      const cur = this.connectionsByIp.get(cappedIp) || 0;
      if (cur >= this.maxConnPerIp) {
        console.warn(`[${new Date().toISOString()}] Per-IP connection cap hit for ${cappedIp} (${cur}) — refused`);
        socket.destroy();
        return;
      }
      this.connectionsByIp.set(cappedIp, cur + 1);
      ipCounted = true;
    }

    let sessionId = null;
    let lineBuffer = '';
    // PROXY-protocol v2 phase: a gateway connection is prefixed with a binary PROXY v2 header;
    // direct/local miners send none. We buffer raw bytes until we can decide, then switch to
    // line-based stratum parsing. `proxyDone` flips once the decision is made (parsed or absent).
    //
    // ⚠ Pre-set on the PUBLIC listener, so :3333 is always raw stratum (audit §J6-3a). A PROXY
    // header is only ever legitimate on a REGION listener: the regional gateway's HAProxy is
    // configured `server central <hub_wg_ip>:<region_port> send-proxy-v2` (07_lib_gateway.sh),
    // i.e. it dials the tunnel port over WireGuard and never the public one. Parsing it here too
    // meant any anonymous client could ASSERT the IP the pool recorded — the value that becomes
    // session.ip, and therefore the ownership gate's IP leg and the network map's country
    // attribution. The §J3 fixes correctly put both writes behind an accepted share, but they
    // assumed the address being written was OBSERVED. On :3333 it now always is.
    let proxyDone = !!isPublic;
    let preBuf = Buffer.alloc(0);

    // Per-connection message token bucket (throttles submit / login / pre-login
    // floods; each is refilled at MSG_RATE_PER_SEC, capped at MSG_BURST). A legitimate miner
    // never approaches this rate; a flooder is disconnected.
    let msgTokens = MSG_BURST;
    let msgRefill = Date.now();

    socket.setKeepAlive(true, 60000);
    socket.setTimeout(600000);

    this.sockets.set(socket, null);

    // Pre-login deadline (audit §J6-8). Cleared the moment a session is established, so it only
    // ever fires on a socket that has occupied a slot in the global ceiling without logging in.
    let loginTimer = setTimeout(() => {
      loginTimer = null;
      if (!sessionId && !socket.destroyed) {
        console.warn(`[${new Date().toISOString()}] No login within ${LOGIN_DEADLINE_MS}ms from ${cappedIp} — disconnecting`);
        socket.destroy();
      }
    }, LOGIN_DEADLINE_MS);
    if (typeof loginTimer.unref === 'function') loginTimer.unref();
    const clearLoginTimer = () => {
      if (loginTimer) { clearTimeout(loginTimer); loginTimer = null; }
    };

    const cleanup = () => {
      this.sockets.delete(socket);
      clearLoginTimer();
      if (ipCounted) {
        // cappedIp, never `ip` — see the note where it is frozen (audit §J6-3b).
        const n = (this.connectionsByIp.get(cappedIp) || 1) - 1;
        if (n <= 0) this.connectionsByIp.delete(cappedIp);
        else this.connectionsByIp.set(cappedIp, n);
        ipCounted = false;
      }
      if (sessionId) {
        this.minerManager.closeSession(sessionId);
        sessionId = null;
      }
    };

    // Process whatever complete newline-terminated stratum messages are buffered.
    // Protects against TCP fragmentation splitting a JSON message across data events.
    const processLines = () => {
      const lines = lineBuffer.split('\n');
      lineBuffer = lines.pop(); // last element may be partial — keep buffered

      // A partial line that grows past MAX_LINE_BYTES has no newline in sight:
      // treat it as a malicious oversized frame and drop the connection before it can OOM us.
      // (This also bounds any complete line, since the partial is checked on every data event
      // before its terminating newline can arrive.)
      if (lineBuffer.length > MAX_LINE_BYTES) {
        console.warn(`[${new Date().toISOString()}] Oversized stratum frame from ${ip} (${lineBuffer.length} bytes) — disconnecting`);
        socket.destroy();
        return;
      }

      for (const line of lines) {
        // Spend a token for EVERY frame, including blank/whitespace-only ones — the skip used to
        // sit above this and blank frames were therefore free (audit §J6-8). Combined with the
        // pre-login deadline above, a socket can no longer be held open indefinitely for one byte.
        //
        // Refill and spend one message token; disconnect a flooder. Legit miners
        // send a login then a few submits/sec, nowhere near MSG_RATE_PER_SEC.
        const now = Date.now();
        const bucket = tokenBucketStep(msgTokens, msgRefill, now, MSG_RATE_PER_SEC, MSG_BURST);
        msgRefill = now;
        msgTokens = bucket.tokens;
        if (!bucket.allowed) {
          console.warn(`[${new Date().toISOString()}] Message rate cap exceeded (${ip}) — disconnecting`);
          socket.destroy();
          return;
        }

        if (!line.trim()) continue;

        // The connection is alive: refresh its session's idle clock (audit §J6-2). This is the
        // ONLY thing that keeps a working rig out of pruneInactiveSessions(), and it lives in
        // the message loop rather than in handleSubmit on purpose — a `status` / `getjobtemplate`
        // keepalive between shares is activity too. Deliberately AFTER the token bucket, so a
        // flood cannot buy itself immortality, and after the blank-line skip, so a lone newline
        // cannot either.
        if (sessionId) this.minerManager.touchSession(sessionId);

        const msg = parseStratumMessage(line);
        if (!msg) {
          socket.write(JSON.stringify({
            id: null,
            jsonrpc: '2.0',
            error: { code: -32700, message: 'Parse error' }
          }) + '\n');
          continue;
        }

        this.handleMessage(socket, msg, ip,
          (sid) => { sessionId = sid; this.sockets.set(socket, sid); clearLoginTimer(); },
          ()    => sessionId,
          region
        );
      }
    };

    socket.on('data', (data) => {
      if (!proxyDone) {
        preBuf = preBuf.length ? Buffer.concat([preBuf, data]) : Buffer.from(data);
        const r = parseProxyV2Header(preBuf);
        if (r.state === 'need-more') {
          // A signature match that never completes (junk/slowloris) must not buffer forever.
          if (preBuf.length > PROXY_V2_MAX) { socket.destroy(); }
          return;
        }
        proxyDone = true;
        let rest;
        if (r.state === 'parsed') {
          if (r.ip) ip = r.ip;             // real miner IP from the gateway
          rest = preBuf.subarray(r.consumed);
        } else {
          rest = preBuf;                   // 'absent' → every buffered byte is stratum data
        }
        preBuf = Buffer.alloc(0);
        lineBuffer += rest.toString();
        processLines();
        return;
      }
      lineBuffer += data.toString();
      processLines();
    });

    socket.on('error', cleanup);
    socket.on('end',   cleanup);
    socket.on('close', cleanup);
    socket.on('timeout', () => { socket.destroy(); cleanup(); });
  }

  handleMessage(socket, msg, ip, setSession, getSession, region) {
    switch (msg.method) {
      case 'login':
        this.handleLogin(socket, msg, ip, setSession, region, getSession);
        break;

      case 'submit':
        if (!getSession()) {
          socket.write(JSON.stringify(
            createLoginResponse(msg.id, { code: -1, message: 'Not logged in' })
          ) + '\n');
        } else {
          this.handleSubmit(socket, msg, getSession());
        }
        break;

      case 'getjobtemplate':
        this.handleGetJobTemplate(socket, msg);
        break;

      case 'status':
        this.handleStatus(socket, msg, getSession());
        break;

      default:
        socket.write(JSON.stringify({
          id: msg.id,
          jsonrpc: '2.0',
          error: { code: -32601, message: 'Method not found' }
        }) + '\n');
    }
  }

  handleLogin(socket, msg, ip, setSession, region, getSession) {
    const { id, params } = msg;
    // params may be an object { login, pass, agent } or a positional array
    const login = params && (typeof params === 'object'
      ? (params.login || (Array.isArray(params) ? params[0] : null))
      : null);
    // Stratum password — kept in the in-memory session only, and hashed into the address's
    // ownership-proof window on the session's first ACCEPTED share (owner-proof.js decides
    // whether it is usable; factory defaults like "x" are never captured). Never logged.
    //
    // Retention cap: ASIC firmware password fields are often unbounded (a G1 Mini accepts 54k+
    // chars), and MAX_LINE_BYTES lets ~16 KB of that through per login. Anything over PASS_MAX
    // can never be usable proof, so holding it for the life of the session is pure waste. Slice
    // to PASS_MAX + 1 — one char PAST the limit, so an over-long password is still correctly
    // REJECTED as too long rather than silently truncated into something that validates.
    const rawPass = params && typeof params === 'object'
      ? (typeof params.pass === 'string' ? params.pass
        : (Array.isArray(params) && typeof params[1] === 'string' ? params[1] : ''))
      : '';
    const pass = rawPass.length > PASS_MAX ? rawPass.slice(0, PASS_MAX + 1) : rawPass;

    // The network is passed so a wrong-chain spelling of a valid key is refused here rather
    // than becoming a second account (audit §J17-4). Stratum login is the ONLY path that
    // creates a miner_accounts row, so this one call decides the pool's whole identity space.
    const isMain = this.config && this.config.network === 'mainnet';
    const parsed = validateUsername(login, isMain ? 'mainnet' : 'testnet');
    if (!parsed) {
      socket.write(JSON.stringify(
        createLoginResponse(id, { code: -1, message:
          `Invalid login. Use a ${isMain ? 'mainnet grin1…' : 'testnet tgrin1…'} Slatepack address, ` +
          `optionally as address.worker_name (worker name auto-shortens to 25 chars; keep it under 40)` })
      ) + '\n');
      socket.destroy();
      return;
    }

    // Moderation gate: a banned address is refused before a session is created, so it
    // cannot submit shares. The balance row is left untouched (banMiner never deletes it),
    // so anything already owed can still be paid out.
    if (this.minerManager.isBanned(parsed.grin_address)) {
      socket.write(JSON.stringify(
        createLoginResponse(id, { code: -1, message: 'This address is banned from the pool.' })
      ) + '\n');
      socket.destroy();
      console.warn(`[${new Date().toISOString()}] Rejected banned miner login: ${parsed.grin_address} (${ip})`);
      return;
    }

    // Re-login on a socket that already holds a session: close the old one FIRST (audit §J6-4).
    // `setSession` below overwrites the connection's only handle to it, and `cleanup` can reclaim
    // just the one that handle points at — so without this, each repeated login abandoned a live
    // session that survived until the ten-minute sweep. At 25 msg/s × 320 connections that is
    // ~8,000 orphaned sessions/second per source address, each holding the address, region, worker
    // name and the stratum password as typed, and each counted by getActiveMinersCount() /
    // getStats() on the two PUBLIC endpoints that iterate activeSessions in full. The sweep that
    // eventually cleared them ran closeSession → updateMinerOnline per entry: millions of
    // synchronous SQLite UPDATEs in one loop on the event loop the share path shares.
    // The Grin stratum protocol has no re-login flow, so nothing legitimate reaches this.
    const priorSession = typeof getSession === 'function' ? getSession() : null;
    if (priorSession) {
      this.minerManager.closeSession(priorSession);
    }

    this.minerManager.ensureMinerExists(parsed.grin_address);

    // NOTE: the miner's source IP / password are deliberately NOT recorded here. Stratum login
    // is unauthenticated (the address IS the username), so recording at login let anyone with a
    // TCP socket log in under a victim's address and poison its ownership-proof windows
    // (evicting the real owner's proofs / passing the gate). Both are recorded on the session's
    // first ACCEPTED share instead (see handleSubmit) — evidence requires actual PoW.

    const sessionId = this.minerManager.createSession(parsed.grin_address, parsed.worker_name, ip, region, pass);
    setSession(sessionId);

    // Optional `donateN` worker tag → the miner's voluntary donation %. PARKED on the session
    // here and applied on the first accepted share (audit §J3-5), for exactly the reason the
    // note below gives about proof capture: this handler is unauthenticated, so applying it at
    // login let ANY TCP client send `{"login":"<victim>.x-donate100"}` and permanently divert
    // up to 100% of that address's future PPLNS credit into the prize pool — persistently (a
    // normal login carries no donate tag, so the victim's own rig never clears it) and
    // irreversibly (the prize pool pays out to other people). Donations are on by default, so
    // this needed no operator misconfiguration. The tag is a convenience, not an instruction
    // from someone who has proved anything.
    if (parsed.donation_percent !== null && parsed.donation_percent !== undefined) {
      const s = this.minerManager.getSession(sessionId);
      if (s) s.donationPercent = parsed.donation_percent;
    }

    socket.write(JSON.stringify(createLoginResponse(id)) + '\n');

    // Push current job immediately so the miner can start working
    if (this.currentJob) {
      socket.write(JSON.stringify(createJobNotification(
        this.currentJob.job_id,
        this.currentJob.height,
        this.currentJob.difficulty,
        this.currentJob.pre_pow
      )) + '\n');
    }

    // Address MASKED, IP in full (audit §J8-5). This one line is the only place the pool ever
    // writes a miner's full address next to their real MINING ip — nginx never sees stratum, so
    // there is no second copy — and it is exactly the pairing owner-proof.js spends a 16 MB
    // scrypt per capture to avoid storing in `miner_accounts.last_ip`. journald keeps it for
    // whatever SystemMaxUse/MaxRetentionSec say, which on an untuned box is months.
    //
    // The IP is kept whole on purpose, and the address is masked instead: the full IP is how an
    // operator identifies and `ufw deny`s an abusive rig, and coarsening it (§G1's choice for
    // the DB) would remove that with no replacement. Masking the address instead breaks the
    // linkage — which is the actual defect — while leaving the ban workflow intact. The worker
    // name stays: it is operator-supplied, not an identity.
    console.log(`[${new Date().toISOString()}] Miner login: ${maskAddress(parsed.grin_address)}.${parsed.worker_name} (${ip})`);
  }

  handleSubmit(socket, msg, sessionId) {
    const { id, params } = msg;
    const session = this.minerManager.getSession(sessionId);

    if (!session) {
      socket.write(JSON.stringify(createSubmitResponse(id, false, null, 'Session not found')) + '\n');
      return;
    }

    // Grin stratum submit params (all required).
    // TYPES are checked as well as presence (audit §J6-11). The pool still does NOT judge the
    // solution — the node stays the authority on the PoW — but every one of these values is
    // re-serialised onto the shared upstream node socket, so each must be the shape the node's
    // serde expects before it goes anywhere near it. `job_id` is normalised to a number here so
    // a string-typed id from an unusual client is still translated rather than silently stale.
    const { edge_bits, height, nonce, pow } = params || {};
    const job_id = typeof (params || {}).job_id === 'string'
      ? Number((params || {}).job_id)
      : (params || {}).job_id;

    const badParams =
      typeof edge_bits !== 'number' || !Number.isFinite(edge_bits) ||
      typeof height    !== 'number' || !Number.isFinite(height) ||
      typeof job_id    !== 'number' || !Number.isFinite(job_id) ||
      nonce === undefined || nonce === null ||
      !Array.isArray(pow) || pow.length === 0 ||
      !pow.every((n) => typeof n === 'number' && Number.isFinite(n));

    if (badParams) {
      this._stat(sessionId, 'rejected');
      if (this._rejectCeilingHit(socket, session)) return;
      socket.write(JSON.stringify(
        createSubmitResponse(id, false, null, 'Missing or malformed submit params: edge_bits, height, job_id, nonce, pow[]')
      ) + '\n');
      return;
    }

    // Stale job check
    if (!this.isValidJob(job_id)) {
      this._warnThrottled(session, 'stale',
        (n) => `[SECURITY] Stale job ${job_id} from ${session.grinAddress} (current: ${this.jobCounter})` +
               (n ? ` [+${n} suppressed]` : ''));
      this._stat(sessionId, 'stale');
      socket.write(JSON.stringify(createSubmitResponse(id, false, null, 'Stale job')) + '\n');
      return;
    }

    // Height must match the job we sent
    if (this.currentJob && height !== this.currentJob.height) {
      this._stat(sessionId, 'rejected');
      if (this._rejectCeilingHit(socket, session)) return;
      socket.write(JSON.stringify(createSubmitResponse(id, false, null, 'Height mismatch')) + '\n');
      return;
    }

    // Look up the job this submit references ONCE: we need both its node job_id (to translate
    // for the upstream node) and its pre_pow (the dedup key — see below).
    // isValidJob() now asks jobIdMap itself, so a valid job_id ALWAYS has an entry here and there
    // are no fallbacks left (audit §J6-10). The two that used to sit here were documented as
    // unreachable and were not: the second degraded `workId` to `String(job_id)`, i.e. made the
    // dedup key the miner's own integer — the exact state the 2026-07-17 pre_pow fix removed.
    const jobEntry = this.jobIdMap.get(job_id);
    if (!jobEntry || !jobEntry.pre_pow) {
      this._stat(sessionId, 'stale');
      socket.write(JSON.stringify(createSubmitResponse(id, false, null, 'Stale job')) + '\n');
      return;
    }

    // Dedup key is bound to the ACTUAL WORK (pre_pow), not the pool's incrementing job_id.
    // The node re-issues many job_ids for one identical pre_pow, so keying on job_id would let
    // the same solved (nonce,pow) be credited once per wrapping job. pre_pow collapses
    // every re-version of one template to a single dedup identity. The worker name is passed for
    // signature compatibility only and is NOT hashed — see generateShareHash (audit §J6-1).
    const workId = jobEntry.pre_pow;
    const shareHash = this.shareValidator.generateShareHash(session.grinAddress, workId, session.workerName, nonce);

    // CRITICAL ORDERING: validate the PoW with the Grin node BEFORE crediting anything.
    // The node is the authority — it checks the actual Cuckatoo32 solution against the pool's
    // share difficulty and reports whether this submit is a valid share (and whether it also
    // solves a full block). Recording the share first (as a previous version did) let anyone
    // farm PPLNS credit by sending structurally-valid submits with a bogus pow[] array: the
    // node would reject them, but the share was already counted. Now nothing is persisted
    // unless the node accepts the PoW. If the node is briefly unreachable, forwardSubmit
    // returns accepted:false and we reject the share (the miner resubmits) rather than crediting
    // unvalidated work.
    (async () => {
      let nodeResult = { accepted: true, blockHash: null, error: null };
      if (this.nodeStratumClient) {
        // Translate OUR job_id to the node's own id for this job — the node rejects
        // its unknown ids as stale (see jobIdMap in the constructor).
        //
        // Build the node payload from the five KNOWN fields rather than spreading `params`
        // (audit §J6-11). The old `{ ...params, job_id }` forwarded every key the miner
        // invented, in the miner's own insertion order, onto the single upstream socket every
        // miner's shares share — which is what let a decoy `nonce` key win the send-side
        // quote-stripping replacement, and what would turn one crafted frame into a pool-wide
        // outage if grin's stratum ever dropped a connection on a malformed message rather than
        // answering with an error.
        const nodeJobId = jobEntry.node === undefined ? job_id : jobEntry.node;
        nodeResult = await this.nodeStratumClient.forwardSubmit({
          edge_bits, height, job_id: nodeJobId, nonce, pow
        });
        if (!nodeResult.accepted) {
          this._stat(sessionId, 'rejected');
          this._warnThrottled(session, 'noderej',
            (n) => `[${new Date().toISOString()}] Node rejected share from ${session.grinAddress}: ${nodeResult.error}` +
                   (n ? ` [+${n} suppressed]` : ''));
          if (this._rejectCeilingHit(socket, session)) return;
          socket.write(JSON.stringify(createSubmitResponse(id, false, null, nodeResult.error || 'Share rejected by node')) + '\n');
          return;
        }
      }
      // else: no upstream node wired (dev/test only) — fall through and record optimistically.

      // PoW accepted by the node → now it's safe to record the share for PPLNS.
      const result = await this.shareValidator.submitShare(
        session.grinAddress,
        session.workerName,
        session.difficulty,
        height,
        shareHash,
        session.region
      );
      if (!result.success) {
        // Node accepted the PoW but we couldn't record it (duplicate share_hash UNIQUE, or DB
        // error). Don't double-credit — report rejected without counting it.
        this._stat(sessionId, 'rejected');
        socket.write(JSON.stringify(createSubmitResponse(id, false, null, result.error)) + '\n');
        console.log(`[${new Date().toISOString()}] Share not recorded: ${result.error}`);
        return;
      }

      // A share the node accepted AND we recorded: this connection is behaving. Clear the
      // consecutive-reject counter (audit §J6-5) — the ceiling only ever fires on an
      // uninterrupted run of failures, which a real rig at a ~1% reject rate never produces.
      session.consecutiveRejects = 0;

      this.minerManager.recordShare(session.grinAddress, session.difficulty);
      this._stat(sessionId, 'accepted');
      // Per-CONNECTION accepted-share count. recordShare() above deliberately fans out across
      // every session on the address, so it cannot answer "has THIS socket done any work?" —
      // and that is the only question the two ownership guards below are asking.
      session.acceptedShares = (session.acceptedShares || 0) + 1;

      // Ownership-gate evidence: record the miner's source IP + stratum password into the
      // address's proof windows only after the node ACCEPTED a share on this session — a login
      // alone must not count (see handleLogin). Once per session; session.ip is the real miner
      // IP (direct socket, or PROXY-protocol v2 value on a Model C gateway listener). Async
      // (scrypt hashing) — fire and forget, never blocks the share path.
      if (!session.ipRecorded) {
        session.ipRecorded = true;
        // Network-map: resolve the same real IP to a COUNTRY ONLY (never stored raw). Best-effort,
        // no-op without geoip-lite; own 6h throttle inside. See miners.recordMinerCountry.
        this.minerManager.recordMinerCountry(session.grinAddress, session.ip);

      }

      // Voluntary donation tag, parked at login and applied here. §J3-5 moved it off the
      // unauthenticated login handler and onto the first accepted share; §J6-7 adds the two
      // conditions that make the cost match what it moves:
      //
      //   · PROOF_MIN_SHARES, not one share — the same bar as ROTATING an ownership proof this
      //     address already has. Redirecting up to 100% of an address's future PPLNS credit must
      //     not be cheaper than rotating its identity, and it was: one share, and the share the
      //     attacker had to produce was itself credited to the victim.
      //   · A RAISE needs the slot to be empty; a LOWER is always honoured. So a stranger can
      //     only ever reduce someone's donation (harmless), the victim can always clear a tag
      //     someone else set by logging in once with `.donate0`, and the first value an address
      //     ever sets still works with no ceremony. This matters because the proceeds go to the
      //     prize pool, which pays out to OTHER people — the diversion is irreversible once made.
      if (session.donationPercent !== null && session.donationPercent !== undefined &&
          !session.donationDone && session.acceptedShares >= PROOF_MIN_SHARES) {
        session.donationDone = true;
        try {
          const current = this.incentives.donationPercent(session.grinAddress) || 0;
          if (session.donationPercent <= current || current === 0) {
            this.incentives.setDonation(session.grinAddress, session.donationPercent);
          } else {
            console.warn(`[${new Date().toISOString()}] Donation raise ${current}%→${session.donationPercent}% ` +
                         `refused for ${session.grinAddress}: a stored donation may only be LOWERED from stratum (§J6-7)`);
          }
        } catch (e) {
          console.error(`Error setting donation for ${session.grinAddress}: ${e.message}`);
        }
      }

      // Ownership-proof capture runs at most twice per session, and the second pass is the
      // point of it (audit §J3-4). The window is only two slots deep and anyone may mine to
      // anyone's address, so two hostile sessions used to evict both of a miner's proofs — and
      // a miner who had since stopped mining could never re-capture, leaving their balance
      // unreachable. DISPLACING a stored value now costs sustained work, not one share:
      //   · first accepted share  → capture, but only into EMPTY slots (mayDisplace false).
      //     A brand-new address has nothing to protect, and gating first capture would strand
      //     a rig that reconnects too often to ever reach the threshold.
      //   · PROOF_MIN_SHARES-th   → capture again, now permitted to rotate an existing value.
      // recordOwnerEvidence is a no-op when nothing changed, so a normal rig writes once.
      if (!session.evidenceDone &&
          (session.acceptedShares === 1 || session.acceptedShares >= PROOF_MIN_SHARES)) {
        const mayDisplace = session.acceptedShares >= PROOF_MIN_SHARES;
        if (mayDisplace) session.evidenceDone = true;
        this.minerManager.recordOwnerEvidence(
          session.grinAddress, session.ip, session.pass, { mayDisplace }
        );
      }

      if (nodeResult.blockHash) {
        console.log(`[${new Date().toISOString()}] BLOCK FOUND: height=${height} hash=${nodeResult.blockHash} miner=${session.grinAddress}`);
        // Credit the found block to the local DB (creditBlock dedups by hash UNIQUE). Under
        // Model C every region's submits arrive here, so the central box is the sole crediter.
        if (this.blockManager) {
          // ⚠ creditBlock does NOT throw — it catches internally and returns {success:false}
          // (blocks.js). This try/catch therefore never fired, the return value used to be
          // discarded, and the very next statement told the miner the submit succeeded. A
          // block the node accepted but the DB never recorded is then invisible everywhere:
          // §J5-8's distribution_stalled detector reads `FROM blocks` and a row that was never
          // INSERTed has nothing to be stuck. The end state is indistinguishable from bad luck.
          // Audit §J7-1 — read the result, and make the failure impossible to miss.
          let credited = null;
          try {
            credited = await this.blockManager.creditBlock(
              height, nodeResult.blockHash, nonce, GRIN_BLOCK_REWARD, session.grinAddress
            );
          } catch (err) {
            credited = { success: false, error: err.message };
          }
          if (!credited || credited.success === false) {
            const reason = (credited && credited.error) || 'unknown';
            console.error(
              `[CRITICAL] BLOCK NOT RECORDED: height=${height} hash=${nodeResult.blockHash} ` +
              `miner=${session.grinAddress} nonce=${nonce} — ${reason}. The node accepted this ` +
              `block but the pool database did not store it, so its reward will never mature, ` +
              `distribute or reconcile. RECORD THESE VALUES: they are the only copy outside the chain.`
            );
            // Fire-and-forget: the miner's submit response must not wait on a webhook. The
            // alert carries every field needed to re-enter the block by hand.
            if (this.alertMonitor && typeof this.alertMonitor.triggerAlert === 'function') {
              Promise.resolve(this.alertMonitor.triggerAlert('block_record_failed', {
                level: 'critical',
                message:
                  `Block ${height} (${nodeResult.blockHash}) was accepted by the node but could NOT be ` +
                  `written to pool.db: ${reason}. Its reward will never be distributed until it is ` +
                  `re-entered by hand. Found by ${session.grinAddress}.`,
                data: {
                  height, hash: nodeResult.blockHash, nonce: String(nonce),
                  found_by: session.grinAddress, reward: GRIN_BLOCK_REWARD, error: reason,
                },
              })).catch((e) => console.error(`[CRITICAL] and the alert failed too: ${e.message}`));
            }
          }
        }
        socket.write(JSON.stringify(createSubmitResponse(id, true, nodeResult.blockHash)) + '\n');
        return;
      }

      socket.write(JSON.stringify(createSubmitResponse(id, true)) + '\n');
      console.log(`[${new Date().toISOString()}] Share accepted: ${session.grinAddress} height=${height} job=${job_id}`);
    })().catch((err) => {
      console.error(`[ERROR] Share submission: ${err.message}`);
      socket.write(JSON.stringify(createSubmitResponse(id, false, null, 'Internal error')) + '\n');
    });
  }

  handleGetJobTemplate(socket, msg) {
    if (!this.currentJob) {
      socket.write(JSON.stringify({
        id: msg.id, jsonrpc: '2.0', result: null,
        error: { code: -1, message: 'No job available' }
      }) + '\n');
      return;
    }
    socket.write(JSON.stringify(createJobTemplateResponse(
      msg.id,
      this.currentJob.job_id,
      this.currentJob.height,
      this.currentJob.difficulty,
      this.currentJob.pre_pow
    )) + '\n');
  }

  handleStatus(socket, msg, sessionId) {
    const session = sessionId ? this.minerManager.getSession(sessionId) : null;
    socket.write(JSON.stringify(createStatusResponse(msg.id, {
      sessionId:  session ? session.sessionId : 'none',
      height:     this.currentJob ? this.currentJob.height : 0,
      difficulty: session ? session.difficulty : 0,
      accepted:   session ? (session.accepted || 0) : 0,
      rejected:   session ? (session.rejected || 0) : 0,
      stale:      session ? (session.stale    || 0) : 0
    })) + '\n');
  }

  // A job_id is valid iff jobIdMap still holds it — that map IS the window, pruned to
  // JOB_WINDOW entries by setNewJob (audit §J6-10). The old arithmetic form had no upper bound
  // (`jobCounter + 1000` passed), accepted non-integers, and never consulted the structure that
  // actually knows which jobs exist — so "valid" and "present in the map" could disagree, which
  // is what made the fallbacks in handleSubmit reachable.
  isValidJob(jobId) {
    return Number.isInteger(jobId) && this.jobIdMap.has(jobId);
  }

  _stat(sessionId, field) {
    const session = this.minerManager.getSession(sessionId);
    if (!session) return;
    session[field] = (session[field] || 0) + 1;
    // Consecutive node-rejected submits with no accept in between (audit §J6-5). `stale` is
    // excluded: it is legitimate every time a new job lands mid-flight.
    if (field === 'rejected') {
      session.consecutiveRejects = (session.consecutiveRejects || 0) + 1;
    } else if (field === 'accepted') {
      session.consecutiveRejects = 0;
    }
  }

  // Drop a connection that has produced MAX_CONSECUTIVE_REJECTS failures in a row (audit §J6-5).
  // Returns true when the socket was destroyed, so the caller returns without writing a reply.
  // Each rejected submit costs the Grin node a full Cuckatoo verification and a log line, and
  // nothing else in this subsystem ever acted on session.rejected — it was counted and displayed.
  _rejectCeilingHit(socket, session) {
    if (!session || (session.consecutiveRejects || 0) < MAX_CONSECUTIVE_REJECTS) return false;
    console.warn(`[${new Date().toISOString()}] ${session.consecutiveRejects} consecutive rejected submits ` +
                 `from ${maskAddress(session.grinAddress)} (${session.ip}) — disconnecting`);  // §J8-5
    socket.destroy();
    return true;
  }

  // One warn line per session per `key` per WARN_THROTTLE_MS; suppressed lines are counted and
  // the count is folded into the next one (audit §J6-5). Without this, a rejecting flood inside
  // the documented message budget writes ~1 MB/s of journal onto the disk the SQLite DB lives on.
  // `build(suppressedCount)` is only called when the line is actually emitted.
  _warnThrottled(session, key, build) {
    if (!session) { console.warn(build(0)); return; }
    const state = session._warnState || (session._warnState = {});
    const st = state[key] || (state[key] = { last: 0, suppressed: 0 });
    const now = Date.now();
    if (now - st.last < WARN_THROTTLE_MS) { st.suppressed++; return; }
    const n = st.suppressed;
    st.suppressed = 0;
    st.last = now;
    console.warn(build(n));
  }

  pruneInactiveSessions() {
    const pruned = this.minerManager.pruneInactiveSessions();
    if (pruned > 0) {
      console.log(`[${new Date().toISOString()}] Pruned ${pruned} inactive sessions`);
    }
  }

  stop() {
    for (const server of this.servers) {
      try { server.close(); } catch (e) { /* already closed */ }
    }
    // Release the port claims too, or a restart in the same process is refused as
    // already-bound by the idempotency check (audit §J6-12).
    this.boundPorts.clear();
  }

  getStats() {
    const sessions = this.minerManager.getActiveSessions();
    return {
      active_connections: this.sockets.size,
      active_miners:      this.minerManager.getActiveMinersCount(),
      current_height:     this.currentJob ? this.currentJob.height : null,
      current_job_id:     this.jobCounter,
      sessions: sessions.map(s => ({
        grin_address:   s.grinAddress,
        worker_name:    s.workerName,
        difficulty:     s.difficulty,
        shares:         s.shareCount,
        accepted:       s.accepted    || 0,
        rejected:       s.rejected    || 0,
        stale:          s.stale       || 0,
        online_seconds: Math.floor((Date.now() - s.subscribedAt) / 1000)
      }))
    };
  }
}

module.exports = StratumServer;
// Exposed for unit testing the gateway PROXY-protocol v2 path (see scripts/test-proxy-v2.js).
module.exports.parseProxyV2Header = parseProxyV2Header;
// Exposed for unit testing the stratum flood guards (see scripts/test-stratum-guards.js).
module.exports.tokenBucketStep = tokenBucketStep;
module.exports.MAX_LINE_BYTES  = MAX_LINE_BYTES;
module.exports.MSG_RATE_PER_SEC = MSG_RATE_PER_SEC;
module.exports.MSG_BURST        = MSG_BURST;
module.exports.MAX_CONSECUTIVE_REJECTS = MAX_CONSECUTIVE_REJECTS;
module.exports.LOGIN_DEADLINE_MS       = LOGIN_DEADLINE_MS;
module.exports.JOB_WINDOW              = JOB_WINDOW;
module.exports.MSG_RATE_PER_SEC = MSG_RATE_PER_SEC;
module.exports.MSG_BURST        = MSG_BURST;
