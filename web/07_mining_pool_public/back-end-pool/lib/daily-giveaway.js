// Daily giveaway — every UTC day the pool gives a random total, between two operator-set limits,
// split into a random number of equal prizes, between two more limits. Contract: script07_design.md "Daily
// giveaway".
//
// Each prize is its own pick from the whole entry list, weighted by work, so a pick's odds are
// exactly a share of the work. Splitting an address divides that share and adds nothing to it,
// which is why there is no cap and no one-win limit: both would pay for splitting.
//
// Rides the lottery's commit-reveal (script07_security_audit_archive.md §I8): commit() freezes the
// entry list, the rules and the prize pool figure and names a future seed block; settle() runs once
// that block exists and derives EVERYTHING from its hash — amount, prize count, winners. Given
// those frozen inputs the seed alone fixes the outcome, and Math.random() must never enter this
// path. The frozen inputs live in the pool DB and are not published, so this binds the pool's own
// code and admin actions; it is not proof an outsider can check.
//
// Money moves only in settle(), inside one transaction, claimed by a status compare-and-swap.
// Amounts are rolled in integer nanogrin so the bounds are exact; a share is rounded DOWN, and the
// dust stays in the prize pool.
const crypto = require('crypto');
const IncentivesManager = require('./incentives');
const { GIVEAWAY_GRIN_LIMIT } = require('./pool-settings');

const SECONDS_PER_DAY = 86400;
const NANO = 1e9;
const EVENT_NAME = 'Daily giveaway';
const POT = 'd';
const MAX_WINNERS = 1000; // the ceiling pool-settings enforces on save
// Preview runs a synchronous scan of the DB that takes shares, so repeat clicks reuse the answer.
const PREVIEW_CACHE_MS = 60000;
const PREVIEW_TOP_MINERS = 5;

const flag = (v) => v === true || v === 'true';

class DailyGiveaway {
  // lottery is the LotteryManager class, for its seeded maths: passed in because lottery.js
  // requires this file.
  constructor(db, incentives, grinNode, lottery, seedDelayBlocks) {
    this.db = db;
    this.incentives = incentives;
    this.grinNode = grinNode;
    this.lottery = lottery;
    this.seedDelayBlocks = seedDelayBlocks;
    this.previewCache = null;
    // For the admin page only, so both reset on restart until the next tick refills them. Neither
    // state writes a row: a skipped day has none, and a held draw just stays 'committed'.
    this.lastSkip = null;
    this.holds = new Map(); // draw id → 'off' | 'short'
  }

  status() {
    return { last_skip: this.lastSkip, holds: Object.fromEntries(this.holds) };
  }

  // Settings as validated numbers, or null when they cannot make a draw. pool-settings checks
  // these on save; this re-checks because a row can also arrive through a restored config.
  rules() {
    const s = this.incentives.settingsView();
    const r = {
      min_grin: parseFloat(s.daily_giveaway_min_grin),
      max_grin: parseFloat(s.daily_giveaway_max_grin),
      min_winners: parseInt(s.daily_giveaway_min_winners, 10),
      max_winners: parseInt(s.daily_giveaway_max_winners, 10),
      min_active_hours: parseInt(s.daily_giveaway_min_active_hours, 10),
    };
    const valid = Number.isFinite(r.min_grin) && Number.isFinite(r.max_grin)
      && r.min_grin >= 1 / NANO && r.max_grin >= r.min_grin && r.max_grin < GIVEAWAY_GRIN_LIMIT
      && Number.isInteger(r.min_winners) && Number.isInteger(r.max_winners)
      && r.min_winners >= 1 && r.max_winners >= r.min_winners && r.max_winners <= MAX_WINNERS
      && Number.isInteger(r.min_active_hours) && r.min_active_hours >= 1 && r.min_active_hours <= 24;
    return valid ? r : null;
  }

  enabled() {
    const s = this.incentives.settingsView();
    return flag(s.incentives_enabled) && flag(s.daily_giveaway_enabled);
  }

  // What the public fortune board may say about the giveaway; null while it is off.
  publicRules() {
    return this.enabled() ? this.rules() : null;
  }

  // The last COMPLETED UTC day: [00:00 yesterday, 00:00 today).
  static previousDay(nowSec) {
    const end = Math.floor(nowSec / SECONDS_PER_DAY) * SECONDS_PER_DAY;
    return { start: end - SECONDS_PER_DAY, end };
  }

  // Addresses that mined for at least minActiveHours of [start, end), with their work in that time,
  // sorted because the pick walks this order. Banned addresses never qualify. The hours gate only
  // keeps out short visits; the odds come from the work.
  eligibleEntries(start, end, minActiveHours) {
    const reserved = IncentivesManager.RESERVED_ADDRESSES;
    const marks = reserved.map(() => '?').join(',');
    return this.db.prepare(`
      SELECT grin_address AS address, SUM(hashrate_gps * window_seconds) AS work
      FROM hashrate_history
      WHERE recorded_at >= ? AND recorded_at < ?
        AND hashrate_gps > 0
        AND grin_address NOT IN (${marks})
        AND grin_address NOT IN (SELECT grin_address FROM miner_accounts WHERE is_banned = 1)
      GROUP BY grin_address
      HAVING SUM(window_seconds) >= ?
      ORDER BY grin_address ASC
    `).all(start, end, ...reserved, minActiveHours * 3600);
  }

  // The whole outcome from a seed: pure, so the real settle() and the admin preview cannot drift
  // apart. entries are [{ address, tickets }]; winners come back as [{ address, wins }]. Every
  // rolled prize is paid, so fewer miners than prizes means more wins each, not a smaller total.
  plan(seedHash, salt, entries, rules, prizePool) {
    const minNano = Math.round(rules.min_grin * NANO);
    const maxNano = Math.round(rules.max_grin * NANO);
    const rolledNano = minNano + this.lottery.seededMod(seedHash, `${salt}:amount`, maxNano - minNano + 1);
    const rolledPrizes = rules.min_winners
      + this.lottery.seededMod(seedHash, `${salt}:count`, rules.max_winners - rules.min_winners + 1);

    const totalNano = Math.min(rolledNano, Math.floor(prizePool * NANO));
    // Never more prizes than whole nanogrin to share, or a dust pool would pay nobody.
    const count = entries.length ? Math.max(0, Math.min(rolledPrizes, totalNano)) : 0;

    const wins = new Map();
    for (let i = 0; i < count; i++) {
      const { address } = this.lottery.pickWeighted(seedHash, `${salt}:pick:${i}`, entries);
      wins.set(address, (wins.get(address) || 0) + 1);
    }

    // prizePool is a REAL: floor(pool × 1e9) can land one nanogrin above the true balance, and the
    // debit in settle() refuses anything above it.
    let shareNano = count > 0 ? Math.floor(totalNano / count) : 0;
    if (shareNano > 0 && (shareNano * count) / NANO > prizePool) shareNano -= 1;
    return {
      rolled_grin: rolledNano / NANO,
      winners: [...wins].map(([address, n]) => ({ address, wins: n })),
      share_grin: shareNano / NANO,
      total_grin: (shareNano * count) / NANO,
    };
  }

  // COMMIT. The prize pool figure is frozen with the rules, so emptying the pool once the seed is
  // public cannot change the result. A row in 'committed' or 'empty' closes the period: the partial
  // unique index idx_lottery_daily_once makes a second commit for one scheduled day impossible,
  // whatever the scheduler does. An underfunded day writes NO row, so a top-up later that day still
  // draws it.
  //
  // onlyIfNoneOpen is checked INSIDE the transaction because the node call above it can take
  // seconds, and two Run-now requests have different period_starts, so the index cannot stop them.
  async commit(period, { onlyIfNoneOpen = false } = {}) {
    const rules = this.rules();
    if (!rules) return { success: false, reason: 'bad_rules' };

    const bucket = this.incentives.prizePoolBalance();
    if (bucket < rules.min_grin) {
      return { success: false, reason: 'underfunded', prize_pool: bucket, min_grin: rules.min_grin };
    }

    let tip;
    try {
      tip = await this.grinNode.getTip();
    } catch (err) {
      return { success: false, reason: 'no_seed', error: err.message };
    }
    if (!tip || !Number.isFinite(Number(tip.height))) return { success: false, reason: 'no_seed' };
    const seedHeight = Math.floor(Number(tip.height)) + this.seedDelayBlocks;

    const entries = this.lottery.buildWeightedTickets(
      this.eligibleEntries(period.start, period.end, rules.min_active_hours), 0
    );
    const tx = this.db.transaction(() => {
      if (onlyIfNoneOpen && this._openDraw()) return null;
      const info = this.db.prepare(`
        INSERT INTO lottery_draws
          (draw_type, event_name, period_start, period_end, seed_height, status, rules_json)
        VALUES ('daily', ?, ?, ?, ?, ?, ?)
      `).run(EVENT_NAME, period.start, period.end, seedHeight,
             entries.length ? 'committed' : 'empty', JSON.stringify({ ...rules, prize_pool: bucket }));
      const ins = this.db.prepare(
        'INSERT INTO lottery_entries (draw_id, grin_address, tickets_a, tickets_b) VALUES (?, ?, 0, ?)'
      );
      for (const e of entries) ins.run(info.lastInsertRowid, e.address, e.tickets);
      return info.lastInsertRowid;
    });

    let drawId;
    try {
      drawId = tx();
    } catch (err) {
      if (/UNIQUE/i.test(err.message)) return { success: false, reason: 'already_drawn' };
      throw err;
    }
    if (drawId === null) {
      const open = this._openDraw();
      return { success: false, reason: 'draw_open', draw_id: open && open.id };
    }
    console.log(
      `[${new Date().toISOString()}] Daily giveaway ${drawId} COMMITTED: ${entries.length} ` +
      `eligible, seed = block ${seedHeight} (tip ${tip.height})`
    );
    return { success: true, committed: true, draw_id: drawId, eligible: entries.length, seed_height: seedHeight };
  }

  // REVEAL + pay, called by LotteryManager.resolveDraw once the seed header is in hand. Returning
  // null leaves the draw 'committed' for a later tick, which is how both stops work:
  //   switch off   the incident brake. It defers and never closes the draw, because closing it
  //                after the seed is public would be a free veto; the hash cannot change, so a
  //                deferred draw cannot be re-rolled.
  //   pool short   held until topped up, for the same reason: never closed as paid-nothing.
  // A winner banned after commit forfeits: the picks stay as the seed made them, and that share
  // stays in the prize pool.
  settle(draw, header) {
    if (!this.enabled()) {
      console.warn(`[Daily giveaway] draw ${draw.id} deferred: the giveaway is switched off`);
      this.holds.set(draw.id, 'off');
      return null;
    }
    const rules = JSON.parse(draw.rules_json);
    const entries = this.db.prepare(
      'SELECT grin_address AS address, tickets_b AS tickets FROM lottery_entries WHERE draw_id = ? ORDER BY grin_address ASC'
    ).all(draw.id);

    // Returns the winners, null if another resolver claimed the draw, or 'short' if the pool cannot
    // cover it.
    const tx = this.db.transaction(() => {
      const plan = this.plan(header.hash, draw.id, entries, rules, rules.prize_pool);
      const isBanned = this.db.prepare('SELECT 1 FROM miner_accounts WHERE grin_address = ? AND is_banned = 1');
      const payees = plan.winners.filter((w) => !isBanned.get(w.address));
      const shareNano = Math.round(plan.share_grin * NANO);
      const total = (shareNano * payees.reduce((sum, w) => sum + w.wins, 0)) / NANO;
      if (this.incentives.prizePoolBalance() < total) return 'short';

      // Claim before paying: a replayed tick changes 0 rows and leaves before any prize is paid.
      const claimed = this.db.prepare(
        "UPDATE lottery_draws SET seed_hash = ?, drawn_at = unixepoch(), status = 'drawn' WHERE id = ? AND status = 'committed'"
      ).run(header.hash, draw.id);
      if (claimed.changes !== 1) return null;

      const winners = [];
      if (total > 0) {
        // ONE debit for the whole draw. Per-winner debits on REAL balances can leave the last
        // winner a rounding error short and silently unpaid. A refused debit rolls the draw back
        // to 'committed' for the next tick: a draw pays all its winners or none.
        if (!this.incentives.debitPrizePool(total, 'lottery', draw.id)) {
          throw new Error(`daily giveaway ${draw.id}: prize pool refused ${total}`);
        }
        for (const { address, wins } of payees) {
          const amount = (shareNano * wins) / NANO;
          this.incentives._move(address, amount, 'credit', 'lottery', draw.id);
          this.db.prepare(`
            INSERT INTO lottery_winners (draw_id, grin_address, pot, ticket_count, amount)
            VALUES (?, ?, ?, ?, ?)
          `).run(draw.id, address, POT, wins, amount);
          winners.push({ address, pot: POT, wins, amount });
        }
        this.db.prepare("UPDATE lottery_draws SET status = 'paid' WHERE id = ?").run(draw.id);
      }
      return winners;
    });

    const winners = tx();
    if (winners === null) return null;
    if (winners === 'short') {
      console.error(`[Daily giveaway] draw ${draw.id} held: the prize pool cannot cover it. Top it up to pay.`);
      this.holds.set(draw.id, 'short');
      return null;
    }
    this.holds.delete(draw.id);
    console.log(
      `[${new Date().toISOString()}] Daily giveaway ${draw.id} RESOLVED from block ` +
      `${draw.seed_height} (${header.hash}): ${winners.length} winner(s)`
    );
    return { success: true, draw_id: draw.id, seed_height: draw.seed_height, seed_hash: header.hash, winners };
  }

  // Scheduler entry point, hourly. Only the last completed day is drawn: a pool that was down for
  // three days does not pay three days at once.
  async runDue(now = Date.now()) {
    if (!this.enabled()) {
      this.lastSkip = null;
      return null;
    }
    const { start, end } = DailyGiveaway.previousDay(Math.floor(now / 1000));
    const done = this.db.prepare(
      "SELECT 1 FROM lottery_draws WHERE draw_type = 'daily' AND period_start = ? LIMIT 1"
    ).get(start);
    if (done) return null;
    const res = await this.commit({ start, end });
    if (res.success) {
      this.lastSkip = null;
    } else {
      console.warn(`[Daily giveaway] not drawn for ${start}: ${res.reason}`);
      this.lastSkip = {
        at: Math.floor(now / 1000), reason: res.reason, prize_pool: res.prize_pool, min_grin: res.min_grin,
      };
    }
    return res;
  }

  // Admin "Run now": an EXTRA real draw over the last 24 h, for proving the path on a live pool.
  // It does not replace the scheduled draw. One open draw at a time, so a double click cannot
  // queue two payouts.
  async runNow(now = Date.now()) {
    if (!this.enabled()) return { success: false, reason: 'disabled' };
    const open = this._openDraw();
    if (open) return { success: false, reason: 'draw_open', draw_id: open.id };
    const end = Math.floor(now / 1000);
    return this.commit({ start: end - SECONDS_PER_DAY, end }, { onlyIfNoneOpen: true });
  }

  _openDraw() {
    return this.db.prepare(
      "SELECT id FROM lottery_draws WHERE draw_type = 'daily' AND status = 'committed' LIMIT 1"
    ).get();
  }

  // Read-only rehearsal for the admin panel: `days` simulated days over the real eligible miners
  // plus `extraMiners` invented ones, each doing the real miners' average work. Writes nothing, so
  // it can run on the live pool at any time. Uses plan(), the same function that pays real prizes,
  // on throwaway random seeds. top_real is the odds: a share of the tickets the real list alone
  // would hold, so pretend miners never dilute it.
  preview({ extraMiners = 0, days = 7, now = Date.now() } = {}) {
    const rules = this.rules();
    if (!rules) return { success: false, reason: 'bad_rules' };
    const { start, end } = DailyGiveaway.previousDay(Math.floor(now / 1000));
    const key = `${start}:${rules.min_active_hours}`;
    if (!this.previewCache || this.previewCache.key !== key || now - this.previewCache.at >= PREVIEW_CACHE_MS) {
      this.previewCache = { key, at: now, real: this.eligibleEntries(start, end, rules.min_active_hours) };
    }
    const real = this.previewCache.real;
    const averageWork = real.length ? real.reduce((sum, e) => sum + e.work, 0) / real.length : 1;
    const pretend = Array.from({ length: extraMiners }, (_, i) => ({
      address: `pretend-miner-${String(i + 1).padStart(3, '0')}`, work: averageWork,
    }));
    const entries = this.lottery.buildWeightedTickets(real.concat(pretend), 0);
    const prizePool = this.incentives.prizePoolBalance();
    const realTickets = this.lottery.buildWeightedTickets(real, 0);
    const realTotal = realTickets.reduce((sum, e) => sum + e.tickets, 0);
    const topReal = [...realTickets]
      .sort((a, b) => b.tickets - a.tickets || (a.address < b.address ? -1 : 1))
      .slice(0, PREVIEW_TOP_MINERS)
      .map((e) => ({ address: e.address, work_share: e.tickets / realTotal }));

    let left = prizePool;
    const simulated = [];
    for (let day = 1; day <= days; day++) {
      if (left < rules.min_grin) {
        simulated.push({ day, skipped: 'underfunded', prize_pool_after: left });
        continue;
      }
      const seed = crypto.randomBytes(32).toString('hex');
      const p = this.plan(seed, `preview:${day}`, entries, rules, left);
      left -= p.total_grin;
      simulated.push({
        day, winners: p.winners, share_grin: p.share_grin, total_grin: p.total_grin, prize_pool_after: left,
      });
    }
    return {
      success: true,
      enabled: this.enabled(),
      rules,
      real_eligible: real.length,
      top_real: topReal,
      pretend_miners: pretend.length,
      prize_pool: prizePool,
      days: simulated,
    };
  }
}

module.exports = DailyGiveaway;
