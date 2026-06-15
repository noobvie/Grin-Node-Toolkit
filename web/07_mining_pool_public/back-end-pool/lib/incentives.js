const { getDb } = require('./db');
const PoolSettings = require('./pool-settings');

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

  // Low-level balance move + audit row. Mirrors the 0-snapshot convention used by
  // rewards.js / orphan-detector.js. refId must be an integer (block height, draw id, or 0).
  _move(address, delta, eventType, refType, refId = 0) {
    this.ensureAccount(address);
    this.db.prepare('UPDATE miner_accounts SET balance = balance + ? WHERE grin_address = ?').run(delta, address);
    this.db.prepare(`
      INSERT INTO balance_log
        (grin_address, event_type, amount, balance_before, balance_after,
         locked_before, locked_after, reference_type, reference_id)
      VALUES (?, ?, ?, 0, 0, 0, 0, ?, ?)
    `).run(address, eventType, Math.abs(delta), refType, refId);
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

  // ─── Per-address incentive state ───────────────────────────────────────────
  incentiveRow(address) {
    this.db.prepare('INSERT OR IGNORE INTO miner_incentives (grin_address) VALUES (?)').run(address);
    return this.db.prepare('SELECT * FROM miner_incentives WHERE grin_address = ?').get(address);
  }

  donationPercent(address) {
    const row = this.db.prepare('SELECT donation_percent FROM miner_incentives WHERE grin_address = ?').get(address);
    return row ? row.donation_percent : 0;
  }

  // Set a miner's voluntary donation %, parsed from the `donateN` worker-name tag at login.
  // No-op unless donations are enabled. Idempotent.
  setDonation(address, percent) {
    if (RESERVED_ADDRESSES.includes(address)) return;
    const s = this.settingsView();
    if (!flag(s.allow_miner_donations)) return;
    let p = parseFloat(percent);
    if (isNaN(p)) return;
    p = Math.max(0, Math.min(100, p));
    this.ensureAccount(address);
    this.db.prepare(`
      INSERT INTO miner_incentives (grin_address, donation_percent, updated_at)
      VALUES (?, ?, unixepoch())
      ON CONFLICT(grin_address) DO UPDATE SET donation_percent = excluded.donation_percent, updated_at = unixepoch()
    `).run(address, p);
  }

  // Streak multiplier as a fraction (e.g. 0.03 for +3%). Returns 0 if the streak is stale
  // (the address didn't mine today or yesterday) or streaks are disabled.
  streakMultiplier(address, s = this.settingsView()) {
    if (!flag(s.streak_enabled)) return 0;
    const row = this.db.prepare('SELECT streak_days, last_active_day FROM miner_incentives WHERE grin_address = ?').get(address);
    if (!row || !row.last_active_day) return 0;
    const today = Math.floor(Date.now() / 1000 / SECONDS_PER_DAY);
    if (row.last_active_day < today - 1) return 0; // streak broken
    const weeks = Math.floor(row.streak_days / 7);
    if (weeks <= 0) return 0;
    const pct = Math.min(weeks * s.streak_bonus_per_week_percent, s.streak_max_percent);
    return pct / 100;
  }

  // ─── Hook called by rewards.js (inside its distribution transaction) ────────
  // minerMap: Map<grin_address, grossPayout>. poolFee: the operator fee already credited to
  // pool_fee by rewards.js. This rebalances those base credits into the incentive system:
  //   1. divert prize_fee_cut_percent of the fee from pool_fee → prize_pool
  //   2. divert each miner's donation_percent of their payout → prize_pool
  //   3. top up each miner with their streak bonus, funded from prize_pool
  applyToDistribution(blockHeight, minerMap, poolFee) {
    const s = this.settingsView();
    if (!flag(s.incentives_enabled)) return;

    // 1. Fee cut → prize pool (net-zero move out of pool_fee).
    const cut = (poolFee || 0) * (s.prize_fee_cut_percent / 100);
    if (cut > 0) {
      this._move(POOL_FEE, -cut, 'debit', 'fee_cut', blockHeight);
      this.creditPrizePool(cut, 'fee_cut', blockHeight);
    }

    // 2. Voluntary miner donations → prize pool.
    if (flag(s.allow_miner_donations)) {
      for (const [address, gross] of minerMap) {
        if (RESERVED_ADDRESSES.includes(address)) continue;
        const pct = this.donationPercent(address);
        if (pct > 0) {
          const donated = gross * (pct / 100);
          if (donated > 0) {
            this._move(address, -donated, 'debit', 'donation', blockHeight);
            this.creditPrizePool(donated, 'donation', blockHeight);
          }
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
  // Flat bonus to block.found_by, paid when the block matures. Idempotent per block height.
  payBlockFinderJackpot(block) {
    const s = this.settingsView();
    if (!flag(s.incentives_enabled) || !flag(s.jackpot_enabled)) return false;
    const amount = parseFloat(s.jackpot_amount);
    if (!(amount > 0)) return false;
    const address = block && block.found_by;
    if (!address || RESERVED_ADDRESSES.includes(address)) return false;

    const already = this.db.prepare(`
      SELECT 1 FROM balance_log
      WHERE grin_address = ? AND reference_type = 'jackpot' AND reference_id = ? AND event_type = 'credit' LIMIT 1
    `).get(address, block.height);
    if (already) return false;

    const tx = this.db.transaction(() => {
      if (!this.debitPrizePool(amount, 'jackpot', block.height)) return false;
      this._move(address, amount, 'credit', 'jackpot', block.height);
      return true;
    });
    return tx();
  }

  // Claw back a block-finder jackpot when its block is orphaned. Idempotent.
  reverseJackpot(blockHeight) {
    const credits = this.db.prepare(`
      SELECT grin_address, amount FROM balance_log
      WHERE reference_type = 'jackpot' AND reference_id = ? AND event_type = 'credit'
    `).all(blockHeight);
    for (const c of credits) {
      if (c.grin_address === PRIZE_POOL) continue; // skip the funding-side debit's mirror
      const reversed = this.db.prepare(`
        SELECT 1 FROM balance_log
        WHERE grin_address = ? AND reference_type = 'jackpot' AND reference_id = ? AND event_type = 'reversal' LIMIT 1
      `).get(c.grin_address, blockHeight);
      if (reversed) continue;
      const tx = this.db.transaction(() => {
        this._move(c.grin_address, -c.amount, 'reversal', 'jackpot', blockHeight);
        this.creditPrizePool(c.amount, 'jackpot_reversal', blockHeight);
      });
      tx();
    }
  }

  // ─── Loyalty streak daily updater ──────────────────────────────────────────
  // Bumps streak_days for every address that submitted a valid share today (UTC). Run daily.
  updateStreaks() {
    const today = Math.floor(Date.now() / 1000 / SECONDS_PER_DAY);
    const dayStart = today * SECONDS_PER_DAY;
    const active = this.db.prepare('SELECT DISTINCT grin_address FROM shares WHERE created_at >= ?').all(dayStart);
    let updated = 0;
    const tx = this.db.transaction(() => {
      for (const { grin_address } of active) {
        if (RESERVED_ADDRESSES.includes(grin_address)) continue;
        const row = this.incentiveRow(grin_address);
        if (row.last_active_day === today) continue; // already counted today
        const newDays = row.last_active_day === today - 1 ? row.streak_days + 1 : 1;
        this.db.prepare('UPDATE miner_incentives SET streak_days = ?, last_active_day = ?, updated_at = unixepoch() WHERE grin_address = ?')
          .run(newDays, today, grin_address);
        updated++;
      }
    });
    tx();
    return { active: active.length, updated };
  }

  // Manual operator top-up of the prize bucket (accounting only — real GRIN must be in wallet).
  manualTopup(amount) {
    const amt = parseFloat(amount);
    if (!(amt > 0)) throw new Error('top-up amount must be > 0');
    this.creditPrizePool(amt, 'topup', 0);
    return this.prizePoolBalance();
  }

  // Public-safe summary for the branding payload / admin dashboard.
  publicSummary() {
    return { prize_pool_grin: Number(this.prizePoolBalance().toFixed(9)) };
  }
}

IncentivesManager.RESERVED_ADDRESSES = RESERVED_ADDRESSES;
IncentivesManager.PRIZE_POOL = PRIZE_POOL;

module.exports = IncentivesManager;
