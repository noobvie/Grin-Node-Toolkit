const { getDb } = require('./db');
const { getHorizon } = require('./ledger-rollup');

class HashrateTracker {
  constructor(config, minerManager) {
    this.config = config;
    this.db = getDb();
    this.minerManager = minerManager;
    this.samplingInterval = 60000;
    this.isRunning = false;
  }

  start() {
    if (this.isRunning) return;

    this.isRunning = true;
    console.log(`[${new Date().toISOString()}] Hashrate tracker started`);

    this.trackingLoop();
  }

  async trackingLoop() {
    while (this.isRunning) {
      try {
        await this.recordHashrates();
        // Cheap + idempotent: only writes when a fresh completed hour exists (no-op otherwise).
        await this.rollupCompletedHours();
      } catch (err) {
        console.error(`[ERROR] Hashrate tracking error: ${err.message}`);
      }

      await this.sleep(this.samplingInterval);
    }
  }

  // Cuckatoo32 hashrate: GPS = Σ(share difficulty) × 42 / window_seconds / 16384
  // (matches CLAUDE.md and /api/pool/stats/regions). Derived from the SHARES table — real
  // accepted work — NOT from a static per-session difficulty.
  static CYCLE_LENGTH = 42;
  static SOLUTION_RATE = 16384;
  static HOUR = 3600;

  // Snapshot each active miner's hashrate over the last sampling window into hashrate_history
  // (time-series for charts). Computed from shares actually accepted in the window.
  recordHashrates() {
    try {
      const windowSeconds = this.samplingInterval / 1000;
      const cutoff = Math.floor(Date.now() / 1000) - windowSeconds;

      const rows = this.db.prepare(`
        SELECT grin_address, COALESCE(SUM(difficulty), 0) AS sumdiff
        FROM shares WHERE created_at > ? GROUP BY grin_address
      `).all(cutoff);

      const stmt = this.db.prepare(`
        INSERT INTO hashrate_history (grin_address, hashrate_gps, window_seconds)
        VALUES (?, ?, ?)
      `);
      const tx = this.db.transaction(() => {
        for (const r of rows) {
          const gps = (r.sumdiff * HashrateTracker.CYCLE_LENGTH) /
                      (windowSeconds * HashrateTracker.SOLUTION_RATE);
          stmt.run(r.grin_address, gps, windowSeconds);
        }
      });
      tx();

      return rows.length;
    } catch (err) {
      console.error(`Error recording hashrates: ${err.message}`);
      return 0;
    }
  }

  calculateHashrate(difficulty, windowSeconds = 60) {
    if (difficulty <= 0 || windowSeconds <= 0) return 0;
    return (difficulty * HashrateTracker.CYCLE_LENGTH) / (windowSeconds * HashrateTracker.SOLUTION_RATE);
  }

  // Pool-wide GPS over a window — computed directly from shares (not by summing the per-sample
  // history rows, which would multiply by the number of samples in the window).
  getPoolHashrate(windowMinutes = 1) {
    try {
      const windowSeconds = windowMinutes * 60;
      const cutoffTime = Math.floor(Date.now() / 1000) - windowSeconds;

      const row = this.db.prepare(`
        SELECT COALESCE(SUM(difficulty), 0) AS sumdiff FROM shares WHERE created_at > ?
      `).get(cutoffTime);

      return (row.sumdiff * HashrateTracker.CYCLE_LENGTH) / (windowSeconds * HashrateTracker.SOLUTION_RATE);
    } catch (err) {
      console.error(`Error calculating pool hashrate: ${err.message}`);
      return 0;
    }
  }

  // Per-miner average GPS over a window, derived from that miner's accepted shares. Shape
  // ({ avg_hashrate, max_hashrate }) is preserved for existing callers; max == avg here since
  // it's a single window aggregate.
  getMinerHashrate(minerAddress, windowMinutes = 1) {
    try {
      const windowSeconds = windowMinutes * 60;
      const cutoffTime = Math.floor(Date.now() / 1000) - windowSeconds;

      const row = this.db.prepare(`
        SELECT COALESCE(SUM(difficulty), 0) AS sumdiff
        FROM shares WHERE grin_address = ? AND created_at > ?
      `).get(minerAddress, cutoffTime);

      const gps = (row.sumdiff * HashrateTracker.CYCLE_LENGTH) / (windowSeconds * HashrateTracker.SOLUTION_RATE);
      return { avg_hashrate: gps, max_hashrate: gps };
    } catch (err) {
      console.error(`Error calculating miner hashrate: ${err.message}`);
      return { avg_hashrate: 0, max_hashrate: 0 };
    }
  }

  getTopMiners(limit = 10, windowMinutes = 1) {
    try {
      const windowSeconds = windowMinutes * 60;
      const cutoffTime = Math.floor(Date.now() / 1000) - windowSeconds;
      const factor = HashrateTracker.CYCLE_LENGTH / (windowSeconds * HashrateTracker.SOLUTION_RATE);

      const rows = this.db.prepare(`
        SELECT grin_address, COALESCE(SUM(difficulty), 0) AS sumdiff
        FROM shares WHERE created_at > ?
        GROUP BY grin_address
        ORDER BY sumdiff DESC
        LIMIT ?
      `).all(cutoffTime, limit);

      return rows.map(r => ({
        grin_address: r.grin_address,
        avg_hashrate: r.sumdiff * factor,
        max_hashrate: r.sumdiff * factor
      }));
    } catch (err) {
      console.error(`Error fetching top miners: ${err.message}`);
      return [];
    }
  }

  // Top miners by AVERAGE hashrate over a multi-day window, from the persistent hashrate_history
  // samples (retained ~30 days) — unlike getTopMiners (a short live snapshot off the shares table,
  // pruned after ~1 day). Each sample covers window_seconds of mining at hashrate_gps, so
  // SUM(gps × window_seconds) / totalWindowSeconds is the time-weighted average GPS across the
  // whole window (gaps count as zero), rewarding sustained mining rather than a peak burst.
  getTopAvgHashrate(days = 30, limit = 500) {
    try {
      const windowSeconds = days * 86400;
      const cutoffTime = Math.floor(Date.now() / 1000) - windowSeconds;

      const rows = this.db.prepare(`
        SELECT grin_address,
               COALESCE(SUM(hashrate_gps * window_seconds), 0) / ? AS avg_gps
        FROM hashrate_history
        WHERE recorded_at > ?
        GROUP BY grin_address
        ORDER BY avg_gps DESC
        LIMIT ?
      `).all(windowSeconds, cutoffTime, limit);

      return rows.map(r => ({
        grin_address: r.grin_address,
        avg_hashrate_gps: parseFloat((r.avg_gps || 0).toFixed(6))
      }));
    } catch (err) {
      console.error(`Error fetching top avg hashrate: ${err.message}`);
      return [];
    }
  }

  // Per-worker breakdown for one address. Hashrate + share count + last_share come from the
  // SHARES table (works across restarts and all regions); accepted/rejected/stale + online come
  // from the LIVE in-memory stratum sessions. Under Model C every region's miners terminate
  // their session on this box, so reject/stale is complete pool-wide. Workers seen in shares but
  // with no live session show online:false and null reject/stale.
  getWorkersForAccount(minerAddress, windowMinutes = 10) {
    try {
      const windowSeconds = windowMinutes * 60;
      const cutoff = Math.floor(Date.now() / 1000) - windowSeconds;
      const factor = HashrateTracker.CYCLE_LENGTH / (windowSeconds * HashrateTracker.SOLUTION_RATE);

      // worker_name may be NULL (default worker) — COALESCE so it groups under a stable label.
      const rows = this.db.prepare(`
        SELECT COALESCE(worker_name, 'default') AS worker_name,
               COALESCE(SUM(difficulty), 0) AS sumdiff,
               COUNT(*) AS share_count,
               MAX(created_at) AS last_share_at
        FROM shares
        WHERE grin_address = ? AND created_at > ?
        GROUP BY COALESCE(worker_name, 'default')
        ORDER BY sumdiff DESC
      `).all(minerAddress, cutoff);

      // Live session counters keyed by worker name.
      const liveByWorker = new Map();
      const sessions = this.minerManager.getSessionsByMiner
        ? this.minerManager.getSessionsByMiner(minerAddress)
        : [];
      for (const s of sessions) {
        const wn = s.workerName || 'default';
        const acc = liveByWorker.get(wn) || { accepted: 0, rejected: 0, stale: 0, online: true };
        acc.accepted += s.accepted || 0;
        acc.rejected += s.rejected || 0;
        acc.stale    += s.stale    || 0;
        liveByWorker.set(wn, acc);
      }

      const workers = rows.map(r => {
        const live = liveByWorker.get(r.worker_name);
        const out = {
          worker_name:  r.worker_name,
          hashrate_gps: parseFloat((r.sumdiff * factor).toFixed(6)),
          share_count:  r.share_count,
          last_share_at: r.last_share_at,
          online:       !!live,
          accepted:     live ? live.accepted : null,
          rejected:     live ? live.rejected : null,
          stale:        live ? live.stale : null
        };
        if (live) {
          const total = live.accepted + live.rejected + live.stale;
          out.reject_pct = total > 0 ? parseFloat(((live.rejected / total) * 100).toFixed(2)) : 0;
          out.stale_pct  = total > 0 ? parseFloat(((live.stale    / total) * 100).toFixed(2)) : 0;
        } else {
          out.reject_pct = null;
          out.stale_pct  = null;
        }
        if (live) liveByWorker.delete(r.worker_name);
        return out;
      });

      // Live workers connected but with no accepted share in the window yet → still list them.
      for (const [wn, live] of liveByWorker) {
        const total = live.accepted + live.rejected + live.stale;
        workers.push({
          worker_name:  wn,
          hashrate_gps: 0,
          share_count:  0,
          last_share_at: null,
          online:       true,
          accepted:     live.accepted,
          rejected:     live.rejected,
          stale:        live.stale,
          reject_pct:   total > 0 ? parseFloat(((live.rejected / total) * 100).toFixed(2)) : 0,
          stale_pct:    total > 0 ? parseFloat(((live.stale    / total) * 100).toFixed(2)) : 0
        });
      }

      return workers;
    } catch (err) {
      console.error(`Error building worker breakdown for ${minerAddress}: ${err.message}`);
      return [];
    }
  }

  // Time-series for one address — the per-minute samples recorded by recordHashrates(), thinned
  // to ~maxPoints evenly-spaced buckets for charting. Returns [{ t, gps }] oldest→newest.
  getAccountHistory(minerAddress, hours = 24, maxPoints = 288) {
    try {
      const cutoff = Math.floor(Date.now() / 1000) - hours * 3600;
      const rows = this.db.prepare(`
        SELECT recorded_at AS t, hashrate_gps AS gps
        FROM hashrate_history
        WHERE grin_address = ? AND recorded_at > ?
        ORDER BY recorded_at ASC
      `).all(minerAddress, cutoff);
      return HashrateTracker._thin(rows, maxPoints);
    } catch (err) {
      console.error(`Error fetching account history for ${minerAddress}: ${err.message}`);
      return [];
    }
  }

  // Pool-wide time-series — SUM across addresses per recorded_at bucket (the history table is
  // per-address, so the pool series is not pre-aggregated). Returns [{ t, gps }] oldest→newest.
  getPoolHistory(hours = 24, maxPoints = 288) {
    try {
      const cutoff = Math.floor(Date.now() / 1000) - hours * 3600;
      const rows = this.db.prepare(`
        SELECT recorded_at AS t, COALESCE(SUM(hashrate_gps), 0) AS gps
        FROM hashrate_history
        WHERE recorded_at > ?
        GROUP BY recorded_at
        ORDER BY recorded_at ASC
      `).all(cutoff);
      return HashrateTracker._thin(rows, maxPoints);
    } catch (err) {
      console.error(`Error fetching pool history: ${err.message}`);
      return [];
    }
  }

  // ── Durable pool-wide hourly rollup (pool_metrics_hourly) ─────────────────────────────────
  // Collapse every fully-completed hour that isn't rolled up yet into one aggregate row, computed
  // from shares (pool GPS + distinct miners), blocks (found + confirmed rewards) and withdrawals
  // (confirmed payouts) BEFORE those source tables prune. The table is NEVER pruned, so the public
  // trend charts have Day→All-Time history at ~1 MB/year (size independent of miner count).
  // Idempotent upsert (safe to re-run a bucket). No backfill: an empty table starts at the
  // just-completed hour. Called every tracking loop; a no-op on minutes with no new completed hour.
  async rollupCompletedHours() {
    try {
      const H = HashrateTracker.HOUR;
      const nowHour = Math.floor(Date.now() / 1000 / H) * H;   // start of the current (incomplete) hour
      const lastRow = this.db.prepare('SELECT MAX(bucket_start) AS b FROM pool_metrics_hourly').get();
      let start = (lastRow && lastRow.b != null) ? lastRow.b + H : nowHour - H;
      // Bound catch-up after a long outage — no backfill is wanted, and shares older than ~1 day are
      // already pruned, so skip ancient gaps straight to the just-completed hour.
      const MAX_HOURS = 1000;
      if (start < nowHour - MAX_HOURS * H) start = nowHour - H;
      if (start > nowHour - H) return 0; // no fully-completed hour to roll up yet

      // Network hashrate sample for the pool-vs-network trend (P-04). Fetched only when a
      // rollup will actually write (≤1 node round-trip per hour). Applied to the JUST-completed
      // hour only — catch-up buckets after an outage keep NULL rather than a wrong "now" value.
      let netGps = null;
      if (typeof this.networkGpsProvider === 'function') {
        try { netGps = await this.networkGpsProvider(); } catch (e) { netGps = null; }
        if (!(netGps > 0)) netGps = null;
      }

      const upsert = this.db.prepare(`
        INSERT INTO pool_metrics_hourly
          (bucket_start, pool_hashrate_gps, miner_count, blocks_found, earnings, payout, network_hashrate_gps, updated_at)
        VALUES (@b, @gps, @miners, @blocks, @earnings, @payout, @net, unixepoch())
        ON CONFLICT(bucket_start) DO UPDATE SET
          pool_hashrate_gps = excluded.pool_hashrate_gps,
          miner_count       = excluded.miner_count,
          blocks_found      = excluded.blocks_found,
          earnings          = excluded.earnings,
          payout            = excluded.payout,
          network_hashrate_gps = COALESCE(excluded.network_hashrate_gps, pool_metrics_hourly.network_hashrate_gps),
          updated_at        = unixepoch()
      `);
      const regionUpsert = this.db.prepare(`
        INSERT INTO pool_region_metrics_hourly
          (bucket_start, region, hashrate_gps, miner_count, shares, updated_at)
        VALUES (@b, @region, @gps, @miners, @shares, unixepoch())
        ON CONFLICT(bucket_start, region) DO UPDATE SET
          hashrate_gps = excluded.hashrate_gps,
          miner_count  = excluded.miner_count,
          shares       = excluded.shares,
          updated_at   = unixepoch()
      `);
      const shareStmt = this.db.prepare(`
        SELECT COALESCE(SUM(difficulty), 0) AS sumdiff, COUNT(DISTINCT grin_address) AS miners
        FROM shares WHERE created_at >= ? AND created_at < ?`);
      const regionStmt = this.db.prepare(`
        SELECT COALESCE(region, 'default') AS region,
               COALESCE(SUM(difficulty), 0) AS sumdiff,
               COUNT(DISTINCT grin_address) AS miners,
               COUNT(*) AS shares
        FROM shares WHERE created_at >= ? AND created_at < ?
        GROUP BY COALESCE(region, 'default')`);
      const blockStmt = this.db.prepare(`
        SELECT COUNT(*) AS n FROM blocks
        WHERE found_at >= ? AND found_at < ? AND status != 'orphaned'`);
      const earnStmt = this.db.prepare(`
        SELECT COALESCE(SUM(reward), 0) AS s FROM blocks
        WHERE confirmed_at >= ? AND confirmed_at < ? AND status != 'orphaned'`);
      // NET of the flat withdrawal fee: `amount` is the gross the miner was debited, but only
      // amount − fee_charged actually reached them. Legacy rows have fee_charged = 0, which is
      // historically correct (they predate the fee), so this stays exact across the migration.
      const payStmt = this.db.prepare(`
        SELECT COALESCE(SUM(amount - COALESCE(fee_charged, 0)), 0) AS s FROM withdrawals
        WHERE status = 'confirmed' AND confirmed_at >= ? AND confirmed_at < ?`);

      const factor = HashrateTracker.CYCLE_LENGTH / (H * HashrateTracker.SOLUTION_RATE);
      let wrote = 0;
      const tx = this.db.transaction(() => {
        for (let b = start; b <= nowHour - H; b += H) {
          const sh = shareStmt.get(b, b + H);
          const bl = blockStmt.get(b, b + H);
          const en = earnStmt.get(b, b + H);
          const pa = payStmt.get(b, b + H);
          upsert.run({
            b,
            gps: parseFloat((sh.sumdiff * factor).toFixed(6)),
            miners: sh.miners || 0,
            blocks: bl.n || 0,
            earnings: parseFloat((en.s || 0).toFixed(9)),
            payout: parseFloat((pa.s || 0).toFixed(9)),
            net: (netGps != null && b === nowHour - H) ? parseFloat(netGps.toFixed(6)) : null
          });
          for (const r of regionStmt.all(b, b + H)) {
            regionUpsert.run({
              b,
              region: r.region,
              gps: parseFloat((r.sumdiff * factor).toFixed(6)),
              miners: r.miners || 0,
              shares: r.shares || 0
            });
          }
          wrote++;
        }
      });
      tx();
      return wrote;
    } catch (err) {
      console.error(`Error rolling up hourly metrics: ${err.message}`);
      return 0;
    }
  }

  // Read the durable rollup for the public trend charts. `range` selects span + bucket size:
  //   day → 24×1h · week → 7d×1h · month → 30d×1d · year → 365d×1d · all → whole series, bucket
  //   auto-scaled by total span (≤90d→1d, ≤2y→1w, else 1m). Hourly rows are re-bucketed by integer
  //   division on bucket_start (UTC-aligned). Aggregation: hashrate = AVG of hourly avgs, miners =
  //   AVG concurrent (rounded), blocks/earnings/payout = SUM. Returns { range, bucket_seconds, points }.
  getMetricsHistory(range = 'day') {
    try {
      const H = HashrateTracker.HOUR;
      const DAY = 86400;
      const now = Math.floor(Date.now() / 1000);
      let bucket, cutoff;

      if (range === 'all') {
        const first = this.db.prepare('SELECT MIN(bucket_start) AS b FROM pool_metrics_hourly').get();
        const earliest = (first && first.b != null) ? first.b : now - DAY;
        const totalSpan = now - earliest;
        bucket = totalSpan <= 90 * DAY ? DAY : (totalSpan <= 730 * DAY ? 7 * DAY : 30 * DAY);
        cutoff = earliest;
      } else {
        let span;
        switch (range) {
          case 'week':  span = 7 * DAY;   bucket = H;   break;
          case 'month': span = 30 * DAY;  bucket = DAY; break;
          case 'year':  span = 365 * DAY; bucket = DAY; break;
          case 'day':
          default:      span = 24 * H;    bucket = H;   break;
        }
        cutoff = now - span;
      }

      const rows = this.db.prepare(`
        SELECT CAST(bucket_start / ? AS INTEGER) * ?  AS t,
               AVG(pool_hashrate_gps)           AS hashrate_gps,
               AVG(miner_count)                 AS miner_count,
               COALESCE(SUM(blocks_found), 0)   AS blocks_found,
               COALESCE(SUM(earnings), 0)       AS earnings,
               COALESCE(SUM(payout), 0)         AS payout,
               AVG(network_hashrate_gps)        AS network_hashrate_gps
        FROM pool_metrics_hourly
        WHERE bucket_start >= ?
        GROUP BY t
        ORDER BY t ASC
      `).all(bucket, bucket, cutoff);

      return {
        range,
        bucket_seconds: bucket,
        points: rows.map(r => ({
          t: r.t,
          hashrate_gps: parseFloat((r.hashrate_gps || 0).toFixed(6)),
          miner_count: Math.round(r.miner_count || 0),
          blocks_found: r.blocks_found || 0,
          earnings: parseFloat((r.earnings || 0).toFixed(9)),
          payout: parseFloat((r.payout || 0).toFixed(9)),
          // NULL until the first sampled hour (or when the node was unreachable) — charts skip gaps.
          network_hashrate_gps: r.network_hashrate_gps != null
            ? parseFloat(r.network_hashrate_gps.toFixed(6)) : null
        }))
      };
    } catch (err) {
      console.error(`Error fetching metrics history: ${err.message}`);
      return { range, bucket_seconds: null, points: [] };
    }
  }

  // Per-region (gateway) trend series from pool_region_metrics_hourly — same range/bucket rules
  // as getMetricsHistory (they chart side by side off one range toggle). Returns
  // { range, bucket_seconds, series: [{ region, points: [{ t, miner_count, hashrate_gps }] }] }
  // with series ordered by total shares desc (busiest first, for legend order). Chart colours
  // are NOT tied to this order — the frontend keys them by region name so a region never
  // changes colour when the ranking shifts.
  getRegionMetricsHistory(range = 'day') {
    try {
      const H = HashrateTracker.HOUR;
      const DAY = 86400;
      const now = Math.floor(Date.now() / 1000);
      let bucket, cutoff;

      if (range === 'all') {
        const first = this.db.prepare('SELECT MIN(bucket_start) AS b FROM pool_region_metrics_hourly').get();
        const earliest = (first && first.b != null) ? first.b : now - DAY;
        const totalSpan = now - earliest;
        bucket = totalSpan <= 90 * DAY ? DAY : (totalSpan <= 730 * DAY ? 7 * DAY : 30 * DAY);
        cutoff = earliest;
      } else {
        let span;
        switch (range) {
          case 'week':  span = 7 * DAY;   bucket = H;   break;
          case 'month': span = 30 * DAY;  bucket = DAY; break;
          case 'year':  span = 365 * DAY; bucket = DAY; break;
          case 'day':
          default:      span = 24 * H;    bucket = H;   break;
        }
        cutoff = now - span;
      }

      const rows = this.db.prepare(`
        SELECT CAST(bucket_start / ? AS INTEGER) * ? AS t,
               region,
               AVG(hashrate_gps)   AS hashrate_gps,
               AVG(miner_count)    AS miner_count,
               COALESCE(SUM(shares), 0) AS shares
        FROM pool_region_metrics_hourly
        WHERE bucket_start >= ?
        GROUP BY t, region
        ORDER BY t ASC
      `).all(bucket, bucket, cutoff);

      const byRegion = new Map();
      const shareTotals = new Map();
      for (const r of rows) {
        if (!byRegion.has(r.region)) byRegion.set(r.region, []);
        byRegion.get(r.region).push({
          t: r.t,
          miner_count: Math.round(r.miner_count || 0),
          hashrate_gps: parseFloat((r.hashrate_gps || 0).toFixed(6))
        });
        shareTotals.set(r.region, (shareTotals.get(r.region) || 0) + (r.shares || 0));
      }
      const series = [...byRegion.entries()]
        .sort((a, b) => (shareTotals.get(b[0]) || 0) - (shareTotals.get(a[0]) || 0))
        .map(([region, points]) => ({ region, points }));

      return { range, bucket_seconds: bucket, series };
    } catch (err) {
      console.error(`Error fetching region metrics history: ${err.message}`);
      return { range, bucket_seconds: null, series: [] };
    }
  }

  // Durable payments & transparency series for payment-history.html. Every money movement is
  // recorded forever — withdrawals are never pruned, and the ledger survives as
  // balance_log_daily (never pruned) + a raw balance_log window of balance_log_keep_days
  // (min 45d — see lib/ledger-rollup.js). Composite-read rule: rollup for day < horizon H,
  // raw for created_at >= H. Ranges day/week/month span ≤30d < the 45d raw floor, so they
  // read raw only; year/all merge both sources additively per bucket. One call feeds the page:
  //   points        time-bucketed { payout, to_miners, fee, donations, giveaways } (drives the
  //                 cumulative-paid area, reward-split doughnut and giveaways-over-time bar)
  //   distribution  payout-size histogram over the window (fixed GRIN buckets)
  //   totals        LIFETIME figures for the transparency tiles (range-independent), incl. an
  //                 effective fee % derived from the ledger itself (fee ÷ (fee+to-miners)) so it
  //                 needs no config and matches what was actually taken.
  // Ledger taxonomy (verified against rewards.js / incentives.js / lottery.js):
  //   reference_type 'block'    credit → block reward distributed to miners
  //                  'pool_fee' credit → operator fee collected (to the 'pool_fee' bucket)
  //                  'donation' debit  → reward voluntarily donated by a miner
  //   giveaways = credits of streak/join_bonus/prize_award/jackpot/lottery to REAL miner addresses
  //   (reserved buckets 'pool_fee'/'prize_pool' are funding-side, excluded). Reversals subtract.
  // Synchronous (all sqlite .all/.get). UTC-aligned buckets, mirroring getMetricsHistory/getBlocksHistory.
  getPaymentsHistory(range = 'month') {
    const H = HashrateTracker.HOUR;
    const DAY = 86400;
    const GIVEAWAY_TYPES = "('streak','join_bonus','prize_award','jackpot','lottery')";
    const RESERVED = "('pool_fee','prize_pool')";
    const empty = {
      range, bucket_seconds: null, points: [], distribution: [],
      totals: {
        paid_all: 0, payout_count: 0, avg_payout: 0, last_payout_at: null,
        fee_all: 0, donations_all: 0, giveaways_all: 0, to_miners_all: 0, fee_percent: 0,
        withdrawal_fees_all: 0
      }
    };
    try {
      const now = Math.floor(Date.now() / 1000);
      const H = getHorizon(this.db); // balance_log_daily covers created_at < H; 0 = no rollup yet
      let bucket, cutoff;

      if (range === 'all') {
        const first = this.db.prepare(`
          SELECT MIN(t) AS b FROM (
            SELECT MIN(confirmed_at) AS t FROM withdrawals WHERE status = 'confirmed'
            UNION ALL SELECT MIN(created_at) AS t FROM balance_log
            UNION ALL SELECT MIN(day) AS t FROM balance_log_daily
          )`).get();
        const earliest = (first && first.b != null) ? first.b : now - 30 * DAY;
        const totalSpan = Math.max(now - earliest, DAY);
        bucket = totalSpan <= 90 * DAY ? DAY : (totalSpan <= 730 * DAY ? 7 * DAY : 30 * DAY);
        cutoff = earliest;
      } else {
        let span;
        switch (range) {
          case 'day':   span = 24 * H;      bucket = H;      break;
          case 'week':  span = 7 * DAY;     bucket = DAY;    break;
          case 'year':  span = 365 * DAY;   bucket = 7 * DAY; break;
          case 'month':
          default:      span = 30 * DAY;    bucket = DAY;    break;
        }
        cutoff = now - span;
      }

      // Confirmed payouts per bucket (actual GRIN sent to miners), keyed by confirmed_at.
      // Net of the flat withdrawal fee — see payStmt above.
      const payRows = this.db.prepare(`
        SELECT CAST(confirmed_at / ? AS INTEGER) * ? AS t,
               COALESCE(SUM(amount - COALESCE(fee_charged, 0)), 0) AS payout
        FROM withdrawals
        WHERE status = 'confirmed' AND confirmed_at >= ?
        GROUP BY t
      `).all(bucket, bucket, cutoff);

      // Ledger movements per bucket, split by category. Composite: year/all pull days
      // below the rollup horizon from balance_log_daily and the rest from raw; shorter
      // ranges are entirely inside the raw window (≥45d) and skip the rollup. A bucket
      // wider than a day (week/month) can straddle the horizon and receive rows from
      // BOTH sources, so the merge below must be additive, not assignment.
      const ledSeries = [];
      const useRollup = H > 0 && (range === 'year' || range === 'all');
      if (useRollup && H > cutoff) {
        ledSeries.push(...this.db.prepare(`
          SELECT CAST(day / ? AS INTEGER) * ? AS t,
                 COALESCE(SUM(CASE WHEN reference_type = 'block'    AND event_type = 'credit' THEN total_amount ELSE 0 END), 0) AS to_miners,
                 COALESCE(SUM(CASE WHEN reference_type = 'pool_fee' AND event_type = 'credit' THEN total_amount ELSE 0 END), 0) AS fee,
                 COALESCE(SUM(CASE WHEN reference_type = 'donation' AND event_type = 'debit'  THEN total_amount ELSE 0 END), 0) AS donations,
                 COALESCE(SUM(CASE WHEN reference_type IN ${GIVEAWAY_TYPES} AND grin_address NOT IN ${RESERVED} AND event_type = 'credit'   THEN total_amount
                                 WHEN reference_type IN ${GIVEAWAY_TYPES} AND grin_address NOT IN ${RESERVED} AND event_type = 'reversal' THEN -total_amount
                                 ELSE 0 END), 0) AS giveaways
          FROM balance_log_daily
          WHERE day >= ? AND day < ?
          GROUP BY t
        `).all(bucket, bucket, Math.floor(cutoff / DAY) * DAY, H));
      }
      const rawFrom = useRollup ? Math.max(cutoff, H) : cutoff;
      ledSeries.push(...this.db.prepare(`
        SELECT CAST(created_at / ? AS INTEGER) * ? AS t,
               COALESCE(SUM(CASE WHEN reference_type = 'block'    AND event_type = 'credit' THEN amount ELSE 0 END), 0) AS to_miners,
               COALESCE(SUM(CASE WHEN reference_type = 'pool_fee' AND event_type = 'credit' THEN amount ELSE 0 END), 0) AS fee,
               COALESCE(SUM(CASE WHEN reference_type = 'donation' AND event_type = 'debit'  THEN amount ELSE 0 END), 0) AS donations,
               COALESCE(SUM(CASE WHEN reference_type IN ${GIVEAWAY_TYPES} AND grin_address NOT IN ${RESERVED} AND event_type = 'credit'   THEN amount
                               WHEN reference_type IN ${GIVEAWAY_TYPES} AND grin_address NOT IN ${RESERVED} AND event_type = 'reversal' THEN -amount
                               ELSE 0 END), 0) AS giveaways
        FROM balance_log
        WHERE created_at >= ?
        GROUP BY t
      `).all(bucket, bucket, rawFrom));

      // Merge the source series into one bucket map (a bucket may appear in any of them).
      const byT = new Map();
      const slot = t => {
        let s = byT.get(t);
        if (!s) { s = { t, payout: 0, to_miners: 0, fee: 0, donations: 0, giveaways: 0 }; byT.set(t, s); }
        return s;
      };
      for (const r of payRows) slot(r.t).payout += r.payout || 0;
      for (const r of ledSeries) {
        const s = slot(r.t);
        s.to_miners += r.to_miners || 0;
        s.fee += r.fee || 0;
        s.donations += r.donations || 0;
        s.giveaways += r.giveaways || 0;
      }
      const round9 = v => parseFloat((Number(v) || 0).toFixed(9));
      const points = Array.from(byT.values())
        .sort((a, b) => a.t - b.t)
        .map(s => ({
          t: s.t,
          payout: round9(s.payout),
          to_miners: round9(s.to_miners),
          fee: round9(s.fee),
          donations: round9(s.donations),
          giveaways: round9(s.giveaways)
        }));

      // Payout-size histogram over the window (fixed GRIN buckets). Edges chosen for typical
      // Grin payout magnitudes; the last bucket is open-ended.
      const edges = [1, 5, 10, 25, 50, 100];
      const labels = ['<1', '1–5', '5–10', '10–25', '25–50', '50–100', '≥100'];
      const counts = new Array(labels.length).fill(0);
      this.db.prepare(`
        SELECT (amount - COALESCE(fee_charged, 0)) AS amount FROM withdrawals
        WHERE status = 'confirmed' AND confirmed_at >= ?
      `).all(cutoff).forEach(w => {
        const a = Number(w.amount) || 0;
        let i = edges.findIndex(e => a < e);
        if (i === -1) i = labels.length - 1;
        counts[i]++;
      });
      const distribution = labels.map((label, i) => ({ label, count: counts[i] }));

      // Lifetime totals for the transparency tiles (range-independent).
      const pay = this.db.prepare(`
        SELECT COALESCE(SUM(amount - COALESCE(fee_charged, 0)), 0) AS paid,
               COALESCE(SUM(fee_charged), 0) AS withdrawal_fees,
               COUNT(*) AS cnt, MAX(confirmed_at) AS last
        FROM withdrawals WHERE status = 'confirmed'
      `).get();
      // Lifetime ledger sums = rollup(day < H) + raw(created_at >= H). Exact at every
      // prune state: raw rows below H still present simply aren't read twice.
      const ledRaw = this.db.prepare(`
        SELECT COALESCE(SUM(CASE WHEN reference_type = 'block'    AND event_type = 'credit' THEN amount ELSE 0 END), 0) AS to_miners,
               COALESCE(SUM(CASE WHEN reference_type = 'pool_fee' AND event_type = 'credit' THEN amount ELSE 0 END), 0) AS fee,
               COALESCE(SUM(CASE WHEN reference_type = 'donation' AND event_type = 'debit'  THEN amount ELSE 0 END), 0) AS donations,
               COALESCE(SUM(CASE WHEN reference_type IN ${GIVEAWAY_TYPES} AND grin_address NOT IN ${RESERVED} AND event_type = 'credit'   THEN amount
                               WHEN reference_type IN ${GIVEAWAY_TYPES} AND grin_address NOT IN ${RESERVED} AND event_type = 'reversal' THEN -amount
                               ELSE 0 END), 0) AS giveaways
        FROM balance_log WHERE created_at >= ?
      `).get(H);
      const ledAgg = H > 0 ? this.db.prepare(`
        SELECT COALESCE(SUM(CASE WHEN reference_type = 'block'    AND event_type = 'credit' THEN total_amount ELSE 0 END), 0) AS to_miners,
               COALESCE(SUM(CASE WHEN reference_type = 'pool_fee' AND event_type = 'credit' THEN total_amount ELSE 0 END), 0) AS fee,
               COALESCE(SUM(CASE WHEN reference_type = 'donation' AND event_type = 'debit'  THEN total_amount ELSE 0 END), 0) AS donations,
               COALESCE(SUM(CASE WHEN reference_type IN ${GIVEAWAY_TYPES} AND grin_address NOT IN ${RESERVED} AND event_type = 'credit'   THEN total_amount
                               WHEN reference_type IN ${GIVEAWAY_TYPES} AND grin_address NOT IN ${RESERVED} AND event_type = 'reversal' THEN -total_amount
                               ELSE 0 END), 0) AS giveaways
        FROM balance_log_daily WHERE day < ?
      `).get(H) : { to_miners: 0, fee: 0, donations: 0, giveaways: 0 };
      const led = {
        to_miners: ledRaw.to_miners + ledAgg.to_miners,
        fee: ledRaw.fee + ledAgg.fee,
        donations: ledRaw.donations + ledAgg.donations,
        giveaways: ledRaw.giveaways + ledAgg.giveaways
      };
      const paidAll = led.to_miners + led.fee; // gross block reward accounted in the ledger
      const totals = {
        paid_all: round9(pay.paid),
        payout_count: pay.cnt || 0,
        avg_payout: pay.cnt ? round9(pay.paid / pay.cnt) : 0,
        last_payout_at: pay.last || null,
        fee_all: round9(led.fee),
        donations_all: round9(led.donations),
        giveaways_all: round9(led.giveaways),
        to_miners_all: round9(led.to_miners),
        // Block-reward split ONLY (fee ÷ gross reward). Deliberately excludes the flat
        // withdrawal fee below: that is a per-transaction cost recovery, not a cut of mined
        // rewards, and averaging the two would make this number depend on how OFTEN miners
        // withdraw rather than on the advertised pool fee.
        fee_percent: paidAll > 0 ? parseFloat(((led.fee / paidAll) * 100).toFixed(2)) : 0,
        // Lifetime flat withdrawal fees collected, reported separately so the transparency
        // page can show the full operator take without distorting fee_percent.
        withdrawal_fees_all: round9(pay.withdrawal_fees)
      };

      return { range, bucket_seconds: bucket, points, distribution, totals };
    } catch (err) {
      console.error(`Error fetching payments history: ${err.message}`);
      return empty;
    }
  }

  // Evenly downsample a dense oldest→newest series to at most maxPoints (keeps the last point).
  static _thin(rows, maxPoints) {
    if (rows.length <= maxPoints) {
      return rows.map(r => ({ t: r.t, gps: parseFloat((r.gps || 0).toFixed(6)) }));
    }
    const step = rows.length / maxPoints;
    const out = [];
    for (let i = 0; i < maxPoints; i++) {
      const r = rows[Math.floor(i * step)];
      out.push({ t: r.t, gps: parseFloat((r.gps || 0).toFixed(6)) });
    }
    const last = rows[rows.length - 1];
    if (out.length === 0 || out[out.length - 1].t !== last.t) {
      out.push({ t: last.t, gps: parseFloat((last.gps || 0).toFixed(6)) });
    }
    return out;
  }

  getHashrateStats() {
    try {
      const poolHashrate1h = this.getPoolHashrate(60);
      const poolHashrate24h = this.getPoolHashrate(1440);
      const topMiners = this.getTopMiners(10, 60);

      const activeSessions = this.minerManager.getActiveSessions();
      const uniqueMiners = new Set(activeSessions.map(s => s.grinAddress)).size;

      return {
        pool_hashrate_1h_gps: parseFloat(poolHashrate1h.toFixed(6)),
        pool_hashrate_24h_gps: parseFloat(poolHashrate24h.toFixed(6)),
        active_miners: uniqueMiners,
        active_connections: activeSessions.length,
        top_miners: topMiners.map(m => ({
          grin_address: m.grin_address,
          hashrate_gps: parseFloat(m.avg_hashrate.toFixed(6)),
          max_hashrate_gps: parseFloat(m.max_hashrate.toFixed(6))
        }))
      };
    } catch (err) {
      console.error(`Error fetching hashrate stats: ${err.message}`);
      return {
        pool_hashrate_1h_gps: 0,
        pool_hashrate_24h_gps: 0,
        active_miners: 0,
        active_connections: 0,
        top_miners: []
      };
    }
  }

  stop() {
    this.isRunning = false;
    console.log(`[${new Date().toISOString()}] Hashrate tracker stopped`);
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = HashrateTracker;
