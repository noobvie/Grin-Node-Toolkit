// info.js — Info page: tabs, SVG charts, emission, network

const GENESIS_UNIX = 1547520000; // 2019-01-15 00:00:00 UTC

const INFLATION_MILESTONES = [
  [1, 100], [2, 50], [3, 33.3], [5, 20],
  [7, 14.3], [10, 10], [15, 6.7], [20, 5], [50, 2],
];

// ── Utility ──────────────────────────────────────────────────────────────────

function fmtNum(n, dec) {
  if (n == null) return '—';
  if (dec != null) return Number(n).toLocaleString(undefined, { minimumFractionDigits: dec, maximumFractionDigits: dec });
  return Number(n).toLocaleString();
}

function setText(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}

function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── Tab system ───────────────────────────────────────────────────────────────

const _tabLoaded = {};

function switchTab(name) {
  document.querySelectorAll('.gs-tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.gs-tab-panel').forEach(p => p.classList.toggle('active', p.id === 'tab-' + name));
  document.title = name.charAt(0).toUpperCase() + name.slice(1) + ' — GrinScan';
  if (!_tabLoaded[name]) {
    _tabLoaded[name] = true;
    loadTabData(name);
  }
}

function loadTabData(name) {
  if (name === 'charts')  loadCharts();
  if (name === 'network') loadNetwork();
  // 'about' is static
}

// ── SVG chart helper ─────────────────────────────────────────────────────────

function makeSVG(points, width, height, opts) {
  const { xMin, xMax, yMin, yMax, color, dotX, dotY, yFmt } = opts;
  const xRange = xMax - xMin || 1;
  const yRange = yMax - yMin || 1;
  const pad = { top: 20, right: 10, bottom: 34, left: 52 };
  const cw = width  - pad.left - pad.right;
  const ch = height - pad.top  - pad.bottom;

  function toX(v) { return pad.left + ((v - xMin) / xRange) * cw; }
  function toY(v) { return pad.top  + (1 - (v - yMin) / yRange) * ch; }

  const polyPts = points.map(([x, y]) => `${toX(x).toFixed(1)},${toY(y).toFixed(1)}`).join(' ');

  const yTicks = Array.from({ length: 5 }, (_, i) => yMin + (yRange * i) / 4);
  const _defaultYFmt = v => {
    if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M';
    if (v >= 1e3) return (v / 1e3).toFixed(1) + 'k';
    return v.toFixed(0);
  };
  const yAxisSvg = yTicks.map(v => {
    const label = (yFmt || _defaultYFmt)(v);
    return `<text x="${pad.left - 6}" y="${toY(v).toFixed(1)}" text-anchor="end" dominant-baseline="middle" font-size="11" fill="var(--muted)">${label}</text>
            <line x1="${pad.left}" y1="${toY(v).toFixed(1)}" x2="${pad.left + cw}" y2="${toY(v).toFixed(1)}" stroke="var(--border)" stroke-width="0.5"/>`;
  }).join('');

  const xStep = (xMax - xMin) / 4;
  const xAxisSvg = [0, 1, 2, 3, 4].map(i => {
    const xv = xMin + xStep * i;
    const label = opts.xFmt ? opts.xFmt(xv) : xv.toFixed(0);
    return `<text x="${toX(xv).toFixed(1)}" y="${height - 8}" text-anchor="middle" font-size="11" fill="var(--muted)">${label}</text>`;
  }).join('');

  let dotSvg = '';
  if (dotX != null && dotY != null) {
    const iconSize = 18;
    const cx = parseFloat(toX(dotX).toFixed(1));
    const cy = parseFloat(toY(dotY).toFixed(1));
    dotSvg = `<image href="/grin-logo.svg" x="${(cx - iconSize/2).toFixed(1)}" y="${(cy - iconSize/2).toFixed(1)}" width="${iconSize}" height="${iconSize}"/>`;

    if (opts.dotLabel) {
      const bw = 160, bh = 36;
      const iconR = iconSize / 2 + 2;  // clearance from icon edge to bubble
      const bx = Math.min(Math.max(cx - bw / 2, pad.left), pad.left + cw - bw);
      const arrowX = Math.min(Math.max(cx, bx + 8), bx + bw - 8);
      const aw = 5; // arrow half-width at base
      let by, pathD;
      if (cy - iconR - bh >= pad.top) {
        // bubble above — arrow points down to dot
        by = cy - iconR - bh;
        pathD = [
          `M ${bx.toFixed(1)},${by.toFixed(1)}`,
          `L ${(bx+bw).toFixed(1)},${by.toFixed(1)}`,
          `L ${(bx+bw).toFixed(1)},${(by+bh).toFixed(1)}`,
          `L ${(arrowX+aw).toFixed(1)},${(by+bh).toFixed(1)}`,
          `L ${cx.toFixed(1)},${cy.toFixed(1)}`,
          `L ${(arrowX-aw).toFixed(1)},${(by+bh).toFixed(1)}`,
          `L ${bx.toFixed(1)},${(by+bh).toFixed(1)} Z`,
        ].join(' ');
      } else {
        // bubble below — arrow points up to dot
        by = cy + iconR;
        pathD = [
          `M ${bx.toFixed(1)},${by.toFixed(1)}`,
          `L ${(arrowX-aw).toFixed(1)},${by.toFixed(1)}`,
          `L ${cx.toFixed(1)},${cy.toFixed(1)}`,
          `L ${(arrowX+aw).toFixed(1)},${by.toFixed(1)}`,
          `L ${(bx+bw).toFixed(1)},${by.toFixed(1)}`,
          `L ${(bx+bw).toFixed(1)},${(by+bh).toFixed(1)}`,
          `L ${bx.toFixed(1)},${(by+bh).toFixed(1)} Z`,
        ].join(' ');
      }
      dotSvg += `
    <path d="${pathD}" fill="var(--surface)" stroke="var(--accent)" stroke-width="1" stroke-linejoin="round"/>
    <text font-family="monospace" font-size="10" font-weight="700" fill="var(--accent)"
          x="${(bx+8).toFixed(1)}" y="${(by+14).toFixed(1)}">Hey Grinner! I'm here</text>
    <text font-family="monospace" font-size="10" fill="var(--text)"
          x="${(bx+8).toFixed(1)}" y="${(by+27).toFixed(1)}">${opts.dotLabel}</text>`;
    }
  }

  return `<svg viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
    ${yAxisSvg}
    ${xAxisSvg}
    <polyline points="${polyPts}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round"/>
    ${dotSvg}
  </svg>`;
}

// ── Formatters used by history charts ────────────────────────────────────────

function fmtHR(gps) {
  if (!gps) return '—';
  if (gps >= 1e6) return (gps / 1e6).toFixed(2) + ' MG/s';
  if (gps >= 1e3) return (gps / 1e3).toFixed(2) + ' kG/s';
  return gps.toFixed(2) + ' G/s';
}

function fmtDiffLabel(d) {
  if (!d) return '—';
  if (d >= 1e9) return (d / 1e9).toFixed(2) + 'B';
  if (d >= 1e6) return (d / 1e6).toFixed(2) + 'M';
  if (d >= 1e3) return (d / 1e3).toFixed(1) + 'K';
  return d.toFixed(0);
}

function makeTsFmt(days) {
  if (days === 1)
    return ts => new Date(ts * 1000).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  if (days <= 31)
    return ts => new Date(ts * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  if (days <= 365)
    return ts => new Date(ts * 1000).toLocaleDateString(undefined, { month: 'short', year: '2-digit' });
  return ts => new Date(ts * 1000).getFullYear().toString();
}

// ── History charts ────────────────────────────────────────────────────────────

let _histDays       = 7;
let _activityMetric = 'both';
let _cachedRows     = null;
let _cachedHeight   = null;

function getChartW() {
  const el = document.querySelector('.gs-chart-wrap');
  if (!el) return 600;
  const style   = window.getComputedStyle(el);
  const padding = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
  return Math.max(el.clientWidth - padding, 280);
}

function _chartLoading(ids) {
  ids.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = '<p style="color:var(--muted);font-size:12px;padding:16px;text-align:center;">Loading…</p>';
  });
}

function makeActivitySVG(txPts, feePts, metric, width, height, xFmt) {
  const COIN    = window.GRINSCAN_NETWORK === 'testnet' ? 'tGRIN' : 'GRIN';
  const showTx  = metric !== 'fee';
  const showFee = metric !== 'tx';
  const pad = { top: 20, right: (showTx && showFee) ? 55 : 10, bottom: 30, left: 45 };
  const cw = width - pad.left - pad.right;
  const ch = height - pad.top - pad.bottom;

  const allPts = [...(showTx ? txPts : []), ...(showFee ? feePts : [])];
  if (!allPts.length) return '<p style="color:var(--muted);font-size:12px;padding:16px;text-align:center;">No data</p>';

  const xMin   = allPts.reduce((m, p) => Math.min(m, p[0]), Infinity);
  const xMax   = allPts.reduce((m, p) => Math.max(m, p[0]), -Infinity);
  const xRange = xMax - xMin || 1;
  function toX(v) { return pad.left + ((v - xMin) / xRange) * cw; }

  const txMax  = Math.max(...txPts.map(p => p[1]),  1)     * 1.2;
  const feeMax = Math.max(...feePts.map(p => p[1]), 0.001) * 1.2;
  function toY_tx(v)  { return pad.top + (1 - Math.min(v / txMax,  1)) * ch; }
  function toY_fee(v) { return pad.top + (1 - Math.min(v / feeMax, 1)) * ch; }

  // X axis labels
  const xStep  = (xMax - xMin) / 4;
  const xAxisSvg = [0, 1, 2, 3, 4].map(i => {
    const xv = xMin + xStep * i;
    return `<text x="${toX(xv).toFixed(1)}" y="${height - 8}" text-anchor="middle" font-size="9" fill="var(--muted)">${(xFmt || makeTsFmt(7))(xv)}</text>`;
  }).join('');

  // Left Y axis — tx when showTx, else fee
  const leftMax   = showTx ? txMax  : feeMax;
  const leftColor = showTx ? 'var(--green)' : 'var(--accent2)';
  const leftFmt   = showTx
    ? v => v.toFixed(0)
    : v => v < 0.001 ? '0' : v.toFixed(3);
  const toY_left  = showTx ? toY_tx : toY_fee;

  const N = 5;
  const gridAndLeftAxis = Array.from({ length: N }, (_, i) => (leftMax * i) / (N - 1)).map(v => {
    const y = toY_left(v).toFixed(1);
    return `<line x1="${pad.left}" y1="${y}" x2="${pad.left + cw}" y2="${y}" stroke="var(--border)" stroke-width="0.5"/>` +
           `<text x="${pad.left - 6}" y="${y}" text-anchor="end" dominant-baseline="middle" font-size="9" fill="${leftColor}">${leftFmt(v)}</text>`;
  }).join('');

  // Right Y axis — fee (only when showing both)
  let rightAxisSvg = '';
  if (showTx && showFee) {
    rightAxisSvg = Array.from({ length: N }, (_, i) => (feeMax * i) / (N - 1)).map(v => {
      const y    = toY_fee(v).toFixed(1);
      const label = v < 0.001 ? '0' : v.toFixed(3);
      return `<text x="${(pad.left + cw + 6).toFixed(1)}" y="${y}" dominant-baseline="middle" font-size="9" fill="var(--accent2)">${label}</text>`;
    }).join('');
  }

  // Polylines
  let txLine = '';
  if (showTx && txPts.length) {
    const pts = txPts.map(([x, y]) => `${toX(x).toFixed(1)},${toY_tx(y).toFixed(1)}`).join(' ');
    txLine = `<polyline points="${pts}" fill="none" stroke="var(--green)" stroke-width="1.8" stroke-linejoin="round"/>`;
  }
  let feeLine = '';
  if (showFee && feePts.length) {
    const pts = feePts.map(([x, y]) => `${toX(x).toFixed(1)},${toY_fee(y).toFixed(1)}`).join(' ');
    feeLine = `<polyline points="${pts}" fill="none" stroke="var(--accent2)" stroke-width="1.8" stroke-linejoin="round"/>`;
  }

  // Inline legend (both mode only)
  let legendSvg = '';
  if (showTx && showFee) {
    const lx = pad.left + 8, ly = pad.top + 4;
    legendSvg = `<rect x="${lx - 2}" y="${ly - 2}" width="180" height="18" rx="2" fill="var(--surface)" fill-opacity="0.8"/>` +
      `<line x1="${lx}" y1="${ly + 7}" x2="${lx + 14}" y2="${ly + 7}" stroke="var(--green)" stroke-width="2"/>` +
      `<text x="${lx + 18}" y="${ly + 11}" font-size="9" fill="var(--green)">Transactions</text>` +
      `<line x1="${lx + 92}" y1="${ly + 7}" x2="${lx + 106}" y2="${ly + 7}" stroke="var(--accent2)" stroke-width="2"/>` +
      `<text x="${lx + 110}" y="${ly + 11}" font-size="9" fill="var(--accent2)">Fees (${COIN})</text>`;
  }

  return `<svg viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
    ${gridAndLeftAxis}
    ${rightAxisSvg}
    ${xAxisSvg}
    ${txLine}
    ${feeLine}
    ${legendSvg}
  </svg>`;
}

function renderActivity(rows) {
  const W      = 700;
  const txPts  = rows.map(r => [r.timestamp, r.tx_count || 0]);
  const feePts = rows.map(r => [r.timestamp, (r.fee_total || 0) / 1e9]);
  const el     = document.getElementById('chart-activity');
  if (el) el.innerHTML = makeActivitySVG(txPts, feePts, _activityMetric, W, 170, makeTsFmt(_histDays));
}

function wireActivityMetricToggle() {
  const wrap = document.getElementById('activity-metric-toggle');
  if (!wrap) return;
  wrap.addEventListener('click', e => {
    const btn = e.target.closest('.gs-chart-day-btn');
    if (!btn) return;
    wrap.querySelectorAll('.gs-chart-day-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    _activityMetric = btn.dataset.metric;
    if (_cachedRows) renderActivity(_cachedRows);
  });
}

function _drawHistory(rows, days) {
  const xMin = rows[0].timestamp;
  const xMax = rows[rows.length - 1].timestamp;
  const W    = getChartW();
  const xFmt = makeTsFmt(days);

  const hrPts = rows.map(r => [r.timestamp, r.hashrate_gps]);
  const hrMax = Math.max(...hrPts.map(p => p[1])) * 1.15 || 1;
  const hrEl  = document.getElementById('chart-hashrate-history');
  if (hrEl) hrEl.innerHTML = makeSVG(hrPts, W, 160, {
    xMin, xMax, yMin: 0, yMax: hrMax, color: 'var(--accent)',
    xFmt,
    yFmt: v => hrMax >= 1e6 ? (v/1e6).toFixed(2)+'M' : hrMax >= 1e3 ? (v/1e3).toFixed(2)+'k' : v.toFixed(1),
  });

  const diffPts = rows.map(r => [r.timestamp, r.difficulty]);
  const diffMax = Math.max(...diffPts.map(p => p[1])) * 1.15 || 1;
  const diffEl  = document.getElementById('chart-difficulty-history');
  if (diffEl) diffEl.innerHTML = makeSVG(diffPts, W, 140, {
    xMin, xMax, yMin: 0, yMax: diffMax, color: 'var(--accent2)',
    xFmt,
    yFmt: v => diffMax >= 1e9 ? (v/1e9).toFixed(2)+'B' : diffMax >= 1e6 ? (v/1e6).toFixed(2)+'M' : diffMax >= 1e3 ? (v/1e3).toFixed(2)+'k' : v.toFixed(0),
  });

  renderActivity(rows);
}

async function renderHistoryCharts(days) {
  const ids = ['chart-hashrate-history', 'chart-difficulty-history', 'chart-activity'];
  _chartLoading(ids);
  try {
    const r = await fetch('/api/history?days=' + days);
    const { rows } = await r.json();
    if (!rows || !rows.length) {
      ids.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.innerHTML = '<p style="color:var(--muted);font-size:12px;padding:16px;text-align:center;">No data in this range</p>';
      });
      _cachedRows = null;
      return;
    }
    _cachedRows = rows;
    _drawHistory(rows, days);
  } catch (e) {
    console.error('renderHistoryCharts:', e);
  }
}

// ── Charts tab ────────────────────────────────────────────────────────────────

function _drawEmissionCharts(height) {
  const COIN       = window.GRINSCAN_NETWORK === 'testnet' ? 'tGRIN' : 'GRIN';
  const GENESIS_YEAR = 2019;
  const supply     = height * 60;
  const supplyM    = supply / 1e6;
  const elapsed    = (Date.now() / 1000 - GENESIS_UNIX) / (365.25 * 86400);
  const inflation  = (365.25 * 24 * 3600 / supply) * 100;
  const nowYear    = GENESIS_YEAR + elapsed;
  const supplyYMax = 50 * 31.56;
  const W          = getChartW();

  const supplyPoints = [];
  for (let yr = 0; yr <= 50; yr += 0.5) supplyPoints.push([GENESIS_YEAR + yr, yr * 31.56]);
  const supplyEl = document.getElementById('chart-supply');
  if (supplyEl) supplyEl.innerHTML = makeSVG(supplyPoints, W, 200, {
    xMin: GENESIS_YEAR, xMax: GENESIS_YEAR + 50, yMin: 0, yMax: supplyYMax,
    color: 'var(--accent)', dotX: nowYear, dotY: supplyM,
    xFmt: v => v >= GENESIS_YEAR + 50 ? '∞' : v.toFixed(0),
    yFmt: v => v >= supplyYMax - 0.01 ? '∞' : v.toFixed(0) + 'M',
    dotLabel: `${supplyM.toFixed(1)}M ${COIN} · ${Math.floor(nowYear)}`,
  });

  const inflPoints = INFLATION_MILESTONES.map(([y, p]) => [GENESIS_YEAR + y, p]);
  const inflEl = document.getElementById('chart-inflation');
  if (inflEl) inflEl.innerHTML = makeSVG(inflPoints, W, 180, {
    xMin: GENESIS_YEAR, xMax: GENESIS_YEAR + 50, yMin: 0, yMax: 100,
    color: 'var(--accent2)', dotX: nowYear, dotY: Math.min(inflation, 100),
    xFmt: v => v >= GENESIS_YEAR + 50 ? '∞' : v.toFixed(0),
    yFmt: v => v.toFixed(0) + '%',
    dotLabel: `${inflation.toFixed(1)}%/yr · ${Math.floor(nowYear)}`,
  });
}

async function loadCharts() {
  const COIN = window.GRINSCAN_NETWORK === 'testnet' ? 'tGRIN' : 'GRIN';

  if (window.GRINSCAN_NETWORK !== 'mainnet') {
    const el = document.getElementById('charts-price-stats');
    if (el) el.style.display = 'none';
  }

  try {
    const fetches = [fetch('/api/tip'), fetch('/api/stats')];
    if (window.GRINSCAN_NETWORK === 'mainnet') fetches.push(fetch('/api/price'));
    const results = await Promise.all(fetches);

    // Populate hashrate / difficulty card from stats
    if (results[1]?.ok) {
      const stats = await results[1].json();
      setText('info-hashrate',  fmtHR(stats.hashrate_gps));
      setText('info-difficulty', 'diff ' + fmtDiffLabel(stats.difficulty));
    }

    const { height } = await results[0].json();
    const supply    = height * 60;
    const elapsed   = (Date.now() / 1000 - GENESIS_UNIX) / (365.25 * 86400);
    const inflation = (365.25 * 24 * 3600 / supply) * 100;

    setText('em-supply',     fmtNum(supply) + ' ' + COIN);
    setText('em-block',      '#' + fmtNum(height));
    setText('em-reward',     '60 ' + COIN + ' / block');
    setText('em-reward-sub', '1 ' + COIN + ' / sec');
    setText('em-inflation',  inflation.toFixed(1) + '% / year');
    setText('em-years',      elapsed.toFixed(1) + ' years since genesis');

    _cachedHeight = height;
    _drawEmissionCharts(height);

    if (results[2]?.ok) {
      const priceData = await results[2].json();
      setText('price-btc', priceData.price_btc != null ? priceData.price_btc.toFixed(8) + ' ₿' : '—');
      setText('price-usd', priceData.price_usd != null ? '$' + priceData.price_usd.toFixed(4)   : '—');
      const chg = priceData.change_24h_pct;
      const chgEl = document.getElementById('price-24h');
      if (chgEl && chg != null) {
        chgEl.textContent = (chg >= 0 ? '+' : '') + chg.toFixed(2) + '%';
        chgEl.style.color = chg >= 0 ? 'var(--green)' : 'var(--red)';
      }
      if (priceData.stale) {
        const w = document.getElementById('price-stale-warn');
        if (w) w.style.display = '';
      }
      const mcap = supply * (priceData.price_usd || 0);
      if (mcap) {
        const mcapStr = mcap >= 1e9 ? '$' + (mcap / 1e9).toFixed(2) + 'B'
                      : mcap >= 1e6 ? '$' + (mcap / 1e6).toFixed(2) + 'M'
                      : '$' + (mcap / 1e3).toFixed(1) + 'K';
        setText('market-cap', mcapStr);
      }
    }

    // Kick off history charts (uses cached blocks — no backfill needed)
    renderHistoryCharts(_histDays);

  } catch (e) {
    console.error('loadCharts:', e);
  }
}

function wireHistoryRange() {
  const wrap = document.getElementById('history-range');
  if (!wrap) return;
  wrap.addEventListener('click', e => {
    const btn = e.target.closest('.gs-chart-day-btn');
    if (!btn) return;
    wrap.querySelectorAll('.gs-chart-day-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    _histDays = btn.dataset.days === '0' ? 0 : parseInt(btn.dataset.days);
    renderHistoryCharts(_histDays);
  });
}

// ── Network tab ──────────────────────────────────────────────────────────────

function formatBytes(b) {
  if (b == null) return '—';
  if (b >= 1073741824) return (b / 1073741824).toFixed(2) + ' GB';
  if (b >= 1048576)    return (b / 1048576).toFixed(1) + ' MB';
  if (b >= 1024)       return (b / 1024).toFixed(0) + ' KB';
  return b + ' B';
}

async function loadNetwork() {
  const el = document.getElementById('network-content');
  if (!el) return;
  el.innerHTML = '<p style="color:var(--muted);font-family:var(--font-mono);font-size:13px;">Loading…</p>';
  try {
    const [peers, stats] = await Promise.all([
      fetch('/api/peers').then(r => r.json()).catch(() => []),
      fetch('/api/stats').then(r => r.json()).catch(() => ({})),
    ]);

    const tipH   = stats.tip_height    != null ? Number(stats.tip_height).toLocaleString()    : '?';
    const cached = stats.cached_blocks != null ? Number(stats.cached_blocks).toLocaleString() : '?';
    const minH   = stats.min_cached_height != null ? Number(stats.min_cached_height).toLocaleString() : null;
    setText('node-type-badge',
      stats.node_mode === 'archive' ? '✅ Full Archive (since genesis)' :
      stats.node_mode === 'pruned'  ? '⚠ Pruned (recent blocks only)' :
                                      '⏳ Determining…');
    setText('cached-blocks', minH != null ? `${cached} (#${minH} – #${tipH})` : `${cached} (tip #${tipH})`);
    setText('db-size',    formatBytes(stats.db_size_bytes));
    setText('chain-size', formatBytes(stats.chain_size_bytes));

    if (!Array.isArray(peers) || !peers.length) {
      el.innerHTML = '<p style="color:var(--muted);font-family:var(--font-mono);font-size:13px;">Owner API unreachable — peer data unavailable.</p>';
      return;
    }
    const outbound = peers.filter(p => p.direction === 'Outbound').length;
    const inbound  = peers.filter(p => p.direction === 'Inbound').length;

    const versions = {};
    peers.forEach(p => {
      const m = (p.user_agent || '').match(/(\d+\.\d+)\.\d+/);
      const b = m ? m[1] : 'Other';
      versions[b] = (versions[b] || 0) + 1;
    });
    const sortedV = Object.entries(versions).sort((a, b) => b[1] - a[1]);

    const vBars = sortedV.map(([ver, cnt]) => {
      const pct = ((cnt / peers.length) * 100).toFixed(0);
      return `<div class="gs-version-bar-wrap">
        <div class="gs-version-bar-label">
          <span>MW/Grin ${ver}.x</span>
          <span>${cnt} (${pct}%)</span>
        </div>
        <div class="gs-version-bar-outer">
          <div class="gs-version-bar-inner" style="width:${pct}%"></div>
        </div>
      </div>`;
    }).join('');

    function maskAddr(addr) {
      if (!addr) return '—';
      let s = addr.replace(/(\[(?:[^\]]*:)?(?:\d+\.\d+\.)\d+\.)\d+(\])/g, '$1*$2');
      s = s.replace(/((?:\d+\.){2}\d+\.)\d+(:\d+)/g, '$1*$2');
      return s;
    }

    const rows = peers.map(p => {
      const dir = p.direction === 'Outbound'
        ? '<span class="badge badge-outbound">Outbound</span>'
        : '<span class="badge badge-inbound">Inbound</span>';
      return `<tr><td>${esc(maskAddr(p.addr))}</td><td>${dir}</td><td style="color:var(--muted)">${esc(p.user_agent)}</td></tr>`;
    }).join('');

    el.innerHTML = `
      <div class="gs-info-stats-grid" style="grid-template-columns:repeat(3,1fr);margin-bottom:20px;">
        <div class="gs-info-stat"><div class="gs-info-stat-label">Total Peers</div><div class="gs-info-stat-value">${peers.length}</div></div>
        <div class="gs-info-stat"><div class="gs-info-stat-label">Outbound</div><div class="gs-info-stat-value">${outbound}</div></div>
        <div class="gs-info-stat"><div class="gs-info-stat-label">Inbound</div><div class="gs-info-stat-value">${inbound}</div></div>
      </div>
      <div class="gs-info-section">
        <h3>Client Version Distribution</h3>
        ${vBars}
      </div>
      <div class="gs-info-section">
        <h3>Connected Peers
          <button id="refresh-peers-btn" class="gs-api-btn" style="margin-left:12px;font-size:11px;">↻ Refresh</button>
        </h3>
        <div class="gs-table-wrap">
          <table class="gs-peer-table">
            <thead><tr><th>Address</th><th>Direction</th><th>User Agent</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>`;
    document.getElementById('refresh-peers-btn')?.addEventListener('click', () => {
      _tabLoaded['network'] = false;
      loadNetwork();
    });
  } catch (e) {
    el.innerHTML = '<p style="color:var(--muted);">Failed to load peer data.</p>';
  }
}

// ── Init ─────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('.gs-tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });
  wireHistoryRange();
  wireActivityMetricToggle();
  switchTab('about');

  let _resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(_resizeTimer);
    _resizeTimer = setTimeout(() => {
      if (_cachedRows)   _drawHistory(_cachedRows, _histDays);
      if (_cachedHeight) _drawEmissionCharts(_cachedHeight);
    }, 150);
  });
});
