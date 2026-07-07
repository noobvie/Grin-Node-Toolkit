// tiny-explorer.js — frontend for index.html, block.html, 404.html.
// Reads server-injected window.TINYEXP_* globals; talks to /api/*.

// ── Formatters ────────────────────────────────────────────────────────────────

function fmtNum(n) { return n == null ? '—' : Number(n).toLocaleString(); }
function fmtHashShort(h) { return h ? h.slice(0, 10) + '…' + h.slice(-6) : '—'; }

function fmtAge(ts) {
  const s = Math.floor(Date.now() / 1000) - ts;
  if (s < 0) return 'just now';
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86400) + 'd ago';
}
function ageClass(ts) {
  const s = Math.floor(Date.now() / 1000) - ts;
  if (s < 300) return '';
  if (s < 1800) return 'age-warn';
  return 'age-old';
}
function fmtFee(nano) {
  if (!nano) return '—';
  return (nano / 1e9).toFixed(9).replace(/\.?0+$/, '') + ' ツ';
}
function fmtHashrate(gps) {
  if (gps == null) return '—';
  if (gps >= 1e6) return (gps / 1e6).toFixed(2) + ' MG/s';
  if (gps >= 1e3) return (gps / 1e3).toFixed(2) + ' kG/s';
  return gps.toFixed(2) + ' G/s';
}
function fmtDifficulty(d) {
  if (d == null) return '—';
  const n = Number(d);
  if (n >= 1e15) return (n / 1e15).toFixed(2) + ' P';
  if (n >= 1e12) return (n / 1e12).toFixed(2) + ' T';
  if (n >= 1e9)  return (n / 1e9).toFixed(2)  + ' G';
  if (n >= 1e6)  return (n / 1e6).toFixed(1)  + ' M';
  if (n >= 1e3)  return (n / 1e3).toFixed(1)  + ' K';
  return String(n);
}
function fmtMoneyCap(n) {
  if (n == null || isNaN(n) || n === 0) return '—';
  if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
  return '$' + n.toFixed(2);
}

// ── Toast ─────────────────────────────────────────────────────────────────────

let _toastTimer = null;
function toast(msg) {
  const t = document.getElementById('tx-toast');
  if (!t) return;
  t.textContent = msg; t.classList.add('show');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => t.classList.remove('show'), 4000);
}

function copyText(text, btn) {
  navigator.clipboard.writeText(text).then(() => {
    if (!btn) return;
    const o = btn.textContent; btn.textContent = 'Copied'; btn.classList.add('copied');
    setTimeout(() => { btn.textContent = o; btn.classList.remove('copied'); }, 1600);
  }).catch(() => {});
}

// ── Theme toggle ────────────────────────────────────────────────────────────────

function initTheme() {
  const root = document.documentElement;
  const stored = localStorage.getItem('tinyexp-theme');
  if (stored) root.setAttribute('data-theme', stored);
  const btn = document.getElementById('tx-theme-toggle');
  function icon() {
    const dark = root.getAttribute('data-theme') === 'dark'
      || (!root.getAttribute('data-theme') && matchMedia('(prefers-color-scheme: dark)').matches);
    if (btn) btn.textContent = dark ? '☀' : '☾';
  }
  icon();
  if (btn) btn.addEventListener('click', () => {
    const cur = root.getAttribute('data-theme')
      || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    const next = cur === 'dark' ? 'light' : 'dark';
    root.setAttribute('data-theme', next);
    localStorage.setItem('tinyexp-theme', next);
    icon();
  });
}

// ── Slogan + footer + search ─────────────────────────────────────────────────

function initChrome() {
  const sl = document.getElementById('tx-slogan');
  if (sl && window.TINYEXP_SLOGAN) sl.textContent = window.TINYEXP_SLOGAN;

  const ft = document.getElementById('tx-footer-text');
  if (ft) {
    const ver = window.TINYEXP_VERSION ? ' v' + window.TINYEXP_VERSION : '';
    ft.innerHTML =
      `Tiny Explorer${ver} &nbsp;·&nbsp; ` +
      `<a href="https://grinscan.net" target="_blank" rel="noopener">GrinScan</a>` +
      ` &nbsp;·&nbsp; <a href="https://forum.grin.mw" target="_blank" rel="noopener">Grin Forum</a>` +
      ` &nbsp;·&nbsp; <a href="https://github.com/noobvie/Grin-Node-Toolkit" target="_blank" rel="noopener">Node Toolkit</a>` +
      ` &nbsp;·&nbsp; Made with &#10084;&#65039; from Saigon ` +
      `<svg viewBox="0 0 27 18" width="21" height="14" role="img" aria-label="Yellow flag with three red stripes" style="vertical-align:-2px;border-radius:2px">` +
      `<rect width="27" height="18" fill="#FFCD00"/><rect y="4" width="27" height="2" fill="#DA251D"/>` +
      `<rect y="8" width="27" height="2" fill="#DA251D"/><rect y="12" width="27" height="2" fill="#DA251D"/></svg>`;
  }

  const form = document.getElementById('tx-search-form');
  const inp  = document.getElementById('tx-search-input');
  if (form && inp) {
    form.addEventListener('submit', e => {
      e.preventDefault();
      const q = inp.value.trim();
      if (q) window.location.href = '/block/' + encodeURIComponent(q);
    });
    document.addEventListener('keydown', e => {
      if (e.key === '/' && document.activeElement !== inp) { e.preventDefault(); inp.focus(); }
      if (e.key === 'Escape') inp.blur();
    });
  }
}

// ── INDEX PAGE ────────────────────────────────────────────────────────────────

let _prevTip = 0;

async function pollStats() {
  try {
    const r = await fetch('/api/stats');
    if (!r.ok) return;
    const s = await r.json();

    setText('stat-tip', fmtNum(s.tip_height));
    if (_prevTip && s.tip_height > _prevTip) toast('New block #' + fmtNum(s.tip_height));
    _prevTip = s.tip_height;

    setText('stat-hashrate', fmtHashrate(s.hashrate_gps));
    setText('stat-difficulty', fmtDifficulty(s.difficulty));
    setText('stat-supply', s.supply != null ? fmtNum(s.supply) + ' ツ' : '—');
    setText('stat-marketcap', fmtMoneyCap(s.market_cap));

    const priceEl = document.getElementById('stat-price');
    if (priceEl) priceEl.textContent = (s.price_usd != null && s.price_btc != null)
      ? '$' + s.price_usd.toFixed(4) + ' / ' + Math.round(s.price_btc * 1e8) + ' sat'
      : '—';
    const chEl = document.getElementById('stat-change');
    if (chEl) {
      if (s.change_24h_pct != null) {
        chEl.textContent = (s.change_24h_pct >= 0 ? '+' : '') + s.change_24h_pct.toFixed(2) + '% · 24h';
        chEl.style.color = s.change_24h_pct > 0 ? 'var(--green)' : s.change_24h_pct < 0 ? 'var(--red)' : '';
      } else { chEl.textContent = ''; }
    }

    // Node peers — 30d (world.grin.money) or local fallback
    const peersCard = document.getElementById('card-peers');
    setText('stat-peers', s.peers_count != null ? fmtNum(s.peers_count) : '—');
    const peersLabel = document.getElementById('label-peers-text');
    if (peersLabel && s.peers_label) peersLabel.textContent = s.peers_label;
    const peersSub = document.getElementById('stat-peers-sub');
    if (peersSub) peersSub.textContent = s.peers_source === 'local' ? 'live from this node' :
                                         s.peers_source === 'world30d' ? 'distinct · 30 days' : '';
    if (peersCard && s.peers_count == null) peersCard.style.display = 'none';

    setText('stat-g1', s.g1_per_day != null ? s.g1_per_day.toFixed(2) + ' ツ' : '—');
  } catch {}
}

function setText(id, val) { const el = document.getElementById(id); if (el) el.textContent = val; }

function blockRow(b) {
  const tr = document.createElement('tr');
  tr.innerHTML =
    `<td class="col-h">${fmtNum(b.height)}</td>` +
    `<td class="tx-hash" title="${b.hash || ''}">${fmtHashShort(b.hash)}</td>` +
    `<td class="${ageClass(b.timestamp)}" data-ts="${b.timestamp}">${fmtAge(b.timestamp)}</td>` +
    `<td>${b.tx_count ?? 0}</td>` +
    `<td>${fmtFee(b.fee_total)}</td>`;
  tr.addEventListener('click', () => { window.location.href = '/block/' + b.height; });
  return tr;
}

async function loadLatest() {
  try {
    const r = await fetch('/api/latest?n=20');
    if (!r.ok) return;
    const blocks = await r.json();
    const tb = document.getElementById('blocks-tbody');
    if (!tb) return;
    tb.innerHTML = '';
    blocks.forEach(b => tb.appendChild(blockRow(b)));
    const up = document.getElementById('tx-updated');
    if (up) up.textContent = 'Updated ' + new Date().toLocaleTimeString();
  } catch {}
}

function startAgeTick() {
  setInterval(() => {
    document.querySelectorAll('[data-ts]').forEach(el => {
      const ts = parseInt(el.dataset.ts);
      el.textContent = fmtAge(ts);
      el.className = el.className.replace(/age-\w+/g, '').trim() + ' ' + ageClass(ts);
    });
  }, 1000);
}

function initIndex() {
  pollStats();
  loadLatest();
  startAgeTick();
  setInterval(() => { pollStats(); loadLatest(); }, 30000);
}

// ── BLOCK DETAIL PAGE ───────────────────────────────────────────────────────────

function refFromPath() {
  // /block/<ref>
  const m = window.location.pathname.match(/\/block\/([^/?#]+)/);
  return m ? decodeURIComponent(m[1]) : '';
}

function row(label, value, copyVal) {
  const div = document.createElement('div');
  div.className = 'tx-row';
  const l = document.createElement('div'); l.className = 'tx-row-label'; l.textContent = label;
  const v = document.createElement('div'); v.className = 'tx-row-value'; v.textContent = value;
  div.appendChild(l); div.appendChild(v);
  if (copyVal) {
    const b = document.createElement('button'); b.className = 'tx-copy'; b.textContent = 'Copy';
    b.addEventListener('click', () => copyText(copyVal, b));
    div.appendChild(b);
  } else {
    const spacer = document.createElement('span'); div.appendChild(spacer);
  }
  return div;
}

function kernelBadge(features) {
  const f = (features || '').toLowerCase();
  if (f === 'coinbase') return ['badge-coinbase', 'COINBASE'];
  if (f.includes('locked') || f.includes('height')) return ['badge-height-locked', 'HEIGHT_LOCKED'];
  return ['badge-plain', 'PLAIN'];
}

function renderBlock(block) {
  const h = block.header;
  const kernels = block.kernels || [];
  const inputs  = block.inputs  || [];
  const outputs = block.outputs || [];
  const ts = Math.floor(new Date(h.timestamp).getTime() / 1000);
  const txCount = kernels.filter(k => k.features !== 'Coinbase').length;
  const feeTotal = kernels.filter(k => k.features !== 'Coinbase').reduce((s, k) => s + (k.fee || 0), 0);

  document.title = 'Block #' + fmtNum(h.height) + ' — ' + (window.TINYEXP_DOMAIN || 'Tiny Explorer');
  setText('block-title', 'Block #' + fmtNum(h.height));

  const rows = document.getElementById('block-rows');
  rows.innerHTML = '';
  rows.appendChild(row('Height', fmtNum(h.height)));
  rows.appendChild(row('Hash', h.hash || '—', h.hash));
  rows.appendChild(row('Previous', h.previous || '—', h.previous));
  rows.appendChild(row('Timestamp', new Date(h.timestamp).toUTCString() + '  (' + fmtAge(ts) + ')'));
  if (block._prev_timestamp) rows.appendChild(row('Block time', (ts - block._prev_timestamp) + 's'));
  rows.appendChild(row('Confirmations', block._confirmations != null ? fmtNum(block._confirmations) : '—'));
  rows.appendChild(row('Reward', '60 ツ' + (feeTotal ? '  + ' + fmtFee(feeTotal) + ' fees' : '')));
  rows.appendChild(row('Difficulty', fmtNum(h.total_difficulty) + '  (cumulative)'));
  if (h.edge_bits != null) rows.appendChild(row('Proof of Work', 'Cuckatoo' + h.edge_bits + ' (C' + h.edge_bits + ')'));
  if (h.nonce != null) rows.appendChild(row('Nonce', String(h.nonce), String(h.nonce)));
  if (h.version != null) rows.appendChild(row('Version', String(h.version)));
  if (h.output_root) rows.appendChild(row('Output root', h.output_root, h.output_root));
  if (h.range_proof_root) rows.appendChild(row('Range-proof root', h.range_proof_root, h.range_proof_root));
  if (h.kernel_root) rows.appendChild(row('Kernel root', h.kernel_root, h.kernel_root));
  if (h.total_kernel_offset) rows.appendChild(row('Kernel offset', h.total_kernel_offset, h.total_kernel_offset));
  rows.appendChild(row('Counts', inputs.length + ' inputs · ' + outputs.length + ' outputs · ' +
    kernels.length + ' kernels · ' + txCount + ' tx'));

  // Kernels
  const kBody = document.getElementById('kernels-body');
  setText('kernels-heading', 'Kernels (' + kernels.length + ')');
  kBody.innerHTML = '';
  kernels.forEach(k => {
    const [cls, label] = kernelBadge(k.features);
    const item = document.createElement('div'); item.className = 'tx-item';
    const badge = document.createElement('span'); badge.className = 'badge ' + cls; badge.textContent = label;
    const fee = document.createElement('span'); fee.style.color = 'var(--text-soft)';
    fee.textContent = 'fee: ' + (k.features !== 'Coinbase' && k.fee ? fmtFee(k.fee) : '—');
    const excess = document.createElement('span'); excess.className = 'commit'; excess.textContent = k.excess || '';
    item.appendChild(badge); item.appendChild(fee);
    if (k.lock_height) { const lh = document.createElement('span'); lh.style.color = 'var(--text-soft)'; lh.textContent = 'lock: ' + fmtNum(k.lock_height); item.appendChild(lh); }
    item.appendChild(excess);
    if (k.excess) { const b = document.createElement('button'); b.className = 'tx-copy'; b.textContent = 'Copy'; b.addEventListener('click', () => copyText(k.excess, b)); item.appendChild(b); }
    kBody.appendChild(item);
  });

  // Inputs
  const iBody = document.getElementById('inputs-body');
  setText('inputs-heading', 'Inputs (' + inputs.length + ')');
  iBody.innerHTML = '';
  if (!inputs.length) { iBody.innerHTML = '<div class="tx-empty">No inputs — coinbase-only block.</div>'; }
  else inputs.forEach(inp => {
    const commit = typeof inp === 'string' ? inp : (inp.commit || JSON.stringify(inp));
    iBody.appendChild(commitItem(commit));
  });

  // Outputs
  const oBody = document.getElementById('outputs-body');
  setText('outputs-heading', 'Outputs (' + outputs.length + ')');
  oBody.innerHTML = '';
  outputs.forEach(o => {
    const isCb = (o.output_type || '').toLowerCase() === 'coinbase';
    const item = document.createElement('div'); item.className = 'tx-item';
    const badge = document.createElement('span'); badge.className = 'badge ' + (isCb ? 'badge-coinbase' : 'badge-plain'); badge.textContent = isCb ? 'COINBASE' : 'PLAIN';
    const spent = document.createElement('span'); spent.className = 'spent-tag ' + (o.spent ? 'spent' : 'unspent'); spent.textContent = o.spent ? 'SPENT' : 'UNSPENT';
    const commit = document.createElement('span'); commit.className = 'commit'; commit.textContent = o.commit || '';
    item.appendChild(badge); item.appendChild(spent); item.appendChild(commit);
    if (o.commit) { const b = document.createElement('button'); b.className = 'tx-copy'; b.textContent = 'Copy'; b.addEventListener('click', () => copyText(o.commit, b)); item.appendChild(b); }
    oBody.appendChild(item);
  });

  // Raw JSON
  const raw = document.getElementById('raw-json');
  if (raw) raw.textContent = JSON.stringify(block, null, 2);

  // Prev / Next
  const prev = document.getElementById('nav-prev');
  const next = document.getElementById('nav-next');
  if (prev) { if (h.height > 0) { prev.href = '/block/' + (h.height - 1); prev.textContent = '← #' + fmtNum(h.height - 1); } else { prev.style.display = 'none'; } }
  if (next) { next.href = '/block/' + (h.height + 1); next.textContent = '#' + fmtNum(h.height + 1) + ' →'; }
  document.addEventListener('keydown', e => {
    if (e.key === 'ArrowLeft' && h.height > 0) window.location.href = '/block/' + (h.height - 1);
    if (e.key === 'ArrowRight') window.location.href = '/block/' + (h.height + 1);
  });

  document.getElementById('block-loading').style.display = 'none';
  document.getElementById('block-content').style.display = '';
}

function commitItem(commit) {
  const item = document.createElement('div'); item.className = 'tx-item';
  const c = document.createElement('span'); c.className = 'commit'; c.textContent = commit;
  const b = document.createElement('button'); b.className = 'tx-copy'; b.textContent = 'Copy';
  b.addEventListener('click', () => copyText(commit, b));
  item.appendChild(c); item.appendChild(b);
  return item;
}

async function loadBlock() {
  const ref = refFromPath();
  if (!ref) { window.location.replace('/404.html'); return; }
  try {
    // fetch tip in parallel for confirmations
    const [br, tr] = await Promise.all([
      fetch('/api/block/' + encodeURIComponent(ref)),
      fetch('/api/tip').catch(() => null),
    ]);
    if (br.status === 404) { window.location.replace('/404.html?q=' + encodeURIComponent(ref)); return; }
    if (!br.ok) { showBlockError('Server error ' + br.status); return; }
    const block = await br.json();
    if (tr && tr.ok) {
      const tip = await tr.json();
      if (tip.height != null && block.header) block._confirmations = tip.height - block.header.height + 1;
    }
    renderBlock(block);
  } catch (e) {
    showBlockError('Failed to load block: ' + e.message);
  }
}

function showBlockError(msg) {
  const l = document.getElementById('block-loading');
  if (l) l.innerHTML = '<div class="tx-error"><h2>Unable to load block</h2><p>' + msg + '</p>' +
    '<p><a href="/">← Back to explorer</a></p></div>';
}

// ── 404 PAGE ────────────────────────────────────────────────────────────────────

function init404() {
  const q = new URLSearchParams(window.location.search).get('q');
  const qEl = document.getElementById('tx-404-query');
  if (qEl && q) qEl.textContent = '"' + q + '"';
  const wrap = document.getElementById('tx-fallbacks');
  const fallbacks = (window.TINYEXP_FALLBACKS && window.TINYEXP_FALLBACKS.length)
    ? window.TINYEXP_FALLBACKS
    : [
        { name: 'Grincoin.org', url: 'https://grincoin.org', blurb: 'Full archive explorer — deep block bodies since genesis.' },
        { name: 'GrinScan', url: 'https://grinscan.net', blurb: 'Dual-network explorer with charts, peers, price, and a REST API.' },
      ];
  if (wrap) wrap.innerHTML = fallbacks.map(f =>
    `<a class="tx-fallback" href="${f.url}" target="_blank" rel="noopener">` +
    `<div class="name">${f.name} ↗</div><div class="blurb">${f.blurb || ''}</div></a>`).join('');
}

// ── Init ─────────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  initTheme();
  initChrome();
  const page = document.body.dataset.page;
  if (page === 'index') initIndex();
  if (page === 'block') loadBlock();
  if (page === 'notfound') init404();
});
