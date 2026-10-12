// /api/admin/incentives*. Moved verbatim out of routes/index.js (code-layout refactor P9);
// registrations stay at 2-space indent and write FULL paths.

const express = require('express');

module.exports = function createAdminIncentivesRoutes(ctx, guards) {
  const { db, incentivesManager, lotteryManager } = ctx;
  const { secureAdmin, freshAdmin } = guards;
  const router = express.Router();

  // Award a contest/incentive prize directly to a miner's address (address-as-identity —
  // no account needed). Funded from the prize_pool bucket by default so it's backed by real
  // GRIN already in the wallet; the prize pays out to the address via the normal Tor flow.
  // The note is stored in the audit log for the operator's records.
  router.post('/api/admin/incentives/award', freshAdmin, (req, res) => {
    try {
      const addr = String((req.body && req.body.address) || '').trim();
      const amount = parseFloat(req.body && req.body.amount);
      const note = String((req.body && req.body.note) || '').slice(0, 280);
      const fromPrizePool = (req.body && req.body.from_prize_pool) !== false; // default true

      if (!/^t?grin1[ac-hj-np-z02-9]{40,}$/.test(addr)) {
        return res.status(400).json({ error: 'Enter a valid Grin Slatepack address (grin1…)' });
      }
      // Number.isFinite, not isNaN: `"Infinity"` passes isNaN() and `<= 0`, and a REAL
      // balance column stores +Inf permanently — no finite correction can undo it, and
      // JSON.stringify renders it as `null`, so the corruption is invisible. Audit §J7-5.
      if (!Number.isFinite(amount) || amount <= 0) {
        return res.status(400).json({ error: 'amount must be a positive, finite number' });
      }
      if (!incentivesManager) {
        return res.status(503).json({ error: 'incentives unavailable' });
      }

      const result = incentivesManager.awardPrize(addr, amount, { fromPrizePool });
      if (!result.ok) {
        const msg = result.reason === 'insufficient_prize_pool'
          ? 'Prize pool balance is too low to cover this award. Top up the prize pool or uncheck "fund from prize pool".'
          : (result.reason || 'award failed');
        return res.status(400).json({ error: msg });
      }

      db.prepare(`
        INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, details, ip)
        VALUES (?, 'prize_award', 'miner_account', ?, ?, ?)
      `).run(req.user.user_id, addr, JSON.stringify({ amount, note, from_prize_pool: fromPrizePool, balance: result.balance }), req.ip);

      res.json({ success: true, grin_address: addr, amount, balance: result.balance, funded_from: fromPrizePool ? 'prize_pool' : 'mint' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── INCENTIVES ENDPOINTS (Admin only) ────────────────────────────
  // Scalar config is handled by the generic /api/admin/settings/incentives endpoints; these
  // cover the live prize-pool bucket and lottery draws that the generic settings can't.

  router.get('/api/admin/incentives/prize-pool', secureAdmin, (req, res) => {
    try {
      // statement = lifetime in/out breakdown (fee-cut · donations · top-ups · abandoned balances
      // in; prizes · jackpots · join bonuses · streaks out) + current balance + recent 25 rows.
      // `balance`/`ledger` kept for backward-compat with the existing panel wiring.
      const statement = incentivesManager.prizePoolStatement(25);
      res.json({
        success: true,
        balance: statement.balance,
        ledger: statement.recent,
        statement,
      });
    } catch (err) {
      res.status(500).json({ error: 'Failed to load prize pool' });
    }
  });

  // Manual operator top-up of the prize bucket. Accounting only — the operator must already
  // hold the GRIN in the pool wallet; this just records it as available for prizes.
  router.post('/api/admin/incentives/prize-pool/topup', freshAdmin, (req, res) => {
    try {
      const balance = incentivesManager.manualTopup(req.body.amount);
      db.prepare(`
        INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, details)
        VALUES (?, 'prize_pool_topup', 'prize_pool', 'prize_pool', ?)
      `).run(req.user.user_id, JSON.stringify({ amount: req.body.amount, balance }));
      res.json({ success: true, balance });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.get('/api/admin/incentives/lottery/draws', secureAdmin, (req, res) => {
    try {
      res.json({
        success: true,
        draws: lotteryManager.recentDraws(20),
        next: lotteryManager.nextScheduled(),
      });
    } catch (err) {
      res.status(500).json({ error: 'Failed to load lottery draws' });
    }
  });

  // Manually trigger a draw (testing / off-schedule special event).
  router.post('/api/admin/incentives/lottery/draw-now', freshAdmin, async (req, res) => {
    try {
      const type = req.body.type === 'special' ? 'special' : 'weekly';
      const result = await lotteryManager.runDraw(type, {
        eventName: req.body.event_name || null,
        // Finite-only (§J7-5): parseFloat('Infinity') is truthy, so `|| 0` does not catch it.
        potGrinOverride: (Number.isFinite(parseFloat(req.body.pot_grin)) ? parseFloat(req.body.pot_grin) : 0),
      });
      db.prepare(`
        INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, details)
        VALUES (?, 'lottery_draw_now', 'lottery', ?, ?)
      `).run(req.user.user_id, String(result.draw_id || ''), JSON.stringify(result));
      res.json({ success: true, result });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // ─── Contest campaigns (admin CRUD) ─────────────────────────────────────────
  // A campaign is a scheduled lottery draw with an explicit date-range window and optional
  // per-campaign rule overrides (pot split, min active days, whale cap). See lib/lottery.js.

  router.get('/api/admin/incentives/campaigns', secureAdmin, (req, res) => {
    try {
      res.json({ success: true, campaigns: lotteryManager.listCampaigns(50) });
    } catch (err) {
      res.status(500).json({ error: 'Failed to load campaigns' });
    }
  });

  router.post('/api/admin/incentives/campaigns', freshAdmin, (req, res) => {
    try {
      const campaign = lotteryManager.createCampaign(req.body || {});
      db.prepare(`
        INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, details)
        VALUES (?, 'campaign_create', 'campaign', ?, ?)
      `).run(req.user.user_id, String(campaign.id), JSON.stringify(campaign));
      res.json({ success: true, campaign });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.put('/api/admin/incentives/campaigns/:id', freshAdmin, (req, res) => {
    try {
      const campaign = lotteryManager.updateCampaign(parseInt(req.params.id, 10), req.body || {});
      db.prepare(`
        INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, details)
        VALUES (?, 'campaign_update', 'campaign', ?, ?)
      `).run(req.user.user_id, String(campaign.id), JSON.stringify(campaign));
      res.json({ success: true, campaign });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.post('/api/admin/incentives/campaigns/:id/cancel', freshAdmin, (req, res) => {
    try {
      const campaign = lotteryManager.cancelCampaign(parseInt(req.params.id, 10));
      db.prepare(`
        INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, details)
        VALUES (?, 'campaign_cancel', 'campaign', ?, ?)
      `).run(req.user.user_id, String(campaign.id), JSON.stringify({ id: campaign.id }));
      res.json({ success: true, campaign });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // Manually run a scheduled campaign now (testing / early close). Pays real prize-pool GRIN.
  router.post('/api/admin/incentives/campaigns/:id/run', freshAdmin, async (req, res) => {
    try {
      const c = lotteryManager.getCampaign(parseInt(req.params.id, 10));
      if (!c) return res.status(404).json({ error: 'campaign not found' });
      if (c.status !== 'scheduled') return res.status(400).json({ error: 'campaign already drawn or cancelled' });
      const result = await lotteryManager.runCampaign(c);
      db.prepare(`
        INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, details)
        VALUES (?, 'campaign_run_now', 'campaign', ?, ?)
      `).run(req.user.user_id, String(c.id), JSON.stringify(result));
      res.json({ success: true, result });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  return router;
};
