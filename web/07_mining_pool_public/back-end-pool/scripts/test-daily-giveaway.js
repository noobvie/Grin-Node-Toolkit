// Daily giveaway regression tests (lib/daily-giveaway.js, script07_design.md "Daily giveaway").
//
// Runs the real commit, reveal and payout code against a throwaway SQLite file and a fake node,
// with 1, 3 and 50 miners, because a pool with one miner cannot show on its own that the
// multi-winner path works. Never touches the pool DB. Run: node scripts/test-daily-giveaway.js
const path = require('path');
const fs = require('fs');
const os = require('os');

const APP = path.resolve(__dirname, '..');
const dbFile = path.join(os.tmpdir(), `pool-giveaway-${Date.now()}.sqlite`);

const { initDb, getDb, createSchema, closeDb } = require(path.join(APP, 'lib/db.js'));
initDb(dbFile);
const db = getDb();
createSchema();

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name} ${extra}`); }
};
const near = (a, b) => Math.abs(a - b) < 1e-6;

const cleanup = () => {
  try { closeDb(); } catch (_) {}
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(dbFile + suffix); } catch (_) {}
  }
};

// Fake node: every height has a distinct, reproducible hash; the tip can be moved.
let tipHeight = 1000;
const crypto = require('crypto');
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
const yesterday = today - DAY;

// One hour-long sample per hour for `hours` hours of the given UTC day.
const mineDay = (address, dayStart, hours, gps = 100) => {
  db.prepare('INSERT OR IGNORE INTO miner_accounts (grin_address, balance) VALUES (?, 0)').run(address);
  const ins = db.prepare(
    'INSERT INTO hashrate_history (grin_address, hashrate_gps, window_seconds, recorded_at) VALUES (?, ?, 3600, ?)'
  );
  for (let h = 0; h < hours; h++) ins.run(address, gps, dayStart + h * 3600 + 30);
};
const miners = (n, prefix) => Array.from({ length: n }, (_, i) => `grin1${prefix}${String(i).padStart(3, '0')}`);
const tickets = (list, count = 1) => list.map((address) => ({ address, tickets: count }));
const prizesOf = (winners) => winners.reduce((sum, w) => sum + w.wins, 0);
const wipe = () => {
  for (const t of ['lottery_winners', 'lottery_entries', 'lottery_draws', 'hashrate_history']) db.prepare(`DELETE FROM ${t}`).run();
};

(async () => {
  const LotteryManager = require(path.join(APP, 'lib/lottery.js'));
  const DailyGiveaway = require(path.join(APP, 'lib/daily-giveaway.js'));
  const PoolSettings = require(path.join(APP, 'lib/pool-settings.js'));
  const ps = new PoolSettings(db);
  db.prepare("INSERT INTO users (username, password_hash, is_admin, is_active) VALUES ('t','x',1,1)").run();
  const uid = db.prepare("SELECT id FROM users WHERE username='t'").get().id;

  const lot = new LotteryManager({ network: 'mainnet' }, fakeNode);
  const inc = lot.incentives;
  const daily = lot.daily;
  const pool = () => inc.prizePoolBalance();
  const balance = (a) => (db.prepare('SELECT balance FROM miner_accounts WHERE grin_address=?').get(a) || {}).balance || 0;
  const seedAndReveal = async (res) => {
    tipHeight = res.seed_height;
    return lot.resolveCommittedDraws();
  };

  console.log('\n[1] switches and settings');
  ok('off by default: the scheduler does nothing', (await daily.runDue()) === null);
  ps.updateSection('incentives', { incentives_enabled: 'true', daily_giveaway_enabled: 'true' }, uid);
  ok('works without lottery_enabled', daily.enabled() === true);
  let threw = false;
  try { ps.updateSection('incentives', { daily_giveaway_min_grin: 9, daily_giveaway_max_grin: 2 }, uid); } catch (_) { threw = true; }
  ok('min GRIN above max GRIN is refused on save', threw);
  threw = false;
  try { ps.updateSection('incentives', { daily_giveaway_min_winners: 9, daily_giveaway_max_winners: 2 }, uid); } catch (_) { threw = true; }
  ok('min winners above max winners is refused on save', threw);
  threw = false;
  try { ps.updateSection('incentives', { daily_giveaway_max_grin: 'Infinity' }, uid); } catch (_) { threw = true; }
  ok('an infinite amount is refused on save', threw);
  ps.updateSection('incentives', {
    daily_giveaway_min_grin: 2, daily_giveaway_max_grin: 6,
    daily_giveaway_min_winners: 2, daily_giveaway_max_winners: 4, daily_giveaway_min_active_hours: 6,
  }, uid);
  // A row written behind the validators must not reach a draw it could wedge.
  const realView = inc.settingsView;
  inc.settingsView = () => ({ ...realView.call(inc), daily_giveaway_max_grin: 1e300 });
  ok('an out-of-range stored amount makes no rules', daily.rules() === null);
  inc.settingsView = realView;

  console.log('\n[2] plan(): limits hold across 3000 seeds');
  const rules = daily.rules();
  const fifty = tickets(miners(50, 'plan'));
  let inRange = true, unique = true, exact = true;
  const seenCounts = new Set();
  let lowHalf = 0, severalWinners = 0;
  for (let i = 0; i < 3000; i++) {
    const p = daily.plan(hashAt(i), i, fifty, rules, 1e6);
    if (p.rolled_grin < 2 || p.rolled_grin > 6) inRange = false;
    if (prizesOf(p.winners) < 2 || prizesOf(p.winners) > 4) inRange = false;
    if (new Set(p.winners.map((w) => w.address)).size !== p.winners.length) unique = false;
    if (p.total_grin > p.rolled_grin + 1e-9 || p.rolled_grin - p.total_grin > 1e-8) exact = false;
    seenCounts.add(prizesOf(p.winners));
    if (p.winners.length > 1) severalWinners++;
    if (p.rolled_grin < 4) lowHalf++;
  }
  ok('total and prize count stay inside the limits', inRange);
  ok('a miner with several wins is one winner row', unique);
  ok('shares add up to the rolled total, rounded down', exact);
  ok('each prize of a draw is picked separately', severalWinners > 2900, String(severalWinners));
  ok('every prize count in the range occurs', seenCounts.size === 3, [...seenCounts].join());
  ok('amounts spread across the range', lowHalf > 1200 && lowHalf < 1800, String(lowHalf));
  const a = daily.plan(hashAt(7), 7, fifty, rules, 1e6);
  const b = daily.plan(hashAt(7), 7, fifty, rules, 1e6);
  ok('the same seed gives the same result', JSON.stringify(a) === JSON.stringify(b));
  const fixed = daily.plan(hashAt(1), 1, fifty, { ...rules, min_grin: 3, max_grin: 3, min_winners: 2, max_winners: 2 }, 1e6);
  ok('equal limits give a fixed result', near(fixed.total_grin, 3) && prizesOf(fixed.winners) === 2);
  const wins = new Map();
  for (let i = 0; i < 20000; i++) {
    const w = daily.plan(hashAt(`f${i}`), i, fifty, { ...rules, min_winners: 1, max_winners: 1 }, 1e6).winners[0].address;
    wins.set(w, (wins.get(w) || 0) + 1);
  }
  const counts = [...wins.values()];
  ok('equal work gives a similar chance', wins.size === 50 && Math.min(...counts) > 280 && Math.max(...counts) < 530,
     `${Math.min(...counts)}..${Math.max(...counts)}`);

  console.log('\n[2b] the chance follows work');
  const oneWinner = { ...rules, min_winners: 1, max_winners: 1 };
  const winsFor = (entries, match, seeds = 10000) => {
    let n = 0;
    for (let i = 0; i < seeds; i++) {
      if (match(daily.plan(hashAt(`w${i}`), i, entries, oneWinner, 1e6).winners[0].address)) n++;
    }
    return n;
  };
  const nineToOne = winsFor([{ address: 'grin1big', tickets: 900 }, { address: 'grin1small', tickets: 100 }], (w) => w === 'grin1big');
  ok('nine times the work wins about nine times as often', nineToOne > 8800 && nineToOne < 9200, String(nineToOne));
  // Prize money, across draws of 1 to 4 prizes, because a one-prize draw hides what a multi-prize
  // draw can do. 50/50 work split into 10 addresses, and 30/70 split into 5.
  const moneyShare = (entries, isRig, n, seeds = 20000) => {
    const r = { ...rules, min_winners: n, max_winners: n };
    let rig = 0;
    for (let i = 0; i < seeds; i++) {
      for (const w of daily.plan(hashAt(`s${n}:${i}`), i, entries, r, 1e6).winners) {
        if (isRig(w.address)) rig += w.wins;
      }
    }
    return rig / (seeds * n);
  };
  const isSplit = (a) => a.startsWith('grin1split');
  for (const n of [1, 2, 3, 4]) {
    const half = moneyShare([...tickets(miners(10, 'split'), 50), { address: 'grin1other', tickets: 500 }], isSplit, n);
    const third = moneyShare([...tickets(miners(5, 'split'), 60), { address: 'grin1other', tickets: 700 }], isSplit, n);
    ok(`${n} prize(s): splitting wins the rig's work share and no more`, Math.abs(half - 0.5) < 0.012 && Math.abs(third - 0.3) < 0.012,
       `${half} ${third}`);
  }
  const repeat = daily.plan(hashAt(1), 1, [{ address: 'grin1big', tickets: 1e9 }, { address: 'grin1small', tickets: 1 }],
    { ...rules, min_grin: 4, max_grin: 4, min_winners: 4, max_winners: 4 }, 1e6);
  ok('one miner can win several prizes of a draw', repeat.winners.length === 1 && repeat.winners[0].wins === 4 && near(repeat.share_grin, 1),
     JSON.stringify(repeat));

  console.log('\n[3] eligibility');
  wipe();
  mineDay('grin1steady', yesterday, 6);
  mineDay('grin1burst', yesterday, 5, 900000);
  mineDay('grin1today', today, 12);
  mineDay('prize_pool', yesterday, 24);
  mineDay('grin1banned', yesterday, 12);
  db.prepare("UPDATE miner_accounts SET is_banned = 1 WHERE grin_address = 'grin1banned'").run();
  // The window is half-open: a sample exactly at its start counts, one exactly at its end does not.
  const rawSample = db.prepare('INSERT INTO hashrate_history (grin_address, hashrate_gps, window_seconds, recorded_at) VALUES (?, 100, ?, ?)');
  for (const a of ['grin1first', 'grin1last']) db.prepare('INSERT OR IGNORE INTO miner_accounts (grin_address, balance) VALUES (?, 0)').run(a);
  rawSample.run('grin1first', 6 * 3600, yesterday);
  rawSample.run('grin1last', 6 * 3600, today);
  // One rig touring 60 addresses, a minute each, in each of six hours: under an hour of work apiece.
  const tour = miners(60, 'tour');
  tour.forEach((a, i) => {
    db.prepare('INSERT OR IGNORE INTO miner_accounts (grin_address, balance) VALUES (?, 0)').run(a);
    for (let h = 0; h < 6; h++) rawSample.run(a, 60, yesterday + h * 3600 + i * 60);
  });
  const elEntries = daily.eligibleEntries(yesterday, today, 6);
  const el = elEntries.map((e) => e.address);
  ok('six hours qualifies', el.includes('grin1steady'));
  ok('five hours does not, however much hashrate', !el.includes('grin1burst'));
  ok('work outside the day does not count', !el.includes('grin1today'));
  ok('a reserved bucket never qualifies', !el.includes('prize_pool'));
  ok('a banned address never qualifies', !el.includes('grin1banned'));
  ok('a sample at the start of the day counts', el.includes('grin1first'));
  ok('a sample at the end of the day does not', !el.includes('grin1last'));
  ok('six minutes of samples per address does not qualify', !el.some((a) => tour.includes(a)), String(el.length));
  ok('work is hashrate over mining time', elEntries.find((e) => e.address === 'grin1steady').work === 100 * 6 * 3600);
  const qplan = db.prepare(`EXPLAIN QUERY PLAN SELECT grin_address FROM hashrate_history
    WHERE recorded_at >= 1 AND recorded_at < 2 AND hashrate_gps > 0 GROUP BY grin_address HAVING SUM(window_seconds) >= 1`)
    .all().map((r) => r.detail).join(' | ');
  ok('a copy of the eligibility query stays on the time index', /SEARCH .*idx_hashrate_time/.test(qplan), qplan);

  console.log('\n[3b] a draw that uses the whole prize pool pays every winner');
  // min = the pool and max above it, so the roll always asks for at least the whole pool.
  let lost = 0, overdrawn = 0;
  for (const [amount, n] of [[0.3, 3], [0.6, 3], [1.2, 3], [2.4, 3], [3.3, 3], [3.9, 3], [4.8, 3], [5.1, 3], [1.1, 2], [7.7, 5]]) {
    wipe();
    inc.debitPrizePool(pool(), 'test', 0);
    inc.creditPrizePool(amount, 'test', 0);
    ps.updateSection('incentives', {
      daily_giveaway_min_grin: amount, daily_giveaway_max_grin: 20,
      daily_giveaway_min_winners: n, daily_giveaway_max_winners: n,
    }, uid);
    miners(n, 'drain').forEach((m) => mineDay(m, yesterday, 12));
    const r = await daily.commit(DailyGiveaway.previousDay(nowSec));
    tipHeight = r.seed_height;
    const paid = await lot.resolveCommittedDraws();
    if (!paid[0] || prizesOf(paid[0].winners) !== n) lost++;
    if (pool() < 0) overdrawn++;
  }
  ok('nobody chosen goes unpaid at an exact-fit prize pool', lost === 0, String(lost));
  ok('the prize pool never goes negative', overdrawn === 0);
  const ulp = daily.plan(hashAt(1), 1, tickets(['grin1a']), { min_grin: 1, max_grin: 1, min_winners: 1, max_winners: 1 }, 0.0012058939999999999);
  ok('a pool just under a whole nanogrin is not overspent', ulp.total_grin <= 0.0012058939999999999 && ulp.share_grin > 0, JSON.stringify(ulp));
  const dust = daily.plan(hashAt(1), 1, tickets(miners(5, 'dust')), { min_grin: 1, max_grin: 1, min_winners: 5, max_winners: 5 }, 3e-9);
  ok('a dust pool pays fewer prizes rather than nobody', prizesOf(dust.winners) === 3 && dust.share_grin > 0, JSON.stringify(dust));
  ok('an empty pool plans no winners', daily.plan(hashAt(1), 1, tickets(['grin1a']), rules, 0).winners.length === 0);
  threw = false;
  try { ps.updateSection('incentives', { daily_giveaway_min_grin: 1e-10 }, uid); } catch (_) { threw = true; }
  ok('an amount below one nanogrin is refused on save', threw);
  ps.updateSection('incentives', {
    daily_giveaway_min_grin: 2, daily_giveaway_max_grin: 6,
    daily_giveaway_min_winners: 2, daily_giveaway_max_winners: 4,
  }, uid);
  inc.debitPrizePool(pool(), 'test', 0);

  console.log('\n[4] one miner, the pool as it is today');
  wipe();
  inc.creditPrizePool(100, 'test', 0);
  mineDay('grin1solo', yesterday, 24);
  let before = pool();
  let res = await daily.runDue();
  ok('the draw commits', res && res.success && res.eligible === 1, JSON.stringify(res));
  ok('commit moves no money', pool() === before && balance('grin1solo') === 0);
  ok('the seed block is in the future', res.seed_height > tipHeight);
  ok('reveal waits for the seed block', (await lot.resolveCommittedDraws()).length === 0 && pool() === before);
  ok('a second tick cannot open the same day', (await daily.runDue()) === null);
  const staleRow = db.prepare('SELECT * FROM lottery_draws WHERE id=?').get(res.draw_id);
  let out = await seedAndReveal(res);
  ok('reveal pays one winner', out.length === 1 && out[0].winners.length === 1, JSON.stringify(out));
  const soloPaid = balance('grin1solo');
  ok('the only miner receives every prize, a total inside the limits', soloPaid > 1.99 && soloPaid <= 6, String(soloPaid));
  ok('the prize pool falls by exactly that', near(before - pool(), soloPaid));
  ok('a replayed reveal pays nothing', (await lot.resolveCommittedDraws()).length === 0 && balance('grin1solo') === soloPaid);
  // A second resolver holding the row from before the first one paid: only the status claim stops it.
  ok('a racing resolver with a stale row pays nothing',
     (await lot.resolveDraw(staleRow)) === null && balance('grin1solo') === soloPaid);

  console.log('\n[5] 3 miners and 50 miners, the pool after new miners arrive');
  for (const n of [3, 50]) {
    wipe();
    const set = miners(n, `m${n}x`);
    set.forEach((m) => mineDay(m, yesterday, 12));
    before = pool();
    res = await daily.runDue();
    ok(`${n} miners: all entered`, res.eligible === n, JSON.stringify(res));
    out = await seedAndReveal(res);
    const w = out[0].winners;
    ok(`${n} miners: prize count inside the limits`, prizesOf(w) >= 2 && prizesOf(w) <= 4, String(prizesOf(w)));
    ok(`${n} miners: winners are distinct`, new Set(w.map((x) => x.address)).size === w.length);
    ok(`${n} miners: every prize is the same size`, w.every((x) => near(x.amount / x.wins, w[0].amount / w[0].wins)));
    const paid = w.reduce((s, x) => s + x.amount, 0);
    ok(`${n} miners: total inside the limits`, paid > 1.99 && paid <= 6, String(paid));
    ok(`${n} miners: the ledger balances`, near(before - pool(), paid));
    const ledger = db.prepare("SELECT COALESCE(SUM(amount),0) s FROM balance_log WHERE reference_type='lottery' AND reference_id=? AND event_type='credit'").get(res.draw_id).s;
    ok(`${n} miners: credits match the winners rows`, near(ledger, paid));
  }

  console.log('\n[5b] a real draw uses frozen work');
  wipe();
  mineDay('grin1whale', yesterday, 12, 9000);
  miners(10, 'fish').forEach((m) => mineDay(m, yesterday, 12, 100));
  res = await daily.runDue();
  const stored = db.prepare('SELECT grin_address, tickets_b FROM lottery_entries WHERE draw_id=?').all(res.draw_id);
  const ticketsOf = (a) => stored.find((r) => r.grin_address === a).tickets_b;
  ok('entries store the day\'s work', ticketsOf('grin1whale') === 9000 * 12 * 3600 && ticketsOf('grin1fish000') === 100 * 12 * 3600,
     JSON.stringify(stored.slice(0, 2)));
  await seedAndReveal(res);
  inc.creditPrizePool(200, 'test', 0);
  ps.updateSection('incentives', { daily_giveaway_min_winners: 1, daily_giveaway_max_winners: 1 }, uid);
  let bigWins = 0;
  for (let i = 0; i < 20; i++) {
    wipe();
    mineDay('grin1huge', yesterday, 12, 1e7);
    mineDay('grin1tiny', yesterday, 12, 1);
    res = await daily.runDue();
    const drawn = await seedAndReveal(res);
    if (drawn[0].winners[0].address === 'grin1huge') bigWins++;
    tipHeight += 1;
  }
  ok('settle picks by the stored work, not by head count', bigWins === 20, String(bigWins));
  ps.updateSection('incentives', { daily_giveaway_min_winners: 2, daily_giveaway_max_winners: 4 }, uid);
  wipe();
  mineDay('grin1repeat', yesterday, 12);
  ps.updateSection('incentives', {
    daily_giveaway_min_grin: 3, daily_giveaway_max_grin: 3, daily_giveaway_min_winners: 3, daily_giveaway_max_winners: 3,
  }, uid);
  const repeatBefore = balance('grin1repeat');
  res = await daily.runDue();
  await seedAndReveal(res);
  const repeatRow = db.prepare('SELECT ticket_count, amount FROM lottery_winners WHERE draw_id=?').all(res.draw_id);
  ok('several wins pay as one row and one credit', repeatRow.length === 1 && repeatRow[0].ticket_count === 3
     && near(repeatRow[0].amount, 3) && near(balance('grin1repeat') - repeatBefore, 3), JSON.stringify(repeatRow));
  ps.updateSection('incentives', {
    daily_giveaway_min_grin: 2, daily_giveaway_max_grin: 6, daily_giveaway_min_winners: 2, daily_giveaway_max_winners: 4,
  }, uid);

  console.log('\n[6] rules are frozen at commit');
  wipe();
  mineDay('grin1frozen', yesterday, 12);
  res = await daily.runDue();
  ps.updateSection('incentives', { daily_giveaway_min_grin: 50, daily_giveaway_max_grin: 60 }, uid);
  const frozenBefore = balance('grin1frozen');
  await seedAndReveal(res);
  const frozenPaid = balance('grin1frozen') - frozenBefore;
  ok('a change after commit does not alter the draw', frozenPaid >= 2 && frozenPaid <= 6, String(frozenPaid));
  ps.updateSection('incentives', { daily_giveaway_min_grin: 2, daily_giveaway_max_grin: 6 }, uid);

  console.log('\n[7] empty and short-funded days');
  wipe();
  res = await daily.runDue();
  ok('nobody qualified: closed as empty', res.success && res.eligible === 0
     && db.prepare('SELECT status FROM lottery_draws WHERE id=?').get(res.draw_id).status === 'empty');
  ok('an empty day is not counted as a draw held', lot.stats().total_draws === 0);
  ok('an empty day is not retried', (await daily.runDue()) === null);

  wipe();
  mineDay('grin1poor', yesterday, 12);
  inc.debitPrizePool(pool() - 1, 'test', 0);
  res = await daily.runDue();
  ok('prize pool below the minimum: no draw', res.success === false && res.reason === 'underfunded', JSON.stringify(res));
  ok('and no row, so a top-up can still draw that day', db.prepare('SELECT COUNT(*) c FROM lottery_draws').get().c === 0);
  ok('the admin status names the skip', daily.status().last_skip && daily.status().last_skip.reason === 'underfunded', JSON.stringify(daily.status()));
  inc.creditPrizePool(2.5, 'test', 0);
  res = await daily.runDue();
  ok('after a top-up the day is drawn', res.success === true, JSON.stringify(res));
  ok('and the skip is cleared', daily.status().last_skip === null);
  inc.debitPrizePool(pool() - 0.5, 'test', 0);
  const poorBefore = balance('grin1poor');
  await seedAndReveal(res);
  ok('pool drained after commit: the draw is held, not closed',
     db.prepare('SELECT status FROM lottery_draws WHERE id=?').get(res.draw_id).status === 'committed'
     && balance('grin1poor') === poorBefore && near(pool(), 0.5));
  ok('the admin status says it is held for funds', daily.status().holds[res.draw_id] === 'short', JSON.stringify(daily.status()));
  inc.creditPrizePool(10, 'test', 0);
  await lot.resolveCommittedDraws();
  ok('and clears once it pays', daily.status().holds[res.draw_id] === undefined);
  ps.updateSection('incentives', { daily_giveaway_enabled: 'false' }, uid);
  daily.lastSkip = { at: 1, reason: 'underfunded' };
  await daily.runDue();
  ok('switching off clears an old skip notice', daily.status().last_skip === null);
  ps.updateSection('incentives', { daily_giveaway_enabled: 'true' }, uid);
  const poorPaid = balance('grin1poor') - poorBefore;
  ok('after a top-up it pays, sized by the pool at commit', poorPaid >= 2 && poorPaid <= 3.5 + 1e-9, String(poorPaid));

  console.log('\n[7b] stopping a draw');
  wipe();
  inc.creditPrizePool(50, 'test', 0);
  mineDay('grin1keep', yesterday, 12);
  mineDay('grin1ring', yesterday, 12);
  res = await daily.runDue();
  db.prepare("UPDATE miner_accounts SET is_banned = 1 WHERE grin_address = 'grin1ring'").run();
  ps.updateSection('incentives', { daily_giveaway_enabled: 'false' }, uid);
  const stopBefore = pool();
  await seedAndReveal(res);
  ok('switched off: the draw waits and pays nothing', pool() === stopBefore
     && db.prepare('SELECT status FROM lottery_draws WHERE id=?').get(res.draw_id).status === 'committed');
  ok('the admin status says it is held by the switch', daily.status().holds[res.draw_id] === 'off', JSON.stringify(daily.status()));
  ps.updateSection('incentives', { daily_giveaway_enabled: 'true' }, uid);
  // Fixed picks, so the banned miner holds two prizes and the other one whatever the seed says.
  const realPlan = daily.plan;
  daily.plan = (...args) => ({
    ...realPlan.apply(daily, args),
    winners: [{ address: 'grin1keep', wins: 1 }, { address: 'grin1ring', wins: 2 }],
  });
  const stopped = await lot.resolveCommittedDraws();
  daily.plan = realPlan;
  ok('switched back on: it resolves', stopped.length === 1, JSON.stringify(stopped));
  ok('a winner banned after commit forfeits', balance('grin1ring') === 0);
  ok('the other winner is paid, and the prize pool falls by that share alone',
     balance('grin1keep') > 0 && near(stopBefore - pool(), balance('grin1keep')));
  ok('the forfeit leaves no winners row', db.prepare("SELECT COUNT(*) c FROM lottery_winners WHERE grin_address='grin1ring'").get().c === 0);

  console.log('\n[8] once-a-day guard and downtime');
  wipe();
  inc.creditPrizePool(100, 'test', 0);
  mineDay('grin1guard', yesterday, 12);
  const period = DailyGiveaway.previousDay(nowSec);
  const first = await daily.commit(period);
  const second = await daily.commit(period);
  ok('the database refuses a second draw for one day', first.success && second.reason === 'already_drawn', JSON.stringify(second));
  await seedAndReveal(first);
  const later = await daily.runDue(Date.now() + 3 * DAY * 1000);
  const missed = await daily.runDue(Date.now() + 3 * DAY * 1000);
  const dailyStarts = db.prepare("SELECT period_start FROM lottery_draws WHERE draw_type='daily' ORDER BY period_start").all().map((r) => r.period_start);
  ok('after downtime only the last completed day is drawn', later && later.success === true && missed === null
     && dailyStarts.length === 2 && dailyStarts[1] === yesterday + 3 * DAY, JSON.stringify(dailyStarts));
  ok('a node outage writes no row', await (async () => {
    wipe();
    const saved = fakeNode.getTip;
    fakeNode.getTip = async () => { throw new Error('down'); };
    const r = await daily.runDue();
    fakeNode.getTip = saved;
    return r.reason === 'no_seed' && db.prepare('SELECT COUNT(*) c FROM lottery_draws').get().c === 0;
  })());

  console.log('\n[9] admin Run now and preview');
  wipe();
  db.prepare("INSERT OR IGNORE INTO miner_accounts (grin_address, balance) VALUES ('grin1live', 0)").run();
  for (let h = 1; h <= 7; h++) {
    db.prepare('INSERT INTO hashrate_history (grin_address, hashrate_gps, window_seconds, recorded_at) VALUES (?, 100, 3600, ?)')
      .run('grin1live', nowSec - h * 3600);
  }
  const run1 = await daily.runNow();
  ok('Run now uses the last 24 hours', run1.success === true && run1.eligible === 1, JSON.stringify(run1));
  const run2 = await daily.runNow();
  ok('a second click cannot queue a second draw', run2.reason === 'draw_open', JSON.stringify(run2));
  await seedAndReveal(run1);
  // Two requests in flight together, on a slow node: both pass the early check before either inserts.
  const fastTip = fakeNode.getTip;
  fakeNode.getTip = async () => { await new Promise((r) => setTimeout(r, 30)); return fastTip(); };
  const raced = await Promise.all([daily.runNow(Date.now() + 5000), daily.runNow(Date.now() + 6000)]);
  fakeNode.getTip = fastTip;
  ok('two requests racing on a slow node open one draw', raced.filter((r) => r.success).length === 1
     && raced.some((r) => r.reason === 'draw_open' && r.draw_id), JSON.stringify(raced));
  await seedAndReveal(raced.find((r) => r.success));
  ok('Run now does not block the scheduled draw', (await daily.runDue()).success === true);
  // The real scheduler entry point, with the weekly path throwing and lottery_enabled off.
  wipe();
  mineDay('grin1tick', yesterday, 12);
  const realDue = lot.dueDraws;
  lot.dueDraws = () => { throw new Error('weekly path down'); };
  let tickThrew = false;
  try { await lot.runDueDraws(); } catch (_) { tickThrew = true; }
  lot.dueDraws = realDue;
  ok('a failing weekly path does not cost the giveaway day', tickThrew
     && db.prepare("SELECT COUNT(*) c FROM lottery_draws WHERE draw_type='daily'").get().c === 1);

  const rows = () => db.prepare('SELECT (SELECT COUNT(*) FROM lottery_draws) d, (SELECT COUNT(*) FROM lottery_winners) w, (SELECT COUNT(*) FROM balance_log) l').get();
  const snap = JSON.stringify(rows());
  const poolSnap = pool();
  const prev = daily.preview({ extraMiners: 20 });
  ok('preview uses pretend miners', prev.success && prev.pretend_miners === 20 && prev.days.length === 7);
  ok('preview shows several prizes', prev.days.every((d) => prizesOf(d.winners) >= 2 && prizesOf(d.winners) <= 4));
  ok('preview writes nothing and moves nothing', JSON.stringify(rows()) === snap && pool() === poolSnap);
  const realEligible = daily.eligibleEntries;
  let scans = 0;
  daily.eligibleEntries = (...a) => { scans++; return realEligible.apply(daily, a); };
  daily.previewCache = null;
  const t0 = Date.now();
  daily.preview({ now: t0 });
  daily.preview({ now: t0 + 1000 });
  ok('repeat previews reuse one scan', scans === 1, String(scans));
  daily.preview({ now: t0 + 61000 });
  ok('and refresh after a minute', scans === 2, String(scans));
  daily.eligibleEntries = realEligible;
  ps.updateSection('incentives', { daily_giveaway_enabled: 'false' }, uid);
  ok('preview still works while switched off', daily.preview({}).success === true);
  ok('Run now refuses while switched off', (await daily.runNow()).reason === 'disabled');
  ok('public rules are hidden while off', lot.stats().daily_giveaway === null);
  ps.updateSection('incentives', { daily_giveaway_enabled: 'true' }, uid);
  const pub = lot.stats().daily_giveaway;
  ok('public rules show the limits while on', pub && pub.min_grin === 2 && pub.max_winners === 4, JSON.stringify(pub));

  console.log('\n[10] what the pages read');
  wipe();
  const boardAddr = 'grin1boardqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq';
  mineDay(boardAddr, yesterday, 12);
  res = await daily.runDue();
  ok('recentDraws can skip a draw that has not paid', lot.recentDraws(5, { paidOnly: true }).length === 0);
  await seedAndReveal(res);
  ok('and shows it once it has paid', lot.recentDraws(5, { paidOnly: true }).length === 1);
  const hist = lot.winnerHistory(5, 0);
  ok('fortune board lists the win as the daily giveaway',
     hist.total > 0 && hist.winners[0].event === 'Daily giveaway' && hist.winners[0].pot === 'd', JSON.stringify(hist.winners[0]));
  ok('the address is truncated on the fortune board', !hist.winners[0].address.includes(boardAddr) && hist.winners[0].address.includes('…'));
  const st = lot.stats();
  ok('fortune board stats count the pot', st.by_pot.some((p) => p.pot === 'd' && p.amount > 0));
  const publicJson = JSON.stringify([st, hist]);
  ok('the public feeds carry no full address and no draw internals',
     !publicJson.includes(boardAddr) && !publicJson.includes('rules_json') && !publicJson.includes('prize_pool'));
  const earned = db.prepare('SELECT COUNT(*) AS count, COALESCE(SUM(amount), 0) AS total_grin FROM lottery_winners WHERE grin_address = ?').get(boardAddr);
  ok('a copy of the account prize query matches the ledger credit', earned.count === 1 && near(earned.total_grin, balance(boardAddr)));

  cleanup();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error(err);
  cleanup();
  process.exit(1);
});
