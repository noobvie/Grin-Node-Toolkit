// users.html page script — moved BYTE-verbatim out of the page's inline <script> (code-layout F3).
// Classic script (no defer/module) loaded at the same position as the old block, after auth.js,
// api.js, admin-shell.js, stepup.js and payouts-common.js, whose globals it uses (H14).
// Auth gate (httpOnly-cookie aware): redirects to /login.html if not an admin, else wires
// up the topbar username + Logout. Pool name + testnet banner (chrome) are handled by
// admin-shell.js.
API.guardAdminPage();

// HTML escaper. Safe in text and in a quoted attribute VALUE — but never splice its output
// into a JS string literal inside an on*="…" handler: the HTML parser decodes &#39; back to a
// real ' before the JS is parsed. Row buttons pass values via data-* + this.dataset instead
// (audit §J14). `s == null`, not `s || ''`, so a legitimate 0 renders as "0" and not blank.
function escHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function fmtWhen(ts) {
  return ts ? new Date(ts * 1000).toLocaleString() : '—';
}

// Compact "3m ago" / "2h ago" for the lock and ban countdowns.
function fmtDur(secs) {
  const s = Math.max(0, Math.round(secs || 0));
  if (s < 60) return s + 's';
  if (s < 3600) return Math.round(s / 60) + 'm';
  return (s / 3600).toFixed(1) + 'h';
}

// For the payout request audit (moved here from payments.html, 2026-10). Local copies of the
// payout pages' payouts-common.js helpers: this page does not load that file, which also
// carries the payout freeze kill-switch.
function fmtGrin(v) { return (Number(v) || 0).toFixed(4); }
function shortAddr(a) {
  a = String(a || '');
  return a.length > 18 ? a.slice(0, 10) + '…' + a.slice(-6) : a;
}

// ── Login security ───────────────────────────────────────────────────────────
// Two AdminTable-managed lists (origins, targeted usernames) plus small hand-rendered
// blocks for the lock/ban state and the admin-account roster, which are short by nature.
const originsTable = AdminTable.create({
  tbody: 'sec-origins-tbody',
  search: 'Filter by address…',
  empty: 'No failed logins in this window.',
  text: r => [r.ip, r.attempts, fmtWhen(r.last_at)].join(' '),
  row: r => `<tr>
      <td class="mono">${escHtml(r.ip)}</td>
      <td>${escHtml(String(r.attempts))}</td>
      <td>${escHtml(fmtWhen(r.last_at))}</td>
      <td style="text-align:right;">
        <button class="btn btn-sm btn-outline" data-ip="${escHtml(r.ip)}" data-action="clear-ban">Lift ban</button>
      </td>
    </tr>`
});

const targetsTable = AdminTable.create({
  tbody: 'sec-targets-tbody',
  search: 'Filter by username…',
  empty: 'No failed logins in this window.',
  text: r => [r.username, r.attempts, fmtWhen(r.last_at)].join(' '),
  row: r => `<tr>
      <td class="mono">${escHtml(r.username)}</td>
      <td>${escHtml(String(r.attempts))}</td>
      <td>${escHtml(fmtWhen(r.last_at))}</td>
    </tr>`
});

function renderLocks(d) {
  const locks = d.active_lockouts || [];
  const bans = d.banned_ips || [];
  const el = document.getElementById('sec-locks');
  if (locks.length === 0 && bans.length === 0) {
    el.innerHTML = '<span style="color:var(--text-dim);font-size:.85rem;">' +
      'Nothing locked or banned right now.</span>';
    return;
  }
  let html = '';
  if (locks.length) {
    html += '<div style="font-size:.8rem;color:var(--text-dim);margin-bottom:.35rem;">' +
            'Locked login pairs</div><ul style="margin:0 0 .9rem;padding-left:1.1rem;font-size:.85rem;">';
    for (const l of locks) {
      html += `<li><span class="mono">${escHtml(l.username)}</span> from ` +
              `<span class="mono">${escHtml(l.ip)}</span> — unlocks in ${escHtml(fmtDur(l.seconds_remaining))}</li>`;
    }
    html += '</ul>';
  }
  if (bans.length) {
    html += '<div style="font-size:.8rem;color:var(--text-dim);margin-bottom:.35rem;">' +
            'Auto-banned addresses</div><ul style="margin:0;padding-left:1.1rem;font-size:.85rem;">';
    for (const b of bans) {
      html += `<li><span class="mono">${escHtml(b.ip)}</span> — expires in ${escHtml(fmtDur(b.seconds_remaining))} ` +
              `<button class="btn btn-sm btn-outline" style="margin-left:.4rem;" ` +
              `data-ip="${escHtml(b.ip)}" data-action="clear-ban">Lift</button></li>`;
    }
    html += '</ul>';
  }
  el.innerHTML = html;
}

function renderAccounts(d) {
  const rows = d.accounts || [];
  const tb = document.getElementById('sec-accounts-tbody');
  if (rows.length === 0) {
    tb.innerHTML = '<tr><td colspan="4" style="color:var(--text-dim);">No admin accounts found.</td></tr>';
    return;
  }
  tb.innerHTML = rows.map(r => {
    const twofa = r.totp_enabled
      ? '<span class="badge badge-ok">On</span>'
      : '<span class="badge badge-warn">Off</span>';
    const state = r.is_active
      ? '<span class="badge badge-dim">Active</span>'
      : '<span class="badge badge-error">Disabled</span>';
    // A non-zero counter is a signal, not a lock — say so, so nobody reads it as "locked".
    const fails = r.failed_login_attempts || 0;
    return `<tr>
      <td class="mono">${escHtml(r.username)}</td>
      <td>${twofa}</td>
      <td${fails > 0 ? ' style="color:var(--warning);"' : ''}>${escHtml(String(fails))}</td>
      <td>${state}</td>
    </tr>`;
  }).join('');

  // Nag only when the pool actually requires 2FA and someone hasn't enrolled — that admin's
  // money/destructive actions are being refused right now, which is worth naming explicitly.
  const warn = document.getElementById('sec-totp-warn');
  const missing = rows.filter(r => !r.totp_enabled).map(r => r.username);
  if (d.totp_mandatory && missing.length) {
    warn.innerHTML = 'This pool requires 2FA for admin actions, but 2FA is off for: ' +
      '<strong>' + missing.map(escHtml).join(', ') + '</strong>. ' +
      'Those accounts can sign in and read, but every money or destructive action is refused ' +
      'until they enroll on the <a href="/admin/settings-access.html">Access settings</a> page.';
    warn.style.display = '';
  } else if (!d.totp_mandatory && rows.some(r => !r.totp_enabled)) {
    warn.innerHTML = '2FA is optional on this pool and is off for at least one admin. ' +
      'Enrolling it (and then enabling <em>Require 2FA</em> on the ' +
      '<a href="/admin/settings-access.html">Access settings</a> page) is the single biggest ' +
      'improvement you can make to admin login security.';
    warn.style.display = '';
  } else {
    warn.style.display = 'none';
  }
}

async function loadAuthActivity(reset) {
  const hours = document.getElementById('sec-window').value;
  if (reset) { originsTable.setLoading(); targetsTable.setLoading(); }
  try {
    const d = await API.get('/api/admin/security/auth-activity?hours=' + encodeURIComponent(hours));
    document.getElementById('sec-ok').textContent      = (d.totals && d.totals.success) || 0;
    document.getElementById('sec-badpass').textContent = (d.totals && d.totals.failed_password) || 0;
    document.getElementById('sec-bad2fa').textContent  = (d.totals && d.totals.failed_2fa) || 0;
    document.getElementById('sec-bans').textContent    = (d.totals && d.totals.autobans) || 0;

    // Say it out loud when the requested window was clipped by audit retention, so a gap
    // caused by pruning is never read as "there were no attempts".
    const note = document.getElementById('sec-window-note');
    note.textContent = d.truncated_by_retention
      ? `Showing ${d.window_hours}h — the audit log only keeps ${d.retention_days} days.`
      : '';

    originsTable.setRows(d.top_origins || [], reset ? { reset: true } : undefined);
    targetsTable.setRows(d.targeted_usernames || [], reset ? { reset: true } : undefined);
    renderLocks(d);
    renderAccounts(d);
  } catch (err) {
    originsTable.setError(err.message);
    targetsTable.setError(err.message);
    document.getElementById('sec-locks').textContent = 'Could not load: ' + err.message;
  }
}

// Lifting a ban re-opens login attempts from that address, so it goes through step-up
// (adminFetch), not a plain fetch.
async function clearBan(ip) {
  if (!confirm('Lift the temporary ban on ' + ip + '?\n\nLogin attempts from this address will be accepted again.')) return;
  try {
    const res = await adminFetch('/api/admin/security/temp-ban/clear', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ip })
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || ('HTTP ' + res.status));
    if (!body.was_banned) alert('That address had no active ban (it may have already expired).');
    loadAuthActivity();
  } catch (err) {
    alert(err.message);
  }
}

// ── Sessions & login activity ────────────────────────────────────────────────
// Keys MUST match the actions the writers emit. 'login_failed' is what index.js's login
// route inserts; the panel previously only mapped 'login_failure', which nothing writes,
// so failed logins rendered with the raw action key as their label.
const LOGIN_LABEL = {
  login_success:    ['badge-ok',    'Login'],
  login_failed:     ['badge-error', 'Failed login'],
  login_failure:    ['badge-error', 'Failed login'],   // legacy rows from older builds
  login_2fa_failed: ['badge-error', 'Failed 2FA code'],
  ip_autoban:       ['badge-error', 'IP auto-banned'],
  logout:           ['badge-dim',   'Logout'],
  '2fa_enabled':    ['badge-ok',    '2FA enabled'],
  '2fa_disabled':   ['badge-warn',  '2FA disabled'],
  admin_cli_reset:  ['badge-warn',  'Recovery via server CLI'],
};
// Searched/paged by AdminTable (admin-shell.js): 20 rows a page, filter across every
// column, and the retention sentence is filled from Settings → Database at load.
const loginTable = AdminTable.create({
  tbody: 'login-tbody',
  search: 'Filter by user, IP or event…',
  empty: 'No login activity recorded.',
  note: 'Part of the admin audit trail — kept {days} days, then pruned ' +
        '(<a href="/admin/settings-database.html">change</a>). Newest 200 events shown.',
  retentionKey: 'audit_log_keep_days',
  retentionDefault: 180,
  // Explicit search text: the row's badge label ("Failed login") is what an operator
  // types, not the raw action key, so both are indexed.
  text: r => [r.username, r.ip, r.action, (LOGIN_LABEL[r.action] || [])[1],
              r.created_at ? new Date(r.created_at * 1000).toLocaleString() : ''].join(' '),
  row: r => {
    const [cls, label] = LOGIN_LABEL[r.action] || ['badge-dim', r.action];
    const when = r.created_at ? new Date(r.created_at * 1000).toLocaleString() : '—';
    return `<tr>
      <td>${escHtml(when)}</td>
      <td><span class="badge ${cls}">${escHtml(label)}</span></td>
      <td>${escHtml(r.username || '—')}</td>
      <td class="mono">${escHtml(r.ip || '—')}</td>
    </tr>`;
  }
});

async function loadLoginHistory() {
  try {
    const d = await API.get('/api/admin/security/login-history?limit=200');
    loginTable.setRows((d && d.history) || []);
  } catch (err) {
    loginTable.setError(err.message);
  }
}

async function revokeSessions() {
  if (!confirm('Revoke all of your sessions? Every device (including this one) will need to log in again soon.')) return;
  const btn = document.getElementById('revoke-btn');
  btn.disabled = true;
  try {
    const res = await adminFetch('/api/admin/security/revoke-sessions', { method: 'POST' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || ('HTTP ' + res.status));
    const msg = document.getElementById('revoke-msg');
    msg.textContent = body.message || 'Sessions revoked.';
    msg.style.display = '';
    loadLoginHistory();
  } catch (err) {
    alert(err.message);
  } finally {
    btn.disabled = false;
  }
}

// ── Payout request audit ──────────────────────────────────────────────────────
// Times are rendered as explicit UTC (not toLocaleString) — this table is read alongside
// server logs during an incident, and a browser-local timestamp would not line up with them.
function utcTs(t) {
  return t ? new Date(t * 1000).toISOString().replace('T', ' ').slice(0, 19) : '—';
}
const PA_ACTION = {
  withdraw_tor: 'Tor payout', withdraw_slatepack: 'Slatepack', withdraw_nostr: 'Nostr payout',
  slatepack_finalize: 'Slatepack finalize',
  nostr_destination_register: 'Nostr dest. register', nostr_destination_remove: 'Nostr dest. remove',
};
const PA_REASON = {
  no_match: 'proof did not match', too_many_attempts: 'throttled (lockout)',
  proof_required: 'no proof supplied', account_not_found: 'unknown address',
  no_recorded_proof: 'no proof on file', tor_unreachable: 'wallet unreachable',
  npub_changed: 'Nostr key changed', lookup_failed: 'lookup failed',
};

// Retention here is the live audit_log_keep_days — the endpoint reports it per request
// (a.retention_days), so the note is refreshed from the response as well as at load.
const paTable = AdminTable.create({
  tbody: 'pa-tbody',
  search: 'Filter by address, origin, action or reason…',
  empty: 'No payout requests in this window.',
  note: 'Audit rows are kept {days} days, then pruned ' +
        '(<a href="/admin/settings-database.html">Settings → Database</a>).',
  retentionKey: 'audit_log_keep_days',
  retentionDefault: 180,
  text: e => [e.grin_address, e.ip_prefix, e.country, e.country_code, e.action,
              PA_ACTION[e.action], e.outcome, e.outcome === 'ok' ? 'accepted' : 'refused',
              e.reason, PA_REASON[e.reason], utcTs(e.at)].join(' '),
  row: e => {
    const okRow = e.outcome === 'ok';
    const detail = e.reason ? (PA_REASON[e.reason] || e.reason)
                 : (e.amount != null ? fmtGrin(e.amount) + ' ツ' : '—');
    return `<tr>
      <td class="mono">${escHtml(utcTs(e.at))}</td>
      <td>${escHtml(PA_ACTION[e.action] || e.action)}</td>
      <td><span class="badge ${okRow ? 'badge-ok' : 'badge-error'}">${okRow ? 'accepted' : 'refused'}</span></td>
      <td class="mono" title="${escHtml(e.grin_address || '')}">${escHtml(shortAddr(e.grin_address))}</td>
      <td class="mono">${escHtml(e.ip_prefix || '—')}</td>
      <td>${escHtml(e.country || (e.country_code || '—'))}</td>
      <td style="color:var(--text-dim);">${escHtml(detail)}</td>
    </tr>`;
  }
});

// resetPage: the window/result selects changed, so the old page number means nothing.
// The 2-minute auto-refresh passes nothing and keeps the operator where they were.
async function loadPayoutAudit(resetPage) {
  const summary = document.getElementById('pa-summary');
  const banner = document.getElementById('pa-banner');
  const note = document.getElementById('pa-note');
  const days = document.getElementById('pa-days').value;
  const result = document.getElementById('pa-result').value;
  try {
    const a = await API.get(`/api/admin/payments/audit?days=${days}&result=${result}&limit=200`);
    summary.textContent = `${a.totals.ok} accepted · ${a.totals.deny} refused · ${a.totals.origins} origin(s) in ${a.window_days}d`;

    // Be explicit when retention already deleted part of the requested window, so an empty
    // stretch is never misread as "nobody tried".
    note.textContent = a.truncated_by_retention
      ? `showing ${a.window_days}d — retention keeps only ${a.retention_days}d`
      : (a.geo_available ? '' : 'country unavailable (geoip-lite not installed)');

    const top = a.top_denied_origins || [];
    banner.innerHTML = top.length ? `<div class="health-card ${top[0].addresses > 1 ? 'error' : 'warn'}" style="margin-bottom:.6rem;">
      <div class="health-name">${top[0].addresses > 1 ? '⚠' : 'ℹ'} Repeat refusals from ${top.length} origin(s)</div>
      <div class="health-detail" style="margin-top:.3rem;">
        ${top.map(t => `<span class="mono">${escHtml(t.ip_prefix)}</span> — ${t.denials} refused across
           ${t.addresses} address${t.addresses === 1 ? '' : 'es'} (last ${escHtml(utcTs(t.last_at))})`).join('<br>')}
        <br><br>One origin refused against <strong>several different addresses</strong> is an
        address-sweep attempt, not a miner mistyping their own password. Block the prefix in
        <a href="/admin/settings-access.html">Settings → Access</a> if it persists.
      </div></div>` : '';

    if (a.retention_days) paTable.setNoteDays(a.retention_days);
    paTable.setRows(a.events || [], { reset: resetPage === true });
  } catch (err) {
    summary.textContent = '';
    banner.innerHTML = '';
    paTable.setError(err.message);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  loadLoginHistory();
  loadAuthActivity(true);
  loadPayoutAudit();
});
// Payout request audit: pure DB read (no wallet call) but a wide scan — 2 min is enough to
// notice a live sweep. The other two sections load once and refresh on demand.
setInterval(loadPayoutAudit, 120000);

// ==== F3: event wiring — replaces the inline on*= attributes (strict script-src, no inline handlers).
// One delegated listener per event type; data-action names the handler. Every old handler ignored
// the Event and `this` except where noted, so the wrappers pass exactly the arguments the attribute did.
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  switch (el.dataset.action) {
    case 'load-auth-activity': loadAuthActivity(true); break;
    case 'revoke-sessions':    revokeSessions(); break;
    case 'load-payout-audit':  loadPayoutAudit(); break;
    case 'clear-ban':          clearBan(el.dataset.ip); break;
  }
});
document.addEventListener('change', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  switch (el.dataset.action) {
    case 'load-auth-activity-change': loadAuthActivity(true); break;
    case 'load-payout-audit-reset':  loadPayoutAudit(true); break;
  }
});
