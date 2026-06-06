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

// How many old job IDs remain valid for submit (avoids instant stale on slow networks)
const JOB_WINDOW = 10;

class StratumServer {
  constructor(config) {
    this.config = config;
    this.port = config.stratum_port || 3416;
    this.server = null;
    this.shareValidator = new ShareValidator(config);
    this.minerManager = new MinerManager(config);
    // Map<socket, sessionId|null> — authoritative socket registry for broadcasting
    this.sockets = new Map();
    // Current job pushed by NodeStratumClient via setNewJob()
    this.currentJob = null;
    this.jobCounter = 0;
    // Set by index.js after both are constructed
    this.nodeStratumClient = null;
  }

  // Wire the upstream node stratum client so submits can be forwarded for PoW validation.
  setNodeStratumClient(client) {
    this.nodeStratumClient = client;
  }

  start() {
    this.server = net.createServer((socket) => this.handleNewConnection(socket));

    this.server.listen(this.port, '0.0.0.0', () => {
      console.log(`[${new Date().toISOString()}] Stratum server listening on :${this.port}`);
    });

    this.server.on('error', (err) => {
      console.error(`[ERROR] Stratum server: ${err.message}`);
    });

    setInterval(() => this.pruneInactiveSessions(), 60000);
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

  handleNewConnection(socket) {
    const ip = socket.remoteAddress || 'unknown';
    let sessionId = null;
    let lineBuffer = '';

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

    socket.on('data', (data) => {
      // Buffer incoming bytes and only process complete newline-terminated messages.
      // Protects against TCP fragmentation splitting a JSON message across data events.
      lineBuffer += data.toString();
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
          ()    => sessionId
        );
      }
    });

    socket.on('error', cleanup);
    socket.on('end',   cleanup);
    socket.on('close', cleanup);
    socket.on('timeout', () => { socket.destroy(); cleanup(); });
  }

  handleMessage(socket, msg, ip, setSession, getSession) {
    switch (msg.method) {
      case 'login':
        this.handleLogin(socket, msg, ip, setSession);
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

  handleLogin(socket, msg, ip, setSession) {
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

    this.minerManager.ensureMinerExists(parsed.grin_address);
    const sessionId = this.minerManager.createSession(parsed.grin_address, parsed.worker_name, ip);
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

    const shareHash = this.shareValidator.generateShareHash(job_id, session.workerName, nonce);

    this.shareValidator.submitShare(
      session.grinAddress,
      session.workerName,
      session.difficulty,
      height,
      shareHash
    ).then(async (result) => {
      if (!result.success) {
        this._stat(sessionId, 'rejected');
        socket.write(JSON.stringify(createSubmitResponse(id, false, null, result.error)) + '\n');
        console.log(`[${new Date().toISOString()}] Share rejected: ${result.error}`);
        return;
      }

      this.minerManager.recordShare(session.grinAddress, session.difficulty);
      this._stat(sessionId, 'accepted');

      // Forward every accepted share upstream — the Grin node validates the actual
      // Cuckatoo32 PoW and tells us if this share is also a valid block solution.
      if (this.nodeStratumClient) {
        const nodeResult = await this.nodeStratumClient.forwardSubmit(params);
        if (nodeResult.blockHash) {
          console.log(`[${new Date().toISOString()}] BLOCK FOUND: height=${height} hash=${nodeResult.blockHash} miner=${session.grinAddress}`);
          socket.write(JSON.stringify(createSubmitResponse(id, true, nodeResult.blockHash)) + '\n');
          return;
        }
        if (!nodeResult.accepted) {
          console.warn(`[${new Date().toISOString()}] Node rejected share from ${session.grinAddress}: ${nodeResult.error}`);
        }
      }

      socket.write(JSON.stringify(createSubmitResponse(id, true)) + '\n');
      console.log(`[${new Date().toISOString()}] Share accepted: ${session.grinAddress} height=${height} job=${job_id}`);
    }).catch((err) => {
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
    if (this.server) this.server.close();
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
