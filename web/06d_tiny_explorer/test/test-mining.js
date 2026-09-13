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
// It reads the shipped file as text and evaluates the pure functions out of it;
// §7 additionally drives initMining() through a ~40-line listener-capturing shim,
// because "number of units" is pure interaction and nothing read off the source
// would prove it. There is no jsdom and no devDependency either way (06d has one
// npm dependency, express, and that is not negotiable).
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
const PURE = ['posNum', 'miningEstimate', 'fmtGrinAmt', 'fmtWatts', '_usd', 'fmtUsdAmt', 'fmtUsdPrice', 'fmtPayback'];
const { posNum, miningEstimate, fmtGrinAmt, fmtWatts, fmtUsdAmt, fmtUsdPrice, fmtPayback } =
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
  for (const id of ['mine-gps', 'mine-fee', 'mine-watt', 'mine-kwh', 'mine-units', 'mine-cost']) {
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

// ═══ 7. "Number of units" — the multiplier, driven through real handlers ═══
console.log('\n[7] number of units — the boxes below hold the FLEET total');

// This one feature cannot be tested by reading the source: it is entirely
// interaction — a count, a preset and two boxes that rewrite each other. So the
// shim below captures listeners and fires them against the shipped initMining().
// It is ~40 lines of plain JS and node:assert; there is still no jsdom and no
// devDependency, which is the constraint that actually matters here.
//
// The invariant under test: the hashrate and wattage boxes are ALWAYS the total
// for every unit, because miningEstimate() reads nothing else. The count is not
// a hidden multiplier inside the maths — it multiplies a per-unit basis INTO the
// visible boxes, so every figure on the page stays checkable against what the
// reader can see.
function drive() {
  const vals = { 'mine-gps':'1.2','mine-fee':'0','mine-watt':'120','mine-kwh':'0.17','mine-units':'1','mine-cost':'' };
  const text = {}, listeners = {};
  const mk = (id) => ({ id,
    get value(){ return vals[id]; }, set value(v){ vals[id] = String(v); },
    get textContent(){ return text[id]; }, set textContent(v){ text[id] = v; },
    dataset:{}, options:[], selectedIndex:0, style:{},
    addEventListener(ev, fn){ (listeners[id] = listeners[id] || {})[ev] = fn; },
    setAttribute(){}, removeAttribute(){}, classList:{ add(){}, remove(){}, toggle(){} } });

  const RIGS = [
    { value:'ipollo-g1-mini', text:'iPollo G1 Mini — 1.20 G/s · 120 W', gps:'1.2', watts:'120' },
    { value:'ipollo-g1',      text:'iPollo G1 — 36.0 G/s · 2800 W',    gps:'36',  watts:'2800' },
    { value:'custom',         text:'Custom — enter your own figures' },
  ];
  const nodes = {};
  for (const id of Object.keys(vals).concat(['mine-rig-note','mine-units-note','mine-watt-note',
    'mine-kwh-note','mine-day','mine-week','mine-month','mine-day-usd','mine-week-usd','mine-month-usd',
    'mine-power','mine-breakeven','mine-breakeven-sub','mine-profit','mine-profit-sub',
    'mine-payback','mine-payback-sub','mine-cost-note',
    'mine-net','mine-net-sub','mine-price','mine-price-sub'])) nodes[id] = mk(id);

  const rig = mk('mine-rig');
  rig.options = RIGS.map(r => { const o = mk('o'); o.text = r.text;
    if (r.gps) { o.dataset.gps = r.gps; o.dataset.watts = r.watts; } return o; });
  Object.defineProperty(rig, 'value', {
    get(){ return RIGS[rig.selectedIndex].value; },
    set(v){ rig.selectedIndex = RIGS.findIndex(r => r.value === v); } });
  nodes['mine-rig'] = rig;
  const kwh = mk('mine-kwh-preset');
  kwh.options = [Object.assign(mk('o'), { dataset:{ kwh:'0.17' } })];
  Object.defineProperty(kwh, 'value', { get(){ return 'us'; }, set(){} });
  nodes['mine-kwh-preset'] = kwh;

  let ready = null;
  const sandbox = {
    document: { documentElement:{ setAttribute(){}, getAttribute(){ return null; } },
      body:{ dataset:{ page:'mining' }, classList:{ add(){}, remove(){} } },
      getElementById: id => nodes[id] || null,
      querySelector: () => null, querySelectorAll: () => [], createElement: () => mk('t'),
      addEventListener: (ev, fn) => { if (ev === 'DOMContentLoaded') ready = fn; } },
    window: { location:{ pathname:'/mining', href:'' }, addEventListener(){} },
    localStorage: { getItem: () => null, setItem(){}, removeItem(){} },
    navigator: { clipboard: null },
    matchMedia: () => ({ matches:false, addEventListener(){}, addListener(){} }),
    // Never settles: these assertions are about the form, and a live basis would
    // make them depend on a timer. run-all.js calls report() synchronously.
    fetch: () => new Promise(() => {}),
    console: { log(){} },
  };
  const args = Object.keys(sandbox);
  new Function(...args, js)(...args.map(k => sandbox[k]));
  ready();

  return {
    vals, text,
    rig: () => rig.value,
    set(id, v, ev) { nodes[id].value = v; listeners[id][ev || 'input'](); },
    boxes: () => vals['mine-gps'] + '/' + vals['mine-watt'],
  };
}

ok('a count of 1 leaves the shipped defaults alone', () => {
  const d = drive();
  assert.strictEqual(d.boxes(), '1.2/120');
});

ok('4 units multiplies BOTH the hashrate and the power draw', () => {
  const d = drive();
  d.set('mine-units', '4');
  assert.strictEqual(d.boxes(), '4.8/480', 'the count did not reach both boxes');
  assert.ok(d.text['mine-units-note'].includes('4.8 G/s and 480 W'),
    'the note does not say the multiplication back: ' + d.text['mine-units-note']);
});

ok('changing the hardware keeps the count instead of dropping to one', () => {
  const d = drive();
  d.set('mine-units', '4');
  d.set('mine-rig', 'ipollo-g1', 'change');
  assert.strictEqual(d.boxes(), '144/11200', 'the preset overwrote the fleet total');
});

ok('a figure corrected by hand is what gets multiplied — 4 x measured, not 4 x spec', () => {
  const d = drive();
  d.set('mine-units', '4');
  d.set('mine-watt', '600');          // 150 W each at the wall, not the 120 W spec
  assert.strictEqual(d.rig(), 'custom', 'editing a total left the picker naming a preset');
  d.set('mine-units', '8');
  assert.strictEqual(d.vals['mine-watt'], '1200', 'the measured wattage was thrown away');
});

ok('blank, zero, junk and negative counts are ONE unit — never zero, never NaN', () => {
  for (const v of ['', '0', 'abc', '-3']) {
    const d = drive();
    d.set('mine-units', '4');
    d.set('mine-units', v);
    assert.strictEqual(d.boxes(), '1.2/120', 'count ' + JSON.stringify(v) + ' did not fall back to one');
  }
});

ok('no float dust reaches a box the reader retypes', () => {
  const d = drive();
  d.set('mine-units', '3');
  d.set('mine-gps', '2.1');           // 0.7 each
  d.set('mine-units', '3');
  assert.strictEqual(d.vals['mine-gps'], '2.1', '0.7 x 3 leaked its binary tail');
  d.set('mine-units', '7');
  assert.strictEqual(d.vals['mine-gps'], '4.9');
});

ok('the count never becomes a hidden multiplier inside the maths', () => {
  // miningEstimate() must still take no unit count: the boxes are the only input.
  assert.ok(!/units?/.test(lift('miningEstimate')),
    'miningEstimate() now knows about unit counts — the visible total is no longer the whole input');
});

// Break-even is the one card a unit count CANNOT move, because the count
// multiplies the power bill and the income by the same factor and cancels.
// That is correct arithmetic and looks exactly like a field that stopped
// updating, so the page has to say so — and the claim in that copy is a
// property of miningEstimate(), which is testable here directly.
ok('break-even does not move with the count — the ratio cancels', () => {
  const one  = est();
  const four = est({ gps: '4.8', watts: '480' });   // the same rig, x4
  assert.ok(Math.abs(four.breakEven - one.breakEven) < 1e-12,
    'break-even changed with fleet size: ' + one.breakEven + ' -> ' + four.breakEven);
  // ...while everything the reader expects to scale actually does.
  assert.ok(Math.abs(four.grinDay  / one.grinDay  - 4) < 1e-9, 'income did not scale x4');
  assert.ok(Math.abs(four.powerDay / one.powerDay - 4) < 1e-9, 'power did not scale x4');
});

ok('and the page explains that stillness instead of leaving it ambiguous', () => {
  const src = lift('initMining');
  const i = src.indexOf("'mine-breakeven-sub'");
  assert.notStrictEqual(i, -1, 'the break-even sub-label is gone');
  assert.ok(/unchanged by unit count/.test(src.slice(i, i + 400)),
    'nothing tells the reader WHY break-even sits still while every other card moves');
});

// ═══ 8. "Pays for itself in" — capital payback ══════════════════════════════
console.log('\n[8] payback — a duration, and three different ways to have none');

// The shipped defaults LOSE money (-$0.43/day at $0.17/kWh), which is the
// honest answer for most real hardware and useless as an arithmetic fixture.
// Cheap power, so there is a positive profit to divide into.
const cheap = { kwhCost: '0.02' };
const paid  = (over) => est(Object.assign({ hwCost: '500' }, cheap, over));

ok('payback is what you spent divided by what you clear in a day', () => {
  const r = paid();
  assert.ok(r.profitDay > 0, 'the profitable fixture stopped being profitable');
  assert.strictEqual(r.paybackDays, 500 / r.profitDay);
});

ok('nothing spent is not a free rig — blank, 0 and junk all decline to answer', () => {
  for (const v of ['', '   ', '0', 'abc', '-100']) {
    assert.strictEqual(paid({ hwCost: v }).paybackDays, null,
      'a cost of ' + JSON.stringify(v) + ' produced a payback anyway');
  }
});

ok('a rig that loses money has no payback — never is a word, not Infinity', () => {
  const r = est({ hwCost: '500' });     // the shipped defaults, at $0.17/kWh
  assert.ok(r.profitDay < 0, 'the default fixture stopped being a loss-maker');
  assert.strictEqual(r.paybackDays, null);
});

ok('and no basis is no payback — never a 0, never a NaN', () => {
  for (const over of [{ netGps: null }, { priceUsd: 0 }, { gps: '' }]) {
    const r = paid(over);
    assert.strictEqual(r.paybackDays, null, 'a missing basis produced a payback: ' + JSON.stringify(over));
  }
});

ok('payback does not move with the count either — the same cancellation as break-even', () => {
  const one  = paid();
  const four = paid({ hwCost: '2000', gps: '4.8', watts: '480' });   // the same rig, x4
  assert.ok(Math.abs(four.paybackDays / one.paybackDays - 1) < 1e-9,
    'payback changed with fleet size: ' + one.paybackDays + ' -> ' + four.paybackDays);
});

ok('fmtPayback says days, then months, then years — one unit at a time', () => {
  assert.strictEqual(fmtPayback(0.5),  'under a day');
  assert.strictEqual(fmtPayback(1),    '1 day');
  assert.strictEqual(fmtPayback(45),   '45 days');
  assert.strictEqual(fmtPayback(89),   '89 days');
  assert.strictEqual(fmtPayback(365),  '12 months');
  assert.strictEqual(fmtPayback(1095), '36 months');
  assert.strictEqual(fmtPayback(1096), '3.0 years');
  assert.strictEqual(fmtPayback(365.25 * 12), '12 years');
});

ok('a payback long enough to be meaningless stops being a number', () => {
  assert.strictEqual(fmtPayback(1e9), 'over 100 years');
  for (const v of [Infinity, NaN, null, undefined, 0, -5]) {
    assert.strictEqual(fmtPayback(v), '—', String(v) + ' rendered as a duration');
  }
});

ok('the cost box scales with the count, like the two figures above it', () => {
  const d = drive();
  d.set('mine-cost', '520');
  d.set('mine-units', '4');
  assert.strictEqual(d.vals['mine-cost'], '2080', 'the count did not reach the cost box');
  assert.ok(/spent/.test(d.text['mine-units-note']),
    'the note does not say the cost multiplication back: ' + d.text['mine-units-note']);
});

ok('an empty cost box stays empty when the count changes — 0 is not "unpriced"', () => {
  const d = drive();
  d.set('mine-units', '4');
  assert.strictEqual(d.vals['mine-cost'], '', 'the count answered an unasked question with 0');
  assert.strictEqual(d.text['mine-payback-sub'], 'enter what the hardware cost',
    'the card claims something other than a missing price');
});

ok('typing a price does not accuse the reader of leaving the preset', () => {
  const d = drive();
  d.set('mine-cost', '520');
  assert.strictEqual(d.rig(), 'ipollo-g1-mini',
    'a hardware price dropped the picker to Custom — no preset in that list carries one');
});

ok('and the card says "never" in words rather than leaving a readable-as-broken dash', () => {
  const src = lift('initMining');
  const i = src.indexOf("'mine-payback'");
  assert.notStrictEqual(i, -1, 'the payback card is gone');
  assert.ok(/'never'/.test(src.slice(i, i + 300)),
    'a rig that loses money renders as a dash, indistinguishable from a missing input');
  const j = src.indexOf("'mine-payback-sub'");
  assert.ok(/unchanged by unit count/.test(src.slice(j, j + 500)),
    'payback is scale-invariant like break-even and nothing on the card says so');
});

// ═══ Report ══════════════════════════════════════════════════════════════════
console.log('\n' + '─'.repeat(72));
console.log('mining: ' + pass + ' passed, ' + fail + ' failed');

module.exports = { report: () => ({ pass, fail }) };
