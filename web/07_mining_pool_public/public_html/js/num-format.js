// num-format.js — ONE rule for the GRIN figures on every public placard tile.
//
// THE RULE: a placard tile shows a SHORT figure, and the exact one is its tooltip. Tables,
// ledgers, forms and the amount chips keep exact figures; a miner copies those, so they are
// never abbreviated. Before this file each page rolled its own fmtGrin: 4 dp on the account
// page, 3 dp with separators elsewhere, "GRIN" on the prize-pool tile and "ツ" beside it. The
// account page's large tile then clipped "345.9303 ツ" at desktop width.
//
//   0              2 dp     0.00 ツ
//   |v| < 1        4 dp     0.0412 ツ     a small balance is still readable
//   |v| < 1,000    2 dp     345.93 ツ
//   ≥ 1,000        2 dp + K / M / B        12.34K ツ · 1.23M ツ
//
// Digits are TRUNCATED toward zero, never rounded. A tile must not show more than the account
// holds: 345.9999 rounded is "346.00", which the max chip and the payout then contradict.
// The cut works on the decimal string (toFixed(9), the chain's own precision), not on
// Math.trunc(x * 100): 345.93 * 100 is 34592.999… in binary, and that would read "345.92".
//
// Loaded BEFORE each page's inline script (it defines a global the page calls). branding.js
// uses it for the [data-brand="prize-pool"] tile when present and falls back without it.
(function () {
  'use strict';

  function cut(x, d) {
    var s = x.toFixed(9);
    var i = s.indexOf('.');
    return i === -1 ? s : s.slice(0, i + 1 + d);
  }

  function unitSuffix(unit) {
    if (unit === undefined) return ' ツ';
    return unit ? ' ' + unit : '';
  }

  function grinTile(v, unit) {
    var n = Number(v);
    if (!isFinite(n)) n = 0;
    var a = Math.abs(n);
    var s;
    if (a >= 1e9) s = cut(n / 1e9, 2) + 'B';
    else if (a >= 1e6) s = cut(n / 1e6, 2) + 'M';
    else if (a >= 1e3) s = cut(n / 1e3, 2) + 'K';
    else if (a >= 1 || a === 0) s = cut(n, 2);
    else s = cut(n, 4);
    return s + unitSuffix(unit);
  }

  // The tooltip figure: full precision, thousands separators, float noise past 9 dp dropped.
  function grinExact(v, unit) {
    var n = Number(v);
    if (!isFinite(n)) n = 0;
    return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 9 }) + unitSuffix(unit);
  }

  // Write a tile: short text, exact title. A null/undefined value leaves the placeholder.
  function setGrinTile(el, v, unit) {
    if (!el) return;
    if (v === null || v === undefined) { el.textContent = '—'; el.title = ''; return; }
    el.textContent = grinTile(v, unit);
    el.title = grinExact(v, unit);
  }

  window.PoolFmt = { grinTile: grinTile, grinExact: grinExact, setGrinTile: setGrinTile };
})();
