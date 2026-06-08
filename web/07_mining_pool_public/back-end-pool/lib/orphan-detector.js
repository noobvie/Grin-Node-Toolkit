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

      const shares = this.db.prepare(`
        SELECT * FROM shares WHERE block_height = ?
      `).all(block.height);

      for (const share of shares) {
        const stmt = this.db.prepare(`
          UPDATE miner_accounts
          SET balance = balance - ?, balance_locked = balance_locked - ?
          WHERE grin_address = ?
        `);

        const rewardAmount = block.reward / shares.length;
        stmt.run(rewardAmount, 0, share.grin_address);

        const logStmt = this.db.prepare(`
          INSERT INTO balance_log
          (grin_address, event_type, amount, balance_before, balance_after,
           locked_before, locked_after, reference_type, reference_id)
          VALUES (?, 'reversal', ?, 0, 0, 0, 0, 'block', ?)
        `);
        logStmt.run(share.grin_address, rewardAmount, blockId);
      }

      // Claw back any block-finder jackpot paid for this block (idempotent).
      if (this.incentives) {
        this.incentives.reverseJackpot(block.height);
      }

      console.log(`Reversed payouts for block ${blockId} (${shares.length} shares)`);
    } catch (err) {
      console.error(`Error reversing block payouts: ${err.message}`);
    }
  }
}

module.exports = OrphanDetector;
