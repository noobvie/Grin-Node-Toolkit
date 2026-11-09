const { getDb } = require('./db');
const PoolSettings = require('./pool-settings');
const { getHorizon } = require('./ledger-rollup');

const r9 = (v) => parseFloat((Number(v) || 0).toFixed(9));

// Reserved pseudo-addresses. These are accounting buckets in miner_accounts, NOT real
// miners — they must be filtered out of every miner-facing surface (leaderboards, stats,
// lottery eligibility, online counts).
//   pool_fee   — accrues the operator fee (created by rewards.js)
//   prize_pool — the single incentive bucket: funded by fee-cut + donations + manual top-ups,
//                drained by join bonuses, jackpots, streak top-ups and lottery payouts.
const RESERVED_ADDRESSES = ['pool_fee', 'prize_pool'];
const PRIZE_POOL = 'prize_pool';
const POOL_FEE = 'pool_fee';

const flag = (v) => v === true || v === 'true';
const SECONDS_PER_DAY = 86400;

// Central incentive logic. Shares the sqlite singleton with the rest of the pool, so
// its mutations participate in any enclosing db.transaction() (e.g. rewards.js distribution).
class IncentivesManager {
  constructor(config) {
    this.config = config || {};
    this.db = getDb();
    this.settings = new PoolSettings(this.db);
  }

  // Parsed incentives config with booleans/JSON coerced (defaults arrive as strings).
  settingsView() {
    const s = this.settings.getSection('incentives');
    let events = s.lottery_special_events;
    if (typeof events === 'string') {
      try { events = JSON.parse(events); } catch (e) { events = []; }
    }
    return { ...s, lottery_special_events: Array.isArray(events) ? events : [] };
  }

  enabled() {
    return flag(this.settingsView().incentives_enabled);
  }

  // ─── Prize-pool bucket primitives ──────────────────────────────────────────
  ensureAccount(address) {
    this.db.prepare('INSERT OR IGNORE INTO miner_accounts (grin_address, balance) VALUES (?, 0)').run(address);
  }

  prizePoolBalance() {
    const row = this.db.prepare('SELECT balance FROM miner_accounts WHERE grin_address = ?').get(PRIZE_POOL);
    return row ? row.balance : 0;
  }

  // Low-level balance move + audit row. Writes REAL before/after snapshots, as rewards.js and
  // orphan-detector.js do — never 0 placeholders, which make the ledger unauditable (audit
  // archive §I5). Every prize-pool, donation, streak and lottery movement flows through here.
  // refId must be an integer (block height, draw id, or 0).
  _move(address, delta, eventType, refType, refId = 0) {
    this.ensureAccount(address);
    const before = this.db.prepare(
      'SELECT balance, balance_locked FROM miner_accounts WHERE grin_address = ?'
    ).get(address);
    this.db.prepare(
      'UPDATE miner_accounts SET balance = balance + ?, updated_at = unixepoch() WHERE grin_address = ?'
    ).run(delta, address);
    this.db.prepare(`
      INSERT INTO balance_log
        (grin_address, event_type, amount, balance_before, balance_after,
         locked_before, locked_after, reference_type, reference_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(address, eventType, Math.abs(delta), before.balance, before.balance + delta,
           before.balance_locked, before.balance_locked, refType, refId);
  }

  creditPrizePool(amount, refType, refId = 0) {
    if (amount > 0) this._move(PRIZE_POOL, amount, 'credit', refType, refId);
  }

  // Returns false (no movement) if the bucket can't cover it — prizes never overdraw.
  debitPrizePool(amount, refType, refId = 0) {
    if (amount <= 0) return true;
    if (this.prizePoolBalance() < amount) return false;
    this._move(PRIZE_POOL, -amount, 'debit', refType, refId);
    return true;
  }

  // Recent prize-pool ledger for the admin panel.
  prizePoolLedger(limit = 25) {
    return this.db.prepare(`
      SELECT event_type, amount, reference_type, reference_id, created_at
      FROM balance_log WHERE grin_address = ?
      ORDER BY created_at DESC LIMIT ?
    `).all(PRIZE_POOL, limit);
  }

  // Full prize-pool "where it comes from / where it goes" statement — lifetime in/out totals
  // broken down by source, current balance, and the recent ledger. Composite read over the
  // ledger-rollup horizon (rollup for day < H + raw for created_at >= H) so totals stay exact
  // forever after raw balance_log rows are pruned. Powers both the admin panel and the public
  // /api/pool/prize-pool transparency report. `recentLimit` rows of raw detail (0 = none).
  prizePoolStatement(recentLimit = 25) {
    const H = getHorizon(this.db); // 0 = no rollup yet → whole ledger is raw
    const rows = this.db.prepare(`
      SELECT event_type, reference_type, SUM(amt) AS amount, SUM(cnt) AS count FROM (
        SELECT event_type, reference_type, total_amount AS amt, event_count AS cnt
        FROM balance_log_daily WHERE grin_address = ? AND day < ?
        UNION ALL
        SELECT event_type, reference_type, amount, 1
        FROM balance_log WHERE grin_address = ? AND created_at >= ?
      ) GROUP BY event_type, reference_type
    `).all(PRIZE_POOL, H, PRIZE_POOL, H);

    // Human labels for each reference_type. Inflows are credits, outflows are debits; a reversal
    // that is NOT a withdrawal returns funds TO the bucket, so it counts as an inflow. This is a
    // DISPLAY grouping only — reconciliation.js is the accounting authority. (A 'dormant' sweep is
    // terminal by policy: it only ever appears as a credit inflow here, never a reversal.)
    const IN_LABELS = {
      fee_cut: 'Pool-fee cut', donation: 'Miner donations', topup: 'Operator top-ups',
      dormant: 'Abandoned balances', jackpot_reversal: 'Orphaned-block clawbacks',
    };
    const OUT_LABELS = {
      prize_award: 'Operator awards', lottery: 'Lottery & daily giveaway', jackpot: 'Block-finder jackpots',
      join_bonus: 'Join bonuses', streak: 'Loyalty streaks',
    };
    const inflow = {}; const outflow = {};
    let inTotal = 0; let outTotal = 0;
    for (const row of rows) {
      const amt = Number(row.amount) || 0;
      const isIn = row.event_type === 'credit' ||
        (row.event_type === 'reversal' && row.reference_type !== 'withdrawal');
      const bucket = isIn ? inflow : outflow;
      const labels = isIn ? IN_LABELS : OUT_LABELS;
      const key = row.reference_type;
      const label = labels[key] || (key.charAt(0).toUpperCase() + key.slice(1).replace(/_/g, ' '));
      bucket[key] = bucket[key] || { key, label, amount: 0, count: 0 };
      bucket[key].amount = r9(bucket[key].amount + amt);
      bucket[key].count += Number(row.count) || 0;
      if (isIn) inTotal += amt; else outTotal += amt;
    }
    const bySorted = (obj) => Object.values(obj).sort((a, b) => b.amount - a.amount);

    return {
      balance: r9(this.prizePoolBalance()),
      in: { total: r9(inTotal), by: bySorted(inflow) },
      out: { total: r9(outTotal), by: bySorted(outflow) },
      net: r9(inTotal - outTotal),
      recent: recentLimit > 0 ? this.prizePoolLedger(recentLimit) : [],
    };
  }

  // ─── Per-address incentive state ───────────────────────────────────────────
  incentiveRow(address) {
    this.db.prepare('INSERT OR IGNORE INTO miner_incentives (grin_address) VALUES (?)').run(address);
    return this.db.prepare('SELECT * FROM miner_incentives WHERE grin_address = ?').get(address);
  }

  // Would a `donateN` tag take a cut right now? Mirrors the two flags applyToDistribution
  // checks, so every live reading (account page, wall, admin list) reports a donation only
  // when it is real (audit §J3-5) — a tag on a pool with donations switched off moves nothing.
  donationsActive() {
    const s = this.settingsView();
    return flag(s.incentives_enabled) && flag(s.allow_miner_donations);
  }

  // There is no stored donation %: rewards.js reads it per SHARE (design §18.2). The
  // miner_incentives.donation_percent column (the v1 per-address percentage, audit §J6-7) is
  // kept in the schema but read by nothing.

  // Streak multiplier as a fraction (e.g. 0.03 for +3%). Returns 0 if the streak is stale
  // (the address didn't mine today or yesterday) or streaks are disabled. A last_active_day after
  // today was written under a clock that ran ahead; it is stale too, never a streak kept alive.
  streakMultiplier(address, s = this.settingsView()) {
    if (!flag(s.streak_enabled)) return 0;
    const row = this.db.prepare('SELECT streak_days, last_active_day FROM miner_incentives WHERE grin_address = ?').get(address);
    if (!row || !row.last_active_day) return 0;
    const today = Math.floor(Date.now() / 1000 / SECONDS_PER_DAY);
    if (row.last_active_day < today - 1 || row.last_active_day > today) return 0; // streak broken
    const weeks = Math.floor(row.streak_days / 7);
    if (weeks <= 0) return 0;
    const pct = Math.min(weeks * s.streak_bonus_per_week_percent, s.streak_max_percent);
    return pct / 100;
  }

  // ─── Hook called by rewards.js (inside its distribution transaction) ────────
  // minerMap: Map<grin_address, grossPayout>. poolFee: the operator fee already credited to
  // pool_fee by rewards.js. donateMap: Map<grin_address, Σ share credit × that share's donate
  // %> — built per SHARE by rewards.js (design §18.2); absent/empty = nobody donates. This
  // rebalances those base credits into the incentive system:
  //   1. divert prize_fee_cut_percent of the fee from pool_fee → prize_pool
  //   2. divert each address's donateMap amount (≤ its gross) → prize_pool
  //   3. top up each miner with their streak bonus, funded from prize_pool
  applyToDistribution(blockHeight, minerMap, poolFee, donateMap = null) {
    const s = this.settingsView();
    if (!flag(s.incentives_enabled)) return;

    // 1. Fee cut → prize pool (net-zero move out of pool_fee).
    const cut = (poolFee || 0) * (s.prize_fee_cut_percent / 100);
    if (cut > 0) {
      this._move(POOL_FEE, -cut, 'debit', 'fee_cut', blockHeight);
      this.creditPrizePool(cut, 'fee_cut', blockHeight);
    }

    // 2. Voluntary miner donations → prize pool. Iterates minerMap, not donateMap, so only an
    // address this block actually credited can be debited. The clamp is float-drift insurance:
    // a donate100-only address sums to exactly its gross, and nothing may take more than that.
    // Ledger shape (same as v1 rows): one debit per address per block, one prize-pool credit.
    if (flag(s.allow_miner_donations) && donateMap && typeof donateMap.get === 'function') {
      for (const [address, gross] of minerMap) {
        if (RESERVED_ADDRESSES.includes(address)) continue;
        const want = Number(donateMap.get(address)) || 0;
        const donated = Math.min(want, gross);
        if (Number.isFinite(donated) && donated > 0) {
          this._move(address, -donated, 'debit', 'donation', blockHeight);
          this.creditPrizePool(donated, 'donation', blockHeight);
        }
      }
    }

    // 3. Loyalty streak top-ups, funded from the prize pool (never dilutes base PPLNS).
    if (flag(s.streak_enabled)) {
      for (const [address, gross] of minerMap) {
        if (RESERVED_ADDRESSES.includes(address)) continue;
        const mult = this.streakMultiplier(address, s);
        if (mult > 0) {
          const bonus = gross * mult;
          if (this.debitPrizePool(bonus, 'streak', blockHeight)) {
            this._move(address, bonus, 'credit', 'streak', blockHeight);
          }
        }
      }
    }
  }

  // ─── Join bonus ────────────────────────────────────────────────────────────
  // Called when an address's first withdrawal confirms. One-time, funded from prize_pool,
  // idempotent via miner_incentives.join_bonus_paid. Leaves the flag unset (will retry) if
  // the bucket can't fund it yet.
  maybePayJoinBonus(address) {
    const s = this.settingsView();
    if (!flag(s.incentives_enabled) || !flag(s.join_bonus_enabled)) return false;
    if (RESERVED_ADDRESSES.includes(address)) return false;
    const amount = parseFloat(s.join_bonus_amount);
    if (!(amount > 0)) return false;

    const tx = this.db.transaction(() => {
      const row = this.incentiveRow(address);
      if (row.join_bonus_paid) return false;
      if (!this.debitPrizePool(amount, 'join_bonus', 0)) return false; // insufficient — retry later
      this._move(address, amount, 'credit', 'join_bonus', 0);
      this.db.prepare('UPDATE miner_incentives SET join_bonus_paid = 1, updated_at = unixepoch() WHERE grin_address = ?').run(address);
      return true;
    });
    return tx();
  }

  // ─── Manual prize/bonus award to a single address ──────────────────────────
  // Operator awards a contest/incentive prize straight to a miner's address balance.
  // Address-as-identity: no account needed — the credit lands on miner_accounts and pays
  // out to that address via the normal Tor withdrawal flow. Funded from the prize_pool
  // bucket by default (so it's backed by real GRIN already in the wallet); pass
  // fromPrizePool=false to mint a fresh credit (operator must ensure wallet funds exist).
  // The human-readable note is recorded by the caller in admin_audit_log.
  // Returns { ok, reason?, balance } — ok=false with reason='insufficient_prize_pool'
  // when the bucket can't cover a prize-pool-funded award.
  awardPrize(address, amount, { fromPrizePool = true } = {}) {
    const addr = String(address || '').trim();
    const amt = parseFloat(amount);
    if (!addr) return { ok: false, reason: 'address required' };
    if (RESERVED_ADDRESSES.includes(addr)) return { ok: false, reason: 'cannot award a reserved address' };
    if (!(amt > 0)) return { ok: false, reason: 'amount must be > 0' };

    const tx = this.db.transaction(() => {
      if (fromPrizePool && !this.debitPrizePool(amt, 'prize_award', 0)) return false; // insufficient
      this._move(addr, amt, 'credit', 'prize_award', 0);
      return true;
    });
    if (!tx()) return { ok: false, reason: 'insufficient_prize_pool' };

    const row = this.db.prepare('SELECT balance FROM miner_accounts WHERE grin_address = ?').get(addr);
    return { ok: true, balance: row ? row.balance : amt };
  }

  // ─── Block-finder jackpot ──────────────────────────────────────────────────
  // Flat bonus to block.found_by, due when the block matures (both maturity paths call this
  // right after their confirmBlock claim). If the prize pool cannot cover it, or older jackpots
  // are already waiting, it is recorded in jackpot_pending with the amount in force NOW and
  // payPendingJackpots pays it later — a confirmed block is never revisited, so skipping it
  // here would lose that jackpot for good. Idempotent per block: a credit already on the ledger
  // (address + height) or a pending row (keyed by block id) makes a repeat call a no-op.
  // Returns true only when it paid now.
  payBlockFinderJackpot(block) {
    const s = this.settingsView();
    if (!flag(s.incentives_enabled) || !flag(s.jackpot_enabled)) return false;
    const amount = parseFloat(s.jackpot_amount);
    if (!(amount > 0)) return false;
    const address = block && block.found_by;
    if (!address || RESERVED_ADDRESSES.includes(address)) return false;

    const outcome = this.db.transaction(() => {
      if (this._jackpotCredited(address, block.height)) return 'already';
      // A jackpot that matures while others wait joins the back of the queue, so a top-up
      // pays them in maturity order rather than to whichever block happens to mature next.
      const queued = this.db.prepare('SELECT 1 FROM jackpot_pending LIMIT 1').get();
      if (!queued && this.debitPrizePool(amount, 'jackpot', block.height)) {
        this._move(address, amount, 'credit', 'jackpot', block.height);
        return 'paid';
      }
      const r = this.db.prepare(`
        INSERT OR IGNORE INTO jackpot_pending (block_id, block_height, grin_address, amount)
        VALUES (?, ?, ?, ?)
      `).run(block.id, block.height, address, amount);
      return r.changes ? 'pending' : 'already';
    })();
    if (outcome === 'pending') {
      const waiting = this.pendingJackpotSummary();
      console.log(`[${new Date().toISOString()}] [jackpot] block ${block.height} (id ${block.id}): ` +
        `${amount} GRIN to ${address} is PENDING — prize pool holds ${r9(this.prizePoolBalance())} GRIN, ` +
        `${waiting.count} jackpot(s) waiting (${waiting.amount} GRIN)`);
    }
    return outcome === 'paid';
  }

  _jackpotCredited(address, height) {
    return !!this.db.prepare(`
      SELECT 1 FROM balance_log
      WHERE grin_address = ? AND reference_type = 'jackpot' AND reference_id = ? AND event_type = 'credit' LIMIT 1
    `).get(address, height);
  }

  // Pay waiting jackpots oldest first while the prize pool covers each one, and only while
  // incentives and the jackpot are both switched on (a switched-off jackpot keeps its queue for
  // when it is switched back on). Strict FIFO: the first jackpot the prize pool cannot cover
  // stops the sweep. Letting smaller, newer jackpots past it would let a steady stream of them
  // keep the oldest waiting indefinitely, and the public promise is "oldest first".
  // Each payment is one transaction with deleting its row, in the same ledger shape as a jackpot
  // paid at maturity; the credit check inside it turns a row whose credit already landed into a
  // delete, never a second payment.
  // Called from the block monitor's tick and after a manual top-up.
  payPendingJackpots() {
    const out = { paid: 0, dropped: 0, waiting: 0 };
    const rows = this.db.prepare(`
      SELECT p.block_id, p.block_height, p.grin_address, p.amount, b.status AS block_status
      FROM jackpot_pending p LEFT JOIN blocks b ON b.id = p.block_id
      ORDER BY p.created_at ASC, p.block_id ASC
    `).all();
    if (!rows.length) return out;
    const s = this.settingsView();
    if (!flag(s.incentives_enabled) || !flag(s.jackpot_enabled)) { out.waiting = rows.length; return out; }

    for (let i = 0; i < rows.length; i++) {
      const p = rows[i];
      // reverseJackpot deletes the row when its block orphans; this catches a row it missed.
      if (p.block_status === 'orphaned') {
        this.db.prepare('DELETE FROM jackpot_pending WHERE block_id = ?').run(p.block_id);
        out.dropped++;
        console.log(`[${new Date().toISOString()}] [jackpot] block ${p.block_height} (id ${p.block_id}) is orphaned — pending jackpot DROPPED`);
        continue;
      }
      const result = this.db.transaction(() => {
        if (!this.db.prepare('SELECT 1 FROM jackpot_pending WHERE block_id = ?').get(p.block_id)) return 'gone';
        if (!this._jackpotCredited(p.grin_address, p.block_height)) {
          if (!this.debitPrizePool(p.amount, 'jackpot', p.block_height)) return 'short';
          this._move(p.grin_address, p.amount, 'credit', 'jackpot', p.block_height);
        }
        this.db.prepare('DELETE FROM jackpot_pending WHERE block_id = ?').run(p.block_id);
        return 'paid';
      })();
      if (result === 'short') { out.waiting = rows.length - i; break; }
      if (result === 'paid') {
        out.paid++;
        console.log(`[${new Date().toISOString()}] [jackpot] block ${p.block_height} (id ${p.block_id}): pending ${p.amount} GRIN PAID to ${p.grin_address}`);
      }
    }
    return out;
  }

  // Jackpots waiting for the prize pool — admin panel only (a count and a total, no addresses).
  pendingJackpotSummary() {
    const row = this.db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(amount), 0) AS amt FROM jackpot_pending').get();
    return { count: row.n, amount: r9(row.amt) };
  }

  // A block that orphans: drop its pending jackpot, and claw back the jackpot IT earned.
  // The ledger keys a jackpot by height (reference_id) and blocks.height is not UNIQUE, so a
  // credit at this height may belong to another pool block there that matured. A credit is this
  // block's only if it went to this block's finder and no OTHER block at this height by that
  // finder is confirmed or paid — otherwise orphaning the losing block would take back the
  // winner's jackpot. Idempotent: a reversal row already on the ledger skips the credit.
  reverseJackpot(block) {
    if (!block) return;
    const dropped = this.db.prepare('DELETE FROM jackpot_pending WHERE block_id = ?').run(block.id);
    if (dropped.changes) {
      console.log(`[${new Date().toISOString()}] [jackpot] block ${block.height} (id ${block.id}) orphaned — pending jackpot DROPPED`);
    }
    const credits = this.db.prepare(`
      SELECT grin_address, amount FROM balance_log
      WHERE reference_type = 'jackpot' AND reference_id = ? AND event_type = 'credit'
    `).all(block.height);
    for (const c of credits) {
      if (c.grin_address !== block.found_by) continue;
      const sibling = this.db.prepare(`
        SELECT id FROM blocks
        WHERE height = ? AND id != ? AND found_by = ? AND status IN ('confirmed', 'paid') LIMIT 1
      `).get(block.height, block.id, c.grin_address);
      if (sibling) {
        console.log(`[${new Date().toISOString()}] [jackpot] block ${block.height} (id ${block.id}) orphaned — ` +
          `jackpot kept: it belongs to block id ${sibling.id} at the same height`);
        continue;
      }
      const reversed = this.db.prepare(`
        SELECT 1 FROM balance_log
        WHERE grin_address = ? AND reference_type = 'jackpot' AND reference_id = ? AND event_type = 'reversal' LIMIT 1
      `).get(c.grin_address, block.height);
      if (reversed) continue;
      const tx = this.db.transaction(() => {
        this._move(c.grin_address, -c.amount, 'reversal', 'jackpot', block.height);
        this.creditPrizePool(c.amount, 'jackpot_reversal', block.height);
      });
      tx();
    }
  }

  // ─── Loyalty streak updater ────────────────────────────────────────────────
  // A UTC day counts for an address if it mined with work that day, read from hashrate_history
  // (the same activity source as lottery eligibility) or, for a completed day already rolled up,
  // from its per-address daily rollup miner_hashrate_daily (gps_seconds > 0 exactly when the day
  // had a sample with work). Raw shares are not usable here: retention keeps only confirm depth +
  // PPLNS window + margin blocks of them (~31 h on mainnet, ~9 h on testnet), so late in a day
  // yesterday's early shares are already gone.
  // Run at boot and hourly. Each run covers the persisted scan mark (a little before the last
  // run) to now, never from before the start of YESTERDAY, and counts each day it covers in
  // order — yesterday, then today — so a day with mining counts whenever the pool was up during
  // it, including a miner that started after the last run of that day. Yesterday is read from
  // the rollup once HashrateTracker.rollupMinerDays has rolled it (within a minute of midnight),
  // so only today's raw rows are ever scanned and an hourly run reads about an hour of them.
  // maxRawSeconds caps how much raw time one call reads (the scan mark then stops where it
  // stopped and caughtUp is false): the first run after a deploy or an outage has up to a day of
  // raw rows to read, ~1.3 s at 1000 miners in one synchronous call on the DB the stratum server
  // shares, so index.js reads it in slices and yields to the event loop between them.
  // Per address and day: a day at or before last_active_day is skipped (already counted; and
  // last_active_day never moves backwards), the day after it extends the streak, anything later
  // restarts it at 1. A last_active_day after today (written under a clock that ran ahead) is
  // stale and restarts it too. Older days are not walked after a longer outage: with a whole day
  // missing the streak restarts at 1 anyway. streakMultiplier reads the result.
  static STREAK_SCAN_OVERLAP = 300;

  updateStreaks(nowSec = Math.floor(Date.now() / 1000), maxRawSeconds = Infinity) {
    const today = Math.floor(nowSec / SECONDS_PER_DAY);
    const floor = (today - 1) * SECONDS_PER_DAY;
    const mark = this._streakScanMark();
    // A mark ahead of the clock (clock moved back, a restored backup) is not trusted: rescan
    // from the floor, which is harmless because a counted day is skipped.
    const from = mark > nowSec ? floor : Math.max(floor, mark - IncentivesManager.STREAK_SCAN_OVERLAP);
    const rolledTo = this._minerDayRollupHorizon();
    // Bounded on BOTH sides, like every hashrate_history range read, so it SEARCHes
    // idx_hashrate_time for the window only (scripts/test-shares-plans.js pins the plan).
    const activeIn = this.db.prepare(`
      SELECT DISTINCT grin_address FROM hashrate_history
      WHERE recorded_at >= ? AND recorded_at < ? AND hashrate_gps > 0`);
    const activeOnRolledDay = this.db.prepare(
      'SELECT grin_address FROM miner_hashrate_daily WHERE day = ? AND gps_seconds > 0');
    const setStreak = this.db.prepare(
      'UPDATE miner_incentives SET streak_days = ?, last_active_day = ?, updated_at = unixepoch() WHERE grin_address = ?');
    let active = 0; let updated = 0;
    let cursor = from; let budget = maxRawSeconds;
    const tx = this.db.transaction(() => {
      for (let day = Math.floor(from / SECONDS_PER_DAY); day <= today && budget > 0; day++) {
        const dayStart = day * SECONDS_PER_DAY;
        const start = Math.max(from, dayStart);
        const rolled = day < today && dayStart + SECONDS_PER_DAY <= rolledTo;
        const end = Math.min(nowSec + 1, dayStart + SECONDS_PER_DAY, rolled ? Infinity : start + budget);
        if (start >= end) continue;
        if (!rolled) budget -= end - start;
        cursor = end;
        const rows = rolled ? activeOnRolledDay.all(dayStart) : activeIn.all(start, end);
        for (const { grin_address } of rows) {
          if (RESERVED_ADDRESSES.includes(grin_address)) continue;
          active++;
          const row = this.incentiveRow(grin_address);
          const last = row.last_active_day !== null && row.last_active_day <= today ? row.last_active_day : null;
          if (last !== null && last >= day) continue;
          const newDays = last === day - 1 ? row.streak_days + 1 : 1;
          setStreak.run(newDays, day, grin_address);
          updated++;
        }
      }
      // The mark moves in the SAME transaction as the updates it covers, so a crash leaves both
      // unchanged and the next run repeats the window.
      this.db.prepare(`
        INSERT INTO pool_config (section, key, value, value_type)
        VALUES ('_state', 'streak_scan_mark', ?, 'string')
        ON CONFLICT(section, key) DO UPDATE SET value = excluded.value
      `).run(String(Math.min(cursor, nowSec)));
    });
    tx();
    return { active, updated, caughtUp: cursor > nowSec };
  }

  // HashrateTracker's miner_hashrate_daily horizon: the first UTC day (as a unix-second day start)
  // NOT yet rolled up; every day before it is complete in the rollup. 0 = nothing rolled.
  _minerDayRollupHorizon() {
    try {
      const row = this.db.prepare(
        "SELECT value FROM pool_config WHERE section = '_state' AND key = 'miner_hashrate_day_horizon'").get();
      const v = row ? parseInt(row.value, 10) : 0;
      return Number.isFinite(v) && v > 0 ? v : 0;
    } catch (e) { return 0; }
  }

  _streakScanMark() {
    try {
      const row = this.db.prepare(
        "SELECT value FROM pool_config WHERE section = '_state' AND key = 'streak_scan_mark'").get();
      const v = row ? parseInt(row.value, 10) : 0;
      return Number.isFinite(v) && v > 0 ? v : 0;
    } catch (e) { return 0; }
  }

  // Manual operator top-up of the prize bucket (accounting only — real GRIN must be in wallet).
  manualTopup(amount) {
    const amt = parseFloat(amount);
    // Finite, not just > 0 (audit §J7-5): parseFloat('Infinity') passes `> 0`, and
    // `balance = balance + Infinity` on a REAL column is permanent — every later finite
    // correction leaves it at Infinity, JSON.stringify reports it as `null`, and
    // debitPrizePool()'s `prizePoolBalance() < amount` guard is then off for good.
    if (!Number.isFinite(amt) || amt <= 0) throw new Error('top-up amount must be a positive, finite number');
    this.creditPrizePool(amt, 'topup', 0);
    // A top-up is usually made to cover waiting jackpots: pay them now rather than on the block
    // monitor's next tick. The top-up itself has already landed, so a failure here only defers
    // them to that tick. The returned balance is after any payment.
    try { this.payPendingJackpots(); }
    catch (e) { console.error(`[jackpot] pending sweep after top-up failed: ${e.message}`); }
    return this.prizePoolBalance();
  }

  // Public-safe summary for the branding payload / admin dashboard.
  publicSummary() {
    return { prize_pool_grin: Number(this.prizePoolBalance().toFixed(9)) };
  }
}

IncentivesManager.RESERVED_ADDRESSES = RESERVED_ADDRESSES;
IncentivesManager.PRIZE_POOL = PRIZE_POOL;
// Exported so the withdrawal scheduler can credit the flat payout fee to the same
// pseudo-address the block-reward fee uses, without re-declaring the literal.
IncentivesManager.POOL_FEE = POOL_FEE;

module.exports = IncentivesManager;
