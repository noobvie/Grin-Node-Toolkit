// Fortune-board read model tests (lib/incentives-public.js + its two routes in routes/public.js).
//
// Pins: each `offers` key is present exactly when its payer would pay (and a quoted "false" is
// off, as flag() reads it); jackpot clawbacks are netted out; lifetime totals follow the
// ledger-rollup horizon contract (rollup day < H + raw created_at >= H, raw rows below H never
// counted twice); lottery and daily giveaway are split by lottery_winners.pot; reserved
// addresses never count; streak is aggregate-only and history refuses it; history truncates
// addresses, splits raw and rolled rows on the raw floor, and pages stably. Also pins that a
// draw whose prize-pool debit fails writes no lottery_winners row, so the board cannot list a
// prize that was never paid.
//
// Runs the real modules against a throwaway SQLite file and a fake node. Never touches the pool
// DB, starts no server. Run: node scripts/test-incentives-public.js
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

const APP = path.resolve(__dirname, '..');
const dbFile = path.join(os.tmpdir(), `pool-incentives-public-${Date.now()}.sqlite`);

const { initDb, getDb, createSchema, closeDb } = require(path.join(APP, 'lib/db.js'));
initDb(dbFile);
const db = getDb();
createSchema();

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name} ${extra}`); }
};
const near = (a, b) => Math.abs(a - b) < 1e-9;

const cleanup = () => {
  try { closeDb(); } catch (_) {}
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(dbFile + suffix); } catch (_) {}
  }
};

let tipHeight = 5000;
const hashAt = (h) => crypto.createHash('sha256').update(`block-${h}`).digest('hex');
const fakeNode = {
  async getTip() { return { height: tipHeight, hash: hashAt(tipHeight) }; },
  async getHeader(h) {
    if (h > tipHeight) throw new Error('height not found');
    return { height: h, hash: hashAt(h) };
  },
};

const DAY = 86400;
const nowSec = Math.floor(Date.now() / 1000);
const today = Math.floor(nowSec / DAY) * DAY;

const addr = (tag) => `grin1${tag.padEnd(58, 'q')}`;   // 63 chars, like a real address
const account = (a) => db.prepare('INSERT OR IGNORE INTO miner_accounts (grin_address, balance) VALUES (?, 0)').run(a);
const raw = (a, eventType, refType, amount, refId, at) => {
  account(a);
  db.prepare(`
    INSERT INTO balance_log (grin_address, event_type, amount, balance_before, balance_after,
      locked_before, locked_after, reference_type, reference_id, created_at)
    VALUES (?, ?, ?, 0, 0, 0, 0, ?, ?, ?)
  `).run(a, eventType, amount, refType, refId, at);
};
const rolled = (a, eventType, refType, amount, count, day) => db.prepare(`
  INSERT INTO balance_log_daily (day, grin_address, event_type, reference_type, total_amount, event_count)
  VALUES (?, ?, ?, ?, ?, ?)
`).run(day, a, eventType, refType, amount, count);
const setHorizon = (h) => db.prepare(`
  INSERT INTO pool_config (section, key, value, value_type) VALUES ('_state', 'balance_log_rollup_horizon', ?, 'string')
  ON CONFLICT(section, key) DO UPDATE SET value = excluded.value
`).run(String(h));
const draw = (type, eventName, drawnAt, status = 'paid') => db.prepare(`
  INSERT INTO lottery_draws (draw_type, event_name, period_start, period_end, seed_height, seed_hash, status, drawn_at, created_at)
  VALUES (?, ?, ?, ?, 123, ?, ?, ?, ?)
`).run(type, eventName, drawnAt, drawnAt, hashAt(123), status, drawnAt, drawnAt).lastInsertRowid;
const winner = (drawId, a, pot, tickets, amount, at) => db.prepare(`
  INSERT INTO lottery_winners (draw_id, grin_address, pot, ticket_count, amount, created_at) VALUES (?, ?, ?, ?, ?, ?)
`).run(drawId, a, pot, tickets, amount, at);
const wipeLedger = () => {
  for (const t of ['balance_log', 'balance_log_daily', 'lottery_winners', 'lottery_entries', 'lottery_draws', 'miner_incentives', 'campaigns']) {
    db.prepare(`DELETE FROM ${t}`).run();
  }
  db.prepare("DELETE FROM pool_config WHERE section = '_state'").run();
  db.prepare("UPDATE miner_accounts SET balance = 0 WHERE grin_address = 'prize_pool'").run();
};

(async () => {
  const LotteryManager = require(path.join(APP, 'lib/lottery.js'));
  const IncentivesPublic = require(path.join(APP, 'lib/incentives-public.js'));
  const PoolSettings = require(path.join(APP, 'lib/pool-settings.js'));
  const ps = new PoolSettings(db);
  db.prepare("INSERT INTO users (username, password_hash, is_admin, is_active) VALUES ('t','x',1,1)").run();
  const uid = db.prepare("SELECT id FROM users WHERE username='t'").get().id;
  const set = (patch) => ps.updateSection('incentives', patch, uid);

  const lot = new LotteryManager({ network: 'mainnet' }, fakeNode);
  const inc = lot.incentives;
  const fresh = () => new IncentivesPublic({ incentives: inc, lottery: lot });
  const offers = () => fresh().offers();
  const keys = () => Object.keys(offers()).sort().join(',');

  console.log('\n[1] offers: a key is present only while its payer would pay');
  set({ incentives_enabled: 'true' });
  ok('shipped defaults offer nothing (every feature switch is off)', keys() === '', keys());

  set({ join_bonus_enabled: 'true', join_bonus_amount: 0.5 });
  ok('join bonus: on + amount > 0 → offered with its amount',
    offers().join_bonus && offers().join_bonus.amount_grin === 0.5);
  set({ join_bonus_amount: 0 });
  ok('join bonus: amount 0 → absent (maybePayJoinBonus returns before paying)', !offers().join_bonus);
  set({ join_bonus_amount: 0.5 });

  set({ jackpot_enabled: 'true', jackpot_amount: 0 });
  ok('jackpot: amount 0 (the shipped default) → absent', !offers().jackpot);
  set({ jackpot_amount: 2 });
  ok('jackpot: on + amount → offered', offers().jackpot && offers().jackpot.amount_grin === 2);

  set({ streak_enabled: 'true', streak_bonus_per_week_percent: 1, streak_max_percent: 5 });
  ok('streak: on with percents → offered', offers().streak &&
    offers().streak.bonus_per_week_percent === 1 && offers().streak.max_percent === 5);
  set({ streak_max_percent: 0 });
  ok('streak: max 0 → absent (streakMultiplier is 0 for every length)', !offers().streak);
  set({ streak_max_percent: 5 });

  ok('lottery off: no weekly, events or campaigns', !offers().lottery_weekly && !offers().special_events && !offers().campaigns);
  set({ lottery_enabled: 'true' });
  ok('lottery on, weekly off: no weekly card', !offers().lottery_weekly);
  set({ lottery_weekly_enabled: 'true' });
  const wk = offers().lottery_weekly;
  ok('weekly on: offered with the payer\'s numbers', wk && wk.pot_share_weighted_percent === 50 &&
    wk.pot_equal_chance_percent === 50 && wk.min_active_days === 1 && wk.max_ticket_share_percent === 0 &&
    wk.pot_fraction_percent === 100, JSON.stringify(wk));
  ok('weekly: never publishes lottery_min_shares (unused by the payer)', wk && !('min_shares' in wk) && !('lottery_min_shares' in wk));
  ok('weekly: next_draw_at is null before the first weekly draw (due at the next tick)', wk && wk.next_draw_at === null);
  const lastWeekly = nowSec - 3 * DAY;
  db.prepare("INSERT INTO lottery_draws (draw_type, period_start, period_end, status, created_at) VALUES ('weekly', 0, 0, 'pending', ?)").run(lastWeekly);
  ok('weekly: next_draw_at = last weekly draw + 7 days, in UNIX seconds', offers().lottery_weekly.next_draw_at === lastWeekly + 7 * DAY);
  // Save refuses a split above 100, but a restored config row can still carry one.
  const view0 = inc.settingsView;
  inc.settingsView = () => ({ ...view0.call(inc), lottery_pot_share_weighted_percent: 80, lottery_pot_equal_chance_percent: 50 });
  ok('weekly: Pot B is clamped as runDraw clamps it (80 + 50 → 80 + 20)',
    offers().lottery_weekly.pot_share_weighted_percent === 80 && offers().lottery_weekly.pot_equal_chance_percent === 20);
  inc.settingsView = view0;
  set({ lottery_pot_fraction_percent: 0 });
  ok('weekly: pot fraction 0 → absent (the pot is 0, award() pays nothing)', !offers().lottery_weekly);
  set({ lottery_pot_fraction_percent: 100 });

  ok('special events: shipped events are all disabled → absent', !offers().special_events);
  set({ lottery_special_events: JSON.stringify([
    { name: 'Genesis', date: '01-15', pot_grin: 3, enabled: true },
    { name: 'Off', date: '02-02', pot_grin: 0, enabled: false },
  ]) });
  const ev = offers().special_events;
  ok('special events: only enabled events',
    ev && ev.length === 1 && ev[0].name === 'Genesis' && ev[0].date === '01-15' && ev[0].pot_grin === 3, JSON.stringify(ev));
  // Save refuses a malformed date; a restored row can still hold one, and dueDraws never fires it.
  inc.settingsView = () => ({ ...view0.call(inc), lottery_special_events: [{ name: 'Bad date', date: '2-2', pot_grin: 1, enabled: true }] });
  ok('special events: a malformed date is not offered', !offers().special_events);
  inc.settingsView = view0;

  lot.createCampaign({ name: 'Spring', description: 'd', starts_at: nowSec - DAY, ends_at: nowSec + DAY, pot_grin: 4 });
  lot.createCampaign({ name: 'Zero', starts_at: nowSec - DAY, ends_at: nowSec + 2 * DAY, pot_fraction_percent: 0 });
  lot.createCampaign({ name: 'Past', starts_at: nowSec - 3 * DAY, ends_at: nowSec - DAY, pot_grin: 4 });
  const cs = offers().campaigns;
  ok('campaigns: scheduled + not yet ended, and only those whose own pot can pay',
    cs && cs.length === 1 && cs[0].name === 'Spring' && cs[0].pot_grin === 4, JSON.stringify(cs));
  ok('campaign: a campaign with no overrides carries the global rules, resolved',
    cs && cs[0].pot_fraction_percent === 100 && cs[0].pot_share_weighted_percent === 50 && cs[0].pot_equal_chance_percent === 50 &&
    cs[0].min_active_days === 1 && cs[0].max_ticket_share_percent === 0, JSON.stringify(cs && cs[0]));
  // Written behind the validator (a restored row), so the Pot B clamp has something to clamp.
  db.prepare(`INSERT INTO campaigns (name, status, starts_at, ends_at, pot_grin, pot_fraction_percent, weighted_percent,
    equal_chance_percent, min_active_days, max_ticket_share_percent) VALUES ('Override', 'scheduled', ?, ?, 0, 40, 80, 50, 2, 10)`)
    .run(nowSec - DAY, nowSec + 3 * DAY);
  db.prepare(`INSERT INTO campaigns (name, status, starts_at, ends_at, pot_grin, min_active_days)
    VALUES ('Too strict', 'scheduled', ?, ?, 5, 4)`).run(nowSec - DAY, nowSec + DAY);
  const ov2 = offers().campaigns;
  const over = ov2 && ov2.find((c) => c.name === 'Override');
  ok('campaign: overrides resolved as runCampaign + runDraw apply them (Pot B clamped 80 + 50 → 80 + 20)',
    over && over.pot_fraction_percent === 40 && over.pot_share_weighted_percent === 80 && over.pot_equal_chance_percent === 20 &&
    over.min_active_days === 2 && over.max_ticket_share_percent === 10, JSON.stringify(over));
  const winDays = Math.floor((nowSec + DAY) / DAY) - Math.floor((nowSec - DAY) / DAY) + 1;
  ok(`campaign: min_active_days 4 over a window touching ${winDays} UTC days is not offered (nobody can qualify)`,
    winDays === 3 && ov2 && !ov2.some((c) => c.name === 'Too strict'));
  db.prepare("DELETE FROM campaigns WHERE name IN ('Override', 'Too strict')").run();
  const ev2 = offers().special_events;
  ok('special event: carries its own (global) rules, so the page never borrows the weekly card',
    ev2 && ev2[0].pot_fraction_percent === 100 && ev2[0].min_active_days === 1 && ev2[0].pot_share_weighted_percent === 50 &&
    ev2[0].pot_equal_chance_percent === 50 && ev2[0].max_ticket_share_percent === 0, JSON.stringify(ev2));
  // runDraw scores [now − 7 d, now] inclusive, which touches 8 UTC day buckets: 8 can qualify, 9 cannot.
  set({ lottery_min_active_days: 8 });
  ok('min_active_days 8: weekly and special still offered (a 7-day window touches 8 UTC days)',
    !!offers().lottery_weekly && !!offers().special_events);
  set({ lottery_min_active_days: 9 });
  ok('min_active_days 9: weekly and special hidden (nobody can qualify)', !offers().lottery_weekly && !offers().special_events);
  set({ lottery_min_active_days: 1 });

  set({ daily_giveaway_enabled: 'true' });
  const dg = offers().daily_giveaway;
  ok('daily giveaway: publicRules() fields, without lottery_enabled mattering',
    dg && dg.min_grin === 1 && dg.max_grin === 5 && dg.min_winners === 1 && dg.max_winners === 3 && dg.min_active_hours === 6,
    JSON.stringify(dg));

  set({ lottery_enabled: 'false' });
  ok('lottery master off hides weekly, events and campaigns but not the giveaway',
    !offers().lottery_weekly && !offers().special_events && !offers().campaigns && !!offers().daily_giveaway);
  set({ lottery_enabled: 'true' });

  // flag() truthiness: a quoted "false" and a boolean false are both off; only true/'true' is on.
  const realView = inc.settingsView;
  inc.settingsView = () => ({ ...realView.call(inc), jackpot_enabled: 'False', streak_enabled: false, join_bonus_enabled: true });
  ok('flag(): "False" and false are off, boolean true is on', !offers().jackpot && !offers().streak && !!offers().join_bonus);
  inc.settingsView = () => ({ ...realView.call(inc), incentives_enabled: 'false' });
  ok('incentives master off → offers is empty', keys() === '');
  inc.settingsView = realView;

  console.log('\n[2] given: horizon contract, jackpot netting, giveaway split, reserved addresses');
  wipeLedger();
  const A = addr('alice'), B = addr('bob'), C = addr('carol');
  const H = today - 2 * DAY;
  setHorizon(H);
  // Rolled (day < H): counted.
  rolled(A, 'credit', 'join_bonus', 0.5, 1, H - 10 * DAY);
  rolled(B, 'credit', 'prize_award', 3, 2, H - 40 * DAY);
  rolled(A, 'credit', 'streak', 0.2, 4, H - 5 * DAY);
  // Raw rows BELOW H are still on disk (not yet pruned) and are also in the rollup → must not count.
  raw(A, 'credit', 'join_bonus', 0.5, 0, H - 10 * DAY + 100);
  // Raw (created_at >= H): counted.
  raw(C, 'credit', 'jackpot', 2, 777, H + 100);
  raw(B, 'credit', 'jackpot', 2, 778, H + 200);
  raw(B, 'reversal', 'jackpot', 2, 778, H + 300);           // clawed back → nets to 0
  raw(A, 'credit', 'streak', 0.1, 779, H + 400);
  // Prize-pool side and reserved addresses: never miner credits.
  raw('prize_pool', 'debit', 'jackpot', 2, 777, H + 100);
  raw('prize_pool', 'credit', 'jackpot_reversal', 2, 778, H + 300);
  raw('pool_fee', 'credit', 'prize_award', 9, 0, H + 500);
  // Draws: pot a/b = lottery, d = giveaway.
  const wk1 = draw('weekly', null, H + 1000);
  winner(wk1, A, 'a', 10, 1.5, H + 1000);
  winner(wk1, C, 'b', 1, 1.0, H + 1000);
  const dg1 = draw('daily', 'Daily giveaway', H - 30 * DAY);
  winner(dg1, B, 'd', 3, 0.75, H - 30 * DAY);
  draw('daily', 'Daily giveaway', H, 'empty');               // a day nobody qualified: not "held"
  draw('weekly', null, H + 2000, 'committed');                // still waiting for its seed: not "held"

  const g = fresh().given(inc.settingsView(), nowSec);
  const k = Object.fromEntries(g.by_kind.map((x) => [x.kind, x]));
  ok('by_kind lists all six kinds in a fixed order', g.by_kind.map((x) => x.kind).join(',') === 'lottery,giveaway,jackpot,join_bonus,streak,award');
  ok('join bonus counted once (rollup), not again from the unpruned raw row below H',
    near(k.join_bonus.grin, 0.5) && k.join_bonus.count === 1, JSON.stringify(k.join_bonus));
  ok('award from the rollup, reserved pool_fee row excluded', near(k.award.grin, 3) && k.award.count === 2, JSON.stringify(k.award));
  ok('streak = rollup + raw (aggregate only)', near(k.streak.grin, 0.3) && k.streak.count === 5, JSON.stringify(k.streak));
  ok('jackpot net of the clawback (2 + 2 − 2 = 2, one kept)', near(k.jackpot.grin, 2) && k.jackpot.count === 1, JSON.stringify(k.jackpot));
  ok('lottery = pots a + b', near(k.lottery.grin, 2.5) && k.lottery.count === 2, JSON.stringify(k.lottery));
  ok('giveaway = pot d', near(k.giveaway.grin, 0.75) && k.giveaway.count === 1, JSON.stringify(k.giveaway));
  ok('total_grin is the sum of the kinds', near(g.total_grin, 0.5 + 3 + 0.3 + 2 + 2.5 + 0.75), String(g.total_grin));
  ok('miners_rewarded counts real addresses with a positive net (A, B, C)', g.miners_rewarded === 3, String(g.miners_rewarded));
  ok('draws_held counts draws that paid a winner (not empty or still-committed ones)', g.draws_held === 2, String(g.draws_held));
  ok('by_event matches LotteryManager.stats().by_event exactly (shape, names, order)',
    JSON.stringify(g.by_event) === JSON.stringify(lot.stats().by_event) &&
    g.by_event.some((e) => e.event === 'Weekly' && near(e.amount, 2.5) && e.count === 2) &&
    g.by_event.some((e) => e.event === 'Daily giveaway' && near(e.amount, 0.75)), JSON.stringify(g.by_event));
  const months = g.monthly.map((m) => m.month);
  ok('monthly is UTC YYYY-MM, oldest first, with every kind on each row',
    months.length >= 1 && months.every((m, i) => /^\d{4}-\d{2}$/.test(m) && (i === 0 || months[i - 1] < m)) &&
    g.monthly.every((m) => ['lottery', 'giveaway', 'jackpot', 'join_bonus', 'streak', 'award'].every((x) => typeof m[x] === 'number')));
  const monthSum = g.monthly.reduce((s, m) => s + m.lottery + m.giveaway + m.jackpot + m.join_bonus + m.streak + m.award, 0);
  ok('monthly sums to total_grin', near(monthSum, g.total_grin), `${monthSum} vs ${g.total_grin}`);

  // Only B got a clawed-back jackpot; with the award gone too B must drop out.
  db.prepare("DELETE FROM balance_log_daily WHERE grin_address = ? AND reference_type = 'prize_award'").run(B);
  db.prepare('DELETE FROM lottery_winners WHERE grin_address = ?').run(B);
  ok('an address whose only payment was clawed back is not "rewarded"', fresh().given(inc.settingsView(), nowSec).miners_rewarded === 2);

  // Monthly clawbacks never make a negative cell. Months are UTC calendar months.
  wipeLedger();
  setHorizon(0);
  const monthStart = (y, m) => Date.UTC(y, m, 1) / 1000;
  const nowD = new Date(nowSec * 1000);
  const thisMonth = monthStart(nowD.getUTCFullYear(), nowD.getUTCMonth());
  const lastMonth = monthStart(nowD.getUTCFullYear(), nowD.getUTCMonth() - 1);
  const twoBack = monthStart(nowD.getUTCFullYear(), nowD.getUTCMonth() - 2);
  const ym = (t) => new Date(t * 1000).toISOString().slice(0, 7);
  // Raw credit last month, its reversal this month (same block height) → off LAST month's cell.
  raw(A, 'credit', 'jackpot', 2, 4001, lastMonth + 100);
  raw(A, 'credit', 'jackpot', 2, 4002, thisMonth + 100);
  raw(A, 'reversal', 'jackpot', 2, 4001, thisMonth + 200);
  let gm = fresh().given(inc.settingsView(), nowSec);
  let cellOf = (m) => (gm.monthly.find((x) => x.month === m) || {}).jackpot;
  ok('a reversal whose credit is raw comes off the credit\'s month, not its own',
    cellOf(ym(lastMonth)) === 0 && cellOf(ym(thisMonth)) === 2, JSON.stringify(gm.monthly));
  // Rolled credits two months back, a rolled reversal this month with no credit in this month:
  // nothing identifies the credit, so it carries back to the earlier months, never below 0.
  wipeLedger();
  setHorizon(today);
  rolled(B, 'credit', 'jackpot', 2, 1, twoBack);
  rolled(B, 'credit', 'jackpot', 2, 1, lastMonth);
  rolled(B, 'reversal', 'jackpot', 3, 2, thisMonth);
  gm = fresh().given(inc.settingsView(), nowSec);
  cellOf = (m) => (gm.monthly.find((x) => x.month === m) || {}).jackpot;
  const jSum = gm.monthly.reduce((sum, x) => sum + x.jackpot, 0);
  ok('an unattributable reversal carries back newest-first and no monthly cell is negative',
    gm.monthly.every((x) => Object.entries(x).every(([k, v]) => k === 'month' || v >= 0)) &&
    (cellOf(ym(thisMonth)) || 0) === 0 && cellOf(ym(lastMonth)) === 0 && cellOf(ym(twoBack)) === 1, JSON.stringify(gm.monthly));
  const jk = gm.by_kind.find((x) => x.kind === 'jackpot');
  ok('…and the jackpot column still sums to by_kind\'s net jackpot', near(jSum, jk.grin) && near(jk.grin, 1), `${jSum} vs ${jk.grin}`);
  wipeLedger();

  console.log('\n[3] streak_active_miners mirrors streakMultiplier()');
  const day = Math.floor(nowSec / DAY);
  const streakRow = (a, days, last) => { account(a); db.prepare('INSERT OR REPLACE INTO miner_incentives (grin_address, streak_days, last_active_day) VALUES (?, ?, ?)').run(a, days, last); };
  streakRow(addr('s1'), 7, day);          // one full week, active today → counts
  streakRow(addr('s2'), 20, day - 1);     // active yesterday → counts
  streakRow(addr('s3'), 6, day);          // no full week → 0
  streakRow(addr('s4'), 30, day - 2);     // broken → 0
  const sv = inc.settingsView();
  const realActive = [addr('s1'), addr('s2'), addr('s3'), addr('s4')].filter((a) => inc.streakMultiplier(a, sv) > 0).length;
  const counted = fresh().streakActiveMiners(sv, nowSec);
  ok('count equals the addresses streakMultiplier() pays (2)', counted === 2 && realActive === 2, `${counted} vs ${realActive}`);
  ok('streak off → 0', fresh().streakActiveMiners({ ...sv, streak_enabled: 'false' }, nowSec) === 0);

  console.log('\n[4] overview shape');
  inc.creditPrizePool(7, 'topup', 0);
  const ov = fresh().overview();
  ok('overview carries enabled, prize_pool_grin, offers, given, pool_flows',
    ov.enabled === true && near(ov.prize_pool_grin, 7) && ov.offers && ov.given && ov.pool_flows);
  ok('pool_flows = prizePoolStatement in/out/balance with no per-event rows',
    near(ov.pool_flows.balance, 7) && Array.isArray(ov.pool_flows.in.by) && Array.isArray(ov.pool_flows.out.by) &&
    !('recent' in ov.pool_flows));
  ok('overview never carries a full address', !JSON.stringify(ov).includes('grin1'));
  raw('prize_pool', 'debit', 'lottery', 1, 1, nowSec);
  raw('prize_pool', 'debit', 'prize_award', 1, 0, nowSec);
  const outLabels = Object.fromEntries(inc.prizePoolStatement(0).out.by.map((x) => [x.key, x.label]));
  ok('prize-pool outflow labels: lottery covers the giveaway, prize_award is the operator manual award',
    outLabels.lottery === 'Lottery & daily giveaway' && outLabels.prize_award === 'Operator awards', JSON.stringify(outLabels));

  console.log('\n[5] history: kinds, truncation, raw floor, stable pages');
  wipeLedger();
  const H2 = today - DAY;
  setHorizon(H2);
  const R = today - 5 * DAY;              // oldest raw day still on disk
  // Rolled only (pruned from raw): one row per day/address/kind.
  rolled(A, 'credit', 'jackpot', 2, 1, R - 3 * DAY);
  rolled(A, 'reversal', 'jackpot', 2, 1, R - 3 * DAY);        // same-day clawback
  rolled(B, 'credit', 'join_bonus', 0.5, 1, R - 2 * DAY);
  rolled(B, 'credit', 'streak', 0.4, 3, R - 2 * DAY);         // streak: never listed
  // Days in [R, H2) are BOTH rolled and raw: raw must win, rolled must not duplicate.
  rolled(C, 'credit', 'prize_award', 1, 1, R);
  raw(C, 'credit', 'prize_award', 1, 0, R + 50);
  raw(C, 'credit', 'jackpot', 2, 900, R + DAY);
  raw(C, 'credit', 'streak', 0.1, 900, R + DAY);
  raw(A, 'credit', 'jackpot', 2, 901, H2 + 10);
  raw(A, 'reversal', 'jackpot', 2, 901, H2 + 20);
  raw('prize_pool', 'debit', 'jackpot', 2, 900, R + DAY);
  const wk2 = draw('weekly', null, H2 + 30);
  winner(wk2, B, 'a', 99, 1.25, H2 + 30);
  const dg2 = draw('daily', 'Daily giveaway', H2 + 40);
  winner(dg2, C, 'd', 2, 0.5, H2 + 40);
  const sp = draw('special', null, H2 + 50);
  winner(sp, A, 'b', 1, 0.3, H2 + 50);

  const all = fresh().history({ limit: 100 });
  const kinds = all.rows.map((r) => r.kind);
  ok('history total and rows agree', all.total === all.rows.length && all.total === 8, `${all.total} / ${all.rows.length}`);
  ok('no streak row, ever', !kinds.includes('streak'));
  ok('newest first', all.rows.every((r, i) => i === 0 || all.rows[i - 1].at >= r.at));
  ok('every address is truncated (10 + … + 4)', all.rows.every((r) => r.address.length === 15 && r.address.includes('…')));
  ok('no full address anywhere in the payload', !JSON.stringify(all).match(/grin1[a-z0-9]{40,}/));
  const awards = all.rows.filter((r) => r.kind === 'award');
  ok('a day both raw and rolled is listed once, from raw (exact time)', awards.length === 1 && awards[0].at === R + 50);
  const jp = all.rows.filter((r) => r.kind === 'jackpot');
  const jpRaw = jp.find((r) => r.block_height === 901);
  const jpRawKept = jp.find((r) => r.block_height === 900);
  const jpRolled = jp.find((r) => r.block_height === null);
  ok('raw jackpot carries its block height and an exact clawed_back', jpRaw && jpRaw.clawed_back === true && jpRawKept && jpRawKept.clawed_back === false);
  ok('rolled jackpot: UTC-day start, no height, clawed_back null (not knowable without a height)',
    jpRolled && jpRolled.at === R - 3 * DAY && jpRolled.clawed_back === null);
  const lotRow = all.rows.find((r) => r.kind === 'lottery' && r.event === 'Weekly');
  const spRow = all.rows.find((r) => r.kind === 'lottery' && r.event === 'Special');
  const gvRow = all.rows.find((r) => r.kind === 'giveaway');
  ok('lottery rows: event name defaults as winnerHistory, seed fields, no prizes/height',
    lotRow && spRow && lotRow.seed_height === 123 && lotRow.seed_hash === hashAt(123) && lotRow.prizes === null && lotRow.block_height === null);
  ok('lottery row never publishes ticket counts', lotRow && !('ticket_count' in lotRow) && !('tickets' in lotRow));
  ok('giveaway row: prizes = prize count, event null', gvRow && gvRow.prizes === 2 && gvRow.event === null);
  ok('bonus rows carry no seed', all.rows.filter((r) => !['lottery', 'giveaway'].includes(r.kind)).every((r) => r.seed_hash === null && r.seed_height === null));

  const onlyJp = fresh().history({ kind: 'jackpot' });
  ok('kind filter: jackpot only, total matches', onlyJp.rows.every((r) => r.kind === 'jackpot') && onlyJp.total === 3);
  ok('kind filter: giveaway', fresh().history({ kind: 'giveaway' }).total === 1);
  ok('kind=streak is refused', fresh().history({ kind: 'streak' }) === null);
  ok('an unknown kind is refused', fresh().history({ kind: 'block' }) === null);

  ok('a single page that holds everything has next = null', all.next === null);
  const walk = (ip, limit, kind = '') => {
    const out = []; let before; let guard = 0;
    do { const p = ip.history({ limit, before, kind }, Date.now() + guard); out.push(...p.rows); before = p.next; } while (before && ++guard < 50);
    return out;
  };
  const pages = walk(fresh(), 3);
  ok('cursor pages of 3 concatenate to the full list in the same order', JSON.stringify(pages) === JSON.stringify(all.rows));
  ok('cursor pages work per kind too', JSON.stringify(walk(fresh(), 1, 'jackpot')) === JSON.stringify(onlyJp.rows));
  // A row landing between two requests must neither repeat nor shift the next page.
  const ipLive = fresh();
  const p1 = ipLive.history({ limit: 3 });
  raw(C, 'credit', 'prize_award', 9, 0, nowSec + 10);   // newer than everything listed
  const p2 = ipLive.history({ limit: 3, before: p1.next });
  ok('a row landing between pages does not repeat or skip one (keyset, not offset)',
    JSON.stringify(p1.rows.concat(p2.rows)) === JSON.stringify(all.rows.slice(0, 6)));
  db.prepare("DELETE FROM balance_log WHERE amount = 9 AND reference_type = 'prize_award'").run();
  ok('next is the last row position, "<at>-<src>-<sid>"', /^\d+-[1-3]-\d+$/.test(p1.next) && p1.next.startsWith(String(p1.rows[2].at) + '-'));
  ok('limit is capped at 100 and a junk limit falls back to 25', fresh().history({ limit: 5000 }).rows.length === 8 && fresh().history({ limit: 'x' }).rows.length === 8);
  for (const bad of ['abc', '1-4-1', '-1-1-1', '1-1', '1-1-1-1', '1e3-1-1', '9999999999999-1-1', ' 1-1-1', ['1-1-1'], 5, {}]) {
    ok(`a malformed cursor is refused: ${JSON.stringify(bad)}`, fresh().history({ before: bad }) === null);
  }
  ok('an offset parameter is not read', JSON.stringify(fresh().history({ offset: 3, limit: 100 }).rows) === JSON.stringify(all.rows));
  // Reserved pseudo-addresses never appear, even as a CREDIT under a listed type.
  raw('prize_pool', 'credit', 'prize_award', 1, 0, nowSec);
  raw('pool_fee', 'credit', 'jackpot', 1, 5, nowSec);
  ok('a reserved-address credit row never appears in history', fresh().history({ limit: 100 }).total === 8);
  db.prepare("DELETE FROM balance_log WHERE grin_address IN ('prize_pool', 'pool_fee') AND created_at = ?").run(nowSec);
  // mask(): one helper, nothing sent whole.
  const { mask } = IncentivesPublic;
  ok('mask: a full address gets the winnerHistory 10 + … + 4', mask(A) === `${A.slice(0, 10)}…${A.slice(-4)}`);
  ok('mask: a short or odd value keeps at most a third of it', mask('shortaddr12345') === 'shor…' && mask('ab') === '…' && mask('') === '' && mask(null) === '');
  raw('shortaddr12345', 'credit', 'prize_award', 1, 0, nowSec - 5);
  const shortRow = fresh().history({ limit: 100, kind: 'award' }).rows.find((r) => r.amount === 1 && r.at === nowSec - 5);
  ok('a short address in the ledger is masked in history', shortRow && shortRow.address === 'shor…' && !JSON.stringify(shortRow).includes('shortaddr'));
  db.prepare("DELETE FROM balance_log WHERE grin_address = 'shortaddr12345'").run();

  setHorizon(0);
  db.prepare('DELETE FROM balance_log_daily').run();
  ok('no rollup yet: the whole raw ledger is listed', fresh().history({ limit: 100 }).total === 6);

  console.log('\n[6] routes: off gate, refusal, cache header, generic 500');
  const createPublicRoutes = require(path.join(APP, 'routes/public.js'));
  const mkRouter = (incentivesManager, lotteryManager) => createPublicRoutes({
    incentivesManager, lotteryManager,
    rateLimiter: { middleware: (b) => Object.assign((req, res, next) => next(), { bucket: b }) },
    config: {}, poolSettings: {}, adsManager: {}, assetManager: {}, gamesLink: {}, pagesManager: {}, postsManager: {}, stratumPause: null,
  });
  const call = (router, p, query = {}) => {
    const layer = router.stack.find((l) => l.route && l.route.path === p);
    const handlers = layer.route.stack.map((s) => s.handle);
    const res = {
      code: 200, headers: {}, body: null,
      status(c) { this.code = c; return this; },
      setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
      set(k, v) { this.headers[k.toLowerCase()] = v; },
      json(b) { this.body = b; return this; },
    };
    let i = 0;
    const next = () => { const h = handlers[i++]; if (h) h({ query }, res, next); };
    next();
    return res;
  };
  const live = mkRouter(inc, lot);
  const mine = live.stack.filter((l) => l.route && /^\/api\/public\/incentives\//.test(l.route.path));
  ok('both routes are registered', mine.length === 2);
  ok('both sit on the public rate-limit bucket, first in the chain', mine.every((l) => l.route.stack[0].handle.bucket === 'public'));
  let r = call(live, '/api/public/incentives/overview');
  ok('overview: success envelope + Cache-Control public, max-age=60',
    r.code === 200 && r.body.success === true && r.body.data.enabled === true && r.headers['cache-control'] === 'public, max-age=60');
  r = call(live, '/api/public/incentives/history', { kind: 'streak' });
  ok('history: kind=streak answers 400', r.code === 400 && !r.body.success);
  r = call(live, '/api/public/incentives/history', { kind: 'award', limit: '2' });
  ok('history: a valid kind answers rows', r.code === 200 && r.body.data.rows.every((x) => x.kind === 'award'));
  for (const bad of ['garbage', '1-9-1', ['1-1-1', '2-1-1']]) {
    r = call(live, '/api/public/incentives/history', { before: bad });
    ok(`history: a malformed cursor answers 400, never 500: ${JSON.stringify(bad)}`, r.code === 400 && r.body.error === 'Bad cursor');
  }
  r = call(live, '/api/public/incentives/history', { limit: '1' });
  const r2 = r.body.data.next ? call(live, '/api/public/incentives/history', { limit: '1', before: r.body.data.next }) : null;
  ok('history: next carries to the following page through the route', r.code === 200 && 'next' in r.body.data &&
    (r.body.data.next === null || (r2 && r2.code === 200 && JSON.stringify(r2.body.data.rows) !== JSON.stringify(r.body.data.rows))));

  set({ incentives_enabled: 'false' });
  r = call(mkRouter(inc, lot), '/api/public/incentives/overview');
  ok('incentives off: overview is exactly { enabled: false }', r.code === 200 && JSON.stringify(r.body.data) === '{"enabled":false}');
  r = call(mkRouter(inc, lot), '/api/public/incentives/history');
  ok('incentives off: history is empty', r.code === 200 && r.body.data.total === 0 && r.body.data.rows.length === 0 && r.body.data.next === null);
  set({ incentives_enabled: 'true' });

  const broken = { enabled: () => true, get db() { throw new Error('SQLITE_ERROR: no such table secret_thing'); } };
  r = call(mkRouter(broken, lot), '/api/public/incentives/overview');
  ok('a failure is a 500 with a generic message (no error text leaks)',
    r.code === 500 && r.body.error === 'Failed to load incentives overview' && !JSON.stringify(r.body).includes('secret_thing'));
  r = call(mkRouter(broken, lot), '/api/public/incentives/history');
  ok('history failure is a generic 500 too', r.code === 500 && r.body.error === 'Failed to load reward history');

  console.log('\n[7] a draw whose prize-pool debit fails writes no winner row');
  wipeLedger();
  set({ lottery_enabled: 'true' });
  const M1 = addr('m1'), M2 = addr('m2');
  for (const a of [M1, M2]) {
    account(a);
    db.prepare('INSERT INTO hashrate_history (grin_address, hashrate_gps, window_seconds, recorded_at) VALUES (?, 100, 3600, ?)').run(a, nowSec - 3600);
  }
  inc.creditPrizePool(10, 'topup', 0);
  const committed = await lot.runDraw('weekly');
  ok('weekly draw committed with a pot', committed.success && committed.pot_a > 0);
  db.prepare("UPDATE miner_accounts SET balance = 0 WHERE grin_address = 'prize_pool'").run();
  tipHeight = committed.seed_height;
  await lot.resolveCommittedDraws();
  ok('empty prize pool at reveal → no lottery_winners row, no credit',
    db.prepare('SELECT COUNT(*) AS c FROM lottery_winners').get().c === 0 &&
    db.prepare("SELECT COUNT(*) AS c FROM balance_log WHERE reference_type = 'lottery'").get().c === 0);
  const row = db.prepare('SELECT status FROM lottery_draws WHERE id = ?').get(committed.draw_id);
  ok('…and the draw closes as drawn (held), not paid', row.status === 'drawn', row.status);
  ok('…so the board lists nothing for it', fresh().history({ kind: 'lottery' }).total === 0);
  ok('…and the overview does not count it as held (lottery/stats still does, unchanged)',
    fresh().given(inc.settingsView(), nowSec).draws_held === 0 && lot.stats().total_draws === 1);

  console.log('\n[8] query plans: the fortune-board reads use their partial indexes, nothing else moves');
  // Without ANALYZE (production never runs it) a full (reference_type, event_type, …) index
  // outvotes idx_balance_log_address on per-address block reads. The partial indexes are only
  // usable by a query that repeats their WHERE term, so these pin both halves.
  const dbSrc = fs.readFileSync(path.join(APP, 'lib/db.js'), 'utf8');
  const ipSrc = fs.readFileSync(path.join(APP, 'lib/incentives-public.js'), 'utf8');
  const reEsc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const termOf = (name) => (ipSrc.match(new RegExp(`const ${name} = "([^"]+)";`)) || [])[1];
  const bonusTerm = termOf('BONUS_REF_TYPES_SQL');
  const histTerm = termOf('HISTORY_REF_TYPES_SQL');
  ok('idx_balance_log_bonus + idx_bld_bonus carry BONUS_REF_TYPES_SQL verbatim (the only indexes with streak in them)',
    !!bonusTerm && (dbSrc.match(new RegExp(`WHERE ${reEsc(bonusTerm)}\``, 'g')) || []).length === 2, bonusTerm);
  ok('idx_balance_log_history + idx_bld_history carry HISTORY_REF_TYPES_SQL verbatim',
    !!histTerm && (dbSrc.match(new RegExp(`WHERE ${reEsc(histTerm)}\``, 'g')) || []).length === 2, histTerm);
  const planOf = (fn) => {
    const seen = [];
    const realPrepare = db.prepare.bind(db);
    db.prepare = (sql) => { seen.push(sql); return realPrepare(sql); };
    try { fn(); } finally { db.prepare = realPrepare; }
    return seen.filter((s) => /balance_log/.test(s) && /^\s*SELECT/i.test(s))
      .map((s) => realPrepare(`EXPLAIN QUERY PLAN ${s}`).all(...Array((s.match(/\?/g) || []).length).fill(0)).map((r) => r.detail).join(' | '))
      .join(' || ');
  };
  const ovPlan = planOf(() => fresh().given(inc.settingsView(), nowSec));
  ok('given(): rollup via idx_bld_bonus, raw half via idx_balance_log_bonus (never every raw row since H), no full scan',
    /balance_log_daily USING INDEX idx_bld_bonus/.test(ovPlan) &&
    /SEARCH b USING INDEX idx_balance_log_bonus \(event_type=\? AND created_at>\?\)/.test(ovPlan) &&
    !/idx_balance_log_time/.test(ovPlan) && !/SCAN (b|c|balance_log|balance_log_daily)\b/.test(ovPlan), ovPlan);
  ok('given(): credit_month is looked up by idx_balance_log_history, never one address\'s rows',
    /SEARCH c USING INDEX idx_balance_log_history \(event_type=\?\)/.test(ovPlan) && !/idx_balance_log_address/.test(ovPlan), ovPlan);
  const hPlan = planOf(() => fresh().history({ limit: 25 }));
  ok('history(): raw rows via idx_balance_log_history, rolled via idx_bld_history, no full scan',
    /SEARCH b USING INDEX idx_balance_log_history/.test(hPlan) && /SEARCH g USING INDEX idx_bld_history/.test(hPlan) &&
    // First page: the winners arm walks idx_lottery_winners_time newest first and stops at its
    // LIMIT ("SCAN w USING INDEX" in index order), which is a page, not a scan.
    !/SCAN (b|g|r|balance_log)\b/.test(hPlan) && !/SCAN w(?! USING INDEX idx_lottery_winners_time)/.test(hPlan), hPlan);
  // A deep cursor must cost about a page: each arm walks its own index from the cursor down,
  // in order, with its own LIMIT — so no arm sorts its whole range (no temp b-tree inside an arm
  // before its LIMIT) and the arms meet in a MERGE.
  const pagePlan = (args) => {
    const seen = [];
    const realPrepare = db.prepare.bind(db);
    db.prepare = (sql) => { seen.push(sql); return realPrepare(sql); };
    try { fresh().history(args); } finally { db.prepare = realPrepare; }
    const sql = seen.find((x) => /ORDER BY at DESC/.test(x));
    return realPrepare(`EXPLAIN QUERY PLAN ${sql}`).all(...Array((sql.match(/\?/g) || []).length).fill(0)).map((r) => r.detail);
  };
  const deep = pagePlan({ limit: 25, before: '1700000000-2-5' });
  const deepText = deep.join(' | ');
  ok('a cursor page: the three arms walk idx_lottery_winners_time / idx_balance_log_history / idx_bld_history with the cursor as a range',
    /SEARCH w USING INDEX idx_lottery_winners_time \(created_at<\?\)/.test(deepText) &&
    /SEARCH b USING INDEX idx_balance_log_history \(event_type=\? AND created_at<\?\)/.test(deepText) &&
    /SEARCH g USING INDEX idx_bld_history \(event_type=\? AND day<\?\)/.test(deepText), deepText);
  ok('a cursor page: the arms meet in MERGE (UNION ALL), each arm ordered by its index (no sort before its LIMIT)',
    /MERGE \(UNION ALL\)/.test(deepText) && deep.every((d, i) => !(/^SEARCH (w|b|g) /.test(d) && /TEMP B-TREE/.test(deep[i + 1] || ''))), deepText);
  const deepKind = pagePlan({ limit: 25, kind: 'jackpot', before: '1700000000-2-5' }).join(' | ');
  ok('a kind page reads only its own arms (jackpot: no lottery_winners arm)', !/SEARCH w /.test(deepKind) && /SEARCH b /.test(deepKind), deepKind);
  ok('history(): the clawed_back check walks reversals by the partial index, never one address\'s rows',
    /SEARCH r USING INDEX idx_balance_log_history \(event_type=\?\)/.test(hPlan) && !/SEARCH r USING INDEX idx_balance_log_address/.test(hPlan), hPlan);
  ok('history(): no read touches the streak-bearing index', !/idx_bld_bonus/.test(hPlan));
  const ppPlan = planOf(() => inc.prizePoolStatement(0));
  ok('prizePoolStatement keeps its per-address indexes',
    /idx_bld_address/.test(ppPlan) && /idx_balance_log_address/.test(ppPlan) && !/_bonus|_history/.test(ppPlan), ppPlan);
  const blockPlan = db.prepare("EXPLAIN QUERY PLAN SELECT COALESCE(SUM(amount),0) s FROM balance_log WHERE grin_address = ? AND event_type = 'credit' AND reference_type = 'block' AND reference_id = ?")
    .all('x', 1).map((r) => r.detail).join(' | ');
  ok('a per-address block-credit read still uses idx_balance_log_address', /idx_balance_log_address/.test(blockPlan), blockPlan);

  console.log('\n[9] scale: one busy address with many jackpots does not stall the history read');
  // The clawed_back check once planned on idx_balance_log_address and ran per jackpot row, so its
  // cost was jackpots × that address's raw rows (about 40 s at 1,800 jackpots on a live-sized
  // ledger). Seeded here: 1,000 jackpots and 50,000 block credits on ONE address, plus 50,000
  // streak credits. The bound is loose for a slow box; the broken plan takes seconds.
  wipeLedger();
  const BUSY = addr('busy');
  account(BUSY);
  const t0 = nowSec - 30 * DAY;
  db.exec('BEGIN');
  db.prepare(`WITH RECURSIVE k(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM k WHERE i < 49999)
    INSERT INTO balance_log (grin_address, event_type, amount, balance_before, balance_after, locked_before, locked_after, reference_type, reference_id, created_at)
    SELECT ?, 'credit', 0.1, 0, 0, 0, 0, 'block', i, ? + i * 50 FROM k`).run(BUSY, t0);
  db.prepare(`WITH RECURSIVE k(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM k WHERE i < 49999)
    INSERT INTO balance_log (grin_address, event_type, amount, balance_before, balance_after, locked_before, locked_after, reference_type, reference_id, created_at)
    SELECT ?, 'credit', 0.003, 0, 0, 0, 0, 'streak', i, ? + i * 50 + 1 FROM k`).run(BUSY, t0);
  db.prepare(`WITH RECURSIVE k(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM k WHERE i < 999)
    INSERT INTO balance_log (grin_address, event_type, amount, balance_before, balance_after, locked_before, locked_after, reference_type, reference_id, created_at)
    SELECT ?, 'credit', 2, 0, 0, 0, 0, 'jackpot', 100000 + i, ? + i * 2500 + 2 FROM k`).run(BUSY, t0);
  db.exec('COMMIT');
  const clock = (fn) => { const t = process.hrtime.bigint(); const r = fn(); return { r, ms: Number(process.hrtime.bigint() - t) / 1e6 }; };
  const big = clock(() => fresh().history({ limit: 100 }));
  ok(`history first page over 1,000 jackpots on one busy address: ${big.ms.toFixed(1)} ms (< 400)`,
    big.ms < 400 && big.r.total === 1000 && big.r.rows.length === 100, `${big.ms} ms, total ${big.r.total}`);
  const bigKind = clock(() => fresh().history({ limit: 100, kind: 'jackpot' }));
  ok(`history kind=jackpot, same ledger: ${bigKind.ms.toFixed(1)} ms (< 400)`, bigKind.ms < 400, `${bigKind.ms} ms`);
  let deepest = null; let pageCount = 0;
  const walker = fresh();
  for (let before; pageCount < 20; pageCount++) {
    const p = walker.history({ limit: 100, before }, Date.now() + pageCount);
    deepest = p;
    if (!p.next) break;
    before = p.next;
  }
  ok('walking every page reaches the last one (next = null)', deepest && deepest.next === null && pageCount === 9, String(pageCount));

  // A cache-busting cursor (a fresh one per request) costs about a page, not the whole history:
  // 20,000 rolled jackpot rows + 3,000 giveaway winners + the raw rows above, then cursors that
  // point near the top of each arm.
  db.exec('BEGIN');
  db.prepare(`WITH RECURSIVE d(j) AS (SELECT 1 UNION ALL SELECT j + 1 FROM d WHERE j < 400), k(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM k WHERE n < 50)
    INSERT OR IGNORE INTO balance_log_daily (day, grin_address, event_type, reference_type, total_amount, event_count)
    SELECT ? - j * ${DAY}, 'grin1' || printf('%058d', n), 'credit', 'jackpot', 2, 1 FROM d, k`).run(today - 40 * DAY);
  db.prepare(`WITH RECURSIVE d(j) AS (SELECT 1 UNION ALL SELECT j + 1 FROM d WHERE j < 600)
    INSERT INTO lottery_draws (draw_type, event_name, period_start, period_end, seed_height, seed_hash, status, drawn_at, created_at)
    SELECT 'daily', 'Daily giveaway', ? - j * ${DAY}, ? - j * ${DAY}, 1, 'ab', 'paid', ? - j * ${DAY}, ? - j * ${DAY} FROM d`).run(nowSec, nowSec, nowSec, nowSec);
  db.exec(`WITH RECURSIVE k(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM k WHERE n < 5)
    INSERT INTO lottery_winners (draw_id, grin_address, pot, ticket_count, amount, created_at)
    SELECT d.id, 'grin1' || printf('%058d', n), 'd', 1, 0.2, d.drawn_at FROM lottery_draws d, k`);
  db.exec('COMMIT');
  setHorizon(today - 35 * DAY);
  const buster = fresh();
  buster.history({ limit: 100 });              // fills the per-kind total memo, as a live page does
  let worst = 0;
  for (let i = 0; i < 20; i++) {
    const c = clock(() => buster.history({ limit: 100, before: `${nowSec + 1000 + i}-1-${i}` }, Date.now() + i));
    worst = Math.max(worst, c.ms);
  }
  ok(`20 cache-busting cursors over ~25,000 history rows: worst ${worst.toFixed(1)} ms (< 60)`, worst < 60, `${worst} ms`);

  // The rollup half of given() is memoised on (H, MAX(rowid) of balance_log_daily): the same
  // state reads it once; a moved H or a new rolled row reads it again.
  setHorizon(today - DAY);
  const ipMemo = fresh();
  const dailyReads = (fn) => {
    let n = 0;
    const realPrepare = db.prepare.bind(db);
    db.prepare = (sql) => { if (/SUM\(total_amount\)[\s\S]*FROM balance_log_daily/.test(sql)) n++; return realPrepare(sql); };
    try { fn(); } finally { db.prepare = realPrepare; }
    return n;
  };
  ok('given(): first call reads the rollup', dailyReads(() => ipMemo.given(inc.settingsView(), nowSec)) === 1);
  ok('given(): same horizon, no new rolled row → the rollup is not read again', dailyReads(() => ipMemo.given(inc.settingsView(), nowSec)) === 0);
  setHorizon(today);
  ok('given(): the horizon moved → the rollup is read again', dailyReads(() => ipMemo.given(inc.settingsView(), nowSec)) === 1);
  rolled(addr('late'), 'credit', 'join_bonus', 0.5, 1, today - 90 * DAY);
  const afterInsert = { n: dailyReads(() => ipMemo.given(inc.settingsView(), nowSec)) };
  const lateGiven = ipMemo.given(inc.settingsView(), nowSec);
  ok('given(): a new rolled row below H with H unchanged → read again, and it is counted',
    afterInsert.n === 1 && lateGiven.by_kind.find((x) => x.kind === 'join_bonus').grin >= 0.5);

  // The raw half is memoised per H too and then reads only ids above its watermark, by rowid
  // range — so a stale H (retention off) costs one cold read, not one per overview.
  setHorizon(today - 2 * DAY);
  const ipRaw = fresh();
  const g0 = ipRaw.given(inc.settingsView(), nowSec);
  const streak0 = g0.by_kind.find((x) => x.kind === 'streak');
  const sqlSeen = [];
  const realPrepare2 = db.prepare.bind(db);
  db.prepare = (sql) => { sqlSeen.push(sql); return realPrepare2(sql); };
  raw(addr('inc1'), 'credit', 'streak', 0.25, 1, nowSec - 10);
  raw(addr('inc1'), 'credit', 'jackpot', 2, 777001, nowSec - 9);
  raw(addr('inc1'), 'reversal', 'jackpot', 2, 777001, nowSec - 8);
  let g1;
  try { g1 = ipRaw.given(inc.settingsView(), nowSec); } finally { db.prepare = realPrepare2; }
  const streak1 = g1.by_kind.find((x) => x.kind === 'streak');
  const jp1 = g1.by_kind.find((x) => x.kind === 'jackpot');
  const jp0 = g0.by_kind.find((x) => x.kind === 'jackpot');
  ok('given(): new raw rows after a warm read are counted (streak +0.25, jackpot +2 −2)',
    near(streak1.grin, streak0.grin + 0.25) && streak1.count === streak0.count + 1 && near(jp1.grin, jp0.grin) && jp1.count === jp0.count,
    JSON.stringify([streak0, streak1, jp0, jp1]));
  const incSql = sqlSeen.find((x) => /b\.id > \? AND b\.id <= \?/.test(x));
  const incPlan = incSql ? realPrepare2(`EXPLAIN QUERY PLAN ${incSql}`).all(...Array((incSql.match(/\?/g) || []).length).fill(0)).map((r) => r.detail).join(' | ') : '';
  ok('given(): the warm raw read is a rowid range, not a walk from H',
    /SEARCH b USING INTEGER PRIMARY KEY \(rowid>\? AND rowid<\?\)/.test(incPlan) && !/idx_balance_log_bonus|idx_balance_log_time/.test(incPlan), incPlan);
  ok('given(): the warm read issues no cold raw query', !sqlSeen.some((x) => /b\.created_at >= \? AND b\.reference_type IN/.test(x)));
  const gCold = fresh().given(inc.settingsView(), nowSec);
  ok('given(): warm (incremental) and cold reads agree', JSON.stringify(gCold.by_kind) === JSON.stringify(g1.by_kind) &&
    JSON.stringify(gCold.monthly) === JSON.stringify(g1.monthly));

  console.log('\n[10] a prune between two pages never repeats GRIN');
  // Page 1 shows four raw credits of day D; then the retention pass rolls day D up and prunes its
  // raw rows, so the cursor points at a raw row that no longer exists and day D is one rolled row
  // holding all ten credits, four of them already shown. Page 2 must not list that rolled row.
  wipeLedger();
  const LR = require(path.join(APP, 'lib/ledger-rollup.js'));
  const P = addr('prune');
  const D = today - 60 * DAY;
  for (let h = 1; h <= 10; h++) raw(P, 'credit', 'join_bonus', 1, 0, D + h * 3600);
  raw(P, 'credit', 'join_bonus', 1, 0, D - DAY + 3600);
  const pub = fresh();
  const q1 = pub.history({ limit: 4 });
  LR.rollupCompletedDays(db);
  LR.verifyAndPruneRaw(db, 45, 400);
  ok('the prune really ran (day D is rolled, its raw rows gone)',
    db.prepare('SELECT COUNT(*) AS c FROM balance_log WHERE created_at < ?').get(D + DAY).c === 0 &&
    db.prepare("SELECT total_amount AS t FROM balance_log_daily WHERE day = ? AND reference_type = 'join_bonus'").get(D).t === 10);
  const q2 = pub.history({ limit: 100, before: q1.next });
  const shown = q1.rows.concat(q2.rows).reduce((sum, r) => sum + r.amount, 0);
  ok('page 2 after the prune skips the rest of day D instead of repeating it', q2.rows.every((r) => r.at < D) &&
    q2.rows.length === 1 && q2.rows[0].at === D - DAY && q2.rows[0].amount === 1, JSON.stringify(q2.rows.map((r) => [r.at - D, r.amount])));
  ok(`GRIN shown across both pages (${shown}) never exceeds the ledger (11)`, shown <= 11 && shown === 5);
  const fresh2 = fresh().history({ limit: 100 });
  ok('a fresh walk after the prune shows the whole ledger once', fresh2.rows.reduce((sum, r) => sum + r.amount, 0) === 11 && fresh2.rows.length === 2);

  console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed\n`);
  cleanup();
  process.exit(fail === 0 ? 0 : 1);
})().catch((err) => {
  console.error(err);
  cleanup();
  process.exit(1);
});
