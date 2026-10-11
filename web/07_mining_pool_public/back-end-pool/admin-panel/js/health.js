// health.html page script — moved BYTE-verbatim out of the page's inline script block (code-layout F5).
// Classic script (no defer/module) loaded at the same position as the old block, after the <script src> tags before it, whose globals it uses (H14).
// Auth gate (httpOnly-cookie aware): redirects to /login.html if not an admin, else wires
// up the topbar username + Logout. Pool name + testnet banner are handled by admin-shell.js.
API.guardAdminPage();

// ── Service definition map ─────────────────────────────────────────────────
// Maps API fields to display config
const SERVICES = [
  { key: 'pool_manager', name: 'Pool Manager' },
  { key: 'grin_node',    name: 'Grin Node' },
  { key: 'stratum',      name: 'Stratum Server' },
  { key: 'grin_wallet',  name: 'Grin Wallet' },
  { key: 'nginx',        name: 'nginx' },
  { key: 'database',     name: 'Database' },
];

function statusClass(status) {
  if (!status) return 'error';
  const s = status.toLowerCase();
  if (s === 'ok' || s === 'healthy' || s === 'running' || s === 'up') return 'ok';
  if (s === 'degraded' || s === 'warning') return 'warn';
  return 'error';
}

// `s == null`, not `s || ''` — a numeric 0 is a real value here (0 miners connected, port 0
// on a mis-set service) and the old form rendered it as an empty string, so "Miners: " read
// as missing data rather than none. Audit §J14.
function escHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function renderServiceDetail(svc) {
  const parts = [];
  if (svc.uptime    != null) parts.push('Uptime: ' + escHtml(svc.uptime));
  if (svc.pid       != null) parts.push('PID: ' + escHtml(svc.pid));
  if (svc.height    != null) parts.push('Height: ' + (window.Explorer ? Explorer.link('block', svc.height, svc.height) : escHtml(svc.height)));
  if (svc.synced    != null) parts.push('Synced: ' + (svc.synced ? 'Yes' : 'No'));
  if (svc.port      != null) parts.push('Port: ' + escHtml(svc.port));
  if (svc.miners_connected != null) parts.push('Miners: ' + escHtml(svc.miners_connected));
  if (svc.spendable_balance != null) parts.push('Spendable: ' + parseFloat(svc.spendable_balance).toFixed(4) + ' GRIN');
  // Grin Wallet card only: the binary the pool runs vs the version its payout guards were checked
  // against (lib/grin-wallet-version.js). A mismatch also Degrades the card, with the reason below.
  if (svc.wallet_version_tested != null) {
    const v = svc.wallet_version;
    parts.push('grin-wallet: ' + (v ? 'v' + escHtml(v) : 'unknown') +
      (v === svc.wallet_version_tested ? ' (tested)' : ' — payouts tested with v' + escHtml(svc.wallet_version_tested)));
  }
  if (svc.size_mb   != null) parts.push('Size: ' + escHtml(svc.size_mb) + ' MB');
  if (svc.wal_mode  != null) parts.push('WAL: ' + escHtml(svc.wal_mode));
  if (svc.message   != null) parts.push(escHtml(svc.message));
  return parts.join('<br>');
}

async function loadHealth() {
  try {
    const d = await API.get('/api/admin/health');
    const grid = document.getElementById('health-grid');

    const cards = SERVICES.map(svcDef => {
      const svc    = d.services && d.services[svcDef.key] ? d.services[svcDef.key] : {};
      const status = svc.status || 'unknown';
      const cls    = statusClass(status);
      // 'critical' is up but wrong (e.g. a payout marked paid that the wallet cancelled) — red
      // like Down, but it must not read as an outage.
      const badge  = cls === 'ok'
        ? '<span class="badge badge-ok">OK</span>'
        : cls === 'warn'
          ? '<span class="badge badge-warn">Degraded</span>'
          : String(status).toLowerCase() === 'critical'
            ? '<span class="badge badge-error">Critical</span>'
            : '<span class="badge badge-error">Down</span>';
      const detail = renderServiceDetail(svc);
      // An alert nothing resolves automatically (the "paid twice?" alarm) carries its id here; the
      // operator closes it after reconciling by hand (AlertMonitor.resolveManual, step-up gated).
      const manual = (Array.isArray(svc.manual_alerts) ? svc.manual_alerts : [])
        .map(a => `<button type="button" class="btn btn-outline btn-sm" data-resolve-alert="${Number(a.id)}"
          style="margin-top:.6rem;">Mark reconciled</button>`).join(' ');
      return `
        <div class="health-card ${cls}">
          <div class="health-name">${escHtml(svcDef.name)} ${badge}</div>
          <div class="health-detail" style="margin-top:.4rem;">${detail || 'No data'}</div>
          ${manual}
        </div>
      `;
    }).join('');
    grid.innerHTML = cards;

    // System stats
    const sys = d.system || {};
    const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val ?? '—'; };
    set('sys-disk',   sys.disk_free   != null ? sys.disk_free + ' GB free' : '—');
    set('sys-mem',    sys.memory_pct  != null ? sys.memory_pct + '%' : '—');
    set('sys-load',   sys.load_avg    != null ? sys.load_avg  : '—');
    set('sys-uptime', sys.uptime      != null ? sys.uptime    : '—');

    // Refresh timestamp
    const ts = document.getElementById('last-refresh');
    if (ts) ts.textContent = '(refreshed ' + new Date().toLocaleTimeString() + ')';
  } catch (err) {
    document.getElementById('health-grid').innerHTML =
      `<div class="health-card error"><div class="health-name">Error loading health data</div><div class="health-detail">${escHtml(err.message)}</div></div>`;
  }
}

// ── Reconciliation summary ───────────────────────────────────────────────────
// One-shot solvency/integrity verdict. Reconciliation forces a full wallet→node output
// scan (slow), so health loads it ONCE on page open — the full statement + its own 3-min
// poll live on treasury.html. Never wire this into the 60s liveness loop.
function fmtSigned(v) { const n = Number(v) || 0; return (n >= 0 ? '+' : '') + n.toFixed(4); }
async function loadReconciliation() {
  const banner = document.getElementById('recon-banner');
  try {
    const d = await API.get('/api/admin/reconciliation');
    const c = d.checks || {};
    const problems = [];
    if (c.coverage_liquid_ok === false) problems.push(`⚠ Cannot pay out now — liquid gap ${fmtSigned(c.coverage_liquid_gap)} ツ.`);
    if (c.coverage_full_ok === false) problems.push(`⚠ Under-funded — full coverage gap ${fmtSigned(c.coverage_full_gap)} ツ.`);
    if (c.locked_ok === false) problems.push('⚠ Locked-balance ledger does not match in-flight withdrawals.');
    if (c.integrity_ok === false) problems.push(`⚠ INTEGRITY DRIFT ${fmtSigned(c.integrity_drift)} ツ — a balance moved without a ledger row.`);
    if (d.wallet && !d.wallet.reachable) problems.push('Wallet was unreachable — coverage checks skipped.');
    if (problems.length) {
      problems.push('→ Open the <a href="treasury.html">Treasury</a> page for the full statement.');
      banner.innerHTML = `<div class="health-card error" style="margin-bottom:.8rem;">
        <div class="health-detail">${problems.join('<br>')}</div></div>`;
    } else {
      banner.innerHTML = `<div class="health-card ok" style="margin-bottom:.8rem;">
        <div class="health-detail">✓ Wallet covers all balances; ledger reconciles with the log.
        <a href="treasury.html">Full statement →</a></div></div>`;
    }
  } catch (err) {
    banner.innerHTML =
      `<div class="health-card error" style="margin-bottom:.8rem;"><div class="health-detail">Error: ${escHtml(err.message)}</div></div>`;
  }
}

// ── Mark reconciled ─────────────────────────────────────────────────────────
// Closes the "paid twice?" alarm (slate_refunded_but_mined) once the operator has checked it by
// hand. ONE native prompt (the note), then the in-page step-up — a second native dialog chained
// after the first can be suppressed by the browser and read as a cancel.
function showHealthMsg(text, isError) {
  const el = document.getElementById('health-msg');
  if (!el) return;
  el.textContent = text;
  el.style.color = isError ? 'var(--danger)' : 'var(--text-dim)';
  el.style.display = '';
}
async function resolveAlert(id) {
  const note = prompt('Mark the "paid twice?" alarm as reconciled.\n\n' +
    'Only after you have checked it by hand: the payout it names was refunded to the miner AND ' +
    'its transaction is on chain. Recover the amount or accept the loss first — this only closes the alarm.\n\n' +
    'What did you find or do? (goes in the audit log)');
  if (note === null) return;
  if (!note.trim()) { showHealthMsg('Not closed — a note is required.', true); return; }
  try {
    const res = await adminFetch('/api/admin/alerts/' + id + '/resolve', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ note: note.trim() })
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || ('HTTP ' + res.status));
    showHealthMsg('Alarm closed and recorded in the audit log.', false);
    loadHealth();
  } catch (err) { showHealthMsg('Not closed: ' + err.message, true); }
}
document.getElementById('health-grid').addEventListener('click', (e) => {
  const b = e.target.closest('[data-resolve-alert]');
  if (b) resolveAlert(b.getAttribute('data-resolve-alert'));
});

// ── Stratum intake line ──────────────────────────────────────────────────────
// One line from the shared poll; the controls live on Settings → Announcements → Stratum.
function renderStratumLine(c) {
  const el = document.getElementById('stratum-line');
  const S = window.AdminStratum;
  if (!el || !S) return;
  const k = S.classify(c);
  const cls = k.level === 'ok' ? 'ok' : (k.tone === 'red' ? 'error' : 'warn');
  const live = (c.listeners || []).filter(l => l && l.listening).length;
  const extra = k.level === 'ok' || k.level === 'scheduled'
    ? ' ' + live + ' listener(s) up · ' + escHtml(c.connections) + ' connection(s).'
    : (k.level === 'paused' || k.level === 'pausing')
      ? ' The Stratum Server card below shows the process, which stays up; region status on Regions reflects the tunnel, not intake.'
      : '';
  el.className = 'health-card ' + cls;
  el.style.marginBottom = '.8rem';
  el.innerHTML = '<div class="health-detail">' + S.summaryHtml(c) + extra +
    ' <a href="settings-announcements.html?findh=Stratum">Stratum controls →</a></div>';
}
function renderStratumError(err) {
  const el = document.getElementById('stratum-line');
  if (!el) return;
  el.className = 'health-card warn';
  el.innerHTML = '<div class="health-detail">Stratum intake unknown — ' + escHtml(err.message) + '.</div>';
}
if (window.AdminStratum) AdminStratum.subscribe(renderStratumLine, renderStratumError);

// Initial paint: load everything once.
document.addEventListener('DOMContentLoaded', () => { loadHealth(); loadReconciliation(); });
// Cheap liveness (cached node/wallet status, system stats) — every 60s. Reconciliation is
// NOT in this loop (it forces a slow wallet→node scan); it stays a one-shot on load here.
setInterval(() => { loadHealth(); }, 60000);
