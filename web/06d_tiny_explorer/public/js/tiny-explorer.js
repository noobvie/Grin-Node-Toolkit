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
// Compact age for the "Age" table column — the header already says "Age", so the
// per-row " ago" suffix is redundant (5m, 2h, 1d …). Prose contexts keep fmtAge.
function fmtAgeCompact(ts) { return fmtAge(ts).replace(/ ago$/, ''); }
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
      `<a href="https://grinscan.org" target="_blank" rel="noopener">GrinScan</a>` +
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
      if (q) window.location.href = searchTarget(q);
    });
    // "/" focuses the search box — but only when the visitor is not already
    // typing somewhere. Every tool page has its own field (a URL on /node-check
    // legitimately contains "/", and /slate takes a pasted multi-line slatepack),
    // so stealing focus mid-entry would eat the keystroke.
    const typing = el => !!el && (el.isContentEditable ||
      el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT');
    document.addEventListener('keydown', e => {
      if (e.key === '/' && !typing(document.activeElement)) { e.preventDefault(); inp.focus(); }
      if (e.key === 'Escape') inp.blur();
    });
  }

  initTooltips();
  initTools();
}

// Group labels for the Tools dropdown, in render order. The hub is going from
// two tools to six; six flat rows is a list, not a menu, so the rows are grouped
// under the pair table in script06_design.md ("Option D addendum — Tools hub
// expansion to six"): Verify what you were handed / Operate your own side.
//
// Membership is keyed on the row's href, NOT on DOM order, so the six page
// headers can keep carrying the rows in whatever order and still group the same
// way. A tool listed here that no page carries yet is skipped, and a group with
// no rows renders no heading — so "Operate" simply appears when the first tool
// that belongs to it ships. An href not listed here still renders, ungrouped,
// after the groups.
// Membership follows the pair table's COLUMNS, reading down (Transaction,
// Reachability, Economics). Note the design doc's illustrative 3x2 grid puts
// Emission in the second row with the operate tools; the table itself files it
// under Verify, and that is what its own one-liner says it does ("Verify 1
// tsu/sec"), so Verify is what it gets here.
const TOOLS_MENU_GROUPS = [
  { label: 'Verify',  hrefs: ['/slate', '/proof', '/wallet-check', '/emission'] },
  { label: 'Operate', hrefs: ['/node-check', '/mining'] }
];

// Rewrite #tx-tools-menu as grouped sections. The headings are labels, not menu
// items: role="presentation", no tabindex, no href — so neither the tab order
// nor the menu's accessible child list gains anything focusable.
// The Wallet Checker's one-line description is written for the tier-1-only page
// (checksum, network, .onion) because that is what ships by default and what a
// visitor gets if this script never runs. Where the operator has switched the
// Tor liveness probe on, the tool genuinely does more than the line claims — and
// "can I see whether this wallet is online before I send to it" is the reason
// most people open it, so a label that never mentions it hides the feature
// behind a page nobody had a reason to click. Runs on every shell (the tools
// menu is in all of them) and on the homepage card grid.
const WALLET_PROBE_LINE = 'Address checks — and is the wallet listening?';

function applyWalletProbeLabels() {
  if (window.TINYEXP_WALLET_PROBE !== true) return;
  document.querySelectorAll('.tx-tools-item[href="/wallet-check"] small')
    .forEach(n => { n.textContent = WALLET_PROBE_LINE; });
  document.querySelectorAll('.tx-tool-card[href="/wallet-check"] .tx-tool-line')
    .forEach(n => { n.textContent = WALLET_PROBE_LINE; });
}

function groupToolsMenu(menu) {
  const items = Array.from(menu.querySelectorAll('.tx-tools-item'));
  if (!items.length || menu.querySelector('.tx-tools-group')) return;
  const byHref = new Map();
  items.forEach(a => byHref.set(new URL(a.getAttribute('href'), location.origin).pathname, a));

  const frag = document.createDocumentFragment();
  const placed = new Set();
  TOOLS_MENU_GROUPS.forEach(group => {
    const rows = group.hrefs.map(h => byHref.get(h)).filter(Boolean);
    if (!rows.length) return;                    // no rows yet → no heading
    const h = document.createElement('div');
    h.className = 'tx-tools-group';
    h.setAttribute('role', 'presentation');
    h.textContent = group.label;
    frag.appendChild(h);
    rows.forEach(a => { frag.appendChild(a); placed.add(a); });
  });
  items.forEach(a => { if (!placed.has(a)) frag.appendChild(a); });
  menu.appendChild(frag);                        // moves the existing nodes
}

// Header "Tools" dropdown — identical markup on every page, so this runs from
// initChrome regardless of which page we're on.
function initTools() {
  const wrap = document.getElementById('tx-tools');
  const btn  = document.getElementById('tx-tools-btn');
  const menu = document.getElementById('tx-tools-menu');
  if (!wrap || !btn || !menu) return;
  groupToolsMenu(menu);
  applyWalletProbeLabels();
  function open(v) {
    wrap.classList.toggle('open', v);
    btn.setAttribute('aria-expanded', v ? 'true' : 'false');
    menu.hidden = !v;
  }
  btn.addEventListener('click', e => { e.stopPropagation(); open(menu.hidden); });
  document.addEventListener('click', e => { if (!wrap.contains(e.target)) open(false); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') open(false); });
}

// Touch-friendly tooltips: tap the ℹ icon to toggle its bubble; tapping anywhere
// else (or the bubble itself — it's pointer-events:none) or pressing Escape
// closes it. Hover-capable devices still get plain CSS hover; this only adds the
// tap behaviour that hover can't provide on touch.
function initTooltips() {
  const tips = document.querySelectorAll('.tx-info[data-tip]');
  if (!tips.length) return;
  function closeAll(except) {
    document.querySelectorAll('.tx-info.tip-open').forEach(t => {
      if (t !== except) { t.classList.remove('tip-open'); t.blur(); }
    });
  }
  tips.forEach(t => {
    t.addEventListener('click', e => {
      e.stopPropagation();               // don't let the document handler close it
      const willOpen = !t.classList.contains('tip-open');
      closeAll(t);
      if (willOpen) { t.classList.add('tip-open'); }
      else { t.classList.remove('tip-open'); t.blur(); }
    });
  });
  document.addEventListener('click', () => closeAll(null));
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeAll(null); });
}

// Route a search term to the right detail page by format. A block height is
// decimal; a block hash is 64 hex (32 bytes); a kernel excess and an output
// commitment are both 66 hex (33-byte compressed points) so they can't be told
// apart here — 66-hex goes to /kernel, whose page auto-falls-back to /output if
// the excess isn't a kernel. Unknown shapes fall through to /block for a clean
// server-side 404.
function searchTarget(q) {
  const s = q.trim().replace(/^0x/i, '');
  // A pasted slatepack goes to the client-side Slate Inspector. Carry it in the
  // query string when it is short enough to survive a URL; otherwise just open
  // the page and let the visitor paste into the (much larger) textarea.
  if (s.includes('BEGINSLATEPACK')) {
    return s.length <= 3000 ? '/slate?s=' + encodeURIComponent(s) : '/slate';
  }
  if (/^\d+$/.test(s))               return '/block/'  + encodeURIComponent(s);
  if (/^[0-9a-fA-F]{64}$/.test(s))   return '/block/'  + encodeURIComponent(s);
  if (/^[0-9a-fA-F]{66}$/.test(s))   return '/kernel/' + encodeURIComponent(s);
  return '/block/' + encodeURIComponent(s);
}

// ── Sparklines ────────────────────────────────────────────────────────────────
// Tiny inline SVG trend lines for the Hashrate/Difficulty cards. Computed purely
// client-side from the /api/latest series already fetched for the block table —
// no new endpoint, no stored history. Stroke/fill colour comes from CSS.

function sparkSvg(values) {
  const vals = values.filter(v => isFinite(v) && v > 0);
  if (vals.length < 2) return '';
  const min = Math.min(...vals), max = Math.max(...vals);
  const range = (max - min) || 1;
  const W = 100, H = 26, pad = 2;
  const pts = vals.map((v, i) => {
    const x = pad + (i / (vals.length - 1)) * (W - 2 * pad);
    const y = pad + (1 - (v - min) / range) * (H - 2 * pad);
    return x.toFixed(1) + ',' + y.toFixed(1);
  });
  const [lx, ly] = pts[pts.length - 1].split(',');
  return '<svg class="tx-spark-svg" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" aria-hidden="true">'
    + '<polyline points="' + pts.join(' ') + '" fill="none" stroke-width="1.5" '
    + 'vector-effect="non-scaling-stroke" stroke-linejoin="round" stroke-linecap="round"/>'
    + '<circle cx="' + lx + '" cy="' + ly + '" r="1.8"/></svg>';
}

// Derive per-block difficulty (Δ total_difficulty) and hashrate from the latest
// blocks (newest-first) and paint both sparklines oldest→newest, left→right.
function renderSparklines(blocks) {
  if (!Array.isArray(blocks) || blocks.length < 3) return;
  const asc = blocks.slice().sort((a, b) => a.height - b.height);
  const diffs = [], rates = [];
  for (let i = 1; i < asc.length; i++) {
    const dd = Number(asc[i].total_difficulty) - Number(asc[i - 1].total_difficulty);
    const dt = asc[i].timestamp - asc[i - 1].timestamp;
    if (dd > 0) diffs.push(dd);
    if (dd > 0 && dt > 0) rates.push(dd * 42 / dt / 16384);
  }
  const sh = document.getElementById('spark-hashrate');
  const sd = document.getElementById('spark-difficulty');
  if (sh) sh.innerHTML = sparkSvg(rates);
  if (sd) sd.innerHTML = sparkSvg(diffs);
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
        chEl.style.color = s.change_24h_pct > 0 ? 'var(--green-ink)' : s.change_24h_pct < 0 ? 'var(--red-ink)' : '';
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

    // Mempool — shown as a sub-line under Tip Height (pending vs settled); blank
    // if the node didn't answer get_pool_size.
    setText('stat-mempool', s.mempool != null
      ? fmtNum(s.mempool) + (s.mempool === 1 ? ' tx' : ' txs') + ' pending'
      : '');
  } catch {}
}

function setText(id, val) { const el = document.getElementById(id); if (el) el.textContent = val; }

function blockRow(b) {
  const tr = document.createElement('tr');
  tr.innerHTML =
    `<td class="col-h">${fmtNum(b.height)}</td>` +
    `<td class="tx-hash" title="${b.hash || ''}">${fmtHashShort(b.hash)}</td>` +
    `<td class="${ageClass(b.timestamp)}" data-ts="${b.timestamp}">${fmtAgeCompact(b.timestamp)}</td>` +
    `<td>${b.tx_count ?? 0}</td>` +
    `<td>${fmtFee(b.fee_total)}</td>`;
  tr.addEventListener('click', () => { window.location.href = '/block/' + b.height; });
  return tr;
}

const LATEST_INTERVAL_MS = 120000; // 2-min cooldown between table refreshes
let _lastUpdatedStr = '';
let _nextLatestAt   = 0;

async function loadLatest() {
  try {
    const r = await fetch('/api/latest?n=20');
    if (!r.ok) return;
    const blocks = await r.json();
    const tb = document.getElementById('blocks-tbody');
    if (!tb) return;
    tb.innerHTML = '';
    blocks.forEach(b => tb.appendChild(blockRow(b)));
    renderSparklines(blocks);
    _lastUpdatedStr = new Date().toLocaleTimeString();
    _nextLatestAt   = Date.now() + LATEST_INTERVAL_MS;
    renderUpdated();
  } catch {}
}

// "Updated 12:34:56 · next in 1:59" — the cooldown countdown, ticked every second.
function renderUpdated() {
  const up = document.getElementById('tx-updated');
  if (!up || !_lastUpdatedStr) return;
  const remain = Math.max(0, Math.round((_nextLatestAt - Date.now()) / 1000));
  const mm = Math.floor(remain / 60), ss = remain % 60;
  up.textContent = 'Updated ' + _lastUpdatedStr + ' · next in ' + mm + ':' + String(ss).padStart(2, '0');
}

// Sync badge: compare our tip to public explorers via /api/sync (server-side).
async function checkSync() {
  const el = document.getElementById('tx-sync');
  if (!el) return;
  try {
    const r = await fetch('/api/sync');
    if (!r.ok) throw new Error();
    const s = await r.json();
    if (s.synced == null) {
      el.className = 'tx-sync unknown'; el.textContent = 'sync ?';
      el.title = 'Could not reach a reference explorer';
      return;
    }
    const lag = s.lag;
    const ref = s.ref_source + ' ' + fmtNum(s.ref_height);
    const via = s.ref_count ? ' · checked vs ' + s.ref_count + ' source' + (s.ref_count === 1 ? '' : 's') : '';
    if (s.synced) {
      el.className = 'tx-sync ok'; el.textContent = 'Synced';
      el.title = 'Height ' + fmtNum(s.our_height) + ' · in step with ' + ref +
        (lag > 0 ? ' (' + lag + ' behind, within tolerance)' : lag < 0 ? ' (' + (-lag) + ' ahead)' : '') + via;
    } else {
      el.className = 'tx-sync warn'; el.textContent = lag + ' behind';
      el.title = 'Height ' + fmtNum(s.our_height) + ' vs ' + ref + ' — ' + lag + ' blocks behind' + via;
    }
  } catch {
    el.className = 'tx-sync unknown'; el.textContent = 'sync ?';
    el.title = 'Sync check unavailable';
  }
}

function startAgeTick() {
  setInterval(() => {
    document.querySelectorAll('[data-ts]').forEach(el => {
      const ts = parseInt(el.dataset.ts);
      el.textContent = fmtAgeCompact(ts);
      el.className = el.className.replace(/age-\w+/g, '').trim() + ' ' + ageClass(ts);
    });
    renderUpdated(); // tick the refresh countdown
  }, 1000);
}

function initIndex() {
  pollStats();
  loadLatest();
  checkSync();
  startAgeTick();
  // Stats (tip/price/hashrate) stay near-live at 30s; the Latest Blocks table
  // is heavier and blocks only land ~every 60s, so refresh it + the sync badge
  // on a 2-min cooldown (with a live countdown shown to the user).
  setInterval(pollStats, 30000);
  setInterval(() => { loadLatest(); checkSync(); }, LATEST_INTERVAL_MS);
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

// esc(), like its twin showEntityError below. `msg` is not always a constant:
// the catch path passes e.message, and a failed res.json() builds that message
// from a SNIPPET OF THE RESPONSE BODY — so raw bytes off the wire reached
// innerHTML here while the identical function 130 lines down escaped them.
function showBlockError(msg) {
  const l = document.getElementById('block-loading');
  if (l) l.innerHTML = '<div class="tx-error"><h2>Unable to load block</h2><p>' + esc(msg) + '</p>' +
    '<p><a href="/">← Back to explorer</a></p></div>';
}

// ── KERNEL / OUTPUT DETAIL PAGES ──────────────────────────────────────────────

// row() variant whose value is a link (e.g. → the containing block).
function rowLink(label, text, href, copyVal) {
  const div = document.createElement('div'); div.className = 'tx-row';
  const l = document.createElement('div'); l.className = 'tx-row-label'; l.textContent = label;
  const v = document.createElement('div'); v.className = 'tx-row-value';
  const a = document.createElement('a'); a.href = href; a.textContent = text; a.className = 'tx-link';
  v.appendChild(a);
  div.appendChild(l); div.appendChild(v);
  if (copyVal) {
    const b = document.createElement('button'); b.className = 'tx-copy'; b.textContent = 'Copy';
    b.addEventListener('click', () => copyText(copyVal, b));
    div.appendChild(b);
  } else { div.appendChild(document.createElement('span')); }
  return div;
}

function entityRefFromPath(kind) {
  const m = window.location.pathname.match(new RegExp('/' + kind + '/([^/?#]+)'));
  return m ? decodeURIComponent(m[1]) : '';
}

// Grin serialises kernel features either as a bare string ("Coinbase") or an
// externally-tagged object ({"Plain":{"fee":7000000}} / {"HeightLocked":{…}}).
// Normalise both to { type, fee, lock_height }.
function kernelFeatures(tk) {
  const f = tk && tk.features;
  if (typeof f === 'string') return { type: f, fee: tk.fee, lock_height: tk.lock_height };
  if (f && typeof f === 'object') {
    const type = Object.keys(f)[0] || 'Unknown';
    const inner = f[type] || {};
    const fee = typeof inner.fee === 'number' ? inner.fee : undefined;
    return { type, fee, lock_height: inner.lock_height };
  }
  return { type: 'Unknown' };
}

function showEntity() {
  const l = document.getElementById('entity-loading');
  if (l) l.style.display = 'none';
  const c = document.getElementById('entity-content');
  if (c) c.style.display = '';
}

function renderKernel(located, ref) {
  const tk = located.tx_kernel || {};
  const feat = kernelFeatures(tk);
  const excess = tk.excess || ref;

  document.title = 'Kernel ' + excess.slice(0, 12) + '… — ' + (window.TINYEXP_DOMAIN || 'Tiny Explorer');
  setText('entity-title', 'Kernel');

  const rows = document.getElementById('entity-rows');
  rows.innerHTML = '';
  rows.appendChild(row('Excess', excess, excess));
  rows.appendChild(row('Type', feat.type));
  if (feat.type !== 'Coinbase') rows.appendChild(row('Fee', feat.fee != null ? fmtFee(feat.fee) : '—'));
  if (feat.lock_height) rows.appendChild(row('Lock height', fmtNum(feat.lock_height)));
  if (located.height != null) rows.appendChild(rowLink('Block height', fmtNum(located.height), '/block/' + located.height));
  if (located._block_hash) rows.appendChild(rowLink('Block hash', fmtHashShort(located._block_hash), '/block/' + located._block_hash, located._block_hash));
  if (located._timestamp) rows.appendChild(row('Timestamp', new Date(located._timestamp * 1000).toUTCString() + '  (' + fmtAge(located._timestamp) + ')'));
  if (located._confirmations != null) rows.appendChild(row('Confirmations', fmtNum(located._confirmations)));
  if (located.mmr_index != null) rows.appendChild(row('Kernel MMR index', fmtNum(located.mmr_index)));
  if (tk.excess_sig) rows.appendChild(row('Excess signature', tk.excess_sig, tk.excess_sig));

  const raw = document.getElementById('raw-json');
  if (raw) raw.textContent = JSON.stringify(located, null, 2);
  showEntity();
}

function renderOutput(out, ref) {
  const commit = out.commit || ref;
  const isCb = (out.output_type || '').toLowerCase() === 'coinbase';

  document.title = 'Output ' + commit.slice(0, 12) + '… — ' + (window.TINYEXP_DOMAIN || 'Tiny Explorer');
  setText('entity-title', 'Output');

  const rows = document.getElementById('entity-rows');
  rows.innerHTML = '';
  rows.appendChild(row('Commitment', commit, commit));
  rows.appendChild(row('Type', isCb ? 'Coinbase' : 'Transaction'));
  rows.appendChild(row('Status', out.spent ? 'SPENT' : 'UNSPENT'));
  if (out.block_height != null) rows.appendChild(rowLink('Block height', fmtNum(out.block_height), '/block/' + out.block_height));
  if (out._block_hash) rows.appendChild(rowLink('Block hash', fmtHashShort(out._block_hash), '/block/' + out._block_hash, out._block_hash));
  if (out._timestamp) rows.appendChild(row('Timestamp', new Date(out._timestamp * 1000).toUTCString() + '  (' + fmtAge(out._timestamp) + ')'));
  if (out._confirmations != null) rows.appendChild(row('Confirmations', fmtNum(out._confirmations)));
  if (out.mmr_index != null) rows.appendChild(row('Output MMR index', fmtNum(out.mmr_index)));
  if (out.proof) rows.appendChild(row('Range proof', out.proof.slice(0, 18) + '…  (' + out.proof.length / 2 + ' bytes)', out.proof));

  const raw = document.getElementById('raw-json');
  if (raw) raw.textContent = JSON.stringify(out, null, 2);
  showEntity();
}

// 66-hex kernel/output share a format — if a lookup misses, transparently probe
// the other kind and redirect when it hits, so a search that guessed wrong still
// lands on the right page.
async function entityNotFound(kind, ref) {
  const other = kind === 'kernel' ? 'output' : 'kernel';
  if (/^[0-9a-fA-F]{66}$/.test(ref)) {
    try {
      const r = await fetch('/api/' + other + '/' + encodeURIComponent(ref));
      if (r.ok) { window.location.replace('/' + other + '/' + encodeURIComponent(ref)); return; }
    } catch {}
  }
  const l = document.getElementById('entity-loading');
  if (l) l.style.display = 'none';
  const nf = document.getElementById('entity-notfound');
  if (nf) {
    nf.style.display = '';
    nf.innerHTML =
      '<div class="tx-error"><h2>' + (kind === 'kernel' ? 'Kernel' : 'Output') + ' not found</h2>' +
      '<p>No ' + kind + ' matches <code class="commit">' + esc(ref) + '</code> on this node.</p>' +
      '<p>A pruned node keeps every <strong>kernel</strong>, but a <strong>spent</strong> output that has ' +
      'been pruned can no longer be located here.</p>' +
      '<p><a href="/' + other + '/' + encodeURIComponent(ref) + '">Try looking it up as ' + (other === 'kernel' ? 'a kernel' : 'an output') + ' →</a></p>' +
      '<p><a href="/">← Back to explorer</a></p></div>';
  }
}

function showEntityError(msg) {
  const l = document.getElementById('entity-loading');
  if (l) l.innerHTML = '<div class="tx-error"><h2>Lookup failed</h2><p>' + esc(msg) + '</p>' +
    '<p><a href="/">← Back to explorer</a></p></div>';
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function loadEntity(kind) {
  const ref = entityRefFromPath(kind);
  if (!ref) { window.location.replace('/404.html'); return; }
  try {
    const r = await fetch('/api/' + kind + '/' + encodeURIComponent(ref));
    if (r.status === 404) { return entityNotFound(kind, ref); }
    if (!r.ok) { return showEntityError('Server error ' + r.status); }
    const data = await r.json();
    if (kind === 'kernel') renderKernel(data, ref);
    else renderOutput(data, ref);
  } catch (e) { showEntityError('Failed to load: ' + e.message); }
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
        { name: 'GrinScan', url: 'https://grinscan.org', blurb: 'Dual-network explorer with charts, peers, price, and a REST API.' },
      ];
  // Operator-supplied (config.fallback_explorers), so this is not a visitor XSS
  // — but it is still untrusted-by-shape: an unescaped " in a url closes the
  // href attribute, and a javascript: url would run on click. Escape all three,
  // and let only http(s) through, so a typo in the config degrades to a missing
  // card instead of a broken page.
  const safeUrl = u => /^https?:\/\//i.test(String(u || '')) ? String(u) : '';
  if (wrap) wrap.innerHTML = fallbacks.map(f => {
    const href = safeUrl(f.url);
    if (!href) return '';
    return `<a class="tx-fallback" href="${esc(href)}" target="_blank" rel="noopener noreferrer">` +
      `<div class="name">${esc(f.name || href)} ↗</div>` +
      `<div class="blurb">${esc(f.blurb || '')}</div></a>`;
  }).join('');
}

// ── EMISSION PAGE ─────────────────────────────────────────────────────────────

function initEmission() {
  const calc    = document.getElementById('calc-height');
  const calcOut = document.getElementById('calc-supply');
  function recalc() {
    if (!calcOut) return;
    const h = parseInt(calc.value, 10);
    calcOut.textContent = (isFinite(h) && h >= 0) ? fmtNum(h * 60) : '—';
  }
  if (calc) calc.addEventListener('input', recalc);

  // Live figures: supply = height × 60; annual inflation = 60×1440×365 / supply.
  fetch('/api/stats').then(r => r.ok ? r.json() : null).then(s => {
    if (!s || s.tip_height == null) return;
    setText('emit-height', fmtNum(s.tip_height));
    setText('emit-supply', fmtNum(s.tip_height * 60));
    setText('emit-updated', 'as of ' + new Date().toLocaleTimeString());
    const supply = s.supply != null ? s.supply : s.tip_height * 60;
    const annualNew = 60 * 1440 * 365; // 31,536,000 ツ/yr
    if (supply > 0) setText('emit-inflation', '≈ ' + (annualNew / supply * 100).toFixed(2) + '%');
    if (calc && !calc.value) { calc.value = s.tip_height; recalc(); }
  }).catch(() => {});
}

// ── MINING CALCULATOR PAGE ──────────────────────────────────

// A blank, negative, non-numeric or infinite input is 0 here — never NaN, which
// propagates silently through every later multiplication and lands in a money
// figure (memory reference_money_number_boundary_traps).
function posNum(v) {
  const n = typeof v === 'number' ? v : parseFloat(v);
  return (isFinite(n) && n > 0) ? n : 0;
}

// Pure arithmetic, deliberately split from the DOM so it is directly testable.
// netGps is the SERVER's figure; this page never derives a hashrate from
// difficulty (the difficulty/60 trap). A null output means "unknown" and must
// render as —, never as 0: a missing network basis is not an idle miner.
function miningEstimate(inp) {
  const netGps = posNum(inp.netGps);
  const gps    = posNum(inp.gps);
  const fee    = Math.min(100, posNum(inp.feePct));
  const watts  = posNum(inp.watts);
  const kwh    = posNum(inp.kwhCost);
  const price  = posNum(inp.priceUsd) || null;

  // Your share of a network that is paid exactly 86,400 ツ a day (60 ツ × 1440).
  // Both operands must be REAL: an empty hashrate box is "not told yet", not a
  // miner running at 0 G/s, and posNum() flattens the two into the same 0. It
  // rendered as a confident "0 ツ · $0.00" a day and a "-$0.49" daily loss for a
  // rig the reader has not described — the same class of mistake as printing 0
  // for a missing network basis, one field further in.
  const grinDay = (netGps > 0 && gps > 0) ? gps / netGps * 86400 * (1 - fee / 100) : null;
  const powerDay = watts / 1000 * 24 * kwh;
  const usd = g => (g != null && price != null) ? g * price : null;

  return {
    grinDay,
    grinWeek:  grinDay != null ? grinDay * 7  : null,
    grinMonth: grinDay != null ? grinDay * 30 : null,
    usdDay:    usd(grinDay),
    usdWeek:   usd(grinDay != null ? grinDay * 7  : null),
    usdMonth:  usd(grinDay != null ? grinDay * 30 : null),
    powerDay,
    // Undefined with no power cost (nothing to break even against) and with no
    // yield (the division would be Infinity) — both are —, not a number.
    breakEven: (grinDay > 0 && powerDay > 0) ? powerDay / grinDay : null,
    profitDay: usd(grinDay) != null ? usd(grinDay) - powerDay : null,
  };
}

function fmtGrinAmt(n) {
  if (n == null || !isFinite(n)) return '—';
  const d = n === 0 ? 0 : Math.abs(n) < 1 ? 4 : Math.abs(n) < 1000 ? 2 : 0;
  return Number(n).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
}

// WATTS. A whole number above 10 W (no rig is specified to a tenth), one decimal
// below it so a small figure someone typed on purpose is not rounded to nothing.
function fmtWatts(n) {
  if (n == null || !isFinite(n)) return '—';
  return Number(n).toLocaleString(undefined, { maximumFractionDigits: Math.abs(n) < 10 ? 1 : 0 });
}

function _usd(n, d) {
  return (n < 0 ? '-$' : '$') + Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
}

// TOTALS (a day's income, a power bill): cents, widening only for sub-cent sums.
function fmtUsdAmt(n) {
  if (n == null || !isFinite(n)) return '—';
  const a = Math.abs(n);
  return _usd(n, (a !== 0 && a < 0.01) ? 4 : 2);
}

// UNIT PRICES (GRIN price, break-even price): GRIN trades in cents, so 2 dp
// would round a break-even of $0.0667 to $0.07 and destroy the only digits
// that matter.
function fmtUsdPrice(n) {
  if (n == null || !isFinite(n)) return '—';
  const a = Math.abs(n);
  return _usd(n, a !== 0 && a < 0.001 ? 8 : 4);
}

function initMining() {
  const ids = ['mine-gps', 'mine-fee', 'mine-watt', 'mine-kwh'];
  const el  = {};
  ids.forEach(id => { el[id] = document.getElementById(id); });
  const rigSel = document.getElementById('mine-rig');
  const kwhSel = document.getElementById('mine-kwh-preset');
  let netGps = null, priceUsd = null;

  function render() {
    const r = miningEstimate({
      netGps,
      priceUsd,
      gps:     el['mine-gps']  ? el['mine-gps'].value  : 0,
      feePct:  el['mine-fee']  ? el['mine-fee'].value  : 0,
      watts:   el['mine-watt'] ? el['mine-watt'].value : 0,
      kwhCost: el['mine-kwh']  ? el['mine-kwh'].value  : 0,
    });
    setText('mine-day',   fmtGrinAmt(r.grinDay));
    setText('mine-week',  fmtGrinAmt(r.grinWeek));
    setText('mine-month', fmtGrinAmt(r.grinMonth));
    // WHY a figure is —, named in the order the reader can act on it. Every
    // unknown used to print 'enter your hashrate' or 'price unavailable', so a
    // dead /api/stats told a miner who HAD entered a hashrate to enter one —
    // copy that blames the operator for the server's own outage. The missing
    // input in that case is the NETWORK figure, which no field on this page can
    // supply. Order matters: without the network basis nothing downstream is
    // computable, so it is reported first even when the price is also missing.
    const noNet  = (netGps == null);
    const noRate = posNum(el['mine-gps'] ? el['mine-gps'].value : 0) <= 0;
    const blocker = noNet  ? 'needs the network hashrate'
                  : noRate ? 'enter your hashrate'
                  : priceUsd == null ? 'price unavailable'
                  : '—';

    setText('mine-day-usd',   r.usdDay   != null ? fmtUsdAmt(r.usdDay)   : blocker);
    setText('mine-week-usd',  r.usdWeek  != null ? fmtUsdAmt(r.usdWeek)  : blocker);
    setText('mine-month-usd', r.usdMonth != null ? fmtUsdAmt(r.usdMonth) : blocker);
    setText('mine-power', fmtUsdAmt(r.powerDay));
    setText('mine-breakeven', fmtUsdPrice(r.breakEven));
    // Power comes first here: with no power cost there is nothing to break even
    // against, so the missing network basis is not what is holding this card up.
    setText('mine-breakeven-sub', r.breakEven != null
      ? 'per ツ, to cover electricity'
      : r.powerDay > 0 ? (noNet ? 'needs the network hashrate' : 'enter your hashrate')
      : 'no power cost entered');
    setText('mine-profit', fmtUsdAmt(r.profitDay));
    setText('mine-profit-sub', r.profitDay != null
      ? 'income at the live price minus power'
      : blocker === '—' ? 'at the live price' : blocker);

    // Watts are a RATE, and the field was read as a daily total. Spelling the
    // conversion out beside the box is the only place it can't be missed: the
    // "Power cost / day" card shows the money, not the energy, so nothing on
    // screen previously said that 120 W means 2.9 kWh a day.
    // fmtWatts, not fmtGrinAmt: that formatter picks its decimals by magnitude
    // for a GRIN balance, which reads a wattage back as "120.00 W" beside
    // "2,800 W". The one line on the page whose entire job is to make a unit
    // unambiguous cannot itself be inconsistent about the number.
    const w = posNum(el['mine-watt'] ? el['mine-watt'].value : 0);
    setText('mine-watt-note', w > 0
      ? 'A continuous rate, not a daily total — ' + fmtWatts(w) + ' W running 24/7 is '
        + (w * 24 / 1000).toFixed(1) + ' kWh a day.'
      : 'A continuous rate, not a daily total. At 0 W the page shows gross mining income only.');
  }

  // The presets WRITE INTO the number fields rather than feeding the maths
  // themselves, so the visible figures stay the only input miningEstimate ever
  // reads — a dropdown that quietly disagreed with the box below it would be a
  // money figure nobody can audit. Everything below is note text and plumbing.
  const rigName = () => {
    const o = rigSel && rigSel.options[rigSel.selectedIndex];
    return o ? o.text.split(' — ')[0] : '';
  };
  function rigNote() {
    if (!rigSel) return;
    setText('mine-rig-note', rigSel.value === 'custom'
      ? 'Custom — fill in the hashrate and power draw yourself.'
      : rigName() + ' figures filled in below. Edit either one if yours differs, or if you run more than one.');
  }
  function kwhNote() {
    if (!kwhSel) return;
    setText('mine-kwh-note', kwhSel.value === 'custom'
      ? 'Custom — take the rate off your own bill.'
      : 'A rough regional average converted to USD, not a quote — your own bill is the number that matters.');
  }

  if (rigSel) {
    rigSel.addEventListener('change', () => {
      const o = rigSel.options[rigSel.selectedIndex];
      if (o && rigSel.value !== 'custom') {
        if (el['mine-gps']  && o.dataset.gps   != null) el['mine-gps'].value  = o.dataset.gps;
        if (el['mine-watt'] && o.dataset.watts != null) el['mine-watt'].value = o.dataset.watts;
      }
      rigNote();
      render();
    });
  }
  if (kwhSel) {
    kwhSel.addEventListener('change', () => {
      const o = kwhSel.options[kwhSel.selectedIndex];
      if (o && kwhSel.value !== 'custom' && el['mine-kwh'] && o.dataset.kwh != null) {
        el['mine-kwh'].value = o.dataset.kwh;
      }
      kwhNote();
      render();
    });
  }

  // Typing over a filled-in figure drops its select back to Custom, so the
  // dropdown can never name a rig or a region whose numbers are no longer on
  // screen. Assigning .value from the handlers above fires no `input` event,
  // so this cannot loop back on itself.
  ids.forEach(id => {
    if (!el[id]) return;
    el[id].addEventListener('input', () => {
      if ((id === 'mine-gps' || id === 'mine-watt') && rigSel && rigSel.value !== 'custom') {
        rigSel.value = 'custom'; rigNote();
      }
      if (id === 'mine-kwh' && kwhSel && kwhSel.value !== 'custom') {
        kwhSel.value = 'custom'; kwhNote();
      }
      render();
    });
  });

  rigNote();
  kwhNote();
  render();

  // ONE call. hashrate_gps_24h is the day-average basis the server already uses
  // for its own G1/day figure; hashrate_gps (the ~20-block instantaneous rate)
  // is the documented fallback when the day-average could not be computed.
  fetch('/api/stats')
    .then(r => r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)))
    .then(s => {
      const daily = posNum(s.hashrate_gps_24h);
      const inst  = posNum(s.hashrate_gps);
      netGps   = daily || inst || null;
      priceUsd = posNum(s.price_usd) || null;
      setText('mine-net', netGps != null ? fmtHashrate(netGps) : 'unavailable');
      setText('mine-net-sub', netGps == null ? 'cannot estimate without it'
        : daily ? '24h average' : 'recent blocks · 24h average unavailable');
      setText('mine-price', priceUsd != null ? fmtUsdPrice(priceUsd) : 'unavailable');
      setText('mine-price-sub', priceUsd != null ? 'live, USD' : 'USD figures unavailable');
      render();
    })
    .catch(err => {
      // These two cards ARE this page's error surface. Swallowing the failure
      // left them reading "—" and "loading…" for ever, which is indistinguishable
      // from a slow network and says nothing about WHICH half broke — the reason
      // a dead /api/stats (nginx 503 from the tinyx_api limiter, a 502 when the
      // node is unreachable, an offline browser) could not be told apart from a
      // rendering bug. Name the failure and let the estimates fall to —.
      setText('mine-net', 'unavailable');
      setText('mine-net-sub', 'live stats did not load · ' + (err && err.message ? err.message : 'network error'));
      render();

      // /api/stats is all-or-nothing on the NODE: it 502s whenever getTip()
      // fails, taking the price down with it even though the price is fetched
      // from an exchange and needs the node for nothing. Reporting it as
      // 'unavailable' there was simply false. /api/price is that node-free half,
      // so an outage costs the estimates but not the price card.
      fetch('/api/price')
        .then(r => r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)))
        .then(pr => {
          priceUsd = posNum(pr && pr.price_usd) || null;
          if (priceUsd == null) throw new Error('no price');
          setText('mine-price', fmtUsdPrice(priceUsd));
          setText('mine-price-sub', 'live, USD · network hashrate is the missing figure');
          render();
        })
        .catch(() => {
          priceUsd = null;
          setText('mine-price', 'unavailable');
          setText('mine-price-sub', 'USD figures unavailable');
          render();
        });
    });
}

// ── Init ─────────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  initTheme();
  initChrome();
  const page = document.body.dataset.page;
  if (page === 'index') initIndex();
  if (page === 'block') loadBlock();
  if (page === 'kernel') loadEntity('kernel');
  if (page === 'output') loadEntity('output');
  if (page === 'notfound') init404();
  if (page === 'emission') initEmission();
  if (page === 'mining') initMining();
});
