'use strict';

// Grin stratum server.
// Protocol reference: https://github.com/mimblewimble/grin/blob/master/doc/stratum.md
// Flow:
//   1. Miner connects via TCP
//   2. Miner sends "login" (grin_address[.worker_name])
//   3. Server replies "ok" and immediately pushes current job
//   4. Server pushes "job" to ALL miners whenever block-monitor calls setNewJob()
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

// How many old job IDs remain valid for submit (avoids instant stale on slow networks)
const JOB_WINDOW = 10;

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
    this._listen(this.port, '0.0.0.0', this.config.region || 'default');

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
      this._listen(p, host, region);
    }

    setInterval(() => this.pruneInactiveSessions(), 60000);
  }

  // Bind one TCP stratum listener. `region` is the static label stamped on every share that
  // arrives on this socket (so attribution is bound by the tunnel wiring, not a typed string).
  _listen(port, host, region) {
    const server = net.createServer((socket) => this.handleNewConnection(socket, region));
    server.listen(port, host, () => {
      console.log(`[${new Date().toISOString()}] Stratum listener ${host}:${port} (region=${region})`);
    });
    server.on('error', (err) => {
      console.error(`[ERROR] Stratum listener ${host}:${port} (region=${region}): ${err.message}`);
    });
    this.servers.push(server);
  }

  // Called by block-monitor whenever the Grin node provides a new block template.
  // job = { height: number, difficulty: number, pre_pow: string }
  setNewJob(job) {
    this.jobCounter++;
    this.currentJob = {
      job_id:     this.jobCounter,
      height:     job.height,
      difficulty: job.difficulty,
      pre_pow:    job.pre_pow
    };
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

  handleNewConnection(socket, region) {
    // `ip` may be overwritten below by the PROXY-v2 header (real miner IP behind a gateway).
    let ip = socket.remoteAddress || 'unknown';
    let sessionId = null;
    let lineBuffer = '';
    // PROXY-protocol v2 phase: a gateway connection is prefixed with a binary PROXY v2 header;
    // direct/local miners send none. We buffer raw bytes until we can decide, then switch to
    // line-based stratum parsing. `proxyDone` flips once the decision is made (parsed or absent).
    let proxyDone = false;
    let preBuf = Buffer.alloc(0);

    socket.setKeepAlive(true, 60000);
    socket.setTimeout(600000);

    this.sockets.set(socket, null);

    const cleanup = () => {
      this.sockets.delete(socket);
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

      for (const line of lines) {
        if (!line.trim()) continue;

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

    const parsed = validateUsername(login);
    if (!parsed) {
      socket.write(JSON.stringify(
        createLoginResponse(id, { code: -1, message: 'Invalid login. Use grin_address or grin_address.worker_name' })
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

    // Capture the miner's source IP into its last-2-IP window (backs the ownership gate for
    // self-service actions). `ip` is the real miner IP — direct on :3333, or recovered from
    // the gateway's PROXY-protocol v2 header on a per-region listener (see handleNewConnection).
    this.minerManager.recordSourceIp(parsed.grin_address, ip);

    // Optional `donateN` worker tag → record the miner's voluntary donation %.
    // No-op unless donations are enabled in the admin panel.
    if (parsed.donation_percent !== null && parsed.donation_percent !== undefined) {
      try {
        this.incentives.setDonation(parsed.grin_address, parsed.donation_percent);
      } catch (e) {
        console.error(`Error setting donation for ${parsed.grin_address}: ${e.message}`);
      }
    }

    const sessionId = this.minerManager.createSession(parsed.grin_address, parsed.worker_name, ip, region);
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

    const shareHash = this.shareValidator.generateShareHash(session.grinAddress, job_id, session.workerName, nonce);

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
        nodeResult = await this.nodeStratumClient.forwardSubmit(params);
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
