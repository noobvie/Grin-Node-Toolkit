'use strict';

// Public read model for the fortune board: GET /api/public/incentives/overview and
// GET /api/public/incentives/history (routes/public.js). Reads only — no money moves here.
//
// Contract:
//   overview() → { enabled: true, prize_pool_grin, offers, given, pool_flows }
//     offers   a key is PRESENT only while its payer would actually pay. Each gate below mirrors
//              the payer's own check (same settingsView(), same flag() truthiness), so the page
//              never promises an incentive the code would skip. A switched-off incentive, or a
//              draw nobody can qualify for, is absent, not marked "off". Draw offers carry their
//              own RESOLVED rules (per-campaign overrides applied, Pot B clamped).
//     given    all history, NET of jackpot clawbacks, real miner addresses only. by_event is
//              LotteryManager.stats().by_event (draw prizes per event name, top 12 by GRIN).
//     pool_flows  the prize_pool pseudo-address, straight from prizePoolStatement().
//   history({ limit, before, kind }) → { total, rows, next }, newest first, masked addresses.
//     Keyset pages: `next` is the cursor of the last row ("<at>-<src>-<sid>"), passed back as
//     `before`; null on the last page. A cursor names a position, not an offset, so a row landing
//     between two requests cannot repeat or skip a row, and no row is ever shown twice. One case
//     skips instead: if a prune rolls up the day of the raw row a cursor points at, that day is
//     now a single rolled row partly shown already, so the rest of that one day is folded away.
//     `before` that is not a cursor makes history() return null (the route answers 400).
//
// Privacy traps:
//   - Streak bonuses are aggregates ONLY. A streak credit is the miner's gross for one block times
//     a published percent, so a per-address streak row would publish that miner's per-block
//     earnings. history() has no streak branch and refuses kind=streak.
//   - mask() is the one address mask: a full address gets LotteryManager.winnerHistory's 10 + 4,
//     anything shorter keeps at most a third of its characters, so no value is ever sent whole.
//
// Ledger traps (lib/ledger-rollup.js horizon contract):
//   - Lifetime aggregates read rollup (day < H) UNION raw (created_at >= H), as
//     IncentivesManager.prizePoolStatement() does — never raw alone, which is pruned. The rollup
//     half only changes when the rollup moves H, so it is memoised per H.
//   - Lottery and daily-giveaway credits share reference_type 'lottery', and a rolled row has no
//     reference_id, so they cannot be told apart from the ledger. Both come from lottery_winners
//     (pot a/b = lottery, d = giveaway), which is written in the same transaction as the credit.
//   - Rolled rows keep only the UTC day: a rolled history row's `at` is that day's midnight, it
//     can sum several credits of one kind to one address on that day, and a rolled jackpot's
//     clawed_back is null (no block height left to match a reversal against).
//   - SQLite uses a partial index only when the query repeats its WHERE term verbatim. The terms
//     below are copied into lib/db.js; scripts/test-incentives-public.js pins both copies.

const { getHorizon, floorDay } = require('./ledger-rollup');
const IncentivesManager = require('./incentives');

const RESERVED = IncentivesManager.RESERVED_ADDRESSES;
const flag = (v) => v === true || v === 'true';
const r9 = (v) => parseFloat((Number(v) || 0).toFixed(9));
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const pick = (v, fallback) => (v == null ? fallback : v);
const mask = (a) => {
  const s = a == null ? '' : String(a);
  if (s.length >= 20) return `${s.slice(0, 10)}…${s.slice(-4)}`;
  return s ? `${s.slice(0, Math.floor(s.length / 3))}…` : '';
};
const SECONDS_PER_DAY = 86400;
const WEEK_SECONDS = 7 * SECONDS_PER_DAY;
const MEMO_MS = 60000;
const HISTORY_MEMO_MAX = 200;
// A draw's window is inclusive at both ends (eligibleEntries: recorded_at >= start AND <= end),
// so a 7-day window touches 8 UTC days and active_days can reach 8, never more.
const daysTouched = (start, end) => Math.floor(end / SECONDS_PER_DAY) - Math.floor(start / SECONDS_PER_DAY) + 1;

// Ledger reference_type → public kind, for the bonuses that are read from the ledger.
const LEDGER_KINDS = { jackpot: 'jackpot', join_bonus: 'join_bonus', prize_award: 'award', streak: 'streak' };
// idx_balance_log_bonus / idx_bld_bonus (lib/db.js): the four ledger-read bonus types, for the
// lifetime totals.
const BONUS_REF_TYPES_SQL = "reference_type IN ('jackpot', 'join_bonus', 'prize_award', 'streak')";
// idx_balance_log_history / idx_bld_history (lib/db.js): the three types history lists. Streak is
// left out so history never walks the streak credits, the bulk of all bonus rows.
const HISTORY_REF_TYPES_SQL = "reference_type IN ('jackpot', 'join_bonus', 'prize_award')";
const KIND_ORDER = ['lottery', 'giveaway', 'jackpot', 'join_bonus', 'streak', 'award'];
// Kinds history() may list. Streak is absent on purpose (see the header).
const HISTORY_KINDS = ['lottery', 'giveaway', 'jackpot', 'join_bonus', 'award'];
// History kind → its ledger reference_type, for the kinds read from the ledger.
const LEDGER_HISTORY_REF = { jackpot: 'jackpot', join_bonus: 'join_bonus', award: 'prize_award' };
const CURSOR_RE = /^(\d{1,12})-([1-3])-(\d{1,15})$/;

class IncentivesPublic {
  // incentives: an IncentivesManager; lottery: a LotteryManager (its .daily is the giveaway).
  constructor({ incentives, lottery }) {
    this.incentives = incentives;
    this.lottery = lottery;
    this.overviewMemo = null;
    this.rolledMemo = null;        // { H, maxRowid, rows } — the rollup half of given()
    this.rawMemo = null;           // { H, lastId, credits, reversals } — the raw half of given()
    this.historyMemo = new Map();  // page key → { at, data }, evicted oldest first
    this.totalMemo = new Map();    // kind → { at, total }
  }

  get db() { return this.incentives.db; }

  // ─── offers ──────────────────────────────────────────────────────────────────
  // Pot A/B percents as LotteryManager.runDraw applies them: B is clamped so A + B ≤ 100.
  static potSplit(w, e) {
    const wPct = num(w);
    let ePct = num(e);
    if (wPct + ePct > 100) ePct = Math.max(0, 100 - wPct);
    return { wPct, ePct };
  }

  // The rules runDraw would apply with these overrides (null/undefined = inherit the global
  // setting), and whether such a draw can pay anyone at all within a window touching `days`
  // UTC days: a pot (fixed or a fraction), a non-zero split, and an active-days gate that fits.
  static drawRules(s, o, potGrin, days) {
    const split = IncentivesPublic.potSplit(pick(o.weighted, s.lottery_pot_share_weighted_percent),
      pick(o.equal, s.lottery_pot_equal_chance_percent));
    const fraction = num(pick(o.fraction, s.lottery_pot_fraction_percent));
    const minActiveDays = Math.max(1, num(pick(o.minActiveDays, pick(s.lottery_min_active_days, 1))) || 1);
    const rules = {
      pot_fraction_percent: fraction,
      pot_share_weighted_percent: split.wPct,
      pot_equal_chance_percent: split.ePct,
      min_active_days: minActiveDays,
      max_ticket_share_percent: num(pick(o.maxTicket, s.lottery_max_ticket_share_percent)) || 0,
    };
    const pays = (num(potGrin) > 0 || fraction > 0) && (split.wPct > 0 || split.ePct > 0) && minActiveDays <= days;
    return { rules, pays };
  }

  offers(s = this.incentives.settingsView(), nowSec = Math.floor(Date.now() / 1000)) {
    const out = {};
    if (!flag(s.incentives_enabled)) return out;

    // Daily giveaway: DailyGiveaway.publicRules() is its own gate (enabled() + valid rules()).
    const daily = this.lottery && this.lottery.daily ? this.lottery.daily.publicRules() : null;
    if (daily) out.daily_giveaway = { ...daily };

    // Weekly / special / campaign draws: LotteryManager.dueDraws, runDueCampaigns and runDraw
    // all require incentives_enabled && lottery_enabled; award() skips amount <= 0.
    if (flag(s.lottery_enabled)) {
      // Weekly and special draws score the last 7 days (runDraw's default period).
      const week = daysTouched(nowSec - WEEK_SECONDS, nowSec);
      const global = IncentivesPublic.drawRules(s, {}, 0, week);

      if (flag(s.lottery_weekly_enabled) && global.pays) {
        // dueDraws: a weekly draw is due once a week after the last one; with none yet it is due
        // at the next hourly scheduler tick, which null stands for.
        const last = this.db.prepare(
          "SELECT created_at FROM lottery_draws WHERE draw_type = 'weekly' ORDER BY created_at DESC LIMIT 1"
        ).get();
        out.lottery_weekly = { next_draw_at: last ? last.created_at + WEEK_SECONDS : null, ...global.rules };
      }

      // dueDraws matches ev.date against today's "MM-DD" with ev.enabled, so a malformed date
      // never fires and is not offered. runDueDraws passes only the event's pot_grin; every
      // other rule is the global one.
      const events = (Array.isArray(s.lottery_special_events) ? s.lottery_special_events : [])
        .filter((ev) => ev && flag(ev.enabled) && typeof ev.date === 'string' && /^\d{2}-\d{2}$/.test(ev.date))
        .map((ev) => ({ ev, r: IncentivesPublic.drawRules(s, {}, ev.pot_grin, week) }))
        .filter(({ r }) => r.pays)
        .map(({ ev, r }) => ({ name: String(ev.name || ''), date: ev.date, pot_grin: Math.max(0, num(ev.pot_grin)), ...r.rules }));
      if (events.length) out.special_events = events;

      // nextScheduled's campaign list, with runCampaign's overrides resolved.
      const campaigns = this.db.prepare(`
        SELECT name, description, starts_at, ends_at, pot_grin, pot_fraction_percent, weighted_percent,
               equal_chance_percent, min_active_days, max_ticket_share_percent
        FROM campaigns WHERE status = 'scheduled' AND ends_at > ? ORDER BY ends_at ASC LIMIT 10
      `).all(nowSec)
        .map((c) => ({
          c,
          r: IncentivesPublic.drawRules(s, {
            weighted: c.weighted_percent, equal: c.equal_chance_percent, fraction: c.pot_fraction_percent,
            minActiveDays: c.min_active_days, maxTicket: c.max_ticket_share_percent,
          }, c.pot_grin, daysTouched(c.starts_at, c.ends_at)),
        }))
        .filter(({ r }) => r.pays)
        .map(({ c, r }) => ({
          name: c.name, description: c.description, starts_at: c.starts_at, ends_at: c.ends_at,
          pot_grin: num(c.pot_grin), ...r.rules,
        }));
      if (campaigns.length) out.campaigns = campaigns;
    }

    // Join bonus: IncentivesManager.maybePayJoinBonus.
    const joinAmount = parseFloat(s.join_bonus_amount);
    if (flag(s.join_bonus_enabled) && joinAmount > 0) out.join_bonus = { amount_grin: joinAmount };

    // Block-finder jackpot: IncentivesManager.payBlockFinderJackpot.
    const jackpotAmount = parseFloat(s.jackpot_amount);
    if (flag(s.jackpot_enabled) && jackpotAmount > 0) out.jackpot = { amount_grin: jackpotAmount };

    // Loyalty streak: applyToDistribution step 3 + streakMultiplier, which yields
    // min(weeks × per_week, max) — zero for every streak length unless both are above 0.
    const perWeek = num(s.streak_bonus_per_week_percent);
    const maxPct = num(s.streak_max_percent);
    if (flag(s.streak_enabled) && Math.min(perWeek, maxPct) > 0) {
      out.streak = { bonus_per_week_percent: perWeek, max_percent: maxPct };
    }
    return out;
  }

  // Addresses whose streakMultiplier() is above zero right now, counted in SQL with the same
  // three conditions: streak on with a positive percent, active today or yesterday (UTC; a day
  // after today is stale, as there), and at least one full 7-day week.
  streakActiveMiners(s, nowSec) {
    if (!flag(s.streak_enabled)) return 0;
    if (!(Math.min(num(s.streak_bonus_per_week_percent), num(s.streak_max_percent)) > 0)) return 0;
    const today = Math.floor(nowSec / SECONDS_PER_DAY);
    const marks = RESERVED.map(() => '?').join(',');
    return this.db.prepare(`
      SELECT COUNT(*) AS c FROM miner_incentives
      WHERE last_active_day >= ? AND last_active_day <= ? AND streak_days >= 7 AND grin_address NOT IN (${marks})
    `).get(today - 1, today, ...RESERVED).c;
  }

  // ─── given ───────────────────────────────────────────────────────────────────
  // The rollup half (day < H), per address / event / type / UTC month, memoised. Keyed on H and
  // on MAX(rowid) of balance_log_daily (an O(1) read): the rollup pass only inserts or rewrites
  // days >= the old H and nothing deletes rolled rows, so a row below H changes only by a new
  // insert (a new rowid) or by H moving. A hand edit of an existing rolled row in place is the one
  // change this cannot see; it shows within a restart.
  rolledLedger(H) {
    const maxRowid = this.db.prepare('SELECT MAX(rowid) AS m FROM balance_log_daily').get().m || 0;
    if (this.rolledMemo && this.rolledMemo.H === H && this.rolledMemo.maxRowid === maxRowid) return this.rolledMemo.rows;
    const marks = RESERVED.map(() => '?').join(',');
    const rows = this.db.prepare(`
      SELECT grin_address, event_type, reference_type, strftime('%Y-%m', day, 'unixepoch') AS month,
             SUM(total_amount) AS amount, SUM(event_count) AS count
      FROM balance_log_daily
      WHERE day < ? AND ${BONUS_REF_TYPES_SQL} AND event_type IN ('credit', 'reversal')
        AND grin_address NOT IN (${marks})
      GROUP BY grin_address, event_type, reference_type, month
    `).all(H, ...RESERVED);
    this.rolledMemo = { H, maxRowid, rows };
    return rows;
  }

  // The raw half (created_at >= H): just today while the rollup runs, the whole raw window while
  // it does not (retention switched off leaves H stale or 0). Memoised per H and kept current
  // incrementally: raw rows are insert-only with an AUTOINCREMENT id and never backdated, and a
  // prune only deletes days below H, so the rows at or above H are exactly the memo's rows plus
  // those with an id above its watermark. A cold read (new H, or a restart) goes through
  // idx_balance_log_bonus; each later read takes only the new ids, by rowid range.
  //
  // Credits are summed per address / type / UTC month. A jackpot reversal carries the block
  // height it claws back; when that credit is still raw its month is known (credit_month), looked
  // up through idx_balance_log_history — never through one address's rows.
  rawLedger(H) {
    const db = this.db;
    const marks = RESERVED.map(() => '?').join(',');
    const top = db.prepare('SELECT MAX(id) AS m FROM balance_log').get().m || 0;
    const creditMonth = `(SELECT strftime('%Y-%m', MIN(c.created_at), 'unixepoch') FROM balance_log c
        WHERE c.event_type = 'credit' AND c.${HISTORY_REF_TYPES_SQL} AND c.reference_type = 'jackpot'
          AND c.grin_address = b.grin_address AND c.reference_id = b.reference_id)`;
    let memo = this.rawMemo;
    let credits;
    let reversals;
    if (!memo || memo.H !== H || top < memo.lastId) {
      memo = { H, lastId: top, credits: new Map(), reversals: [] };
      credits = db.prepare(`
        SELECT b.grin_address, b.reference_type, strftime('%Y-%m', b.created_at, 'unixepoch') AS month,
               SUM(b.amount) AS amount, COUNT(*) AS count
        FROM balance_log b
        WHERE b.created_at >= ? AND b.${BONUS_REF_TYPES_SQL} AND b.event_type = 'credit'
          AND b.id <= ? AND b.grin_address NOT IN (${marks})
        GROUP BY b.grin_address, b.reference_type, month
      `).all(H, top, ...RESERVED);
      reversals = db.prepare(`
        SELECT b.grin_address, b.reference_type, strftime('%Y-%m', b.created_at, 'unixepoch') AS month, b.amount,
               ${creditMonth} AS credit_month
        FROM balance_log b
        WHERE b.created_at >= ? AND b.${BONUS_REF_TYPES_SQL} AND b.event_type = 'reversal'
          AND b.id <= ? AND b.grin_address NOT IN (${marks})
      `).all(H, top, ...RESERVED);
    } else if (top > memo.lastId) {
      // New ids only. The type list is spelled in a different order on purpose: repeating the
      // partial-index term would let the planner walk idx_balance_log_bonus from H, and the
      // unary + keeps idx_balance_log_time out, so this reads the rowid range and nothing else.
      const fresh = db.prepare(`
        SELECT b.grin_address, b.event_type, b.reference_type, strftime('%Y-%m', b.created_at, 'unixepoch') AS month,
               b.amount, CASE WHEN b.event_type = 'reversal' THEN ${creditMonth} END AS credit_month
        FROM balance_log b
        WHERE b.id > ? AND b.id <= ? AND +b.created_at >= ?
          AND b.reference_type IN ('streak', 'prize_award', 'join_bonus', 'jackpot')
          AND b.event_type IN ('credit', 'reversal') AND b.grin_address NOT IN (${marks})
      `).all(memo.lastId, top, H, ...RESERVED);
      credits = fresh.filter((r) => r.event_type === 'credit').map((r) => ({ ...r, count: 1 }));
      reversals = fresh.filter((r) => r.event_type === 'reversal');
      memo.lastId = top;
    } else {
      credits = [];
      reversals = [];
    }
    for (const r of credits) {
      const key = `${r.grin_address}\u0000${r.reference_type}\u0000${r.month}`;
      const c = memo.credits.get(key);
      if (c) {
        c.amount += Number(r.amount) || 0;
        c.count += Number(r.count) || 0;
      } else {
        memo.credits.set(key, {
          grin_address: r.grin_address, reference_type: r.reference_type, month: r.month,
          amount: Number(r.amount) || 0, count: Number(r.count) || 0,
        });
      }
    }
    for (const r of reversals) memo.reversals.push(r);
    this.rawMemo = memo;
    return { credits: [...memo.credits.values()], reversals: memo.reversals };
  }

  given(s, nowSec) {
    const db = this.db;
    const H = getHorizon(db);
    const marks = RESERVED.map(() => '?').join(',');

    const { credits: rawCredits, reversals: rawReversals } = this.rawLedger(H);

    const draws = db.prepare(`
      SELECT w.grin_address, CASE w.pot WHEN 'd' THEN 'giveaway' ELSE 'lottery' END AS kind,
             strftime('%Y-%m', COALESCE(d.drawn_at, w.created_at), 'unixepoch') AS month,
             SUM(w.amount) AS amount, COUNT(*) AS count
      FROM lottery_winners w JOIN lottery_draws d ON d.id = w.draw_id
      WHERE w.grin_address NOT IN (${marks})
      GROUP BY w.grin_address, kind, month
    `).all(...RESERVED);

    const byKind = Object.fromEntries(KIND_ORDER.map((k) => [k, { kind: k, grin: 0, count: 0 }]));
    const monthly = new Map();
    const cell = (month) => {
      if (!monthly.has(month)) monthly.set(month, Object.fromEntries([['month', month], ...KIND_ORDER.map((k) => [k, 0])]));
      return monthly.get(month);
    };
    const perAddress = new Map(); // address → net GRIN across all kinds
    const clawbacks = [];         // [{ month, amount }] applied to the jackpot column after credits
    const add = (address, kind, month, amount, count) => {
      byKind[kind].grin += amount;
      byKind[kind].count += count;
      if (month) cell(month)[kind] += amount;
      perAddress.set(address, (perAddress.get(address) || 0) + amount);
    };
    // A miner-side reversal under these reference types is only a jackpot clawback
    // (IncentivesManager.reverseJackpot): it takes back both the GRIN and the payment, so the net
    // is what a miner actually kept. by_kind and miners_rewarded take it at once; the monthly
    // column takes it below, so it lands on the month the jackpot was paid.
    const ledgerRow = (address, eventType, refType, month, amount, count, creditMonth) => {
      const kind = LEDGER_KINDS[refType];
      if (eventType !== 'reversal') { add(address, kind, month, amount, count); return; }
      if (kind !== 'jackpot') return;
      byKind.jackpot.grin -= amount;
      byKind.jackpot.count -= count;
      perAddress.set(address, (perAddress.get(address) || 0) - amount);
      clawbacks.push({ month: creditMonth || month, amount });
    };
    for (const r of this.rolledLedger(H)) {
      ledgerRow(r.grin_address, r.event_type, r.reference_type, r.month, Number(r.amount) || 0, Number(r.count) || 0, null);
    }
    for (const r of rawCredits) {
      ledgerRow(r.grin_address, 'credit', r.reference_type, r.month, Number(r.amount) || 0, Number(r.count) || 0, null);
    }
    for (const r of rawReversals) {
      ledgerRow(r.grin_address, 'reversal', r.reference_type, r.month, Number(r.amount) || 0, 1, r.credit_month);
    }
    for (const r of draws) add(r.grin_address, r.kind, r.month, Number(r.amount) || 0, Number(r.count) || 0);

    // Monthly clawbacks. A reversal whose credit is identifiable (raw, by block height) is taken
    // off the credit's month; one whose credit is rolled (no height) off its own month. Either
    // way, whatever that month's jackpot cell cannot absorb carries back to earlier months, newest
    // first: a reversal always follows its credit, so the earlier cells hold it. The monthly
    // column therefore never goes negative and still sums to by_kind's net jackpot. Only a ledger
    // with more clawed back than ever paid would leave a remainder; that is clamped at 0.
    const order = () => [...monthly.keys()].sort();
    for (const cb of clawbacks.sort((a, b) => (a.month < b.month ? 1 : a.month > b.month ? -1 : 0))) {
      let left = cb.amount;
      const months = order().filter((m) => m <= cb.month).reverse();
      for (const m of months) {
        if (!(left > 1e-12)) break;
        const take = Math.min(left, cell(m).jackpot);
        cell(m).jackpot -= take;
        left -= take;
      }
    }

    const by = KIND_ORDER.map((k) => ({ kind: k, grin: r9(byKind[k].grin), count: Math.max(0, byKind[k].count) }));
    const months = order()
      .map((m) => monthly.get(m))
      .map((m) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, k === 'month' ? v : Math.max(0, r9(v))])));
    // Draws that paid at least one winner. Deliberately narrower than LotteryManager.stats()
    // (/api/public/lottery/stats), which also counts a 'drawn' draw that paid nobody because the
    // prize pool was empty at reveal — from a miner's view that draw was not held.
    const drawsHeld = db.prepare('SELECT COUNT(DISTINCT draw_id) AS c FROM lottery_winners').get().c;
    // Prize total per event/campaign, top 12 by GRIN — the same query and name defaults as
    // LotteryManager.stats().by_event, so P-04 reads the same figures from either feed.
    const byEvent = db.prepare(`
      SELECT COALESCE(NULLIF(d.event_name, ''),
                      CASE d.draw_type WHEN 'special' THEN 'Special' ELSE 'Weekly' END) AS event,
             COUNT(*) AS count,
             COALESCE(SUM(w.amount), 0) AS amount
      FROM lottery_winners w
      JOIN lottery_draws d ON d.id = w.draw_id
      GROUP BY event
      ORDER BY amount DESC
      LIMIT 12
    `).all().map((r) => ({ event: r.event, count: r.count, amount: r.amount }));

    return {
      total_grin: r9(by.reduce((sum, k) => sum + k.grin, 0)),
      miners_rewarded: [...perAddress.values()].filter((v) => v > 1e-9).length,
      draws_held: drawsHeld,
      by_kind: by,
      monthly: months,
      by_event: byEvent,
      streak_active_miners: this.streakActiveMiners(s, nowSec),
    };
  }

  // ─── overview ────────────────────────────────────────────────────────────────
  // Memoised for the same 60 s the route's Cache-Control advertises.
  overview(now = Date.now()) {
    if (this.overviewMemo && now - this.overviewMemo.at < MEMO_MS) return this.overviewMemo.data;
    const s = this.incentives.settingsView();
    const nowSec = Math.floor(now / 1000);
    const st = this.incentives.prizePoolStatement(0);
    const data = {
      enabled: true,
      prize_pool_grin: this.incentives.publicSummary().prize_pool_grin,
      offers: this.offers(s, nowSec),
      given: this.given(s, nowSec),
      pool_flows: { in: st.in, out: st.out, balance: st.balance },
    };
    this.overviewMemo = { at: now, data };
    return data;
  }

  // ─── history ─────────────────────────────────────────────────────────────────
  // Per-row detail wants raw rows wherever they still exist, so it splits on the RAW FLOOR R
  // (the UTC day of the oldest raw row) rather than on H: verifyAndPruneRaw deletes whole days,
  // oldest first, and only below H, so raw is complete for every day >= R and the rollup covers
  // every day < R. Raw for t >= R plus rollup for day < min(R, H) is the whole ledger once, with
  // block heights kept for every day raw still holds.
  //
  // Rows are ordered by (at DESC, src ASC, sid DESC) — src 1 draws (at = the winner row's
  // created_at), 2 raw, 3 rolled; sid the row id — which is a total order, so the cursor is
  // exact. Each source is its own arm with the cursor condition and its own ORDER BY … LIMIT
  // page+1 inside it, walked newest first on its own index (idx_lottery_winners_time,
  // idx_balance_log_history, idx_bld_history), so a page reads about a page per arm however deep
  // the cursor points.
  //
  // A raw jackpot is clawed_back when a jackpot reversal names its address and block height.
  // reverseJackpot writes one only for the jackpot the orphaned block itself earned (never for
  // another pool block's at the same height), and the flag reports what the ledger holds.

  // The rows of one arm (all of whose rows have src = k) that come strictly after the cursor.
  // Written as a closed range on the time column plus a filter, so the index range stays bounded.
  static after(cur, k, atCol, sidCol) {
    if (cur.first) return { sql: '', params: [] };
    if (k > cur.src) return { sql: `AND ${atCol} <= ?`, params: [cur.at] };
    if (k < cur.src) return { sql: `AND ${atCol} < ?`, params: [cur.at] };
    return { sql: `AND ${atCol} <= ? AND (${atCol} < ? OR ${sidCol} < ?)`, params: [cur.at, cur.at, cur.sid] };
  }

  // The arms for one request. page = null builds them for COUNT(*) (no cursor, no order);
  // otherwise { cur, n, rolledCut } adds the cursor condition and ORDER BY … LIMIT n per arm.
  static historyArms(k, rolledBelow, page) {
    const marks = RESERVED.map(() => '?').join(',');
    const arms = [];
    const lim = (order) => (page ? `ORDER BY ${order} LIMIT ?` : '');
    const limP = page ? [page.n] : [];
    const cur = page ? page.cur : { first: true };

    if (k === '' || k === 'lottery' || k === 'giveaway') {
      const potSql = k === 'giveaway' ? "AND w.pot = 'd'" : k === 'lottery' ? "AND w.pot <> 'd'" : '';
      const a = IncentivesPublic.after(cur, 1, 'w.created_at', 'w.id');
      arms.push({
        sql: `SELECT CASE w.pot WHEN 'd' THEN 'giveaway' ELSE 'lottery' END AS kind,
                     w.grin_address AS addr, w.amount AS amount, w.created_at AS at,
                     d.event_name AS event_name, d.draw_type AS draw_type, w.ticket_count AS ticket_count,
                     d.seed_height AS seed_height, d.seed_hash AS seed_hash,
                     NULL AS block_height, NULL AS clawed, 1 AS src, w.id AS sid
              FROM lottery_winners w JOIN lottery_draws d ON d.id = w.draw_id
              WHERE w.grin_address NOT IN (${marks}) ${potSql} ${a.sql}
              ${lim('w.created_at DESC, w.id DESC')}`,
        params: [...RESERVED, ...a.params, ...limP],
      });
    }

    if (k === '' || LEDGER_HISTORY_REF[k]) {
      const refP = k ? [LEDGER_HISTORY_REF[k]] : [];
      const clawed = page
        ? `CASE b.reference_type WHEN 'jackpot' THEN EXISTS (
             SELECT 1 FROM balance_log r
             WHERE r.event_type = 'reversal' AND r.${HISTORY_REF_TYPES_SQL} AND r.reference_type = 'jackpot'
               AND r.grin_address = b.grin_address AND r.reference_id = b.reference_id) END`
        : 'NULL';
      const a = IncentivesPublic.after(cur, 2, 'b.created_at', 'b.id');
      arms.push({
        sql: `SELECT CASE b.reference_type WHEN 'prize_award' THEN 'award' ELSE b.reference_type END AS kind,
                     b.grin_address AS addr, b.amount AS amount, b.created_at AS at, NULL AS event_name,
                     NULL AS draw_type, NULL AS ticket_count, NULL AS seed_height, NULL AS seed_hash,
                     CASE b.reference_type WHEN 'jackpot' THEN b.reference_id END AS block_height,
                     ${clawed} AS clawed, 2 AS src, b.id AS sid
              FROM balance_log b
              WHERE b.event_type = 'credit' AND b.${HISTORY_REF_TYPES_SQL} AND b.grin_address NOT IN (${marks})
                ${k ? 'AND b.reference_type = ?' : ''} ${a.sql}
              ${lim('b.created_at DESC, b.id DESC')}`,
        params: [...RESERVED, ...refP, ...a.params, ...limP],
      });
      // Rolled arm. A cursor on a RAW row whose day has since been rolled up (a prune ran between
      // two pages) cannot say which of that day's credits were already shown, so the arm starts
      // below that day: the rest of that one day is folded away, never shown twice.
      const cut = page && page.rolledCut != null ? page.rolledCut : null;
      const ga = cut != null ? { sql: 'AND g.day < ?', params: [cut] } : IncentivesPublic.after(cur, 3, 'g.day', 'g.rowid');
      arms.push({
        sql: `SELECT CASE g.reference_type WHEN 'prize_award' THEN 'award' ELSE g.reference_type END AS kind,
                     g.grin_address AS addr, g.total_amount AS amount, g.day AS at, NULL AS event_name,
                     NULL AS draw_type, NULL AS ticket_count, NULL AS seed_height, NULL AS seed_hash,
                     NULL AS block_height, NULL AS clawed, 3 AS src, g.rowid AS sid
              FROM balance_log_daily g
              WHERE g.day < ? AND g.event_type = 'credit' AND g.${HISTORY_REF_TYPES_SQL} AND g.grin_address NOT IN (${marks})
                ${k ? 'AND g.reference_type = ?' : ''} ${ga.sql}
              ${lim('g.day DESC, g.rowid DESC')}`,
        params: [rolledBelow, ...RESERVED, ...refP, ...ga.params, ...limP],
      });
    }
    return arms;
  }

  // Validates a `before` cursor: '' / undefined = first page, a cursor = that position, anything
  // else = null (refused).
  static parseCursor(before) {
    if (before === undefined || before === null || before === '') return { first: true };
    if (typeof before !== 'string') return null;
    const m = CURSOR_RE.exec(before);
    if (!m) return null;
    const c = { at: Number(m[1]), src: Number(m[2]), sid: Number(m[3]) };
    return Number.isSafeInteger(c.at) && Number.isSafeInteger(c.sid) ? c : null;
  }

  // kind: '' (all) or one of HISTORY_KINDS. A kind outside it (streak included) or a malformed
  // cursor returns null so the route can refuse it.
  history({ limit = 25, before, kind = '' } = {}, now = Date.now()) {
    const k = kind == null ? '' : String(kind);
    if (k !== '' && !HISTORY_KINDS.includes(k)) return null;
    const cur = IncentivesPublic.parseCursor(before);
    if (!cur) return null;
    const lim = Math.min(Math.max(parseInt(limit, 10) || 25, 1), 100);

    const key = `${k}:${lim}:${cur.first ? '' : before}`;
    const hit = this.historyMemo.get(key);
    if (hit && now - hit.at < MEMO_MS) return hit.data;

    const db = this.db;
    const H = getHorizon(db);
    const m = db.prepare('SELECT MIN(created_at) AS m FROM balance_log').get().m;
    const rolledBelow = m == null ? H : Math.min(floorDay(m), H);

    let total;
    const t = this.totalMemo.get(k);
    if (t && now - t.at < MEMO_MS) {
      total = t.total;
    } else {
      total = IncentivesPublic.historyArms(k, rolledBelow, null)
        .reduce((sum, arm) => sum + db.prepare(`SELECT COUNT(*) AS c FROM (${arm.sql})`).get(...arm.params).c, 0);
      this.totalMemo.set(k, { at: now, total });
    }

    const rolledCut = !cur.first && cur.src === 2 && floorDay(cur.at) < rolledBelow ? floorDay(cur.at) : null;
    const arms = IncentivesPublic.historyArms(k, rolledBelow, { cur, n: lim + 1, rolledCut });
    const got = db.prepare(`
      ${arms.map((arm) => `SELECT * FROM (${arm.sql})`).join(' UNION ALL ')}
      ORDER BY at DESC, src ASC, sid DESC
      LIMIT ?
    `).all(...arms.flatMap((arm) => arm.params), lim + 1);
    const rows = got.slice(0, lim);
    const last = rows[rows.length - 1];

    const data = {
      total,
      next: got.length > lim && last ? `${last.at}-${last.src}-${last.sid}` : null,
      rows: rows.map((r) => {
        const isDraw = r.kind === 'lottery' || r.kind === 'giveaway';
        return {
          kind: r.kind,
          address: mask(r.addr),
          amount: r9(r.amount),
          at: r.at,
          // Same default names as LotteryManager.winnerHistory.
          event: r.kind === 'lottery' ? (r.event_name || (r.draw_type === 'special' ? 'Special' : 'Weekly')) : null,
          prizes: r.kind === 'giveaway' ? r.ticket_count : null,
          seed_height: isDraw ? r.seed_height : null,
          seed_hash: isDraw ? r.seed_hash : null,
          block_height: r.kind === 'jackpot' && r.block_height != null ? r.block_height : null,
          // Raw jackpot: true/false. Rolled jackpot (src 3): null, not knowable.
          clawed_back: r.kind === 'jackpot' && r.src === 2 ? !!r.clawed : null,
        };
      }),
    };
    while (this.historyMemo.size >= HISTORY_MEMO_MAX) this.historyMemo.delete(this.historyMemo.keys().next().value);
    this.historyMemo.set(key, { at: now, data });
    return data;
  }
}

IncentivesPublic.HISTORY_KINDS = HISTORY_KINDS;
IncentivesPublic.KIND_ORDER = KIND_ORDER;
IncentivesPublic.mask = mask;

module.exports = IncentivesPublic;
