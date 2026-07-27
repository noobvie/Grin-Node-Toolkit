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
const { PASS_MAX } = require('./owner-proof');

// How many old job IDs remain valid for submit (avoids instant stale on slow networks)
const JOB_WINDOW = 10;

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

// Pure token-bucket step (extracted so it can be unit-tested without a socket — see
// scripts/test-stratum-guards.js). Refills `tokens` for the time elapsed since `lastMs`
// (capped at `burst`), then tries to spend one. Returns the new token count and whether the
// message is allowed. A flooder drives tokens below 1 and is refused; a legit miner never does.
function tokenBucketStep(tokens, lastMs, nowMs, ratePerSec, burst) {
  const refilled = Math.min(burst, tokens + ((nowMs - lastMs) / 1000) * ratePerSec);
  if (refilled < 1) return { tokens: refilled, allowed: false };
  return { tokens: refilled - 1, allowed: true };
}

// Grin block reward is a fixed 60 GRIN (no halving). Used when crediting a found
// block to the local DB. Under Model C all regions submit here, so this box always credits.
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
    // Connection-flood caps (finding 3). Global ceiling bounds total sockets; the per-IP cap
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
  bindRegionListener(region, rawPort) {
    const p = parseInt(rawPort, 10);
    if (!p || p === this.port) return false;
    for (const s of this.servers) {
      const a = typeof s.address === 'function' ? s.address() : null;
      if (a && a.port === p) return false; // already bound — hot-add is idempotent
    }
    const host = this.config.region_listen_host || '127.0.0.1';
    this._listen(p, host, region, false); // hot-added region = trusted tunnel, per-IP-cap exempt
    return true;
  }

  // Bind one TCP stratum listener. `region` is the static label stamped on every share that
  // arrives on this socket (so attribution is bound by the tunnel wiring, not a typed string).
  // `isPublic` gates the per-IP connection cap: true only for the untrusted public :3333 port.
  _listen(port, host, region, isPublic) {
    const server = net.createServer((socket) => this.handleNewConnection(socket, region, isPublic));
    server.listen(port, host, () => {
      console.log(`[${new Date().toISOString()}] Stratum listener ${host}:${port} (region=${region})`);
    });
    server.on('error', (err) => {
      console.error(`[ERROR] Stratum listener ${host}:${port} (region=${region}): ${err.message}`);
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
    // so the share dedup key is derived from pre_pow, not the pool job_id (finding 2 — otherwise
    // the same solved (nonce,pow) could be credited once per wrapping job_id). Drop entries older
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
    // `ip` may be overwritten below by the PROXY-v2 header (real miner IP behind a gateway).
    let ip = socket.remoteAddress || 'unknown';

    // Finding 3 — global socket ceiling: refuse once the process is at capacity so a
    // connection flood can't exhaust file descriptors / memory.
    if (this.sockets.size >= this.maxConnTotal) {
      socket.destroy();
      return;
    }

    // Finding 3 — per-IP connection cap (public listener only; region tunnels are trusted and
    // one peer IP fronts a whole region). Keyed on the real direct IP known at accept time.
    let ipCounted = false;
    if (isPublic) {
      const cur = this.connectionsByIp.get(ip) || 0;
      if (cur >= this.maxConnPerIp) {
        console.warn(`[${new Date().toISOString()}] Per-IP connection cap hit for ${ip} (${cur}) — refused`);
        socket.destroy();
        return;
      }
      this.connectionsByIp.set(ip, cur + 1);
      ipCounted = true;
    }

    let sessionId = null;
    let lineBuffer = '';
    // PROXY-protocol v2 phase: a gateway connection is prefixed with a binary PROXY v2 header;
    // direct/local miners send none. We buffer raw bytes until we can decide, then switch to
    // line-based stratum parsing. `proxyDone` flips once the decision is made (parsed or absent).
    let proxyDone = false;
    let preBuf = Buffer.alloc(0);

    // Finding 3/4 — per-connection message token bucket (throttles submit / login / pre-login
    // floods; each is refilled at MSG_RATE_PER_SEC, capped at MSG_BURST). A legitimate miner
    // never approaches this rate; a flooder is disconnected.
    let msgTokens = MSG_BURST;
    let msgRefill = Date.now();

    socket.setKeepAlive(true, 60000);
    socket.setTimeout(600000);

    this.sockets.set(socket, null);

    const cleanup = () => {
      this.sockets.delete(socket);
      if (ipCounted) {
        const n = (this.connectionsByIp.get(ip) || 1) - 1;
        if (n <= 0) this.connectionsByIp.delete(ip);
        else this.connectionsByIp.set(ip, n);
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

      // Finding 1 — a partial line that grows past MAX_LINE_BYTES has no newline in sight:
      // treat it as a malicious oversized frame and drop the connection before it can OOM us.
      // (This also bounds any complete line, since the partial is checked on every data event
      // before its terminating newline can arrive.)
      if (lineBuffer.length > MAX_LINE_BYTES) {
        console.warn(`[${new Date().toISOString()}] Oversized stratum frame from ${ip} (${lineBuffer.length} bytes) — disconnecting`);
        socket.destroy();
        return;
      }

      for (const line of lines) {
        if (!line.trim()) continue;

        // Finding 3/4 — refill and spend one message token; disconnect a flooder. Legit miners
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
          (sid) => { sessionId = sid; this.sockets.set(socket, sid); },
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
        this.handleLogin(socket, msg, ip, setSession, region);
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

  handleLogin(socket, msg, ip, setSession, region) {
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

    const parsed = validateUsername(login);
    if (!parsed) {
      socket.write(JSON.stringify(
        createLoginResponse(id, { code: -1, message: 'Invalid login. Use grin_address or grin_address.worker_name (worker name auto-shortens to 25 chars; keep it under 40)' })
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

    this.minerManager.ensureMinerExists(parsed.grin_address);

    // NOTE: the miner's source IP / password are deliberately NOT recorded here. Stratum login
    // is unauthenticated (the address IS the username), so recording at login let anyone with a
    // TCP socket log in under a victim's address and poison its ownership-proof windows
    // (evicting the real owner's proofs / passing the gate). Both are recorded on the session's
    // first ACCEPTED share instead (see handleSubmit) — evidence requires actual PoW.

    // Optional `donateN` worker tag → record the miner's voluntary donation %.
    // No-op unless donations are enabled in the admin panel.
    if (parsed.donation_percent !== null && parsed.donation_percent !== undefined) {
      try {
        this.incentives.setDonation(parsed.grin_address, parsed.donation_percent);
      } catch (e) {
        console.error(`Error setting donation for ${parsed.grin_address}: ${e.message}`);
      }
    }

    const sessionId = this.minerManager.createSession(parsed.grin_address, parsed.worker_name, ip, region, pass);
    setSession(sessionId);

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

    console.log(`[${new Date().toISOString()}] Miner login: ${parsed.grin_address}.${parsed.worker_name} (${ip})`);
  }

  handleSubmit(socket, msg, sessionId) {
    const { id, params } = msg;
    const session = this.minerManager.getSession(sessionId);

    if (!session) {
      socket.write(JSON.stringify(createSubmitResponse(id, false, null, 'Session not found')) + '\n');
      return;
    }

    // Grin stratum submit params (all required)
    const { edge_bits, height, job_id, nonce, pow } = params || {};

    if (edge_bits === undefined || height === undefined || job_id === undefined ||
        nonce === undefined || !Array.isArray(pow) || pow.length === 0) {
      this._stat(sessionId, 'rejected');
      socket.write(JSON.stringify(
        createSubmitResponse(id, false, null, 'Missing submit params: edge_bits, height, job_id, nonce, pow[]')
      ) + '\n');
      return;
    }

    // Stale job check
    if (!this.isValidJob(job_id)) {
      console.warn(`[SECURITY] Stale job ${job_id} from ${session.grinAddress} (current: ${this.jobCounter})`);
      this._stat(sessionId, 'stale');
      socket.write(JSON.stringify(createSubmitResponse(id, false, null, 'Stale job')) + '\n');
      return;
    }

    // Height must match the job we sent
    if (this.currentJob && height !== this.currentJob.height) {
      this._stat(sessionId, 'rejected');
      socket.write(JSON.stringify(createSubmitResponse(id, false, null, 'Height mismatch')) + '\n');
      return;
    }

    // Look up the job this submit references ONCE: we need both its node job_id (to translate
    // for the upstream node) and its pre_pow (the dedup key — see below).
    const jobEntry = this.jobIdMap.get(job_id);

    // Dedup key is bound to the ACTUAL WORK (pre_pow), not the pool's incrementing job_id.
    // The node re-issues many job_ids for one identical pre_pow, so keying on job_id would let
    // the same solved (nonce,pow) be credited once per wrapping job (finding 2). pre_pow collapses
    // every re-version of one template to a single dedup identity. Fall back to currentJob's
    // pre_pow (then job_id) only if the window entry is somehow gone — isValidJob already gated it.
    const workId = (jobEntry && jobEntry.pre_pow)
      ? jobEntry.pre_pow
      : (this.currentJob ? this.currentJob.pre_pow : String(job_id));
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
        const nodeJobId = jobEntry ? jobEntry.node : undefined;
        nodeResult = await this.nodeStratumClient.forwardSubmit(
          nodeJobId === undefined ? params : { ...params, job_id: nodeJobId }
        );
        if (!nodeResult.accepted) {
          this._stat(sessionId, 'rejected');
          console.warn(`[${new Date().toISOString()}] Node rejected share from ${session.grinAddress}: ${nodeResult.error}`);
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

      this.minerManager.recordShare(session.grinAddress, session.difficulty);
      this._stat(sessionId, 'accepted');

      // Ownership-gate evidence: record the miner's source IP + stratum password into the
      // address's proof windows only after the node ACCEPTED a share on this session — a login
      // alone must not count (see handleLogin). Once per session; session.ip is the real miner
      // IP (direct socket, or PROXY-protocol v2 value on a Model C gateway listener). Async
      // (scrypt hashing) — fire and forget, never blocks the share path.
      if (!session.ipRecorded) {
        session.ipRecorded = true;
        this.minerManager.recordOwnerEvidence(session.grinAddress, session.ip, session.pass);
        // Network-map: resolve the same real IP to a COUNTRY ONLY (never stored raw). Best-effort,
        // no-op without geoip-lite; own 6h throttle inside. See miners.recordMinerCountry.
        this.minerManager.recordMinerCountry(session.grinAddress, session.ip);
      }

      if (nodeResult.blockHash) {
        console.log(`[${new Date().toISOString()}] BLOCK FOUND: height=${height} hash=${nodeResult.blockHash} miner=${session.grinAddress}`);
        // Credit the found block to the local DB (creditBlock dedups by hash UNIQUE). Under
        // Model C every region's submits arrive here, so the central box is the sole crediter.
        if (this.blockManager) {
          try {
            await this.blockManager.creditBlock(
              height, nodeResult.blockHash, nonce, GRIN_BLOCK_REWARD, session.grinAddress
            );
          } catch (err) {
            console.error(`[ERROR] creditBlock: ${err.message}`);
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

  // job_id is valid if it's within the last JOB_WINDOW jobs
  isValidJob(jobId) {
    return this.jobCounter > 0 &&
           jobId > 0 &&
           jobId >= Math.max(1, this.jobCounter - JOB_WINDOW);
  }

  _stat(sessionId, field) {
    const session = this.minerManager.getSession(sessionId);
    if (session) session[field] = (session[field] || 0) + 1;
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
