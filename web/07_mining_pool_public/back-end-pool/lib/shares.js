const crypto = require('crypto');
const { getDb } = require('./db');

class ShareValidator {
  constructor(config) {
    this.config = config;
    this.db = getDb();
  }

  // `region` tags which region a share came from (Model C multi-region). The central
  // stratum-server stamps it from the listener the share arrived on: the public port →
  // config.region; a per-region internal port → that region (the gateway tunnelled it in).
  // Omitted → default to this box's config.region. It is purely an aggregation dimension
  // (see GET /api/pool/stats/regions); no bearing on PPLNS weighting, which is region-agnostic.
  async submitShare(grinAddress, workerName, difficulty, blockHeight, shareHash, region) {
    try {
      if (!grinAddress || !shareHash) {
        throw new Error('Missing required fields: grinAddress, shareHash');
      }

      if (difficulty <= 0) {
        throw new Error('Invalid difficulty');
      }

      const reg = region || this.config.region || 'default';

      // Staleness is enforced upstream in StratumServer.isValidJob() by job_id window.
      // shareHash is a SHA-256 hex string — Date.parse() on it always returns NaN,
      // so any timestamp-based check here would reject every share.

      const stmt = this.db.prepare(`
        INSERT INTO shares (grin_address, worker_name, difficulty, block_height, share_hash, region)
        VALUES (?, ?, ?, ?, ?, ?)
      `);

      const result = stmt.run(grinAddress, workerName, difficulty, blockHeight, shareHash, reg);

      return {
        success: true,
        share_id: result.lastInsertRowid,
        difficulty,
        timestamp: new Date().toISOString()
      };
    } catch (err) {
      return {
        success: false,
        error: err.message
      };
    }
  }

  async getSharesForBlock(blockHeight) {
    try {
      const stmt = this.db.prepare(`
        SELECT * FROM shares WHERE block_height = ? ORDER BY created_at ASC
      `);
      return stmt.all(blockHeight);
    } catch (err) {
      console.error(`Error fetching shares for block ${blockHeight}: ${err.message}`);
      return [];
    }
  }

  async getSharesForMiner(grinAddress, limit = 100, offset = 0) {
    try {
      const stmt = this.db.prepare(`
        SELECT * FROM shares WHERE grin_address = ? ORDER BY created_at DESC LIMIT ? OFFSET ?
      `);
      return stmt.all(grinAddress, limit, offset);
    } catch (err) {
      console.error(`Error fetching shares for miner ${grinAddress}: ${err.message}`);
      return [];
    }
  }

  // Dedup key for a submitted share. Includes grin_address so two different miners that share
  // a worker name (e.g. the default) can never collide on (job, worker, nonce) and have one's
  // valid share rejected as the other's duplicate.
  generateShareHash(grinAddress, jobId, workerName, nonce) {
    const input = `${grinAddress}-${jobId}-${workerName}-${nonce}`;
    return crypto.createHash('sha256').update(input).digest('hex');
  }

  calculateDifficulty(networkDifficulty, poolTargetHashrate) {
    const minDiff = 0.001;
    const maxDiff = networkDifficulty / 4;

    if (networkDifficulty <= 0) return minDiff;

    const diff = Math.max(minDiff, Math.min(maxDiff, networkDifficulty / poolTargetHashrate));
    return parseFloat(diff.toFixed(6));
  }
}

module.exports = ShareValidator;
