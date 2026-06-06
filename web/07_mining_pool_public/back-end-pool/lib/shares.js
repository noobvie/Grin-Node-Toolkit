const crypto = require('crypto');
const { getDb } = require('./db');

class ShareValidator {
  constructor(config) {
    this.config = config;
    this.db = getDb();
  }

  async submitShare(grinAddress, workerName, difficulty, blockHeight, shareHash) {
    try {
      if (!grinAddress || !shareHash) {
        throw new Error('Missing required fields: grinAddress, shareHash');
      }

      if (difficulty <= 0) {
        throw new Error('Invalid difficulty');
      }

      // Staleness is enforced upstream in StratumServer.isValidJob() by job_id window.
      // shareHash is a SHA-256 hex string — Date.parse() on it always returns NaN,
      // so any timestamp-based check here would reject every share.

      const stmt = this.db.prepare(`
        INSERT INTO shares (grin_address, worker_name, difficulty, block_height, share_hash)
        VALUES (?, ?, ?, ?, ?)
      `);

      const result = stmt.run(grinAddress, workerName, difficulty, blockHeight, shareHash);

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

  generateShareHash(jobId, workerName, timestamp) {
    const input = `${jobId}-${workerName}-${timestamp}`;
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
