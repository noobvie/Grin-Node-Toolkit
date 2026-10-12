// treasury.html page script — moved BYTE-verbatim out of the page's inline <script> (code-layout F3).
// Classic script (no defer/module) loaded at the same position as the old block, after auth.js,
// api.js, admin-shell.js, stepup.js and payouts-common.js, whose globals it uses (H14).
// Treasury: is the pool solvent, and is it paying from the right wallet? Moved off payments.html
// (2026-10), which kept the payout queue. Every action below keeps its endpoint, step-up and
// confirm text from there.
// Auth gate (httpOnly-cookie aware): redirects to /login.html if not an admin, else wires
// up the topbar username + Logout. Pool name + testnet banner are handled by admin-shell.js.
// stepup.js provides adminFetch() for the step-up-gated wizard actions and the freeze toggle.
// payouts-common.js provides escHtml/fmtGrin, flash() (→ #tr-msg, the data-payout-msg element),
// the freeze kill-switch (_frozen, renderFreeze, …) and PAYOUT_ACTIVE_STATUSES.
API.guardAdminPage();

// ── Reconciliation ──────────────────────────────────────────────────────────
// Signed money-value formatter with an explicit + on positives (gaps/drift read clearer).
function fmtSigned(v) { const n = Number(v) || 0; return (n >= 0 ? '+' : '') + n.toFixed(4); }

// Colour a gap/drift KPI: green when healthy (≥0 for gaps, ~0 for drift), red otherwise.
function setGap(id, value, ok) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = fmtSigned(value) + ' ツ';
  el.style.color = ok === false ? 'var(--danger)' : (ok === true ? 'var(--success)' : 'var(--text)');
}

async function loadReconciliation() {
  const msg = document.getElementById('recon-msg');
  try {
    const d = await API.get('/api/admin/reconciliation');
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    const w = d.wallet || {};
    const c = d.checks || {};

    // Coverage
    set('rc-w-spend',    w.reachable ? fmtGrin(w.spendable) + ' ツ' : 'unreachable');
    set('rc-owed-spend', fmtGrin(d.ledger.spendable_owed) + ' ツ');
    setGap('rc-gap-liquid', c.coverage_liquid_gap, c.coverage_liquid_ok);
    set('rc-w-total',    w.reachable ? fmtGrin(w.held) + ' ツ' : 'unreachable');
    set('rc-owed-total', fmtGrin(d.ledger.total_owed) + ' ツ');
    setGap('rc-gap-full', c.coverage_full_gap, c.coverage_full_ok);

    // Maturity
    set('rc-w-immature',  w.reachable ? fmtGrin(w.immature) + ' ツ' : '—');
    set('rc-imm-blocks',  `${d.immature_blocks.count} (${fmtGrin(d.immature_blocks.reward_sum)} ツ)`);
    set('rc-w-locked',    w.reachable ? fmtGrin(w.locked) + ' ツ' : '—');
    set('rc-pending',     `${d.pending_withdrawals.count} (${fmtGrin(d.pending_withdrawals.amount)} ツ)`);
    setGap('rc-drift-locked',    c.locked_drift, c.locked_ok);
    setGap('rc-drift-integrity', c.integrity_drift, c.integrity_ok);

    // Flow statement — 24h / 7d / lifetime columns
    const F = d.flows || {};
    const flowRow = (dir, label, field, strong) => {
      const val = (win) => fmtGrin((((F[win] || {})[dir] || {})[field]) || 0);
      const lbl = strong ? `<strong>${label}</strong>` : label;
      return `<tr${strong ? ' style="background:color-mix(in srgb, var(--accent) 8%, transparent);"' : ''}>
        <td>${dir === 'in' ? 'IN' : 'OUT'}</td><td>${lbl}</td>
        <td class="mono" style="text-align:right;">${val('d1')}</td>
        <td class="mono" style="text-align:right;">${val('d7')}</td>
        <td class="mono" style="text-align:right;">${val('lifetime')}</td></tr>`;
    };
    const netRow = () => {
      const net = (win) => fmtSigned(((F[win] || {}).net) || 0);
      const bad = ((F.lifetime || {}).net || 0) < 0;
      return `<tr style="border-top:2px solid var(--border);font-weight:600;${bad ? 'color:var(--danger);' : ''}">
        <td colspan="2">NET (in − out)</td>
        <td class="mono" style="text-align:right;">${net('d1')}</td>
        <td class="mono" style="text-align:right;">${net('d7')}</td>
        <td class="mono" style="text-align:right;">${net('lifetime')}</td></tr>`;
    };
    document.getElementById('recon-flow-tbody').innerHTML =
      flowRow('in',  'Block rewards → miners', 'block_rewards') +
      flowRow('in',  'Pool fee collected',     'pool_fee') +
      flowRow('in',  'Prize-pool top-ups',     'prize_topup') +
      flowRow('in',  'Admin injections',       'admin_inject') +
      flowRow('in',  'Total IN',               'total', true) +
      flowRow('out', 'Payouts confirmed',      'payouts') +
      flowRow('out', 'Operator revenue withdrawn', 'operator_withdrawals') +
      flowRow('out', 'Orphan clawbacks',       'orphan_clawback') +
      flowRow('out', '(of which network fees)', 'payout_network_fees') +
      flowRow('out', 'Total OUT',              'total', true) +
      netRow();

    // Buckets
    const b = d.ledger.buckets || {};
    const fee = b.pool_fee || {}, prize = b.prize_pool || {};
    document.getElementById('recon-bucket-tbody').innerHTML = `
      <tr>
        <td><strong>Pool fee</strong><br><span style="color:var(--text-dim);font-size:.8rem;">operator revenue</span></td>
        <td class="mono">${fmtGrin(fee.balance)} ツ<br><span style="color:var(--text-dim);font-size:.8rem;" title="The balance minus payout network fees the ledger has not booked yet — what you can actually withdraw">available ${fmtGrin(fee.available)} ツ</span></td>
        <td style="font-size:.85rem;">Collected ${fmtGrin(fee.collected)} · diverted to prizes ${fmtGrin(fee.diverted_to_prizes)} · network fees booked ${fmtGrin(fee.network_fees_booked)} (${fmtGrin(fee.network_fees_unbooked)} not yet) · withdrawn ${fmtGrin(fee.operator_realized)} · <a href="payments.html#sec-manual-payouts">withdraw revenue</a></td>
      </tr>
      <tr>
        <td><strong>Prize pool</strong><br><span style="color:var(--text-dim);font-size:.8rem;">contest budget available</span></td>
        <td class="mono">${fmtGrin(prize.balance)} ツ</td>
        <td style="font-size:.85rem;">Funded ${fmtGrin(prize.funded)} (fee ${fmtGrin(prize.from_fee)} · donations ${fmtGrin(prize.from_donations)} · top-ups ${fmtGrin(prize.from_topups)}) · awarded ${fmtGrin(prize.awarded)}</td>
      </tr>`;

    // Overall banner
    const banner = document.getElementById('recon-banner');
    const problems = [];
    if (c.coverage_liquid_ok === false) problems.push('⚠ Wallet spendable does NOT cover currently-withdrawable balances (cannot pay out now).');
    if (c.coverage_full_ok === false) problems.push('⚠ Wallet held (total + locked) does NOT cover everything owed (under-funded).');
    if (c.locked_ok === false) problems.push('⚠ Locked-balance ledger does not match in-flight withdrawals.');
    if (c.integrity_ok === false) problems.push(`⚠ INTEGRITY DRIFT ${fmtSigned(c.integrity_drift)} ツ — a balance moved without a ledger row (bug or tampering).`);
    if (((F.lifetime || {}).net || 0) < 0) problems.push('⚠ Lifetime OUT exceeds IN — impossible under correct accounting.');
    if (!w.reachable) problems.push('Wallet was unreachable — coverage checks skipped.');
    if (problems.length) {
      banner.innerHTML = `<div class="health-card error" style="margin-bottom:.8rem;">
        <div class="health-detail">${problems.map(escHtml).join('<br>')}</div></div>`;
    } else {
      banner.innerHTML = `<div class="health-card ok" style="margin-bottom:.8rem;">
        <div class="health-detail">✓ Wallet covers all balances · ledger reconciles with the log · IN &gt; OUT.</div></div>`;
    }

    document.getElementById('recon-refresh').textContent =
      '(refreshed ' + new Date().toLocaleTimeString() + ' — every 3 min)';
    if (msg) msg.style.display = 'none';
  } catch (err) {
    if (msg) { msg.textContent = 'Reconciliation error: ' + err.message; msg.style.display = ''; }
  }
}

// ── Wallet-send audit ─────────────────────────────────────────────────────────
// The card only appears when there ARE unmatched sends, so the tools bar + pager are
// shown/hidden with it via setVisible() — otherwise they'd float above a hidden table.
const waTable = AdminTable.create({
  tbody: 'wa-tbody',
  search: 'Filter by tx id or slate…',
  empty: 'No unmatched sends.',
  note: 'Read live from the wallet over the last {days} days — not stored by the pool.',
  text: s => [s.tx_id, s.slate_id, s.amount].join(' '),
  row: s => `<tr>
    <td class="mono" title="${escHtml(String(s.tx_id))}">#${escHtml(String(s.tx_id))}</td>
    <td class="mono" style="text-align:right;color:var(--danger);">${(s.amount || 0).toFixed(4)}</td>
    <td>${escHtml(new Date(s.when * 1000).toISOString().replace('T', ' ').slice(0, 19))}</td>
    <td class="mono">${escHtml(s.slate_id ? (s.slate_id.slice(0, 8) + '…') : '—')}</td>
  </tr>`
});
waTable.setVisible(false);

async function loadWalletAudit() {
  const banner = document.getElementById('wa-banner');
  const card = document.getElementById('wa-card');
  const summary = document.getElementById('wa-summary');
  try {
    const a = await API.get('/api/admin/payouts/wallet-audit');
    if (!a.reachable) {
      summary.textContent = '(wallet unreachable)';
      banner.innerHTML = ''; card.style.display = 'none';
      waTable.setVisible(false);
      return;
    }
    summary.textContent = `${a.matched} matched · ${a.scanned} scanned (last ${a.window_days}d)`;
    waTable.setNoteDays(a.window_days);
    const un = a.unrecorded || [];
    if (un.length) {
      banner.innerHTML = `<div class="health-card error" style="margin-bottom:.6rem;">
        <div class="health-name">⚠ ${un.length} UNRECORDED wallet send(s) — ${(a.total_unrecorded || 0).toFixed(4)} ツ
          <span class="badge badge-error">not in the pool ledger</span></div>
        <div class="health-detail" style="margin-top:.3rem;">These left the wallet without a pool payout. If this was you (e.g. a cold-storage sweep), resume payouts above once confirmed; otherwise treat as a compromise.</div></div>`;
      waTable.setRows(un.slice().sort((x, y) => y.amount - x.amount));
      card.style.display = '';
      waTable.setVisible(true);
    } else {
      banner.innerHTML = `<div class="health-card ok" style="margin-bottom:.6rem;">
        <div class="health-detail">✓ Every wallet send matches a pool payout — no out-of-band sends.</div></div>`;
      card.style.display = 'none';
      waTable.setVisible(false);
    }
  } catch (err) {
    summary.textContent = '';
    banner.innerHTML = `<div class="health-card error" style="margin-bottom:.6rem;"><div class="health-detail">Audit error: ${escHtml(err.message)}</div></div>`;
    card.style.display = 'none';
    waTable.setVisible(false);
  }
}

// ── Wallet-identity guard ─────────────────────────────────────────────────────
function renderIdentity(id) {
  const banner = document.getElementById('wi-banner');
  const summary = document.getElementById('wi-summary');
  if (!id || !id.reachable) {
    summary.textContent = '(wallet unreachable)';
    banner.innerHTML = `<div class="health-card" style="margin-bottom:.6rem;"><div class="health-detail">Wallet unreachable — identity not verified this cycle.</div></div>`;
    return;
  }
  const short = (a) => a ? (a.slice(0, 12) + '…' + a.slice(-6)) : '—';
  if (id.firstRun || id.match) {
    summary.textContent = 'pinned ✓';
    banner.innerHTML = `<div class="health-card ok" style="margin-bottom:.6rem;">
      <div class="health-detail">✓ Live wallet matches the adopted identity <span class="mono">${escHtml(short(id.live))}</span>.</div></div>`;
  } else {
    summary.textContent = 'MISMATCH';
    banner.innerHTML = `<div class="health-card error" style="margin-bottom:.6rem;">
      <div class="health-name">⛔ WALLET IDENTITY CHANGED <span class="badge badge-error">payouts auto-frozen</span></div>
      <div class="health-detail" style="margin-top:.3rem;">
        Adopted: <span class="mono">${escHtml(short(id.expected))}</span><br>
        Live now: <span class="mono" style="color:var(--danger);">${escHtml(short(id.live))}</span><br>
        If you switched wallets on purpose, run the switch wizard to adopt the new wallet. Otherwise treat as a compromise.</div></div>`;
  }
}

async function loadWalletIdentity() {
  try { renderIdentity(await API.get('/api/admin/wallet/identity')); }
  catch (e) { /* leave last state */ }
}

// ── Switch-wallet wizard ──────────────────────────────────────────────────────
function swMsg(t, err) { const el = document.getElementById('sw-msg'); el.textContent = t || ''; el.style.color = err ? 'var(--danger)' : 'var(--success)'; }

function openSwitchWizard() { document.getElementById('sw-card').style.display = ''; wizRefreshState(); }
function closeSwitchWizard() { document.getElementById('sw-card').style.display = 'none'; }

// The in-flight count is read FRESH from the payout queue's endpoint — Treasury holds no queue.
// One query per status in PAYOUT_ACTIVE_STATUSES (the route's ?status= filter), not the newest
// 100 rows the Queue page loads: on a live pool those 100 are mostly paid rows, and an older
// Held payout past row 100 would be missed. A read that did not look must never say "none in
// flight": any failed query, or a list carrying a status it did not ask for, reads UNKNOWN, in
// the danger colour.
const WIZ_STATUS_CAP = 100;   // per status; a status that fills it is shown as "N+"
let _wizSeq = 0;              // the newest wizRefreshState call wins; a late older answer is dropped

// Reflect freeze state + in-flight payout count into the wizard steps. A no-op while the wizard
// is closed: it is also this page's onPayoutFreezeChange hook (below), which fires on every
// freeze poll, and only an open wizard has anything to show or a reason to read the queue.
async function wizRefreshState() {
  if (document.getElementById('sw-card').style.display === 'none') return;
  const s1 = document.getElementById('sw-s1-state');
  s1.textContent = _frozen ? 'frozen ✓' : 'not frozen';
  s1.className = 'badge ' + (_frozen ? 'badge-success' : 'badge-warning');
  document.getElementById('sw-freeze-btn').disabled = _frozen;
  const el = document.getElementById('sw-inflight');
  const seq = ++_wizSeq;
  el.textContent = 'checking…';
  let per;
  try {
    per = await Promise.all(PAYOUT_ACTIVE_STATUSES.map(s =>
      API.get('/api/admin/withdrawals?status=' + encodeURIComponent(s) + '&limit=' + WIZ_STATUS_CAP)));
    if (!per.every(Array.isArray)) throw new Error('unexpected reply from the payout queue');
    // Each list must hold ONLY the status it asked for. A row of any other status means the
    // route ignored ?status= and answered with the newest rows instead — on a live pool those
    // are mostly paid, so the filtered count would be 0 and read "none in flight" past an older
    // Held payout. Such a reply proves nothing: UNKNOWN. (With this check a full list holds
    // 100 in-flight rows, so a capped read can never come out as zero.)
    if (per.some((rows, i) => rows.some(w => !w || w.status !== PAYOUT_ACTIVE_STATUSES[i]))) {
      throw new Error('the payout queue did not filter by status');
    }
  } catch (err) {
    if (seq !== _wizSeq) return;
    el.innerHTML = `<span style="color:var(--danger);">in-flight count UNKNOWN</span> — ${escHtml(err.message)}. ` +
      'Do not switch until this reads a number (it re-checks every minute while the wizard is open)';
    return;
  }
  if (seq !== _wizSeq) return;
  // The server already filtered by status; the shared list is applied again so the wizard can
  // only ever count what the Queue's "Active" chip shows.
  const n = [].concat(...per).filter(w => PAYOUT_ACTIVE_STATUSES.includes(w.status)).length;
  const capped = per.some(rows => rows.length >= WIZ_STATUS_CAP);
  el.innerHTML = n === 0
    ? '<span style="color:var(--success);">none in flight ✓</span>'
    : `<span style="color:var(--danger);">${n}${capped ? '+' : ''} still in flight</span> — wait for these to finish before switching`;
}
// The freeze toggle (payouts-common.js) re-renders step 1 through this hook; wizFreeze/wizResume
// also call wizRefreshState directly (the newest call wins, see _wizSeq).
window.onPayoutFreezeChange = wizRefreshState;

async function wizFreeze() {
  try {
    const res = await adminFetch('/api/admin/payouts/freeze', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'wallet switch (wizard)' })
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || ('HTTP ' + res.status));
    renderFreeze(body); wizRefreshState();
    swMsg('Payouts frozen — safe to switch the wallet on the server now.', false);
  } catch (err) { swMsg(err.message, true); }
}

let _wizVerified = false;
async function wizVerify() {
  swMsg('Checking new wallet…', false);
  try {
    const [id, recon] = await Promise.all([
      API.get('/api/admin/wallet/identity'),
      API.get('/api/admin/reconciliation')
    ]);
    renderIdentity(id);
    const c = (recon && recon.checks) || {};
    const w = (recon && recon.wallet) || {};
    const lines = [];
    if (!id.reachable) lines.push('⚠ Wallet unreachable — cannot adopt yet.');
    else if (id.firstRun) lines.push('New wallet detected — no prior identity was pinned.');
    else if (id.match) lines.push('Live wallet matches the CURRENTLY-adopted identity (no change detected).');
    else lines.push('New wallet differs from the adopted one — adopting will re-pin to it.');
    if (w.reachable) lines.push(`Coverage: wallet held ${Number(w.held).toFixed(4)} ツ vs owed ${Number(recon.ledger.total_owed).toFixed(4)} ツ → ${c.coverage_full_ok === false ? '⚠ UNDER-FUNDED' : 'covered ✓'}`);
    document.getElementById('sw-verify').innerHTML = lines.map(escHtml).join('<br>');
    _wizVerified = !!id.reachable;
    document.getElementById('sw-adopt-btn').disabled = !_wizVerified;
    swMsg(_wizVerified ? 'Verified — you can adopt the new wallet.' : 'Wallet not reachable yet; re-check after it finishes syncing.', !_wizVerified);
  } catch (err) { swMsg(err.message, true); }
}

async function wizAdopt() {
  if (!confirm('Adopt the currently-connected wallet as the pool identity?\n\nDo this only after confirming the new wallet is the correct one and has synced.')) return;
  try {
    const res = await adminFetch('/api/admin/wallet/adopt-identity', { method: 'POST' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || ('HTTP ' + res.status));
    await loadWalletIdentity();
    document.getElementById('sw-resume-btn').disabled = false;
    swMsg('New wallet adopted. Resume payouts when ready.', false);
  } catch (err) { swMsg(err.message, true); }
}

async function wizResume() {
  try {
    const res = await adminFetch('/api/admin/payouts/resume', { method: 'POST' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || ('HTTP ' + res.status));
    renderFreeze(body); wizRefreshState();
    swMsg('Payouts resumed. Wallet switch complete.', false);
    flash('Wallet switched and payouts resumed.', false);
  } catch (err) { swMsg(err.message, true); }
}

document.addEventListener('DOMContentLoaded', () => { loadPayoutControl(); loadReconciliation(); loadWalletAudit(); loadWalletIdentity(); });
// Reconciliation, the wallet-send audit, and the wallet-identity probe each force a wallet call
// (slow) — keep them on the relaxed 3-min cadence. The freeze state is a cheap DB read: 60s.
setInterval(loadPayoutControl, 60000);
setInterval(loadReconciliation, 180000);
setInterval(loadWalletAudit, 180000);
setInterval(loadWalletIdentity, 180000);

// ==== F3: event wiring — replaces the inline on*= attributes (strict script-src, no inline handlers).
// One delegated listener per event type; data-action names the handler. Every old handler ignored
// the Event and `this` except where noted, so the wrappers pass exactly the arguments the attribute did.
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  switch (el.dataset.action) {
    case 'toggle-payouts':      togglePayouts(); break;
    case 'open-switch-wizard':  openSwitchWizard(); break;
    case 'close-switch-wizard': closeSwitchWizard(); break;
    case 'wiz-freeze':          wizFreeze(); break;
    case 'wiz-verify':          wizVerify(); break;
    case 'wiz-adopt':           wizAdopt(); break;
    case 'wiz-resume':          wizResume(); break;
  }
});
