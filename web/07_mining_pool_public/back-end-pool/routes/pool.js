// /api/pool/*, /api/stratum/*, /api/network/*, /api/config/* — the public read APIs behind the dashboard,
// miners-stats, blocks, payments, network-map and connect pages.
// Moved verbatim out of routes/index.js (code-layout refactor P4); registrations stay at 2-space
// indent and write FULL paths. Instances/state come from ctx.

const express = require('express');
const caches = require('./_shared/caches');
const createCurrentExplorerKey = require('./_shared/explorer');
const geoip = require('../lib/geoip');
const connectSuggest = require('../lib/connect-suggest');
const { hubRttMs } = require('../lib/region-rtt');
const { maskAddr } = require('../lib/http-util');
const { cachedGatewayStatus, publicRegionStatus, refreshStratumProbes, stratumRttWindow, stratumVerdict } = require('../lib/gateway-status');
const { getHorizon: getLedgerRollupHorizon } = require('../lib/ledger-rollup');
const { donorSettings } = require('../lib/donor-names');
const { donorWall, liveDonations: donorLiveDonations } = require('../lib/donor-ledger');

module.exports = function createPoolRoutes(ctx, app) {
  const {
    _peerSensorNets, blockManager, blockMonitor, config, db, dormancyManager,
    hashrateTracker, incentivesManager, minerManager, nodeAvailability, poolSettings,
    rateLimiter, stratumPause, stratumServer, wallet
  } = ctx;
  const router = express.Router();
  const currentExplorerKey = createCurrentExplorerKey(ctx);

  router.get('/api/config/pool-info', rateLimiter.middleware('public'), (req, res) => {
    res.json({
      network: config.network,
      explorer: currentExplorerKey(),   // blocks.html primes its link cache from this
      pool_fee_percent: config.pool_fee_percent,
      min_withdrawal: config.min_withdrawal,
      // Flat fee deducted from every payout (0 = the pool absorbs the network fee).
      withdrawal_fee: config.withdrawal_fee || 0,
      address_format: `grin1...`,
      wallet_required: config.tor_enabled ? 'Tor listener' : 'HTTP endpoint'
    });
  });

  router.get('/api/stratum/stats', rateLimiter.middleware('public'), (req, res) => {
    try {
      const stats = stratumServer.getStats();
      // Public, unauthenticated endpoint: truncate miner addresses so the live session list
      // can't be scraped to enumerate every miner's full identity (same privacy posture as
      // the blocks/fortune-board pages). Internal callers use getStats() directly for the
      // full address; this route is the only public surface and never needs it.
      if (Array.isArray(stats.sessions)) {
        stats.sessions = stats.sessions.map((s) => {
          const a = String(s.grin_address || '');
          return {
            ...s,
            grin_address: a.length > 16 ? a.slice(0, 9) + '…' + a.slice(-4) : a
          };
        });
      }
      res.json(stats);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/api/pool/stats', rateLimiter.middleware('public'), (req, res) => {
    try {
      const blockStats = blockManager.getPoolStats();
      const minerCount = minerManager.getActiveMinersCount();
      const sstats = stratumServer.getStats();
      // Pool-wide live share quality (accepted/stale/rejected) summed across stratum
      // sessions. Under Model C EVERY miner's session terminates here (gateways just forward
      // TCP), so this is complete pool-wide — no more hub-mode reject/stale blind spot. Still
      // LIVE-only (in-memory): empty on a bare hub with no sessions, resets on disconnect.
      const sq = { accepted: 0, stale: 0, rejected: 0 };
      for (const s of (sstats.sessions || [])) {
        sq.accepted += s.accepted || 0;
        sq.stale    += s.stale    || 0;
        sq.rejected += s.rejected || 0;
      }
      res.json({
        ...blockStats,
        active_miners: minerCount,
        active_connections: sstats.active_connections,
        // Logged-in rigs (one stratum login = one worker). `active_connections` is raw TCP
        // sockets, which also counts a connection that has not (yet) sent its login.
        active_workers: (sstats.sessions || []).length,
        share_quality: sq,
        // admin-shell.js decoratePoolIdentity() reads these two to prime its explorer links and
        // the testnet pill. `network` was read there but never sent until 2026-09-24, so the
        // admin panel assumed mainnet on every pool. Both are already public (pool-info).
        network: config.network || 'mainnet',
        explorer: currentExplorerKey(),
        // Stratum intake (design §21.9): { accepting, paused_since, resumes_at, planned }, ISO Z.
        // While paused, hashrate simply drops — this says why.
        stratum: stratumPause ? stratumPause.publicStatus() : null
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Public service-health summary for the homepage status strip. Deliberately coarse —
  // up/down + node peer count + sync flag only. NEVER exposes wallet balances or addresses
  // (those stay on the admin-only /api/admin/health/* endpoints).
  //
  // SERVER-SIDE cached, 15 s, with in-flight dedup. It used to set `Cache-Control: max-age=15`
  // and nothing else — a hint to the client, which costs an attacker one header to ignore and
  // which nothing on the box consults (audit §J12-2). Every hit made TWO upstream calls: the
  // node Owner API and the wallet Owner API (AES-GCM over the ECDH session). At the ~10 req/s
  // nginx allows from one host that is 10 node calls and 10 wallet calls a second from an
  // unauthenticated client — against the same singleton WalletAPI whose session the payout
  // path uses, and whose _call() re-runs initSession() on any session-shaped error. This is
  // the same reasoning /api/pool/poolstats already carries a 60 s cache for; that endpoint is
  // polled by one listing service, this one by every homepage visitor.
  const POOL_STATUS_TTL_MS = 15000;
  let _poolStatusCache = { at: 0, body: null };
  let _poolStatusInflight = null;
  const buildPoolStatus = async () => {
    const out = {
      pool: { ok: true },
      node: { reachable: false, state: 'offline', synced: false, peers: 0, height: 0, up_days: null },
      wallet: { reachable: false },
    };
    try {
      // getStatus() resolves (doesn't throw) with { ok: false } when the node is
      // unreachable — gate on status.ok, not the absence of an exception.
      const status = await blockMonitor.grinNode.getStatus();
      if (status && status.ok) {
        out.node = {
          reachable: true,
          state: 'ok',
          synced: status.synced === true,
          peers: status.peer_count || 0,
          height: status.header_height || 0,
          // Coarse uptime, an integer of whole UTC days or null — the ONLY uptime field in any
          // public response (design §20.5). No timestamp, no seconds, no class, no error text.
          up_days: nodeAvailability ? nodeAvailability.upDaysPublic(true) : null,
        };
      } else {
        // 'starting' | 'busy' | 'offline'. A node opening a rebuilt chain_data refuses the API
        // port for minutes, then times out while it catches up; both used to paint the lamp
        // red as "offline" while the process was healthy. reachable stays false either way —
        // this only chooses the colour, it never claims the node answered.
        out.node.state = await blockMonitor.grinNode.downState(status);
      }
    } catch (e) { /* node down → reachable stays false, state stays 'offline' */ }

    try {
      if (wallet && wallet.getBalance) {
        await wallet.getBalance();   // success = wallet API reachable; balance discarded
        out.wallet.reachable = true;
      }
    } catch (e) { /* wallet down → reachable stays false */ }

    return out;
  };

  router.get('/api/pool/status', rateLimiter.middleware('public'), async (req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=15');
    const now = Date.now();
    if (_poolStatusCache.body && (now - _poolStatusCache.at) < POOL_STATUS_TTL_MS) {
      return res.json(_poolStatusCache.body);
    }
    // Collapse concurrent misses onto one upstream pair. Without this a burst arriving on a
    // cold cache each fires its own node + wallet call before the first one can populate it —
    // the same trap torProbeCached and cachedGatewayStatus already guard against.
    if (!_poolStatusInflight) {
      _poolStatusInflight = buildPoolStatus()
        .then((body) => { _poolStatusCache = { at: Date.now(), body }; return body; })
        .catch(() => _poolStatusCache.body)   // buildPoolStatus swallows its own errors; belt and braces
        .then((body) => { _poolStatusInflight = null; return body; });
    }
    // Stale-while-revalidate: once ANY answer is cached, an expired one is served at once and
    // the rebuild above runs in the background. A rebuild is a node call plus a wallet Owner-API
    // call, each with a 10 s timeout, and grin-wallet serialises owner calls behind its wallet
    // lock — so during a payout run retrieve_summary_info can sit until it times out. Awaiting
    // that here made every visitor whose request landed after the TTL wait for it, and the
    // homepage used to hold its other panels behind this response. Only a cold boot waits now.
    if (_poolStatusCache.body) {
      return res.json(_poolStatusCache.body);
    }
    try {
      const body = await _poolStatusInflight;
      // Last-good on a failed build, so a down node does not turn this back into a per-request
      // prober. `pool.ok` stays true either way — the pool API answered, which is what it means.
      res.json(body || { pool: { ok: true }, node: { reachable: false, state: 'offline', synced: false, peers: 0, height: 0, up_days: null }, wallet: { reachable: false } });
    } catch (err) {
      res.status(500).json({ error: 'status unavailable' });
    }
  });

  // Public pool-found blocks, newest first. Paginated (limit+offset) with an optional status
  // filter for the public blocks explorer. Response stays a plain array (back-compat with the
  // homepage recent-blocks table); callers detect the last page when fewer than `limit` return.
  router.get('/api/pool/blocks', rateLimiter.middleware('public'), (req, res) => {
    try {
      const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 500);
      const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
      const status = req.query.status;
      const valid = ['immature', 'confirmed', 'paid', 'orphaned'];
      // Explicit columns since 2026-07-28 (was `SELECT *`): `nonce` is the winning solution's
      // nonce and `id`/`created_at` are internal row bookkeeping — none of the three is read by
      // blocks.html or the reactor fuel-rods, and publishing the nonce serves no verifier (the
      // block hash already anchors the find on any chain explorer). Everything the two consumers
      // actually render is kept, including found_by and the luck pair.
      let sql = `SELECT height, hash, reward, status, found_by, found_at, confirmed_at,
                        network_difficulty, round_shares FROM blocks`;
      const params = [];
      // `matured` = confirmed OR paid. rewards.js flips confirmed→paid the moment it credits
      // the round, so a bare `status=confirmed` filter drops nearly every settled block — the
      // public explorer's "Matured" chip uses this instead. The raw values stay accepted.
      if (status === 'matured') sql += " WHERE status IN ('confirmed', 'paid')";
      else if (status && valid.includes(status)) { sql += ' WHERE status = ?'; params.push(status); }
      sql += ' ORDER BY height DESC LIMIT ? OFFSET ?';
      params.push(limit, offset);
      // found_by MASKED since 2026-09-02 (audit §J11-1). blocks.html already displayed only
      // shortAddr(found_by) — the full value went out solely in the row's `title` tooltip — but
      // this route is offset-paged with no upper bound over a table that is never pruned, so it
      // was the cheapest walk of every full address the pool has ever seen, and that walk is
      // what inverted the mask on `/api/pool/miners`, `/api/stratum/stats` and
      // `/api/pool/unclaimed`. Internal callers read `blocks` directly and are unaffected.
      const blocks = db.prepare(sql).all(...params).map((b) => ({
        ...b,
        found_by: maskAddr(b.found_by),
      }));
      res.json(blocks);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Durable block-history series for the public blocks.html deck (one fetch → all four charts:
  // luck trend, blocks-per-period columns, status doughnut, cumulative reward). Blocks are never
  // pruned, so ?range can be arbitrarily long. See BlockManager.getBlocksHistory.
  router.get('/api/pool/blocks/history', rateLimiter.middleware('public'), (req, res) => {
    try {
      const allowed = ['week', 'month', 'year', 'all'];
      const range = allowed.includes(req.query.range) ? req.query.range : 'month';
      res.json(blockManager ? blockManager.getBlocksHistory(range)
                            : { range, bucket_seconds: null, points: [], luck: [], status: { confirmed: 0, immature: 0, orphaned: 0 }, hours: null });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Balance distribution across accounts, richest first. Addresses are MASKED here (2026-07-28):
  // unmasked this was a public rich-list — a full address paired with a balance, sorted so the
  // largest balances come first, which is a targeting list, not transparency. The distribution
  // itself is legitimate pool-health data, and it survives masking intact; the address→balance
  // mapping does not, which is the point. No front-end consumes this endpoint (the leaderboards
  // use /api/stratum/top-miners and /api/pool/top-block-finders — hashrate and luck, not money).
  router.get('/api/pool/miners', rateLimiter.middleware('public'), (req, res) => {
    try {
      const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 500);
      const stmt = db.prepare(`
        SELECT grin_address, balance, is_online FROM miner_accounts
        ORDER BY balance DESC LIMIT ?
      `);
      const miners = stmt.all(limit).map((m) => ({
        grin_address: maskAddr(m.grin_address),
        balance: m.balance,
        is_online: m.is_online,
      }));
      res.json(miners);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Top block finders over a recent window (default 30 days) — the "lucky miners" leaderboard.
  // Blocks are never pruned (only raw shares are), so this window can be arbitrarily long.
  // Orphaned blocks don't count as a find; total_reward sums the landed rewards.
  router.get('/api/pool/top-block-finders', rateLimiter.middleware('public'), (req, res) => {
    try {
      const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 500, 1), 1000);
      const days = Math.min(parseInt(req.query.days || 30, 10) || 30, 3650);
      const cutoff = Math.floor(Date.now() / 1000) - days * 86400;
      // Orphans are read in the same pass but still never count as a find: every find/reward
      // aggregate is gated on status, the orphan count is its own column, and HAVING keeps a
      // miner whose only blocks were orphaned off the board (as the old WHERE did).
      // total_fees is NULL — not 0 — when no landed block in the window had its fees captured
      // (blocks.fees NULL = not captured), so the page can say "unknown" rather than "none".
      const rows = db.prepare(`
        SELECT found_by AS grin_address,
               SUM(CASE WHEN status != 'orphaned' THEN 1 ELSE 0 END) AS blocks_found,
               COALESCE(SUM(CASE WHEN status != 'orphaned' THEN reward END), 0) AS total_reward,
               SUM(CASE WHEN status != 'orphaned' THEN fees END) AS total_fees,
               SUM(CASE WHEN status = 'orphaned' THEN 1 ELSE 0 END) AS orphaned,
               MAX(CASE WHEN status != 'orphaned' THEN found_at END) AS last_found_at,
               MAX(CASE WHEN status != 'orphaned' THEN height END) AS last_height
        FROM blocks
        WHERE found_at > ?
        GROUP BY found_by
        HAVING blocks_found > 0
        ORDER BY blocks_found DESC, total_reward DESC
        LIMIT ?
      `).all(cutoff, limit);
      const total = db.prepare(
        "SELECT COUNT(*) AS n FROM blocks WHERE status != 'orphaned' AND found_at > ?").get(cutoff);
      // MASKED since 2026-09-02 (audit §J11-1). This is a full address paired with a lifetime
      // reward total and sorted descending — byte for byte the shape §C1 masked on
      // `/api/pool/miners`, published at ten times the row cap and over a 10-year window.
      res.json({
        days,
        total_blocks: total ? total.n : 0,
        top_finders: rows.map((r) => ({ ...r, grin_address: maskAddr(r.grin_address) })),
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });


  // Recent confirmed payouts (public payout teletype + payment-history table). Explicit column
  // list since 2026-07-28: `SELECT *` published the whole withdrawals row, which carries the
  // pool's operational internals — slate_id, tor_check_result, retry_count, next_retry_at,
  // cancel_reason, cancelled_by. Those describe how the pool's payout machinery and a miner's
  // wallet behaved, are read by nothing public, and read as a per-miner reliability record.
  // grin_address was FULL until 2026-09-02 (address-as-identity, and both consumers deep-linked
  // the row to /account-settings.html?addr=); it is MASKED now — see the note at the query —
  // and neither consumer links the row any more.
  //
  // `kernel_excess` — the payout's Tx ID, i.e. its on-chain kernel excess — was dropped from this
  // feed 2026-09-02 (audit §J11-2) and RE-PUBLISHED 2026-09-25 by operator decision, so
  // payment-history.html P-05 can carry a Tx ID column linking each payout to the chain explorer
  // (the 2miners-style public payments list). The operator accepted the cost: a masked address +
  // amount + time beside a kernel lets a chain analyst tag that kernel as this pool's payout, and
  // §J11-1 showed the 9+4 mask is invertible against any feed that still leaks a full address.
  // The mask below is therefore the ONLY thing standing between this feed and a full
  // address <-> kernel table — never unmask it. The per-address all-time history
  // (/api/account/:addr/withdrawals) stays ownership-gated.
  // The value is emitted only when it has a kernel excess's exact shape (33-byte compressed
  // commitment = 66 hex chars): it becomes an explorer href on a public page, so a malformed
  // wallet-log string must reach no one.
  const KERNEL_EXCESS_RE = /^[0-9a-f]{66}$/i;
  router.get('/api/pool/payments', rateLimiter.middleware('public'), (req, res) => {
    try {
      const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
      const stmt = db.prepare(`
        SELECT id, grin_address, amount, fee_charged, method, status,
               created_at, confirmed_at, kernel_excess
        FROM withdrawals WHERE status = 'confirmed'
        ORDER BY confirmed_at DESC LIMIT ?
      `);
      // MASKED since 2026-09-02 (audit §J11-1). Both consumers already truncated for display —
      // the homepage teletype calls truncAddr(), payment-history.html renders truncAddr() with
      // the full value in a `title` — so nothing on screen changes; what goes away is the
      // machine-readable full-address list behind them.
      // has_kernel_proof ("seen mined") stays beside the kernel and keeps its old meaning (any
      // non-empty kernel on record): the homepage teletype and the P-05 status badge read the
      // boolean, so a shape-rejected value hides the link without un-mining the row.
      // Operator revenue withdrawals are listed too (operator decision 2026-10-05: the pool's own
      // take is published beside the miners' payouts). Their grin_address is the 'pool_fee'
      // bucket, which masks to nonsense, and their destination is the operator's private wallet —
      // so neither is emitted: the row says `operator: true` and a fixed label instead.
      const payments = stmt.all(limit).map((p) => {
        const kernel = (typeof p.kernel_excess === 'string' && KERNEL_EXCESS_RE.test(p.kernel_excess))
          ? p.kernel_excess.toLowerCase() : null;
        const operator = p.grin_address === 'pool_fee';
        return {
          ...p, grin_address: operator ? 'Pool operator' : maskAddr(p.grin_address), operator,
          kernel_excess: kernel, has_kernel_proof: !!p.kernel_excess
        };
      });
      res.json(payments);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── Unclaimed / abandoned balances (public transparency) ───────────────────
  // A lost-and-found with a public audit trail: masked addresses of long-dormant balances with a
  // per-address disposal countdown (owner recognises their own → reclaims via the account page
  // BEFORE disposition), plus the historical disposition ledger (final sweeps into the prize
  // pool). Addresses are masked (grin1qxy…mn4p) so this is a reunification aid, not a targeting
  // list; the ownership gate independently protects reclaim. Returns { dormant, dispositions }.
  router.get('/api/pool/unclaimed', rateLimiter.middleware('public'), (req, res) => {
    try {
      if (!dormancyManager) return res.json({ dormant: { enabled: false, totals: { count: 0, amount: 0 }, list: [] }, dispositions: { totals: {}, batches: [] } });
      const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 200);
      res.json({
        dormant: dormancyManager.listDormant({ mask: true, limit }),
        dispositions: dormancyManager.history({ limit: 50 }),
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Pool-wide hashrate time-series (SUM across addresses per bucket) for the dashboard chart.
  router.get('/api/pool/hashrate/history', rateLimiter.middleware('public'), (req, res) => {
    try {
      const hours = Math.min(Math.max(parseInt(req.query.hours, 10) || 24, 1), 720);
      const series = hashrateTracker.getPoolHistory(hours);
      res.json({ hours, series });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Durable pool-wide trend series (hashrate · miners · earnings · payout) from pool_metrics_hourly.
  // One fetch feeds all three miners-stats.html charts; ?range selects span + bucket size.
  router.get('/api/pool/metrics/history', rateLimiter.middleware('public'), (req, res) => {
    try {
      const allowed = ['day', 'week', 'month', 'year', 'all'];
      const range = allowed.includes(req.query.range) ? req.query.range : 'day';
      res.json(hashrateTracker.getMetricsHistory(range));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Per-region (gateway) companion to /api/pool/metrics/history: durable miners/hashrate trend
  // per stratum region, for the "miners by gateway" chart. Same ?range vocabulary.
  router.get('/api/pool/metrics/history/regions', rateLimiter.middleware('public'), (req, res) => {
    try {
      const allowed = ['day', 'week', 'month', 'year', 'all'];
      const range = allowed.includes(req.query.range) ? req.query.range : 'day';
      const out = hashrateTracker.getRegionMetricsHistory(range);

      // Same k-anonymity floor as /api/pool/stats/regions (audit §J11-5), applied per POINT.
      // This route is the durable half: `?range=all` publishes the whole recorded history of
      // per-region miner counts, so suppressing only the live view would leave yesterday's
      // "sgn had 1 miner" permanently readable. Rules identical to the live route — zero stays
      // zero, hashrate is suppressed with the count (with one miner it IS that miner's rig),
      // and the whole thing is skipped for a single-region pool. Applied here rather than in
      // hashrate-tracker.js so admin/internal readers keep the true series.
      const kMinRegions = minBucket();
      let suppressedPoints = 0;
      if (Array.isArray(out.series) && out.series.length > 1) {
        for (const s of out.series) {
          for (const p of (s.points || [])) {
            if (p.miner_count > 0 && p.miner_count < kMinRegions) {
              p.miner_count = null;
              p.hashrate_gps = null;
              p.below_floor = true;
              suppressedPoints++;
            }
          }
        }
      }
      out.min_bucket = (Array.isArray(out.series) && out.series.length > 1) ? kMinRegions : null;
      out.suppressed_points = suppressedPoints;
      res.json(out);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Durable payments & transparency series (payouts · reward split · giveaways · donations · fee)
  // from the never-pruned withdrawals + balance_log tables. One fetch feeds the whole
  // payment-history.html ledger deck; ?range selects span + bucket size (totals stay lifetime).
  router.get('/api/pool/payments/history', rateLimiter.middleware('public'), (req, res) => {
    try {
      const allowed = ['day', 'week', 'month', 'year', 'all'];
      const range = allowed.includes(req.query.range) ? req.query.range : 'month';
      res.json(hashrateTracker.getPaymentsHistory(range));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Donor wall — design §16.6/§16.7 (Part 4, 2026-09-21). The league: every address with a
  // donation debit inside the ranking window, scored GRIN-in-window × loyalty multiplier
  // (distinct months with a debit, +P %/month, capped) and ranked; a capped "past donors"
  // strip for the ones with nothing in the window (a thank-you is not revoked because the
  // giving stopped — nothing is ever deleted); `totals` lifetime over EVERY donor. The whole
  // response is built by lib/donor-ledger.js donorWall() from the composite ledger read
  // (rollup day < H + raw ≥ H, so totals stay exact after raw rows prune; rolled days are
  // UTC-day aligned) — the route only supplies what the lib cannot know: the switch state,
  // the live rigs, and the mask.
  //
  // Names (design §18.7): the donor's own nickname, PRE-moderated — only an admin-approved,
  // unexpired name reaches a card (lib/donor-profiles.js publicProfiles, read inside donorWall);
  // `name` is null for everything but `shown`. No pending text, reject reason or decider ever
  // leaves this route (scripts/test-public-leakage.js §9, scripts/test-donor-league.js).
  // Banners (§18 Part 4): approved + unexpired, and only on league cards ranked ≤
  // donor_banner_slots — the slot rule lives in donorWall, not here.
  //
  // The live readings (rigs_donating, pct_min/pct_max, active_donors) are gated on
  // donationsActive(), the same predicate /api/account/:addr uses for its donation row: with the
  // operator's donation switch OFF a tagged share donates nothing, so every card reads `paused`
  // and nobody counts as currently donating, rather than the wall advertising cuts that are not
  // being taken.
  router.get('/api/pool/donors', rateLimiter.middleware('public'), (req, res) => {
    try {
      let active = false;
      try { active = !!(incentivesManager && incentivesManager.donationsActive()); } catch (_) { active = false; }
      const ds = donorSettings(poolSettings.getSection('incentives'), poolSettings.getSection('pool_info').pool_name);

      // Rigs online / donating per address — ONE pass over the live sessions, not a shares
      // query per card. liveDonations() counts MINING sessions only (acceptedShares > 0, audit
      // §J6-9) by distinct worker name, and reads each rig's tag with the parser rewards.js
      // uses per share (design §18.3) — the same reading the account page and admin list get.
      const live = donorLiveDonations(minerManager ? minerManager.getActiveSessions() : []);

      // `address` MASKED (audit §J11-1) — the mask is a REQUIRED argument of donorWall and is
      // applied inside it to both arrays, so `past` cannot be the list a later edit forgets.
      res.json(donorWall(db, {
        ds,
        H: getLedgerRollupHorizon(db), // 0 = no rollup yet → whole ledger is raw
        active,
        live,
        mask: (a) => maskAddr(a)
      }));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Public prize-pool transparency report: current balance + lifetime in/out totals broken down by
  // source (fee-cut · donations · operator top-ups · ABANDONED BALANCES · orphan clawbacks in;
  // prizes · jackpots · join bonuses · streaks out). Composite read over the
  // ledger-rollup horizon, so totals stay exact after raw balance_log rows prune. Incentives-gated:
  // when incentives are off the bucket still exists (abandoned sweeps can accumulate), so the report
  // is always available — it's a trust surface.
  //
  // LIFETIME TOTALS ONLY — `prizePoolStatement(0)` deliberately returns an EMPTY `recent[]`.
  // Per-event rows are safe in content (a prize-pool row's grin_address is always 'prize_pool',
  // never a miner's), but their timestamps expose the DATE AND SIZE OF EACH OPERATOR TOP-UP.
  // Top-ups are discretionary promotion spend on no fixed schedule, so publishing a per-event
  // cadence invites a "the pool stopped funding prizes" reading of what is just a quiet month.
  // The lifetime total stays public — it is the point of the page. The admin endpoint
  // (/api/admin/incentives/prize-pool) still requests the detail rows; only this public one drops
  // them. Raise the argument above 0 only as a deliberate disclosure decision, and render what you
  // expose — donate.html D-05 draws in.by/out.by only.
  router.get('/api/pool/prize-pool', rateLimiter.middleware('public'), (req, res) => {
    try {
      if (!incentivesManager) return res.json({ enabled: false, balance: 0, in: { total: 0, by: [] }, out: { total: 0, by: [] }, net: 0, recent: [] });
      const st = incentivesManager.prizePoolStatement(0);
      let enabled = false;
      try { enabled = incentivesManager.enabled(); } catch (_) { /* default false */ }
      res.json({ enabled, ...st });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });


  // Network share / luck / round effort / time-since-last-block — pool-trust signals.
  //  · network_share_pct = pool 1h GPS / live network GPS × 100 (how often this pool wins)
  //  · round_effort_pct  = Σ(share diff since last block) / current per-block network diff × 100
  //  · luck_100_pct      = mean over last 100 blocks of (round_shares / network_difficulty) × 100
  //    (UNDER 100% = luckier than expected; uses captured per-block columns, NULL rows skipped)
  //
  //    This ratio used to be the other way up here, which made "luck" mean the OPPOSITE of
  //    what it means everywhere else on the same site: BlockManager.getBlocksHistory and both
  //    blocks tables compute shares ÷ difficulty (the 2miners convention, and the one the
  //    public blocks page spells out in prose), so one page rendered "luck 87%" as a good
  //    round while the dashboard rendered "luck 87%" as a bad one. One convention, and it is
  //    the documented one.
  // Current network difficulty is cached ~60s to avoid hammering the node.
  //
  // MEMOISED 30 s. The network-difficulty half below was already cached for 60 s so a poll
  // could not hammer the node; the SHARE SUM next to it was not, and it is the expensive half
  // (audit §J12-7). Its inputs move no faster than a block, so a per-request rebuild bought
  // nothing.
  const EFFORT_TTL_MS = 30000;
  // Ceiling on how far back the round window may reach. `lastBlockAt` is null until this pool
  // finds its FIRST block, and the old `lastBlockAt || 0` turned that into `created_at > 0` —
  // a sum over the entire shares table, on every request, on a public endpoint the homepage
  // polls. That is launch day, and it is also any long dry spell on a small pool. 7 days is
  // well past the PPLNS/confirm retention horizon, so on a pool that HAS found a block the
  // floor never binds and the figure is unchanged.
  const EFFORT_WINDOW_MAX_S = 7 * 86400;
  let _effortCache = { at: 0, body: null };
  router.get('/api/pool/effort', rateLimiter.middleware('public'), async (req, res) => {
    try {
      if (_effortCache.body && (Date.now() - _effortCache.at) < EFFORT_TTL_MS) {
        return res.json(_effortCache.body);
      }
      const last = blockManager.getLastBlock();
      const lastBlockAt = last ? last.found_at : null;
      const now = Math.floor(Date.now() / 1000);
      // Floor, never 0. `round_window_capped` tells the page that the effort figure is measured
      // from the floor rather than from a real block, so a brand-new pool's number is honest.
      const roundFrom = Math.max(lastBlockAt || 0, now - EFFORT_WINDOW_MAX_S);

      // Cached current per-block network difficulty.
      if (!app.locals._netDiffCache || (Date.now() - app.locals._netDiffCache.at) > 60000) {
        let netDiff = null;
        try {
          if (blockMonitor && blockMonitor.grinNode) {
            const tip = await blockMonitor.grinNode.getTip();
            netDiff = await blockManager._fetchNetworkDifficulty(tip.height);
          }
        } catch (_) { /* leave null */ }
        app.locals._netDiffCache = { at: Date.now(), value: netDiff };
      }
      const netDiff = app.locals._netDiffCache.value;

      // Sum AND count from the one scan. The sum is in chain units (each accepted share is
      // credited job target × C32 graph weight, stratum-protocol.js), so it is ~16384× the
      // share count — a page that labels it "shares" is off by that factor. The count is what
      // a miner can check against their own rig's accepted tally.
      const roundRow = db.prepare(
        'SELECT COALESCE(SUM(difficulty), 0) AS d, COUNT(*) AS n FROM shares WHERE created_at > ?'
      ).get(roundFrom);
      const roundDiff = roundRow.d;
      const roundShareCount = roundRow.n;

      const roundEffortPct = (netDiff && netDiff > 0)
        ? parseFloat(((roundDiff / netDiff) * 100).toFixed(2)) : null;

      // Pool's share of the live network hashrate — how often this pool wins blocks.
      // Both hashrates use the same C32 constants, so the ratio is the honest share.
      // Network GPS uses the 60s block target (no per-block timestamp here):
      //   GPS = diff × 42 / 60 / 16384   (see CLAUDE.md hashrate formula)
      const networkGps = (netDiff && netDiff > 0)
        ? (netDiff * 42) / 60 / 16384 : null;
      let poolGps = null;
      try { poolGps = hashrateTracker.getHashrateStats().pool_hashrate_1h_gps || 0; } catch (_) { /* null */ }
      const networkSharePct = (networkGps && networkGps > 0 && poolGps != null)
        ? parseFloat(((poolGps / networkGps) * 100).toFixed(2)) : null;

      const luckRows = db.prepare(
        `SELECT network_difficulty AS nd, round_shares AS rs FROM blocks
         WHERE network_difficulty IS NOT NULL AND round_shares > 0
         ORDER BY height DESC LIMIT 100`
      ).all();
      let luckPct = null;
      if (luckRows.length > 0) {
        const mean = luckRows.reduce((a, r) => a + (r.rs / r.nd), 0) / luckRows.length;
        luckPct = parseFloat((mean * 100).toFixed(1));
      }

      const body = {
        last_block_at: lastBlockAt,
        seconds_since_last_block: lastBlockAt ? (now - lastBlockAt) : null,
        round_shares: parseFloat(roundDiff.toFixed(6)),
        round_share_count: roundShareCount,
        round_window_from: roundFrom,
        round_window_capped: roundFrom > (lastBlockAt || 0),
        network_difficulty: netDiff,
        round_effort_pct: roundEffortPct,
        network_hashrate_gps: networkGps != null ? parseFloat(networkGps.toFixed(6)) : null,
        network_share_pct: networkSharePct,
        luck_100_pct: luckPct,
        luck_sample: luckRows.length
      };
      _effortCache = { at: Date.now(), body };
      res.json(body);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── miningpoolstats.stream listing feed ────────────────────────────────────────────────────
  // The PULL half of the MPS integration: they poll this, we push nothing. Shape is a
  // field-for-field mirror of the SOLO feed (poolstats_<net>.json, built by
  // lib/07_mining_block_collector.py build_poolstats) — deliberately, because MPS already has a
  // working importer for that structure. A "better" shape would cost them a new adapter for a
  // small coin, which is how a listing request gets declined. If the two ever have to diverge,
  // add fields, never rename or drop one.
  //
  // Solo writes a static file on a 5-min cron because it has no backend; here the data is already
  // live in-process, so a route needs no cron, no state dir and no auth carve-out. If MPS insists
  // on a .json path, alias it in nginx rather than writing a file.
  //
  // Aggregates only — no address, no per-miner row, nothing that isn't already on the public
  // homepage. Safe to serve unauthenticated.
  router.get('/api/pool/poolstats', rateLimiter.middleware('public'), async (req, res) => {
    try {
      // 60s cache: MPS polls on a fixed interval and this is a public GET that touches the node
      // and the DB, so an uncached version is a free amplification handle (same reasoning as
      // getPoolHistory in lib/hashrate-tracker.js). Serve last-good on error rather than a
      // half-empty feed — a delisting-grade blank is worse than a slightly stale number.
      const cached = app.locals._poolstatsFeed;
      if (cached && (Date.now() - cached.at) < 60000) return res.json(cached.body);

      const now = Math.floor(Date.now() / 1000);
      const blockStats = blockManager.getPoolStats() || {};
      const sstats = stratumServer.getStats() || {};

      // NOT blockManager.getLastBlock() — that returns the highest height REGARDLESS of status,
      // so a freshly orphaned block would be published as "last block found". blocks_24h already
      // excludes orphans (blocks.js getPoolStats), so using it here would also make the feed
      // self-contradictory: "0 blocks in 24h" next to a last_block from ten minutes ago.
      let last = null;
      try {
        last = db.prepare(
          `SELECT height, found_at FROM blocks WHERE status != 'orphaned' ORDER BY height DESC LIMIT 1`
        ).get() || null;
      } catch (_) { /* leave null */ }

      let poolGps = null;
      try { poolGps = hashrateTracker.getHashrateStats().pool_hashrate_1h_gps || 0; } catch (_) { /* null */ }

      // Node tip: height + CUMULATIVE total_difficulty (solo's `network.difficulty` is the
      // cumulative field; `difficulty_per_block` below is the per-block one — don't swap them).
      let height = null, totalDiff = null, peers = null;
      try {
        const status = await blockMonitor.grinNode.getStatus();
        if (status && status.ok) {
          height = status.header_height || 0;
          totalDiff = status.total_difficulty != null ? status.total_difficulty : null;
          peers = status.peer_count || 0;
        }
      } catch (_) { /* leave null — a node blip must not blank the pool half */ }

      // Per-block difficulty reuses the /api/pool/effort 60s cache, so a poll costs no extra
      // node round-trip. GPS = diff × 42 / 60 / 16384 (CLAUDE.md; 60s block target).
      let netDiffPb = null;
      if (app.locals._netDiffCache && (Date.now() - app.locals._netDiffCache.at) < 60000) {
        netDiffPb = app.locals._netDiffCache.value;
      } else {
        try {
          const tip = await blockMonitor.grinNode.getTip();
          netDiffPb = await blockManager._fetchNetworkDifficulty(tip.height);
          app.locals._netDiffCache = { at: Date.now(), value: netDiffPb };
        } catch (_) { /* leave null */ }
      }
      const netGps = (netDiffPb && netDiffPb > 0) ? (netDiffPb * 42) / 60 / 16384 : null;

      // Smooth 24h network figure from the durable hourly rollup (solo derives it from a
      // get_header look-back; we already sample it every hour, so no extra node calls).
      let netGps24h = null;
      try {
        const r = db.prepare(
          `SELECT AVG(network_hashrate_gps) AS g FROM pool_metrics_hourly
           WHERE bucket_start > ? AND network_hashrate_gps IS NOT NULL`
        ).get(now - 86400);
        if (r && r.g != null) netGps24h = parseFloat(r.g.toFixed(3));
      } catch (_) { /* leave null */ }

      const body = {
        ts: new Date(now * 1000).toISOString(),
        // Report the REAL network. A testnet pool must never be importable as a mainnet one.
        net: config.network === 'testnet' ? 'testnet' : 'mainnet',
        pool: {
          name: config.pool_name || 'Grin Pool',
          url: config.subdomain ? `https://${config.subdomain}` : '',
          hashrate: poolGps != null ? parseFloat(poolGps.toFixed(3)) : 0,
          hashrate_unit: 'gps',
          workers: sstats.active_connections || 0,
          miners: minerManager.getActiveMinersCount() || 0,
          fee: config.pool_fee_percent || 0,
          reward_model: config.reward_model || 'pplns',
          blocks_24h: blockStats.blocks_24h || 0,
          last_block: last ? { height: last.height, ts: new Date(last.found_at * 1000).toISOString() } : null,
        },
        network: {
          height,
          difficulty: totalDiff,
          difficulty_per_block: netDiffPb,
          hashrate_gps: netGps != null ? parseFloat(netGps.toFixed(3)) : null,
          hashrate_gps_24h: netGps24h,
          connections: peers,
        },
      };
      app.locals._poolstatsFeed = { at: Date.now(), body };
      res.json(body);
    } catch (err) {
      // Last-good, but BOUNDED. An unbounded fallback means a permanently broken backend keeps
      // serving a plausible-looking feed forever, and a listing that silently freezes is worse
      // than one that visibly errors — the operator never finds out. Past the grace window, fail
      // loudly and let MPS show the pool as down, which is the truth.
      const cached = app.locals._poolstatsFeed;
      if (cached && (Date.now() - cached.at) < 15 * 60 * 1000) return res.json(cached.body);
      res.status(500).json({ error: err.message });
    }
  });

  // ─── Multi-region public read APIs ──────────────────────────────────────────
  // Descriptive list of operator-declared regions (for a "connect to your nearest region"
  // UI). Only active rows + non-sensitive fields; the IP allowlist/secret are never exposed.
  router.get('/api/pool/locations', rateLimiter.middleware('public'), (req, res) => {
    try {
      const rows = db.prepare(
        `SELECT region, label, stratum_url, is_active FROM pool_locations
         WHERE is_active = 1 ORDER BY region ASC`
      ).all();
      res.json(rows.map(r => ({ region: r.region, label: r.label, stratum_url: r.stratum_url })));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── Network-map exposure gate (access.network_map_public, ON by default since 2026-09-13) ──
  // Guards the two feeds behind /network-map.html. Neither has ever returned an IP — peer IPs
  // never leave the DB and no coordinate is ever resolved: an aggregate marker sits on its
  // country's exact centroid (geoip.countryCentroid) and the country itself is published beside
  // it, so there is nothing for a scattered point to hide — but
  // both publish a per-country breakdown of who mines here / who this node peers with, and on
  // a small pool a country with one entry names one person. Disabled → 404 (not 403: a 403
  // confirms the feature exists and is merely switched off). network-map.js treats a failed
  // fetch as "not published": bare globe, zeroed placards, a note — no sample data (removed
  // 2026-09-13 after it was twice mistaken for the pool's real footprint).
  const networkMapPublic = () => {
    try {
      const a = poolSettings.getSection('access');
      return a.network_map_public === true || a.network_map_public === 'true';
    } catch (e) {
      return false; // settings unreadable → stay closed
    }
  };
  // k-anonymity floor for the country breakdowns when the feed IS enabled. Countries under
  // the threshold are merged into a single unnamed "Other" row rather than dropped, so the
  // published totals still add up.
  const minBucket = () => {
    try {
      // `|| 3` / `catch → 3` are NOT the default (that is 1, in PoolSettings.defaults): they
      // are the conservative floor for a value that is missing or garbage, fail-closed like
      // networkMapPublic() above. A readable default of 1 parses cleanly and never lands here.
      return Math.max(1, parseInt(poolSettings.getSection('access').network_map_min_bucket, 10) || 3);
    } catch (e) {
      return 3;
    }
  };
  // Operator-declared country of the central (hub) box, set in admin → Access. Most pools sit
  // behind a CDN, so the box cannot geo-locate itself — nothing but the operator knows where it
  // is. Blank falls through to the derivation chain in /api/pool/topology.
  const hubCountryCode = () => {
    try {
      const cc = String(poolSettings.getSection('access').hub_country_code || '').toUpperCase();
      return /^[A-Z]{2}$/.test(cc) ? cc : null;
    } catch (e) {
      return null;
    }
  };

  // ─── Network map: full pool topology (hub → gateways → miners-by-country) ───────────────
  // One call powers /network-map.html. Everything is aggregate + privacy-clean:
  //   · gateways — pool_locations + live share window + WireGuard liveness → status
  //     'connected' (up + miners) | 'handshake' (up, no miners) | 'offline' (tunnel down).
  //   · countries — LIVE stratum sessions (accurate online set + the region each connects
  //     through) crossed with miner_geo (COUNTRY ONLY, from lib/geoip at first accepted share).
  //     Each country is assigned to the gateway most of its miners route through. When
  //     geoip-lite isn't installed (miner_geo empty) we fall back to the GATEWAY's country so
  //     the map still renders; geo_source reports which path was taken.
  //   · positions are COUNTRY CENTROIDS (geoip.countryCentroid) — every marker here is an
  //     aggregate whose country is published in this same payload, so scattering the point
  //     would hide nothing and could only land the dot in the wrong country. The map draws
  //     miner countries as a filled polygon; the centroid is just the label/hover anchor.
  //     Exact per-miner coordinates are never resolved or stored — country is all we hold.
  //     ONE exception, since 2026-09-21: a GATEWAY carries the operator-declared lat/lng
  //     from its pool_locations row when set. A gateway is the pool's own published server,
  //     not a person — its stratum hostname is on the connect grid and geolocatable by
  //     anyone — and the centroid rule drew "Los Angeles" and "New York" 140 km apart in
  //     Kansas, which reads as a broken map, not as privacy. Blank → centroid, as before.
  //
  // MEMOISED 30 s (audit §J12-9). The expensive OUTBOUND parts were already kept out of the
  // request path — cachedGatewayStatus (15 s + running flag) and refreshStratumProbes (60 s +
  // running flag) — but the DB half was not: the 15-minute share aggregate below plans as
  // `SCAN shares USING INDEX idx_share_region | USE TEMP B-TREE FOR count(DISTINCT)`, a full
  // index scan, because `created_at > ?` sits on the SECOND column of idx_share_region and
  // cannot seek. Its inputs move on a 15-minute window, so a per-request rebuild bought
  // nothing. No cache key: the response has no per-caller component.
  const TOPOLOGY_TTL_MS = 30000;
  router.get('/api/pool/topology', rateLimiter.middleware('public'), async (req, res) => {
    try {
      if (!networkMapPublic()) return res.status(404).json({ error: 'not_found' });
      if (caches.topology.body && (Date.now() - caches.topology.at) < TOPOLOGY_TTL_MS) {
        return res.json(caches.topology.body);
      }
      const WINDOW_S = 900, OFFLINE_S = 600, CYCLE = 42, SOL = 16384;
      const nowS = Math.floor(Date.now() / 1000), cutoff = nowS - WINDOW_S;

      // Two views of the same table, on purpose:
      //   locationsAll — every row. Used ONLY to look up which country a region sits in, for
      //     miners whose own country we can't resolve, and for the hub's location. Both are
      //     facts about where a box IS, which don't stop being true when a row is unpublished.
      //   locations    — is_active = 1 only, the same filter the public connect UI applies
      //     (reactor-dashboard.js). A deactivated row (or one seeded ahead of the gateway
      //     actually being built) is not a place this pool runs, so it must not put a marker on
      //     the public globe: unfiltered it drew as a red "offline" gateway, which reads as a
      //     broken pool rather than an unused row. Also what the stratum probe works from —
      //     no point dialling an endpoint nobody is being sent to.
      const locationsAll = db.prepare(
        `SELECT region, label, country, country_code, stratum_url, is_active, lat, lng FROM pool_locations`
      ).all();
      const locations = locationsAll.filter(l => l.is_active === 1 || l.is_active === true);
      const locAllByRegion = new Map(locationsAll.map(l => [l.region, l]));
      // Upper bound load-bearing: one-sided, `GROUP BY region` walked all of idx_share_region
      // (region, created_at) — a range on its SECOND column cannot seek — i.e. the whole retained
      // table per call of a PUBLIC route. scripts/test-shares-plans.js.
      const agg = db.prepare(
        `SELECT region, COUNT(DISTINCT grin_address) AS miners, COALESCE(SUM(difficulty),0) AS sumdiff,
                MAX(created_at) AS last_share
         FROM shares WHERE created_at > ? AND created_at <= ? GROUP BY region`
      ).all(cutoff, nowS);
      const byRegion = new Map(agg.map(r => [r.region, r]));

      const wgSnapshot = cachedGatewayStatus();
      const wgByRegion = wgSnapshot.regions || {};
      refreshStratumProbes(locations);
      const localRegion = (config && config.role === 'singlebox') ? config.region : null;
      // Public gateway state — the SAME signal precedence as /api/pool/stats/regions (shares →
      // local box → WireGuard peer → stratum dial; see the comment there), mapped to the
      // network-map states: connected = up + miners, handshake = up + no miners, offline,
      // checking = no verdict yet.
      const statusOf = (region, hasMiners, shareAge, hasTarget) => {
        const sharesFresh = shareAge !== null && shareAge < OFFLINE_S;
        const verdict = stratumVerdict(region);
        let up;
        if (sharesFresh) up = true;
        else if (region === localRegion) up = true;
        else if (wgSnapshot.available && wgByRegion[region]) {
          const wg = wgByRegion[region];
          up = !!(wg.handshake && (nowS - wg.handshake) < OFFLINE_S) && verdict !== false;
        } else if (verdict === null) {
          if (!hasTarget) return hasMiners ? 'connected' : 'handshake';
          return 'checking';
        } else {
          up = verdict;
        }
        if (!up) return 'offline';
        return hasMiners ? 'connected' : 'handshake';
      };

      // Markers sit on the country centroid. `perCountry` counts how many we've already
      // placed in each country so the 2nd+ marker there (a second gateway, or the hub next
      // to a gateway) gets a small de-stack nudge instead of landing on the same pixel.
      // gwByRegion has a null prototype: region tags are operator-chosen strings, and on a plain
      // {} a region named 'constructor'/'toString' would answer truthy to the lookups below
      // without ever having been registered — the client would then be handed a gateway tag it
      // can't resolve to a position.
      const gateways = [], gwByRegion = Object.create(null), perCountry = {};
      const nudgeFor = (cc) => (cc ? (perCountry[cc] = (perCountry[cc] || 0) + 1) - 1 : 0);
      for (const loc of locations) {
        const a = byRegion.get(loc.region) || { miners: 0, sumdiff: 0, last_share: 0 };
        const shareAge = a.last_share ? (nowS - a.last_share) : null;
        const status = statusOf(loc.region, a.miners > 0, shareAge, !!loc.stratum_url);
        const gps = (a.sumdiff * CYCLE) / (WINDOW_S * SOL);
        // Declared position wins and does NOT take a nudge slot: the de-stack ring exists only
        // for markers that would otherwise share the centroid pixel, and a pinned gateway isn't
        // there. (Both columns are set together or not at all — POST /api/admin/locations
        // enforces the pair — so a lone value never reaches here; the guard is belt-and-braces.)
        const pinned = Number.isFinite(loc.lat) && Number.isFinite(loc.lng);
        const pos = pinned ? { lat: loc.lat, lng: loc.lng }
                           : geoip.countryCentroid(loc.country_code, nudgeFor(loc.country_code));
        const g = {
          region: loc.region, label: loc.label || loc.region,
          country: loc.country || (loc.country_code ? geoip.countryName(loc.country_code) : null),
          country_code: loc.country_code || null,
          status, online: status !== 'offline', miners: a.miners,
          hashrate_gps: parseFloat(gps.toFixed(6)),
          lat: pos ? pos.lat : null, lng: pos ? pos.lng : null
        };
        gateways.push(g); gwByRegion[loc.region] = g;
      }

      // Miners by country from live sessions × miner_geo (with gateway-country fallback).
      const sessions = minerManager.getActiveSessions();
      const addrRegion = new Map();
      for (const s of sessions) if (!addrRegion.has(s.grinAddress)) addrRegion.set(s.grinAddress, s.region);
      const addrs = [...addrRegion.keys()];
      const geoByAddr = new Map();
      if (addrs.length) {
        const rows = db.prepare(
          `SELECT grin_address, country_code, country FROM miner_geo
           WHERE grin_address IN (${addrs.map(() => '?').join(',')})`
        ).all(...addrs);
        rows.forEach(r => geoByAddr.set(r.grin_address, r));
      }
      const countries = new Map();
      let geoHits = 0;
      for (const [addr, region] of addrRegion) {
        let cc = null, name = null;
        const g = geoByAddr.get(addr);
        if (g && g.country_code) { cc = g.country_code; name = geoip.countryName(cc); geoHits++; }
        // Fallback from locationsAll, NOT from the published gateway list: a miner connected
        // through a region the operator has since unpublished still mines from the country that
        // region is in, and dropping them here would quietly shrink the miner total.
        else {
          const loc = locAllByRegion.get(region);
          if (loc && loc.country_code) { cc = loc.country_code; name = loc.country || geoip.countryName(cc); }
        }
        if (!cc) continue;
        let c = countries.get(cc);
        if (!c) { c = { cc, name: name || geoip.countryName(cc), miners: 0, votes: {} }; countries.set(cc, c); }
        c.miners++; c.votes[region] = (c.votes[region] || 0) + 1;
      }
      // k-anonymity: countries below the floor are merged into one unnamed "Other" row (no
      // country_code, no coordinates) so the miner total stays truthful without naming a
      // country that holds a single miner.
      const kMin = minBucket();
      const named = [], thin = [];
      for (const c of countries.values()) (c.miners >= kMin ? named : thin).push(c);
      const countryList = named.map(c => {
        const topRegion = Object.entries(c.votes).sort((a, b) => b[1] - a[1])[0][0];
        // Only name the region if it is a PUBLISHED gateway — the client resolves this string
        // against the gateways it was given, and an unresolvable one made it draw the arc to
        // whichever gateway happened to be first. null = "we're not saying", and the client
        // arcs to the hub instead of to an unrelated city.
        const gw = gwByRegion[topRegion] ? topRegion : null;
        // Nudged off the same counter the gateways used: a gateway's own country almost
        // always has miners too, and an un-nudged marker would land on the exact pixel of
        // that gateway — the hit-test keeps the first match, so the miner tooltip would be
        // unreachable and the region→gateway arc would collapse to a zero-length spike.
        // The index is stable per country (= how many gateways precede it there).
        const pos = geoip.countryCentroid(c.cc, nudgeFor(c.cc));
        return {
          country_code: c.cc, country: c.name, miners: c.miners, gateway: gw,
          lat: pos ? pos.lat : null, lng: pos ? pos.lng : null
        };
      }).sort((a, b) => b.miners - a.miners);
      if (thin.length) {
        countryList.push({
          country_code: null, country: 'Other', gateway: null, lat: null, lng: null,
          miners: thin.reduce((s, c) => s + c.miners, 0), aggregated_countries: thin.length
        });
      }

      // Hub = this settlement core. Nothing on the box can discover its own country (it is
      // behind nginx, usually behind a CDN), so the location is operator-declared with a
      // derivation chain behind it, most authoritative first:
      //   1. access.hub_country_code   — admin → Access (the one field an operator can edit live)
      //   2. config.hub_country_code   — pool.json escape hatch (no UI, honoured if hand-set)
      //   3. config.region_country_code — Script 07 → 2) Configure ("where is THIS server?")
      //   4. this box's own PUBLISHED gateway card — singlebox role only (`localRegion`).
      //   5. this box's own pool_locations row — keyed on config.region, NOT gated on
      //      role === 'singlebox' like `localRegion` is: a 'hub' role still registers its own
      //      region via ensureLocalRegion(), and gating it here left the hub unlocated on
      //      every multi-region install.
      //   6. busiest ONLINE gateway → 7. any gateway with a country → 8. busiest miner country.
      // All eight can miss (fresh install, nothing configured, no miners). Then lat/lng go out
      // as null and the map DRAWS NO HUB — never a placeholder position (network-map.js keeps
      // no fallback coordinate: a wrong hub country is worse than an absent marker).
      // locationsAll, not locations: "where is this box" stays true whether or not the operator
      // publishes that region as a place to point a miner at.
      const localRow = locationsAll.find(l => l.region === config.region) || null;
      const rawHubCc = hubCountryCode()
        || config.hub_country_code
        || config.region_country_code
        || (localRegion && gwByRegion[localRegion] && gwByRegion[localRegion].country_code)
        || (localRow && localRow.country_code)
        || (gateways.filter(g => g.online).sort((a, b) => b.miners - a.miners)[0] || {}).country_code
        || (gateways.find(g => g.country_code) || {}).country_code
        || (countryList.find(c => c.country_code) || {}).country_code
        || null;
      // Normalise ONCE, at the end of the chain: only the admin field is validated on save, so
      // a hand-edited pool.json ('vn', 'Vietnam') or an old DB row could otherwise reach
      // countryCentroid() in a form it can't match and drop the marker without a word.
      const hubCc = /^[A-Z]{2}$/.test(String(rawHubCc || '').toUpperCase())
        ? String(rawHubCc).toUpperCase() : null;
      // Hub POSITION. When this box's own region is a published gateway (the hub also takes
      // stratum directly — e.g. region 'main' labelled "New York"), the hub IS that gateway's
      // box: it takes that gateway's position (operator pin, or its already-nudged centroid) and
      // the gateway is flagged `is_hub` so the client draws ONE marker and no hub→itself link.
      // Before 2026-09-26 the hub took its own centroid-ring slot instead — Kansas for a US box —
      // 1.6° from its own gateway, and every gateway link converged on a spot where nothing runs.
      // An unpublished own row still lends its pin. Either applies only when its country agrees
      // with hubCc: an explicit hub_country_code naming another country wins.
      const ownGw = gwByRegion[config.region] || null;
      const agrees = (cc) => !cc || String(cc).toUpperCase() === hubCc;
      let hubPos = null;
      if (hubCc && ownGw && ownGw.lat != null && agrees(ownGw.country_code)) {
        hubPos = { lat: ownGw.lat, lng: ownGw.lng };
        ownGw.is_hub = true;
      } else if (hubCc && localRow && Number.isFinite(localRow.lat) && Number.isFinite(localRow.lng)
                 && agrees(localRow.country_code)) {
        hubPos = { lat: localRow.lat, lng: localRow.lng };
      } else if (hubCc) {
        hubPos = geoip.countryCentroid(hubCc, nudgeFor(hubCc));
      }
      // Live pool name first: pool_info.pool_name is what the rest of the site renders, and it is
      // editable in admin, whereas pool.json's `pool_name` is frozen at install time ("My Grin
      // Pool") — reading that one labelled the hub marker with a name shown nowhere else.
      let hubLabel = null;
      try { hubLabel = poolSettings.getSection('pool_info').pool_name || null; } catch (_) {}
      const hub = {
        label: hubLabel || config.pool_name || config.name || 'Pool Hub',
        country_code: hubCc, country: hubCc ? geoip.countryName(hubCc) : null,
        lat: hubPos ? hubPos.lat : null, lng: hubPos ? hubPos.lng : null
      };

      const body = {
        hub, gateways, countries: countryList,
        totals: {
          // Distinct live miner addresses — the SAME set /api/pool/stats reports as
          // active_miners (both come from minerManager's active sessions), so the map's
          // placard can never disagree with the homepage. Deliberately not the sum of
          // countries[]: a miner whose country resolves to nothing at all (no geoip and a
          // region row with no country declared) is absent from that array but is still
          // mining, and summing it under-reported the pool.
          miners: addrRegion.size,
          gateways_up: gateways.filter(g => g.online).length,
          gateways_total: gateways.length,
          // True distinct-country count (thin ones are hidden by name, not by tally).
          countries: named.length + thin.length
        },
        geo_source: (geoip.available() && geoHits > 0) ? 'geoip' : 'gateway',
        timestamp: new Date().toISOString()
      };
      caches.topology = { at: Date.now(), body };
      res.json(body);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── Network map: Grin P2P peers by country (rolling window) ────────────────────────────
  // Aggregates network_peers (populated by the peer-snapshot collector — COUNTRY ONLY, no IPs;
  // live connections + each node's own peer store, see snapshotNetworkPeers) over the last
  // ?window days (default 30, max 90). Returns per-country counts (+ main/test split) and a
  // capped set of scattered-in-country twinkle points for the globe. Empty when geoip-lite
  // isn't installed or the node has no peers yet (page then shows no twinkles and says so).
  router.get('/api/network/peers', rateLimiter.middleware('public'), (req, res) => {
    try {
      if (!networkMapPublic()) return res.status(404).json({ error: 'not_found' });
      const days = Math.min(Math.max(parseInt(req.query.window, 10) || 30, 1), 90);
      const cutoff = Math.floor(Date.now() / 1000) - days * 86400;
      const allRows = db.prepare(`
        SELECT country_code, country, COUNT(*) AS peers,
               SUM(CASE WHEN net='main' THEN 1 ELSE 0 END) AS main,
               SUM(CASE WHEN net='test' THEN 1 ELSE 0 END) AS test
        FROM network_peers WHERE last_seen >= ? AND country_code IS NOT NULL
        GROUP BY country_code ORDER BY peers DESC`).all(cutoff);

      // k-anonymity floor. Applied BEFORE the twinkle points are built, not just to the
      // country list — a point is placed inside its own country, so emitting points for a
      // thin country would re-expose exactly what the floor is hiding.
      const kMin = minBucket();
      const rows = allRows.filter(r => r.peers >= kMin);
      const thinRows = allRows.filter(r => r.peers < kMin);

      // Country rows are aggregates → centroid (the map uses them as label anchors). Only the
      // twinkle points below are scattered, because there the spread IS the visual: many dots
      // means many nodes. Scatter half-extents are per-country (geoip COUNTRIES[].s).
      const countries = rows.map(r => {
        const pos = geoip.countryCentroid(r.country_code);
        // Name from the code, never the stored `country` column: that was written by an older
        // table and holds the bare code ("BY") for every country it lacked, for as long as the
        // row lives. Same for miner_geo in /api/pool/topology.
        return {
          country_code: r.country_code, country: geoip.countryName(r.country_code),
          peers: r.peers, main: r.main, test: r.test,
          lat: pos ? pos.lat : null, lng: pos ? pos.lng : null
        };
      });

      const totalPeers = rows.reduce((s, r) => s + r.peers, 0);
      const CAP = 220, points = [];
      for (const r of rows) {
        if (points.length >= CAP) break;
        const want = Math.max(1, Math.round(CAP * r.peers / (totalPeers || 1)));
        const mainWant = Math.round(want * (r.main / (r.peers || 1)));
        for (let i = 0; i < want && points.length < CAP; i++) {
          const pos = geoip.placeInCountry(r.country_code, `pt:${r.country_code}:${i}`);
          if (!pos) break;
          points.push({ lat: pos.lat, lng: pos.lng, net: i < mainWant ? 'main' : 'test' });
        }
      }

      // Thin countries survive as one unnamed bucket so the published totals stay truthful.
      if (thinRows.length) {
        countries.push({
          country_code: null, country: 'Other', lat: null, lng: null,
          peers: thinRows.reduce((s, r) => s + r.peers, 0),
          main: thinRows.reduce((s, r) => s + r.main, 0),
          test: thinRows.reduce((s, r) => s + r.test, 0),
          aggregated_countries: thinRows.length
        });
      }

      res.json({
        window_days: days,
        countries, points,
        // Whether the collector CAN produce sightings. snapshotNetworkPeers is a permanent
        // no-op without geoip-lite, so an empty `countries` means "install the package" on
        // one box and "wait 30 s" on another — network-map.js words its note from this flag
        // rather than promising data that will never arrive.
        geo_available: geoip.available(),
        // Which networks' nodes the sensor reads on this box (a node only peers within its own
        // network). Lets the page say "mainnet + testnet" or "mainnet only" from fact, not
        // from a zero it can't tell apart from "no testnet sightings yet".
        sources: { main: !!_peerSensorNets.main, test: !!_peerSensorNets.test },
        // Totals span ALL peers (including the ones folded into "Other") — the floor hides
        // which country a thin peer is in, not that it exists.
        totals: {
          peers: allRows.reduce((s, r) => s + r.peers, 0),
          main: allRows.reduce((s, r) => s + r.main, 0),
          test: allRows.reduce((s, r) => s + r.test, 0)
        },
        timestamp: new Date().toISOString()
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Per-region live stats. Hashrate is derived from accepted-share difficulty over a short
  // window using the canonical C32 formula (GPS = Σdiff × 42 / window_s / 16384 — matches
  // hashrate-tracker.js and CLAUDE.md), grouped by the `region` tag the central stratum
  // stamps on each share (per-region listener / Model C gateway). Per-region `status` is
  // 'online' (up + active miners) | 'idle' (up, no recent miners) | 'offline' (WireGuard
  // tunnel down / never handshaked); see regionStatus() below for the liveness rules.
  router.get('/api/pool/stats/regions', rateLimiter.middleware('public'), async (req, res) => {
    try {
      const WINDOW_S = 900;  // 15-minute window for "current" regional hashrate
      const OFFLINE_S = 600; // a WireGuard handshake older than this (or none at all) = gateway
                             // down. Aligned with /api/admin/health/gateways so the public pill
                             // and the admin health view never disagree about who is offline.
      const CYCLE_LENGTH = 42, SOLUTION_RATE = 16384;
      const nowS = Math.floor(Date.now() / 1000);
      const cutoff = nowS - WINDOW_S;

      // `workers` = distinct (address, rig) pairs — the same key the hourly rollup and
      // getWorkerBreakdown group on (NULL worker_name → 'default'), so the three agree.
      const agg = db.prepare(
        `SELECT region,
                COUNT(*) AS shares,
                COUNT(DISTINCT grin_address) AS miners,
                COUNT(DISTINCT grin_address || '|' || COALESCE(worker_name, 'default')) AS workers,
                COALESCE(SUM(difficulty), 0) AS sumdiff,
                MAX(created_at) AS last_share
         FROM shares WHERE created_at > ? AND created_at <= ? GROUP BY region`
      ).all(cutoff, nowS);   // upper bound load-bearing — see /api/pool/topology
      const byRegion = new Map(agg.map(r => [r.region, r]));

      const locations = db.prepare(
        `SELECT region, label, country, country_code, stratum_url, is_active FROM pool_locations`
      ).all();
      const locByRegion = new Map(locations.map(l => [l.region, l]));

      // Per-region tunnel liveness (Model C): WireGuard latest-handshake per gateway. Peers
      // carry PersistentKeepalive=25, so a healthy tunnel re-handshakes every ~25s regardless
      // of miner traffic — a handshake older than OFFLINE_S (or none at all) means the gateway
      // is genuinely DOWN, not merely quiet. Cached snapshot, never awaited in the request path.
      const wgSnapshot = cachedGatewayStatus();

      // Active reachability: TCP-dial each declared stratum_url in the BACKGROUND. This is the
      // only signal that covers a region with no WireGuard peer at all — a declared/seeded
      // endpoint pointing at nothing (never paired, DNS not up, gateway not built) used to read
      // as 'idle' blue, i.e. "ready, just quiet", when a miner pointing a rig there gets a
      // refused connection. Kicked here, read from cache; the first hit after boot legitimately
      // has no verdict and reports 'checking'.
      refreshStratumProbes(locations);

      // The LOCAL/singlebox region has no WG peer (it IS the box); this API answering proves
      // the box is alive, so it is never marked offline (its public host may also be
      // un-dialable from itself behind hairpin NAT, so the probe is not trusted to fail it).
      const localRegion = (config && config.role === 'singlebox') ? config.region : null;

      // Four honest public states for a miner choosing where to point their rig:
      //   online   — reachable AND ≥1 share in the window (miners active here right now)
      //   idle     — reachable, no recent miners (perfectly fine to connect, just quiet)
      //   offline  — tunnel down / nothing listening (don't bother — you can't mine here)
      //   checking — no verdict yet (first poll after a restart); say so, never guess 'idle'
      // Signal precedence, strongest first:
      //   ① recent shares — financial-grade proof miners ARE mining through this region; wins
      //      over everything, so a handshake/probe blip can never flip an actively-mined
      //      region red while its own card still shows miners > 0.
      //   ② the local box — see above.
      //   ③ a declared WireGuard peer — for a Model C gateway the tunnel IS the path; a stale
      //      handshake means down even if its public port still answers (HAProxy up, no route
      //      home). A fresh handshake is still overruled by a CONFIRMED dead public port.
      //   ④ otherwise the stratum dial — covers every region wg cannot speak for.
      // The rules live in publicRegionStatus() (module level), shared with /api/pool/connect/suggest.
      const statusCtx = { localRegion, wgSnapshot, nowS, offlineS: OFFLINE_S };
      const regionStatus = (region, hasShares, shareAge, hasTarget) =>
        publicRegionStatus(region, hasShares, shareAge, hasTarget, statusCtx);

      // Union of regions seen in shares and regions declared in pool_locations.
      const regions = new Set([...byRegion.keys(), ...locByRegion.keys()]);
      const out = [];
      let totalGps = 0, totalMiners = 0, totalWorkers = 0, totalShares = 0, checking = 0;
      for (const region of regions) {
        const a = byRegion.get(region) || { shares: 0, miners: 0, workers: 0, sumdiff: 0, last_share: 0 };
        const loc = locByRegion.get(region) || {};
        const gps = (a.sumdiff * CYCLE_LENGTH) / (WINDOW_S * SOLUTION_RATE);
        totalGps += gps; totalMiners += a.miners; totalWorkers += a.workers; totalShares += a.shares;
        const shareAge = a.last_share ? (nowS - a.last_share) : null;
        const status = regionStatus(region, a.shares > 0, shareAge, !!loc.stratum_url);
        if (status === 'checking') checking++;
        out.push({
          region,
          label: loc.label || null,
          country: loc.country || null,
          country_code: loc.country_code || null,
          stratum_url: loc.stratum_url || null,
          is_active: loc.is_active === undefined ? null : !!loc.is_active,
          status,                       // 'online' | 'idle' | 'offline' | 'checking'
          online: status !== 'offline', // reachable? (up regardless of miner count)
          // This box's own (singlebox) region = connecting DIRECT to the hub. The connect page's
          // latency estimate needs to know which row that is: every other region adds its
          // hub_rtt_ms leg on top of the viewer's. A 'hub' role runs no local stratum → no row.
          is_hub: region === localRegion,
          // ≈ one hub↔gateway RTT in integer ms: min of the last 5 successful TCP connects from
          // this box to the region's public stratum (lib/region-rtt.js). 0 for the hub row, null
          // with no sample. Feeds effective latency = viewer→gateway + gateway→hub.
          hub_rtt_ms: hubRttMs(stratumRttWindow(region), region === localRegion),
          hashrate_gps: parseFloat(gps.toFixed(6)),
          miners: a.miners,
          workers: a.workers,
          shares_window: a.shares
        });
      }
      out.sort((x, y) => y.hashrate_gps - x.hashrate_gps);

      // ── k-anonymity floor on the per-region counts (audit §J11-5, 2026-09-02) ──────────────
      // The same floor `/api/pool/topology` and `/api/network/peers` apply to their COUNTRY
      // breakdowns, applied here to the REGION breakdown — which had neither the floor nor the
      // network-map gate. Each region carries an operator-declared country, so on a multi-region
      // pool `{region:'sgn', country_code:'VN', miners:1}` is exactly the statement the floor
      // exists to prevent: one identifiable person mines near Vietnam. The admin helper text for
      // `network_map_min_bucket` says so in as many words.
      //
      // Three rules, each deliberate:
      //  1. Suppress only `0 < n < kMin`. **Zero stays zero** — "no miners here" identifies
      //     nobody and a gateway with none is exactly what a miner picking one needs to see.
      //     Nulling it would repeat §J5-4's mistake in reverse (a suppressed number read as a
      //     real one); here a real zero must not be read as suppressed.
      //  2. Suppress `hashrate_gps`, `shares_window` and `workers` alongside `miners`. With one
      //     miner in a region the hashrate IS that miner's rig size — more identifying than the
      //     count, and suppressing the count alone would have been security theatre. `workers`
      //     under the floor is that one person's rig count — the same disclosure.
      //  3. `status`/`online` are KEPT. They are one bit ("can I mine here?"), that bit is the
      //     entire point of the public connect grid, and a miner pointed at a dead gateway is a
      //     real harm. This is a stated residual, not an oversight: on a thin region 'online'
      //     still implies at least one miner.
      //
      // Skipped entirely when there is only ONE region: the region is then the pool, `totals`
      // already publishes the same number, and suppressing would blank the dashboard of every
      // single-box install for exactly zero privacy gain. Totals stay exact in both cases —
      // they are summed above, before any suppression, so the floor hides WHERE, never HOW MANY.
      const kMinRegions = minBucket();
      let suppressed = 0;
      if (out.length > 1) {
        for (const r of out) {
          if (r.miners > 0 && r.miners < kMinRegions) {
            r.miners = null;
            r.workers = null;
            r.hashrate_gps = null;
            r.shares_window = null;
            r.below_floor = true;
            suppressed++;
          }
        }
      }

      res.json({
        window_seconds: WINDOW_S,
        region_count: out.length,
        // > 0 means at least one region has no liveness verdict yet — the client should
        // repaint shortly instead of waiting out its normal poll interval.
        checking: checking,
        // Tells a client that some per-region numbers are withheld rather than zero, so it can
        // render "—" instead of inventing a 0. The threshold is published too: hiding the floor
        // itself buys nothing (it is in the admin UI and in this file) and an unexplained "—"
        // reads as a bug.
        min_bucket: out.length > 1 ? kMinRegions : null,
        suppressed_regions: suppressed,
        totals: {
          hashrate_gps: parseFloat(totalGps.toFixed(6)),
          miners: totalMiners,
          workers: totalWorkers,
          shares_window: totalShares
        },
        regions: out,
        timestamp: new Date().toISOString()
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // "Best server for you" on the connect page — the geographic ESTIMATE (lib/connect-suggest.js):
  // effective latency = viewer→gateway + gateway→hub, vs viewer→hub for connecting direct.
  // Per viewer, so never cacheable. PRIVACY: the IP is resolved to a COUNTRY for this one
  // computation and dropped — not stored, not logged, not echoed, and neither is the country; the
  // response carries only per-region milliseconds. No country (geoip-lite not installed, a private
  // or unknown address, a country with no centroid on file) → { basis: 'unavailable' } alone, and
  // the page keeps its timezone fallback.
  // Reads the same inputs as /api/pool/stats/regions — the published rows (active, with a
  // stratum_url), publicRegionStatus(), hub_rtt_ms, is_hub — so it can never recommend a region
  // the patch bay paints red. Positions are the operator-declared lat/lng where set (a server's
  // own public location), else the region's country centroid.
  router.get('/api/pool/connect/suggest', rateLimiter.middleware('public'), (req, res) => {
    res.setHeader('Cache-Control', 'private, no-store');
    try {
      const geo = geoip.available()
        ? geoip.lookupCountry(String(req.ip || '').replace('::ffff:', ''))
        : null;
      if (!geo || !geoip.countryCentroid(geo.cc)) return res.json({ basis: 'unavailable' });

      const OFFLINE_S = 600;  // same threshold as /api/pool/stats/regions
      const nowS = Math.floor(Date.now() / 1000);
      const locations = db.prepare(
        `SELECT region, country_code, stratum_url, is_active, lat, lng FROM pool_locations`
      ).all().filter((l) => l.stratum_url && (l.is_active === 1 || l.is_active === true));
      // Fresh shares are the strongest liveness signal (precedence ①); only the newest time is needed.
      const lastShare = new Map(db.prepare(
        `SELECT region, MAX(created_at) AS last_share FROM shares WHERE created_at > ? AND created_at <= ? GROUP BY region`
      ).all(nowS - OFFLINE_S, nowS).map((r) => [r.region, r.last_share]));   // upper bound load-bearing — see /api/pool/topology

      refreshStratumProbes(locations);
      const localRegion = (config && config.role === 'singlebox') ? config.region : null;
      const statusCtx = { localRegion, wgSnapshot: cachedGatewayStatus(), nowS, offlineS: OFFLINE_S };
      const regions = locations.map((l) => {
        const ls = lastShare.get(l.region);
        return {
          region: l.region,
          country_code: l.country_code || null,
          lat: l.lat, lng: l.lng,
          is_hub: l.region === localRegion,
          hub_rtt_ms: hubRttMs(stratumRttWindow(l.region), l.region === localRegion),
          status: publicRegionStatus(l.region, !!ls, ls ? nowS - ls : null, true, statusCtx),
        };
      });

      const { recommended, estimates } = connectSuggest.estimate({ viewerCc: geo.cc, regions });
      res.json({ basis: 'estimate', recommended, estimates });
    } catch (err) {
      res.status(500).json({ error: 'Failed to build a suggestion' });
    }
  });

  router.get('/api/stratum/hashrate', rateLimiter.middleware('public'), (req, res) => {
    try {
      const stats = hashrateTracker.getHashrateStats();
      // getHashrateStats() carries a `top_miners` array with FULL addresses (10 @ 1h). It is a
      // SEVENTH full-address feed — the one §J11-1's table missed, found while applying that
      // fix — and no consumer reads it: both callers (reactor-dashboard.js, miners-stats.html)
      // use only pool_hashrate_1h_gps. Masked rather than deleted so the documented response
      // shape stays stable for the third-party bots api-docs.html invites.
      // The poolstats reporter also calls getHashrateStats(), and it reads ONLY
      // pool_hashrate_1h_gps (poolstats-reporter.js collectStats) — so no address has ever
      // gone off-box to miningpoolstats.stream. Keep it that way.
      if (Array.isArray(stats.top_miners)) {
        stats.top_miners = stats.top_miners.map((m) => ({ ...m, grin_address: maskAddr(m.grin_address) }));
      }
      res.json(stats);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Top miners by hashrate over an arbitrary window (default 24h) — powers the paginated
  // leaderboard on miners-stats.html. Separate from /api/stratum/hashrate (fixed 10 @ 1h,
  // shared with the poolstats reporter) so we can serve a larger list without churning it.
  router.get('/api/stratum/top-miners', rateLimiter.middleware('public'), (req, res) => {
    try {
      const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 500, 1), 1000);
      const windowMinutes = Math.min(parseInt(req.query.window || 1440, 10) || 1440, 1440);
      // MASKED since 2026-09-02 (audit §J11-1). The tracker keeps the full address for internal
      // callers; only this public projection truncates.
      // Explicit projection: the tracker row is internal and may grow. Rig COUNT only — worker
      // names are not published here (they are the miner's own labels, often hostnames).
      const miners = hashrateTracker.getTopMiners(limit, windowMinutes).map(m => ({
        grin_address: maskAddr(m.grin_address),
        hashrate_gps: parseFloat((m.avg_hashrate || 0).toFixed(6)),
        hashrate_1h_gps: m.hashrate_1h == null ? null : parseFloat(m.hashrate_1h.toFixed(6)),
        share_pct: parseFloat((m.share_pct || 0).toFixed(3)),
        shares: m.share_count || 0,
        rigs: m.rig_count || 0,
        last_share_at: m.last_share_at || null
      }));
      res.json({ window_minutes: windowMinutes, top_miners: miners });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Top miners by AVERAGE hashrate over a multi-day window (default 30 days) — the "sustained
  // contribution" leaderboard on miners-stats.html. Backed by hashrate_history (retained
  // database.hashrate_keep_days, default 100d), not the shares table (pruned ~1d on mainnet:
  // confirm_depth + PPLNS window), so the 90-day cap below stays inside real data.
  router.get('/api/stratum/top-avg-hashrate', rateLimiter.middleware('public'), (req, res) => {
    try {
      const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 500, 1), 1000);
      const days = Math.min(parseInt(req.query.days || 30, 10) || 30, 90);
      // MASKED since 2026-09-02 (audit §J11-1) — see /api/stratum/top-miners above.
      const miners = hashrateTracker.getTopAvgHashrate(days, limit)
        .map((m) => ({ ...m, grin_address: maskAddr(m.grin_address) }));
      res.json({ days, top_miners: miners });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
  return router;
};
