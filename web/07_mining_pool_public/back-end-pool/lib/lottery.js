const crypto = require('crypto');
const { getDb } = require('./db');
const IncentivesManager = require('./incentives');

const flag = (v) => v === true || v === 'true';
const SECONDS_PER_DAY = 86400;
const WEEK_SECONDS = 7 * SECONDS_PER_DAY;

// Weekly + special-occasion lottery. Draws are publicly verifiable: the winner is selected
// deterministically from a node block hash (seed_hash) captured at draw time, so anyone can
// recompute the result from the seed + the public share data. Prizes are paid out of the
// prize_pool bucket managed by IncentivesManager.
class LotteryManager {
  constructor(config, grinNode) {
    this.config = config || {};
    this.db = getDb();
    this.grinNode = grinNode;
    this.incentives = new IncentivesManager(config);
  }

  settingsView() {
    return this.incentives.settingsView();
  }

  // Deterministic integer in [0, modulo) from the seed hash + a salt. sha256 → BigInt → mod.
  static seededMod(seedHash, salt, modulo) {
    if (modulo <= 0) return 0;
    const digest = crypto.createHash('sha256').update(`${seedHash}:${salt}`).digest('hex');
    return Number(BigInt('0x' + digest) % BigInt(Math.floor(modulo)));
  }

  // entries: [{ address, tickets }]. Returns the chosen entry (weighted by tickets) or null.
  static pickWeighted(seedHash, salt, entries) {
    const total = entries.reduce((sum, e) => sum + e.tickets, 0);
    if (total <= 0) return null;
    const r = LotteryManager.seededMod(seedHash, salt, total);
    let acc = 0;
    for (const e of entries) {
      acc += e.tickets;
      if (r < acc) return e;
    }
    return entries[entries.length - 1];
  }

  // Addresses with >= min valid shares in [start, end], excluding reserved pseudo-addresses.
  // Returns [{ address, tickets }] where tickets = share count.
  eligibleEntries(periodStart, periodEnd, minShares) {
    const reserved = IncentivesManager.RESERVED_ADDRESSES;
    const placeholders = reserved.map(() => '?').join(',');
    const rows = this.db.prepare(`
      SELECT grin_address AS address, COUNT(*) AS tickets
      FROM shares
      WHERE created_at >= ? AND created_at <= ?
        AND grin_address NOT IN (${placeholders})
      GROUP BY grin_address
      HAVING COUNT(*) >= ?
    `).all(periodStart, periodEnd, ...reserved, minShares);
    return rows;
  }

  lastDrawOfType(type) {
    return this.db.prepare(
      'SELECT * FROM lottery_draws WHERE draw_type = ? ORDER BY created_at DESC LIMIT 1'
    ).get(type);
  }

  // Which draws are due right now (weekly cadence + special-event date match, UTC).
  dueDraws(now = Date.now()) {
    const s = this.settingsView();
    if (!flag(s.incentives_enabled) || !flag(s.lottery_enabled)) return [];
    const due = [];
    const nowSec = Math.floor(now / 1000);

    if (flag(s.lottery_weekly_enabled)) {
      const last = this.lastDrawOfType('weekly');
      if (!last || nowSec - last.created_at >= WEEK_SECONDS) {
        due.push({ type: 'weekly', event_name: null });
      }
    }

    const todayMMDD = new Date(now).toISOString().slice(5, 10); // "MM-DD" (UTC)
    const dayStart = Math.floor(nowSec / SECONDS_PER_DAY) * SECONDS_PER_DAY;
    for (const ev of s.lottery_special_events) {
      if (!flag(ev.enabled) || ev.date !== todayMMDD) continue;
      const alreadyToday = this.db.prepare(
        "SELECT 1 FROM lottery_draws WHERE draw_type = 'special' AND event_name = ? AND created_at >= ? LIMIT 1"
      ).get(ev.name, dayStart);
      if (!alreadyToday) due.push({ type: 'special', event_name: ev.name, pot_grin: ev.pot_grin });
    }
    return due;
  }

  // Run a single draw. Fetches a verifiable seed (async) BEFORE the synchronous DB transaction.
  async runDraw(type, eventName = null, potGrinOverride = 0) {
    const s = this.settingsView();
    if (!flag(s.incentives_enabled) || !flag(s.lottery_enabled)) {
      return { success: false, reason: 'lottery_disabled' };
    }

    const nowSec = Math.floor(Date.now() / 1000);
    const periodStart = nowSec - WEEK_SECONDS;
    const periodEnd = nowSec;

    // Verifiable seed = current node tip hash. Without a node we cannot prove fairness → abort.
    let seed;
    try {
      seed = await this.grinNode.getTip();
    } catch (err) {
      return { success: false, reason: 'no_seed', error: err.message };
    }
    if (!seed || !seed.hash) return { success: false, reason: 'no_seed' };

    // Determine the total pot.
    const bucket = this.incentives.prizePoolBalance();
    let pot;
    if (type === 'special' && potGrinOverride > 0) {
      pot = Math.min(potGrinOverride, bucket);
    } else {
      pot = bucket * (s.lottery_pot_fraction_percent / 100);
    }
    const potA = pot * (s.lottery_pot_share_weighted_percent / 100);
    const potB = pot * (s.lottery_pot_equal_chance_percent / 100);

    const entries = this.eligibleEntries(periodStart, periodEnd, s.lottery_min_shares);

    // Pot A: weighted by shares. Pot B: one entry per address (uniform).
    const winnerA = LotteryManager.pickWeighted(seed.hash, `${eventName || 'weekly'}:A`, entries);
    const winnerB = LotteryManager.pickWeighted(
      seed.hash, `${eventName || 'weekly'}:B`, entries.map((e) => ({ address: e.address, tickets: 1 }))
    );

    const tx = this.db.transaction(() => {
      const info = this.db.prepare(`
        INSERT INTO lottery_draws
          (draw_type, event_name, period_start, period_end, seed_height, seed_hash,
           pot_a_amount, pot_b_amount, status, drawn_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
      `).run(type, eventName, periodStart, periodEnd, seed.height, seed.hash,
             potA, potB, entries.length ? 'drawn' : 'pending');
      const drawId = info.lastInsertRowid;
      const winners = [];

      const award = (winner, pot, amount) => {
        if (!winner || amount <= 0) return;
        if (!this.incentives.debitPrizePool(amount, 'lottery', drawId)) return; // insufficient bucket
        this.incentives._move(winner.address, amount, 'credit', 'lottery', drawId);
        this.db.prepare(`
          INSERT INTO lottery_winners (draw_id, grin_address, pot, ticket_count, amount)
          VALUES (?, ?, ?, ?, ?)
        `).run(drawId, winner.address, pot, winner.tickets || 0, amount);
        winners.push({ address: winner.address, pot, amount });
      };

      award(winnerA, 'a', potA);
      award(winnerB, 'b', potB);

      if (winners.length) {
        this.db.prepare("UPDATE lottery_draws SET status = 'paid' WHERE id = ?").run(drawId);
      }
      return { drawId, winners };
    });

    const result = tx();
    return {
      success: true,
      draw_id: result.drawId,
      type,
      event_name: eventName,
      seed_height: seed.height,
      seed_hash: seed.hash,
      eligible: entries.length,
      pot_a: potA,
      pot_b: potB,
      winners: result.winners,
    };
  }

  // Run every due draw — called by the hourly scheduler job in index.js.
  async runDueDraws() {
    const out = [];
    for (const d of this.dueDraws()) {
      out.push(await this.runDraw(d.type, d.event_name, d.pot_grin || 0));
    }
    return out;
  }

  // Recent draws + their winners, for the admin panel and public payload.
  recentDraws(limit = 10) {
    const draws = this.db.prepare('SELECT * FROM lottery_draws ORDER BY created_at DESC LIMIT ?').all(limit);
    const winStmt = this.db.prepare('SELECT grin_address, pot, ticket_count, amount FROM lottery_winners WHERE draw_id = ?');
    return draws.map((d) => ({ ...d, winners: winStmt.all(d.id) }));
  }

  // Public fortune board: paginated winner history (winner + amount + date + seed for audit).
  // Returns truncated addresses; the seed_hash lets anyone verify the draw was fair.
  winnerHistory(limit = 25, offset = 0) {
    const rows = this.db.prepare(`
      SELECT w.grin_address, w.pot, w.ticket_count, w.amount,
             d.draw_type, d.event_name, d.seed_height, d.seed_hash, d.drawn_at, w.created_at
      FROM lottery_winners w
      JOIN lottery_draws d ON d.id = w.draw_id
      ORDER BY w.created_at DESC
      LIMIT ? OFFSET ?
    `).all(limit, offset);
    const total = this.db.prepare('SELECT COUNT(*) AS c FROM lottery_winners').get().c;
    const trunc = (a) => (a && a.length > 14 ? `${a.slice(0, 10)}…${a.slice(-4)}` : a);
    return {
      total,
      winners: rows.map((r) => ({
        address: trunc(r.grin_address),
        event: r.event_name || (r.draw_type === 'special' ? 'Special' : 'Weekly'),
        pot: r.pot,
        ticket_count: r.ticket_count,
        amount: r.amount,
        drawn_at: r.drawn_at,
        seed_height: r.seed_height,
        seed_hash: r.seed_hash,
      })),
    };
  }

  // Next scheduled weekly draw + upcoming enabled special events (for the public payload).
  nextScheduled() {
    const s = this.settingsView();
    if (!flag(s.incentives_enabled) || !flag(s.lottery_enabled)) return null;
    let nextWeekly = null;
    if (flag(s.lottery_weekly_enabled)) {
      const last = this.lastDrawOfType('weekly');
      const base = last ? last.created_at : Math.floor(Date.now() / 1000);
      nextWeekly = (base + WEEK_SECONDS) * 1000;
    }
    const events = s.lottery_special_events
      .filter((ev) => flag(ev.enabled))
      .map((ev) => ({ name: ev.name, date: ev.date, pot_grin: ev.pot_grin }));
    return { next_weekly: nextWeekly, special_events: events };
  }
}

module.exports = LotteryManager;
