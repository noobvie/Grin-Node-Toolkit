// app.js — GrinScan frontend: index.html + block.html logic

// ── Utilities ────────────────────────────────────────────────────────────────

function fmtNum(n) {
  if (n == null) return '—';
  return Number(n).toLocaleString();
}

function fmtHash(h) {
  if (!h) return '—';
  return '0x' + h.slice(0, 8) + '…' + h.slice(-4);
}

function fmtAge(ts) {
  const secs = Math.floor(Date.now() / 1000) - ts;
  if (secs < 0) return 'just now';
  if (secs < 60) return secs + 's ago';
  if (secs < 3600) return Math.floor(secs / 60) + 'm ' + (secs % 60) + 's ago';
  if (secs < 86400) return Math.floor(secs / 3600) + 'h ago';
  return Math.floor(secs / 86400) + 'd ago';
}

function ageClass(ts) {
  const secs = Math.floor(Date.now() / 1000) - ts;
  if (secs < 300) return '';
  if (secs < 1800) return 'age-warn';
  return 'age-old';
}

function fmtFee(nano) {
  if (!nano) return '—';
  const grin = nano / 1_000_000_000;
  return grin.toFixed(6).replace(/\.?0+$/, '') + ' ツ';
}

function fmtHashrate(gps) {
  if (gps == null) return '—';
  return gps.toFixed(1) + ' GPS';
}

function fmtDifficulty(d) {
  if (d == null) return '—';
  if (d >= 1_000_000) return (d / 1_000_000).toFixed(2) + ' M';
  if (d >= 1_000) return (d / 1_000).toFixed(1) + ' K';
  return String(d);
}

function kernelBadgeClass(features) {
  if (!features) return 'badge-plain';
  const f = features.toLowerCase();
  if (f === 'coinbase') return 'badge-coinbase';
  if (f.includes('locked') || f.includes('height')) return 'badge-height-locked';
  return 'badge-plain';
}

function kernelBadgeLabel(features) {
  if (!features) return 'PLAIN';
  const f = features.toUpperCase();
  if (f === 'COINBASE') return 'COINBASE';
  if (f.includes('LOCKED') || f.includes('HEIGHT')) return 'HEIGHT_LOCKED';
  return 'PLAIN';
}

// ── Toast ────────────────────────────────────────────────────────────────────

let _toastTimer = null;
function showToast(msg) {
  const t = document.getElementById('gs-toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => t.classList.remove('show'), 5000);
}

// ── Copy to clipboard ────────────────────────────────────────────────────────

function copyText(text, btn) {
  navigator.clipboard.writeText(text).then(() => {
    if (!btn) return;
    const orig = btn.textContent;
    btn.textContent = 'Copied!';
    btn.classList.add('copied');
    setTimeout(() => { btn.textContent = orig; btn.classList.remove('copied'); }, 2000);
  }).catch(() => {});
}

// ── Sparkline ────────────────────────────────────────────────────────────────

const _sparkValues = [];
function updateSparkline(difficulty) {
  _sparkValues.push(difficulty);
  if (_sparkValues.length > 10) _sparkValues.shift();
  const canvas = document.getElementById('sparkline');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  if (_sparkValues.length < 2) return;
  const max = Math.max(..._sparkValues);
  const min = Math.min(..._sparkValues);
  const range = max - min || 1;
  const step = w / (_sparkValues.length - 1);
  const style = getComputedStyle(document.documentElement);
  ctx.strokeStyle = style.getPropertyValue('--accent').trim() || '#ff9900';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  _sparkValues.forEach((v, i) => {
    const x = i * step;
    const y = h - ((v - min) / range) * (h - 4) - 2;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.stroke();
}

// ── Stall banner ─────────────────────────────────────────────────────────────

function setStallBanner(stalled) {
  let banner = document.getElementById('stall-banner');
  if (stalled) {
    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'stall-banner';
      banner.className = 'gs-stall-banner';
      banner.textContent = '⚠  No new blocks for 2+ minutes — node may be syncing or offline';
      document.body.insertBefore(banner, document.body.firstChild);
    }
  } else {
    if (banner) banner.remove();
  }
}

// ── INDEX PAGE ───────────────────────────────────────────────────────────────

let _prevTipHeight = 0;
let _blockOffset = 0;
const _LIMIT = 20;

function renderBlockRow(b) {
  const tr = document.createElement('tr');
  tr.dataset.height = b.height;
  tr.innerHTML = `
    <td class="col-height"><strong>${fmtNum(b.height)}</strong></td>
    <td class="col-hash" title="${b.hash || ''}">${fmtHash(b.hash)}</td>
    <td class="col-age ${ageClass(b.timestamp)}" data-ts="${b.timestamp}">${fmtAge(b.timestamp)}</td>
    <td class="col-txs">${b.tx_count ?? 0}</td>
    <td class="col-fees">${fmtFee(b.fee_total)}</td>`;
  tr.addEventListener('click', () => {
    window.location.href = '/block.html?h=' + b.height;
  });
  return tr;
}

async function fetchAndRenderBlocks(append) {
  try {
    const r = await fetch(`/api/blocks?limit=${_LIMIT}&offset=${_blockOffset}`);
    const blocks = await r.json();
    const tbody = document.getElementById('blocks-tbody');
    if (!tbody) return;
    if (!append) {
      tbody.innerHTML = '';
      _blockOffset = 0;
    }
    blocks.forEach(b => tbody.appendChild(renderBlockRow(b)));
    _blockOffset += blocks.length;
    const btn = document.getElementById('load-more-btn');
    if (btn) btn.style.display = blocks.length < _LIMIT ? 'none' : 'block';
  } catch (e) {
    console.error('fetchAndRenderBlocks:', e);
  }
}

async function pollStats() {
  try {
    const r = await fetch('/api/stats');
    const s = await r.json();

    // Tip height with counter animation
    const tipEl = document.getElementById('stat-tip');
    if (tipEl) {
      if (_prevTipHeight > 0 && s.tip_height > _prevTipHeight) {
        showToast('New block #' + fmtNum(s.tip_height));
        // Animate tip counter
        let cur = _prevTipHeight;
        const step = () => {
          if (cur < s.tip_height) {
            cur++;
            tipEl.textContent = fmtNum(cur);
            requestAnimationFrame(step);
          } else {
            tipEl.textContent = fmtNum(s.tip_height);
          }
        };
        requestAnimationFrame(step);
        // Refresh block list
        _blockOffset = 0;
        fetchAndRenderBlocks(false);
      } else {
        tipEl.textContent = fmtNum(s.tip_height);
      }
    }

    const hrEl = document.getElementById('stat-hashrate');
    const diffEl = document.getElementById('stat-difficulty');
    const peersEl = document.getElementById('stat-peers');
    if (hrEl)   hrEl.textContent   = fmtHashrate(s.hashrate_gps);
    if (diffEl) diffEl.textContent = fmtDifficulty(s.difficulty);
    if (peersEl) peersEl.textContent = fmtNum(s.peer_count);

    updateSparkline(s.difficulty);
    setStallBanner(s.stalled);
    _prevTipHeight = s.tip_height;
  } catch {}
}

function startAgeCountdown() {
  setInterval(() => {
    document.querySelectorAll('[data-ts]').forEach(el => {
      const ts = parseInt(el.dataset.ts);
      el.textContent = fmtAge(ts);
      el.className = el.className.replace(/age-\w+/g, '').trim() + ' ' + ageClass(ts);
    });
  }, 1000);
}

// Search
function initSearch() {
  const form = document.getElementById('search-form');
  const inp  = document.getElementById('search-input');
  if (!form || !inp) return;
  form.addEventListener('submit', e => {
    e.preventDefault();
    const q = inp.value.trim();
    if (!q) return;
    window.location.href = '/block.html?h=' + encodeURIComponent(q);
  });
  // "/" shortcut
  document.addEventListener('keydown', e => {
    if (e.key === '/' && document.activeElement !== inp) {
      e.preventDefault();
      inp.focus();
    }
    if (e.key === 'Escape') inp.blur();
  });
}

// Load more
function initLoadMore() {
  const btn = document.getElementById('load-more-btn');
  if (!btn) return;
  btn.addEventListener('click', () => fetchAndRenderBlocks(true));
}

// ── BLOCK DETAIL PAGE ────────────────────────────────────────────────────────

function setBlockDetail(block) {
  const h = block.header;
  const kernels = block.kernels || [];
  const outputs = block.outputs || [];
  const ts = Math.floor(new Date(h.timestamp).getTime() / 1000);
  const txCount = kernels.filter(k => k.features !== 'Coinbase').length;

  // Title
  document.title = `Block #${fmtNum(h.height)} — GrinScan`;

  // Breadcrumb
  const bc = document.getElementById('block-breadcrumb');
  if (bc) bc.textContent = `Block #${fmtNum(h.height)}`;

  // Header rows
  function setRow(id, val, copyVal) {
    const row = document.getElementById(id);
    if (!row) return;
    row.querySelector('.gs-detail-value-text').textContent = val;
    const btn = row.querySelector('.gs-copy-btn');
    if (btn && copyVal) btn.addEventListener('click', () => copyText(copyVal, btn));
    else if (btn && !copyVal) btn.style.display = 'none';
  }

  setRow('row-height',     fmtNum(h.height), null);
  setRow('row-hash',       h.hash || '—',     h.hash);
  setRow('row-prev',       h.previous || '—', h.previous);
  setRow('row-time',       new Date(h.timestamp).toUTCString() + '  (' + fmtAge(ts) + ')', null);
  setRow('row-difficulty', fmtNum(h.total_difficulty), null);
  setRow('row-kernels',    kernels.length + '  (' + txCount + ' transactions + ' + (kernels.length - txCount) + ' coinbase)', null);
  setRow('row-outputs',    outputs.length, null);

  // Kernels list
  const kList = document.getElementById('kernels-list');
  if (kList) {
    kList.innerHTML = '';
    kernels.forEach(k => {
      const div = document.createElement('div');
      div.className = 'gs-kernel-row';
      const fee = k.features !== 'Coinbase' && k.fee ? fmtFee(k.fee) : '—';
      div.innerHTML = `
        <span class="badge ${kernelBadgeClass(k.features)}">${kernelBadgeLabel(k.features)}</span>
        <span style="color:var(--muted);font-size:12px;">fee: ${fee}</span>
        <span class="gs-kernel-excess">${k.excess || ''}</span>`;
      kList.appendChild(div);
    });
  }

  // Prev / Next nav
  const prevBtn = document.getElementById('nav-prev');
  const nextBtn = document.getElementById('nav-next');
  if (prevBtn) {
    if (h.height > 1) {
      prevBtn.href = '/block.html?h=' + (h.height - 1);
      prevBtn.textContent = '← Block #' + fmtNum(h.height - 1);
    } else {
      prevBtn.removeAttribute('href');
      prevBtn.style.opacity = '0.3';
      prevBtn.style.pointerEvents = 'none';
    }
  }
  if (nextBtn) {
    nextBtn.href = '/block.html?h=' + (h.height + 1);
    nextBtn.textContent = 'Block #' + fmtNum(h.height + 1) + ' →';
  }

  // Keyboard nav
  document.addEventListener('keydown', e => {
    if (e.key === 'ArrowLeft'  && h.height > 1) window.location.href = '/block.html?h=' + (h.height - 1);
    if (e.key === 'ArrowRight') window.location.href = '/block.html?h=' + (h.height + 1);
  });
}

async function loadBlockDetail() {
  const params = new URLSearchParams(window.location.search);
  const ref = params.get('h');
  if (!ref) { showBlockError('No block reference in URL.'); return; }

  const errBox = document.getElementById('block-error');
  const detailBox = document.getElementById('block-detail-wrap');

  try {
    const r = await fetch('/api/block/' + encodeURIComponent(ref));
    if (r.status === 404) {
      const data = await r.json().catch(() => ({}));
      if (data.hint === 'cache_miss') {
        showCacheMiss();
      } else {
        showBlockError('Block not found.');
      }
      return;
    }
    if (!r.ok) { showBlockError('Server error ' + r.status); return; }
    const block = await r.json();
    if (detailBox) detailBox.style.display = '';
    if (errBox) errBox.style.display = 'none';
    setBlockDetail(block);
  } catch (e) {
    showBlockError('Failed to load block: ' + e.message);
  }
}

function showBlockError(msg) {
  const errBox = document.getElementById('block-error');
  const detailBox = document.getElementById('block-detail-wrap');
  if (detailBox) detailBox.style.display = 'none';
  if (errBox) {
    errBox.style.display = '';
    const msgEl = errBox.querySelector('.error-msg');
    if (msgEl) msgEl.textContent = msg;
  }
}

function showCacheMiss() {
  const errBox = document.getElementById('block-error');
  const detailBox = document.getElementById('block-detail-wrap');
  const cacheSize = window.GRINSCAN_BLOCKS_CACHE || 500;
  if (detailBox) detailBox.style.display = 'none';
  if (errBox) {
    errBox.style.display = '';
    errBox.innerHTML = `
      <h3>Block not found</h3>
      <p>This node caches the last ~${cacheSize} blocks (~2 weeks of data).<br>
         Older blocks are not available on this instance.</p>
      <p>Try an archive explorer: <a href="https://grincoin.org/blocks" target="_blank" rel="noopener">grincoin.org/blocks</a></p>`;
  }
}

// ── Nav active state (shared across all pages) ───────────────────────────────

function setNavActive() {
  const path = window.location.pathname;
  document.querySelectorAll('.nav-link').forEach(a => {
    const page = a.dataset.page;
    let active = false;
    if (page === 'explorer') active = (path === '/' || path === '/index.html' || path === '/block.html');
    if (page === 'info')     active = path === '/info.html';
    a.classList.toggle('active', active);
  });
}

// ── Footer ───────────────────────────────────────────────────────────────────

function renderFooter() {
  const el = document.getElementById('gs-footer-text');
  if (!el) return;
  const ver  = window.GRINSCAN_VERSION || '';
  const net  = (window.GRINSCAN_NETWORK || 'mainnet').toUpperCase();
  el.innerHTML = `GrinScan${ver ? ' v' + ver : ''} · ${net}
    · <a href="https://github.com/mimblewimble/grin" target="_blank" rel="noopener">Grin Node</a>
    · Powered by <a href="https://github.com/mimblewimble/grin" target="_blank" rel="noopener">Grin Node Toolkit</a>`;
}

// ── Network badge ─────────────────────────────────────────────────────────────

function renderNetworkBadge() {
  const badge = document.getElementById('network-badge');
  if (!badge) return;
  const net = window.GRINSCAN_NETWORK || 'testnet';
  badge.textContent = net.toUpperCase() + ' ●';
  badge.className = 'gs-network-badge ' + net;
}

// ── Init ─────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  setNavActive();
  renderNetworkBadge();
  renderFooter();

  const page = document.body.dataset.page;

  if (page === 'index') {
    // Remove skeleton loaders once first data arrives
    pollStats().then(() => {
      document.querySelectorAll('.skeleton-cell').forEach(el => el.classList.remove('skeleton'));
    });
    fetchAndRenderBlocks(false);
    initSearch();
    initLoadMore();
    startAgeCountdown();
    setInterval(() => pollStats(), 30000);
  }

  if (page === 'block') {
    loadBlockDetail();
    initSearch();
  }
});
