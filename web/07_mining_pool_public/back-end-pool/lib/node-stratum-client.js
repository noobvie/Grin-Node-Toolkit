'use strict';

// Upstream stratum client — connects to the Grin node's built-in stratum server.
//
// Data flow:
//   Grin node stratum  →  NodeStratumClient.handleMessage("job")
//                       →  stratumServer.setNewJob()
//                       →  broadcast to all miners
//
//   Miner submits      →  StratumServer validates share
//                       →  NodeStratumClient.forwardSubmit()
//                       →  Grin node validates PoW
//                       →  returns { accepted, blockHash }
//
// The Grin node stratum port is SEPARATE from the pool stratum port.
// Configure node's grin-server.toml: stratum_server_addr = "127.0.0.1:<node_stratum_port>"
// Pool connects to that port; miners connect to stratum_port.

const net = require('net');
const { parseStratumMessage } = require('./stratum-protocol');

const RECONNECT_DELAY_MS = 5000;
const SUBMIT_TIMEOUT_MS  = 15000;

class NodeStratumClient {
  constructor(config, stratumServer) {
    this.host         = config.node_stratum_host || '127.0.0.1';
    this.port         = config.node_stratum_port || (config.network === 'mainnet' ? 3417 : 13417);
    this.poolAddress  = config.pool_address || '';
    this.stratumServer = stratumServer;
    this.socket       = null;
    this.lineBuffer   = '';
    this.connected    = false;
    this.stopping     = false;
    this.msgId        = 0;
    // Map<msgId, { resolve, timer }> for pending submit responses
    this.pending      = new Map();
  }

  start() {
    if (!this.poolAddress) {
      console.warn('[NodeStratumClient] pool_address not set in config — cannot login to node stratum');
      return;
    }
    this.connect();
  }

  connect() {
    if (this.stopping) return;

    this.socket     = new net.Socket();
    this.lineBuffer = '';

    this.socket.connect(this.port, this.host, () => {
      this.connected = true;
      console.log(`[${new Date().toISOString()}] NodeStratumClient connected to node stratum ${this.host}:${this.port}`);
      this.sendLogin();
    });

    this.socket.on('data', (data) => {
      this.lineBuffer += data.toString();
      const lines = this.lineBuffer.split('\n');
      this.lineBuffer = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        const msg = parseStratumMessage(line);
        if (msg) this.handleMessage(msg);
      }
    });

    this.socket.on('error', (err) => {
      console.error(`[NodeStratumClient] Socket error: ${err.message}`);
    });

    this.socket.on('close', () => {
      this.connected = false;
      // Cancel all pending submits so callers don't hang
      for (const [id, { resolve, timer }] of this.pending) {
        clearTimeout(timer);
        resolve({ accepted: false, error: 'Node stratum disconnected' });
      }
      this.pending.clear();

      if (!this.stopping) {
        console.log(`[NodeStratumClient] Disconnected — reconnecting in ${RECONNECT_DELAY_MS / 1000}s`);
        setTimeout(() => this.connect(), RECONNECT_DELAY_MS);
      }
    });
  }

  sendLogin() {
    this.send({
      method: 'login',
      params: { login: this.poolAddress, pass: '', agent: 'grin-pool/1.0' }
    });
  }

  handleMessage(msg) {
    // Job push from the node — relay to all connected miners
    if (msg.method === 'job') {
      const { difficulty, height, job_id, pre_pow } = msg.params || {};
      if (height !== undefined && pre_pow) {
        this.stratumServer.setNewJob({ height, difficulty, pre_pow });
      }
      return;
    }

    // Response to our login
    if (msg.method === 'login') {
      if (msg.result === 'ok') {
        console.log('[NodeStratumClient] Login accepted by node stratum');
      } else {
        console.error(`[NodeStratumClient] Login rejected: ${JSON.stringify(msg.error)}`);
      }
      return;
    }

    // Response to a submit we forwarded
    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const { resolve, timer } = this.pending.get(msg.id);
      clearTimeout(timer);
      this.pending.delete(msg.id);

      const resultStr = typeof msg.result === 'string' ? msg.result : '';
      resolve({
        accepted:  msg.result === 'ok' || resultStr.startsWith('blockfound'),
        blockHash: resultStr.startsWith('blockfound') ? resultStr.split(' - ')[1] || null : null,
        error:     msg.error ? msg.error.message : null
      });
    }
  }

  // Forward a miner's submit params to the Grin node for PoW validation.
  // Returns { accepted: bool, blockHash: string|null, error: string|null }
  async forwardSubmit(params) {
    if (!this.connected || !this.socket) {
      return { accepted: false, blockHash: null, error: 'Not connected to node stratum' };
    }

    return new Promise((resolve) => {
      const id = ++this.msgId;

      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          resolve({ accepted: false, blockHash: null, error: 'Node stratum submit timeout' });
        }
      }, SUBMIT_TIMEOUT_MS);

      this.pending.set(id, { resolve, timer });
      this.send({ id, method: 'submit', params });
    });
  }

  send(msgObj) {
    if (!msgObj.id)       msgObj.id = ++this.msgId;
    if (!msgObj.jsonrpc)  msgObj.jsonrpc = '2.0';
    if (this.socket && !this.socket.destroyed) {
      this.socket.write(JSON.stringify(msgObj) + '\n');
    }
  }

  getStatus() {
    return {
      connected:    this.connected,
      host:         this.host,
      port:         this.port,
      pending_jobs: this.pending.size
    };
  }

  stop() {
    this.stopping = true;
    if (this.socket) {
      this.socket.removeAllListeners('close');
      this.socket.destroy();
    }
    this.connected = false;
    console.log('[NodeStratumClient] Stopped');
  }
}

module.exports = NodeStratumClient;
