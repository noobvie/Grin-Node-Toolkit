/* reactor-dashboard.js — homepage "Reactor Control" instrument wiring.
 *
 * Drives the control-panel deck in index.html from the public endpoints
 * (no auth; Auth.fetch returns parsed JSON or null):
 *   /api/pool/stats            miners / blocks / rewards / share_quality
 *   /api/stratum/hashrate      pool GPS aggregates (hashrate gauge)
 *   /api/config/pool-info      fee / min payout / network (spec placard)
 *   /api/pool/effort           round effort / luck / round shares (effort gauge)
 *   /api/pool/status           pool+node+wallet health (annunciator, master lamp)
 *   /api/pool/blocks           fuel-rod maturity array
 *   /api/pool/payments         payout teletype
 *   /api/pool/stats/regions    patch-bay switches + region lamps
 *   /api/pool/hashrate/history strip-chart recorder
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
    var c = cv.getContext('2d');
    c.scale(dpr, dpr);

    var g = {
      min: 0, max: 1, ticks: 8, unit: '', zones: [],
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
    g.setValue = function (v) {
      g.target = (v - g.min) / (g.max - g.min || 1);
      if (REDUCED) { g.cur = g.target; render(); }
      else if (!g.running) { g.running = true; requestAnimationFrame(loop); }
    };
    g.render = render;
    render();
    return g;
  }

  var gaugeHash = Gauge('g-hash', { min: 0, max: 2, ticks: 8, unit: 'kG/s' });
  var gaugeEffort = Gauge('g-effort', { min: 0, max: 150, ticks: 6, unit: '%' });
  function effortZones() {
    return [[0, 100, C.accent], [100, 130, C.warn], [130, 150, C.danger]];
  }
  if (gaugeEffort) gaugeEffort.setScale(0, 150, '%', effortZones(), 6);

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

  // ── strip-chart recorder ──────────────────────────────────────────────────
  var chart = (function () {
    var cv = $('rx-chart'), tip = $('rx-tip'), empty = $('rx-chart-empty');
    if (!cv) return { setSeries: function () {}, render: function () {} };
    var c, W, H, series = [];
    var padL = 46, padB = 20, padT = 8, padR = 10;
    var lo = 0, hi = 1, gridVals = [];

    function fit() {
      var dpr = window.devicePixelRatio || 1;
      var r = cv.getBoundingClientRect();
      W = r.width; H = r.height;
      cv.width = W * dpr; cv.height = H * dpr;
      c = cv.getContext('2d');
      c.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    fit();

    function X(i) { return padL + i * (W - padL - padR) / Math.max(series.length - 1, 1); }
    function Y(v) { return padT + (hi - v) * (H - padT - padB) / (hi - lo || 1); }
    function gpsLabel(v) {
      var f = fmtGps(v);
      return f[0] + (f[1] ? ' ' + f[1] : '');
    }

    function computeScale() {
      var vals = series.map(function (p) { return Number(p.gps) || 0; });
      var mn = Math.min.apply(null, vals), mx = Math.max.apply(null, vals);
      if (!isFinite(mn) || !isFinite(mx)) { lo = 0; hi = 1; gridVals = []; return; }
      if (mx <= 0) { lo = 0; hi = 1; }
      else {
        hi = niceCeil(mx * 1.08);
        lo = Math.max(0, mn - (hi - mn) * 0.15);
        lo = Math.floor(lo / (hi / 4)) * (hi / 4);
      }
      gridVals = [];
      for (var i = 0; i <= 4; i++) gridVals.push(lo + (hi - lo) * i / 4);
    }

    function render(hidx) {
      if (!c) return;
      c.clearRect(0, 0, W, H);
      if (!series.length) { if (empty) empty.style.display = 'flex'; return; }
      if (empty) empty.style.display = 'none';
      // graph paper
      var fine = 18;
      c.strokeStyle = 'rgba(127,160,127,.07)';
      c.lineWidth = 1;
      for (var gx = padL; gx <= W - padR; gx += fine) { c.beginPath(); c.moveTo(gx, padT); c.lineTo(gx, H - padB); c.stroke(); }
      for (var gy = padT; gy <= H - padB; gy += fine) { c.beginPath(); c.moveTo(padL, gy); c.lineTo(W - padR, gy); c.stroke(); }
      c.font = '10px ' + MONO;
      gridVals.forEach(function (v) {
        c.strokeStyle = 'rgba(127,160,127,.16)';
        c.beginPath(); c.moveTo(padL, Y(v)); c.lineTo(W - padR, Y(v)); c.stroke();
        c.fillStyle = C.mute; c.textAlign = 'right'; c.textBaseline = 'middle';
        c.fillText(gpsLabel(v), padL - 6, Y(v));
      });
      // x time labels at 5 anchors
      c.textAlign = 'center'; c.textBaseline = 'alphabetic';
      [0, 0.25, 0.5, 0.75, 1].forEach(function (f) {
        var i = Math.round(f * (series.length - 1));
        var d = new Date((series[i].t || 0) * 1000);
        c.fillStyle = C.mute;
        c.fillText(pad2(d.getHours()) + ':' + pad2(d.getMinutes()), X(i), H - 5);
      });
      // phosphor trace
      c.save();
      c.shadowColor = C.accent; c.shadowBlur = 6;
      c.beginPath();
      series.forEach(function (p, i) {
        var y = Y(Number(p.gps) || 0);
        if (i) c.lineTo(X(i), y); else c.moveTo(X(i), y);
      });
      c.strokeStyle = C.accent; c.lineWidth = 1.8; c.lineJoin = 'round'; c.stroke();
      c.restore();
      var li = series.length - 1;
      c.beginPath(); c.arc(X(li), Y(Number(series[li].gps) || 0), 3, 0, 7);
      c.fillStyle = C.accent; c.fill();
      // hover crosshair
      if (hidx != null && series[hidx]) {
        var hx = X(hidx), hy = Y(Number(series[hidx].gps) || 0);
        c.strokeStyle = C.dim; c.lineWidth = 1; c.setLineDash([2, 3]);
        c.beginPath(); c.moveTo(hx, padT); c.lineTo(hx, H - padB); c.stroke();
        c.setLineDash([]);
        c.beginPath(); c.arc(hx, hy, 4, 0, 7); c.fillStyle = C.accent; c.fill();
        c.beginPath(); c.arc(hx, hy, 4, 0, 7); c.strokeStyle = C.bg; c.lineWidth = 2; c.stroke();
      }
    }

    cv.addEventListener('pointermove', function (e) {
      if (!series.length || !tip) return;
      var r = cv.getBoundingClientRect();
      var i = Math.round((e.clientX - r.left - padL) / ((W - padL - padR) / Math.max(series.length - 1, 1)));
      if (i < 0 || i >= series.length) { tip.style.display = 'none'; render(null); return; }
      render(i);
      var d = new Date((series[i].t || 0) * 1000);
      tip.textContent = '';
      var t = document.createElement('span');
      t.className = 't';
      t.textContent = pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ' ';
      tip.appendChild(t);
      tip.appendChild(document.createTextNode(gpsLabel(Number(series[i].gps) || 0)));
      tip.style.display = 'block';
      var tx = X(i) + 12;
      if (tx > W - 130) tx = X(i) - tip.offsetWidth - 12;
      tip.style.left = tx + 'px';
      tip.style.top = (Y(Number(series[i].gps) || 0) - 14) + 'px';
    });
    cv.addEventListener('pointerleave', function () {
      if (tip) tip.style.display = 'none';
      render(null);
    });
    window.addEventListener('resize', function () { fit(); render(null); });

    return {
      setSeries: function (s) { series = Array.isArray(s) ? s : []; computeScale(); render(null); },
      render: function () { render(null); }
    };
  })();

  // ── data loaders ──────────────────────────────────────────────────────────
  var nodeHeight = 0;      // for fuel-rod confirmation depth
  var BASE_PORT = '';      // pool default stratum port (regions may omit one)
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
        // Dial floor keeps an idle pool's scale sane (100 G/s or 1 kG/s minimum).
        var max = niceCeil(Math.max(val * 1.25, unit === 'G/s' ? 100 : 1));
        gaugeHash.setScale(0, max, unit, [[0, max, C.accent]], 8);
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

  async function loadEffort() {
    try {
      var e = await Auth.fetch('/api/pool/effort');
      if (!e) return;
      var eff = e.round_effort_pct;
      setText('g-effort-v', eff != null ? eff.toFixed(0) + '%' : '—');
      setText('g-effort-luck', e.luck_100_pct != null
        ? 'luck ' + e.luck_100_pct.toFixed(0) + '% · ' + (e.luck_sample || 0) + ' blk'
        : 'luck — · no data yet');
      if (gaugeEffort) {
        gaugeEffort.setScale(0, 150, '%', effortZones(), 6);
        gaugeEffort.setValue(eff != null ? Math.min(eff, 150) : 0);
      }
      setText('c-last', e.last_block_at ? timeAgo(e.last_block_at) : '—');
      setText('mi-core-effort', 'EFFORT ' + (eff != null ? eff.toFixed(0) + '%' : '—'));
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

      if (nodeHeight) setText('c-height', Number(nodeHeight).toLocaleString('en-US'));
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
        setText('c-height', Number(blocks[0].height).toLocaleString('en-US'));
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
        h.textContent = '#' + height.toLocaleString('en-US');
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
        return;
      }
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
    }
  }

  async function loadHistory() {
    try {
      var data = await Auth.fetch('/api/pool/hashrate/history?hours=24');
      chart.setSeries((data && data.series) || []);
    } catch (e) { /* chart keeps last trace */ }
  }

  // ── region patch bay + region annunciator lamps ───────────────────────────
  function regionHostPort(r) {
    var parts = String(r.stratum_url || '').split(':');
    return parts[0] + ':' + (parts[1] || BASE_PORT || '3333');
  }
  function regionStratumUri(r) { return 'stratum+tcp://' + regionHostPort(r); }
  function statusCls(s) {
    return s === 'online' ? 's-online' : s === 'stale' ? 's-stale' : s === 'offline' ? 's-offline' : 's-unknown';
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
      bank.querySelectorAll('.switch').forEach(function (sw) {
        var on = sw.dataset.region === key;
        sw.classList.toggle('on', on);
        sw.setAttribute('aria-selected', on ? 'true' : 'false');
      });
    }
    var r = regions.filter(function (x) { return x.region === key; })[0];
    if (!r) return;
    var uri = regionStratumUri(r);
    setText('rx-uri', uri);
    var m = r.status === 'online' ? '● ONLINE' : r.status === 'stale' ? '● DEGRADED' : r.status === 'offline' ? '● OFFLINE' : '○ UNKNOWN';
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
            if (conn.stratum_host) DEFAULT_URI = 'stratum+tcp://' + conn.stratum_host + ':' + (conn.stratum_port || '3333');
          }
        } catch (e) { /* fall back to 3333 */ }
      }
      var data = await Auth.fetch('/api/pool/stats/regions');
      var regions = (data && Array.isArray(data.regions)) ? data.regions : [];
      regions = regions.filter(function (r) { return r.stratum_url && r.is_active !== false; });

      // Region lamps in the annunciator (rebuilt on each poll, capped at 6).
      var lampHost = $('an-regions');
      if (lampHost) {
        lampHost.textContent = '';
        regions.slice(0, 6).forEach(function (r) {
          var lamp = document.createElement('div');
          var st = r.status === 'online' ? 'ok' : r.status === 'stale' ? 'warn' : r.status === 'offline' ? 'alarm' : '';
          lamp.className = 'lamp' + (st ? ' ' + st : '');
          lamp.appendChild(document.createTextNode('REG ' + String(r.region || '').toUpperCase()));
          var small = document.createElement('small');
          small.textContent = r.status === 'offline' ? 'offline'
            : r.status === 'stale' ? 'degraded'
            : (r.miners > 0 ? r.miners + (r.miners === 1 ? ' miner' : ' miners') : 'idle');
          lamp.appendChild(small);
          lampHost.appendChild(lamp);
        });
      }
      setText('mi-regions', regions.length + (regions.length === 1 ? ' REGION' : ' REGIONS') +
        (BASE_PORT ? ' · :' + BASE_PORT : ''));

      if (!bank) return;
      if (regions.length === 0) {
        // No declared regions: hide the switch bank, show the operator's configured host.
        bank.style.display = 'none';
        if (DEFAULT_URI) setText('rx-uri', DEFAULT_URI);
        setText('rx-meta', 'SINGLE ENDPOINT · CUCKATOO32');
        return;
      }
      bank.style.display = '';

      // Nearest region first, then most miners, then name — same order as before.
      var nearestKey = detectNearestRegion(regions.map(function (r) { return r.region; }));
      regions.sort(function (a, b2) {
        if (a.region === nearestKey) return -1;
        if (b2.region === nearestKey) return 1;
        if ((b2.miners || 0) !== (a.miners || 0)) return (b2.miners || 0) - (a.miners || 0);
        return (a.label || a.region).localeCompare(b2.label || b2.region);
      });

      // Preserve the visitor's current selection across the 60s refresh.
      var prev = bank.querySelector('.switch.on');
      var selectedKey = prev ? prev.dataset.region : null;
      if (!selectedKey || !regions.some(function (r) { return r.region === selectedKey; })) {
        selectedKey = regions[0].region;
      }

      bank.textContent = '';
      regions.forEach(function (r) {
        var sw = document.createElement('button');
        sw.type = 'button';
        sw.className = 'switch ' + statusCls(r.status) + (r.region === selectedKey ? ' on' : '');
        sw.dataset.region = r.region;
        sw.setAttribute('role', 'tab');
        sw.setAttribute('aria-selected', r.region === selectedKey ? 'true' : 'false');
        sw.title = (r.label || r.region) + (r.country ? ' · ' + r.country : '');
        var dot = document.createElement('span');
        dot.className = 'lamp-dot';
        var toggle = document.createElement('span');
        toggle.className = 'toggle';
        var knob = document.createElement('span');
        knob.className = 'knob';
        toggle.appendChild(knob);
        var name = document.createElement('span');
        name.className = 'name';
        name.textContent = String(r.region || '').toUpperCase();
        if (r.region === nearestKey) {
          var pin = document.createElement('span');
          pin.className = 'pin';
          pin.title = 'Nearest to you';
          pin.textContent = '📍';
          name.appendChild(pin);
        }
        sw.appendChild(dot); sw.appendChild(toggle); sw.appendChild(name);
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
      var any = email || forum || ['discord', 'telegram', 'twitter', 'website'].some(function (k) { return social[k]; });
      if (any) { var note = $('info-no-contact'); if (note) note.style.display = 'none'; }
    } catch (e) { /* keep the operator note */ }
  }

  // ── theme switch → re-render canvas instruments in the new palette ────────
  new MutationObserver(function () {
    readTokens();
    if (gaugeHash) gaugeHash.render();
    if (gaugeEffort) { gaugeEffort.setScale(0, 150, '%', effortZones(), 6); gaugeEffort.render(); }
    chart.render();
  }).observe(document.body, { attributes: true, attributeFilter: ['class'] });

  // ── refresh cycle ─────────────────────────────────────────────────────────
  async function refresh() {
    await loadStatus();   // first: nodeHeight feeds the fuel-rod depths
    loadPoolInfo();
    loadHashrate();
    loadStats();
    loadEffort();
    loadBlocks();
    loadPayments();
    loadHistory();
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
