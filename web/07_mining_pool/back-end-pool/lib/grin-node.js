const fetch = require('node-fetch');

class GrinNodeAPI {
  constructor(config) {
    this.nodeUrl = config.node_api_url || 'http://127.0.0.1:13413';
    this.secret = config.node_api_secret || '';
    this.network = config.network || 'testnet';
  }

  async getStatus() {
    try {
      const result = await this._ownerRpcCall('get_status', []);
      return {
        ok: true,
        height: result.tip.height,
        total_difficulty: result.tip.total_difficulty,
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
    return this._rpcCall(`${this.nodeUrl}/v2/owner`, method, params, true);
  }

  async _foreignRpcCall(method, params = []) {
    return this._rpcCall(`${this.nodeUrl}/v2/foreign`, method, params, false);
  }

  async _rpcCall(endpoint, method, params = [], isOwner = false) {
    const headers = {
      'Content-Type': 'application/json'
    };

    if (isOwner && this.secret) {
      const credentials = Buffer.from(`grin:${this.secret}`).toString('base64');
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
