const { getDb } = require('./db');

class BlockManager {
  constructor(config) {
    this.config = config;
    this.db = getDb();
    this.lastBlockHeight = 0;
    this.nodeApi = null; // optional GrinNodeAPI for capturing per-block network difficulty
  }

  // Wire a GrinNodeAPI so creditBlock can record the block's network difficulty. Optional —
  // without it, network_difficulty is left NULL and that block is skipped by the luck calc.
  setNodeApi(nodeApi) {
    this.nodeApi = nodeApi;
  }

  // Per-block C32 network difficulty = total_difficulty[h] − total_difficulty[h-1]. Best-effort
  // (two foreign get_header calls); returns null if the node is unreachable or h-1 is unavailable.
  async _fetchNetworkDifficulty(height) {
    if (!this.nodeApi || !height) return null;
    try {
      const [h, hPrev] = await Promise.all([
        this.nodeApi.getHeader(height),
        this.nodeApi.getHeader(height - 1)
      ]);
      const d = Number(h.total_difficulty) - Number(hPrev.total_difficulty);
      return Number.isFinite(d) && d > 0 ? d : null;
    } catch (e) {
      console.warn(`[BlockManager] network difficulty fetch failed for ${height}: ${e.message}`);
      return null;
    }
  }

  // Transaction fees carried by this block, in GRIN. Grin pays the finder
  // REWARD + sum(kernel fees) — 60 is the EMISSION, not the payment — so crediting the flat
  // constant quietly kept every block's fees for the pool on top of pool_fee_percent, and
  // biased reconciliation's coverage gap positive (masking a real shortfall of the same
  // size). Audit §J5-10.
  //
  // Read at FOUND time on purpose: get_block returns the block BODY, which a pruned node
  // serves only inside its pruning horizon — at maturity (1440 blocks later) it may already
  // be gone, while a block we have just this second submitted is certainly there.
  //
  // Best-effort and hash-gated: a race at the tip can hand us a competitor's block at the
  // same height, so the fees are only trusted when the node's header hash is OUR hash.
  // Anything else returns null and the caller falls back to the flat reward.
  async _fetchBlockFees(height, hash) {
    if (!this.nodeApi || !height) return null;
    try {
      const blk = await this.nodeApi.getBlock(height);
      const gotHash = blk && blk.header && blk.header.hash;
      if (!gotHash || String(gotHash).toLowerCase() !== String(hash || '').toLowerCase()) {
        console.warn(
          `[BlockManager] fee capture skipped for ${height}: node has ${gotHash}, we found ${hash}`
        );
        return null;
      }
      const kernels = Array.isArray(blk.kernels) ? blk.kernels : [];
      // Coinbase kernels carry fee 0, so a bare sum is correct. Fees are nanogrin.
      let nano = 0;
      for (const k of kernels) {
        const f = Number(k && k.fee);
        if (Number.isFinite(f) && f > 0) nano += f;
      }
      const grin = nano / 1e9;
      return Number.isFinite(grin) && grin >= 0 ? grin : null;
    } catch (e) {
      console.warn(`[BlockManager] block fee fetch failed for ${height}: ${e.message}`);
      return null;
    }
  }

  // Accumulated pool share-difficulty for the round that found this block — shares since the
  // previous block's found_at. Captured now so luck stays exact after raw shares are pruned.
  _roundShareDiff(prevFoundAt) {
    try {
      const row = this.db.prepare(
        'SELECT COALESCE(SUM(difficulty), 0) AS d FROM shares WHERE created_at > ?'
      ).get(prevFoundAt || 0);
      return row && Number.isFinite(row.d) ? row.d : null;
    } catch (e) {
      return null;
    }
  }

  // `reward` is the flat emission (60). The value actually stored is that plus the block's
  // transaction fees when they can be read from the chain — see _fetchBlockFees.
  async creditBlock(height, hash, nonce, reward, minerAddress) {
    try {
      // Capture round/network stats BEFORE inserting (round = shares since the previous block).
      const prev = this.getLastBlock();
      const roundShares = this._roundShareDiff(prev ? prev.found_at : 0);
      // In PARALLEL, not in sequence: creditBlock is awaited before the miner's submit ack is
      // written, and each of these carries the node client's 10s timeout. Serially that is up
      // to 20s of dead air on an unreachable node; concurrently it is 10s, which is also
      // better than the pre-§J5-10 code managed with the difficulty fetch alone.
      const [networkDiff, fees] = await Promise.all([
        this._fetchNetworkDifficulty(height),
        this._fetchBlockFees(height, hash),
      ]);
      const total = fees === null ? reward : reward + fees;

      const stmt = this.db.prepare(`
        INSERT INTO blocks (height, hash, nonce, reward, fees, status, found_by, found_at, network_difficulty, round_shares)
        VALUES (?, ?, ?, ?, ?, 'immature', ?, unixepoch(), ?, ?)
      `);

      // String(nonce): the column is TEXT and a Grin nonce is a u64 that must never be
      // rounded through a JS number. See db.js's blocks DDL and audit §J5-1.
      const result = stmt.run(height, hash, String(nonce), total, fees, minerAddress, networkDiff, roundShares);

      console.log(
        `[${new Date().toISOString()}] Block credited: height=${height}, hash=${hash.substring(0, 16)}..., ` +
        `reward=${total} GRIN (${reward} emission${fees === null ? ', fees unread' : ` + ${fees} fees`}), miner=${minerAddress}`
      );

      return {
        success: true,
        block_id: result.lastInsertRowid,
        height,
        hash,
        reward: total,
        fees
      };
    } catch (err) {
      console.error(`Error crediting block: ${err.message}`);
      return {
        success: false,
        error: err.message
      };
    }
  }

  async getBlock(blockId) {
    try {
      const stmt = this.db.prepare('SELECT * FROM blocks WHERE id = ?');
      return stmt.get(blockId);
    } catch (err) {
      console.error(`Error fetching block: ${err.message}`);
      return null;
    }
  }

  async getBlockByHeight(height) {
    try {
      const stmt = this.db.prepare('SELECT * FROM blocks WHERE height = ?');
      return stmt.get(height);
    } catch (err) {
      console.error(`Error fetching block by height: ${err.message}`);
      return null;
    }
  }

  async getRecentBlocks(limit = 50) {
    try {
      const stmt = this.db.prepare(`
        SELECT * FROM blocks ORDER BY height DESC LIMIT ?
      `);
      return stmt.all(limit);
    } catch (err) {
      console.error(`Error fetching recent blocks: ${err.message}`);
      return [];
    }
  }

  async updateBlockStatus(blockId, status) {
    try {
      const stmt = this.db.prepare(`
        UPDATE blocks SET status = ? WHERE id = ?
      `);
      stmt.run(status, blockId);
      return true;
    } catch (err) {
      console.error(`Error updating block status: ${err.message}`);
      return false;
    }
  }

  async confirmBlock(blockId) {
    try {
      const stmt = this.db.prepare(`
        UPDATE blocks SET status = 'confirmed', confirmed_at = unixepoch() WHERE id = ?
      `);
      stmt.run(blockId);
      return true;
    } catch (err) {
      console.error(`Error confirming block: ${err.message}`);
      return false;
    }
  }

  async getImmatureBlocks() {
    try {
      const stmt = this.db.prepare(`
        SELECT * FROM blocks WHERE status = 'immature' ORDER BY height ASC
      `);
      return stmt.all();
    } catch (err) {
      console.error(`Error fetching immature blocks: ${err.message}`);
      return [];
    }
  }

  async getBlocksByStatus(status, limit = 100) {
    try {
      const stmt = this.db.prepare(`
        SELECT * FROM blocks WHERE status = ? ORDER BY height DESC LIMIT ?
      `);
      return stmt.all(status, limit);
    } catch (err) {
      console.error(`Error fetching blocks by status: ${err.message}`);
      return [];
    }
  }

  async getBlocksMintedByMiner(minerAddress, limit = 50) {
    try {
      const stmt = this.db.prepare(`
        SELECT * FROM blocks WHERE found_by = ? ORDER BY height DESC LIMIT ?
      `);
      return stmt.all(minerAddress, limit);
    } catch (err) {
      console.error(`Error fetching blocks minted by miner: ${err.message}`);
      return [];
    }
  }

  // Synchronous: all queries are synchronous sqlite .get() (no awaits). It must NOT be async —
  // every caller uses it without await, so an async version returned a Promise they spread
  // into {} (empty stats on /api/pool/stats, /api/admin/metrics, dashboard, poolstats).
  getPoolStats() {
    try {
      const totalBlocks = this.db.prepare(
        'SELECT COUNT(*) as count FROM blocks'
      ).get();

      const totalReward = this.db.prepare(
        'SELECT COALESCE(SUM(reward), 0) as total FROM blocks'
      ).get();

      // 'paid' is the TERMINAL success state — rewards.js flips confirmed→paid the moment it
      // distributes, ~30s after maturity. Counting only 'confirmed' therefore reported a pool
      // that has confirmed 0 blocks and earned 0 confirmed reward in steady state, and rolled
      // every paid block into `immature_blocks` below. This feeds /api/pool/stats and the
      // external poolstats reporter, so it was wrong in public. See audit §J5-4.
      const confirmedBlocks = this.db.prepare(
        "SELECT COUNT(*) as count FROM blocks WHERE status IN ('confirmed', 'paid')"
      ).get();

      const confirmedReward = this.db.prepare(
        "SELECT COALESCE(SUM(reward), 0) as total FROM blocks WHERE status IN ('confirmed', 'paid')"
      ).get();

      // Counted directly, not as (total − confirmed): that subtraction also folded every
      // ORPHANED block into the maturing count.
      const immatureCount = this.db.prepare(
        "SELECT COUNT(*) as count FROM blocks WHERE status = 'immature'"
      ).get();

      // "Found" = any non-orphaned block. created_at is INTEGER unixepoch.
      const blocks24h = this.db.prepare(
        "SELECT COUNT(*) as count FROM blocks WHERE status != 'orphaned' AND created_at > unixepoch() - 86400"
      ).get();
      const blocks7d = this.db.prepare(
        "SELECT COUNT(*) as count FROM blocks WHERE status != 'orphaned' AND created_at > unixepoch() - 7 * 86400"
      ).get();

      return {
        total_blocks_found: totalBlocks.count,
        total_reward: totalReward.total,
        confirmed_blocks: confirmedBlocks.count,
        confirmed_reward: confirmedReward.total,
        immature_blocks: immatureCount.count,
        blocks_24h: blocks24h.count,
        blocks_7d: blocks7d.count
      };
    } catch (err) {
      console.error(`Error fetching pool stats: ${err.message}`);
      return {
        total_blocks_found: 0,
        total_reward: 0,
        confirmed_blocks: 0,
        confirmed_reward: 0,
        immature_blocks: 0,
        blocks_24h: 0,
        blocks_7d: 0
      };
    }
  }

  // Durable block-history series for the public blocks.html deck. Blocks are never pruned, so we
  // bucket straight from the blocks table (found_at) and stay accurate at every range. One call
  // feeds all four charts: time-bucketed counts/reward (bar + cumulative area), a per-block luck
  // trend, and window status totals (doughnut). Returns { range, bucket_seconds, points, luck,
  // status }. Synchronous (all sqlite .all/.get). UTC-aligned buckets, mirroring getMetricsHistory.
  getBlocksHistory(range = 'month') {
    const DAY = 86400;
    const empty = { range, bucket_seconds: null, points: [], luck: [], status: { confirmed: 0, immature: 0, orphaned: 0 } };
    try {
      const now = Math.floor(Date.now() / 1000);
      let bucket, cutoff;

      if (range === 'all') {
        const first = this.db.prepare('SELECT MIN(found_at) AS b FROM blocks').get();
        const earliest = (first && first.b != null) ? first.b : now - 30 * DAY;
        const totalSpan = Math.max(now - earliest, DAY);
        bucket = totalSpan <= 90 * DAY ? DAY : (totalSpan <= 730 * DAY ? 7 * DAY : 30 * DAY);
        cutoff = earliest;
      } else {
        let span;
        switch (range) {
          case 'week':  span = 7 * DAY;   bucket = DAY;     break;
          case 'year':  span = 365 * DAY; bucket = 7 * DAY; break;
          case 'month':
          default:      span = 30 * DAY;  bucket = DAY;     break;
        }
        cutoff = now - span;
      }

      // Time-bucketed counts + reward (drives the blocks-per-period columns and cumulative area).
      const points = this.db.prepare(`
        SELECT CAST(found_at / ? AS INTEGER) * ?              AS t,
               COUNT(*)                                       AS blocks,
               COALESCE(SUM(reward), 0)                       AS reward,
               COALESCE(SUM(CASE WHEN status = 'confirmed' THEN 1 ELSE 0 END), 0) AS confirmed,
               COALESCE(SUM(CASE WHEN status = 'orphaned'  THEN 1 ELSE 0 END), 0) AS orphaned
        FROM blocks
        WHERE found_at >= ?
        GROUP BY t
        ORDER BY t ASC
      `).all(bucket, bucket, cutoff).map(r => ({
        t: r.t,
        blocks: r.blocks || 0,
        reward: parseFloat((r.reward || 0).toFixed(9)),
        confirmed: r.confirmed || 0,
        orphaned: r.orphaned || 0
      }));

      // Per-block luck % over the window (round shares ÷ network difficulty × 100), oldest→newest,
      // capped for a readable line. Only blocks with both captured stats contribute.
      const luck = this.db.prepare(`
        SELECT height, round_shares, network_difficulty, found_at
        FROM blocks
        WHERE found_at >= ? AND network_difficulty > 0 AND round_shares > 0
        ORDER BY height DESC
        LIMIT 120
      `).all(cutoff)
        .map(r => ({ height: r.height, t: r.found_at, luck: parseFloat(((r.round_shares / r.network_difficulty) * 100).toFixed(1)) }))
        .reverse();

      // Window status totals (drives the doughnut — a true orphaned count, unlike /api/pool/stats
      // which folds orphaned into "immature").
      const status = { confirmed: 0, immature: 0, orphaned: 0 };
      this.db.prepare(`
        SELECT status, COUNT(*) AS n FROM blocks WHERE found_at >= ? GROUP BY status
      `).all(cutoff).forEach(r => {
        // 'paid' is confirmed-and-distributed, not maturing — see getPoolStats above.
        if (r.status === 'confirmed' || r.status === 'paid') status.confirmed += r.n;
        else if (r.status === 'orphaned') status.orphaned = r.n;
        else status.immature += r.n; // 'immature' (and any legacy/unknown) count as maturing
      });

      return { range, bucket_seconds: bucket, points, luck, status };
    } catch (err) {
      console.error(`Error fetching blocks history: ${err.message}`);
      return empty;
    }
  }

  // Most recently found block (by height), or null. Synchronous.
  getLastBlock() {
    try {
      return this.db.prepare('SELECT * FROM blocks ORDER BY height DESC LIMIT 1').get() || null;
    } catch (err) {
      console.error(`Error fetching last block: ${err.message}`);
      return null;
    }
  }
}

module.exports = BlockManager;
