// /api/admin/blocks + /api/admin/metrics. Moved verbatim out of routes/index.js (code-layout
// refactor P7); registrations stay at 2-space indent and write FULL paths.

const express = require('express');
const explorers = require('../../lib/explorers');
const createCurrentExplorerKey = require('../_shared/explorer');

module.exports = function createAdminBlocksRoutes(ctx, guards) {
  const { config, db, blockMonitor, blockManager, rewardDistributor, hashrateTracker, withdrawalScheduler } = ctx;
  const currentExplorerKey = createCurrentExplorerKey(ctx);
  const { secureAdmin } = guards;
  const router = express.Router();

  // ─── POOL BLOCKS EXPLORER (Admin) ──────────────────────────────────
  // Pool-found blocks with maturity countdown + chain-explorer deep-links. Distinct from a public
  // chain explorer: this is only THIS pool's blocks, with payout-relevant context (status,
  // maturity, orphan reversals) that a chain explorer cannot have. `grinscan_url` is a legacy
  // field name kept for API shape — it holds whichever explorer the `branding.explorer_mainnet`
  // setting resolves to (lib/explorers.js; testnet is always test.grinscan.org), and the admin
  // page builds its own links via window.Explorer.
  router.get('/api/admin/blocks', secureAdmin, async (req, res) => {
    try {
      const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 500);
      const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
      const status = req.query.status || null;

      const where = status ? 'WHERE status = ?' : '';
      const args = status ? [status, limit, offset] : [limit, offset];
      const rows = db.prepare(
        `SELECT id, height, hash, nonce, reward, fees, status, found_by, found_at, confirmed_at, created_at,
                network_difficulty, round_shares
         FROM blocks ${where} ORDER BY height DESC LIMIT ? OFFSET ?`
      ).all(...args);

      // Current tip → maturity countdown. confirm_depth depends on the network.
      const confirmDepth = config.network === 'testnet'
        ? (config.confirm_depth_testnet || 100)
        : (config.confirm_depth_mainnet || 1440);
      let tipHeight = 0;
      try {
        const st = await blockMonitor.grinNode.getStatus();
        tipHeight = (st && st.ok && st.height) || 0;
      } catch (e) { tipHeight = 0; }

      // The operator's explorer setting, resolved once per request (lib/explorers.js owns the
      // path schemes — they differ per explorer, so never build one of these URLs by hand).
      const explorerKey = currentExplorerKey();
      const explorerBlockUrl = (height) => explorers.explorerUrl(explorerKey, 'block', height);

      const blocks = rows.map((b) => {
        const confirmations = tipHeight ? Math.max(0, tipHeight - b.height) : 0;
        // 'paid' is confirmed-and-distributed (rewards.js flips confirmed→paid), so maturity
        // is behind it too — omitting it made the admin blocks page compute a countdown for
        // a block that had already paid out. Audit §J14.
        const blocks_to_maturity = (b.status === 'confirmed' || b.status === 'paid' || b.status === 'orphaned')
          ? 0 : Math.max(0, confirmDepth - confirmations);
        return {
          ...b,
          confirmations,
          blocks_to_maturity,
          grinscan_url: explorerBlockUrl(b.height),
        };
      });

      res.json({
        success: true,
        tip_height: tipHeight,
        confirm_depth: confirmDepth,
        network: config.network,
        summary: blockManager.getPoolStats(),
        count: blocks.length,
        blocks,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });




  router.get('/api/admin/metrics', secureAdmin, async (req, res) => {
    try {
      const blockStats = blockManager.getPoolStats();
      const rewardStats = await rewardDistributor.rewardStats();
      const hashrateStats = hashrateTracker.getHashrateStats();
      const withdrawalStats = withdrawalScheduler.getStatus();

      res.json({
        blocks: blockStats,
        rewards: rewardStats,
        hashrate: hashrateStats,
        withdrawals: withdrawalStats,
        timestamp: new Date().toISOString()
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};
