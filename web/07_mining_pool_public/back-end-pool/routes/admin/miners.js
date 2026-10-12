// /api/admin/miners*. Moved verbatim out of routes/index.js (code-layout refactor P8);
// registrations stay at 2-space indent and write FULL paths.

const express = require('express');
const minerStatus = require('../../lib/miner-status');
const { PROOF_SET_MAX } = require('../../lib/owner-proof');
const { parseDonateToken } = require('../../lib/stratum-protocol');

module.exports = function createAdminMinersRoutes(ctx, guards) {
  const { config, db, minerManager, withdrawalScheduler, hashrateTracker, incentivesManager } = ctx;
  const { secureAdmin, freshAdmin } = guards;
  const router = express.Router();

  // ─── MINERS (Admin only) ───────────────────────────────────────────
  // Admin view of miner accounts (address-keyed; miners never have logins). Read access
  // to balances + share/hashrate activity, plus a testnet-only balance injector for
  // exercising the payout pipeline without mining 100 blocks first.
  //
  // Live columns (status, workers, hashrate, last_share_at) come from lib/miner-status.js: the
  // in-memory sessions plus ONE windowed pass over the last hour of shares. The per-row
  // `shares_count` / `last_share_at` subqueries this replaced walked every retained share twice
  // per refresh (see RECENT_SQL there). So last_share_at is now null when the address has not
  // shared inside the hour. The page then falls back to last_seen_at, which the session code
  // stamps on connect and disconnect and which, unlike shares, is never pruned.
  // `shares_count` is gone: it counted whatever retention had left, so it fell at every prune.
  //
  // WHICH accounts (the list is capped at `limit`, max 1000):
  //   ?search=  substring of the address, by balance, with `offset` — the page's server-side
  //             lookup for an account the capped list does not hold.
  //   otherwise every account that MINED inside seen_s (biggest first), then admin-banned ones,
  //             then share-less sessions, then the rest by balance (minerStatus.listPriority says
  //             why share-less sessions go last). `offset` does not apply: a page offset into a
  //             priority list that re-orders every refresh would skip and repeat rows.
  // `total_accounts` / `mined_accounts` / `truncated` let the page say how much it is showing.
  router.get('/api/admin/miners', secureAdmin, (req, res) => {
    try {
      const ADMIN_MINER_COLS = `
        ma.grin_address, ma.balance, ma.balance_locked, ma.is_online, ma.is_banned, ma.ban_reason, ma.banned_at,
        ma.last_seen_at, ma.created_at,
        (SELECT COALESCE(SUM(amount),0) FROM withdrawals w WHERE w.grin_address = ma.grin_address AND w.status='confirmed') AS total_paid`;
      const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 1000);
      const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
      // One string, bounded, and LIKE's own wildcards escaped so `_` in a query matches a literal
      // underscore rather than any character.
      const q = typeof req.query.search === 'string' ? req.query.search.trim().slice(0, 100) : '';
      const search = q ? '%' + q.replace(/[\\%_]/g, (c) => '\\' + c) + '%' : null;

      const now = Math.floor(Date.now() / 1000);
      const live = minerStatus.liveRigs(minerManager ? minerManager.getActiveSessions() : []);
      const recent = minerStatus.recentShares(db, now);
      const { mined, connecting } = minerStatus.listPriority(live, recent);

      let rows;
      if (search) {
        rows = db.prepare(`SELECT ${ADMIN_MINER_COLS} FROM miner_accounts ma
                            WHERE ma.grin_address LIKE ? ESCAPE '\\'
                            ORDER BY ma.balance DESC LIMIT ? OFFSET ?`).all(search, limit, offset);
      } else {
        const banned = db.prepare('SELECT grin_address FROM miner_accounts WHERE is_banned = 1 ORDER BY balance DESC LIMIT ?')
          .all(limit).map((r) => r.grin_address);
        const want = [...new Set([...mined, ...banned, ...connecting])].slice(0, limit);
        const wantJson = JSON.stringify(want);
        const picked = want.length
          ? db.prepare(`SELECT ${ADMIN_MINER_COLS} FROM miner_accounts ma
                         WHERE ma.grin_address IN (SELECT value FROM json_each(?))`).all(wantJson)
          : [];
        const room = limit - picked.length;
        const rest = room > 0
          ? db.prepare(`SELECT ${ADMIN_MINER_COLS} FROM miner_accounts ma
                         WHERE ma.grin_address NOT IN (SELECT value FROM json_each(?))
                         ORDER BY ma.balance DESC LIMIT ?`).all(wantJson, room)
          : [];
        // Balance order for the page's default view; the priority only decided who is IN.
        rows = picked.concat(rest).sort((a, b) => (b.balance || 0) - (a.balance || 0));
      }

      const miners = rows.map((m) => ({
        ...m,
        ...minerStatus.summarize(live.get(m.grin_address), recent.get(m.grin_address), now)
      }));
      const total_accounts = db.prepare('SELECT COUNT(*) AS n FROM miner_accounts').get().n;

      res.json({
        success: true, count: miners.length, windows: minerStatus.WINDOWS,
        total_accounts, mined_accounts: mined.length,
        truncated: !search && total_accounts > miners.length,
        miners
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Explicit column list, NOT `SELECT *` (audit §J8-2). `miner_accounts` carries the
  // ownership-gate's `proof_salt` plus ten legacy proof columns, and the proof HASHES now
  // live in `miner_proofs`. None of that may reach a browser: the hashes exist so the DB
  // holds no readable mining IP and no readable rig password (§G, memory
  // `project_pool_ip_privacy`), and §C3's unrevocable admin access token puts anything an
  // admin page receives one stolen session away from an offline attack on the payout gate's
  // second factor. `...acct` below spreads whatever this SELECT names, so the SELECT is the
  // control — the same fix, and the same reason, as the 2026-07-28 pass on
  // /api/pool/payments and /api/pool/miners.
  // `pass_proof_state` IS included: it is a verdict string ('ok' / a reject code), already
  // public on /api/account/:addr, and it is what answers "why won't my password work?".
  router.get('/api/admin/miners/:addr', secureAdmin, (req, res) => {
    try {
      const { addr } = req.params;
      const acct = db.prepare(
        `SELECT id, grin_address, balance, balance_locked, is_online, last_seen_at, min_payout,
                pass_proof_state, is_banned, ban_reason, banned_at,
                nostr_username, nostr_npub, nostr_registered_at,
                nostr_prev_username, nostr_prev_npub,
                created_at, updated_at
           FROM miner_accounts WHERE grin_address = ?`
      ).get(addr);
      if (!acct) return res.status(404).json({ error: 'miner not found' });

      // Support view of the proof set (design §17.2 #7): COUNTS AND TIMESTAMPS ONLY, per kind.
      // Enough to answer "does this miner have any proof on record, and how old is it?" —
      // which is the question a support ticket asks — without handing the panel a digest to
      // grind or a per-row capture time to correlate. `anchor_live` distinguishes an anchor
      // that is still an ordinary set member from one that has been evicted (and so is
      // refused by the destination gate, §J3-4), because that is the difference between a
      // miner who can change their payout destination and one who cannot.
      const proofSets = {};
      for (const kind of ['ip', 'pass']) {
        const agg = db.prepare(
          `SELECT SUM(CASE WHEN evicted_at IS NULL THEN 1 ELSE 0 END) AS live,
                  MIN(first_seen_at) AS oldest_first_seen,
                  MAX(CASE WHEN evicted_at IS NULL THEN last_seen_at END) AS newest_last_seen,
                  MAX(CASE WHEN is_anchor = 1 AND evicted_at IS NULL THEN 1 ELSE 0 END) AS anchor_live
             FROM miner_proofs WHERE grin_address = ? AND kind = ?`
        ).get(addr, kind) || {};
        proofSets[kind] = {
          live: agg.live || 0,
          oldest_first_seen: agg.oldest_first_seen === undefined ? null : agg.oldest_first_seen,
          newest_last_seen: agg.newest_last_seen === undefined ? null : agg.newest_last_seen,
          anchor_live: !!agg.anchor_live
        };
      }

      const total_paid = db.prepare(
        `SELECT COALESCE(SUM(amount),0) AS t FROM withdrawals WHERE grin_address = ? AND status='confirmed'`
      ).get(addr).t;
      // Same strip as GET /api/admin/withdrawals: never serve an old row's stepwise final slate
      // (the column is inert since 2026-09-26), nor the manual rail's stored S1.
      const pending = db.prepare(
        `SELECT * FROM withdrawals WHERE grin_address = ? AND status IN ('tor_checking','tor_sending','tor_held','retry_scheduled','slatepack_pending','finalizing') ORDER BY created_at DESC`
      ).all(addr).map(({ tor_final_slate, slatepack_s1, ...rest }) => rest);
      // The Tor pause as the miner sees it; the operator clears it with the route below.
      const tor_pause = withdrawalScheduler ? withdrawalScheduler.torPauseStatus(addr) : null;
      const shareAgg = db.prepare(
        `SELECT COUNT(*) AS count, MAX(created_at) AS last_share_at FROM shares WHERE grin_address = ?`
      ).get(addr);
      const blocks_found = db.prepare(
        `SELECT COUNT(*) AS c FROM blocks WHERE found_by = ?`
      ).get(addr).c;
      const incentives = db.prepare('SELECT * FROM miner_incentives WHERE grin_address = ?').get(addr) || null;
      const hr = hashrateTracker.getMinerHashrate(addr, 60) || {};

      res.json({
        success: true,
        miner: {
          ...acct,
          is_online: !!acct.is_online,
          total_paid,
          shares_count: shareAgg.count || 0,
          last_share_at: shareAgg.last_share_at || null,
          blocks_found,
          hashrate_gps: parseFloat(((hr.avg_hashrate || 0)).toFixed(6)),
          pending_withdrawals: pending,
          tor_pause,
          proofs: { max: PROOF_SET_MAX, ip: proofSets.ip, pass: proofSets.pass },
          incentives
        }
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Per-rig rows for the expanded view on miners.html. Same data as the public
  // /api/account/:addr/workers (getWorkersForAccount), taken over the seen_s window so a rig that
  // dropped inside it is still listed as `offline`, plus a ten-minute hashrate, the region(s) each
  // live rig is connected through and when that session started. Nothing here the account page
  // does not already publish, apart from the region, and no rig IP or password: those stay
  // hashes in miner_proofs (memory project_pool_ip_privacy). Status rules live in
  // lib/miner-status.js, the same place the list's status dot comes from.
  router.get('/api/admin/miners/:addr/workers', secureAdmin, (req, res) => {
    try {
      const { addr } = req.params;
      const known = db.prepare('SELECT 1 AS x FROM miner_accounts WHERE grin_address = ?').get(addr);
      if (!known) return res.status(404).json({ error: 'miner not found' });
      const W = minerStatus.WINDOWS;
      // ONE call for both windows (the short one is a subset of the long one): the page re-polls
      // this route for each open row, so it reads the address's last hour of shares once, not twice.
      const hour = hashrateTracker.getWorkersForAccount(addr, W.seen_s / 60, W.hashrate_s / 60);
      const live = minerStatus.liveRigs(minerManager ? minerManager.getSessionsByMiner(addr) : []).get(addr);
      // A donateN tag moves nothing while the operator has donations off, so it reads null
      // then, the same rule as the public worker readout.
      let donationsOn = false;
      try { donationsOn = !!(incentivesManager && incentivesManager.donationsActive()); } catch (_) { donationsOn = false; }
      const donateOf = (name) => {
        const t = donationsOn ? parseDonateToken(name) : null;
        return t ? t.percent : null;
      };
      const now = Math.floor(Date.now() / 1000);
      res.json({
        success: true,
        grin_address: addr,
        windows: W,
        workers: minerStatus.workerRows({ hour, live, now, donateOf })
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Testnet-only: inject GRIN into a miner's balance to exercise the payout pipeline
  // (skip the confirm_depth wait). Hard-guarded to testnet so it can never mint mainnet
  // balances. Records a balance_log credit + admin_audit_log row. Step-up gated (freshAdmin)
  // for parity with every other balance-mutating action (withdrawals, payouts, incentives).
  router.post('/api/admin/miners/:addr/inject', freshAdmin, (req, res) => {
    try {
      if (config.network !== 'testnet') {
        return res.status(403).json({ error: 'balance injection is testnet-only' });
      }
      const { addr } = req.params;
      const amount = parseFloat(req.body && req.body.amount);
      // Number.isFinite, not isNaN: `"Infinity"` passes isNaN() and `<= 0`, and a REAL
      // balance column stores +Inf permanently — no finite correction can undo it, and
      // JSON.stringify renders it as `null`, so the corruption is invisible. Audit §J7-5.
      if (!Number.isFinite(amount) || amount <= 0) {
        return res.status(400).json({ error: 'amount must be a positive, finite number' });
      }

      const injected = db.transaction(() => {
        minerManager.ensureMinerExists(addr);
        const before = db.prepare('SELECT balance, balance_locked FROM miner_accounts WHERE grin_address = ?').get(addr);
        db.prepare('UPDATE miner_accounts SET balance = balance + ?, updated_at = unixepoch() WHERE grin_address = ?').run(amount, addr);
        const after = before.balance + amount;
        db.prepare(`
          INSERT INTO balance_log
          (grin_address, event_type, amount, balance_before, balance_after, locked_before, locked_after, reference_type, reference_id)
          VALUES (?, 'credit', ?, ?, ?, ?, ?, 'admin_inject', 0)
        `).run(addr, amount, before.balance, after, before.balance_locked, before.balance_locked);
        return after;
      })();

      db.prepare(`
        INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, details, ip)
        VALUES (?, 'miner_inject', 'miner_account', ?, ?, ?)
      `).run(req.user.user_id, addr, JSON.stringify({ amount, balance: injected }), req.ip);

      res.json({ success: true, grin_address: addr, amount, balance: injected });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Ban / unban a mining address (abuse control). Banning blocks future stratum logins +
  // drops live sessions; the balance is left intact so anything already owed can still be
  // paid out. Step-up gated (freshAdmin) — it's a moderation/access action.
  router.post('/api/admin/miners/:addr/ban', freshAdmin, (req, res) => {
    try {
      const addr = String(req.params.addr || '').trim();
      const reason = String((req.body && req.body.reason) || '').slice(0, 280) || null;
      if (!addr) return res.status(400).json({ error: 'address required' });
      minerManager.banMiner(addr, reason);
      db.prepare(`
        INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, details, ip)
        VALUES (?, 'miner_ban', 'miner_account', ?, ?, ?)
      `).run(req.user.user_id, addr, JSON.stringify({ reason }), req.ip);
      res.json({ success: true, grin_address: addr, is_banned: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/api/admin/miners/:addr/unban', freshAdmin, (req, res) => {
    try {
      const addr = String(req.params.addr || '').trim();
      if (!addr) return res.status(400).json({ error: 'address required' });
      minerManager.unbanMiner(addr);
      db.prepare(`
        INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, details, ip)
        VALUES (?, 'miner_unban', 'miner_account', ?, '{}', ?)
      `).run(req.user.user_id, addr, req.ip);
      res.json({ success: true, grin_address: addr, is_banned: false });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Clear an address's Tor pause — for a pause the operator judges was the pool's fault. The
  // counted failures are re-coded wallet_offline_cleared (the counter skips them); no history is
  // deleted. Step-up, like ban/unban: it re-opens a payout rail for someone.
  router.post('/api/admin/miners/:addr/tor-pause/clear', freshAdmin, (req, res) => {
    try {
      const addr = String(req.params.addr || '').trim();
      if (!addr) return res.status(400).json({ error: 'address required' });
      if (!withdrawalScheduler) return res.status(503).json({ error: 'withdrawal scheduler not running' });
      const known = db.prepare('SELECT 1 AS x FROM miner_accounts WHERE grin_address = ?').get(addr);
      if (!known) return res.status(404).json({ error: 'miner not found' });
      const before = withdrawalScheduler.torPauseStatus(addr);
      const cleared = withdrawalScheduler.clearTorPause(addr, { adminId: req.user.user_id });
      const after = withdrawalScheduler.torPauseStatus(addr);
      db.prepare(`
        INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, details, ip)
        VALUES (?, 'miner_tor_pause_clear', 'miner_account', ?, ?, ?)
      `).run(req.user.user_id, addr, JSON.stringify({ cleared, before }), req.ip);
      res.json({ success: true, grin_address: addr, cleared, tor_pause: after });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};
