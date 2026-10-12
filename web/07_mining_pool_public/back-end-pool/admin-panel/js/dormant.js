// dormant.html page script — moved BYTE-verbatim out of the page's inline <script> (code-layout F3).
// Classic script (no defer/module) loaded at the same position as the old block, after auth.js,
// api.js, admin-shell.js, stepup.js and payouts-common.js, whose globals it uses (H14).
// Dormant balances: the abandoned-balance policy, its sweep, and the record of every sweep.
// Moved off payments.html (2026-10), which kept the payout queue — the below-minimum "manual
// payout" went there too, since it creates a queue row. runDisposition keeps its endpoint,
// step-up and confirm text from there.
// Auth gate (httpOnly-cookie aware): redirects to /login.html if not an admin, else wires
// up the topbar username + Logout. Pool name + testnet banner are handled by admin-shell.js.
// stepup.js provides adminFetch() for Run disposition and the freeze toggle.
// payouts-common.js provides escHtml/fmtGrin, flash() (→ #dorm-msg, the data-payout-msg element)
// and the freeze kill-switch (_frozen, renderFreeze, loadPayoutControl, togglePayouts).
API.guardAdminPage();

// ── Abandoned-balance disposition ──────────────────────────────────────────────
const BLOCK_LABEL = {
  disabled: 'policy disabled', payouts_frozen: 'payouts frozen',
  incentives_disabled: 'enable prize draws first (Incentives tab)',
  awaiting_effective_anchor: 'window starts on first run', no_eligible_sources: 'nothing eligible',
};
// Two AdminTables: the dormant list is a live snapshot (up to 500 addresses), the sweep
// history is a permanent money record — the notes say which is which.
const dormListTable = AdminTable.create({
  tbody: 'dorm-list-tbody',
  search: 'Filter by address…',
  empty: 'No dormant balances.',
  note: 'Live snapshot of currently dormant accounts, not a log — rows leave it when an ' +
        'address mines again, is paid out, or is swept. Top 500 shown.',
  text: r => r.address || '',
  row: r => {
    let disposal = '—';
    if (r.dispose_at) disposal = r.eligible ? '<span style="color:var(--danger);font-weight:600;">due</span>' : ('in ' + (r.days_until_disposal || 0) + ' d');
    return `<tr><td class="mono" style="word-break:break-all;">${escHtml(r.address)}</td>`
      + `<td class="mono" style="text-align:right;">${(r.balance || 0).toFixed(4)}</td>`
      + `<td style="text-align:right;">${r.idle_days || 0}</td><td>${disposal}</td></tr>`;
  }
});

const dormHistTable = AdminTable.create({
  tbody: 'dorm-hist-tbody',
  search: 'Filter by date or trigger…',
  empty: 'No sweeps yet.',
  note: 'Sweep batches are kept permanently — disposition is final, so the record never expires.',
  text: b => [new Date((b.created_at || 0) * 1000).toLocaleString('en-US', { timeZone: 'UTC' }),
              b.total_swept, b.source_count, b.automatic ? 'auto' : 'admin'].join(' '),
  row: b => `<tr><td>${escHtml(new Date((b.created_at || 0) * 1000).toLocaleString('en-US', { timeZone: 'UTC' }))}</td>`
    + `<td class="mono" style="text-align:right;">${(b.total_swept || 0).toFixed(4)}</td>`
    + `<td style="text-align:right;">${b.source_count || 0}</td><td>prize pool</td>`
    + `<td>${b.automatic ? 'auto' : 'admin'}</td></tr>`
});

async function loadDormancy() {
  try {
    const d = await API.get('/api/admin/dormancy');
    const st = d.status || {}, pv = d.preview || {}, dorm = d.dormant || { totals: {}, list: [] }, hist = d.history || { totals: {}, batches: [] };
    const totals = dorm.totals || {}, htotals = hist.totals || {};

    document.getElementById('dorm-summary').textContent = st.enabled
      ? (st.dormancy_months + '-month window · ' + st.active_window_days + '-day active set')
      : 'policy OFF (enable in Settings → Payout)';
    document.getElementById('dk-state').textContent = st.enabled ? (pv.frozen ? 'FROZEN' : 'ON') : 'OFF';
    document.getElementById('dk-dormant').textContent = fmtGrin(totals.amount || 0) + ' ツ';
    document.getElementById('dk-sweep').textContent = (pv.would_sweep ? pv.would_sweep.count : 0) + ' addr · ' + fmtGrin(pv.would_sweep ? pv.would_sweep.amount : 0) + ' ツ';
    document.getElementById('dk-recip').textContent = 'Prize pool';
    document.getElementById('dk-disposed').textContent = fmtGrin(htotals.total_disposed || 0) + ' ツ';

    const runBtn = document.getElementById('dorm-run-btn');
    const runNote = document.getElementById('dorm-run-note');
    runBtn.disabled = !!pv.blocked;
    runNote.textContent = pv.blocked ? ('blocked: ' + (BLOCK_LABEL[pv.blocked] || pv.blocked)) : 'ready';

    const list = Array.isArray(dorm.list) ? dorm.list : [];
    document.getElementById('dorm-list-note').textContent = list.length ? ('(' + totals.count + ' total)') : '';
    dormListTable.setRows(list);
    dormHistTable.setRows(Array.isArray(hist.batches) ? hist.batches : []);
  } catch (err) {
    document.getElementById('dorm-summary').textContent = 'unavailable';
    dormListTable.setError(err.message);
    dormHistTable.setError(err.message);
  }
}

async function runDisposition() {
  if (!confirm('Run an abandoned-balance disposition NOW?\n\nThis permanently sweeps eligible dormant balances into the community prize pool. It is FINAL.')) return;
  try {
    const res = await adminFetch('/api/admin/dormancy/run', { method: 'POST' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || ('HTTP ' + res.status));
    const r = body.result || {};
    flash(r.disposed ? `Disposed ${(r.swept || 0).toFixed(4)} ツ from ${r.sources} address(es) → prize pool.` : `No disposition: ${r.skipped || 'nothing eligible'}.`, false);
    loadDormancy();
  } catch (err) { flash(err.message, true); }
}

// The Policy KPI and the Run button's "blocked: payouts frozen" come from /api/admin/dormancy,
// not from the freeze poll. So when the freeze state CHANGES (this page's toggle, or the 60 s
// poll seeing a freeze made elsewhere), re-read the policy at once. Otherwise the page shows a
// red FROZEN banner above "Policy ON · ready" for up to 2 minutes. An unchanged poll re-reads
// nothing, so the 120 s cadence stays as it is.
let _dormFrozenSeen = null;
window.onPayoutFreezeChange = () => {
  if (_dormFrozenSeen !== null && _dormFrozenSeen !== _frozen) loadDormancy();
  _dormFrozenSeen = _frozen;
};

document.addEventListener('DOMContentLoaded', () => { loadPayoutControl(); loadDormancy(); });
// The dormancy read is a DB scan (no wallet call) — 2 min. The freeze state is a cheap DB read: 60s.
setInterval(loadPayoutControl, 60000);
setInterval(loadDormancy, 120000);

// ==== F3: event wiring — replaces the inline on*= attributes (strict script-src, no inline handlers).
// One delegated listener per event type; data-action names the handler. Every old handler ignored
// the Event and `this` except where noted, so the wrappers pass exactly the arguments the attribute did.
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  switch (el.dataset.action) {
    case 'run-disposition': runDisposition(); break;
    case 'toggle-payouts':  togglePayouts(); break;
  }
});
