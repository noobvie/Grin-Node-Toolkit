const { getDb } = require('./db');

class BlockManager {
  constructor(config) {
    this.config = config;
    this.db = getDb();
    this.lastBlockHeight = 0;
  }

  async creditBlock(height, hash, nonce, reward, minerAddress) {
    try {
      const stmt = this.db.prepare(`
        INSERT INTO blocks (height, hash, nonce, reward, status, found_by, found_at)
        VALUES (?, ?, ?, ?, 'immature', ?, unixepoch())
      `);

      const result = stmt.run(height, hash, nonce, reward, minerAddress);

      console.log(
        `[${new Date().toISOString()}] Block credited: height=${height}, hash=${hash.substring(0, 16)}..., reward=${reward} GRIN, miner=${minerAddress}`
      );

      return {
        success: true,
        block_id: result.lastInsertRowid,
        height,
        hash,
        reward
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

  async getPoolStats() {
    try {
      const totalBlocks = this.db.prepare(
        'SELECT COUNT(*) as count FROM blocks'
      ).get();

      const totalReward = this.db.prepare(
        'SELECT COALESCE(SUM(reward), 0) as total FROM blocks'
      ).get();

      const confirmedBlocks = this.db.prepare(
        "SELECT COUNT(*) as count FROM blocks WHERE status = 'confirmed'"
      ).get();

      const confirmedReward = this.db.prepare(
        "SELECT COALESCE(SUM(reward), 0) as total FROM blocks WHERE status = 'confirmed'"
      ).get();

      return {
        total_blocks_found: totalBlocks.count,
        total_reward: totalReward.total,
        confirmed_blocks: confirmedBlocks.count,
        confirmed_reward: confirmedReward.total,
        immature_blocks: totalBlocks.count - confirmedBlocks.count
      };
    } catch (err) {
      console.error(`Error fetching pool stats: ${err.message}`);
      return {
        total_blocks_found: 0,
        total_reward: 0,
        confirmed_blocks: 0,
        confirmed_reward: 0,
        immature_blocks: 0
      };
    }
  }
}

module.exports = BlockManager;
