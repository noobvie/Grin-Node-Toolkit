// payments.html page script — moved BYTE-verbatim out of the page's inline <script> (code-layout F3).
// Classic script (no defer/module) loaded at the same position as the old block, after auth.js,
// api.js, admin-shell.js, stepup.js and payouts-common.js, whose globals it uses (H14).
// (The old-deep-link forwarder is in <head>.)
let _withdrawals = [];
let _filter = 'all';

// Auth gate (httpOnly-cookie aware): redirects to /login.html if not an admin, else wires
// up the topbar username + Logout. Pool name + testnet banner are handled by admin-shell.js.
// stepup.js provides adminFetch() for the step-up-gated cancel / Held re-check / forced-refund actions.
// payouts-common.js provides escHtml/fmtGrin/fmtTs/shortAddr, flash() (→ #pay-msg, the
// data-payout-msg element), the freeze kill-switch and PAYOUT_ACTIVE_STATUSES.
API.guardAdminPage();

// Every status the scheduler can write. The slatepack and Goblin rails were missing here, so
// their rows fell through to ['badge-dim', <raw status>] — showing "slatepack_pending" in the
// same grey the panel uses for CANCELLED, i.e. an in-flight payout reading as a dead one.
// The labels carry no rail: the badge appends it from w.method (RAIL below), so every row reads
// "Paid · Tor" / "Failed · Slatepack" the same way instead of only the failed ones naming it.
const STATUS = {
  tor_checking:      ['badge-warn',  'Checking'],
  tor_sending:       ['badge-warn',  'Sending'],
  tor_held:          ['badge-warn',  'Held'],
  // LEGACY: no new row lands here since 2026-09-26; the scheduler migrates old ones on its
  // first pass (confirmed / refunded / Held). Kept so such a row never renders raw.
  retry_scheduled:   ['badge-warn',  'Legacy retry'],
  slatepack_pending: ['badge-warn',  'Awaiting slate'],
  finalizing:        ['badge-warn',  'Settling'],
  confirmed:         ['badge-ok',    'Paid'],
  tor_failed:        ['badge-error', 'Failed'],
  slatepack_failed:  ['badge-error', 'Failed'],
  nostr_failed:      ['badge-error', 'Failed'],
  slatepack_expired: ['badge-dim',   'Expired'],
  cancelled:         ['badge-dim',   'Cancelled'],
};
// The payout's rail (withdrawals.method, NOT NULL DEFAULT 'tor'). 'nostr' is the Goblin rail and
// 'manual' an admin's out-of-band payout. An unknown value renders raw rather than vanishing.
const RAIL = { tor: 'Tor', slatepack: 'Slatepack', nostr: 'Goblin', manual: 'Manual' };
const railOf = (w) => (w.method ? (RAIL[w.method] || w.method) : '');
// Where a PAID row stands on chain (GET /api/admin/withdrawals chain_state, from the scheduler's
// "marked paid but not mined" watchdog). 'mined' needs no badge; the rest sit beside "Paid".
const CHAIN = {
  settling:     ['badge-dim',   'mining…',          'Paid under an hour ago - not seen mined yet, which is normal'],
  unmined:      ['badge-warn',  'not mined',        'Marked paid over an hour ago but not seen mined. The pool re-broadcasts the stored transaction hourly - see Health / Alerts'],
  cancelled:    ['badge-error', 'cancelled in wallet', 'The pool wallet CANCELLED this transaction - the miner was debited but NOT paid. Settle it by hand (see the payout_unmined alert)'],
  absent:       ['badge-error', 'not in wallet',    'The pool wallet has no record of this slate - check the wallet that sent it and the explorer before acting'],
  unverifiable: ['badge-warn',  'unverifiable',     'No slate id was captured for this payout, so the wallet cannot be asked whether it mined'],
};
// The "active" filter chip reads PAYOUT_ACTIVE_STATUSES (payouts-common.js) — never a local copy.
// Why a Tor payout failed (fail_code, public-safe) — the operator reads fail_detail beside it.
const FAIL_CODE = {
  wallet_offline:         'miner wallet offline (counted)',
  wallet_offline_cleared: 'miner wallet offline (un-counted by an admin)',
  wallet_unreachable:     'miner wallet unreachable (probe could not look)',
  pool_send_path:         'POOL send path — the wallet answered our probe',
  pool_busy:              'POOL wallet could not cover it',
  unknown:                'Held, then proven not sent',
};

// An operator revenue withdrawal leaves the 'pool_fee' bucket for the operator's own wallet
// (dest_address). Shown as such — 'pool_fee' alone reads as a payout to nobody.
const isRevenue = (w) => w.grin_address === 'pool_fee';
function addrCell(w) {
  if (isRevenue(w)) {
    return `<span class="badge badge-ok">Operator revenue</span> → <span class="mono" title="${escHtml(w.dest_address || '')}">${escHtml(shortAddr(w.dest_address || '—'))}</span>`;
  }
  return `<span class="mono" title="${escHtml(w.grin_address)}">${escHtml(shortAddr(w.grin_address))}</span>`;
}

function matchesFilter(w) {
  if (_filter === 'all') return true;
  if (_filter === 'active') return PAYOUT_ACTIVE_STATUSES.includes(w.status);
  return w.status === _filter;
}

async function loadQueueSummary() {
  try {
    const s = await API.get('/api/admin/withdrawal-scheduler');
    document.getElementById('queue-summary').textContent =
      `${s.pending || 0} pending · ${s.held_count || 0} held · ${s.failed || 0} failed · ${fmtGrin(s.total_paid_24h)} ツ paid (24h)`;
  } catch (e) {}
}

// Search + 20-per-page paging from AdminTable (admin-shell.js). The status chips above
// stay page-side and feed it a pre-filtered array; the search box narrows within that.
const payTable = AdminTable.create({
  tbody: 'pay-tbody',
  search: 'Filter by address, id or status…',
  // ?q= prefills this box — miners.html links here as payments.html?q=<address>.
  urlQuery: true,
  empty: 'No withdrawals in this view.',
  note: 'Payout records are kept permanently — this view loads the 100 most recent.',
  text: w => [w.id, w.grin_address, w.dest_address, isRevenue(w) ? 'operator revenue' : '', w.status,
              (STATUS[w.status] || [])[1], w.method, railOf(w),
              w.cancel_reason, w.fail_code, w.fail_detail, (CHAIN[w.chain_state] || [])[1]].join(' '),
  row: w => {
    const [cls, status] = STATUS[w.status] || ['badge-dim', w.status];
    const rail = railOf(w);
    const label = rail ? `${status} · ${rail}` : status;
    const chain = CHAIN[w.chain_state];
    const chainBadge = chain
      ? ` <span class="badge ${chain[0]}" title="${escHtml(chain[2])}">${escHtml(chain[1])}</span>`
      : '';
    // No Retry: a Tor payout is tried once (the route answers 410). Cancel only where the server
    // allows it: a never-sent tor_checking row. Never Held (its send may have landed), never a
    // legacy retry_scheduled row, and never tor_failed — it was refunded when it failed, so
    // cancel had nothing to return and only relabelled it (the server answers 409).
    const canCancel = w.status === 'tor_checking';
    const isHeld    = w.status === 'tor_held';
    // Signed payment proof — the dispute document (recipient's own signature over amount +
    // kernel + sender). Only a confirmed Tor payout can have one; a row whose backfill has not
    // stored it yet still gets the button, because the route fetches it from the wallet on demand.
    const canProof = w.status === 'confirmed' && w.method === 'tor' && w.slate_id && w.kernel_excess;
    let actions = '';
    if (canProof)  actions += `<button class="btn-icon" data-action="download-proof" data-id="${w.id}" data-tip="${w.has_payment_proof ? 'Download the signed payment proof' : 'Fetch the signed payment proof from the wallet and download it'}" aria-label="Download the signed payment proof">🧾</button>`;
    if (isHeld) {
      actions += `<button class="btn-icon" data-action="recheck-held" data-id="${w.id}" data-tip="Re-check now: read the wallet's tx log for this payout (no send)" aria-label="Re-check this held payout">🔎</button>`;
      actions += `<button class="btn-icon btn-icon-danger" data-action="force-refund-held" data-id="${w.id}" data-amount="${fmtGrin(w.amount)}" data-tip="Forced refund: only once you have proven it never reached the chain (step-up, typed payout ID)" aria-label="Force-refund this held payout">↩</button>`;
    }
    if (canCancel) actions += `<button class="btn-icon btn-icon-danger" data-action="cancel-withdrawal" data-id="${w.id}" data-amount="${fmtGrin(w.amount)}" data-tip="Cancel this payout (refunds the balance)" aria-label="Cancel this payout">❌</button>`;
    actions = actions
      ? `<div class="row-actions">${actions}</div>`
      : '<span style="color:var(--text-dim)">—</span>';
    const reason = w.cancel_reason ? ` title="${escHtml(w.cancel_reason)}"` : '';
    // Reason column: why a Tor payout failed or is held (fail_code + the CLI's own fail_detail,
    // admin-only), else the cancel reason. The first 140 chars show; the full text is the tip.
    let why = '<span style="color:var(--text-dim)">—</span>';
    if (w.fail_code || w.fail_detail) {
      const detail = String(w.fail_detail || '');
      const short = detail.length > 140 ? detail.slice(0, 140) + '…' : detail;
      why = (w.fail_code ? `<span class="mono" title="${escHtml(FAIL_CODE[w.fail_code] || '')}">${escHtml(w.fail_code)}</span>` : '')
          + (detail ? `<div class="mono" style="font-size:.75rem;color:var(--text-dim);white-space:normal;word-break:break-word;max-width:28rem;" title="${escHtml(detail)}">${escHtml(short)}</div>` : '');
    } else if (w.cancel_reason) {
      why = `<span style="font-size:.8rem;">${escHtml(w.cancel_reason)}</span>`;
    }
    return `<tr>
      <td class="mono">${w.id}</td>
      <td>${addrCell(w)}</td>
      <td class="mono">${fmtGrin(w.amount)}</td>
      <td><span class="badge ${cls}"${reason}>${escHtml(label)}</span>${chainBadge}</td>
      <td>${why}</td>
      <td>${fmtTs(w.created_at)}</td>
      <td>${fmtTs(w.confirmed_at)}</td>
      <td>${actions}</td>
    </tr>`;
  }
});

async function loadWithdrawals() {
  try {
    const items = await API.get('/api/admin/withdrawals');
    _withdrawals = Array.isArray(items) ? items : [];
    render();
  } catch (err) {
    payTable.setError(err.message);
  }
}

// `resetPage` only when a status chip changed — the 30s refresh must not pull the
// operator off the page they are reading.
function render(resetPage) {
  payTable.setRows(_withdrawals.filter(matchesFilter), { reset: resetPage === true });
}

function setFilter(f, btn) {
  _filter = f;
  document.querySelectorAll('#filter-chips .tab-btn').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  render(true);
}

// Saves the proof as the JSON `grin-wallet export_proof` would write, so `grin-wallet
// verify_proof <file>` (or the explorer's /proof page) accepts it unchanged. 409 means the
// row has no proof to give (non-Tor rail, or not confirmed yet); 503 means the wallet could
// not be asked — both are shown verbatim, neither is retried automatically.
async function downloadProof(id) {
  try {
    const res = await adminFetch('/api/admin/withdrawals/' + id + '/payment-proof');
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || ('HTTP ' + res.status));
    const blob = new Blob([JSON.stringify(body.proof, null, 2) + '\n'], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'payout-' + id + '-proof.json';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    flash(`Proof for withdrawal #${id} ${body.cached ? 'downloaded' : 'fetched from the wallet and downloaded'} — verify with: grin-wallet verify_proof payout-${id}-proof.json`, false);
    if (!body.cached) refresh();
  } catch (err) { flash(err.message, true); }
}

// Held (tor_held): the one Tor attempt's outcome is unknown and the amount stays locked. The
// scheduler re-reads the wallet every pass by itself; Re-check runs that same resolution now —
// confirmed on a confirmed tx, refunded only on a second "absent" read ≥ 10 min after the first,
// otherwise still Held. It never sends.
const HELD_OUTCOME = {
  confirmed: 'confirmed — it went out, marked paid',
  refunded: 'refunded — proven absent on two reads',
  absent_first: 'absent on this read — a second read ≥ 10 min later decides the refund',
  absent_wait: 'absent again, but under 10 min since the first absent read — still Held',
  held: 'the wallet holds an UNCONFIRMED matching send — still Held',
  unknown: 'the wallet log could not be read or matched — still Held',
  frozen: 'absent on this read, but payouts are FROZEN — a Held payout is refunded only after a resume (a confirmation still settles it)',
  history_changed: 'absent, but the wallet no longer carries the history it had when this payout was first checked (a restore, a seed recovery or a different wallet) — still Held; find the send on the wallet that made it',
  fallback_cancelled: 'its never-finalized slatepack fallback was still locked and has been cancelled — the next reads decide the refund',
  reposted: 'its send got past the Tor round trip but has not mined — re-broadcast (the identical transaction), still Held',
};
async function recheckHeld(id) {
  try {
    const res = await adminFetch('/api/admin/withdrawals/' + id + '/recheck', { method: 'POST' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || ('HTTP ' + res.status));
    flash(`Payout ID ${id}: ${HELD_OUTCOME[body.outcome] || body.outcome} (status ${body.status}).`, false);
    refresh();
  } catch (err) { flash(err.message, true); }
}

// Forced refund of a Held payout: the operator's call once they have proven the send never reached
// the chain. The payout ID is typed back (the server checks it as confirm_id), then step-up; the
// server still refuses on a confirmed match in the wallet log, or a log it cannot read. ONE native
// prompt only: a second one chained after it can be suppressed by the browser and read as a cancel
// (memory: admin login security). The audit row records the typed id, amount and wallet read.
async function forceRefundHeld(id, amount) {
  const typed = prompt(`FORCED REFUND of held payout ID ${id} (${amount} ツ) back to the miner's balance.\n\n` +
    `Only if you have proven it never reached the chain — if it did, the miner is paid twice.\n\n` +
    `Type the payout ID (${id}) to confirm:`);
  if (typed === null) return;
  if (String(typed).trim() !== String(id)) { flash(`Not refunded — the typed ID did not match payout ID ${id}.`, true); return; }
  try {
    const res = await adminFetch('/api/admin/withdrawals/' + id + '/force-refund', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm_id: typed.trim() })
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || ('HTTP ' + res.status));
    flash(`Payout ID ${id} force-refunded (${fmtGrin(body.amount)} ツ back to the miner).` +
      (body.cancelled_slate ? ` Its never-finalized fallback slate was cancelled first.` : '') +
      (body.wallet_history === 'changed' ? ' Note: the wallet history had CHANGED since this payout was first checked — the refund rests on your own proof.' : ''),
      false);
    refresh();
  } catch (err) { flash(err.message, true); }
}

async function cancelWithdrawal(id, amount) {
  const reason = prompt(`Cancel withdrawal #${id} (${amount} ツ) and refund the miner's balance?\n\nOptional reason:`);
  if (reason === null) return;
  try {
    const res = await adminFetch('/api/admin/withdrawals/' + id + '/cancel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason })
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || ('HTTP ' + res.status));
    flash(`Withdrawal #${id} cancelled${body.refunded ? ' and refunded' : ''}.`, false);
    refresh();
  } catch (err) { flash(err.message, true); }
}

// The payout kill-switch (renderFreeze / loadPayoutControl / togglePayouts) is in payouts-common.js.
function refresh() { loadQueueSummary(); loadWithdrawals(); loadPayoutControl(); loadRevenue(); }

// ── Operator revenue (pool_fee bucket → the operator's saved address) ─────────
// GET /api/admin/revenue is SQL only (no wallet call), so it rides the 30 s refresh. The
// withdraw form never takes an address: the server sends to the SAVED one and checks that the
// address this page shows is still the saved one (it echoes it back) — see index.js.
let _rev = null;
function holdText(s) {
  const h = Math.floor(s / 3600), m = Math.ceil((s % 3600) / 60);
  return h ? `${h} h ${m} min` : `${m} min`;
}
async function loadRevenue() {
  try {
    _rev = await API.get('/api/admin/revenue');
    renderRevenue(_rev);
  } catch (err) {
    document.getElementById('rv-tbody').innerHTML = `<tr><td colspan="7">${escHtml(err.message)}</td></tr>`;
  }
}
function renderRevenue(d) {
  document.getElementById('rv-balance').textContent = fmtGrin(d.balance) + ' ツ';
  document.getElementById('rv-unbooked').textContent = fmtGrin(d.unbooked_network_fees) + ' ツ';
  document.getElementById('rv-available').textContent = fmtGrin(d.available) + ' ツ';

  document.getElementById('rv-addr').textContent = d.address || 'not set';
  const hold = document.getElementById('rv-hold');
  if (!d.address) {
    hold.innerHTML = '<span class="badge badge-warn">set one below to withdraw</span>';
  } else if (d.hold_remaining_s > 0) {
    hold.innerHTML = `<span class="badge badge-warn" title="Unlocks ${escHtml(fmtTs(d.usable_at))}">24 h hold — ${escHtml(holdText(d.hold_remaining_s))} left</span>`;
  } else {
    hold.innerHTML = '<span class="badge badge-ok">ready</span>';
  }

  // The address-change alarm cannot be closed until the 24 h hold ends (server-enforced:
  // AlertMonitor.closeLockedUntil) — so whoever changed the address cannot also silence it.
  const alertBox = document.getElementById('rv-alert');
  const lockedUntil = Number(d.address_alert_locked_until) || 0;
  alertBox.innerHTML = d.address_alert
    ? `<div class="health-card warn" style="margin-bottom:.8rem;">
         <div class="health-detail">⚠ ${escHtml(d.address_alert.message)}</div>
         ${lockedUntil
           ? `<div class="health-detail" style="margin-top:.4rem;">This alert stays up until the hold ends (${escHtml(fmtTs(lockedUntil))}). If you did not make this change, set the address back now.</div>`
           : `<button class="btn btn-sm btn-outline" style="margin-top:.5rem;" data-action="close-address-alert" data-id="${Number(d.address_alert.id)}">It was me — close this alert</button>`}
       </div>`
    : '';

  // The hold only protects revenue if someone hears about a change within 24 h. Off-box channels
  // come from pool.json (not editable from this panel), so a stolen session cannot switch them off.
  const ch = d.alert_channels || {};
  const on = Object.keys(ch).filter((k) => ch[k]);
  document.getElementById('rv-channels').innerHTML = on.length
    ? `<div style="font-size:.8rem;color:var(--text-dim);margin-bottom:.6rem;">Address changes are pushed to: ${escHtml(on.join(', '))}.</div>`
    : `<div class="health-card warn" style="margin-bottom:.8rem;"><div class="health-detail">⚠ No off-box alert channel (Telegram, email, Discord, Slack) is configured, so an address change is announced only inside this panel. Set one up in pool.json — the 24 h hold protects your revenue only if you hear about a change in time.</div></div>`;

  const pend = document.getElementById('rv-pending');
  if (d.pending) {
    const label = (STATUS[d.pending.status] || [])[1] || d.pending.status;
    pend.style.display = '';
    pend.textContent = `Withdrawal #${d.pending.id} (${fmtGrin(d.pending.amount)} ツ) is in progress — ${label}. The next one can start when it settles.`;
  } else {
    pend.style.display = 'none';
  }

  document.getElementById('rv-withdraw-btn').disabled =
    !d.address || d.hold_remaining_s > 0 || !!d.pending || !!d.frozen || !(d.available > 0);

  const rows = Array.isArray(d.history) ? d.history : [];
  document.getElementById('rv-tbody').innerHTML = rows.length
    ? rows.map((w) => {
        const [cls, status] = STATUS[w.status] || ['badge-dim', w.status];
        const k = String(w.kernel_excess || '');
        return `<tr>
          <td class="mono">${w.id}</td>
          <td>${fmtTs(w.created_at)}</td>
          <td class="mono">${fmtGrin(w.amount)}</td>
          <td><span class="badge ${cls}">${escHtml(status)}</span></td>
          <td>${fmtTs(w.confirmed_at)}</td>
          <td><span class="mono" title="${escHtml(w.dest_address || '')}">${escHtml(shortAddr(w.dest_address || '—'))}</span></td>
          <td>${k ? `<span class="mono" title="${escHtml(k)}">${escHtml(k.slice(0, 8) + '…' + k.slice(-6))}</span>` : '<span style="color:var(--text-dim)">—</span>'}</td>
        </tr>`;
      }).join('')
    : '<tr><td colspan="7" style="color:var(--text-dim)">No revenue withdrawals yet.</td></tr>';
}
// Max keeps one withdrawal fee back. The revenue withdrawal pays its OWN network fee (~0.023), and
// that fee is booked to the pool fee at the NEXT withdrawal — sending every last nanogrin would
// leave the bucket briefly negative by it. The flat fee (≥ 0.04) always covers one plain payout.
function fillRevenueMax() {
  if (!_rev) return;
  const reserve = Math.max(Number(_rev.withdrawal_fee) || 0, 0.04);
  const max = Math.floor((Number(_rev.available) - reserve) * 1e9) / 1e9;
  document.getElementById('rv-amount').value = max > 0 ? max.toFixed(9).replace(/.?0+$/, '') : '';
  const out = document.getElementById('rv-result');
  out.textContent = max > 0
    ? `Max keeps ${fmtGrin(reserve)} ツ back for this withdrawal's own network fee.`
    : 'Not enough revenue to cover a withdrawal and its network fee yet.';
  out.style.color = 'var(--text-dim)';
}
async function withdrawRevenue() {
  const out = document.getElementById('rv-result');
  const btn = document.getElementById('rv-withdraw-btn');
  const amount = parseFloat(document.getElementById('rv-amount').value);
  if (!_rev || !_rev.address) { out.textContent = 'set a revenue address first'; out.style.color = 'var(--warn)'; return; }
  if (!(amount > 0)) { out.textContent = 'enter a positive amount'; out.style.color = 'var(--warn)'; return; }
  const fees = Number(_rev.unbooked_network_fees) || 0;
  const feeLine = fees > 0
    ? `\n\nFirst, ${fmtGrin(fees)} ツ of payout network fees the pool wallet already paid is deducted from the pool fee.`
    : '';
  if (!confirm(`Send ${amount} ツ of operator revenue over Tor to\n${_rev.address}?${feeLine}\n\nYour wallet must be listening over Tor.`)) return;
  btn.disabled = true;
  out.textContent = 'sending…'; out.style.color = 'var(--text-dim)';
  try {
    const res = await adminFetch('/api/admin/revenue/withdraw', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount, address: _rev.address })
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || ('HTTP ' + res.status));
    out.textContent = `✓ queued (#${body.withdrawal_id}, ${fmtGrin(body.amount)} ツ) — sending over Tor` +
      (body.network_fees_booked > 0 ? `; ${fmtGrin(body.network_fees_booked)} ツ of network fees booked` : '');
    out.style.color = 'var(--ok)';
    document.getElementById('rv-amount').value = '';
    refresh();
  } catch (err) {
    out.textContent = err.message; out.style.color = 'var(--danger)';
    if (_rev) renderRevenue(_rev);   // re-derive the button state the click disabled
  }
}
async function saveRevenueAddress() {
  const out = document.getElementById('rv-save-result');
  const btn = document.getElementById('rv-save-btn');
  const address = document.getElementById('rv-new-addr').value.trim();
  if (!address) { out.textContent = 'enter an address'; out.style.color = 'var(--warn)'; return; }
  if (!confirm(`Set the operator revenue address to\n${address}?\n\nWithdrawals to it stay blocked for 24 hours, and a critical alert is raised.`)) return;
  btn.disabled = true;
  out.textContent = 'saving…'; out.style.color = 'var(--text-dim)';
  try {
    const res = await adminFetch('/api/admin/revenue/address', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address })
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || ('HTTP ' + res.status));
    out.textContent = `✓ saved — withdrawals to it unlock ${fmtTs(body.usable_at)}`;
    out.style.color = 'var(--ok)';
    document.getElementById('rv-new-addr').value = '';
    loadRevenue();
  } catch (err) { out.textContent = err.message; out.style.color = 'var(--danger)'; }
  finally { btn.disabled = false; }
}
// Closes the address-change alarm once the operator has confirmed the change was theirs. Uses the
// shared manual-resolve route (step-up, audited, note REQUIRED) — the same one health.html uses.
async function closeAddressAlert(id) {
  const note = prompt('Confirm this revenue address change was yours. The note goes in the audit log:', 'revenue address change was mine');
  if (note === null) return;
  try {
    const res = await adminFetch('/api/admin/alerts/' + id + '/resolve', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ note })
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || ('HTTP ' + res.status));
    flash('Address-change alert closed.', false);
    loadRevenue();
  } catch (err) { flash(err.message, true); }
}

// ── Manual payout (below-minimum support request) ─────────────────────────────
// The card in Manual payouts, under the revenue card. Its endpoints sit under /api/admin/dormancy/* for
// historical reasons only — it pays a miner who asked, it does not touch the dormancy sweep
// (that is dormant.html). Every payout it makes appears in the queue above.
async function verifyOwner() {
  const address = document.getElementById('mp-addr').value.trim();
  const proof = document.getElementById('mp-proof').value.trim();
  const out = document.getElementById('mp-verify-result');
  if (!address || !proof) { out.textContent = 'enter address + proof'; out.style.color = 'var(--warn)'; return; }
  out.textContent = 'checking…'; out.style.color = 'var(--text-dim)';
  try {
    const res = await adminFetch('/api/admin/dormancy/verify-owner', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address, proof })
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || ('HTTP ' + res.status));
    if (body.match) { out.textContent = '✓ MATCH (' + (body.method || 'ok') + ')'; out.style.color = 'var(--ok)'; }
    else { out.textContent = '✗ no match (' + (body.reason || '') + ')'; out.style.color = 'var(--danger)'; }
  } catch (err) { out.textContent = err.message; out.style.color = 'var(--danger)'; }
}

// A payout POST that transparently handles the backend's "needs acknowledgment" gates: a 428
// verify_required (no ownership verification in the last 15 min) and a 400
// above_min_needs_ack (at/above the pool minimum, auto-payout could double-pay). Each
// prompts once and retries with the matching flag set. Returns the parsed body on success; throws
// otherwise. `extra` carries the acks across retries so each is asked at most once.
async function postPayoutWithAcks(url, base, extra) {
  extra = extra || {};
  const res = await adminFetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...base, ...extra })
  });
  const body = await res.json().catch(() => ({}));
  if (res.ok) return body;
  if (body.reason === 'verify_required' && !extra.verified_ack) {
    if (!confirm('No successful ownership verification for this address in the last 15 minutes.\n\nVerify ownership first (recommended). Proceed only if you have confirmed the owner by other means?')) {
      throw new Error('ownership not verified');
    }
    return postPayoutWithAcks(url, base, { ...extra, verified_ack: true });
  }
  if (body.reason === 'above_min_needs_ack' && !extra.allow_above_min) {
    if (!confirm(`This amount is at or above the ${body.min} ツ minimum.\n\nThe auto-payout scheduler could also pay this balance — consider freezing payouts, or use "Send Tor payout" instead. Record it anyway?`)) {
      throw new Error('at/above minimum — not acknowledged');
    }
    return postPayoutWithAcks(url, base, { ...extra, allow_above_min: true });
  }
  throw new Error(body.error || ('HTTP ' + res.status));
}

// Primary path: the backend sends over Tor through the normal locked withdrawal flow and records it
// automatically. Convenient (no out-of-band send, real fee/kernel captured), but needs the miner's
// wallet listener reachable — the scheduler declines and reverses the lock if it isn't.
async function sendTorPayout() {
  const address = document.getElementById('mp-addr').value.trim();
  const amount = parseFloat(document.getElementById('mp-amount').value);
  const out = document.getElementById('mp-tor-result');
  const btn = document.getElementById('mp-tor-btn');
  if (!address || !(amount > 0)) { out.textContent = 'address + positive amount required'; out.style.color = 'var(--warn)'; return; }
  if (!confirm(`Send a Tor payout of ${amount} ツ to\n${address}?\n\nThe pool will send it over Tor and record it. The miner's wallet listener must be online.`)) return;
  btn.disabled = true;
  out.textContent = 'sending…'; out.style.color = 'var(--text-dim)';
  try {
    const body = await postPayoutWithAcks('/api/admin/dormancy/send-payout', { address, amount });
    out.textContent = `✓ queued (#${body.withdrawal_id}, ${(body.amount || amount).toFixed(4)} ツ) — sending over Tor`;
    out.style.color = 'var(--ok)';
    document.getElementById('mp-amount').value = '';
    refresh();
  } catch (err) { out.textContent = err.message; out.style.color = 'var(--danger)'; }
  finally { btn.disabled = false; }
}

async function recordManualPayout() {
  const address = document.getElementById('mp-addr').value.trim();
  const amount = parseFloat(document.getElementById('mp-amount').value);
  const fee = parseFloat(document.getElementById('mp-fee').value) || 0;
  const out = document.getElementById('mp-result');
  const btn = document.getElementById('mp-record-btn');
  if (!address || !(amount > 0)) { out.textContent = 'address + positive amount required'; out.style.color = 'var(--warn)'; return; }
  if (!confirm(`Record a MANUAL payout of ${amount} ツ to\n${address}?\n\nOnly do this AFTER you have actually sent the coins on the server. This debits the miner's balance.`)) return;
  btn.disabled = true;   // in-flight guard: a resubmit would double-debit the miner
  // (the server dedups too — see recordManualPayout in lib/dormancy.js)
  try {
    const body = await postPayoutWithAcks('/api/admin/dormancy/manual-payout', {
      address, amount, fee,
      kernel_excess: document.getElementById('mp-kernel').value.trim() || null,
      slate_id: document.getElementById('mp-slate').value.trim() || null,
      note: document.getElementById('mp-note').value.trim() || null,
    });
    out.textContent = `✓ recorded (#${body.withdrawal_id}, balance now ${(body.balance_after || 0).toFixed(4)} ツ)`;
    out.style.color = 'var(--ok)';
    ['mp-amount', 'mp-fee', 'mp-kernel', 'mp-slate', 'mp-note'].forEach(id => { document.getElementById(id).value = ''; });
    refresh();
  } catch (err) { out.textContent = err.message; out.style.color = 'var(--danger)'; }
  finally { btn.disabled = false; }
}

document.addEventListener('DOMContentLoaded', () => { refresh(); });
// Withdrawal queue + freeze state are cheap — 30s. (Reconciliation, the wallet-send audit and the
// wallet-identity probe moved to treasury.html with their 3-min wallet-call cadence; the
// abandoned-balance poll moved to dormant.html, the payout request audit's to users.html.)
setInterval(refresh, 30000);

// ==== F3: event wiring — replaces the inline on*= attributes (strict script-src, no inline handlers).
// One delegated listener per event type; data-action names the handler. Every old handler ignored
// the Event and `this` except where noted, so the wrappers pass exactly the arguments the attribute did.
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  switch (el.dataset.action) {
    case 'set-filter':             setFilter(el.dataset.filter, el); break;
    case 'toggle-payouts':         togglePayouts(); break;
    case 'fill-revenue-max':       fillRevenueMax(); break;
    case 'withdraw-revenue':       withdrawRevenue(); break;
    case 'save-revenue-address':   saveRevenueAddress(); break;
    case 'verify-owner':           verifyOwner(); break;
    case 'send-tor-payout':        sendTorPayout(); break;
    case 'record-manual-payout':   recordManualPayout(); break;
    case 'download-proof':         downloadProof(Number(el.dataset.id)); break;
    case 'recheck-held':           recheckHeld(Number(el.dataset.id)); break;
    case 'force-refund-held':      forceRefundHeld(Number(el.dataset.id), Number(el.dataset.amount)); break;
    case 'cancel-withdrawal':      cancelWithdrawal(Number(el.dataset.id), Number(el.dataset.amount)); break;
    case 'close-address-alert':    closeAddressAlert(Number(el.dataset.id)); break;
  }
});
document.addEventListener('input', (e) => {
  const el = e.target.closest('[data-action]');
  if (el && el.dataset.action === 'clear-verify-result') document.getElementById('mp-verify-result').textContent = '';
});
