// =============================================================================
// Grin Node Status Page — node-status.js
// web/04/public_html/js/node-status.js
//
// Calls two Grin foreign API (v2) methods — both read-only, no auth needed:
//   get_tip     → height, total_difficulty, latest block hash
//   get_version → node_version, block_header_version
//
// NOTE: get_peers_connected / get_status are owner-API only — not on /v2/foreign.
//
// GRIN_NETWORK is injected by config.js (written at deploy time by the toolkit).
// =============================================================================

const INTERVAL_SEC = 60;

// ── RPC helper ────────────────────────────────────────────────────────────────
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

// ── Formatting ────────────────────────────────────────────────────────────────
// Integer only — no decimals, no thousands separator
const fmtInt = n => String(Math.floor(Number(n)));

// ── DOM helper ─────────────────────────────────────────────────────────────────
function setVal(id, text, extraClass) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = text;
  el.className = 'card-value' + (extraClass ? ' ' + extraClass : '');
}

function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
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

  const [tipRes, verRes] = await Promise.allSettled([
    rpc('get_tip'),
    rpc('get_version'),
  ]);

  const tip = tipRes.status === 'fulfilled' ? tipRes.value : null;
  const ver = verRes.status === 'fulfilled' ? verRes.value : null;

  // Chain
  setVal('v-height',     tip?.height           != null ? fmtInt(tip.height)           : '—');
  setVal('v-difficulty', tip?.total_difficulty != null ? fmtInt(tip.total_difficulty) : '—');
  // Full hash — no truncation, CSS handles wrapping
  setVal('v-hash', tip?.last_block_pushed ?? '—', 'hash');

  // Circulating supply: Grin emits 1 coin/second, ~60/block
  if (tip?.height != null) {
    const supply = Math.floor(tip.height) * 60;
    setVal('v-supply', fmtInt(supply) + ' GRIN / ∞');
    setText('v-supply-sub', '≈ height × 60  (1 GRIN/s · 60 s/block · no max supply)');
  } else {
    setVal('v-supply', '—');
  }

  // Node
  setVal('v-node-ver', ver?.node_version              ?? '—');
  setVal('v-hdr-ver',  ver?.block_header_version != null
                         ? String(ver.block_header_version) : '—');

  // Error banner
  const anyError = tipRes.status === 'rejected' && verRes.status === 'rejected';
  if (anyError && errBanner) {
    errBanner.textContent = 'Could not reach node: ' + tipRes.reason?.message;
    errBanner.classList.add('visible');
  } else if (errBanner) {
    errBanner.classList.remove('visible');
  }

  // Footer timestamp — UTC + user's local time
  const now      = new Date();
  const utcStr   = now.toUTCString();
  const localStr = now.toLocaleString([], {
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    timeZoneName: 'short',
  });
  const ts = document.getElementById('last-updated');
  if (ts) ts.innerHTML = (anyError ? 'Last attempt ' : 'Updated ')
    + utcStr + ' &nbsp;|&nbsp; Local: ' + localStr;

  document.querySelectorAll('.card').forEach(c => c.classList.remove('loading'));
  startCountdown();
}

// ── Network badge ──────────────────────────────────────────────────────────────
function applyNetwork() {
  const network = (typeof GRIN_NETWORK !== 'undefined' ? GRIN_NETWORK : '').toLowerCase();
  if (!network) return;

  const badge = document.getElementById('network-badge');
  if (badge) {
    badge.textContent = network.toUpperCase();
    badge.className   = 'network-badge ' + network;
  }

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

// ── Curl tip ───────────────────────────────────────────────────────────────────
function applyCurlTip() {
  const el = document.getElementById('curl-tip');
  if (!el) return;
  const origin = window.location.origin;
  el.textContent =
    `curl -s -X POST ${origin}/v2/foreign \\\n` +
    `     -H 'Origin: https://www.google.com' \\\n` +
    `     -H 'Content-Type: application/json' \\\n` +
    `     -d '{"jsonrpc":"2.0","method":"get_tip","params":[],"id":1}' \\\n` +
    `     -D -`;
}

// ── Fetch tip (browser console example) ────────────────────────────────────────
function applyFetchTip() {
  const el = document.getElementById('fetch-tip');
  if (!el) return;
  const origin = window.location.origin;
  el.textContent =
    `fetch('${origin}/v2/foreign', {\n` +
    `  method: 'POST',\n` +
    `  headers: { 'Content-Type': 'application/json' },\n` +
    `  body: JSON.stringify({\n` +
    `    jsonrpc: '2.0', method: 'get_tip', params: [], id: 1\n` +
    `  })\n` +
    `}).then(r => r.json()).then(console.log)`;
}

// ── Self test ──────────────────────────────────────────────────────────────────
async function runSelfTest() {
  const btn = document.getElementById('test-btn');
  const out = document.getElementById('fetch-result');
  if (!out) return;

  out.textContent = 'Fetching…';
  out.className   = 'curl-block fetch-result';
  if (btn) btn.disabled = true;

  try {
    const [tip, ver] = await Promise.all([rpc('get_tip'), rpc('get_version')]);
    out.textContent = JSON.stringify({ get_tip: tip, get_version: ver }, null, 2);
    out.classList.add('ok');
  } catch (err) {
    out.textContent = 'Error: ' + err.message;
    out.classList.add('err');
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ── Remote API checker ─────────────────────────────────────────────────────────
async function runRemoteCheck() {
  const input = document.getElementById('remote-url');
  const btn   = document.getElementById('remote-btn');
  const out   = document.getElementById('remote-result');
  if (!out || !input) return;

  const origin = input.value.trim().replace(/\/+$/, '');
  if (!origin) { out.textContent = 'Enter a URL first.'; return; }

  const url = origin + '/v2/foreign';
  out.textContent = 'Checking ' + url + ' …';
  out.className   = 'curl-block fetch-result';
  if (btn) btn.disabled = true;

  try {
    const res = await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ jsonrpc: '2.0', method: 'get_tip', params: [], id: 1 }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const json   = await res.json();
    const result = json.result?.Ok ?? json.result;
    out.textContent = JSON.stringify(result, null, 2);
    out.classList.add('ok');
  } catch (err) {
    const isCors = err.message === 'Failed to fetch' || err.message.includes('NetworkError');
    out.textContent = isCors
      ? 'Blocked — likely CORS not enabled on the remote node.\n\n'
        + 'Open F12 → Console for the exact browser error.\n'
        + 'The remote node must respond with:\n'
        + '  Access-Control-Allow-Origin: *'
      : 'Error: ' + err.message;
    out.classList.add('err');
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ── Boot ───────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  applyTheme(currentTheme);
  applyNetwork();
  applyCurlTip();
  applyFetchTip();

  // Attach button listeners here — inline onclick is blocked by CSP script-src 'self'
  document.getElementById('test-btn')?.addEventListener('click', runSelfTest);
  document.getElementById('remote-btn')?.addEventListener('click', runRemoteCheck);
  document.getElementById('remote-url')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') runRemoteCheck();
  });
  document.getElementById('theme-btn')?.addEventListener('click', () => {
    applyTheme(currentTheme === 'light' ? 'dark' : 'light');
  });

  refresh();
});
