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

  // Dedup key for a submitted share: address + work + nonce, and NOTHING the miner can re-spell.
  //
  // `workId` = the job's pre_pow (the identity of the actual work), NOT the pool's incrementing
  // job_id: the node re-issues many job_ids for one identical pre_pow, and keying on job_id let
  // the same solved (nonce,pow) be credited once per wrapping job. pre_pow collapses every
  // re-version of a template to one dedup identity, so a resubmitted solution always hits the
  // share_hash UNIQUE constraint. `grinAddress` gives total cross-miner isolation: two miners
  // are two different addresses, so one's valid share can never be rejected as the other's
  // duplicate even when both use the default worker name.
  //
  // ⚠ `workerName` is accepted but DELIBERATELY NOT HASHED (audit §J6-1). It used to be in the
  // key, justified as the cross-miner-collision guard — but grinAddress already was that guard,
  // and the worker label is whatever the miner types after the dot. Including it meant one
  // solved (pre_pow, nonce, pow) re-submitted under N rig labels inserted N times and multiplied
  // that address's PPLNS weight N-fold for one unit of real work, from one socket, inside the
  // token bucket. That is the SAME defect the 2026-07-17 pre_pow fix closed, re-entered through
  // a second miner-chosen field. The parameter stays so call sites and tests keep their shape,
  // and shares.worker_name is still written — as attribution, never as part of the uniqueness
  // decision. Do not put it back.
  generateShareHash(grinAddress, workId, workerName, nonce) {
    const input = `${grinAddress}-${workId}-${nonce}`;
    return crypto.createHash('sha256').update(input).digest('hex');
  }

  // UNUSED — there is no vardiff. Every session is created with difficulty 1.0 (miners.js
  // createSession) and nothing ever calls setSessionDifficulty, so every share is recorded at
  // difficulty 1. Kept as the intended formula if vardiff is built; wiring it up also means
  // telling the miner the new difficulty, which this stratum server does not yet do.
  calculateDifficulty(networkDifficulty, poolTargetHashrate) {
    const minDiff = 0.001;
    const maxDiff = networkDifficulty / 4;

    if (networkDifficulty <= 0) return minDiff;

    const diff = Math.max(minDiff, Math.min(maxDiff, networkDifficulty / poolTargetHashrate));
    return parseFloat(diff.toFixed(6));
  }
}

module.exports = ShareValidator;
