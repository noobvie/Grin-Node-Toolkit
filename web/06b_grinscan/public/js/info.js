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
  const pad = { top: 20, right: 10, bottom: 30, left: 45 };
  const cw = width  - pad.left - pad.right;
  const ch = height - pad.top  - pad.bottom;

  function toX(v) { return pad.left + ((v - xMin) / xRange) * cw; }
  function toY(v) { return pad.top  + (1 - (v - yMin) / yRange) * ch; }

  const polyPts = points.map(([x, y]) => `${toX(x).toFixed(1)},${toY(y).toFixed(1)}`).join(' ');

  const yTicks = Array.from({ length: 5 }, (_, i) => yMin + (yRange * i) / 4);
  const _defaultYFmt = v => {
    if (v >= 1e6) return (v / 1e6).toFixed(0) + 'M';
    if (v >= 1e3) return (v / 1e3).toFixed(0) + 'K';
    return v.toFixed(1);
  };
  const yAxisSvg = yTicks.map(v => {
    const label = (yFmt || _defaultYFmt)(v);
    return `<text x="${pad.left - 6}" y="${toY(v).toFixed(1)}" text-anchor="end" dominant-baseline="middle" font-size="9" fill="var(--muted)">${label}</text>
            <line x1="${pad.left}" y1="${toY(v).toFixed(1)}" x2="${pad.left + cw}" y2="${toY(v).toFixed(1)}" stroke="var(--border)" stroke-width="0.5"/>`;
  }).join('');

  const xStep = (xMax - xMin) / 4;
  const xAxisSvg = [0, 1, 2, 3, 4].map(i => {
    const xv = xMin + xStep * i;
    const label = opts.xFmt ? opts.xFmt(xv) : xv.toFixed(0);
    return `<text x="${toX(xv).toFixed(1)}" y="${height - 8}" text-anchor="middle" font-size="9" fill="var(--muted)">${label}</text>`;
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
    <text font-family="monospace" font-size="9" font-weight="700" fill="var(--accent)"
          x="${(bx+8).toFixed(1)}" y="${(by+14).toFixed(1)}">Hey Grinner! I'm here</text>
    <text font-family="monospace" font-size="9" fill="var(--text)"
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

// ── Charts tab ────────────────────────────────────────────────────────────────

async function loadCharts() {
  const COIN = window.GRINSCAN_NETWORK === 'testnet' ? 'tGRIN' : 'GRIN';

  if (window.GRINSCAN_NETWORK !== 'mainnet') {
    const el = document.getElementById('charts-price-stats');
    if (el) el.style.display = 'none';
  }

  try {
    const fetches = [fetch('/api/tip')];
    if (window.GRINSCAN_NETWORK === 'mainnet') fetches.push(fetch('/api/price'));
    const results = await Promise.all(fetches);

    const { height } = await results[0].json();
    const supply  = height * 60;
    const supplyM = supply / 1e6;
    const elapsed = (Date.now() / 1000 - GENESIS_UNIX) / (365.25 * 86400);
    const inflation = (365.25 * 24 * 3600 / supply) * 100;

    setText('em-supply',     fmtNum(supply) + ' ' + COIN);
    setText('em-block',      '#' + fmtNum(height));
    setText('em-reward',     '60 ' + COIN + ' / block');
    setText('em-reward-sub', '1 ' + COIN + ' / sec');
    setText('em-inflation',  inflation.toFixed(1) + '% / year');
    setText('em-years',      elapsed.toFixed(1) + ' years since genesis');

    const GENESIS_YEAR = 2019;
    const nowYear      = GENESIS_YEAR + elapsed;
    const supplyYMax   = 50 * 31.56;

    const supplyPoints = [];
    for (let yr = 0; yr <= 50; yr += 0.5) supplyPoints.push([GENESIS_YEAR + yr, yr * 31.56]);
    const supplyEl = document.getElementById('chart-supply');
    if (supplyEl) supplyEl.innerHTML = makeSVG(supplyPoints, 700, 200, {
      xMin: GENESIS_YEAR, xMax: GENESIS_YEAR + 50, yMin: 0, yMax: supplyYMax,
      color: 'var(--accent)', dotX: nowYear, dotY: supplyM,
      xFmt: v => v >= GENESIS_YEAR + 50 ? '∞' : v.toFixed(0),
      yFmt: v => v >= supplyYMax - 0.01 ? '∞' : v.toFixed(0) + 'M',
      dotLabel: `${supplyM.toFixed(1)}M ${COIN} · ${Math.floor(nowYear)}`,
    });

    const inflPoints = INFLATION_MILESTONES.map(([y, p]) => [GENESIS_YEAR + y, p]);
    const inflEl = document.getElementById('chart-inflation');
    if (inflEl) inflEl.innerHTML = makeSVG(inflPoints, 700, 180, {
      xMin: GENESIS_YEAR, xMax: GENESIS_YEAR + 50, yMin: 0, yMax: 100,
      color: 'var(--accent2)', dotX: nowYear, dotY: Math.min(inflation, 100),
      xFmt: v => v >= GENESIS_YEAR + 50 ? '∞' : v.toFixed(0),
      yFmt: v => v.toFixed(0) + '%',
      dotLabel: `${inflation.toFixed(1)}%/yr · ${Math.floor(nowYear)}`,
    });

    if (results[1]?.ok) {
      const priceData = await results[1].json();
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
      setText('circulating', fmtNum(supply) + ' ツ');
    }

  } catch (e) {
    console.error('loadCharts:', e);
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
    const [peers, stats] = await Promise.all([
      fetch('/api/peers').then(r => r.json()).catch(() => []),
      fetch('/api/stats').then(r => r.json()).catch(() => ({})),
    ]);

    const tipH   = stats.tip_height    != null ? Number(stats.tip_height).toLocaleString()    : '?';
    const cached = stats.cached_blocks != null ? Number(stats.cached_blocks).toLocaleString() : '?';
    setText('cached-blocks', `${cached} (tip #${tipH})`);
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

// ── Init ─────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('.gs-tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });
  switchTab('about');
});
