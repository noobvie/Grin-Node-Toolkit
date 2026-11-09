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

  // Synchronous on purpose (better-sqlite3 is). This was declared `async` with no caller
  // awaiting it, so GET /api/account/:addr/shares serialised the Promise and answered `{}`
  // for every address — a dead public endpoint nobody consumed.
  getSharesForMiner(grinAddress, limit = 100, offset = 0) {
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

  // Dedup key for a submitted share: the work, the nonce and the proof, and NOTHING the miner can
  // re-spell.
  //
  // `workId` = the job's pre_pow (the identity of the actual work), NOT the pool's incrementing
  // job_id: the node re-issues many job_ids for one identical pre_pow, and keying on job_id let
  // the same solved (nonce,pow) be credited once per wrapping job. pre_pow collapses every
  // re-version of a template to one dedup identity, so a resubmitted solution always hits the
  // share_hash UNIQUE constraint.
  //
  // ⚠ The worker name and the address must stay OUT of this key (audit §J6-1). Both are whatever
  // the miner typed at login, so with either in it, one solved (pre_pow, nonce, pow) inserts once
  // per label or once per address and multiplies PPLNS weight for one unit of real work, inside
  // the token bucket. The node keeps no record of shares, so this key is the only control.
  //
  // `pow` is in it because one graph can hold two 42-cycles, and each is a real solution. It cannot
  // be re-spelled: the node refuses a proof whose edges are not ascending. Nor can the nonce:
  // handleSubmit takes only the canonical form (isCanonicalU64).
  //
  // grin-miner draws each nonce from the OS RNG across the whole u64, so its rigs do not collide
  // here. A rig that reused a nonce sequence another rig also uses would lose those shares; no
  // other miner software has been checked.
  generateShareHash(workId, nonce, pow) {
    const input = `${workId}-${nonce}-${pow.join(',')}`;
    return crypto.createHash('sha256').update(input).digest('hex');
  }

  // UNUSED — there is no vardiff. Every share is recorded at the JOB's target × the C32 graph
  // weight (stratum-protocol shareCreditDifficulty), i.e. the node's minimum_share_difficulty
  // in chain units. Kept as the intended formula if vardiff is built; wiring it up also means
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
