/* reactor-dashboard.js — homepage "Reactor Control" instrument wiring.
 *
 * Drives the control-panel deck in index.html from the public endpoints
 * (no auth; Auth.read returns parsed JSON on a 2xx, else null — audit §J15-2):
 *   /api/pool/stats            miners / blocks / rewards / share_quality
 *   /api/stratum/hashrate      pool GPS aggregates (hashrate gauge)
 *   /api/config/pool-info      fee / min payout / network (spec placard)
 *   /api/pool/effort           network share / luck / round shares (share gauge)
 *   /api/pool/status           pool+node+wallet health (annunciator, master lamp)
 *   /api/pool/blocks           fuel-rod maturity array
 *   /api/pool/payments         payout teletype
 *   /api/pool/stats/regions    patch-bay switches + region lamps
 *   /api/pool/hashrate/history fine 24h pool trace + gauge 24h-peak marker
 *   /api/pool/metrics/history  P-04 trend recorders (pool/network hashrate, miners online)
 *   /api/public/branding       default stratum host/port fallback + where latency may be timed
 *   /api/pool/connect/suggest  estimated latency per region + Recommended
 *   <hub or gateway>/ping      the browser's own RTT, replacing the estimate (empty 204s)
 *
 * All canvas instruments read their colors from the theme token bridge on <body>
 * (--accent/--gold/--warn/--danger/--info/--text-*) and re-render when the theme
 * switcher changes the body class, so every theme re-skins the gauges too.
 * Miner-supplied strings (addresses) are only ever written via textContent.
 */
(function () {
  'use strict';

  var REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var MONO = '"Cascadia Code","SF Mono",ui-monospace,Menlo,Consolas,monospace';

  // ── theme tokens (re-read on theme change) ────────────────────────────────
  var C = {};
  function tok(name, fb) {
    try {
      var v = getComputedStyle(document.body).getPropertyValue(name);
      return (v && v.trim()) || fb;
    } catch (e) { return fb; }
  }
  function readTokens() {
    C.accent = tok('--accent', '#5dff73');
    C.accent2 = tok('--accent2', '#ff4fd8');
    C.info = tok('--info', '#5ad1ff');
    C.warn = tok('--warn', '#f5b942');
    C.danger = tok('--danger', '#ff5a52');
    C.dim = tok('--text-dim', '#8a978f');
    C.mute = tok('--text-mute', '#57635c');
    C.bg = tok('--bg', '#07090c');
    // Dial face — the wide recessed arc the needle sweeps over. Must follow the theme:
    // as a hard-coded black it painted a dark grey band across a white panel on every
    // light theme. --rx-inset is the same recess token the counters/tubes use, and
    // themes.css re-tunes it per theme family.
    C.dial = tok('--rx-inset', 'rgba(0,0,0,.45)');
    // Light themes set --glow to transparent (themes.css "LIGHT-MODE CORRECTIONS"); mirror
    // that on canvas so the needle doesn't carry a coloured halo across a white dial.
    C.glow = tok('--glow', '');
    C.bloom = (C.glow === 'transparent') ? 0 : 8;
  }
  readTokens();

  // ── small helpers ─────────────────────────────────────────────────────────
  function $(id) { return document.getElementById(id); }
  // Derive a translucent variant of a theme color for canvas gradient stops (handles
  // #rgb / #rrggbb / rgb()/rgba()); falls back to the solid color if it can't parse.
  function withAlpha(col, a) {
    col = (col || '').trim();
    if (col[0] === '#') {
      var h = col.slice(1);
      if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
      var n = parseInt(h, 16);
      if (!isNaN(n)) return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
    }
    if (col.indexOf('rgb') === 0) {
      var m = col.match(/rgba?\(([^)]+)\)/);
      if (m) return 'rgba(' + m[1].split(',').slice(0, 3).map(function (x) { return x.trim(); }).join(',') + ',' + a + ')';
    }
    return col;
  }
  function setText(id, text) { var el = $(id); if (el) el.textContent = text; }
  // Set an element to a block height that deep-links to a chain explorer (new tab).
  function setHeightLink(id, height) {
    var el = $(id);
    if (!el) return;
    var label = Number(height).toLocaleString('en-US');
    if (height && window.Explorer) el.innerHTML = Explorer.link('block', height, label);
    else el.textContent = label;
  }
  function pad2(n) { return String(n).padStart(2, '0'); }

  // Display units follow the toolkit convention: G/s, kG/s, MG/s.
  function fmtGps(gps) {
    if (!isFinite(gps)) return ['—', ''];
    if (gps >= 1e6) return [(gps / 1e6).toFixed(2), 'MG/s'];
    if (gps >= 1e3) return [(gps / 1e3).toFixed(2), 'kG/s'];
    return [gps.toFixed(2), 'G/s'];
  }
  function timeAgo(unixSeconds) {
    if (!unixSeconds) return '—';
    var s = Math.max(0, Math.floor(Date.now() / 1000) - unixSeconds);
    if (s < 60) return s + 's';
    if (s < 3600) return Math.floor(s / 60) + 'm';
    if (s < 86400) return (s / 3600).toFixed(1) + 'h';
    return (s / 86400).toFixed(1) + 'd';
  }
  function truncAddr(addr) {
    addr = String(addr || '');
    return addr.length > 16 ? addr.slice(0, 9) + '…' + addr.slice(-4) : addr;
  }
  // Smallest "nice" ceiling (1-2-5 progression) above v — gauge/chart scale tops.
  function niceCeil(v) {
    if (!(v > 0)) return 1;
    var p = Math.pow(10, Math.floor(Math.log10(v)));
    var m = v / p;
    var f = m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10;
    return f * p;
  }

  // ── UTC station clock ─────────────────────────────────────────────────────
  function tickClock() {
    var el = $('rx-utc');
    if (!el) return;
    var d = new Date();
    el.textContent = pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes()) + ':' + pad2(d.getUTCSeconds()) + ' UTC';
  }
  tickClock();
  setInterval(tickClock, 1000);

  // ── analog gauges ─────────────────────────────────────────────────────────
  // A gauge owns its canvas; setValue() retargets the needle (eased approach with a
  // faint operating wobble once settled — skipped entirely under reduced motion).
  function Gauge(canvasId, opts) {
    var cv = $(canvasId);
    if (!cv) return null;
    var W = 190, H = 150;
    var dpr = window.devicePixelRatio || 1;
    cv.width = W * dpr; cv.height = H * dpr;
    // Pin the CSS display size independent of the backing store, otherwise the
    // browser falls back to the width/height attributes (= W*dpr) as CSS pixels
    // and the gauge balloons dpr× on HiDPI screens (real iPhone Safari, dpr=3).
    cv.style.width = W + 'px'; cv.style.height = H + 'px';
    var c = cv.getContext('2d');
    c.scale(dpr, dpr);

    var g = {
      min: 0, max: 1, ticks: 8, unit: '', zones: [], marker: null,
      gradient: null, needleColor: null,
      target: 0, cur: 0, wob: 0, running: false
    };
    Object.assign(g, opts || {});

    var cx = W / 2, cy = H - 24, R = 72;
    var a0 = Math.PI * 1.05, a1 = Math.PI * 1.95;
    function A(f) { return a0 + (a1 - a0) * Math.min(Math.max(f, 0), 1); }

    function render() {
      c.clearRect(0, 0, W, H);
      // dial face
      c.beginPath(); c.arc(cx, cy, R + 14, a0 - 0.06, a1 + 0.06);
      c.strokeStyle = C.dial; c.lineWidth = 30; c.stroke();
      // value band: an all-positive gradient sweep (hashrate — higher is better, so no
      // danger colors) OR discrete zones (round effort — green→amber→red).
      if (g.gradient) {
        var lg = c.createLinearGradient(cx - (R + 7), cy, cx + (R + 7), cy);
        g.gradient.forEach(function (s) { lg.addColorStop(s[0], s[1]); });
        c.beginPath(); c.arc(cx, cy, R + 7, a0, a1);
        c.strokeStyle = lg; c.lineWidth = 4; c.stroke();
      } else {
        g.zones.forEach(function (z) {
          c.beginPath();
          c.arc(cx, cy, R + 7, A((z[0] - g.min) / (g.max - g.min)), A((z[1] - g.min) / (g.max - g.min)));
          c.strokeStyle = z[2]; c.globalAlpha = 0.5; c.lineWidth = 4; c.stroke();
          c.globalAlpha = 1;
        });
      }
      // ticks + numerals
      c.font = '9px ' + MONO;
      for (var i = 0; i <= g.ticks; i++) {
        var f = i / g.ticks, a = A(f);
        var major = i % 2 === 0;
        c.strokeStyle = major ? C.dim : C.mute;
        c.lineWidth = major ? 1.6 : 1;
        c.beginPath();
        c.moveTo(cx + Math.cos(a) * (R - 2), cy + Math.sin(a) * (R - 2));
        c.lineTo(cx + Math.cos(a) * (R - (major ? 12 : 7)), cy + Math.sin(a) * (R - (major ? 12 : 7)));
        c.stroke();
        if (major) {
          var lab = g.min + (g.max - g.min) * f;
          var txt = (g.max - g.min) >= 20 ? String(Math.round(lab)) : String(parseFloat(lab.toFixed(1)));
          c.fillStyle = C.mute; c.textAlign = 'center'; c.textBaseline = 'middle';
          c.fillText(txt, cx + Math.cos(a) * (R - 22), cy + Math.sin(a) * (R - 22));
        }
      }
      // reference marker (e.g. 24h hashrate peak) — a bright info-blue pip on the rim.
      // It's a reference, not a danger line: higher hashrate is good, so no red at top.
      if (g.marker != null && g.marker >= g.min && g.marker <= g.max) {
        var ma = A((g.marker - g.min) / (g.max - g.min || 1));
        c.save();
        c.strokeStyle = C.info; c.lineWidth = 2.4; c.lineCap = 'round';
        c.beginPath();
        c.moveTo(cx + Math.cos(ma) * (R + 3), cy + Math.sin(ma) * (R + 3));
        c.lineTo(cx + Math.cos(ma) * (R - 11), cy + Math.sin(ma) * (R - 11));
        c.stroke();
        c.restore();
      }
      // needle (amber when the dial is flagged idle, e.g. zero active miners)
      var na = A(g.cur);
      var nc = g.needleColor || C.accent;
      c.save();
      c.shadowColor = nc; c.shadowBlur = C.bloom;
      c.strokeStyle = nc; c.lineWidth = 2.4; c.lineCap = 'round';
      c.beginPath();
      c.moveTo(cx - Math.cos(na) * 10, cy - Math.sin(na) * 10);
      c.lineTo(cx + Math.cos(na) * (R - 14), cy + Math.sin(na) * (R - 14));
      c.stroke();
      c.restore();
      // hub + unit
      c.beginPath(); c.arc(cx, cy, 5, 0, 7); c.fillStyle = C.mute; c.fill();
      c.beginPath(); c.arc(cx, cy, 2, 0, 7); c.fillStyle = nc; c.fill();
      c.fillStyle = C.mute; c.font = '9.5px ' + MONO; c.textAlign = 'center';
      c.fillText(g.unit, cx, cy - 26);
    }

    function loop() {
      g.cur += (g.target - g.cur) * 0.06;
      g.wob += 0.05;
      if (Math.abs(g.target - g.cur) < 0.002) g.cur = g.target + Math.sin(g.wob) * 0.0035;
      render();
      requestAnimationFrame(loop);
    }

    g.setScale = function (min, max, unit, zones, ticks) {
      g.min = min; g.max = max; g.unit = unit;
      if (zones) g.zones = zones;
      if (ticks) g.ticks = ticks;
    };
    g.setMarker = function (v) { g.marker = v; };
    g.setGradient = function (stops) { g.gradient = stops; };
    g.setNeedleColor = function (col) { g.needleColor = col || null; };
    g.setValue = function (v) {
      g.target = (v - g.min) / (g.max - g.min || 1);
      if (REDUCED) { g.cur = g.target; render(); }
      else if (!g.running) { g.running = true; requestAnimationFrame(loop); }
    };
    g.render = render;
    render();
    return g;
  }

  // Pool hashrate. Stable 0–200 G/s dial that auto-bumps only when the live value or the
  // 24h peak would exceed it (never pins); higher is better → single accent zone (no red
  // danger band), with an info-blue tick marking the 24h peak as a reference.
  var gaugeHash = Gauge('g-hash', { min: 0, max: 200, ticks: 8, unit: 'G/s' });
  // All-green gradient sweep (faint → bright accent). Higher hashrate is good, so the band
  // never turns red/amber by value — "low" is not "danger". Re-applied each refresh so a
  // theme switch re-derives it from the live --accent token.
  var HASH_GRAD = function () { return [[0, withAlpha(C.accent, 0.22)], [1, withAlpha(C.accent, 0.72)]]; };
  if (gaugeHash) gaugeHash.setGradient(HASH_GRAD());
  // Round effort — current round's Σ share-diff / one block's network diff, live. <100% =
  // nominal (green), 100–150% = running long (amber), >150% = overdue/unlucky (red). The
  // big numeral carries the true %; luck (100-block) + network share ride the sub-line.
  var gaugeShare = Gauge('g-share', { min: 0, max: 200, ticks: 8, unit: '%' });

  // Idle state for the hashrate dial: with zero active miners the value reads a muted amber
  // "IDLE" (needle + numeral) — a distinct dead-pool signal, deliberately NOT a red danger
  // band. Gated on active_miners (from /api/pool/stats), never raw gps=0 which blips to 0
  // between shares even with miners connected. Applied from both loaders so whichever lands
  // last keeps it fresh; null = not yet known → not idle.
  var lastActiveMiners = null;
  function applyHashState() {
    var idle = lastActiveMiners === 0;
    if (gaugeHash) gaugeHash.setNeedleColor(idle ? C.warn : null);
    var v = $('g-hash-v'); if (v) v.classList.toggle('idle', idle);
  }

  // ── LED bargraph (share quality) ──────────────────────────────────────────
  var LED_SEGS = 40;
  function renderLedbar(acc, stl, rej) {
    var bar = $('rx-ledbar');
    if (!bar) return;
    bar.textContent = '';
    var total = acc + stl + rej;
    var counts;
    if (total <= 0) {
      counts = { g: 0, a: 0, r: 0 };
    } else {
      // Non-zero minorities always get at least one visible segment; green fills the rest.
      var aSeg = stl > 0 ? Math.max(1, Math.round(LED_SEGS * stl / total)) : 0;
      var rSeg = rej > 0 ? Math.max(1, Math.round(LED_SEGS * rej / total)) : 0;
      counts = { g: Math.max(0, LED_SEGS - aSeg - rSeg), a: aSeg, r: rSeg };
    }
    for (var i = 0; i < LED_SEGS; i++) {
      var s = document.createElement('span');
      if (i < counts.g) s.className = 'g';
      else if (i < counts.g + counts.a) s.className = 'a';
      else if (i < counts.g + counts.a + counts.r) s.className = 'r';
      bar.appendChild(s);
    }
    var pct = function (n) { return total > 0 ? ((n / total) * 100).toFixed(1) + '%' : '—'; };
    setText('led-g', 'VALID ' + pct(acc));
    setText('led-a', 'STALE ' + pct(stl));
    setText('led-r', 'REJECT ' + pct(rej));
    setText('led-note', total > 0 ? '' : 'no live sessions right now');
    bar.setAttribute('aria-label', total > 0
      ? 'Share quality: ' + pct(acc) + ' valid, ' + pct(stl) + ' stale, ' + pct(rej) + ' rejected'
      : 'Share quality: no live sessions');
    // STALE annunciator: stale+rejected as a share of live shares. Green "Low stale" at or
    // under 5%, red "High stale" above it, unlit with no live sessions (nothing to judge).
    if (total <= 0) {
      setLamp('an-stale', '', 'no live shares', 'Stale rate');
    } else {
      var badPct = ((stl + rej) / total) * 100;
      var bad = badPct > 5;
      setLamp('an-stale', bad ? 'alarm' : 'ok',
        badPct.toFixed(1) + '% · limit 5%', bad ? 'High stale' : 'Low stale');
    }
  }

  // ORPHAN annunciator — orphans FOUND in the last 24 h (orphans_24h from /api/pool/stats),
  // so the lamp clears on its own a day after the orphaned block. null/absent = unknown
  // (failed read, or an older backend): stays unlit rather than claiming "no orphans".
  function renderOrphanLamp(n) {
    if (typeof n !== 'number' || !isFinite(n)) {
      setLamp('an-orphan', '', 'no data', 'Orphan check');
    } else if (n > 0) {
      setLamp('an-orphan', 'alarm', n + (n === 1 ? ' block' : ' blocks') + ' · last 24 h', 'Orphan detected');
    } else {
      setLamp('an-orphan', 'ok', 'last 24 hours', 'No orphan detected');
    }
  }

  // ── annunciator ───────────────────────────────────────────────────────────
  // `title` is optional and only rewrites lamps whose markup carries a .lamp-t span.
  function setLamp(id, state, subText, title) {
    var el = $(id);
    if (!el) return;
    el.className = 'lamp' + (state ? ' ' + state : '');
    if (title != null) {
      var t = el.querySelector('.lamp-t');
      if (t) t.textContent = title;
    }
    if (subText != null) {
      var small = el.querySelector('small');
      if (small) small.textContent = subText;
    }
  }

  // ── master lamp (composite pool + node + wallet health) ──────────────────
  function setMaster(state, label) {
    var el = $('rx-master');
    if (!el) return;
    el.className = 'master-lamp' + (state === 'ok' ? '' : ' ' + state);
    setText('rx-master-text', label);
  }

  // ── chart recorders (P-04) ────────────────────────────────────────────────
  // Rendered with PoolCharts (Chart.js, charts-init.js) — the same recorder the other
  // public pages use, replacing the old hand-rolled 24h strip chart (2026-07-17). Pool
  // and network hashrate are two ALIGNED single-axis charts, never one dual-axis chart:
  // network GPS runs orders of magnitude above pool GPS and would flatten the pool trace.
  var chartRange = 'day'; // 24H | 7D | 30D → /api/pool/metrics/history range vocabulary

  function toggleChartEmpty(id, show) {
    var el = $(id);
    if (el) el.style.display = show ? 'flex' : 'none';
  }

  // ── data loaders ──────────────────────────────────────────────────────────
  var nodeHeight = 0;      // for fuel-rod confirmation depth
  var BASE_PORT = '';      // pool default stratum port (regions may omit one)
  var hashPeakGps = 0;     // 24h peak (from the P-04 history series) → hashrate dial marker
  var DEFAULT_URI = '';    // operator's configured stratum host:port (zero-region fallback)

  async function loadPoolInfo() {
    try {
      var info = await Auth.read('/api/config/pool-info');
      if (!info) return;
      setText('pl-fee', (info.pool_fee_percent != null ? info.pool_fee_percent : 0).toFixed(1) + '%');
      setText('pl-min', (info.min_withdrawal != null ? info.min_withdrawal : 0).toFixed(1) + ' GRIN');
      setText('pl-net', String(info.network || '—').toUpperCase());
    } catch (e) { /* placard keeps placeholders */ }
  }

  async function loadHashrate() {
    try {
      var hr = await Auth.read('/api/stratum/hashrate');
      if (!hr) return;
      var gps = hr.pool_hashrate_1h_gps || 0;
      var g1 = fmtGps(gps);
      setText('g-hash-v', g1[0] + ' ' + g1[1]);
      var g24 = fmtGps(hr.pool_hashrate_24h_gps || 0);
      setText('g-hash-avg', lastActiveMiners === 0
        ? 'idle · no active miners'
        : '24h avg ' + g24[0] + ' ' + g24[1]);
      applyHashState();
      if (gaugeHash) {
        // Scale the dial in the display unit family of the current value.
        var unit = g1[1] || 'G/s';
        var div = unit === 'MG/s' ? 1e6 : unit === 'kG/s' ? 1e3 : 1;
        var val = gps / div;
        var peak = hashPeakGps / div;
        // Stable 200 G/s dial (floor); grows only when the live value OR the 24h peak
        // would exceed it, so the needle never pins and the peak tick always fits.
        var floor = unit === 'G/s' ? 200 : 1;
        var max = Math.max(floor, niceCeil(Math.max(val, peak) * 1.15));
        // Higher hashrate is good → all-green gradient sweep, no red danger band at the top.
        gaugeHash.setScale(0, max, unit, [], 8);
        gaugeHash.setGradient(HASH_GRAD());
        gaugeHash.setMarker(peak > 0 ? peak : null);
        gaugeHash.setValue(val);
      }
    } catch (e) { /* gauge keeps last position */ }
  }

  async function loadStats() {
    try {
      var s = await Auth.read('/api/pool/stats');
      if (!s) { renderOrphanLamp(null); return; }
      renderOrphanLamp(s.orphans_24h);
      setText('c-miners', String(s.active_miners || 0));
      lastActiveMiners = Number(s.active_miners) || 0;
      applyHashState();
      // Logged-in rigs. Older backends only carry the raw socket count, which is the same
      // number once every connection has logged in.
      var workers = Number(s.active_workers != null ? s.active_workers : s.active_connections) || 0;
      setText('c-miners-sub', workers + (workers === 1 ? ' worker' : ' workers'));
      setText('c-blocks24', String(s.blocks_24h || 0));
      setText('c-total', Number(s.total_blocks_found || 0).toLocaleString('en-US'));
      setText('c-reward', Number(s.confirmed_reward || 0).toFixed(0));
      // Still maturing (1,440 confirmations); older backends don't send it.
      setText('c-immature', Number(s.immature_reward || 0).toFixed(0));
      setText('mi-miners', (s.active_miners || 0) + ' UNITS');
      var q = s.share_quality || {};
      renderLedbar(Number(q.accepted) || 0, Number(q.stale) || 0, Number(q.rejected) || 0);
    } catch (e) { renderOrphanLamp(null); /* counters keep placeholders */ }
  }

  // More decimals for a small share so it isn't rounded to "0%".
  function fmtShare(v) { return v.toFixed(v < 1 ? 2 : v < 10 ? 1 : 0) + '%'; }

  // Compact big numbers for the spec plate (2.11 M, 58.3 K) — difficulty can be huge.
  function fmtCompact(n) {
    n = Number(n) || 0;
    if (n >= 1e9) return (n / 1e9).toFixed(2) + ' G';
    if (n >= 1e6) return (n / 1e6).toFixed(2) + ' M';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + ' K';
    return String(Math.round(n));
  }

  async function loadShare() {
    try {
      var e = await Auth.read('/api/pool/effort');
      if (!e) return;
      var share = e.network_share_pct;
      // Spec-plate network conditions (same endpoint already carries them).
      if (e.network_hashrate_gps != null) {
        var gh = fmtGps(e.network_hashrate_gps);
        setText('pl-nethash', gh[0] + ' ' + gh[1]);
      }
      setText('pl-netdiff', e.network_difficulty != null ? fmtCompact(e.network_difficulty) : '—');
      // Round-effort gauge: live current-round effort. The 100-block luck + network share
      // (both still useful, but not gauge-shaped) ride the sub-line under the numeral.
      var effort = e.round_effort_pct != null ? e.round_effort_pct : 0;
      setText('g-share-v', e.round_effort_pct != null ? Math.round(effort) + '%' : '—');
      // §J12-7 added round_window_capped: true means the round window was clamped to a floor
      // because the pool has not found a block yet, so "effort" is measured from an arbitrary
      // start rather than from the last block. The number is honest arithmetic on a window
      // that is not a round; presenting it as one is not (audit §J15-8, answering §J12's
      // handoff). Say so in the sub-line and skip the luck figure, which needs a real round.
      if (e.round_window_capped) {
        setText('g-share-luck', 'no block found yet — measured from a window, not a round');
      } else {
        setText('g-share-luck',
          // Shares ÷ network difficulty, so UNDER 100% is a lucky pool — the same
          // convention as the blocks page. Bare "luck 87%" reads as bad news to
          // anyone assuming higher-is-better, hence the suffix.
          (e.luck_100_pct != null
            ? 'luck ' + e.luck_100_pct.toFixed(0) + '% ' + (e.luck_100_pct <= 100 ? '(lucky)' : '(unlucky)')
            : 'luck —') +
          ' · ' + (share != null ? 'share ' + fmtShare(share) : 'share —'));
      }
      if (gaugeShare) {
        // Stable 0–200% dial (bumps if a very unlucky round runs past it). Zones:
        // 0–100 nominal, 100–150 running long, 150→top overdue.
        var emax = Math.max(200, niceCeil(effort * 1.1));
        gaugeShare.setScale(0, emax, '%',
          [[0, 100, C.accent], [100, 150, C.warn], [150, emax, C.danger]], 8);
        gaugeShare.setValue(Math.min(effort, emax));
      }
      setText('c-last', e.last_block_at ? timeAgo(e.last_block_at) + ' ago' : 'none yet');
      setText('mi-core-share', 'NET-SHARE ' + (share != null ? fmtShare(share) : '—'));
      // `round_shares` is the round's SUMMED share difficulty in chain units (each accepted
      // share weighs job target × 16384 — the effort numerator), so printing it as "SHARES"
      // showed 21.5 M for ~1,300 real shares. `round_share_count` is the count a miner can
      // check against their rig's accepted tally; the sum stays on hover for the curious.
      var sharesEl = $('mi-core-shares');
      if (e.round_share_count != null) {
        setText('mi-core-shares', fmtCompact(e.round_share_count) + ' SHARES');
        if (sharesEl) sharesEl.title = Number(e.round_share_count).toLocaleString('en-US') +
          ' accepted shares this round · summed difficulty ' +
          fmtCompact(e.round_shares) + ' (chain units, the round-effort numerator)';
      } else {
        setText('mi-core-shares', '— SHARES');
        if (sharesEl) sharesEl.removeAttribute('title');
      }
    } catch (err) { /* gauge keeps last position */ }
  }

  async function loadStatus() {
    try {
      var s = await Auth.read('/api/pool/status');
      if (!s) throw new Error('no status');
      var poolOk = !!(s.pool && s.pool.ok);
      var nodeOk = !!(s.node && s.node.reachable);
      var nodeSynced = nodeOk && s.node.synced === true;
      var walletOk = !!(s.wallet && s.wallet.reachable);
      nodeHeight = (nodeOk && s.node.height) || nodeHeight;

      setLamp('an-pool', poolOk ? 'ok' : 'alarm', poolOk ? 'online' : 'offline');
      if (nodeOk) {
        setLamp('an-node', nodeSynced ? 'ok' : 'warn',
          (s.node.peers || 0) + ' peers' + (nodeSynced ? '' : ' · sync'));
      } else {
        setLamp('an-node', 'alarm', 'offline');
      }
      setLamp('an-wallet', walletOk ? 'ok' : 'alarm', walletOk ? 'unlocked' : 'offline');

      if (nodeHeight) setHeightLink('c-height', nodeHeight);
      var nodeVal = $('mi-node');
      if (nodeVal) {
        nodeVal.textContent = nodeOk ? (nodeSynced ? 'SYNCED' : 'SYNCING') : 'OFFLINE';
        nodeVal.setAttribute('class', nodeOk ? (nodeSynced ? 'val cy' : 'val') : 'val bad');
      }

      if (!poolOk) {
        setMaster('bad', 'Pool unreachable');
      } else if (nodeOk && nodeSynced && walletOk) {
        setMaster('ok', 'All systems nominal');
      } else {
        var issues = [];
        if (!nodeOk) issues.push('node offline');
        else if (!nodeSynced) issues.push('node syncing');
        if (!walletOk) issues.push('wallet offline');
        setMaster('warn', 'Degraded · ' + issues.join(', '));
      }
    } catch (e) {
      setLamp('an-pool', 'alarm', 'offline');
      setLamp('an-node', 'alarm', 'offline');
      setLamp('an-wallet', 'alarm', 'offline');
      setMaster('bad', 'Pool unreachable');
    }
  }

  // Fuel rods: one column per recent block; fill = confirmation depth / 1440, and the rod's
  // colour walks --warn → --accent with the same ratio (CSS reads it from --mat).
  // Always 10 rods on a fixed grid (reactor.css), so nothing scrolls sideways.
  var ROD_COUNT = 10;
  async function loadBlocks() {
    var wrap = $('rx-rods');
    if (!wrap) return;
    try {
      var blocks = await Auth.read('/api/pool/blocks?limit=' + ROD_COUNT);
      wrap.textContent = '';
      // null = the feed did not answer (429, 5xx, network). That is NOT "no blocks yet", and
      // saying so told every visitor a working pool had never found a block (audit §J15-2).
      if (blocks === null) {
        var u = document.createElement('div');
        u.className = 'rods-empty';
        u.textContent = 'BLOCK FEED UNAVAILABLE';
        wrap.appendChild(u);
        return;
      }
      if (!Array.isArray(blocks) || blocks.length === 0) {
        var d = document.createElement('div');
        d.className = 'rods-empty';
        d.textContent = 'NO BLOCKS FOUND YET';
        wrap.appendChild(d);
        return;
      }
      // Height counter fallback: with the node unreachable, show the newest pool block.
      if (!nodeHeight && blocks[0] && blocks[0].height) {
        setHeightLink('c-height', blocks[0].height);
      }
      // The orphan LAMP is owned by loadStats (24 h window); rods still mark each orphan.
      blocks.slice(0, ROD_COUNT).forEach(function (b) {
        var height = Number(b.height || 0);
        var conf;
        if (b.status === 'confirmed') conf = 1440;
        else if (nodeHeight && height) conf = Math.max(0, Math.min(1440, nodeHeight - height));
        else conf = Math.max(0, Math.min(1440, Math.floor((Date.now() / 1000 - (b.found_at || b.created_at || 0)) / 60)));
        var orphan = b.status === 'orphaned';
        var mature = b.status === 'confirmed';

        var pct = orphan || mature ? 100 : Math.floor(100 * conf / 1440);

        var rod = document.createElement('div');
        rod.className = 'rod' + (mature ? ' done' : '') + (orphan ? ' orphan' : '');
        rod.style.setProperty('--mat', pct + '%');
        var tube = document.createElement('div');
        tube.className = 'tube';
        // The fill is always full height; maturity is where green meets yellow (CSS, --mat).
        // A proportional-height fill left a busy hour's rods all at ~3% and looking dead.
        var fill = document.createElement('div');
        fill.className = 'fill';
        tube.appendChild(fill);
        // Face label = the last 4 digits ("…4,399"): always 6 characters, so a rod never widens
        // as the chain grows, and it is the part that tells neighbouring blocks apart. Never an
        // abbreviation like "4M399" — that reads as a different number. Full height is in the
        // tooltip and the link's aria-label.
        var full = height.toLocaleString('en-US');
        var last4 = String(height % 10000).padStart(4, '0');
        var tail = height >= 10000 ? '…' + last4.charAt(0) + ',' + last4.slice(1) : '#' + full;
        var h = document.createElement('div');
        h.className = 'h';
        // Link the block height out to a chain explorer (new tab) as independent proof.
        if (height && window.Explorer) {
          h.innerHTML = Explorer.link('block', height, tail);
          if (h.firstElementChild) h.firstElementChild.setAttribute('aria-label', 'Block ' + full + ' on a chain explorer');
        } else {
          h.textContent = tail;
        }
        var m = document.createElement('div');
        m.className = 'm pct';
        m.textContent = orphan ? 'ORPHAN' : (mature ? 'MATURE' : pct + '%');
        var when = document.createElement('div');
        when.className = 'm';
        when.textContent = timeAgo(b.found_at || b.created_at);
        rod.appendChild(tube); rod.appendChild(h); rod.appendChild(m); rod.appendChild(when);
        // The reward (60 + fees, so the same "60" on every rod) lives here, not on the face.
        rod.title = 'Block ' + full + ' · ' + (b.status || 'immature') +
          (orphan || mature ? '' : ' · ' + conf + '/1440 confirmations') +
          ' · reward ' + Number(b.reward || 0).toFixed(2) + ' GRIN';
        wrap.appendChild(rod);
      });
    } catch (e) {
      wrap.textContent = '';
      var d2 = document.createElement('div');
      d2.className = 'rods-empty';
      d2.textContent = 'BLOCK DATA UNAVAILABLE';
      wrap.appendChild(d2);
    }
  }

  // Rail tag for a teletype line, from withdrawals.method. This used to be a hard-coded
  // '[TOR OK]', so a Slatepack or Goblin payout printed as Tor. The column is
  // `NOT NULL DEFAULT 'tor'` (db.js — the Tor rail's INSERT relies on that default), so a
  // missing value can only mean an older API response and still reads as Tor. Any other
  // unknown rail prints its own name rather than being passed off as one we know.
  var PAY_RAIL_TAG = { tor: 'TOR', slatepack: 'SLATEPACK', nostr: 'GOBLIN', manual: 'MANUAL' };
  function payRailTag(method) {
    var m = String(method || 'tor').toLowerCase();
    return '[' + (PAY_RAIL_TAG[m] || m.toUpperCase()) + ' OK]';
  }

  // Payout teletype (addresses are miner-supplied → textContent only).
  async function loadPayments() {
    var tty = $('rx-tty');
    if (!tty) return;
    try {
      var payments = await Auth.read('/api/pool/payments?limit=7');
      tty.textContent = '';
      // Same split as loadBlocks: "the feed is down" and "nobody has been paid yet" are
      // opposite facts about a pool and must not share a line (audit §J15-2).
      if (payments === null) {
        var pu = document.createElement('div');
        pu.textContent = 'PAYOUT FEED UNAVAILABLE';
        tty.appendChild(pu);
        setLamp('an-payouts', 'warn', 'feed down');
        return;
      }
      if (!Array.isArray(payments) || payments.length === 0) {
        var d = document.createElement('div');
        d.textContent = 'NO PAYOUTS YET — first payout prints here';
        tty.appendChild(d);
        // A quiet/new pool with no payouts yet is normal — neutral, never an alarm.
        setLamp('an-payouts', '', 'none yet');
        return;
      }
      // Payouts lamp: last payout age (green = auto-pay is flowing). Info, not an alarm —
      // gaps between payouts are expected when miners haven't crossed the min payout.
      var newestPay = payments.reduce(function (m, p) {
        return Math.max(m, p.confirmed_at || p.created_at || 0);
      }, 0);
      setLamp('an-payouts', newestPay ? 'ok' : '', newestPay ? timeAgo(newestPay) + ' ago' : 'none yet');
      // Print oldest → newest so the freshest line sits at the bottom (printer style).
      payments.slice().reverse().forEach(function (p) {
        var ts = p.confirmed_at || p.created_at || 0;
        var dte = new Date(ts * 1000);
        var line = document.createElement('div');
        line.appendChild(document.createTextNode(
          pad2(dte.getUTCHours()) + ':' + pad2(dte.getUTCMinutes()) + ' UTC  PAID '));
        var b = document.createElement('b');
        b.textContent = Number(p.amount || 0).toFixed(2) + ' GRIN';
        line.appendChild(b);
        line.appendChild(document.createTextNode(' → ' + truncAddr(p.grin_address) + '  '));
        var via = document.createElement('span');
        via.className = 'via';
        via.textContent = payRailTag(p.method);
        line.appendChild(via);
        tty.appendChild(line);
      });
    } catch (e) {
      tty.textContent = '';
      var d2 = document.createElement('div');
      d2.textContent = 'PAYMENT DATA UNAVAILABLE';
      tty.appendChild(d2);
      setLamp('an-payouts', 'warn', 'no data');
    }
  }

  async function loadTrendCharts() {
    if (typeof PoolCharts === 'undefined') return;

    // Fine-grained (5-min) 24h pool series: always fetched — it feeds the hashrate
    // dial's 24h-peak marker — and it IS the pool trace when the 24H range is selected.
    var fine = [];
    try {
      var data = await Auth.read('/api/pool/hashrate/history?hours=24');
      fine = (data && data.series) || [];
      hashPeakGps = fine.reduce(function (m, p) { return Math.max(m, Number(p.gps) || 0); }, 0);
    } catch (e) { /* keep last peak / trace */ }

    // Durable hourly/daily rollup for the selected range (pool 7D/30D + network line).
    var points = [], bucket = 3600;
    try {
      var m = await Auth.read('/api/pool/metrics/history?range=' + chartRange);
      points = (m && m.points) || [];
      bucket = (m && m.bucket_seconds) || 3600;
    } catch (e) { /* charts keep last trace */ }

    var pool = chartRange === 'day'
      ? fine.map(function (p) { return { t: p.t, v: p.gps }; })
      : points.map(function (p) { return { t: p.t, v: p.hashrate_gps }; });
    toggleChartEmpty('rx-chart-empty', pool.length === 0);
    PoolCharts.renderTrendLine('rx-chart', pool, {
      label: 'Pool hashrate',
      bucketSeconds: chartRange === 'day' ? 300 : bucket,
      valueFmt: PoolCharts.fmtGps
    });

    // Network hashrate — hourly samples stored by the rollup; NULL rows (pre-deploy hours,
    // node unreachable) are skipped, so the series simply starts when sampling started.
    var net = [];
    points.forEach(function (p) {
      if (p.network_hashrate_gps != null) net.push({ t: p.t, v: p.network_hashrate_gps });
    });
    toggleChartEmpty('rx-chart-net-empty', net.length === 0);
    PoolCharts.renderTrendLine('rx-chart-net', net, {
      label: 'Network hashrate',
      bucketSeconds: bucket,
      valueFmt: PoolCharts.fmtGps,
      color: '#3987e5',
      compact: true
    });
    renderPoolShare(pool, net);
    // A fixed-30d "miners online" trace was rendered here until 2026-07-19 — removed with its
    // canvas (see index.html P-04); miners-stats.html P-02 covers it with a full range toggle.
  }

  // Pool share of network hashrate, printed on the network sub-label. This is the one honest
  // way to show the pool/network RELATIONSHIP: at a fraction of a percent the pool is invisible
  // on a shared axis (and a pie wedge would be ~1° of arc), but the number reads fine at any
  // magnitude. Pool and network are sampled on different cadences (5-min vs hourly), so pair the
  // newest network sample with the pool point closest to it in time rather than the two array tails.
  function renderPoolShare(pool, net) {
    var el = $('rx-share');
    if (!el) return;
    var hide = function () { el.hidden = true; el.textContent = ''; };
    if (!pool.length || !net.length) return hide();

    var lastNet = net[net.length - 1];
    var netGps = Number(lastNet.v) || 0;
    if (netGps <= 0) return hide();

    var near = pool.reduce(function (best, p) {
      return Math.abs(p.t - lastNet.t) < Math.abs(best.t - lastNet.t) ? p : best;
    }, pool[0]);
    var poolGps = Number(near.v) || 0;
    if (poolGps <= 0) return hide();

    // More decimals the smaller the share, so a new pool never reads as a flat "0.0%".
    var pct = (poolGps / netGps) * 100;
    var txt = pct >= 1 ? pct.toFixed(1) : (pct >= 0.1 ? pct.toFixed(2) : pct.toFixed(3));

    el.textContent = '';
    var b = document.createElement('b');
    b.textContent = txt + '%';
    el.appendChild(b);
    el.appendChild(document.createTextNode(' of network'));
    el.hidden = false;
  }

  // 24H / 7D / 30D toggle on the P-04 title → redraw the hashrate pair.
  (function wireChartRange() {
    var bar = $('rx-range');
    if (!bar) return;
    bar.addEventListener('click', function (e) {
      var btn = e.target.closest('button[data-range]');
      if (!btn) return;
      var r = btn.getAttribute('data-range');
      if (!r || r === chartRange) return;
      chartRange = r;
      bar.querySelectorAll('button').forEach(function (b) {
        var on = b === btn;
        b.classList.toggle('active', on);
        b.setAttribute('aria-selected', on ? 'true' : 'false');
      });
      loadTrendCharts();
    });
  })();

  // ── region patch bay + region annunciator lamps ───────────────────────────
  function regionHostPort(r) {
    var parts = String(r.stratum_url || '').split(':');
    return parts[0] + ':' + (parts[1] || BASE_PORT || '3333');
  }
  // host:port only — iPollo G1/G1-Mini and lolMiner/GMiner all accept a bare
  // host:port; the stratum+tcp:// scheme prefix is unnecessary and just clutters
  // the field (operator request 2026-07-14).
  function regionStratumUri(r) { return regionHostPort(r); }
  function statusCls(s) {
    // The public regions API emits 'online' | 'idle' | 'offline' | 'checking'.
    //   online   — reachable + active miners (green)
    //   idle     — reachable, no recent miners; fine to connect (blue)
    //   offline  — tunnel down / nothing listening on the advertised port (red)
    //   checking — no liveness verdict yet, first poll after a pool restart (grey, pulsing)
    // Server-side these are backed by recent shares, the WireGuard handshake AND an active
    // TCP dial of the advertised endpoint, so 'idle' means genuinely reachable and 'offline'
    // is a real down — neither is a guess. 'checking' exists so an unknown never masquerades
    // as 'idle': the bay paints instantly and recolours the moment the verdict lands.
    return s === 'online' ? 's-online'
      : s === 'offline' ? 's-down'
      : s === 'checking' ? 's-checking'
      : 's-idle';
  }
  function statusWord(s) {
    return s === 'online' ? '● ONLINE'
      : s === 'offline' ? '● OFFLINE'
      : s === 'checking' ? '◌ CHECKING'
      : '○ IDLE';
  }
  function statusTitle(s) {
    return s === 'online' ? 'online — miners active'
      : s === 'offline' ? 'offline — gateway unreachable'
      : s === 'checking' ? 'checking — verifying this endpoint right now'
      : 'idle — reachable, no recent miners';
  }

  // FALLBACK only — used when /api/pool/connect/suggest has no answer (no geo-IP on the server,
  // an unknown country). A gateway does not shorten the trip to the pool, so the honest default
  // is the pool's own region (is_hub). The one exception is mainland China / HK / Taiwan / Macau,
  // where the cross-border route is the problem a Hong Kong gateway exists for. No per-region
  // timezone table: that went stale every time the region list changed.
  function detectNearestRegion(regions) {
    var tz = '';
    try { tz = (Intl.DateTimeFormat().resolvedOptions().timeZone) || ''; } catch (e) { tz = ''; }
    var usable = function (k) {
      return regions.some(function (r) { return r.region === k && r.status !== 'offline'; }) ? k : null;
    };
    if (/^Asia\/(Shanghai|Hong_Kong|Taipei|Macau|Macao|Urumqi)$/.test(tz) && usable('hkg')) return 'hkg';
    var hub = regions.filter(function (r) { return r.is_hub === true; })[0];
    return hub ? usable(hub.region) : null;
  }

  // ── connect suggestion: "~NN ms" per chip + a "Recommended" badge ─────────
  // Server-side ESTIMATE (effective latency = your distance to a server + its link to the pool,
  // lib/connect-suggest.js). Fetched ONCE per page load, in parallel with the region list and
  // never awaited by it: the patch bay paints from /stats/regions alone, then re-renders when
  // this lands. `suggestion` = { recommended: tag|null, byRegion: { tag: { est_ms, via } } }.
  var suggestion = null;
  var suggestionP = null;
  var userPickedRegion = false;  // a chip was clicked this page load → the selection is theirs
  var lastRegionsData = null;    // last /stats/regions payload, so the suggestion can re-render it

  function loadSuggestion() {
    if (suggestionP) return suggestionP;
    suggestionP = Auth.read('/api/pool/connect/suggest').then(function (d) {
      if (!d || d.basis !== 'estimate' || !Array.isArray(d.estimates)) return;
      var by = {};
      d.estimates.forEach(function (e) {
        if (e && e.region && e.est_ms > 0) by[e.region] = { est_ms: Math.round(e.est_ms), via: e.via };
      });
      suggestion = { recommended: (d.recommended && by[d.recommended]) ? d.recommended : null, byRegion: by };
      if (lastRegionsData) renderRegions(lastRegionsData);
    });
    return suggestionP;
  }

  // ── connect measurement: the browser times each server itself ─────────────
  // Replaces the estimate above wherever it succeeds; a server it cannot time keeps its estimate.
  // Where it may time (lib/latency-probe.js → /api/public/branding connection.latency):
  //   · the hub (the is_hub "direct" row) at hub_url: '/ping' same-origin, an un-proxied
  //     https://<host>/ping, or null behind a CDN (the edge would answer, a few ms from everyone);
  //   · a gateway at https://<its stratum host>/ping, and ONLY under probe_domain. The page CSP's
  //     connect-src carries https://*.<probe_domain> and nothing wider, so any other host would be
  //     a CSP violation, not a measurement.
  // That is viewer→server. A gateway does not shorten the trip to the pool, so its figure is that
  // PLUS its hub_rtt_ms; direct is viewer→hub alone. The pick re-runs through pickRecommended()
  // with the server's own bias (direct_bias_ms). No latency config = no measurement at all.
  // Budget: a gateway answers 30 req / 10 s per IP, the hub a burst of 20. One run is 4 requests
  // per host, and re-test is held off RETEST_HOLD_MS after every run.
  var RTT_TIMEOUT_MS = 2500;   // per request; a gateway without the probe may DROP, not refuse
  var RTT_SAMPLES = 3;         // after one warm-up that pays DNS + TLS
  var RTT_CACHE_KEY = 'pool.rtt.v1';
  var RTT_CACHE_MS = 10 * 60 * 1000;
  var RETEST_HOLD_MS = 15000;
  var latencyCfg = null;       // { probe_domain, hub_url, direct_bias_ms } once branding answers
  var latencyCfgP = null;
  var measuredByUrl = {};      // probe URL → viewer→server ms, or null (tried and failed)
  var measuredAt = {};         // probe URL → when (ms epoch), for the session cache
  var measuring = false;
  var bayVisible = false;      // the connect panel has been on screen (IntersectionObserver)
  var retestBtn = null;
  var retestHeldUntil = 0;
  var retestTimer = null;

  // ⚠ A copy of pickRecommended() in back-end-pool/lib/connect-suggest.js — this file deploys
  // to the web root, apart from the app, so it cannot load that one. test-connect-suggest.js [h]
  // runs both on the same inputs: change both or neither. Keep it self-contained (the test
  // lifts it out by its text). rows: [{ region, ms, direct }] → tag | null.
  function pickRecommended(rows, bias) {
    var list = [];
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (r && r.region && typeof r.ms === 'number' && isFinite(r.ms)) list.push(r);
    }
    if (!list.length) return null;
    list.sort(function (a, b) {
      return (a.ms - b.ms) || (a.region < b.region ? -1 : a.region > b.region ? 1 : 0);
    });
    var best = list[0];
    var direct = null;
    for (var j = 0; j < list.length; j++) { if (list[j].direct === true) { direct = list[j]; break; } }
    return (direct && best.direct !== true && direct.ms - best.ms <= bias) ? direct.region : best.region;
  }

  // Branding is read once and shared with loadRegions' port/host fallback. A failed read is
  // forgotten so the next caller retries; an answer is kept for the page's life.
  var brandingP = null;
  function readBranding() {
    if (!brandingP) {
      brandingP = Auth.read('/api/public/branding').catch(function () { return null; }).then(function (b) {
        if (!b) brandingP = null;
        return b;
      });
    }
    return brandingP;
  }

  function loadLatencyConfig() {
    if (latencyCfg || latencyCfgP) return;
    latencyCfgP = readBranding().then(function (b) {
      latencyCfgP = null;
      var l = b && b.data && b.data.connection && b.data.connection.latency;
      if (!l || !(typeof l.direct_bias_ms === 'number' && isFinite(l.direct_bias_ms) && l.direct_bias_ms >= 0)) return;
      latencyCfg = {
        probe_domain: (typeof l.probe_domain === 'string' && /^[a-z0-9.-]+$/.test(l.probe_domain)) ? l.probe_domain : null,
        hub_url: (l.hub_url === '/ping' ||
          (typeof l.hub_url === 'string' && /^https:\/\/[a-z0-9.-]+\/ping$/.test(l.hub_url))) ? l.hub_url : null,
        direct_bias_ms: l.direct_bias_ms,
      };
      if (lastRegionsData) renderRegions(lastRegionsData);
    });
  }

  function publishedRegions(data) {
    var regions = (data && Array.isArray(data.regions)) ? data.regions : [];
    return regions.filter(function (r) { return r.stratum_url && r.is_active !== false; });
  }

  // The /ping URL this page may time for a region, or null.
  function probeUrlFor(r) {
    if (!latencyCfg) return null;
    if (r.is_hub === true) return latencyCfg.hub_url;
    var dom = latencyCfg.probe_domain;
    var host = String(r.stratum_url || '').split(':')[0].toLowerCase();
    if (!dom || !/^[a-z0-9.-]+$/.test(host)) return null;
    if (host.slice(-(dom.length + 1)) !== '.' + dom) return null;  // the CSP wildcard skips the apex
    return 'https://' + host + '/ping';
  }

  // One timed GET. RTT = responseStart − requestStart from Resource Timing when it is readable
  // (both probes send Timing-Allow-Origin: *), else the fetch's wall time. Only an empty 204 counts
  // — a redirect, an error page or a 429 is not this probe.
  function pingOnce(url) {
    var ctl = (typeof AbortController === 'function') ? new AbortController() : null;
    var timer = ctl ? setTimeout(function () { ctl.abort(); }, RTT_TIMEOUT_MS) : null;
    var u = url + '?r=' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    var t0 = performance.now();
    return fetch(u, { cache: 'no-store', credentials: 'omit', redirect: 'error', signal: ctl ? ctl.signal : undefined })
      .then(function (res) {
        var wall = performance.now() - t0;
        if (res.status !== 204) return null;
        var e = null;
        try {
          var list = performance.getEntriesByName(new URL(u, location.href).href, 'resource');
          e = list[list.length - 1] || null;
        } catch (err) { e = null; }
        return (e && e.requestStart > 0 && e.responseStart > e.requestStart) ? e.responseStart - e.requestStart : wall;
      })
      .catch(function () { return null; })
      .then(function (ms) { if (timer) clearTimeout(timer); return ms; });
  }

  // Warm-up, then RTT_SAMPLES in sequence on the same (kept-alive) connection → the fastest, or
  // null. A failed warm-up ends it: a host that is not answering would otherwise cost 4 timeouts.
  function measureRtt(url) {
    return pingOnce(url).then(function (warm) {
      if (warm == null) return null;
      var best = null;
      var n = 0;
      function next() {
        if (n++ >= RTT_SAMPLES) return best;
        return pingOnce(url).then(function (ms) {
          if (ms != null && (best == null || ms < best)) best = ms;
          return next();
        });
      }
      return next();
    });
  }

  // sessionStorage, 10 min per URL. Every access guarded: a private window or blocked storage
  // throws, and the page must measure as if the cache were empty.
  function readRttCache() {
    try {
      var c = JSON.parse(sessionStorage.getItem(RTT_CACHE_KEY) || 'null');
      var out = {};
      var now = Date.now();
      if (!c || typeof c !== 'object') return out;
      Object.keys(c).forEach(function (url) {
        var v = c[url];
        if (!v || typeof v.at !== 'number' || v.at > now || now - v.at > RTT_CACHE_MS) return;
        if (v.ms === null || (typeof v.ms === 'number' && isFinite(v.ms) && v.ms > 0 && v.ms < 60000)) out[url] = v;
      });
      return out;
    } catch (e) { return {}; }
  }
  function writeRttCache() {
    try {
      var c = {};
      Object.keys(measuredByUrl).forEach(function (url) { c[url] = { ms: measuredByUrl[url], at: measuredAt[url] }; });
      sessionStorage.setItem(RTT_CACHE_KEY, JSON.stringify(c));
    } catch (e) { /* no storage — measure again next load */ }
  }

  // Time every region's probe that has not been tried this page load (force: all of them again).
  // Runs only once the connect panel has been on screen. Hosts run in parallel, samples within a
  // host in sequence. The bay re-renders ONCE, when every host has answered or timed out, so the
  // Recommended badge does not hop between chips as results trickle in.
  function maybeMeasure(force) {
    if (measuring || !bayVisible || !latencyCfg || !lastRegionsData) return;
    if (force && Date.now() < retestHeldUntil) return;
    var cached = force ? {} : readRttCache();
    var fromCache = false;
    var todo = [];
    publishedRegions(lastRegionsData).forEach(function (r) {
      if (r.status === 'offline') return;
      var url = probeUrlFor(r);
      if (!url || todo.indexOf(url) >= 0) return;
      if (!force && url in measuredByUrl) return;
      if (!force && cached[url]) {
        measuredByUrl[url] = cached[url].ms;
        measuredAt[url] = cached[url].at;
        fromCache = true;
        return;
      }
      todo.push(url);
    });
    if (!todo.length) {
      if (fromCache) renderRegions(lastRegionsData);
      return;
    }
    measuring = true;
    updateRetest();
    Promise.all(todo.map(function (url) {
      return measureRtt(url).then(function (ms) { return [url, ms]; }, function () { return [url, null]; });
    })).then(function (pairs) {
      var now = Date.now();
      pairs.forEach(function (p) { measuredByUrl[p[0]] = p[1]; measuredAt[p[0]] = now; });
      writeRttCache();
    }).catch(function () { /* keep the estimates */ }).then(function () {
      measuring = false;
      retestHeldUntil = Date.now() + RETEST_HOLD_MS;
      renderRegions(lastRegionsData);
    });
  }

  // "Re-test latency" — below the switch bank, shown only when there is something to time.
  function updateRetest() {
    var bank = $('rx-switches');
    if (!bank) return;
    if (!retestBtn) {
      retestBtn = document.createElement('button');
      retestBtn.type = 'button';
      retestBtn.className = 'rgn-retest';
      retestBtn.id = 'rx-retest';
      retestBtn.hidden = true;
      retestBtn.addEventListener('click', function () { maybeMeasure(true); });
      bank.insertAdjacentElement('afterend', retestBtn);
    }
    var any = bank.style.display !== 'none' && publishedRegions(lastRegionsData).some(function (r) {
      return r.status !== 'offline' && !!probeUrlFor(r);
    });
    var wait = retestHeldUntil - Date.now();
    retestBtn.hidden = !any || !bayVisible;
    retestBtn.disabled = measuring || wait > 0;
    retestBtn.textContent = measuring ? 'Testing latency…' : 'Re-test latency';
    if (!measuring && wait > 0 && !retestTimer) {
      retestTimer = setTimeout(function () { retestTimer = null; updateRetest(); }, wait + 50);
    }
  }

  // Measurement starts the first time the connect panel scrolls into view: a visitor who never
  // reaches it costs no probe traffic. No IntersectionObserver → treat it as visible.
  (function watchConnectPanel() {
    var panel = $('connect');
    var seen = function () { bayVisible = true; loadLatencyConfig(); maybeMeasure(false); };
    if (!panel || typeof IntersectionObserver !== 'function') { seen(); return; }
    var io = new IntersectionObserver(function (entries) {
      if (entries.some(function (e) { return e.isIntersecting; })) { io.disconnect(); seen(); }
    });
    io.observe(panel);
  })();

  // The figure a chip shows: the browser's measurement when there is one, else the server's
  // estimate, else null. { ms, via, measured, leg (viewer→server, measured only) }.
  function latencyFor(r) {
    if (r.status === 'offline') return null;
    var url = probeUrlFor(r);
    var leg = url ? measuredByUrl[url] : null;
    if (typeof leg === 'number') {
      if (r.is_hub === true) return { ms: leg, via: 'direct', measured: true, leg: leg };
      // Without its link home a gateway's figure is the misleading viewer→gateway-only number.
      if (typeof r.hub_rtt_ms === 'number' && isFinite(r.hub_rtt_ms) && r.hub_rtt_ms >= 0) {
        return { ms: leg + r.hub_rtt_ms, via: 'gateway', measured: true, leg: leg };
      }
    }
    var s = suggestion && suggestion.byRegion[r.region];
    return s ? { ms: s.est_ms, via: s.via, measured: false } : null;
  }

  // Recommended region for this payload. With at least one measurement: re-rank everything shown
  // (measured where possible, estimated elsewhere) by the shared rule. Estimates only: the
  // server's pick, while it is still published and not offline.
  function recommendedKey(regions) {
    var rows = [];
    var measured = false;
    regions.forEach(function (r) {
      var l = latencyFor(r);
      if (!l) return;
      rows.push({ region: r.region, ms: l.ms, direct: r.is_hub === true });
      if (l.measured) measured = true;
    });
    if (measured) return pickRecommended(rows, latencyCfg.direct_bias_ms);
    return (suggestion && suggestion.recommended &&
      regions.some(function (r) { return r.region === suggestion.recommended && r.status !== 'offline'; }))
      ? suggestion.recommended : null;
  }

  // Latency figure + badge on one chip — the ONE place that writes them.
  function decorateRegionChip(sw, r, recKey, nearestKey) {
    var l = latencyFor(r);
    if (l) {
      var shown = Math.max(1, Math.round(l.ms));
      var ms = document.createElement('span');
      ms.className = l.measured ? 'rgn-ms' : 'rgn-ms is-est';
      ms.textContent = (l.measured ? '' : '~') + shown + ' ms';
      sw.appendChild(ms);
      sw.title += l.measured
        ? '\n' + shown + ' ms measured: ' + (l.via === 'direct'
          ? 'your browser to the pool'
          : 'your browser to this server (' + Math.max(1, Math.round(l.leg)) + ') + its link to the pool (' +
            Math.round(r.hub_rtt_ms) + ')')
        : '\n~' + shown + ' ms estimated: ' + (l.via === 'direct'
          ? 'your distance to the pool'
          : 'your distance to this server + its link to the pool');
    }
    if (r.region === recKey) {
      var rec = document.createElement('span');
      rec.className = 'rgn-rec';
      rec.textContent = 'Recommended';
      sw.appendChild(rec);
    } else if (r.region === nearestKey) {
      var pin = document.createElement('span');
      pin.className = 'rgn-pin';
      pin.title = 'Suggested for you';
      pin.textContent = '📍';
      sw.appendChild(pin);
    }
  }

  function selectRegion(regions, key) {
    var bank = $('rx-switches');
    if (bank) {
      bank.querySelectorAll('.rgn').forEach(function (sw) {
        var on = sw.dataset.region === key;
        sw.classList.toggle('sel', on);
        sw.setAttribute('aria-selected', on ? 'true' : 'false');
      });
    }
    var r = regions.filter(function (x) { return x.region === key; })[0];
    if (!r) return;
    var uri = regionStratumUri(r);
    setText('rx-uri', uri);
    setText('rx-guide-uri', uri);  // Pool 1 field in the collapsed miner-setup mock follows the selection
    setText('rx-meta',
      String(r.label || r.region).toUpperCase() +
      (r.country ? ' · ' + String(r.country).toUpperCase() : '') +
      ' · ' + statusWord(r.status) + ' · ' + (r.miners > 0 ? r.miners + ' MINERS' : 'NO MINERS') +
      ' · SAME PORT EVERY REGION');
  }

  // When the server reports regions still being liveness-checked, repaint sooner than the
  // 60s cycle so a grey LED settles into its real colour in seconds, not a minute. Bounded —
  // a region that can never get a verdict must not turn this into a poll loop.
  var checkingRetries = 0;
  var checkingTimer = null;

  async function loadRegions() {
    try {
      // Region list and branding are fetched CONCURRENTLY: branding only supplies the fallback
      // port/host, so making the patch bay wait on it just delayed first paint. The regions
      // endpoint itself never blocks on a liveness read server-side (handshake + stratum dial
      // are cached out of the request path), so this resolves as fast as the DB query.
      var fallbackP = (!BASE_PORT || !DEFAULT_URI) ? readBranding() : Promise.resolve(null);
      var regionsP = Auth.read('/api/pool/stats/regions');
      loadSuggestion();  // once per page load; re-renders the bay itself when it lands
      var b = await fallbackP;
      var conn = b && b.data && b.data.connection;
      if (conn) {
        BASE_PORT = conn.stratum_port || BASE_PORT;
        if (conn.stratum_host) DEFAULT_URI = conn.stratum_host + ':' + (conn.stratum_port || '3333');
      }
      var data = await regionsP;

      // Verdict still pending → re-poll in 4s (up to 5 times ≈ the server's 60s probe TTL).
      if (checkingTimer) { clearTimeout(checkingTimer); checkingTimer = null; }
      if (data && data.checking > 0 && checkingRetries < 5) {
        checkingRetries++;
        checkingTimer = setTimeout(loadRegions, 4000);
      } else if (!data || !data.checking) {
        checkingRetries = 0;
      }
      if (data) lastRegionsData = data;
      renderRegions(data);
    } catch (e) { /* keep whatever the patch bay currently shows */ }
  }

  // Paint the gateway lamps + patch bay from one /stats/regions payload. Called by loadRegions
  // and again when the connect suggestion or a measurement lands — idempotent, keeps the
  // selection. Then time any server not yet tried (a no-op until the panel has been seen).
  function renderRegions(data) {
    paintRegions(data);
    updateRetest();
    if (bayVisible) loadLatencyConfig();  // retries a failed branding read; a no-op once known
    maybeMeasure(false);
  }

  function paintRegions(data) {
    var bank = $('rx-switches');
    try {
      var regions = publishedRegions(data);

      // Gateway array (P-02b): one lamp per region, rebuilt each poll (capped at 8).
      var lampHost = $('an-regions');
      if (lampHost) {
        lampHost.textContent = '';
        if (regions.length === 0) {
          var empty = document.createElement('div');
          empty.className = 'gateways-empty';
          empty.textContent = 'NO REGIONS ONLINE';
          lampHost.appendChild(empty);
        }
        regions.slice(0, 8).forEach(function (r) {
          var lamp = document.createElement('div');
          var st = r.status === 'online' ? 'ok' : r.status === 'offline' ? 'alarm' : '';
          lamp.className = 'lamp' + (st ? ' ' + st : '');
          lamp.appendChild(document.createTextNode('REG ' + String(r.region || '').toUpperCase()));
          var small = document.createElement('small');
          // `miners` is null when the server withheld it under the k-anonymity floor
          // (audit §J11-5) — that is NOT zero, and rendering it as 'idle' would contradict
          // the 'online' lamp beside it and re-create §J5-4's suppressed-reads-as-real bug.
          // "<N miners" states exactly what the null already discloses (0 < n < N) and no more
          // — `workers` is withheld with it (one person's rig count), so no worker figure there.
          // "2 miners / 5 workers": miners = distinct addresses, workers = distinct rigs.
          small.textContent = r.status === 'offline' ? 'offline'
            : r.status === 'checking' ? 'checking'
            : r.below_floor ? '<' + (data.min_bucket || 3) + ' miners'
            : (r.miners > 0
                ? r.miners + (r.miners === 1 ? ' miner' : ' miners') +
                  (r.workers > 0 ? ' / ' + r.workers + (r.workers === 1 ? ' worker' : ' workers') : '')
                : 'idle');
          lamp.appendChild(small);
          lampHost.appendChild(lamp);
        });
      }
      setText('mi-regions', regions.length + (regions.length === 1 ? ' REGION' : ' REGIONS') +
        (BASE_PORT ? ' · :' + BASE_PORT : ''));

      // Spec-plate "active regions" = declared regions VERIFIED reachable (idle counts — a
      // gateway that's up but momentarily miner-less is still available to connect; 'checking'
      // does not, it isn't confirmed yet and resolves within seconds). A single-endpoint pool
      // (no declared regions) reports its one endpoint as active.
      var activeRegions = regions.length === 0
        ? (DEFAULT_URI ? 1 : 0)
        : regions.filter(function (r) { return r.status === 'online' || r.status === 'idle'; }).length;
      setText('pl-regions', String(activeRegions));

      var help = $('rx-help');  // collapsed colour-legend + guidance disclosure
      if (!bank) return;
      if (regions.length === 0) {
        // No declared regions: hide the switch bank, show the operator's configured host.
        bank.style.display = 'none';
        if (help) help.hidden = true;
        if (DEFAULT_URI) { setText('rx-uri', DEFAULT_URI); setText('rx-guide-uri', DEFAULT_URI); }
        setText('rx-meta', 'SINGLE ENDPOINT · CUCKATOO32');
        return;
      }
      bank.style.display = '';
      if (help) help.hidden = false;

      // The Recommended region (measured, else estimated — recommendedKey) when there is one, else
      // the timezone fallback — which gets the 📍 pin, never the badge: it is a guess, not an
      // estimate. Judged against THIS payload: a region that has since gone offline (or been
      // withdrawn) loses the badge rather than steering a rig at it.
      var recKey = recommendedKey(regions);
      var nearestKey = recKey ? null : detectNearestRegion(regions);
      var firstKey = recKey || nearestKey;
      // Suggested region first, then most miners, then name.
      regions.sort(function (a, b2) {
        if (a.region === firstKey) return -1;
        if (b2.region === firstKey) return 1;
        // A floor-suppressed region (§J11-5) has 1-2 miners, not 0 — count it as 1 so it does
        // not sort below a genuinely empty gateway.
        var mA = a.miners != null ? a.miners : (a.below_floor ? 1 : 0);
        var mB = b2.miners != null ? b2.miners : (b2.below_floor ? 1 : 0);
        if (mB !== mA) return mB - mA;
        return (a.label || a.region).localeCompare(b2.label || b2.region);
      });

      // Preserve the current selection across the 60s refresh. Until the visitor clicks a chip,
      // the Recommended region takes it (it may land after the first paint).
      var prev = bank.querySelector('.rgn.sel');
      var selectedKey = prev ? prev.dataset.region : null;
      if (recKey && !userPickedRegion) selectedKey = recKey;
      if (!selectedKey || !regions.some(function (r) { return r.region === selectedKey; })) {
        selectedKey = regions[0].region;
      }

      bank.textContent = '';
      regions.forEach(function (r) {
        var sw = document.createElement('button');
        sw.type = 'button';
        sw.className = 'rgn ' + statusCls(r.status) + (r.region === selectedKey ? ' sel' : '');
        sw.dataset.region = r.region;
        sw.setAttribute('role', 'tab');
        sw.setAttribute('aria-selected', r.region === selectedKey ? 'true' : 'false');
        sw.title = (r.label || r.region) + (r.country ? ' · ' + r.country : '') +
          ' — ' + statusTitle(r.status);
        var led = document.createElement('span');
        led.className = 'rgn-led';
        var name = document.createElement('span');
        name.className = 'rgn-name';
        name.textContent = String(r.region || '').toUpperCase();
        sw.appendChild(led);
        sw.appendChild(name);
        decorateRegionChip(sw, r, recKey, nearestKey);
        sw.addEventListener('click', function () {
          userPickedRegion = true;
          selectRegion(regions, r.region);
        });
        bank.appendChild(sw);
      });
      selectRegion(regions, selectedKey);
    } catch (e) { /* keep whatever the patch bay currently shows */ }
  }

  // Copy the selected stratum URI.
  (function wireCopy() {
    var btn = $('rx-copy');
    if (!btn) return;
    btn.addEventListener('click', function () {
      var code = $('rx-uri');
      var val = code && code.textContent.trim();
      if (!val) return;
      var done = function () {
        btn.textContent = 'COPIED';
        setTimeout(function () { btn.textContent = 'Copy'; }, 1400);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(val).then(done, done);
      } else { done(); }
    });
  })();

  // Contact rows in the procedures panel (branding.js fills text/href; this
  // toggles row visibility — same behaviour as the previous dashboard).
  async function loadInfoContact() {
    try {
      var r = await fetch('/api/public/branding', { credentials: 'same-origin' });
      var json = r.ok ? await r.json() : null;
      var data = (json && json.data) ? json.data : {};
      var enc = data.pool && data.pool.contact_email_enc;
      var email = '';
      try { email = enc ? atob(enc) : ''; } catch (e) { email = ''; }
      var forum = (data.pool && data.pool.support_forum_url) || '';
      // data.branding.social is not read here: branding.js owns the social rows.
      if (email) { var li = $('info-email'); if (li) li.style.display = ''; }
      if (forum) {
        var fli = $('info-forum'), fa = $('info-forum-link');
        if (fa) fa.setAttribute('href', forum);
        if (fli) fli.style.display = '';
      }
      // The "no contact channels configured" row is gone (it was an admin instruction on a
      // public page), so there is nothing left to toggle off when contacts DO exist — each
      // row above reveals itself, and P-08 simply carries no contact lines otherwise.
    } catch (e) { /* leave every contact row hidden — better silent than half-filled */ }
  }

  // ── theme switch → re-render canvas instruments in the new palette ────────
  new MutationObserver(function () {
    readTokens();
    // The dial BANDS (gradient sweep / effort zones) are baked colour stops, not tokens read
    // at draw time — render() alone repaints the needle and numerals in the new palette but
    // leaves the band on the old accent, so a Reactor→light switch left a phosphor-green
    // sweep on a white dial until the next 60s refresh happened to re-apply it. Re-derive
    // them here; the effort zones keep whatever scale the last refresh set.
    applyHashState();  // idle needle holds a colour value too — re-pick it from the new C.warn
    if (gaugeHash) { gaugeHash.setGradient(HASH_GRAD()); gaugeHash.render(); }
    if (gaugeShare) {
      gaugeShare.setScale(gaugeShare.min, gaugeShare.max, gaugeShare.unit,
        [[0, 100, C.accent], [100, 150, C.warn], [150, gaugeShare.max, C.danger]], 8);
      gaugeShare.render();
    }
    // Trend charts re-read the theme accent on their update path — refresh redraws them.
    loadTrendCharts();
  }).observe(document.body, { attributes: true, attributeFilter: ['class'] });

  // ── refresh cycle ─────────────────────────────────────────────────────────
  async function refresh() {
    // Kicked BEFORE the awaited loadStatus: the patch bay is the one panel a visitor came
    // here to act on, and it has no dependency on nodeHeight — queueing it behind the status
    // round trip only delayed the switches appearing.
    loadRegions();
    await loadStatus();   // first: nodeHeight feeds the fuel-rod depths
    loadPoolInfo();
    loadHashrate();
    loadStats();
    loadShare();
    loadBlocks();
    loadPayments();
    loadTrendCharts();
  }

  function boot() { refresh(); loadInfoContact(); }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
  setInterval(refresh, 60000);
})();
