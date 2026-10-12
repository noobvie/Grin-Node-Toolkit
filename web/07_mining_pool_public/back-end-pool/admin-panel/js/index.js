// index.html page script — moved BYTE-verbatim out of the page's inline script block (code-layout F5).
// Classic script (no defer/module) loaded at the same position as the old block, after the <script src> tags before it, whose globals it uses (H14).
// Auth gate (httpOnly-cookie aware): redirects to /login.html if not an admin, else wires
// up the topbar username + Logout. Pool name + testnet banner are handled by admin-shell.js.
API.guardAdminPage();

function fmtGrin(v) { return (v || 0).toFixed(4); }
function fmtHashrate(gps) {
  if (!gps) return '—';
  if (gps >= 1000) return (gps / 1000).toFixed(2) + ' KG/s';
  return gps.toFixed(2) + ' G/s';
}
// withdrawals.created_at is INTEGER unixepoch (see lib/db.js) — seconds, not ms. Passing it
// to new Date() unscaled rendered every row as January 1970 (audit §J14).
function fmtTs(t) { return t ? new Date(t * 1000).toLocaleString() : '—'; }
function escHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function shortAddr(a) {
  a = String(a || '');
  return a.length > 18 ? a.slice(0, 10) + '…' + a.slice(-6) : a;
}

// Must stay in step with STATUS in payments.html and with every status the withdrawal
// scheduler can write. The old map here listed five statuses no rail has ever produced
// (waiting_finalize / finalized / completed / failed / expired), so EVERY row fell through
// to the grey badge-dim fallback — the same colour the panel uses for CANCELLED. A failed
// payout read as a finished one on the operator's landing page (audit §J14, same class as
// §H4, which was fixed on payments.html only).
const STATUS_BADGE = {
  tor_checking:      '<span class="badge badge-warn">Checking (Tor)</span>',
  tor_sending:       '<span class="badge badge-warn">Sending</span>',
  tor_held:          '<span class="badge badge-warn">Held</span>',
  // LEGACY since 2026-09-26 (no new row; migrated on the scheduler's first pass).
  retry_scheduled:   '<span class="badge badge-warn">Legacy retry</span>',
  slatepack_pending: '<span class="badge badge-warn">Awaiting slate</span>',
  finalizing:        '<span class="badge badge-warn">Settling</span>',
  confirmed:         '<span class="badge badge-ok">Paid</span>',
  tor_failed:        '<span class="badge badge-error">Failed (Tor)</span>',
  slatepack_failed:  '<span class="badge badge-error">Failed (slate)</span>',
  nostr_failed:      '<span class="badge badge-error">Failed (Goblin)</span>',
  slatepack_expired: '<span class="badge badge-dim">Expired</span>',
  cancelled:         '<span class="badge badge-dim">Cancelled</span>',
};

async function loadAdminDashboard() {
  try {
    const d = await API.get('/api/admin/dashboard');
    document.getElementById('kpi-users').textContent    = d.total_users    ?? '—';
    document.getElementById('kpi-miners').textContent   = d.active_miners  ?? '—';
    document.getElementById('kpi-hashrate').textContent = fmtHashrate(d.pool_hashrate_gps);
    document.getElementById('kpi-unclaimed').textContent = fmtGrin(d.unclaimed_balance);
    document.getElementById('kpi-pending').textContent  = d.pending_withdrawals ?? '—';
    document.getElementById('kpi-donor-requests').textContent = d.pending_donor_requests ?? '—';
  } catch (e) {}

  loadHashrateChart();
  loadShareQuality();

  try {
    const items = await API.get('/api/admin/withdrawals?limit=10');
    const tbody = document.getElementById('recent-tbody');
    if (!items || !items.length) {
      tbody.innerHTML = '<tr class="empty-row"><td colspan="5">No withdrawals yet.</td></tr>';
      return;
    }
    tbody.innerHTML = items.map(w => {
      const badge = STATUS_BADGE[w.status] || `<span class="badge badge-dim">${escHtml(w.status)}</span>`;
      // The column is `slate_id` (lib/db.js). `tx_slate_id` does not exist on this row, so
      // this cell was permanently '—' (audit §J14).
      const slate = w.slate_id
        ? `<span class="truncate mono" title="${escHtml(w.slate_id)}">${escHtml(String(w.slate_id).slice(0,16))}…</span>`
        : '—';
      // withdrawals are keyed by grin_address — there is no username/user_id column, so this
      // cell used to render the literal string "undefined" on every row (audit §J14).
      return `<tr>
        <td>${escHtml(fmtTs(w.created_at))}</td>
        <td><span class="mono" title="${escHtml(w.grin_address)}">${escHtml(shortAddr(w.grin_address))}</span></td>
        <td class="mono">${fmtGrin(w.amount)}</td>
        <td>${badge}</td>
        <td>${slate}</td>
      </tr>`;
    }).join('');
  } catch (e) {}
}

// 30-day pool hashrate — reuses the public history endpoint (no backend change) and the
// vendored Chart.js helper. Falls back to a tidy empty state when there are no samples yet
// or Chart.js failed to load, so the card never renders broken.
async function loadHashrateChart() {
  const wrap = document.getElementById('hashrate-wrap');
  if (!wrap) return;
  try {
    const d = await API.get('/api/pool/hashrate/history?hours=720');
    const series = (d && d.series) || [];
    if (!series.length || !window.PoolCharts) {
      wrap.innerHTML = '<div class="chart-empty">No hashrate samples yet.</div>';
      return;
    }
    PoolCharts.renderHashrateChart('hashrate-chart', series, { label: 'Pool hashrate' });
  } catch (e) {
    wrap.innerHTML = '<div class="chart-empty">Hashrate history unavailable.</div>';
  }
}

// Live pool-wide share quality (valid/stale/rejected). Reuses the public /api/pool/stats
// aggregate. Empty state on a pure hub or with no connected rigs.
async function loadShareQuality() {
  const wrap = document.getElementById('quality-wrap');
  if (!wrap) return;
  try {
    const s = await API.get('/api/pool/stats');
    const q = (s && s.share_quality) || {};
    const acc = Number(q.accepted) || 0, stl = Number(q.stale) || 0, rej = Number(q.rejected) || 0;
    if (acc + stl + rej === 0 || !window.PoolCharts) {
      wrap.innerHTML = '<div class="chart-empty">No live share data yet.</div>';
      return;
    }
    PoolCharts.renderDoughnutChart('quality-chart',
      ['Valid', 'Stale', 'Rejected'], [acc, stl, rej],
      { colors: ['#3fb950', '#d29922', '#f85149'] });
  } catch (e) {
    wrap.innerHTML = '<div class="chart-empty">Share quality unavailable.</div>';
  }
}

document.addEventListener('DOMContentLoaded', loadAdminDashboard);
