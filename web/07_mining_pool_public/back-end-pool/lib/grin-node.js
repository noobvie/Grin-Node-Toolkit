const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

// ─── RPC failure classification ───────────────────────────────────────────────
// A node call can fail two very different ways, and callers MUST be able to tell them
// apart: either the node answered and reported an error (a real statement about the
// chain — "no header at that height"), or we never got an answer at all (401 from a
// wrong/unreadable secret, ECONNREFUSED, timeout, an nginx error page). Only the first
// kind says anything about a block.
//
// Every error thrown from here therefore carries `nodeReplied`, and node-reported ones
// also carry `rpcErr` + `notFound`. NEVER re-derive this by string-matching .message:
// every message this module builds for getHeader() contains the word "height", and
// orphan-detector once matched on exactly that — so an unreachable node classified as
// "height_not_found" and orphaned live blocks, reversing miner payouts.

// We never reached a Grin JSON-RPC answer. Says NOTHING about the chain.
function transportFailure(message) {
  const err = new Error(message);
  err.nodeReplied = false;
  return err;
}

// The node answered and reported an error. `payload` is the node's own Err/error object.
//
// `chainStatement` says WHICH layer produced it, and it is the whole point of this function:
//   true  — `result.Err`, the Grin handler's own answer about the chain. Only this may set
//           notFound, because only this means "there is no header at that height".
//   false — a JSON-RPC ENVELOPE error (`data.error`): -32601 Method not found, -32602 Invalid
//           params, a parse error. These describe the CALL, not the chain, and their messages
//           routinely contain the words "not found" — a grin node answers exactly
//           `{"error":{"code":-32601,"message":"Method not found"}}` for a method the endpoint
//           does not carry (documented in CLAUDE.md for get_tip on the Owner API). Deriving
//           notFound from one made verifyBlockOnChain orphan a live block and reverse its
//           payouts on a pure misconfiguration. See audit §J5-2.
function nodeReplyFailure(message, payload, chainStatement = false) {
  const err = new Error(message);
  err.nodeReplied = true;
  err.rpcErr = payload;
  err.chainStatement = chainStatement === true;
  if (!err.chainStatement) {
    // Envelope error: the node replied, but said nothing about any block.
    err.notFound = false;
    return err;
  }
  // Safe to inspect the NODE'S OWN Err payload here (unlike our wrapper message, which always
  // contains "height"). grin reports a missing block/header as a NotFound variant.
  const s = (typeof payload === 'string' ? payload : JSON.stringify(payload === undefined ? '' : payload)).toLowerCase();
  err.notFound = s.includes('notfound') || s.includes('not found');
  return err;
}

class GrinNodeAPI {
  constructor(config) {
    this.nodeUrl = config.node_api_url || 'http://127.0.0.1:13413';
    this.network = config.network || 'testnet';

    // The Grin node secures BOTH its Owner (/v2/owner, .api_secret) and Foreign
    // (/v2/foreign, .foreign_api_secret) endpoints with HTTP Basic Auth (grin:<secret>).
    // They live in two separate files in the node directory. We resolve each from, in order:
    //   1. an explicit value in pool.json (node_api_secret / node_foreign_api_secret)
    //   2. an explicit path  (node_api_secret_path / node_foreign_api_secret_path)
    //   3. the live node dir under /opt/grin/node (see _detectNodeDir)
    // Reading by path means there are no copies to keep in sync when the node is rebuilt.
    // The backend is de-rooted (runs as `grinpool`), so it reads the grin-owned secret files
    // through the `grinsecret` group — 640 root:grinsecret, applied by pool_deroot() and
    // re-applied by grin_sync_pool_stratum() after a node rebuild.
    const nodeDir = config.node_dir || this._detectNodeDir();
    this.secret = this._resolveSecret(
      config.node_api_secret, config.node_api_secret_path,
      path.join(nodeDir, '.api_secret')
    );
    this.foreignSecret = this._resolveSecret(
      config.node_foreign_api_secret, config.node_foreign_api_secret_path,
      path.join(nodeDir, '.foreign_api_secret')
    );
  }

  // Which node dir actually serves this network. Mirrors the fallback branch of
  // grin_live_node_dir() in scripts/lib/grin_node_secrets.sh: mainnet prefers the FULL
  // archive when it is present, else the pruned node; testnet is always pruned.
  //
  // Hardcoding `<net>-prune` here was a live trap — a mainnet-full box has no
  // /opt/grin/node/mainnet-prune/.api_secret, so every call went out unauthenticated,
  // the node answered 401, and the pool reported a perfectly healthy node as offline.
  // Detecting at runtime also survives a prune↔full rebuild with no config edit; set
  // `node_dir` in pool.json only to override a non-standard layout.
  _detectNodeDir() {
    const base = '/opt/grin/node';
    const candidates = /^main/i.test(this.network)
      ? [`${base}/mainnet-full`, `${base}/mainnet-prune`]
      : [`${base}/testnet-prune`, `${base}/testnet-full`];
    for (const dir of candidates) {
      try {
        if (fs.existsSync(path.join(dir, '.api_secret'))) return dir;
      } catch (_) { /* unreadable → try the next candidate */ }
    }
    return candidates[0];
  }

  // Prefer an explicit value, then an explicit/default file path. Placeholder values
  // (CHANGE_ME…) and unreadable files resolve to '' so the call simply goes out unauthed
  // (matches a node that has auth disabled) rather than sending a bogus credential.
  //
  // A file that EXISTS but cannot be read is a different animal: it means the grinsecret
  // group grant is missing, and the resulting unauthenticated call gets a 401 that looks
  // exactly like a dead node. Never let that one pass silently — it is not diagnosable
  // from the symptom.
  _resolveSecret(value, explicitPath, defaultPath) {
    if (value && String(value).trim() && !/^CHANGE_ME/i.test(value)) {
      return String(value).trim();
    }
    const p = explicitPath || defaultPath;
    try {
      if (p && fs.existsSync(p)) return fs.readFileSync(p, 'utf-8').trim();
      this._warnNoSecret(p, `no such file (wrong node dir? this box may run a different ${this.network} layout)`);
    } catch (err) {
      const denied = err.code === 'EACCES' || err.code === 'EPERM';
      this._warnNoSecret(p, denied
        ? `permission denied — the grinsecret group grant is missing. Fix: chgrp grinsecret "${p}" && chmod 640 "${p}" (or run grin-secret-sync)`
        : (err.code || err.message));
    }
    return '';
  }

  // One line at startup, per missing secret. Without it an unresolved secret is completely
  // silent: the call goes out unauthenticated, the node answers 401, and every consumer
  // reports a healthy node as "offline" with nothing anywhere saying why.
  _warnNoSecret(p, why) {
    console.error(
      `[grin-node] no API secret from ${p}: ${why}. Calls to ${this.nodeUrl} will go out ` +
      `UNAUTHENTICATED and a node with auth enabled will answer 401 (which reads as "node down").`
    );
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

  // Re-wrap a failure with a friendlier message WITHOUT losing the classification set by
  // _rpcCall. A plain `new Error(...)` here silently drops nodeReplied/notFound, which is
  // what forced callers into string-matching in the first place.
  _rewrap(message, err) {
    const out = new Error(message);
    out.nodeReplied = err && err.nodeReplied === true;
    if (err && err.rpcErr !== undefined) out.rpcErr = err.rpcErr;
    if (err && err.notFound !== undefined) out.notFound = err.notFound;
    return out;
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
      throw this._rewrap(`Failed to get tip: ${err.message}`, err);
    }
  }

  async getHeader(height) {
    try {
      // Foreign API get_header(height, hash, commit) — all 3 params are required positionally
      // (the last two are Option, passed as null). Sending only [height] → node replies
      // "WrongNumberOfArgs. Expected 3. Actual 1".
      const result = await this._foreignRpcCall('get_header', [height, null, null]);
      return {
        height: result.height,
        hash: result.hash,
        nonce: result.nonce,
        timestamp: result.timestamp,
        difficulty: result.difficulty,
        total_difficulty: result.total_difficulty
      };
    } catch (err) {
      throw this._rewrap(`Failed to get header for height ${height}: ${err.message}`, err);
    }
  }

  async getBlock(height) {
    try {
      // get_block(height, hash, commit) — same 3-param Foreign API contract as get_header.
      const result = await this._foreignRpcCall('get_block', [height, null, null]);
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
      throw this._rewrap(`Failed to get block ${height}: ${err.message}`, err);
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
      throw this._rewrap(`Failed to get outputs: ${err.message}`, err);
    }
  }

  async validateChain() {
    try {
      const result = await this._ownerRpcCall('validate_chain', []);
      return result;
    } catch (err) {
      throw this._rewrap(`Chain validation failed: ${err.message}`, err);
    }
  }

  // Owner API get_connected_peers — the live inbound+outbound peer list. Each entry carries
  // { addr: "ip:port", direction, version, ... }. Used by the network-map peer-snapshot
  // collector, which geolocates each peer's IP to a COUNTRY ONLY (lib/geoip) and discards the
  // address. Returns [] on any error / unreachable node (caller treats empty as "skip").
  async getConnectedPeers() {
    try {
      const result = await this._ownerRpcCall('get_connected_peers', []);
      return Array.isArray(result) ? result : [];
    } catch (_) {
      return [];
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

    // Phase 1 — TRANSPORT. Anything that fails here means we never obtained a Grin
    // JSON-RPC answer: connection refused, timeout, a 401/403 from a wrong or unreadable
    // secret, a 5xx, or an nginx error page that isn't JSON. None of it says anything
    // about the chain, so it is tagged nodeReplied:false.
    let data;
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        timeout: 10000
      });

      if (!response.ok) {
        // 401/403 here is the classic wrong-secret signature, NOT a missing block.
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      data = await response.json();
    } catch (err) {
      throw transportFailure(`RPC call ${method} failed: ${err.message}`);
    }

    // Phase 2 — the node answered. Its Err payload IS a statement about the chain,
    // so these carry nodeReplied:true (+ notFound where the node says so).
    if (data && data.error) {
      // Envelope layer — NOT a statement about the chain (chainStatement stays false).
      throw nodeReplyFailure(`RPC call ${method} failed: RPC error: ${data.error.message}`, data.error);
    }

    // `'Ok' in result`, not truthiness: the node serialises Rust Result<T,E> as {"Ok":T}, and a
    // legitimate T can be falsy — validate_chain and push_transaction both answer {"Ok":null}.
    // A truthiness test fell through both branches and returned the WRAPPER object instead of
    // the unwrapped value, which reads to the caller as a success carrying garbage.
    const res = data ? data.result : undefined;
    if (res && typeof res === 'object') {
      if (Object.prototype.hasOwnProperty.call(res, 'Ok')) return res.Ok;
      if (Object.prototype.hasOwnProperty.call(res, 'Err')) {
        throw nodeReplyFailure(
          `RPC call ${method} failed: RPC error: ${JSON.stringify(res.Err)}`, res.Err, true
        );
      }
    }

    return res;
  }
}

module.exports = GrinNodeAPI;
