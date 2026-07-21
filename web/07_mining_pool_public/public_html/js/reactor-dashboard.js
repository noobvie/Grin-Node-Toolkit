/* reactor-dashboard.js — homepage "Reactor Control" instrument wiring.
 *
 * Drives the control-panel deck in index.html from the public endpoints
 * (no auth; Auth.fetch returns parsed JSON or null):
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
 *   /api/public/branding       default stratum host/port fallback
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
  }
  readTokens();

  // ── small helpers ─────────────────────────────────────────────────────────
  function $(id) { return document.getElementById(id); }
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
      c.strokeStyle = 'rgba(0,0,0,.45)'; c.lineWidth = 30; c.stroke();
      // colored zones
      g.zones.forEach(function (z) {
        c.beginPath();
        c.arc(cx, cy, R + 7, A((z[0] - g.min) / (g.max - g.min)), A((z[1] - g.min) / (g.max - g.min)));
        c.strokeStyle = z[2]; c.globalAlpha = 0.5; c.lineWidth = 4; c.stroke();
        c.globalAlpha = 1;
      });
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
      // needle
      var na = A(g.cur);
      c.save();
      c.shadowColor = C.accent; c.shadowBlur = 8;
      c.strokeStyle = C.accent; c.lineWidth = 2.4; c.lineCap = 'round';
      c.beginPath();
      c.moveTo(cx - Math.cos(na) * 10, cy - Math.sin(na) * 10);
      c.lineTo(cx + Math.cos(na) * (R - 14), cy + Math.sin(na) * (R - 14));
      c.stroke();
      c.restore();
      // hub + unit
      c.beginPath(); c.arc(cx, cy, 5, 0, 7); c.fillStyle = C.mute; c.fill();
      c.beginPath(); c.arc(cx, cy, 2, 0, 7); c.fillStyle = C.accent; c.fill();
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
  // Round effort — current round's Σ share-diff / one block's network diff, live. <100% =
  // nominal (green), 100–150% = running long (amber), >150% = overdue/unlucky (red). The
  // big numeral carries the true %; luck (100-block) + network share ride the sub-line.
  var gaugeShare = Gauge('g-share', { min: 0, max: 200, ticks: 8, unit: '%' });

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
    // HIGH STALE annunciator: lit when stale+rejected exceed 5% of live shares.
    var bad = total > 0 && ((stl + rej) / total) > 0.05;
    setLamp('an-stale', bad ? 'warn' : '', bad ? '> 5%' : '< 5%');
  }

  // ── annunciator ───────────────────────────────────────────────────────────
  function setLamp(id, state, subText) {
    var el = $(id);
    if (!el) return;
    el.className = 'lamp' + (state ? ' ' + state : '');
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
      var info = await Auth.fetch('/api/config/pool-info');
      if (!info) return;
      setText('pl-fee', (info.pool_fee_percent != null ? info.pool_fee_percent : 0).toFixed(1) + '%');
      setText('pl-min', (info.min_withdrawal != null ? info.min_withdrawal : 0).toFixed(1) + ' GRIN');
      setText('pl-net', String(info.network || '—').toUpperCase());
    } catch (e) { /* placard keeps placeholders */ }
  }

  async function loadHashrate() {
    try {
      var hr = await Auth.fetch('/api/stratum/hashrate');
      if (!hr) return;
      var gps = hr.pool_hashrate_1h_gps || 0;
      var g1 = fmtGps(gps);
      setText('g-hash-v', g1[0] + ' ' + g1[1]);
      var g24 = fmtGps(hr.pool_hashrate_24h_gps || 0);
      setText('g-hash-avg', '24h avg ' + g24[0] + ' ' + g24[1]);
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
        // Higher hashrate is good → one accent sweep, no red danger band at the top.
        gaugeHash.setScale(0, max, unit, [[0, max, C.accent]], 8);
        gaugeHash.setMarker(peak > 0 ? peak : null);
        gaugeHash.setValue(val);
      }
    } catch (e) { /* gauge keeps last position */ }
  }

  async function loadStats() {
    try {
      var s = await Auth.fetch('/api/pool/stats');
      if (!s) return;
      setText('c-miners', String(s.active_miners || 0));
      setText('c-miners-sub', (s.active_connections || 0) + ' conn');
      setText('c-blocks24', String(s.blocks_24h || 0));
      setText('c-blocks24-sub', (s.blocks_7d || 0) + ' wk');
      setText('c-total', Number(s.total_blocks_found || 0).toLocaleString('en-US'));
      setText('c-reward', Number(s.confirmed_reward || 0).toFixed(0));
      setText('mi-miners', (s.active_miners || 0) + ' UNITS');
      var q = s.share_quality || {};
      renderLedbar(Number(q.accepted) || 0, Number(q.stale) || 0, Number(q.rejected) || 0);
    } catch (e) { /* counters keep placeholders */ }
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
      var e = await Auth.fetch('/api/pool/effort');
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
      setText('g-share-luck',
        (e.luck_100_pct != null ? 'luck ' + e.luck_100_pct.toFixed(0) + '%' : 'luck —') +
        ' · ' + (share != null ? 'share ' + fmtShare(share) : 'share —'));
      if (gaugeShare) {
        // Stable 0–200% dial (bumps if a very unlucky round runs past it). Zones:
        // 0–100 nominal, 100–150 running long, 150→top overdue.
        var emax = Math.max(200, niceCeil(effort * 1.1));
        gaugeShare.setScale(0, emax, '%',
          [[0, 100, C.accent], [100, 150, C.warn], [150, emax, C.danger]], 8);
        gaugeShare.setValue(Math.min(effort, emax));
      }
      setText('c-last', e.last_block_at ? timeAgo(e.last_block_at) : '—');
      setText('mi-core-share', 'NET-SHARE ' + (share != null ? fmtShare(share) : '—'));
      setText('mi-core-shares', e.round_shares != null
        ? Number(e.round_shares).toLocaleString('en-US', { maximumFractionDigits: 0 }) + ' SHARES'
        : '— SHARES');
    } catch (err) { /* gauge keeps last position */ }
  }

  async function loadStatus() {
    try {
      var s = await Auth.fetch('/api/pool/status');
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

  // Fuel rods: one column per recent block; fill = confirmation depth / 1440.
  async function loadBlocks() {
    var wrap = $('rx-rods');
    if (!wrap) return;
    try {
      var blocks = await Auth.fetch('/api/pool/blocks?limit=8');
      wrap.textContent = '';
      if (!Array.isArray(blocks) || blocks.length === 0) {
        var d = document.createElement('div');
        d.className = 'rods-empty';
        d.textContent = 'NO BLOCKS FOUND YET';
        wrap.appendChild(d);
        setLamp('an-orphan', '', 'none');
        return;
      }
      // Height counter fallback: with the node unreachable, show the newest pool block.
      if (!nodeHeight && blocks[0] && blocks[0].height) {
        setHeightLink('c-height', blocks[0].height);
      }
      var anyOrphan = false;
      blocks.forEach(function (b) {
        var height = Number(b.height || 0);
        var conf;
        if (b.status === 'confirmed') conf = 1440;
        else if (nodeHeight && height) conf = Math.max(0, Math.min(1440, nodeHeight - height));
        else conf = Math.max(0, Math.min(1440, Math.floor((Date.now() / 1000 - (b.found_at || b.created_at || 0)) / 60)));
        var orphan = b.status === 'orphaned';
        if (orphan) anyOrphan = true;
        var mature = b.status === 'confirmed';

        var rod = document.createElement('div');
        rod.className = 'rod' + (mature ? ' done' : '') + (orphan ? ' orphan' : '');
        var tube = document.createElement('div');
        tube.className = 'tube';
        var fill = document.createElement('div');
        fill.className = 'fill';
        fill.style.height = Math.max(3, Math.round(100 * (orphan ? 1 : conf) / 1440)) + '%';
        if (orphan) fill.style.height = '100%';
        tube.appendChild(fill);
        var h = document.createElement('div');
        h.className = 'h';
        var hLabel = '#' + height.toLocaleString('en-US');
        // Link the block height out to a chain explorer (new tab) as independent proof.
        if (height && window.Explorer) h.innerHTML = Explorer.link('block', height, hLabel);
        else h.textContent = hLabel;
        var m = document.createElement('div');
        m.className = 'm';
        m.textContent = orphan ? 'ORPHAN' : (mature ? 'MATURE' : conf + '/1440');
        var when = document.createElement('div');
        when.className = 'm';
        when.textContent = timeAgo(b.found_at || b.created_at) + ' · ' + Number(b.reward || 0).toFixed(1);
        rod.appendChild(tube); rod.appendChild(h); rod.appendChild(m); rod.appendChild(when);
        rod.title = 'Block ' + height.toLocaleString('en-US') + ' · ' + (b.status || 'immature') +
          ' · reward ' + Number(b.reward || 0).toFixed(2) + ' GRIN';
        wrap.appendChild(rod);
      });
      setLamp('an-orphan', anyOrphan ? 'alarm' : '', anyOrphan ? 'detected' : 'none');
    } catch (e) {
      wrap.textContent = '';
      var d2 = document.createElement('div');
      d2.className = 'rods-empty';
      d2.textContent = 'BLOCK DATA UNAVAILABLE';
      wrap.appendChild(d2);
    }
  }

  // Payout teletype (addresses are miner-supplied → textContent only).
  async function loadPayments() {
    var tty = $('rx-tty');
    if (!tty) return;
    try {
      var payments = await Auth.fetch('/api/pool/payments?limit=7');
      tty.textContent = '';
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
        via.textContent = '[TOR OK]';
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
      var data = await Auth.fetch('/api/pool/hashrate/history?hours=24');
      fine = (data && data.series) || [];
      hashPeakGps = fine.reduce(function (m, p) { return Math.max(m, Number(p.gps) || 0); }, 0);
    } catch (e) { /* keep last peak / trace */ }

    // Durable hourly/daily rollup for the selected range (pool 7D/30D + network line).
    var points = [], bucket = 3600;
    try {
      var m = await Auth.fetch('/api/pool/metrics/history?range=' + chartRange);
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
    // The public regions API emits 'online' | 'idle' | 'offline'. online = tunnel up + active
    // miners (green); idle = tunnel up, no recent miners — fine to connect (amber); offline =
    // WireGuard tunnel down / never handshaked, don't bother (red). Backed by the gateway
    // handshake signal server-side, so 'offline' is a real "down", not a guess.
    return s === 'online' ? 's-online' : s === 'offline' ? 's-down' : 's-idle';
  }

  // Best-effort nearest region from the browser IANA timezone (no geo-IP; same
  // heuristic the previous dashboard used).
  function detectNearestRegion(keys) {
    var tz = '';
    try { tz = (Intl.DateTimeFormat().resolvedOptions().timeZone) || ''; } catch (e) { return null; }
    if (!tz) return null;
    var has = function (k) { return keys.indexOf(k) !== -1 ? k : null; };
    var exact = {
      'Asia/Ho_Chi_Minh': 'sgn', 'America/New_York': 'nyc',
      'America/Los_Angeles': 'lax', 'America/Toronto': 'yyz',
      'Europe/Amsterdam': 'ams'
    };
    if (exact[tz] && has(exact[tz])) return exact[tz];
    if (tz === 'Asia/Ho_Chi_Minh' && has('han')) return 'han';
    var area = tz.split('/')[0];
    if (area === 'America') {
      if (/Los_Angeles|Vancouver|Tijuana|Phoenix|Denver|Edmonton|Boise|Anchorage|Whitehorse|Dawson|Mazatlan/.test(tz)) return has('lax') || has('nyc') || has('yyz');
      if (/Toronto|Montreal|Halifax|Winnipeg|Regina|St_Johns/.test(tz)) return has('yyz') || has('nyc');
      return has('nyc') || has('yyz') || has('lax');
    }
    if (area === 'Asia' || area === 'Australia' || area === 'Indian') return has('han') || has('sgn');
    var pref = { Pacific: 'lax', Europe: 'ams', Africa: 'ams', Atlantic: 'ams', Antarctica: 'lax' };
    return pref[area] ? has(pref[area]) : null;
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
    var m = r.status === 'online' ? '● ONLINE' : r.status === 'offline' ? '● OFFLINE' : '○ IDLE';
    setText('rx-meta',
      String(r.label || r.region).toUpperCase() +
      (r.country ? ' · ' + String(r.country).toUpperCase() : '') +
      ' · ' + m + ' · ' + (r.miners > 0 ? r.miners + ' MINERS' : 'NO MINERS') +
      ' · SAME PORT EVERY REGION');
  }

  async function loadRegions() {
    var bank = $('rx-switches');
    try {
      if (!BASE_PORT || !DEFAULT_URI) {
        try {
          var b = await Auth.fetch('/api/public/branding');
          var conn = b && b.data && b.data.connection;
          if (conn) {
            BASE_PORT = conn.stratum_port || BASE_PORT;
            if (conn.stratum_host) DEFAULT_URI = conn.stratum_host + ':' + (conn.stratum_port || '3333');
          }
        } catch (e) { /* fall back to 3333 */ }
      }
      var data = await Auth.fetch('/api/pool/stats/regions');
      var regions = (data && Array.isArray(data.regions)) ? data.regions : [];
      regions = regions.filter(function (r) { return r.stratum_url && r.is_active !== false; });

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
          small.textContent = r.status === 'offline' ? 'offline'
            : (r.miners > 0 ? r.miners + (r.miners === 1 ? ' miner' : ' miners') : 'idle');
          lamp.appendChild(small);
          lampHost.appendChild(lamp);
        });
      }
      setText('mi-regions', regions.length + (regions.length === 1 ? ' REGION' : ' REGIONS') +
        (BASE_PORT ? ' · :' + BASE_PORT : ''));

      // Spec-plate "active regions" = declared regions that aren't offline (idle counts —
      // a tunnel that's up but momentarily miner-less is still available to connect). A
      // single-endpoint pool (no declared regions) reports its one endpoint as active.
      var activeRegions = regions.length === 0
        ? (DEFAULT_URI ? 1 : 0)
        : regions.filter(function (r) { return r.status !== 'offline'; }).length;
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

      // Nearest region first, then most miners, then name — same order as before.
      var nearestKey = detectNearestRegion(regions.map(function (r) { return r.region; }));
      regions.sort(function (a, b2) {
        if (a.region === nearestKey) return -1;
        if (b2.region === nearestKey) return 1;
        if ((b2.miners || 0) !== (a.miners || 0)) return (b2.miners || 0) - (a.miners || 0);
        return (a.label || a.region).localeCompare(b2.label || b2.region);
      });

      // Preserve the visitor's current selection across the 60s refresh.
      var prev = bank.querySelector('.rgn.sel');
      var selectedKey = prev ? prev.dataset.region : null;
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
          ' — ' + (r.status === 'online' ? 'online — miners active'
            : r.status === 'offline' ? 'offline — gateway unreachable'
            : 'idle — no recent miners');
        var led = document.createElement('span');
        led.className = 'rgn-led';
        var name = document.createElement('span');
        name.className = 'rgn-name';
        name.textContent = String(r.region || '').toUpperCase();
        sw.appendChild(led);
        sw.appendChild(name);
        if (r.region === nearestKey) {
          var pin = document.createElement('span');
          pin.className = 'rgn-pin';
          pin.title = 'Nearest to you';
          pin.textContent = '📍';
          sw.appendChild(pin);
        }
        sw.addEventListener('click', function () { selectRegion(regions, r.region); });
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
      var social = (data.branding && data.branding.social) || {};
      if (email) { var li = $('info-email'); if (li) li.style.display = ''; }
      if (forum) {
        var fli = $('info-forum'), fa = $('info-forum-link');
        if (fa) fa.setAttribute('href', forum);
        if (fli) fli.style.display = '';
      }
      // Keys must match the P-08 rows in index.html — 'website' is deliberately not one of
      // them (self-referential), so counting it here would hide the note with no row shown.
      var any = email || forum || ['discord', 'telegram', 'twitter', 'nostr'].some(function (k) { return social[k]; });
      if (any) { var note = $('info-no-contact'); if (note) note.style.display = 'none'; }
    } catch (e) { /* keep the operator note */ }
  }

  // ── theme switch → re-render canvas instruments in the new palette ────────
  new MutationObserver(function () {
    readTokens();
    if (gaugeHash) gaugeHash.render();
    if (gaugeShare) gaugeShare.render();
    // Trend charts re-read the theme accent on their update path — refresh redraws them.
    loadTrendCharts();
  }).observe(document.body, { attributes: true, attributeFilter: ['class'] });

  // ── refresh cycle ─────────────────────────────────────────────────────────
  async function refresh() {
    await loadStatus();   // first: nodeHeight feeds the fuel-rod depths
    loadPoolInfo();
    loadHashrate();
    loadStats();
    loadShare();
    loadBlocks();
    loadPayments();
    loadTrendCharts();
    loadRegions();
  }

  function boot() { refresh(); loadInfoContact(); }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
  setInterval(refresh, 60000);
})();
