'use strict';

// Mining Calculator — the money arithmetic and the "why is this —" contract.
//
// WHY THIS FILE EXISTS. /mining is the only page in 06d that prints a number a
// reader may spend money on: a break-even GRIN price and a daily profit. Its two
// live inputs both come from one /api/stats call, and that call CAN fail — it is
// 502 whenever the node is unreachable, because getTip() is the one un-.catch()ed
// leg of its Promise.all. Every wrong answer this page can give is therefore a
// missing-input answer, and all of them look identical on screen: a dash.
//
// Two directions have to hold, and only one of them is obvious:
//   - a MISSING basis must never render as a number (0 ツ/day, $0.00, a profit of
//     -$0.49 for a rig nobody described) — the numeric trap this repo has hit
//     before (memory reference_money_number_boundary_traps);
//   - and a rendered dash must name the RIGHT missing input. The page shipped
//     'enter your hashrate' beside a hashrate the reader had already entered,
//     because the figure actually missing was the NETWORK one and the copy could
//     not tell the two apart. That is a false statement about the operator's own
//     input, and no arithmetic test would have caught it.
//
// So this asserts the estimate function AND the sub-line each card falls back to.
// It reads the shipped file as text and evaluates only the pure functions out of
// it — there is no DOM here and no devDependency (06d has one npm dependency,
// express, and that is not negotiable).
//
// Run: node test/test-mining.js

const assert = require('node:assert');
const fs     = require('node:fs');
const path   = require('node:path');

const APP = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(APP, rel), 'utf8');

let pass = 0, fail = 0;
const ok = (name, fn) => {
  try { fn(); pass++; console.log('  PASS  ' + name); }
  catch (e) { fail++; console.log('  FAIL  ' + name + '\n        ' + (e && e.message)); }
};

const js       = read('public/js/tiny-explorer.js');
const html     = read('public/mining.html');
const serverJs = read('tiny-explorer-server.js');

// Lift the pure helpers out of the SHIPPED file by brace-matching, so these tests
// run against the code that deploys rather than a copy that can drift.
function lift(name) {
  const i = js.indexOf('function ' + name + '(');
  assert.notStrictEqual(i, -1, 'function ' + name + '() is gone from tiny-explorer.js');
  let depth = 0;
  for (let k = js.indexOf('{', i); k < js.length; k++) {
    if (js[k] === '{') depth++;
    else if (js[k] === '}' && --depth === 0) return js.slice(i, k + 1);
  }
  throw new Error('unbalanced braces in ' + name);
}
const PURE = ['posNum', 'miningEstimate', 'fmtGrinAmt', 'fmtWatts', '_usd', 'fmtUsdAmt', 'fmtUsdPrice'];
const { posNum, miningEstimate, fmtGrinAmt, fmtWatts, fmtUsdAmt, fmtUsdPrice } =
  new Function(PURE.map(lift).join('\n') + '\nreturn {' + PURE.join(',') + '};')();

// A healthy basis, and the page's own shipped defaults.
const NET   = 59000;    // 59 kG/s
const PRICE = 0.0352;
const base = { netGps: NET, priceUsd: PRICE, gps: '1.2', feePct: '0', watts: '120', kwhCost: '0.17' };
const est = (over) => miningEstimate(Object.assign({}, base, over));

// ═══ 1. posNum() — every non-number collapses to 0, never to NaN ═════════════
console.log('\n[1] posNum — no NaN reaches a money figure');

ok('blank, junk, negative, Infinity and null are all 0', () => {
  for (const v of ['', '   ', 'abc', '-5', -5, 'Infinity', Infinity, -Infinity, NaN, null, undefined, {}]) {
    assert.strictEqual(posNum(v), 0, JSON.stringify(String(v)) + ' did not collapse to 0');
  }
});

ok('a real figure survives as a number, string or not', () => {
  assert.strictEqual(posNum('1.2'), 1.2);
  assert.strictEqual(posNum(2800), 2800);
});

// ═══ 2. The share formula ════════════════════════════════════════════════════
console.log('\n[2] your share of 86,400 ツ a day');

ok('gps / net * 86400, to the tsu', () => {
  assert.strictEqual(est().grinDay, 1.2 / NET * 86400);
});

ok('week and month are 7 and 30 of the same day', () => {
  const r = est();
  assert.strictEqual(r.grinWeek,  r.grinDay * 7);
  assert.strictEqual(r.grinMonth, r.grinDay * 30);
});

ok('a pool fee comes off the top, and 100% leaves nothing', () => {
  assert.ok(Math.abs(est({ feePct: '1' }).grinDay - est().grinDay * 0.99) < 1e-12);
  assert.strictEqual(est({ feePct: '100' }).grinDay, 0);
});

ok('a fee above 100 is clamped — never negative income', () => {
  assert.strictEqual(est({ feePct: '250' }).grinDay, 0);
});

ok('power cost is watts/1000 * 24 * rate — a RATE, not a daily total', () => {
  assert.ok(Math.abs(est().powerDay - 0.4896) < 1e-9);
  assert.strictEqual(est({ watts: '0' }).powerDay, 0);
});

ok('break-even is the day power bill divided by the day tsu', () => {
  const r = est();
  assert.strictEqual(r.breakEven, r.powerDay / r.grinDay);
});

ok('profit is income at the live price minus that bill', () => {
  const r = est();
  assert.strictEqual(r.profitDay, r.grinDay * PRICE - r.powerDay);
});

// ═══ 3. A missing input is null — never a number ═════════════════════════════
console.log('\n[3] a missing basis renders as unknown, not as zero');

ok('no network hashrate means every tsu and USD figure is null', () => {
  const r = est({ netGps: null });
  for (const k of ['grinDay', 'grinWeek', 'grinMonth', 'usdDay', 'usdWeek', 'usdMonth', 'breakEven', 'profitDay']) {
    assert.strictEqual(r[k], null, k + ' invented a figure with no network basis');
  }
});

ok('an EMPTY hashrate box is "not told yet", not a rig running at 0 G/s', () => {
  const r = est({ gps: '' });
  assert.strictEqual(r.grinDay, null, 'a blank field produced a confident 0 tsu/day');
  assert.strictEqual(r.profitDay, null, 'a blank field produced a confident daily loss');
  assert.strictEqual(r.breakEven, null);
});

ok('the power bill stands on its own — it needs neither node nor price', () => {
  const r = est({ netGps: null, priceUsd: null, gps: '' });
  assert.ok(Math.abs(r.powerDay - 0.4896) < 1e-9, 'power cost went missing with the node');
});

ok('no price means USD is null but the tsu figures survive', () => {
  const r = est({ priceUsd: null });
  assert.ok(r.grinDay > 0);
  assert.strictEqual(r.usdDay, null);
  assert.strictEqual(r.profitDay, null);
});

ok('a zero power bill has no break-even — that division is Infinity, not a price', () => {
  const r = est({ watts: '0', kwhCost: '0' });
  assert.strictEqual(r.breakEven, null);
  assert.ok(isFinite(r.profitDay));
});

// ═══ 4. Formatters ═══════════════════════════════════════════════════════════
console.log('\n[4] formatters — null is a dash, and cents are not rounded away');

ok('null, NaN and Infinity print as a dash everywhere', () => {
  for (const f of [fmtGrinAmt, fmtWatts, fmtUsdAmt, fmtUsdPrice]) {
    assert.strictEqual(f(null), '—');
    assert.strictEqual(f(Infinity), '—');
    assert.strictEqual(f(NaN), '—');
  }
});

ok('a unit PRICE keeps 4 dp — 2 would round a 0.0667 break-even to 0.07', () => {
  assert.strictEqual(fmtUsdPrice(0.0667), '$0.0667');
  assert.ok(/^\$0\.0000\d+$/.test(fmtUsdPrice(0.00005)), 'sub-milli price lost its digits');
});

ok('a negative total keeps its sign OUTSIDE the dollar mark', () => {
  assert.strictEqual(fmtUsdAmt(-0.43), '-$0.43');
});

ok('watts are whole above 10 W, so 120 and 2800 read alike', () => {
  assert.strictEqual(fmtWatts(120), '120');
  assert.strictEqual(fmtWatts(2800), '2,800');
  assert.strictEqual(fmtWatts(7.5), '7.5');
});

// ═══ 5. The "why is this —" copy names the right missing input ═══════════════
console.log('\n[5] a dash must blame the right missing figure');

// render() is DOM-bound, so assert the contract on its source: the blocker chain
// must test the network basis BEFORE the reader's own field, or an outage tells a
// miner to enter a hashrate that is already on screen.
const render = js.slice(js.indexOf('function initMining('));

ok('the blocker chain exists and checks the network basis first', () => {
  const noNet  = render.indexOf('noNet');
  const noRate = render.indexOf('noRate');
  assert.ok(noNet > -1 && noRate > -1, 'the noNet/noRate blocker chain is gone');
  assert.ok(noNet < noRate, 'the reader own field is blamed before the network basis');
});

ok('"needs the network hashrate" is reachable copy, not just a comment', () => {
  assert.ok(/blocker\s*=\s*noNet\s*\?\s*'needs the network hashrate'/.test(render),
    'the network-basis wording is no longer the first branch');
});

ok('the break-even card can say it too — it was the card that got this wrong', () => {
  const sub = render.slice(render.indexOf("setText('mine-breakeven-sub'"), render.indexOf("setText('mine-profit'"));
  assert.ok(sub.includes('needs the network hashrate'),
    'break-even still blames the operator for a missing network figure');
});

// ═══ 6. Client / server / markup contract ════════════════════════════════════
console.log('\n[6] the fields, ids and routes all three sides agree on');

ok('every id render() writes to exists in mining.html', () => {
  const ids = [...render.matchAll(/setText\('(mine-[a-z-]+)'/g)].map(m => m[1]);
  assert.ok(ids.length >= 12, 'render() suddenly writes almost nothing — did it move?');
  for (const id of new Set(ids)) {
    assert.ok(html.includes('id="' + id + '"'), 'mining.html has no #' + id);
  }
});

ok('every input id the page reads exists as an input', () => {
  for (const id of ['mine-gps', 'mine-fee', 'mine-watt', 'mine-kwh']) {
    assert.ok(new RegExp('<input id="' + id + '"').test(html), 'no <input> for #' + id);
  }
});

ok('the server sends the two fields the page reads', () => {
  assert.ok(/hashrate_gps_24h:/.test(serverJs), '/api/stats no longer exposes the day-average basis');
  assert.ok(/hashrate_gps:/.test(serverJs));
  assert.ok(/price_usd:/.test(serverJs));
});

ok('/api/price exists server-side — the node-free half the outage path falls back to', () => {
  assert.ok(/app\.get\('\/api\/price'/.test(serverJs), 'the price route is gone');
  assert.ok(render.includes("fetch('/api/price')"),
    'the /api/stats failure path no longer recovers the price');
});

ok('every hardware preset carries both figures it fills in', () => {
  const opts = [...html.matchAll(/<option value="(?!custom)[^"]+"[^>]*>/g)].map(m => m[0]);
  const rigs = opts.filter(o => o.includes('data-gps'));
  assert.ok(rigs.length >= 20, 'the hardware list shrank unexpectedly: ' + rigs.length);
  for (const o of rigs) {
    assert.ok(/data-watts="\d/.test(o), 'a preset fills in a hashrate but no power draw: ' + o);
  }
});

ok('every electricity preset carries a rate, and none is negative', () => {
  const rates = [...html.matchAll(/data-kwh="([^"]*)"/g)].map(m => m[1]);
  assert.ok(rates.length >= 10, 'the electricity list shrank unexpectedly: ' + rates.length);
  for (const v of rates) {
    const n = parseFloat(v);
    assert.ok(isFinite(n) && n >= 0, 'bad kWh preset: ' + JSON.stringify(v));
  }
});

// ═══ Report ══════════════════════════════════════════════════════════════════
console.log('\n' + '─'.repeat(72));
console.log('mining: ' + pass + ' passed, ' + fail + ' failed');

module.exports = { report: () => ({ pass, fail }) };
