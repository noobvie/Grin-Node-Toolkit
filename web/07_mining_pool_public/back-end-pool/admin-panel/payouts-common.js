/* payouts-common.js — shared logic for the admin payout pages (2026-10).
   Moved out of payments.html's inline <script>; only flash() (which message element) and
   renderFreeze() (the hook below) changed. Loaded by the payout pages only (payments.html =
   the queue, treasury.html, dormant.html), after stepup.js — togglePayouts() needs
   adminFetch() — and before the page's own inline script, which calls into it. A classic
   script, not a module: the top-level function declarations stay global so the pages'
   onclick="…" handlers reach them.

   WHY a shared file: the payouts page was split by SUBJECT (queue / treasury / dormant
   balances), and every one of those pages needs the same freeze kill-switch, helpers and
   status list. Two copies of the in-flight list are how a wallet-switch wizard comes to
   count a different set than the queue does — so there is exactly one, here.

   Each page provides:
     #freeze-banner, #freeze-toggle   the kill-switch banner + button (renderFreeze fills them)
     ONE element marked data-payout-msg, with style="display:none" INLINE — flash() writes
       there. Never hide it with a class that carries display:none (the 2026-09-19 bug that
       made every admin flash invisible).
     optionally window.onPayoutFreezeChange — called after every renderFreeze(), for a page
       that mirrors the freeze state somewhere else on screen. */

function escHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function fmtGrin(v) { return (Number(v) || 0).toFixed(4); }
function fmtTs(t)   { return t ? new Date(t * 1000).toLocaleString() : '—'; }
function shortAddr(a) {
  a = String(a || '');
  return a.length > 18 ? a.slice(0, 10) + '…' + a.slice(-6) : a;
}

// Every payout status whose coins are still committed (amount locked, send not settled). It
// drives the queue's "Active" filter chip AND the wallet-switch wizard's in-flight count: a
// status missing here hides exactly the payouts an operator is looking for, and lets the
// wizard read "none in flight" while a send is mid-flight. Held belongs here — its one send
// may still be in the wallet. Never re-declare this list on a page.
const PAYOUT_ACTIVE_STATUSES = Object.freeze(['tor_checking', 'tor_sending', 'tor_held', 'retry_scheduled', 'slatepack_pending', 'finalizing']);

function flash(msg, isErr) {
  const el = document.querySelector('[data-payout-msg]');
  el.textContent = msg;
  el.className = isErr ? 'error-msg' : 'success-msg';
  el.style.display = '';
  setTimeout(() => { el.style.display = 'none'; }, 5000);
}

// ── Payout kill-switch ────────────────────────────────────────────────────────
let _frozen = false;
function renderFreeze(ctrl) {
  _frozen = !!(ctrl && ctrl.frozen);
  const banner = document.getElementById('freeze-banner');
  const btn = document.getElementById('freeze-toggle');
  if (_frozen) {
    const when = ctrl.frozen_at ? new Date(ctrl.frozen_at * 1000).toLocaleString() : '—';
    banner.innerHTML = `<div class="health-card error" style="margin-bottom:1rem;">
      <div class="health-name">⛔ PAYOUTS FROZEN <span class="badge badge-error">no payouts are being sent</span></div>
      <div class="health-detail" style="margin-top:.4rem;">
        Reason: ${escHtml(ctrl.reason || '—')}<br>By: ${escHtml(ctrl.frozen_by || '—')} · ${escHtml(when)} UTC-local</div></div>`;
    btn.textContent = '▶ Resume payouts';
    btn.className = 'btn btn-sm';
  } else {
    banner.innerHTML = '';
    btn.textContent = '⛔ Freeze payouts';
    btn.className = 'btn btn-sm btn-outline';
  }
  btn.style.display = '';
  if (typeof window.onPayoutFreezeChange === 'function') window.onPayoutFreezeChange();
}

async function loadPayoutControl() {
  try {
    const ctrl = await API.get('/api/admin/payouts/control');
    renderFreeze(ctrl);
  } catch (e) {}
}

async function togglePayouts() {
  if (_frozen) {
    if (!confirm('Resume automated payouts? Only do this once you have confirmed the wallet and ledger are safe.')) return;
    try {
      const res = await adminFetch('/api/admin/payouts/resume', { method: 'POST' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || ('HTTP ' + res.status));
      renderFreeze(body);
      flash('Payouts resumed.', false);
    } catch (err) { flash(err.message, true); }
  } else {
    const reason = prompt('Freeze ALL automated payouts now?\n\nOptional reason:');
    if (reason === null) return;
    try {
      const res = await adminFetch('/api/admin/payouts/freeze', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason })
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || ('HTTP ' + res.status));
      renderFreeze(body);
      flash('Payouts frozen — no payouts will be sent until resumed.', false);
    } catch (err) { flash(err.message, true); }
  }
}
