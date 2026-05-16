/**
 * Poolstats Reporter — Push pool stats to miningpoolstats.stream
 *
 * Periodically collects pool metrics and submits them to external monitoring.
 * Uses HTTPS only, secure API key storage, and never logs sensitive data.
 */

const https = require('https');
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

  async submit() {
    try {
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

    // Get last block info
    const lastBlock = this.blockManager.getLastBlock();
    const lastBlockTime = lastBlock ? new Date(lastBlock.found_at).toISOString() : null;
    const lastBlockReward = lastBlock ? lastBlock.reward : 0;

    return {
      pool_name: this.config.pool_name || 'Grin Pool',
      url: this.config.subdomain ? `https://${this.config.subdomain}` : '',
      network: 'mainnet',
      pool_fee: this.config.pool_fee_percent || 0,
      miners: minerCount,
      hashrate_gps: hashrateStats.current_gps || 0,
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

        const req = https.request(options, (res) => {
          let responseBody = '';

          res.on('data', chunk => {
            responseBody += chunk.toString('utf8');
          });

          res.on('end', () => {
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
   * Rotate API key (for admin panel security)
   * Called when user changes key via settings
   */
  updateApiKey(newKey) {
    if (!newKey || newKey.trim().length === 0) {
      throw new Error('API key cannot be empty');
    }
    this.apiKey = newKey;
    this.failureCount = 0;
    this.lastError = null;
    this.log('API key updated (never logged)');
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
