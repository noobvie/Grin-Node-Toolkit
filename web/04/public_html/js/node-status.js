// =============================================================================
// Grin Node Status Page — node-status.js
// web/04/public_html/js/node-status.js
//
// Calls two Grin foreign API (v2) methods — both read-only, no auth needed:
//   get_tip     → height, total_difficulty, latest block hash
//   get_version → node_version, protocol_version, block_header_version
//
// NOTE: get_peers_connected and get_status are owner-API only — not exposed
//       on /v2/foreign. Peer count is therefore not available here.
//
// GRIN_NETWORK is injected by config.js (generated at deploy time by the
// Grin Node Toolkit install script).
//
// Auto-refreshes every INTERVAL_SEC seconds with a live countdown badge.
// =============================================================================

const INTERVAL_SEC = 10;

// ── RPC helper ────────────────────────────────────────────────────────────────
// Grin v2 JSON-RPC returns { result: { Ok: ... } } or { result: { Err: ... } }
async function rpc(method, params) {
  const res = await fetch('/v2/foreign', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ jsonrpc: '2.0', method, params: params ?? [], id: 1 }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  const json = await res.json();
  if (json.error) throw new Error(json.error.message ?? JSON.stringify(json.error));
  const result = json.result;
  if (result && 'Err' in result) throw new Error(String(result.Err));
  if (result && 'Ok'  in result) return result.Ok;
  return result;
}

// ── Formatting helpers ─────────────────────────────────────────────────────────
const fmtNum    = n => Number(n).toLocaleString();
const truncHash = h => (h && h.length > 14) ? h.slice(0, 14) + '…' : (h || '—');

// ── DOM helper ─────────────────────────────────────────────────────────────────
function setVal(id, text, extraClass) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = text;
  el.className = 'card-value' + (extraClass ? ' ' + extraClass : '');
}

// ── Countdown ──────────────────────────────────────────────────────────────────
let countdownTimer = null;
let nextIn         = INTERVAL_SEC;

function startCountdown() {
  clearCountdown();
  nextIn = INTERVAL_SEC;
  const badge = document.getElementById('countdown');
  countdownTimer = setInterval(() => {
    nextIn--;
    if (badge) badge.textContent = nextIn + 's';
    if (nextIn <= 0) {
      clearCountdown();
      refresh();
    }
  }, 1000);
}

function clearCountdown() {
  if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
}

// ── Refresh ────────────────────────────────────────────────────────────────────
async function refresh() {
  clearCountdown();

  const badge     = document.getElementById('countdown');
  const errBanner = document.getElementById('error-banner');
  if (badge) badge.textContent = '…';

  document.querySelectorAll('.card').forEach(c => c.classList.add('loading'));

  // Use allSettled so a single method failure doesn't blank the whole page
  const [tipRes, verRes] = await Promise.allSettled([
    rpc('get_tip'),
    rpc('get_version'),
  ]);

  const tip = tipRes.status === 'fulfilled' ? tipRes.value : null;
  const ver = verRes.status === 'fulfilled' ? verRes.value : null;

  // Chain
  setVal('v-height',     tip?.height           != null ? fmtNum(tip.height)           : '—');
  setVal('v-difficulty', tip?.total_difficulty != null ? fmtNum(tip.total_difficulty) : '—');
  setVal('v-hash',       truncHash(tip?.last_block_pushed), 'small');

  // Node
  setVal('v-node-ver',  ver?.node_version          ?? '—');
  setVal('v-proto-ver', ver?.protocol_version       != null ? String(ver.protocol_version)       : '—');
  setVal('v-hdr-ver',   ver?.block_header_version   != null ? String(ver.block_header_version)   : '—');

  // Error banner — show if both calls failed
  const anyError = tipRes.status === 'rejected' && verRes.status === 'rejected';
  if (anyError && errBanner) {
    errBanner.textContent = 'Could not reach node: ' + tipRes.reason?.message;
    errBanner.classList.add('visible');
  } else if (errBanner) {
    errBanner.classList.remove('visible');
  }

  const ts = document.getElementById('last-updated');
  if (ts) ts.textContent = (anyError ? 'Last attempt ' : 'Updated ') + new Date().toUTCString();

  document.querySelectorAll('.card').forEach(c => c.classList.remove('loading'));
  startCountdown();
}

// ── Network badge ──────────────────────────────────────────────────────────────
function applyNetwork() {
  const network = (typeof GRIN_NETWORK !== 'undefined' ? GRIN_NETWORK : '').toLowerCase();
  if (!network) return;

  const badge = document.getElementById('network-badge');
  if (badge) {
    badge.textContent  = network.toUpperCase();
    badge.className    = 'network-badge ' + network;
  }

  // Update page title and og:title
  const label = network.charAt(0).toUpperCase() + network.slice(1);
  document.title = 'Grin ' + label + ' API Status';
}

// ── Theme ──────────────────────────────────────────────────────────────────────
let currentTheme = localStorage.getItem('grin-node-theme') || 'dark';

function applyTheme(theme) {
  currentTheme = theme;
  localStorage.setItem('grin-node-theme', theme);
  if (theme === 'light') {
    document.documentElement.setAttribute('data-theme', 'light');
  } else {
    document.documentElement.removeAttribute('data-theme');
  }
  const btn = document.getElementById('theme-btn');
  if (btn) btn.textContent = theme === 'light' ? '☀' : '🌙';
}

// ── Boot ───────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  applyTheme(currentTheme);
  applyNetwork();

  document.getElementById('theme-btn')?.addEventListener('click', () => {
    applyTheme(currentTheme === 'light' ? 'dark' : 'light');
  });

  refresh();
});
