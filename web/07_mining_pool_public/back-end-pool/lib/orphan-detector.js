const { getDb } = require('./db');
const IncentivesManager = require('./incentives');

class OrphanDetector {
  constructor(config, grinNode) {
    this.config = config;
    this.grinNode = grinNode;
    this.db = getDb();
    this.incentives = new IncentivesManager(config);
  }

  async verifyBlockOnChain(blockHeight, blockNonce) {
    try {
      const header = await this.grinNode.getHeader(blockHeight);

      if (header.nonce === blockNonce) {
        return {
          onChain: true,
          hash: header.hash
        };
      } else {
        return {
          onChain: false,
          reason: 'nonce_mismatch',
          chainNonce: header.nonce,
          poolNonce: blockNonce
        };
      }
    } catch (err) {
      if (err.message.includes('not found') || err.message.includes('height')) {
        return {
          onChain: false,
          reason: 'height_not_found'
        };
      }
      throw err;
    }
  }

  async detectOrphans() {
    try {
      const tip = await this.grinNode.getTip();
      const confirmDepth = this.config.network === 'mainnet'
        ? this.config.confirm_depth_mainnet
        : this.config.confirm_depth_testnet;

      const stmt = this.db.prepare(`
        SELECT * FROM blocks
        WHERE status = 'immature' AND height <= ?
        ORDER BY height ASC
      `);

      const immatureBlocks = stmt.all(tip.height - confirmDepth);

      const results = {
        checked: 0,
        confirmed: 0,
        orphaned: 0,
        details: []
      };

      for (const block of immatureBlocks) {
        results.checked++;

        const verification = await this.verifyBlockOnChain(block.height, block.nonce);

        if (verification.onChain) {
          this.confirmBlock(block.id);
          this.incentives.payBlockFinderJackpot(block);
          results.confirmed++;
          results.details.push({
            block_id: block.id,
            height: block.height,
            status: 'confirmed'
          });
        } else {
          this.orphanBlock(block.id, verification.reason);
          this.reverseBlockPayouts(block.id);
          results.orphaned++;
          results.details.push({
            block_id: block.id,
            height: block.height,
            status: 'orphaned',
            reason: verification.reason
          });
        }
      }

      return results;
    } catch (err) {
      console.error(`Error detecting orphans: ${err.message}`);
      return {
        error: err.message,
        checked: 0,
        confirmed: 0,
        orphaned: 0
      };
    }
  }

  confirmBlock(blockId) {
    try {
      const stmt = this.db.prepare(`
        UPDATE blocks SET status = 'confirmed', confirmed_at = unixepoch() WHERE id = ?
      `);
      stmt.run(blockId);
    } catch (err) {
      console.error(`Error confirming block ${blockId}: ${err.message}`);
    }
  }

  orphanBlock(blockId, reason = 'unknown') {
    try {
      const stmt = this.db.prepare(`
        UPDATE blocks SET status = 'orphaned' WHERE id = ?
      `);
      stmt.run(blockId);

      console.log(`Block ${blockId} marked as orphaned (reason: ${reason})`);
    } catch (err) {
      console.error(`Error orphaning block ${blockId}: ${err.message}`);
    }
  }

  reverseBlockPayouts(blockId) {
    try {
      const block = this.db.prepare('SELECT * FROM blocks WHERE id = ?').get(blockId);
      if (!block) return;

      // Reverse EXACTLY what was credited for this block, by reading back the original
      // balance_log credit rows (keyed by reference_type IN ('block','pool_fee') and
      // reference_id = block.height, matching rewards.js#creditBalances). This mirrors the
      // real difficulty-weighted PPLNS split (minus pool fee) instead of re-deriving it —
      // so it's correct even if the shares were pruned by retention, and it never reverses
      // more than was actually paid.
      //
      // Note: blocks are only distributed AFTER on-chain maturity verification, and orphan
      // detection only targets still-immature (never-distributed) blocks, so in normal
      // operation there are zero credit rows here and this is a safe no-op — we never deduct
      // a balance that was never credited (the previous equal-split logic did, and used the
      // wrong amount and miner set).
      const credits = this.db.prepare(`
        SELECT grin_address, COALESCE(SUM(amount), 0) AS amount
        FROM balance_log
        WHERE event_type = 'credit'
          AND reference_type IN ('block', 'pool_fee')
          AND reference_id = ?
        GROUP BY grin_address
      `).all(block.height);

      if (credits.length > 0) {
        const reverse = this.db.transaction(() => {
          for (const c of credits) {
            const before = this.db.prepare(
              'SELECT balance FROM miner_accounts WHERE grin_address = ?'
            ).get(c.grin_address);
            if (!before) continue;

            // Clamp: if the miner already withdrew, claw back only what remains rather than
            // driving the balance negative. Any shortfall is implicit in the ledger trail.
            const clawback = Math.min(c.amount, before.balance);
            if (clawback <= 0) continue;

            this.db.prepare(`
              UPDATE miner_accounts
              SET balance = balance - ?, updated_at = unixepoch()
              WHERE grin_address = ?
            `).run(clawback, c.grin_address);

            this.db.prepare(`
              INSERT INTO balance_log
              (grin_address, event_type, amount, balance_before, balance_after,
               locked_before, locked_after, reference_type, reference_id)
              VALUES (?, 'reversal', ?, ?, ?, 0, 0, 'block', ?)
            `).run(c.grin_address, clawback, before.balance, before.balance - clawback, block.height);
          }
        });
        reverse();
      }

      // Claw back any block-finder jackpot paid for this block (idempotent).
      if (this.incentives) {
        this.incentives.reverseJackpot(block.height);
      }

      console.log(`Reversed payouts for orphaned block height=${block.height} (${credits.length} credited address(es))`);
    } catch (err) {
      console.error(`Error reversing block payouts: ${err.message}`);
    }
  }
}

module.exports = OrphanDetector;
