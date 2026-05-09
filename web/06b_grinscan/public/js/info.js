// info.js — Info page: tabs, SVG charts, emission, stats, network, API

const GENESIS_UNIX = 1547520000; // 2019-01-15 00:00:00 UTC

// Supply milestones
const SUPPLY_MILESTONES = [
  [0, 0], [1, 31.56], [2, 63.11], [5, 157.79],
  [10, 315.58], [15, 473.36], [20, 631.15],
];
const INFLATION_MILESTONES = [
  [1, 100], [2, 50], [3, 33.3], [5, 20],
  [7, 14.3], [10, 10], [15, 6.7], [20, 5], [50, 2],
];

// ── Utility ──────────────────────────────────────────────────────────────────

function fmtGPS(gps) {
  if (gps == null || isNaN(gps)) return '—';
  if (gps >= 1e15) return (gps / 1e15).toFixed(2) + ' PGPS';
  if (gps >= 1e12) return (gps / 1e12).toFixed(2) + ' TGPS';
  if (gps >= 1e9)  return (gps / 1e9).toFixed(2)  + ' GGPS';
  if (gps >= 1e6)  return (gps / 1e6).toFixed(2)  + ' MGPS';
  if (gps >= 1e3)  return (gps / 1e3).toFixed(1)  + ' kGPS';
  return gps.toFixed(2) + ' GPS';
}

function fmtDiff(d) {
  if (d == null || isNaN(d)) return '—';
  if (d >= 1e15) return (d / 1e15).toFixed(2) + ' P';
  if (d >= 1e12) return (d / 1e12).toFixed(2) + ' T';
  if (d >= 1e9)  return (d / 1e9).toFixed(2)  + ' G';
  if (d >= 1e6)  return (d / 1e6).toFixed(1)  + ' M';
  if (d >= 1e3)  return (d / 1e3).toFixed(1)  + ' K';
  return String(Math.round(d));
}

function fmtNum(n, dec) {
  if (n == null) return '—';
  if (dec != null) return Number(n).toLocaleString(undefined, { minimumFractionDigits: dec, maximumFractionDigits: dec });
  return Number(n).toLocaleString();
}

function fmtDate(ts) {
  return new Date(ts * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
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
  if (name === 'emission')  loadEmission();
  if (name === 'stats')     loadStats();
  if (name === 'charts')    loadCharts(7);
  if (name === 'network')   loadNetwork();
  // 'about' is static
}

// ── SVG chart helper ─────────────────────────────────────────────────────────

function makeSVG(points, width, height, opts) {
  const { xMin, xMax, yMin, yMax, color, dotX, dotY, yFmt } = opts;
  const xRange = xMax - xMin || 1;
  const yRange = yMax - yMin || 1;
  const pad = { top: 20, right: 10, bottom: 30, left: 45 };
  const cw = width  - pad.left - pad.right;
  const ch = height - pad.top  - pad.bottom;

  function toX(v) { return pad.left + ((v - xMin) / xRange) * cw; }
  function toY(v) { return pad.top  + (1 - (v - yMin) / yRange) * ch; }

  const polyPts = points.map(([x, y]) => `${toX(x).toFixed(1)},${toY(y).toFixed(1)}`).join(' ');

  // Y axis labels (5 ticks)
  const yTicks = Array.from({ length: 5 }, (_, i) => yMin + (yRange * i) / 4);
  const _defaultYFmt = v => {
    if (v >= 1e15) return (v / 1e15).toFixed(1) + 'P';
    if (v >= 1e12) return (v / 1e12).toFixed(1) + 'T';
    if (v >= 1e9)  return (v / 1e9).toFixed(1)  + 'G';
    if (v >= 1e6)  return (v / 1e6).toFixed(0)  + 'M';
    if (v >= 1e3)  return (v / 1e3).toFixed(0)  + 'K';
    return v.toFixed(1);
  };
  const yAxisSvg = yTicks.map(v => {
    const label = (yFmt || _defaultYFmt)(v);
    return `<text x="${pad.left - 6}" y="${toY(v).toFixed(1)}" text-anchor="end" dominant-baseline="middle" font-size="9" fill="var(--muted)">${label}</text>
            <line x1="${pad.left}" y1="${toY(v).toFixed(1)}" x2="${pad.left + cw}" y2="${toY(v).toFixed(1)}" stroke="var(--border)" stroke-width="0.5"/>`;
  }).join('');

  // X axis labels (every other)
  const xStep = (xMax - xMin) / 4;
  const xAxisSvg = [0, 1, 2, 3, 4].map(i => {
    const xv = xMin + xStep * i;
    const label = opts.xFmt ? opts.xFmt(xv) : xv.toFixed(0);
    return `<text x="${toX(xv).toFixed(1)}" y="${height - 8}" text-anchor="middle" font-size="9" fill="var(--muted)">${label}</text>`;
  }).join('');

  const dotSvg = (dotX != null && dotY != null)
    ? `<circle cx="${toX(dotX).toFixed(1)}" cy="${toY(dotY).toFixed(1)}" r="5" fill="var(--accent)" stroke="var(--bg)" stroke-width="2"/>`
    : '';

  return `<svg viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
    ${yAxisSvg}
    ${xAxisSvg}
    <polyline points="${polyPts}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round"/>
    ${dotSvg}
  </svg>`;
}

// ── Emission tab ─────────────────────────────────────────────────────────────

async function loadEmission() {
  try {
    const r = await fetch('/api/tip');
    const { height } = await r.json();
    const supply = height * 60;
    const supplyM = supply / 1e6;
    const elapsed = (Date.now() / 1000 - GENESIS_UNIX) / (365.25 * 86400);
    const inflation = (60 / supply) * 100 * (365.25 * 24 * 3600); // annual rate
    const COIN = window.GRINSCAN_NETWORK === 'testnet' ? 'tGRIN' : 'GRIN';

    setText('em-supply',    fmtNum(supply) + ' ' + COIN);
    setText('em-block',     '#' + fmtNum(height));
    setText('em-reward',    '60 ' + COIN + ' / block');
    setText('em-reward-sub', '1 ' + COIN + ' / sec');
    setText('em-inflation', inflation.toFixed(1) + '% / year');
    setText('em-years',     elapsed.toFixed(1) + ' years since genesis');

    // Supply curve (0–20 years, linear through origin)
    const supplyPoints = [];
    for (let yr = 0; yr <= 20; yr += 0.5) {
      supplyPoints.push([yr, yr * 31.56]);
    }
    const supplyDotY = supplyM;
    const supplySVG = makeSVG(supplyPoints, 700, 200, {
      xMin: 0, xMax: 20, yMin: 0, yMax: 650,
      color: 'var(--accent)', dotX: elapsed, dotY: supplyDotY,
      xFmt: v => v.toFixed(0) + 'y',
    });
    const supplyEl = document.getElementById('chart-supply');
    if (supplyEl) supplyEl.innerHTML = supplySVG;

    // Inflation curve (1/H shape)
    const inflPoints = INFLATION_MILESTONES.map(([y, p]) => [y, p]);
    const inflDotY = inflation;
    const inflSVG = makeSVG(inflPoints, 700, 180, {
      xMin: 1, xMax: 50, yMin: 0, yMax: 100,
      color: 'var(--accent2)', dotX: elapsed, dotY: Math.min(inflDotY, 100),
      xFmt: v => v.toFixed(0) + 'y',
    });
    const inflEl = document.getElementById('chart-inflation');
    if (inflEl) inflEl.innerHTML = inflSVG;

  } catch (e) {
    console.error('loadEmission:', e);
  }
}

// ── Stats tab ────────────────────────────────────────────────────────────────

async function loadStats() {
  try {
    const [priceR, histR, tipR] = await Promise.all([
      fetch('/api/price'),
      fetch('/api/history?days=14'),
      fetch('/api/tip'),
    ]);

    if (priceR.ok) {
      const p = await priceR.json();
      setText('price-btc',  p.price_btc != null ? p.price_btc.toFixed(8) + ' ₿' : '—');
      setText('price-usd',  p.price_usd != null ? '$' + p.price_usd.toFixed(4)   : '—');
      const chg = p.change_24h_pct;
      const chgEl = document.getElementById('price-24h');
      if (chgEl && chg != null) {
        chgEl.textContent = (chg >= 0 ? '+' : '') + chg.toFixed(2) + '%';
        chgEl.style.color = chg >= 0 ? 'var(--green)' : 'var(--red)';
      }
      if (p.stale) {
        const w = document.getElementById('price-stale-warn');
        if (w) w.style.display = '';
      }
    }

    if (tipR.ok) {
      const { height } = await tipR.json();
      const supply = height * 60;
      if (priceR.ok) {
        const p = await fetch('/api/price').then(r => r.json()).catch(() => ({}));
        const mcap = supply * (p.price_usd || 0);
        setText('market-cap', mcap ? '$' + fmtNum(Math.round(mcap / 1000)) + 'K' : '—');
      }
      setText('circulating', fmtNum(supply) + ' ツ');
    }

    if (histR.ok) {
      const histData = await histR.json();
      const hist = Array.isArray(histData) ? histData : (histData.rows || []);
      if (hist.length > 1) {
        renderLineChart('chart-hashrate', hist.map(p => [p.timestamp, p.hashrate_gps]),
          'GPS', 'var(--accent)', fmtGPS);
        renderLineChart('chart-difficulty', hist.map(p => [p.timestamp, p.difficulty]),
          '', 'var(--accent2)', fmtDiff);
      }
    }
  } catch (e) {
    console.error('loadStats:', e);
  }
}

function renderLineChart(elId, dataPoints, yUnit, color, yFmt) {
  const el = document.getElementById(elId);
  if (!el || dataPoints.length < 2) return;
  const xVals = dataPoints.map(p => p[0]);
  const yVals = dataPoints.map(p => p[1]);
  const xMin = Math.min(...xVals), xMax = Math.max(...xVals);
  const yMin = Math.min(...yVals) * 0.95, yMax = Math.max(...yVals) * 1.05;

  const svg = makeSVG(dataPoints, 700, 180, {
    xMin, xMax, yMin, yMax,
    color,
    xFmt: ts => fmtDate(ts),
    yFmt,
  });
  el.innerHTML = svg;

  // Hover tooltip
  const svgEl = el.querySelector('svg');
  if (svgEl) {
    const tip = document.createElement('div');
    tip.style.cssText = 'position:absolute;background:var(--surface);border:1px solid var(--border);border-radius:4px;padding:4px 8px;font:11px var(--font-mono);color:var(--text);pointer-events:none;display:none;z-index:10;';
    el.style.position = 'relative';
    el.appendChild(tip);
    svgEl.addEventListener('mousemove', e => {
      const rect = svgEl.getBoundingClientRect();
      const xFrac = (e.clientX - rect.left) / rect.width;
      const idx = Math.round(xFrac * (dataPoints.length - 1));
      const pt = dataPoints[Math.max(0, Math.min(idx, dataPoints.length - 1))];
      tip.style.display = 'block';
      tip.style.left = (e.clientX - rect.left + 10) + 'px';
      tip.style.top  = (e.clientY - rect.top  - 30) + 'px';
      const val = yFmt ? yFmt(pt[1]) : fmtNum(Math.round(pt[1]));
      tip.textContent = fmtDate(pt[0]) + '  ' + val;
    });
    svgEl.addEventListener('mouseleave', () => { tip.style.display = 'none'; });
  }
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
    // Fetch stats for node info card alongside peers
    const [peers, stats] = await Promise.all([
      fetch('/api/peers').then(r => r.json()).catch(() => []),
      fetch('/api/stats').then(r => r.json()).catch(() => ({})),
    ]);

    // Populate node info card
    const modeLabel = stats.node_mode === 'archive' ? '✅ Full Archive'
                    : stats.node_mode === 'pruned'  ? '⚠ Pruned'
                    :                                 '⏳ Syncing History';
    setText('node-mode-badge', modeLabel);

    const minH = stats.backfill_min != null ? Number(stats.backfill_min).toLocaleString() : '?';
    const maxH = stats.tip_height   != null ? Number(stats.tip_height).toLocaleString()   : '?';
    setText('block-history', stats.backfill_active
      ? `Blocks ${minH} – ${maxH} (backfilling…)`
      : `Blocks ${minH} – ${maxH}`);

    setText('db-size',    formatBytes(stats.db_size_bytes));
    setText('chain-size', formatBytes(stats.chain_size_bytes));
    if (!Array.isArray(peers) || !peers.length) {
      el.innerHTML = '<p style="color:var(--muted);font-family:var(--font-mono);font-size:13px;">Owner API unreachable — peer data unavailable.</p>';
      return;
    }
    const outbound = peers.filter(p => p.direction === 'Outbound').length;
    const inbound  = peers.filter(p => p.direction === 'Inbound').length;

    // Version buckets
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
      // IPv6 with embedded IPv4 like [::ffff:1.2.3.4]:port
      let s = addr.replace(/(\[(?:[^\]]*:)?(?:\d+\.\d+\.)\d+\.)\d+(\])/g, '$1*$2');
      // Plain IPv4 like 1.2.3.4:port — mask last octet
      s = s.replace(/((?:\d+\.){2}\d+\.)\d+(:\d+)/g, '$1*$2');
      return s;
    }

    const rows = peers.map(p => {
      const dir = p.direction === 'Outbound'
        ? '<span class="badge badge-outbound">Outbound</span>'
        : '<span class="badge badge-inbound">Inbound</span>';
      return `<tr><td>${maskAddr(p.addr)}</td><td>${dir}</td><td style="color:var(--muted)">${p.user_agent || '—'}</td></tr>`;
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


// ── Charts tab (Chart.js) ─────────────────────────────────────────────────────

const _chartInstances = {};

function destroyChart(id) {
  if (_chartInstances[id]) { _chartInstances[id].destroy(); delete _chartInstances[id]; }
}

function makeLineChart(canvasId, labels, data, label, color, yTickFmt) {
  destroyChart(canvasId);
  const canvas = document.getElementById(canvasId);
  if (!canvas || typeof Chart === 'undefined') return;
  const style = getComputedStyle(document.documentElement);
  const gridColor = style.getPropertyValue('--border').trim() || '#333';
  const textColor = style.getPropertyValue('--muted').trim() || '#888';
  _chartInstances[canvasId] = new Chart(canvas, {
    type: 'line',
    data: {
      labels,
      datasets: [{ label, data, borderColor: color, backgroundColor: color + '22',
        borderWidth: 1.5, pointRadius: 0, fill: true, tension: 0.3 }],
    },
    options: {
      responsive: true,
      animation: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: textColor, maxTicksLimit: 8, font: { size: 10 } }, grid: { color: gridColor } },
        y: { ticks: { color: textColor, maxTicksLimit: 6, font: { size: 10 },
               callback: yTickFmt || undefined }, grid: { color: gridColor } },
      },
    },
  });
}

async function loadCharts(days) {
  // Update active day button
  document.querySelectorAll('.gs-chart-day-btn').forEach(btn => {
    btn.classList.toggle('active', parseInt(btn.dataset.days) === days);
  });

  try {
    const r = await fetch('/api/history?days=' + days);
    if (!r.ok) return;
    const data = await r.json();
    const rows = Array.isArray(data) ? data : (data.rows || []);
    if (rows.length < 2) return;

    const labels = rows.map(p => fmtDate(p.timestamp));
    const style = getComputedStyle(document.documentElement);
    const accent  = style.getPropertyValue('--accent').trim()  || '#c8960c';
    const accent2 = style.getPropertyValue('--accent2').trim() || '#00bcd4';

    makeLineChart('chart-canvas-hashrate',   labels, rows.map(p => p.hashrate_gps), 'GPS',        accent,  v => fmtGPS(v));
    makeLineChart('chart-canvas-difficulty', labels, rows.map(p => p.difficulty),  'Difficulty', accent2, v => fmtDiff(v));

    // Block time: seconds between consecutive blocks, capped at 300s
    const btLabels = rows.slice(1).map((p, i) => fmtDate(p.timestamp));
    const btData   = rows.slice(1).map((p, i) => Math.min(p.timestamp - rows[i].timestamp, 300));
    const green    = style.getPropertyValue('--green').trim() || '#4caf7d';
    makeLineChart('chart-canvas-blocktime', btLabels, btData, 'Block Time (s)', green);

  } catch (e) {
    console.error('loadCharts:', e);
  }
}

// ── Helper ───────────────────────────────────────────────────────────────────

function setText(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}

// ── Init ─────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('.gs-tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  // Charts day selector (delegated — chart canvases may not exist yet)
  document.addEventListener('click', e => {
    if (e.target.classList.contains('gs-chart-day-btn')) {
      const days = parseInt(e.target.dataset.days);
      if (days) loadCharts(days);
    }
  });

  initApiTab();
  switchTab('about');
});
