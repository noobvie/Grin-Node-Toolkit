const { getDb } = require('./db');
const GrinNodeAPI = require('./grin-node');
const OrphanDetector = require('./orphan-detector');

class BlockMonitor {
  constructor(config) {
    this.config = config;
    this.db = getDb();
    this.grinNode = new GrinNodeAPI(config);
    this.orphanDetector = new OrphanDetector(config, this.grinNode);
    this.lastKnownHeight = 0;
    this.isRunning = false;
    this.checkInterval = 30000;
    this.orphanCheckInterval = 6 * 3600 * 1000;
    this.lastOrphanCheck = 0;
  }

  start() {
    if (this.isRunning) return;

    this.isRunning = true;
    console.log(`[${new Date().toISOString()}] Block monitor started`);

    this.monitorLoop();
  }

  async monitorLoop() {
    while (this.isRunning) {
      try {
        await this.checkNewBlocks();

        const now = Date.now();
        if (now - this.lastOrphanCheck > this.orphanCheckInterval) {
          await this.runOrphanDetection();
          this.lastOrphanCheck = now;
        }
      } catch (err) {
        console.error(`[ERROR] Block monitor error: ${err.message}`);
      }

      await this.sleep(this.checkInterval);
    }
  }

  async checkNewBlocks() {
    try {
      const status = await this.grinNode.getStatus();

      if (!status.ok) {
        console.log(`[${new Date().toISOString()}] Node API unavailable: ${status.error}`);
        return;
      }

      if (status.height > this.lastKnownHeight) {
        console.log(
          `[${new Date().toISOString()}] Network height: ${status.height} (difficulty: ${status.total_difficulty})`
        );
        this.lastKnownHeight = status.height;
      }

      await this.checkImmatureBlocks();
    } catch (err) {
      console.error(`Error checking new blocks: ${err.message}`);
    }
  }

  async checkImmatureBlocks() {
    try {
      const stmt = this.db.prepare(`
        SELECT * FROM blocks WHERE status = 'immature' ORDER BY height ASC
      `);
      const immatureBlocks = stmt.all();

      const tip = await this.grinNode.getTip();
      const confirmDepth = this.config.network === 'mainnet'
        ? this.config.confirm_depth_mainnet
        : this.config.confirm_depth_testnet;

      for (const block of immatureBlocks) {
        const confirmationCount = tip.height - block.height;

        if (confirmationCount >= confirmDepth) {
          const verification = await this.orphanDetector.verifyBlockOnChain(
            block.height,
            block.nonce
          );

          if (verification.onChain) {
            this.orphanDetector.confirmBlock(block.id);
            console.log(
              `[${new Date().toISOString()}] Block confirmed: height=${block.height}, confirmations=${confirmationCount}`
            );
          } else {
            this.orphanDetector.orphanBlock(block.id, verification.reason);
            this.orphanDetector.reverseBlockPayouts(block.id);
            console.log(
              `[${new Date().toISOString()}] Block orphaned: height=${block.height}, reason=${verification.reason}`
            );
          }
        }
      }
    } catch (err) {
      console.error(`Error checking immature blocks: ${err.message}`);
    }
  }

  async runOrphanDetection() {
    try {
      console.log(`[${new Date().toISOString()}] Running orphan detection...`);
      const results = await this.orphanDetector.detectOrphans();

      console.log(
        `[${new Date().toISOString()}] Orphan detection complete: ${results.checked} checked, ${results.confirmed} confirmed, ${results.orphaned} orphaned`
      );

      if (results.orphaned > 0) {
        console.warn(`⚠️  WARNING: ${results.orphaned} blocks detected as orphaned`);
      }
    } catch (err) {
      console.error(`Error running orphan detection: ${err.message}`);
    }
  }

  getStatus() {
    return {
      running: this.isRunning,
      last_known_height: this.lastKnownHeight,
      last_orphan_check: new Date(this.lastOrphanCheck).toISOString()
    };
  }

  stop() {
    this.isRunning = false;
    console.log(`[${new Date().toISOString()}] Block monitor stopped`);
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = BlockMonitor;
