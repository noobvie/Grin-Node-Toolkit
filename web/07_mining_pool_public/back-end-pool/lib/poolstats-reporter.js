/**
 * Poolstats Reporter — optional PUSH of pool stats to an external monitor.
 *
 * NOT the live miningpoolstats.stream integration: that one is a PULL feed they poll,
 * GET /api/pool/poolstats in index.js. This pusher is OFF unless pool.json sets
 * poolstats_enabled: true (the Script 07 installer never writes that key), and its
 * endpoint default is a guess at an MPS submit API.
 *
 * Uses HTTPS only, keeps the API key in the Authorization header, never logs it.
 */

const https = require('https');
const fs = require('fs');
const { URL } = require('url');

class PoolstatsReporter {
  constructor(config, modules) {
    this.config = config;
    this.blockManager = modules.blockManager;
    this.minerManager = modules.minerManager;
    this.stratumServer = modules.stratumServer;
    this.hashrateTracker = modules.hashrateTracker;

    this.enabled = config.poolstats_enabled === true;
    this.apiKey = config.poolstats_api_key || '';
    this.endpoint = config.poolstats_endpoint || 'https://api.miningpoolstats.stream/submit';
    this.intervalMins = config.poolstats_interval_mins || 10;
    this.intervalMs = this.intervalMins * 60 * 1000;

    this.lastSubmitTime = 0;
    this.failureCount = 0;
    this.lastError = null;
    this.timerId = null;

    this.log(`Initialized (enabled: ${this.enabled}, interval: ${this.intervalMins} min)`);
  }

  start() {
    if (!this.enabled) {
      this.log('Poolstats reporting is disabled');
      return;
    }

    if (!this.apiKey || this.apiKey.trim().length === 0) {
      this.error('Cannot start: poolstats_api_key not configured');
      return;
    }

    // Validate endpoint is HTTPS
    try {
      const url = new URL(this.endpoint);
      if (url.protocol !== 'https:') {
        throw new Error('Poolstats endpoint must use HTTPS');
      }
    } catch (err) {
      this.error(`Invalid poolstats endpoint: ${err.message}`);
      return;
    }

    this.log('Starting poolstats reporter');

    // First submission after short delay, then periodic
    setTimeout(() => this.submit(), 5000);
    this.timerId = setInterval(() => this.submit(), this.intervalMs);
  }

  stop() {
    if (this.timerId) {
      clearInterval(this.timerId);
      this.timerId = null;
      this.log('Poolstats reporter stopped');
    }
  }

  // Every gate that guards the periodic submission lives in start(), which the admin
  // "test" route (POST /api/admin/poolstats/test) does not go through — it calls submit()
  // directly. So a pool with the pusher switched OFF and no API key configured still
  // POSTed its live stats to a third party on demand, with an empty `Bearer ` header,
  // and an unvalidated (possibly non-HTTPS) endpoint. Re-assert the gates here so the
  // preconditions belong to the ACTION, not to one of its two callers. Audit §J13-1.
  _assertSubmittable() {
    if (!this.enabled) {
      throw new Error('poolstats reporting is disabled (set poolstats_enabled in pool.json)');
    }
    if (!this.apiKey || this.apiKey.trim().length === 0) {
      throw new Error('poolstats_api_key is not configured');
    }
    let url;
    try {
      url = new URL(this.endpoint);
    } catch (err) {
      throw new Error(`invalid poolstats endpoint: ${err.message}`);
    }
    if (url.protocol !== 'https:') throw new Error('poolstats endpoint must use HTTPS');
  }

  async submit() {
    try {
      this._assertSubmittable();
      const stats = this.collectStats();
      await this.httpPost(stats);
      this.lastSubmitTime = Date.now();
      this.failureCount = 0;
      this.lastError = null;
      this.log(`Submitted (${stats.miners} miners, ${stats.blocks_24h} blocks/24h)`);
    } catch (err) {
      this.failureCount++;
      this.lastError = err.message;
      // Log error but NOT the API key
      this.error(`Submission failed (attempt ${this.failureCount}): ${err.message}`);
    }
  }

  /**
   * Collect current pool statistics
   */
  collectStats() {
    const blockStats = this.blockManager.getPoolStats();
    const hashrateStats = this.hashrateTracker.getHashrateStats();
    const minerCount = this.minerManager.getActiveMinersCount();
    const stratumStats = this.stratumServer.getStats();

    // Get last block info (found_at is INTEGER unixepoch seconds → ms for Date)
    const lastBlock = this.blockManager.getLastBlock();
    const lastBlockTime = lastBlock ? new Date(lastBlock.found_at * 1000).toISOString() : null;
    const lastBlockReward = lastBlock ? lastBlock.reward : 0;

    return {
      pool_name: this.config.pool_name || 'Grin Pool',
      url: this.config.subdomain ? `https://${this.config.subdomain}` : '',
      // Same derivation as the pull feed in index.js. This was hardcoded to 'mainnet' until
      // 2026-08-22, so a testnet pool would have listed itself as a mainnet pool the moment
      // the pusher was enabled.
      network: this.config.network === 'testnet' ? 'testnet' : 'mainnet',
      pool_fee: this.config.pool_fee_percent || 0,
      miners: minerCount,
      hashrate_gps: hashrateStats.pool_hashrate_1h_gps || 0,
      blocks_24h: blockStats.blocks_24h || 0,
      blocks_7d: blockStats.blocks_7d || 0,
      blocks_total: blockStats.total_blocks_found || 0,
      last_block: lastBlockTime,
      last_block_height: lastBlock ? lastBlock.height : 0,
      last_block_reward: lastBlockReward,
      reward_model: this.config.reward_model || 'pplns',
      active_connections: stratumStats.active_connections || 0,
      version: '1.0'
    };
  }

  /**
   * POST stats to poolstats.stream API over HTTPS
   * API key passed in Authorization header (never in body or URL)
   */
  httpPost(data) {
    return new Promise((resolve, reject) => {
      try {
        const url = new URL(this.endpoint);

        // Prepare JSON body
        const jsonBody = JSON.stringify(data);

        // HTTPS options with secure defaults
        const options = {
          hostname: url.hostname,
          port: url.port || 443,
          path: url.pathname + url.search,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(jsonBody),
            'Authorization': `Bearer ${this.apiKey}`,  // ← Secure header
            'User-Agent': 'GrinPoolToolkit/1.0'
          },
          timeout: 10000  // 10 second timeout
        };

        // Response cap. `timeout` on an https.request is a socket INACTIVITY timer — a
        // server that drips one byte every 9s never trips it, while responseBody grows
        // without bound. Cap the body and destroy the request past it. Audit §J13-3.
        const MAX_RESPONSE_BYTES = 65536;
        const req = https.request(options, (res) => {
          let responseBody = '';
          let responseBytes = 0;
          let overflowed = false;

          res.on('data', chunk => {
            responseBytes += chunk.length;
            if (responseBytes > MAX_RESPONSE_BYTES) {
              if (!overflowed) {
                overflowed = true;
                req.destroy();
                reject(new Error(`Response exceeded ${MAX_RESPONSE_BYTES} bytes`));
              }
              return;
            }
            responseBody += chunk.toString('utf8');
          });

          res.on('end', () => {
            if (overflowed) return;
            if (res.statusCode >= 200 && res.statusCode < 300) {
              resolve({
                status: res.statusCode,
                body: responseBody
              });
            } else {
              reject(new Error(`HTTP ${res.statusCode}: ${responseBody.slice(0, 200)}`));
            }
          });
        });

        req.on('timeout', () => {
          req.destroy();
          reject(new Error('Request timeout'));
        });

        req.on('error', (err) => {
          reject(new Error(`Connection error: ${err.message}`));
        });

        // Send JSON body (contains stats, not API key)
        req.write(jsonBody);
        req.end();

      } catch (err) {
        reject(err);
      }
    });
  }

  /**
   * Get reporter status (for admin panel / metrics endpoint)
   * Returns status WITHOUT exposing API key
   */
  getStatus() {
    return {
      enabled: this.enabled,
      endpoint: this.endpoint,
      interval_mins: this.intervalMins,
      api_key_configured: this.apiKey && this.apiKey.length > 0,
      api_key_preview: this.apiKey ? `${this.apiKey.slice(0, 7)}...${this.apiKey.slice(-4)}` : null,
      last_submit: this.lastSubmitTime ? new Date(this.lastSubmitTime).toISOString() : null,
      failure_count: this.failureCount,
      last_error: this.lastError,
      status: this.enabled ? 'active' : 'disabled'
    };
  }

  /**
   * Rotate API key (for admin panel security). Called by POST /api/admin/poolstats/update-key.
   *
   * Writes through to pool.json as well as memory. It was in-memory only until 2026-08-22,
   * which meant a rotation silently reverted to the old key on the next service restart —
   * the worst shape for a credential rotation, because the panel reported success.
   *
   * The file write is best-effort and deliberately does NOT throw: the in-memory key is
   * already live and rejecting the rotation would leave the operator with the old key
   * everywhere. A failure is logged loudly instead, so it can be persisted by hand.
   */
  updateApiKey(newKey) {
    if (!newKey || newKey.trim().length === 0) {
      throw new Error('API key cannot be empty');
    }
    this.apiKey = newKey.trim();
    this.failureCount = 0;
    this.lastError = null;
    this.config.poolstats_api_key = this.apiKey;
    this._persistApiKey();
    this.log('API key updated (never logged)');
  }

  /**
   * Re-read pool.json, replace only poolstats_api_key, write it back atomically.
   *
   * Re-read rather than serialising `this.config`: config carries values merged in at
   * runtime by PoolSettings.applyToConfig() that belong in the settings DB, not the file.
   * Dumping the in-memory object would bake all of them into pool.json as if the operator
   * had set them there. Mode 600 is re-asserted on the temp file — pool.json holds
   * credentials and a default-umask temp file would widen them for the rename's duration.
   */
  _persistApiKey() {
    const confPath = this.config.__config_path || process.env.GRIN_POOL_CONF;
    if (!confPath) {
      this.error('API key rotated in memory only — no pool.json path known, it will revert on restart');
      return;
    }
    try {
      const raw = fs.readFileSync(confPath, 'utf8');
      const obj = JSON.parse(raw);
      obj.poolstats_api_key = this.apiKey;
      const tmp = `${confPath}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, confPath);
      this.log('API key persisted to pool.json');
    } catch (err) {
      this.error(`API key rotated in memory but NOT persisted (${err.message}) — it will revert on restart`);
    }
  }

  /**
   * Logging (never logs API key)
   */
  log(msg) {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] [PoolstatsReporter] ${msg}`);
  }

  error(msg) {
    const timestamp = new Date().toISOString();
    console.error(`[${timestamp}] [PoolstatsReporter] ERROR: ${msg}`);
  }
}

module.exports = PoolstatsReporter;
