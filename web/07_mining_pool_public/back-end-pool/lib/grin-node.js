const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

class GrinNodeAPI {
  constructor(config) {
    this.nodeUrl = config.node_api_url || 'http://127.0.0.1:13413';
    this.network = config.network || 'testnet';

    // The Grin node secures BOTH its Owner (/v2/owner, .api_secret) and Foreign
    // (/v2/foreign, .foreign_api_secret) endpoints with HTTP Basic Auth (grin:<secret>).
    // They live in two separate files in the node directory. We resolve each from, in order:
    //   1. an explicit value in pool.json (node_api_secret / node_foreign_api_secret)
    //   2. an explicit path  (node_api_secret_path / node_foreign_api_secret_path)
    //   3. the standard node dir location /opt/grin/node/<net>-prune/.{api,foreign_api}_secret
    // Reading by path means there are no copies to keep in sync when the node is rebuilt —
    // the pool service runs as root, so it can read the grin-owned secret files directly.
    const nodeDir = config.node_dir || `/opt/grin/node/${this.network}-prune`;
    this.secret = this._resolveSecret(
      config.node_api_secret, config.node_api_secret_path,
      path.join(nodeDir, '.api_secret')
    );
    this.foreignSecret = this._resolveSecret(
      config.node_foreign_api_secret, config.node_foreign_api_secret_path,
      path.join(nodeDir, '.foreign_api_secret')
    );
  }

  // Prefer an explicit value, then an explicit/default file path. Placeholder values
  // (CHANGE_ME…) and unreadable files resolve to '' so the call simply goes out unauthed
  // (matches a node that has auth disabled) rather than sending a bogus credential.
  _resolveSecret(value, explicitPath, defaultPath) {
    if (value && String(value).trim() && !/^CHANGE_ME/i.test(value)) {
      return String(value).trim();
    }
    const p = explicitPath || defaultPath;
    try {
      if (p && fs.existsSync(p)) return fs.readFileSync(p, 'utf-8').trim();
    } catch (_) { /* unreadable → unauthenticated call */ }
    return '';
  }

  async getStatus() {
    try {
      const result = await this._ownerRpcCall('get_status', []);
      const tipHeight = result.tip ? result.tip.height : 0;
      // get_status reports sync state as a string ('no_sync' once caught up); while syncing it
      // may carry a sync_info object with the network's highest known height. peer count comes
      // from `connections` (a stringified integer in the node response).
      const syncStatus = result.sync_status || 'unknown';
      const synced = syncStatus === 'no_sync';
      let networkHeight = tipHeight;
      const si = result.sync_info;
      if (si && typeof si === 'object') {
        const hh = si.highest_height || (si.sync_head && si.sync_head.height) || si.current_height;
        if (hh && hh > networkHeight) networkHeight = hh;
      }
      return {
        ok: true,
        height: tipHeight,
        header_height: tipHeight,
        network_height: networkHeight,
        peer_count: parseInt(result.connections, 10) || 0,
        sync_status: syncStatus,
        synced,
        total_difficulty: result.tip ? result.tip.total_difficulty : 0,
        difficulty: result.tip ? result.tip.total_difficulty : 0,
        network: this.network,
        timestamp: Date.now()
      };
    } catch (err) {
      return {
        ok: false,
        error: err.message,
        timestamp: Date.now()
      };
    }
  }

  async getTip() {
    try {
      const result = await this._foreignRpcCall('get_tip', []);
      return {
        height: result.height,
        hash: result.hash,
        total_difficulty: result.total_difficulty
      };
    } catch (err) {
      throw new Error(`Failed to get tip: ${err.message}`);
    }
  }

  async getHeader(height) {
    try {
      const result = await this._foreignRpcCall('get_header', [height]);
      return {
        height: result.height,
        hash: result.hash,
        nonce: result.nonce,
        timestamp: result.timestamp,
        difficulty: result.difficulty,
        total_difficulty: result.total_difficulty
      };
    } catch (err) {
      throw new Error(`Failed to get header for height ${height}: ${err.message}`);
    }
  }

  async getBlock(height) {
    try {
      const result = await this._foreignRpcCall('get_block', [height]);
      return {
        header: {
          height: result.header.height,
          hash: result.header.hash,
          nonce: result.header.nonce,
          timestamp: result.header.timestamp
        },
        inputs: result.inputs || [],
        outputs: result.outputs || [],
        kernels: result.kernels || []
      };
    } catch (err) {
      throw new Error(`Failed to get block ${height}: ${err.message}`);
    }
  }

  async getOutputs(commitments) {
    try {
      if (!Array.isArray(commitments)) {
        commitments = [commitments];
      }

      const result = await this._foreignRpcCall('get_outputs', [commitments]);
      return result;
    } catch (err) {
      throw new Error(`Failed to get outputs: ${err.message}`);
    }
  }

  async validateChain() {
    try {
      const result = await this._ownerRpcCall('validate_chain', []);
      return result;
    } catch (err) {
      throw new Error(`Chain validation failed: ${err.message}`);
    }
  }

  async _ownerRpcCall(method, params = []) {
    return this._rpcCall(`${this.nodeUrl}/v2/owner`, method, params, this.secret);
  }

  async _foreignRpcCall(method, params = []) {
    return this._rpcCall(`${this.nodeUrl}/v2/foreign`, method, params, this.foreignSecret);
  }

  async _rpcCall(endpoint, method, params = [], secret = '') {
    const headers = {
      'Content-Type': 'application/json'
    };

    if (secret) {
      const credentials = Buffer.from(`grin:${secret}`).toString('base64');
      headers['Authorization'] = `Basic ${credentials}`;
    }

    const payload = {
      jsonrpc: '2.0',
      method,
      params,
      id: Math.random().toString(36).substring(7)
    };

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        timeout: 10000
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json();

      if (data.error) {
        throw new Error(`RPC error: ${data.error.message}`);
      }

      if (data.result && data.result.Ok) {
        return data.result.Ok;
      }

      if (data.result && data.result.Err) {
        throw new Error(`RPC error: ${JSON.stringify(data.result.Err)}`);
      }

      return data.result;
    } catch (err) {
      throw new Error(`RPC call ${method} failed: ${err.message}`);
    }
  }
}

module.exports = GrinNodeAPI;
