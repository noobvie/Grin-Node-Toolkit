const { getDb } = require('./db');
const IncentivesManager = require('./incentives');

class RewardDistributor {
  constructor(config) {
    this.config = config;
    this.db = getDb();
    this.pplnsWindow = 60;
    // Incentive system (prize pool, donations, streak top-ups). No-op unless enabled in admin.
    this.incentives = new IncentivesManager(config);
  }

  async distributeRewards(blockId) {
    try {
      const block = this.db.prepare('SELECT * FROM blocks WHERE id = ?').get(blockId);

      if (!block) {
        throw new Error(`Block ${blockId} not found`);
      }

      if (block.status !== 'confirmed') {
        throw new Error(`Block ${blockId} is not confirmed (status: ${block.status})`);
      }

      // FIX #1, #5: CRITICAL - Verify block actually exists on blockchain
      // Prevents fake blocks from being credited if block_monitor is compromised
      if (this.grinNode) {
        try {
          const nodeBlock = await this.grinNode.getBlock(block.height);

          // Double-check: block must exist AND hash must match
          if (!nodeBlock) {
            throw new Error(`[SECURITY ALERT] Block ${block.height} marked confirmed in DB but NOT FOUND on blockchain!`);
          }

          if (nodeBlock.hash !== block.hash) {
            throw new Error(`[SECURITY ALERT] Block ${block.height} hash mismatch! DB: ${block.hash}, Node: ${nodeBlock.hash}`);
          }

          console.log(`[VERIFIED] Block ${block.height} confirmed on blockchain before distribution`);
        } catch (err) {
          console.error(`[CRITICAL] Blockchain verification failed: ${err.message}`);
          throw new Error(`Blockchain verification failed: ${err.message}`);
        }
      } else {
        console.warn(`[WARNING] Grin node not available - skipping blockchain verification`);
      }

      const shares = this.getSharesForDistribution(block.height);

      if (shares.length === 0) {
        console.warn(`No shares found for block ${block.height}`);
        return {
          block_id: blockId,
          success: false,
          reason: 'no_shares_found',
          shares_count: 0
        };
      }

      const totalDifficulty = shares.reduce((sum, s) => sum + s.difficulty, 0);
      const poolFee = block.reward * (this.config.pool_fee_percent / 100);
      const minerReward = block.reward - poolFee;

      const distribution = [];

      for (const share of shares) {
        const sharePercent = share.difficulty / totalDifficulty;
        const minerPayout = minerReward * sharePercent;

        distribution.push({
          grin_address: share.grin_address,
          amount: minerPayout,
          share_difficulty: share.difficulty
        });
      }

      const distributionResult = this.creditBalances(block.height, distribution, minerReward, poolFee);

      return {
        block_id: blockId,
        block_height: block.height,
        success: true,
        total_reward: block.reward,
        pool_fee: poolFee,
        miner_reward: minerReward,
        shares_distributed: shares.length,
        unique_miners: new Set(shares.map(s => s.grin_address)).size,
        distribution_count: distribution.length,
        details: distributionResult
      };
    } catch (err) {
      console.error(`Error distributing rewards for block ${blockId}: ${err.message}`);
      return {
        block_id: blockId,
        success: false,
        error: err.message
      };
    }
  }

  getSharesForDistribution(blockHeight) {
    try {
      const windowStart = Math.max(0, blockHeight - this.pplnsWindow);

      const stmt = this.db.prepare(`
        SELECT * FROM shares
        WHERE block_height >= ? AND block_height <= ?
        ORDER BY created_at ASC
      `);

      return stmt.all(windowStart, blockHeight);
    } catch (err) {
      console.error(`Error fetching shares for distribution: ${err.message}`);
      return [];
    }
  }

  creditBalances(blockHeight, distribution, minerReward, poolFee) {
    try {
      const minerMap = new Map();

      for (const entry of distribution) {
        if (!minerMap.has(entry.grin_address)) {
          minerMap.set(entry.grin_address, 0);
        }
        minerMap.set(entry.grin_address, minerMap.get(entry.grin_address) + entry.amount);
      }

      const results = [];

      const transaction = this.db.transaction(() => {
        for (const [grinAddress, amount] of minerMap) {
          const stmt = this.db.prepare(`
            UPDATE miner_accounts SET balance = balance + ? WHERE grin_address = ?
          `);
          stmt.run(amount, grinAddress);

          const logStmt = this.db.prepare(`
            INSERT INTO balance_log
            (grin_address, event_type, amount, balance_before, balance_after,
             locked_before, locked_after, reference_type, reference_id)
            VALUES (?, 'credit', ?, 0, 0, 0, 0, 'block', ?)
          `);
          logStmt.run(grinAddress, amount, blockHeight);

          results.push({
            grin_address: grinAddress,
            credited: amount
          });
        }
      });

      transaction();

      if (this.config.pool_fee_percent > 0) {
        const feeAddress = this.config.pool_fee_address || 'pool_fee';
        const stmt = this.db.prepare(`
          INSERT OR IGNORE INTO miner_accounts (grin_address, balance)
          VALUES (?, 0)
        `);
        stmt.run(feeAddress);

        const updateStmt = this.db.prepare(`
          UPDATE miner_accounts SET balance = balance + ? WHERE grin_address = ?
        `);
        updateStmt.run(poolFee, feeAddress);

        const logStmt = this.db.prepare(`
          INSERT INTO balance_log
          (grin_address, event_type, amount, balance_before, balance_after,
           locked_before, locked_after, reference_type, reference_id)
          VALUES (?, 'credit', ?, 0, 0, 0, 0, 'pool_fee', ?)
        `);
        logStmt.run(feeAddress, poolFee, blockHeight);
      }

      // Incentive rebalancing: divert fee-cut + donations into the prize pool and pay streak
      // top-ups, all atomically. minerMap is address → gross PPLNS payout for this block.
      if (this.incentives && this.incentives.enabled()) {
        const incentiveTx = this.db.transaction(() => {
          this.incentives.applyToDistribution(blockHeight, minerMap, poolFee);
        });
        incentiveTx();
      }

      return results;
    } catch (err) {
      console.error(`Error crediting balances: ${err.message}`);
      throw err;
    }
  }

  async rewardStats() {
    try {
      const totalPaid = this.db.prepare(
        "SELECT COALESCE(SUM(amount), 0) as total FROM balance_log WHERE event_type = 'credit'"
      ).get();

      // Exclude reserved pseudo-addresses (pool_fee, prize_pool) from miner-facing stats.
      const reserved = IncentivesManager.RESERVED_ADDRESSES;
      const ph = reserved.map(() => '?').join(',');

      const minerCount = this.db.prepare(
        `SELECT COUNT(*) as count FROM miner_accounts WHERE balance > 0 AND grin_address NOT IN (${ph})`
      ).get(...reserved);

      const topMiners = this.db.prepare(`
        SELECT grin_address, balance FROM miner_accounts
        WHERE balance > 0 AND grin_address NOT IN (${ph})
        ORDER BY balance DESC
        LIMIT 10
      `).all(...reserved);

      return {
        total_credited: totalPaid.total,
        miners_with_balance: minerCount.count,
        top_miners: topMiners
      };
    } catch (err) {
      console.error(`Error fetching reward stats: ${err.message}`);
      return {
        total_credited: 0,
        miners_with_balance: 0,
        top_miners: []
      };
    }
  }
}

module.exports = RewardDistributor;
