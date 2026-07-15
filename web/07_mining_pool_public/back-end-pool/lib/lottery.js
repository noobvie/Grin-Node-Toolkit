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

  // Eligible entries for a draw over [start, end], from the PERSISTENT hashrate_history samples
  // (retained ~30d) — NOT the shares table (pruned after ~1 day), so a multi-day/week window
  // counts real sustained activity instead of only the last day. Per address:
  //   work        = SUM(hashrate_gps × window_seconds)  → the weighted-pot (Pot A) ticket weight
  //   active_days = COUNT(DISTINCT day-bucket)           → the small-miner / anti-sybil gate
  // Reserved pseudo-addresses (pool_fee, prize_pool) are excluded. Addresses below minActiveDays
  // or with zero work don't qualify.
  eligibleEntries(periodStart, periodEnd, minActiveDays = 1) {
    const reserved = IncentivesManager.RESERVED_ADDRESSES;
    const placeholders = reserved.map(() => '?').join(',');
    const rows = this.db.prepare(`
      SELECT grin_address AS address,
             COALESCE(SUM(hashrate_gps * window_seconds), 0) AS work,
             COUNT(DISTINCT recorded_at / 86400) AS active_days
      FROM hashrate_history
      WHERE recorded_at >= ? AND recorded_at <= ?
        AND grin_address NOT IN (${placeholders})
      GROUP BY grin_address
      HAVING work > 0 AND active_days >= ?
    `).all(periodStart, periodEnd, ...reserved, Math.max(1, minActiveDays || 1));
    return rows.map((r) => ({ address: r.address, work: r.work, active_days: r.active_days }));
  }

  // Pot A ticket weights from entries, with an optional whale cap: no single address's tickets
  // may exceed maxPct% of the total work. Capping (rather than a concave weight) bounds whales
  // without rewarding address-splitting. maxPct 0/NULL = uncapped. Tickets are rounded to keep
  // pickWeighted's integer seed math stable. NOTE: this is a single-pass cap against the ORIGINAL
  // total — a capped whale's EFFECTIVE odds can still edge above maxPct% once other entries shrink
  // the pool. It meaningfully bounds whales; it is not a hard probabilistic guarantee.
  static buildWeightedTickets(entries, maxPct) {
    const total = entries.reduce((s, e) => s + e.work, 0);
    const cap = maxPct > 0 && total > 0 ? total * (maxPct / 100) : Infinity;
    return entries.map((e) => ({
      address: e.address,
      tickets: Math.max(1, Math.round(Math.min(e.work, cap))),
    }));
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
  // opts (all optional; NULL/undefined overrides inherit the global lottery_* settings):
  //   eventName, potGrinOverride, periodStart, periodEnd, campaignId,
  //   weightedPercent, equalChancePercent, potFractionPercent, minActiveDays, maxTicketSharePercent
  async runDraw(type, opts = {}) {
    const s = this.settingsView();
    if (!flag(s.incentives_enabled) || !flag(s.lottery_enabled)) {
      return { success: false, reason: 'lottery_disabled' };
    }

    const pick = (v, fallback) => (v == null ? fallback : v);
    const eventName = opts.eventName || null;
    const potGrinOverride = parseFloat(opts.potGrinOverride) || 0;

    const nowSec = Math.floor(Date.now() / 1000);
    const periodEnd = opts.periodEnd || nowSec;
    const periodStart = opts.periodStart || (nowSec - WEEK_SECONDS);

    // Verifiable seed = current node tip hash. Without a node we cannot prove fairness → abort.
    let seed;
    try {
      seed = await this.grinNode.getTip();
    } catch (err) {
      return { success: false, reason: 'no_seed', error: err.message };
    }
    if (!seed || !seed.hash) return { success: false, reason: 'no_seed' };

    // Determine the total pot (fixed override, else a fraction of the prize bucket).
    const bucket = this.incentives.prizePoolBalance();
    const fraction = pick(opts.potFractionPercent, s.lottery_pot_fraction_percent) / 100;
    const pot = potGrinOverride > 0 ? Math.min(potGrinOverride, bucket) : bucket * fraction;

    const wPct = pick(opts.weightedPercent, s.lottery_pot_share_weighted_percent);
    let ePct = pick(opts.equalChancePercent, s.lottery_pot_equal_chance_percent);
    // Defensive: Pot A and Pot B are BOTH slices of the same `pot`, so their percents must not
    // sum above 100% or the draw overpays the prize bucket. The two settings are independent
    // (and a per-campaign override may set only one, inheriting the other from the global
    // config) — so clamp here as the single source of truth. Weighted (A) keeps priority.
    if (wPct + ePct > 100) ePct = Math.max(0, 100 - wPct);
    const potA = pot * (wPct / 100);
    const potB = pot * (ePct / 100);

    const minActiveDays = pick(opts.minActiveDays, pick(s.lottery_min_active_days, 1));
    const maxCap = pick(opts.maxTicketSharePercent, s.lottery_max_ticket_share_percent) || 0;

    const entries = this.eligibleEntries(periodStart, periodEnd, minActiveDays);

    // Pot A: weighted by sustained work (with the whale cap). Pot B: one entry per address (uniform).
    const winnerA = LotteryManager.pickWeighted(
      seed.hash, `${eventName || type}:A`, LotteryManager.buildWeightedTickets(entries, maxCap)
    );
    const winnerB = LotteryManager.pickWeighted(
      seed.hash, `${eventName || type}:B`, entries.map((e) => ({ address: e.address, tickets: 1 }))
    );

    const campaignId = opts.campaignId || null;
    const tx = this.db.transaction(() => {
      const info = this.db.prepare(`
        INSERT INTO lottery_draws
          (draw_type, event_name, period_start, period_end, seed_height, seed_hash,
           pot_a_amount, pot_b_amount, status, campaign_id, drawn_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
      `).run(type, eventName, periodStart, periodEnd, seed.height, seed.hash,
             potA, potB, entries.length ? 'drawn' : 'pending', campaignId);
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

  // Run every due weekly/special draw — called by the hourly scheduler job in index.js.
  async runDueDraws() {
    const out = [];
    for (const d of this.dueDraws()) {
      out.push(await this.runDraw(d.type, { eventName: d.event_name, potGrinOverride: d.pot_grin || 0 }));
    }
    return out;
  }

  // ─── Contest campaigns ──────────────────────────────────────────────────────
  // A campaign is a scheduled draw with an explicit [starts_at, ends_at] window and optional
  // per-campaign rule overrides. Its draw scores hashrate_history over that exact window.

  // Run one campaign's draw, then stamp the campaign row with the outcome. If the campaign
  // recurs, schedule the next occurrence. Returns the runDraw result (plus campaign_id).
  async runCampaign(c) {
    const res = await this.runDraw('campaign', {
      eventName: c.name,
      potGrinOverride: c.pot_grin > 0 ? c.pot_grin : 0,
      periodStart: c.starts_at,
      periodEnd: c.ends_at,
      campaignId: c.id,
      weightedPercent: c.weighted_percent,
      equalChancePercent: c.equal_chance_percent,
      potFractionPercent: c.pot_fraction_percent,
      minActiveDays: c.min_active_days,
      maxTicketSharePercent: c.max_ticket_share_percent,
    });
    if (res && res.success) {
      const status = (res.winners && res.winners.length) ? 'paid' : (res.eligible ? 'drawn' : 'empty');
      this.db.prepare(`
        UPDATE campaigns SET status = ?, draw_id = ?, seed_height = ?, seed_hash = ?,
               drawn_at = unixepoch(), updated_at = unixepoch() WHERE id = ?
      `).run(status, res.draw_id || null, res.seed_height || null, res.seed_hash || null, c.id);
      if (c.recurring && c.recurring !== 'none') this._scheduleNextOccurrence(c);
    }
    return { ...res, campaign_id: c.id };
  }

  // Clone a finished recurring campaign forward by one period as a fresh 'scheduled' row.
  _scheduleNextOccurrence(c) {
    const step = c.recurring === 'weekly' ? WEEK_SECONDS
      : c.recurring === 'yearly' ? 365 * SECONDS_PER_DAY : 0;
    if (!step) return;
    this.db.prepare(`
      INSERT INTO campaigns
        (name, description, status, starts_at, ends_at, recurring, pot_grin, pot_fraction_percent,
         weighted_percent, equal_chance_percent, min_active_days, max_ticket_share_percent)
      VALUES (?, ?, 'scheduled', ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(c.name, c.description, c.starts_at + step, c.ends_at + step, c.recurring, c.pot_grin,
           c.pot_fraction_percent, c.weighted_percent, c.equal_chance_percent,
           c.min_active_days, c.max_ticket_share_percent);
  }

  // Run every campaign whose window has closed — called by the scheduler tick in index.js.
  async runDueCampaigns(now = Date.now()) {
    const s = this.settingsView();
    if (!flag(s.incentives_enabled) || !flag(s.lottery_enabled)) return [];
    const nowSec = Math.floor(now / 1000);
    const due = this.db.prepare(
      "SELECT * FROM campaigns WHERE status = 'scheduled' AND ends_at <= ? ORDER BY ends_at ASC LIMIT 20"
    ).all(nowSec);
    const out = [];
    for (const c of due) out.push(await this.runCampaign(c));
    return out;
  }

  // ── Campaign CRUD (admin) ──
  // Sanitise a campaign payload into column values. Override fields left blank become NULL
  // (inherit global). Throws on invalid required fields.
  static _normalizeCampaign(body) {
    const num = (v) => (v === '' || v == null || isNaN(parseFloat(v)) ? null : parseFloat(v));
    const int = (v) => (v === '' || v == null || isNaN(parseInt(v, 10)) ? null : parseInt(v, 10));
    const name = String(body.name || '').trim().slice(0, 80);
    if (!name) throw new Error('name is required');
    const starts = int(body.starts_at);
    const ends = int(body.ends_at);
    if (!starts || !ends) throw new Error('starts_at and ends_at (unix seconds) are required');
    if (ends <= starts) throw new Error('ends_at must be after starts_at');
    const recurring = ['none', 'weekly', 'yearly'].includes(body.recurring) ? body.recurring : 'none';
    const clampPct = (v) => { const n = num(v); return n == null ? null : Math.min(100, Math.max(0, n)); };
    return {
      name,
      description: body.description ? String(body.description).slice(0, 500) : null,
      starts_at: starts,
      ends_at: ends,
      recurring,
      pot_grin: Math.max(0, num(body.pot_grin) || 0),
      pot_fraction_percent: clampPct(body.pot_fraction_percent),
      weighted_percent: clampPct(body.weighted_percent),
      equal_chance_percent: clampPct(body.equal_chance_percent),
      min_active_days: int(body.min_active_days) == null ? null : Math.max(0, int(body.min_active_days)),
      max_ticket_share_percent: clampPct(body.max_ticket_share_percent),
    };
  }

  listCampaigns(limit = 50) {
    return this.db.prepare('SELECT * FROM campaigns ORDER BY ends_at DESC LIMIT ?').all(limit);
  }

  getCampaign(id) {
    return this.db.prepare('SELECT * FROM campaigns WHERE id = ?').get(id);
  }

  // The two pot splits must not exceed 100% AFTER inheritance — a per-campaign override may set
  // only one side, so resolve the missing side from the global config before checking.
  _assertSplitOk(c) {
    const s = this.settingsView();
    const w = c.weighted_percent != null ? c.weighted_percent : (parseFloat(s.lottery_pot_share_weighted_percent) || 0);
    const e = c.equal_chance_percent != null ? c.equal_chance_percent : (parseFloat(s.lottery_pot_equal_chance_percent) || 0);
    if (w + e > 100) {
      throw new Error(`Pot A (${w}%) + Pot B (${e}%) exceed 100% — lower one, or leave both blank to inherit the 50/50 global split`);
    }
  }

  createCampaign(body) {
    const c = LotteryManager._normalizeCampaign(body);
    this._assertSplitOk(c);
    const info = this.db.prepare(`
      INSERT INTO campaigns
        (name, description, status, starts_at, ends_at, recurring, pot_grin, pot_fraction_percent,
         weighted_percent, equal_chance_percent, min_active_days, max_ticket_share_percent)
      VALUES (@name, @description, 'scheduled', @starts_at, @ends_at, @recurring, @pot_grin,
              @pot_fraction_percent, @weighted_percent, @equal_chance_percent, @min_active_days,
              @max_ticket_share_percent)
    `).run(c);
    return this.getCampaign(info.lastInsertRowid);
  }

  updateCampaign(id, body) {
    const existing = this.getCampaign(id);
    if (!existing) throw new Error('campaign not found');
    if (existing.status !== 'scheduled') throw new Error('only scheduled campaigns can be edited');
    const c = LotteryManager._normalizeCampaign(body);
    this._assertSplitOk(c);
    this.db.prepare(`
      UPDATE campaigns SET name=@name, description=@description, starts_at=@starts_at, ends_at=@ends_at,
        recurring=@recurring, pot_grin=@pot_grin, pot_fraction_percent=@pot_fraction_percent,
        weighted_percent=@weighted_percent, equal_chance_percent=@equal_chance_percent,
        min_active_days=@min_active_days, max_ticket_share_percent=@max_ticket_share_percent,
        updated_at=unixepoch() WHERE id=@id
    `).run({ ...c, id });
    return this.getCampaign(id);
  }

  cancelCampaign(id) {
    const c = this.getCampaign(id);
    if (!c) throw new Error('campaign not found');
    if (c.status !== 'scheduled') throw new Error('only scheduled campaigns can be cancelled');
    this.db.prepare("UPDATE campaigns SET status='cancelled', updated_at=unixepoch() WHERE id=?").run(id);
    return this.getCampaign(id);
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
    // Upcoming contest campaigns (scheduled, not yet drawn) — public teaser for the fortune board.
    const nowSec = Math.floor(Date.now() / 1000);
    const campaigns = this.db.prepare(
      "SELECT name, description, starts_at, ends_at, pot_grin FROM campaigns WHERE status = 'scheduled' AND ends_at > ? ORDER BY ends_at ASC LIMIT 10"
    ).all(nowSec).map((c) => ({
      name: c.name,
      description: c.description,
      starts_at: c.starts_at,
      ends_at: c.ends_at,
      pot_grin: c.pot_grin,
    }));
    return { next_weekly: nextWeekly, special_events: events, campaigns };
  }
}

module.exports = LotteryManager;
