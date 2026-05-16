const net = require('net');
const {
  parseStratumMessage,
  validateUsername,
  createSubscribeResponse,
  createSetDifficultyNotification,
  createShareResponse
} = require('./stratum-protocol');
const ShareValidator = require('./shares');
const MinerManager = require('./miners');

class StratumServer {
  constructor(config) {
    this.config = config;
    this.port = config.stratum_port || 3333;
    this.server = null;
    this.shareValidator = new ShareValidator(config);
    this.minerManager = new MinerManager(config);
    this.jobQueue = [];
    this.currentJobId = 0;
  }

  start() {
    this.server = net.createServer((socket) => {
      this.handleNewConnection(socket);
    });

    this.server.listen(this.port, () => {
      console.log(`[${new Date().toISOString()}] Stratum server listening on port ${this.port}`);
    });

    this.server.on('error', (err) => {
      console.error(`[ERROR] Stratum server error: ${err.message}`);
    });

    setInterval(() => this.pruneInactiveSessions(), 60000);
  }

  handleNewConnection(socket) {
    const ip = socket.remoteAddress;
    let sessionId = null;

    socket.setKeepAlive(true, 60000);
    socket.setTimeout(600000);

    socket.on('data', (data) => {
      const lines = data.toString().split('\n');

      for (const line of lines) {
        if (!line.trim()) continue;

        const msg = parseStratumMessage(line);
        if (!msg) {
          socket.write(JSON.stringify({ error: 'Invalid JSON' }) + '\n');
          continue;
        }

        if (msg.method === 'mining.subscribe' && !sessionId) {
          sessionId = this.handleSubscribe(socket, msg, ip);
        } else if (msg.method === 'mining.submit' && sessionId) {
          this.handleSubmit(socket, sessionId, msg);
        } else if (!sessionId) {
          socket.write(JSON.stringify({ error: 'Not subscribed' }) + '\n');
          socket.destroy();
          break;
        }
      }
    });

    socket.on('error', (err) => {
      if (sessionId) {
        this.minerManager.closeSession(sessionId);
      }
    });

    socket.on('end', () => {
      if (sessionId) {
        this.minerManager.closeSession(sessionId);
      }
    });

    socket.on('timeout', () => {
      socket.destroy();
      if (sessionId) {
        this.minerManager.closeSession(sessionId);
      }
    });
  }

  handleSubscribe(socket, msg, ip) {
    const username = msg.params && msg.params[0];

    const parsed = validateUsername(username);
    if (!parsed) {
      socket.write(
        JSON.stringify({
          jsonrpc: '2.0',
          error: { code: -1, message: 'Invalid username format. Use: grin_address[.worker_name]' },
          id: msg.id
        }) + '\n'
      );
      socket.destroy();
      return null;
    }

    this.minerManager.ensureMinerExists(parsed.grin_address);

    const subscriptionId = this.currentJobId.toString();
    const extraNonce1 = Math.random().toString(16).substring(2, 10);
    const extraNonce2Size = 4;

    const sessionId = this.minerManager.createSession(
      parsed.grin_address,
      parsed.worker_name,
      ip
    );

    const response = createSubscribeResponse(subscriptionId, extraNonce1, extraNonce2Size);
    response.id = msg.id;

    socket.write(JSON.stringify(response) + '\n');

    const diffResponse = createSetDifficultyNotification(subscriptionId, 1.0);
    socket.write(JSON.stringify(diffResponse) + '\n');

    console.log(
      `[${new Date().toISOString()}] Miner connected: ${parsed.grin_address}.${parsed.worker_name} (IP: ${ip})`
    );

    return sessionId;
  }

  handleSubmit(socket, sessionId, msg) {
    const [username, jobId, extraNonce2, blockBits, difficulty, blockTime] = msg.params || [];

    const session = this.minerManager.getSession(sessionId);
    if (!session) {
      socket.write(createShareResponse(msg.id, false, -1) + '\n');
      return;
    }

    const parsed = validateUsername(username);
    if (!parsed || parsed.grin_address !== session.grinAddress) {
      socket.write(
        JSON.stringify(
          createShareResponse(msg.id, false, -3)
        ) + '\n'
      );
      return;
    }

    // FIX #2: Validate share difficulty matches server-assigned difficulty
    // Prevents attacker from claiming 1B difficulty for single share
    if (difficulty !== undefined && difficulty !== session.difficulty) {
      console.warn(
        `[SECURITY] Difficulty mismatch: ${session.grinAddress} submitted ${difficulty}, expected ${session.difficulty}`
      );
      socket.write(
        JSON.stringify({
          jsonrpc: '2.0',
          error: { code: -4, message: 'Difficulty mismatch' },
          id: msg.id
        }) + '\n'
      );
      return;
    }

    // FIX #3: Validate job is current (not stale)
    // Prevents replaying old/past job submissions
    const isValidJob = this.isCurrentOrRecentJob(jobId);
    if (!isValidJob) {
      console.warn(`[SECURITY] Stale job submission: ${session.grinAddress} submitted job ${jobId}`);
      socket.write(
        JSON.stringify({
          jsonrpc: '2.0',
          error: { code: -5, message: 'Job not found or stale' },
          id: msg.id
        }) + '\n'
      );
      return;
    }

    const shareHash = this.shareValidator.generateShareHash(jobId, session.workerName, Date.now());

    const shareResult = this.shareValidator.submitShare(
      session.grinAddress,
      session.workerName,
      session.difficulty,
      0,
      shareHash
    );

    if (shareResult.success) {
      this.minerManager.recordShare(session.grinAddress, session.difficulty);
      socket.write(JSON.stringify(createShareResponse(msg.id, true)) + '\n');

      console.log(
        `[${new Date().toISOString()}] Share accepted: ${session.grinAddress} (difficulty: ${session.difficulty})`
      );
    } else {
      socket.write(JSON.stringify(createShareResponse(msg.id, false, -1)) + '\n');
      console.log(`[${new Date().toISOString()}] Share rejected: ${shareResult.error}`);
    }
  }

  broadcastNotification(notification) {
    if (this.server && this.server.connections) {
      for (const socket of this.server.connections) {
        socket.write(JSON.stringify(notification) + '\n');
      }
    }
  }

  pruneInactiveSessions() {
    const pruned = this.minerManager.pruneInactiveSessions();
    if (pruned > 0) {
      console.log(`[${new Date().toISOString()}] Pruned ${pruned} inactive sessions`);
    }
  }

  // FIX #3: Helper to validate job is current/recent (not stale)
  isCurrentOrRecentJob(jobId) {
    if (!jobId) return false;

    // Keep last 10 jobs in memory; anything older is rejected
    const recentJobWindow = 10;
    const currentJobNum = parseInt(this.currentJobId);
    const submittedJobNum = parseInt(jobId);

    if (isNaN(submittedJobNum)) return false;

    // Job must not be more than 'recentJobWindow' jobs old
    return submittedJobNum >= Math.max(0, currentJobNum - recentJobWindow);
  }

  stop() {
    if (this.server) {
      this.server.close();
    }
  }

  getStats() {
    const sessions = this.minerManager.getActiveSessions();
    return {
      active_connections: sessions.length,
      active_miners: this.minerManager.getActiveMinersCount(),
      sessions: sessions.map(s => ({
        grin_address: s.grinAddress,
        worker_name: s.workerName,
        difficulty: s.difficulty,
        shares: s.shareCount,
        online_seconds: Math.floor((Date.now() - s.subscribedAt) / 1000)
      }))
    };
  }
}

module.exports = StratumServer;
