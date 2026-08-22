const { getDb } = require('./db');
const IncentivesManager = require('./incentives');

class RewardDistributor {
  // grinNode: a GrinNodeAPI. REQUIRED for the pre-credit chain re-verification below — it was
  // omitted at the only construction site for a long time, which silently turned that check
  // into dead code (audit §I3). Left optional so a unit test can construct without a node,
  // but index.js must pass BlockMonitor's instance.
  constructor(config, grinNode = null) {
    this.config = config;
    this.db = getDb();
    this.grinNode = grinNode;
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

      // CRITICAL — re-verify against the chain immediately before crediting. This is the
      // second, independent check: OrphanDetector already verified by NONCE when it moved the
      // block to 'confirmed', but that ran up to hours earlier, so a reorg (or a compromised
      // block_monitor) in between must not turn into credited balances.
      //
      // get_HEADER, not get_block: a pruned node keeps the full header chain at every height
      // but serves block BODIES only inside the pruning horizon, so get_block is the call that
      // breaks on the standard mainnet-prune deployment. get_header also returns `hash` at the
      // top level — get_block nests it under `.header`, which is why the previous (unreachable)
      // version of this check would have thrown a false "hash mismatch" on every block had it
      // ever run. See audit §I3.
      if (this.grinNode) {
        try {
          const nodeHeader = await this.grinNode.getHeader(block.height);

          if (!nodeHeader) {
            throw new Error(`[SECURITY ALERT] Block ${block.height} marked confirmed in DB but NOT FOUND on blockchain!`);
          }

          // NONCE is the authoritative comparison — it is exactly what OrphanDetector
          // .verifyBlockOnChain() uses to promote a block to 'confirmed', so it is known to
          // line up with what we store. Both sides are coerced to String: the node returns a
          // u64 that may arrive as a number or a string depending on magnitude.
          if (String(nodeHeader.nonce) !== String(block.nonce)) {
            throw new Error(
              `[SECURITY ALERT] Block ${block.height} nonce mismatch! DB: ${block.nonce}, Node: ${nodeHeader.nonce}`
            );
          }

          // HASH is the stronger check, but blocks.hash is parsed out of the node stratum's
          // "blockfound - <hash>" reply rather than read from the Foreign API, so its exact
          // formatting is not verified against a live node here. Compare it only when it has
          // the shape of a real block hash; anything else means the stored value is not a hash
          // and must be reported loudly, NOT silently treated as a mismatch that freezes every
          // payout. The nonce check above already carries the security property meanwhile.
          const HASH_RE = /^[0-9a-f]{64}$/i;
          if (HASH_RE.test(String(block.hash || '')) && HASH_RE.test(String(nodeHeader.hash || ''))) {
            if (String(nodeHeader.hash).toLowerCase() !== String(block.hash).toLowerCase()) {
              throw new Error(
                `[SECURITY ALERT] Block ${block.height} hash mismatch! DB: ${block.hash}, Node: ${nodeHeader.hash}`
              );
            }
          } else {
            console.warn(
              `[WARNING] Block ${block.height}: stored hash ${JSON.stringify(block.hash)} or node hash ` +
              `${JSON.stringify(nodeHeader.hash)} is not a 64-hex block hash — verified by nonce only. ` +
              `Report this: the hash comparison is meant to be the primary check (audit §I3).`
            );
          }

          console.log(`[VERIFIED] Block ${block.height} confirmed on blockchain before distribution`);
        } catch (err) {
          console.error(`[CRITICAL] Blockchain verification failed: ${err.message}`);
          throw new Error(`Blockchain verification failed: ${err.message}`);
        }
      } else {
        // No node = we cannot prove the block we are about to pay for is on-chain. Refuse
        // rather than credit: the block stays 'confirmed' and the next tick retries, which is
        // the safe direction (a delayed payout, never an unverified one).
        throw new Error('Grin node unavailable — refusing to distribute without chain verification');
      }

      const shares = this.getSharesForDistribution(block.height);

      if (shares.length === 0) {
        console.warn(`No shares found for block ${block.height}`);
        // Mark terminal so the monitor doesn't reprocess it every tick. The block
        // matured with no attributable shares — its reward stays in the pool wallet.
        // CAS like the paid path below: only a row still in 'confirmed' may be closed out.
        const closed = this.db.prepare(
          "UPDATE blocks SET status = 'paid' WHERE id = ? AND status = 'confirmed'"
        ).run(blockId);
        if (closed.changes !== 1) {
          return { block_id: blockId, success: false, reason: 'already_settled', shares_count: 0 };
        }
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

      // ONE transaction covering the CAS status flip, the miner credits, the pool fee and the
      // incentive rebalance. Previously these were four separate write units with the flip
      // last, so a crash after the credits committed left the block in 'confirmed' — and the
      // monitor's next 30s tick re-credited every miner. See audit §I4.
      //
      // The flip goes FIRST inside the transaction: it is the claim. A replay (or a second
      // caller) finds 0 changed rows and throws, rolling the whole thing back before a single
      // balance moves. Ordering it last would leave the same window the bug came from.
      let distributionResult;
      const settle = this.db.transaction(() => {
        const claimed = this.db.prepare(
          "UPDATE blocks SET status = 'paid' WHERE id = ? AND status = 'confirmed'"
        ).run(blockId);
        if (claimed.changes !== 1) {
          const e = new Error(`block ${blockId} is no longer 'confirmed' — already settled`);
          e.alreadySettled = true;
          throw e;
        }
        distributionResult = this.creditBalances(block.height, distribution, minerReward, poolFee);
      });

      try {
        settle();
      } catch (err) {
        if (err.alreadySettled) {
          return { block_id: blockId, success: false, reason: 'already_settled', shares_count: shares.length };
        }
        throw err;
      }

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

      // NOTE: no transaction() here — distributeRewards wraps this whole call (plus the
      // confirmed→paid CAS) in one. Opening a nested one would only create a savepoint and
      // obscure that the caller owns atomicity. Never call this outside that transaction.
      for (const [grinAddress, amount] of minerMap) {
        // Mirror the pool-fee path's INSERT OR IGNORE. balance_log.grin_address is a FK and
        // foreign_keys is ON, so a missing account row would otherwise abort the whole
        // distribution and leave the block retrying every 30s forever. See audit §I6.
        this.db.prepare(
          'INSERT OR IGNORE INTO miner_accounts (grin_address, balance) VALUES (?, 0)'
        ).run(grinAddress);

        // Real before/after snapshots, not the 0 placeholders this used to write. balance_log
        // is the ledger the miner sees at /api/account/:addr/balance/log and the one a
        // disputed payout is reconstructed from; zeros made it unauditable. See audit §I5.
        const before = this.db.prepare(
          'SELECT balance, balance_locked FROM miner_accounts WHERE grin_address = ?'
        ).get(grinAddress);

        const credited = this.db.prepare(
          'UPDATE miner_accounts SET balance = balance + ?, updated_at = unixepoch() WHERE grin_address = ?'
        ).run(amount, grinAddress);
        if (credited.changes !== 1) {
          throw new Error(`credit failed for ${grinAddress} — account row missing after ensure`);
        }

        this.db.prepare(`
          INSERT INTO balance_log
          (grin_address, event_type, amount, balance_before, balance_after,
           locked_before, locked_after, reference_type, reference_id)
          VALUES (?, 'credit', ?, ?, ?, ?, ?, 'block', ?)
        `).run(grinAddress, amount, before.balance, before.balance + amount,
               before.balance_locked, before.balance_locked, blockHeight);

        results.push({
          grin_address: grinAddress,
          credited: amount
        });
      }

      if (this.config.pool_fee_percent > 0) {
        const feeAddress = this.config.pool_fee_address || 'pool_fee';
        const stmt = this.db.prepare(`
          INSERT OR IGNORE INTO miner_accounts (grin_address, balance)
          VALUES (?, 0)
        `);
        stmt.run(feeAddress);

        const feeBefore = this.db.prepare(
          'SELECT balance, balance_locked FROM miner_accounts WHERE grin_address = ?'
        ).get(feeAddress);

        this.db.prepare(
          'UPDATE miner_accounts SET balance = balance + ?, updated_at = unixepoch() WHERE grin_address = ?'
        ).run(poolFee, feeAddress);

        this.db.prepare(`
          INSERT INTO balance_log
          (grin_address, event_type, amount, balance_before, balance_after,
           locked_before, locked_after, reference_type, reference_id)
          VALUES (?, 'credit', ?, ?, ?, ?, ?, 'pool_fee', ?)
        `).run(feeAddress, poolFee, feeBefore.balance, feeBefore.balance + poolFee,
               feeBefore.balance_locked, feeBefore.balance_locked, blockHeight);
      }

      // Incentive rebalancing: divert fee-cut + donations into the prize pool and pay streak
      // top-ups. Called directly — the caller's transaction already covers it, and wrapping it
      // again would only open a savepoint (see the note at the top of this method).
      if (this.incentives && this.incentives.enabled()) {
        this.incentives.applyToDistribution(blockHeight, minerMap, poolFee);
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
