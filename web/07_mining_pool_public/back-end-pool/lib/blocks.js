const { getDb } = require('./db');

// A pool fee % as a number, or NaN when there is none. Not bare Number(): Number(null) and
// Number('') are 0, which would record a missing rate as a 0% block (no fee, and published as
// such). NaN is stored as NULL, which rewards.js treats as "not on record".
const feeRate = (v) => (v === null || v === undefined || v === '' ? NaN : Number(v));

class BlockManager {
  // Newest block intervals one history response carries (_blockIntervals). One point per
  // block, so the cap bounds both the payload and the chart's point count.
  static INTERVAL_CAP = 500;
  // How long the public history route may reuse a computed response (getBlocksHistoryCached).
  static HISTORY_TTL_MS = 60 * 1000;

  constructor(config) {
    this.config = config;
    this.db = getDb();
    this.lastBlockHeight = 0;
    this.nodeApi = null; // optional GrinNodeAPI for capturing per-block network difficulty
    this._historyCache = new Map(); // range → { at, value }
    this._stampUnsettledFeeRate();
  }

  // A block still maturing with no recorded fee was found before fee_percent existed. Its real
  // find-time rate is not on record: the boot rate differs from it after a fee change + restart
  // during maturation (~1 day), or a fee saved in the admin panel that the previous process
  // never applied. The boot rate is what a pool without fee_percent charges at maturity (the
  // live rate, which only a restart moves), so stamping it keeps that charge, and stops a fee
  // saved live after this boot from re-pricing the block.
  // /api/pool/blocks publishes this stamped rate like any other. Settled and orphaned rows are
  // left alone (db.js backfills settled ones from the ledger).
  _stampUnsettledFeeRate() {
    const pct = feeRate(this.config.pool_fee_percent);
    if (!Number.isFinite(pct)) return;
    try {
      const r = this.db.prepare(`
        UPDATE blocks SET fee_percent = ?
        WHERE fee_percent IS NULL AND status IN ('immature', 'confirmed')
      `).run(pct);
      if (r.changes > 0) console.warn(`[BlockManager] recorded fee ${pct}% on ${r.changes} maturing block(s) found before the rate was recorded`);
    } catch (err) {
      // rewards.js still charges an unrecorded block the live rate, so this is not fatal.
      console.error(`[BlockManager] fee_percent stamp for maturing blocks skipped: ${err.message}`);
    }
  }

  // Wire a GrinNodeAPI so creditBlock can record the block's network difficulty. Optional —
  // without it, network_difficulty is left NULL and that block is skipped by the luck calc.
  setNodeApi(nodeApi) {
    this.nodeApi = nodeApi;
  }

  // Per-block C32 network difficulty = total_difficulty[h] − total_difficulty[h-1]. Best-effort
  // (two foreign get_header calls); returns null if the node is unreachable or h-1 is unavailable.
  async _fetchNetworkDifficulty(height) {
    if (!this.nodeApi || !height) return null;
    try {
      const [h, hPrev] = await Promise.all([
        this.nodeApi.getHeader(height),
        this.nodeApi.getHeader(height - 1)
      ]);
      const d = Number(h.total_difficulty) - Number(hPrev.total_difficulty);
      return Number.isFinite(d) && d > 0 ? d : null;
    } catch (e) {
      console.warn(`[BlockManager] network difficulty fetch failed for ${height}: ${e.message}`);
      return null;
    }
  }

  // Transaction fees carried by this block, in GRIN. Grin pays the finder
  // REWARD + sum(kernel fees) — 60 is the EMISSION, not the payment — so crediting the flat
  // constant quietly keeps every block's fees for the pool on top of pool_fee_percent, and
  // biases reconciliation's coverage gap positive (masking a real shortfall of the same
  // size). Audit §J5-10.
  //
  // Read at FOUND time on purpose: get_block returns the block BODY, which a pruned node
  // serves only inside its pruning horizon — at maturity (1440 blocks later) it may already
  // be gone, while a block we have just this second submitted is certainly there.
  //
  // Best-effort and hash-gated: a race at the tip can hand us a competitor's block at the
  // same height, so the fees are only trusted when the node's header hash is OUR hash.
  // Anything else returns null and the caller falls back to the flat reward.
  async _fetchBlockFees(height, hash) {
    if (!this.nodeApi || !height) return null;
    try {
      const blk = await this.nodeApi.getBlock(height);
      const gotHash = blk && blk.header && blk.header.hash;
      if (!gotHash || String(gotHash).toLowerCase() !== String(hash || '').toLowerCase()) {
        console.warn(
          `[BlockManager] fee capture skipped for ${height}: node has ${gotHash}, we found ${hash}`
        );
        return null;
      }
      const kernels = Array.isArray(blk.kernels) ? blk.kernels : [];
      // Coinbase kernels carry fee 0, so a bare sum is correct. Fees are nanogrin.
      let nano = 0;
      for (const k of kernels) {
        const f = Number(k && k.fee);
        if (Number.isFinite(f) && f > 0) nano += f;
      }
      const grin = nano / 1e9;
      return Number.isFinite(grin) && grin >= 0 ? grin : null;
    } catch (e) {
      console.warn(`[BlockManager] block fee fetch failed for ${height}: ${e.message}`);
      return null;
    }
  }

  // Accumulated pool share-difficulty for the round that found this block — shares since the
  // previous block's found_at. Captured now so luck stays exact after raw shares are pruned.
  _roundShareDiff(prevFoundAt) {
    try {
      const row = this.db.prepare(
        'SELECT COALESCE(SUM(difficulty), 0) AS d FROM shares WHERE created_at > ?'
      ).get(prevFoundAt || 0);
      return row && Number.isFinite(row.d) ? row.d : null;
    } catch (e) {
      return null;
    }
  }

  // `reward` is the flat emission (60). The value actually stored is that plus the block's
  // transaction fees when they can be read from the chain — see _fetchBlockFees.
  //
  // `feePercent` is the pool fee the miners were mining under when this block was found;
  // rewards.js splits the reward at it at maturity, so a fee change never re-prices a found
  // block. stratum-server.js snapshots it when the submit ARRIVES, before the node round-trip;
  // without one, the rate is read here, before the node fetches below — read after them, a fee
  // saved during those up-to-10 s would be stamped on a block found under the old rate.
  async creditBlock(height, hash, nonce, reward, minerAddress, feePercent = this.config.pool_fee_percent) {
    const feePct = feeRate(feePercent);
    try {
      // Capture round/network stats BEFORE inserting (round = shares since the previous block).
      const prev = this.getLastBlock();
      const roundShares = this._roundShareDiff(prev ? prev.found_at : 0);
      // In PARALLEL, not in sequence: creditBlock is awaited before the miner's submit ack is
      // written, and each of these carries the node client's 10s timeout. Serially that is up
      // to 20s of dead air on an unreachable node; concurrently it is 10s.
      const [networkDiff, fees] = await Promise.all([
        this._fetchNetworkDifficulty(height),
        this._fetchBlockFees(height, hash),
      ]);
      const total = fees === null ? reward : reward + fees;

      const stmt = this.db.prepare(`
        INSERT INTO blocks (height, hash, nonce, reward, fees, status, found_by, found_at, network_difficulty, round_shares, fee_percent)
        VALUES (?, ?, ?, ?, ?, 'immature', ?, unixepoch(), ?, ?, ?)
      `);

      // String(nonce): the column is TEXT and a Grin nonce is a u64 that must never be
      // rounded through a JS number. See db.js's blocks DDL and audit §J5-1.
      const result = stmt.run(height, hash, String(nonce), total, fees, minerAddress, networkDiff, roundShares,
        Number.isFinite(feePct) ? feePct : null);
      this._historyCache.clear(); // a new block shows on blocks.html at once, not after the TTL

      console.log(
        `[${new Date().toISOString()}] Block credited: height=${height}, hash=${hash.substring(0, 16)}..., ` +
        `reward=${total} GRIN (${reward} emission${fees === null ? ', fees unread' : ` + ${fees} fees`}), miner=${minerAddress}`
      );

      return {
        success: true,
        block_id: result.lastInsertRowid,
        height,
        hash,
        reward: total,
        fees
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

  // Synchronous: all queries are synchronous sqlite .get() (no awaits). It must NOT be async —
  // every caller uses it without await, so an async version would return a Promise they spread
  // into {} (empty stats on /api/pool/stats, /api/admin/metrics, dashboard, poolstats).
  getPoolStats() {
    try {
      const totalBlocks = this.db.prepare(
        'SELECT COUNT(*) as count FROM blocks'
      ).get();

      const totalReward = this.db.prepare(
        'SELECT COALESCE(SUM(reward), 0) as total FROM blocks'
      ).get();

      // 'paid' is the TERMINAL success state — rewards.js flips confirmed→paid the moment it
      // distributes, ~30s after maturity. Counting only 'confirmed' would report a pool that
      // has confirmed 0 blocks and earned 0 confirmed reward in steady state, and roll every
      // paid block into `immature_blocks` below. This feeds /api/pool/stats and the external
      // poolstats reporter, so the error would be public. See audit §J5-4.
      const confirmedBlocks = this.db.prepare(
        "SELECT COUNT(*) as count FROM blocks WHERE status IN ('confirmed', 'paid')"
      ).get();

      const confirmedReward = this.db.prepare(
        "SELECT COALESCE(SUM(reward), 0) as total FROM blocks WHERE status IN ('confirmed', 'paid')"
      ).get();

      // Counted directly, not as (total − confirmed): that subtraction also folded every
      // ORPHANED block into the maturing count.
      const immatureCount = this.db.prepare(
        "SELECT COUNT(*) as count FROM blocks WHERE status = 'immature'"
      ).get();
      // Not (total_reward − confirmed_reward): total_reward also sums ORPHANED rewards.
      const immatureReward = this.db.prepare(
        "SELECT COALESCE(SUM(reward), 0) as total FROM blocks WHERE status = 'immature'"
      ).get();

      // "Found" = any non-orphaned block. created_at is INTEGER unixepoch.
      const blocks24h = this.db.prepare(
        "SELECT COUNT(*) as count, COALESCE(SUM(reward), 0) as reward FROM blocks WHERE status != 'orphaned' AND created_at > unixepoch() - 86400"
      ).get();
      const blocks7d = this.db.prepare(
        "SELECT COUNT(*) as count, COALESCE(SUM(reward), 0) as reward FROM blocks WHERE status != 'orphaned' AND created_at > unixepoch() - 7 * 86400"
      ).get();
      // Orphans FOUND in the last 24h — the homepage Integrity lamp's window. Same predicate as
      // AlertMonitor.checkOrphanedBlocks, so the lamp and the operator alert agree. Never "the
      // newest N blocks": on a slow pool that keeps one orphan lit for weeks.
      const orphans24h = this.db.prepare(
        "SELECT COUNT(*) as count FROM blocks WHERE status = 'orphaned' AND found_at > unixepoch() - 86400"
      ).get();

      return {
        total_blocks_found: totalBlocks.count,
        total_reward: totalReward.total,
        confirmed_blocks: confirmedBlocks.count,
        confirmed_reward: confirmedReward.total,
        immature_blocks: immatureCount.count,
        immature_reward: immatureReward.total,
        blocks_24h: blocks24h.count,
        blocks_7d: blocks7d.count,
        reward_24h: blocks24h.reward,
        reward_7d: blocks7d.reward,
        orphans_24h: orphans24h.count
      };
    } catch (err) {
      console.error(`Error fetching pool stats: ${err.message}`);
      return {
        total_blocks_found: 0,
        total_reward: 0,
        confirmed_blocks: 0,
        confirmed_reward: 0,
        immature_blocks: 0,
        immature_reward: 0,
        blocks_24h: 0,
        blocks_7d: 0,
        reward_24h: 0,
        reward_7d: 0,
        // null, not 0: a failed read must not light the lamp green ("no orphans").
        orphans_24h: null
      };
    }
  }

  // Durable block-history series for the public blocks.html deck. Blocks are never pruned, so we
  // bucket straight from the blocks table (found_at) and stay accurate at every range. One call
  // feeds every chart: time-bucketed counts (found vs expected columns), a per-block luck
  // trend, window status totals (doughnut), the time between consecutive blocks and the UTC
  // weekday×hour heatmap. Returns { range, bucket_seconds, points, luck, status, intervals,
  // intervals_truncated, hours }. Synchronous (all sqlite .all/.get).
  // UTC-aligned buckets, mirroring getMetricsHistory.
  //
  // ⚠ Not for the public route — use getBlocksHistoryCached. One call is several full scans of
  // `blocks` (no found_at index) plus the rollup read back to the oldest predecessor's day, run
  // synchronously in the process that accepts shares.
  getBlocksHistory(range = 'month') {
    const DAY = 86400;
    const empty = { range, bucket_seconds: null, points: [], luck: [], status: { confirmed: 0, immature: 0, orphaned: 0 }, intervals: [], intervals_truncated: false, hours: null };
    try {
      const now = Math.floor(Date.now() / 1000);
      let bucket, cutoff;

      if (range === 'all') {
        const first = this.db.prepare('SELECT MIN(found_at) AS b FROM blocks').get();
        const earliest = (first && first.b != null) ? first.b : now - 30 * DAY;
        const totalSpan = Math.max(now - earliest, DAY);
        bucket = totalSpan <= 90 * DAY ? DAY : (totalSpan <= 730 * DAY ? 7 * DAY : 30 * DAY);
        cutoff = earliest;
      } else {
        let span;
        switch (range) {
          case 'week':  span = 7 * DAY;   bucket = DAY;     break;
          case 'year':  span = 365 * DAY; bucket = 7 * DAY; break;
          case 'month':
          default:      span = 30 * DAY;  bucket = DAY;     break;
        }
        cutoff = now - span;
      }

      // Time-bucketed counts + reward (drives the blocks-per-period columns).
      const found = this.db.prepare(`
        SELECT CAST(found_at / ? AS INTEGER) * ?              AS t,
               COUNT(*)                                       AS blocks,
               COALESCE(SUM(reward), 0)                       AS reward,
               COALESCE(SUM(CASE WHEN status = 'confirmed' THEN 1 ELSE 0 END), 0) AS confirmed,
               COALESCE(SUM(CASE WHEN status = 'orphaned'  THEN 1 ELSE 0 END), 0) AS orphaned
        FROM blocks
        WHERE found_at >= ?
        GROUP BY t
        ORDER BY t ASC
      `).all(bucket, bucket, cutoff).map(r => ({
        t: r.t,
        blocks: r.blocks || 0,
        reward: parseFloat((r.reward || 0).toFixed(9)),
        confirmed: r.confirmed || 0,
        orphaned: r.orphaned || 0
      }));

      // Expected blocks from the pool's hashrate share, per bucket (P-02's comparison line) and
      // per UTC weekday×hour (the heatmap). The found-blocks query only yields NON-empty buckets,
      // but a bucket where the pool mined and found nothing is exactly the unlucky one, so every
      // bucket the hourly rollup covers gets a point — a zero column, not a missing one.
      const exp = this._expectedBlocks(cutoff, bucket);
      const byT = new Map(found.map(p => [p.t, p]));
      exp.byBucket.forEach((_, t) => {
        if (!byT.has(t)) byT.set(t, { t, blocks: 0, reward: 0, confirmed: 0, orphaned: 0 });
      });
      const points = [...byT.values()]
        .sort((a, b) => a.t - b.t)
        .map(p => Object.assign(p, { expected: exp.byBucket.has(p.t) ? exp.byBucket.get(p.t) : null }));

      // Found blocks by UTC weekday (0 = Sunday, strftime %w) × hour. Every status counts, as in
      // `points` — an orphan was still found at that hour, which is what the heatmap asks.
      const hourFound = Array.from({ length: 7 }, () => new Array(24).fill(0));
      this.db.prepare(`
        SELECT CAST(strftime('%w', found_at, 'unixepoch') AS INTEGER) AS wd,
               CAST(strftime('%H', found_at, 'unixepoch') AS INTEGER) AS hr,
               COUNT(*) AS n
        FROM blocks
        WHERE found_at >= ?
        GROUP BY wd, hr
      `).all(cutoff).forEach(r => {
        if (hourFound[r.wd] && r.hr >= 0 && r.hr < 24) hourFound[r.wd][r.hr] = r.n;
      });
      const hours = { found: hourFound, expected: exp.grid, expected_hours: exp.hours };

      // Per-block luck % over the window (round shares ÷ network difficulty × 100), oldest→newest,
      // capped for a readable line. Only blocks with both captured stats contribute.
      const luck = this.db.prepare(`
        SELECT height, round_shares, network_difficulty, found_at
        FROM blocks
        WHERE found_at >= ? AND network_difficulty > 0 AND round_shares > 0
        ORDER BY height DESC
        LIMIT 120
      `).all(cutoff)
        .map(r => ({ height: r.height, t: r.found_at, luck: parseFloat(((r.round_shares / r.network_difficulty) * 100).toFixed(1)) }))
        .reverse();

      // Window status totals (drives the doughnut — a true orphaned count, unlike /api/pool/stats
      // which folds orphaned into "immature").
      const status = { confirmed: 0, immature: 0, orphaned: 0 };
      this.db.prepare(`
        SELECT status, COUNT(*) AS n FROM blocks WHERE found_at >= ? GROUP BY status
      `).all(cutoff).forEach(r => {
        // 'paid' is confirmed-and-distributed, not maturing — see getPoolStats above.
        if (r.status === 'confirmed' || r.status === 'paid') status.confirmed += r.n;
        else if (r.status === 'orphaned') status.orphaned = r.n;
        else status.immature += r.n; // 'immature' (and any legacy/unknown) count as maturing
      });

      // Its own try: a failure here blanks P-04 only, not every chart the response feeds.
      let iv;
      try { iv = this._blockIntervals(cutoff); } catch (e) {
        console.error(`Error computing block intervals: ${e.message}`);
        iv = { intervals: [], truncated: false };
      }
      return { range, bucket_seconds: bucket, points, luck, status,
               intervals: iv.intervals, intervals_truncated: iv.truncated, hours };
    } catch (err) {
      console.error(`Error fetching blocks history: ${err.message}`);
      return empty;
    }
  }

  // getBlocksHistory for the public route, reused for HISTORY_TTL_MS per range, so the work per
  // minute is bounded by the four ranges, not by request traffic. creditBlock clears it; a
  // status change made elsewhere (orphan-detector, rewards) or a new rollup hour shows within
  // the TTL. An error response (`empty`, bucket_seconds null) is not kept.
  getBlocksHistoryCached(range = 'month') {
    const now = Date.now();
    const hit = this._historyCache.get(range);
    if (hit && now - hit.at < BlockManager.HISTORY_TTL_MS) return hit.value;
    const value = this.getBlocksHistory(range);
    if (value.bucket_seconds != null) this._historyCache.set(range, { at: now, value });
    return value;
  }

  // Blocks the pool SHOULD have found, from its share of network hashrate, over the hourly
  // rollup (pool_metrics_hourly). One completed hour at share s expects s × 60 blocks (60 s
  // target). Returns { byBucket: Map(t → expected|null), grid: 7×24 | null, hours }.
  //
  // network_hashrate_gps is NULL on an hour with no node sample (catch-up rows after an outage,
  // and every hour before the column existed). Network hashrate barely moves within a bucket,
  // so a missing hour borrows its BUCKET's mean sample; the pool's own GPS — the part that
  // actually varies — is always the real one. A bucket with no sample of its own reports null
  // (drawn as a gap), never a guess: a borrowed network figure from months away is one. The
  // exception is a bucket where the pool had NO hashrate in any hour — that expects 0 blocks
  // whatever the network did, so it reports 0 (see _hourlyExpected).
  // An hour with no rollup row at all contributes nothing — the pool was not running.
  _expectedBlocks(cutoff, bucket) {
    const out = { byBucket: new Map(), grid: null, hours: 0 };
    const rows = this._hourlyExpected(cutoff, bucket);
    if (!rows.length) return out;

    const keyOf = b => Math.floor(b / bucket) * bucket;
    const sums = new Map();
    const grid = Array.from({ length: 7 }, () => new Array(24).fill(0));
    for (const r of rows) {
      const k = keyOf(r.b);
      if (r.e === null) { sums.set(k, null); continue; }
      // One unknown hour makes the whole bucket unknown, in whatever order the hours arrive.
      if (sums.get(k) !== null) sums.set(k, (sums.get(k) || 0) + r.e);
      const d = new Date(r.b * 1000);
      grid[d.getUTCDay()][d.getUTCHours()] += r.e;
      out.hours += 1;
    }

    const round2 = v => Math.round(v * 100) / 100;
    sums.forEach((v, k) => out.byBucket.set(k, v == null ? null : round2(v)));
    if (out.hours > 0) out.grid = grid.map(row => row.map(round2));
    return out;
  }

  // The rollup hours from `from` on, oldest first, each with the blocks it should have found:
  // [{ b, e }], e = pool GPS ÷ network GPS × 60. The borrowing rule is _expectedBlocks': a NULL
  // network sample takes the mean of its `borrowBucket`, and e is null for an hour of a bucket
  // that has no sample at all. An hour with zero pool hashrate is e = 0 BEFORE that check: it
  // needs no network figure, and the catch-up rows written after an outage are exactly such
  // hours with no sample. Treated as unknown they would drop out of P-04's expected gap, and
  // the outage would read as bad luck.
  _hourlyExpected(from, borrowBucket) {
    const rows = this.db.prepare(`
      SELECT bucket_start AS b, pool_hashrate_gps AS p, network_hashrate_gps AS n
      FROM pool_metrics_hourly
      WHERE bucket_start >= ?
      ORDER BY bucket_start ASC
    `).all(from);
    const keyOf = b => Math.floor(b / borrowBucket) * borrowBucket;
    const net = new Map(); // bucket → { sum, n }
    for (const r of rows) {
      const k = keyOf(r.b);
      const s = net.get(k) || { sum: 0, n: 0 };
      if (r.n > 0) { s.sum += r.n; s.n += 1; }
      net.set(k, s);
    }
    return rows.map(r => {
      if (!(r.p > 0)) return { b: r.b, e: 0 };
      const s = net.get(keyOf(r.b));
      if (!s.n) return { b: r.b, e: null };
      const n = r.n > 0 ? r.n : s.sum / s.n;
      return { b: r.b, e: (r.p / n) * 60 };
    });
  }

  // Time between consecutive pool blocks (blocks.html P-04): one entry per block found in the
  // window, oldest → newest, { height, t, gap, expected, orphaned }. gap = seconds since the
  // pool's previous block, which may be from before the window. Every status counts, as in
  // `points`: an orphan was still a block the pool found, and dropping it would merge two
  // exponential gaps into one; `orphaned` lets the chart mark it instead. found_at is the
  // CREDIT time (after up to ~10 s of node calls), so heights need not be monotone. The pool's
  // very first block has no gap.
  //
  // expected = the MEAN gap the pool's hashrate share predicts over that same stretch — rollup
  // seconds ÷ expected blocks, each hour weighted by how much of it the gap overlaps. Network
  // samples are borrowed per UTC DAY whatever the chart bucket, so a block's expected value does
  // not change with the timeframe toggle. It is null (a gap in the line, never 0) when under
  // half the stretch is covered by the hourly rollup, the pool had no hashrate in it, or the
  // gap is 0. The current hour is not rolled up yet, so the newest blocks can be null — that is
  // honest, not a bug.
  // Gaps are exponential: gap ÷ expected is the stretch's integrated hazard, Exp(1) for ANY
  // hashrate path (time rescaling), so ~63% fall below and ~5% above 3× — which holds only
  // because expected is taken over the stretch itself. Do not switch to the rate at the
  // block's own hour: that over-reports the 3× tail up to 2× on a pool whose hashrate swings.
  //
  // Capped to the newest INTERVAL_CAP; `truncated` says the window held more.
  _blockIntervals(cutoff) {
    const H = 3600, DAY = 86400, CAP = BlockManager.INTERVAL_CAP;
    const rows = this.db.prepare(`
      SELECT height, found_at, status FROM blocks
      WHERE found_at >= ?
      ORDER BY found_at DESC, height DESC
      LIMIT ?
    `).all(cutoff, CAP + 1);
    const truncated = rows.length > CAP;
    rows.reverse(); // oldest → newest; when truncated, rows[0] is only the first block's predecessor
    if (!truncated && rows.length) {
      // The tie branch is defensive: untruncated, every block tied at rows[0].found_at is
      // already in the window, so it cannot match today. It keeps the order a total one.
      const prev = this.db.prepare(`
        SELECT height, found_at, status FROM blocks
        WHERE found_at < ? OR (found_at = ? AND height < ?)
        ORDER BY found_at DESC, height DESC
        LIMIT 1
      `).get(rows[0].found_at, rows[0].found_at, rows[0].height);
      if (prev) rows.unshift(prev);
    }
    if (rows.length < 2) return { intervals: [], truncated };

    // Rollup hours from the hour of the earliest predecessor, borrowing per day.
    const hours = this._hourlyExpected(Math.floor(rows[0].found_at / DAY) * DAY, DAY);
    let j = 0; // hours are sorted and the stretches are consecutive, so one cursor walks both
    const intervals = [];
    for (let i = 1; i < rows.length; i++) {
      const a = rows[i - 1].found_at, z = rows[i].found_at;
      const gap = Math.max(0, z - a);
      while (j < hours.length && hours[j].b + H <= a) j++;
      let blocks = 0, known = 0;
      for (let k = j; k < hours.length && hours[k].b < z; k++) {
        if (hours[k].e === null) continue;
        const overlap = Math.min(z, hours[k].b + H) - Math.max(a, hours[k].b);
        if (overlap <= 0) continue;
        blocks += hours[k].e * overlap / H;
        known += overlap;
      }
      const expected = (gap > 0 && known >= gap / 2 && blocks > 0) ? Math.round(known / blocks) : null;
      intervals.push({ height: rows[i].height, t: z, gap, expected, orphaned: rows[i].status === 'orphaned' });
    }
    return { intervals, truncated };
  }

  // Most recently found block (by height), or null. Synchronous.
  getLastBlock() {
    try {
      return this.db.prepare('SELECT * FROM blocks ORDER BY height DESC LIMIT 1').get() || null;
    } catch (err) {
      console.error(`Error fetching last block: ${err.message}`);
      return null;
    }
  }
}

module.exports = BlockManager;
