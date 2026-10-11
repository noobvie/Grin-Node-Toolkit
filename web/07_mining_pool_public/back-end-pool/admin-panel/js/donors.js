// donors.html page script — moved BYTE-verbatim out of the page's inline script block (code-layout F5).
// Classic script (no defer/module) loaded at the same position as the old block, after the <script src> tags before it, whose globals it uses (H14).
let _allDonors = [];
let _donationsActive = true;
let _windowDays = 365;
let _bannerSlots = 5;

// Auth gate (httpOnly-cookie aware): redirects to /login.html if not an admin, else wires
// up the topbar username + Logout. Pool name + testnet banner are handled by admin-shell.js.
// stepup.js provides adminFetch() for every step-up-gated decision and the settings save
// (the incentives section is step-up gated server-side).
API.guardAdminPage();

function escHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function fmtGrin(v) { return (Number(v) || 0).toFixed(4); }
function fmtDate(t) {
  if (!t) return '—';
  return new Date(t * 1000).toISOString().slice(0, 10);   // UTC, stated once per section
}
function fmtDateTime(t) {
  if (!t) return '—';
  return new Date(t * 1000).toISOString().slice(0, 16).replace('T', ' ');
}
function fmtKb(b) { return b ? (Math.round(b / 102.4) / 10) + ' KB' : '—'; }
function shortAddr(a) {
  a = String(a || '');
  return a.length > 22 ? a.slice(0, 12) + '…' + a.slice(-7) : a;
}
// data-copy + this.dataset, NOT a value spliced into a JS string literal (audit §J14).
function addrButton(a) {
  const addr = escHtml(a);
  return `<button type="button" class="addr-copy" data-copy="${addr}" ` +
    `data-tip="${addr}&#10;Click to copy" aria-label="Copy address ${escHtml(shortAddr(a))}">` +
    `${escHtml(shortAddr(a))}</button>`;
}
// Only a URL the server could have produced for an approved banner (defence in depth).
function bannerUrl(u) {
  return /^\/uploads\/donors\/[0-9a-f]{16}\.(png|jpg|gif)$/.test(String(u || '')) ? u : null;
}

function flashInto(id, msg, isErr) {
  const el = document.getElementById(id);
  el.textContent = msg;
  el.className = isErr ? 'error-msg' : 'success-msg';
  el.style.display = '';
  setTimeout(() => { el.style.display = 'none'; }, isErr ? 9000 : 6000);
}

// Every write: adminFetch (step-up aware, in-page password dialog), the SERVER's error text
// on a refusal (§J14), then a reload of both lists — a decision changes the queue AND the list.
async function postAction(url, body, okMsg, msgId) {
  try {
    const res = await adminFetch(url, {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {})
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
    flashInto(msgId, okMsg + (data.warning ? ` Warning: ${data.warning}` : ''), !!data.warning);
    loadQueue();
    loadNames();
    loadDonors();
    return true;
  } catch (err) {
    flashInto(msgId, err.message, true);
    if (/already been decided/.test(err.message)) loadQueue();
    return false;
  }
}

// ── Reason dialog ───────────────────────────────────────────────────────────────────
// Resolves the typed reason ('' allowed) on Confirm, or null on Cancel / Escape / a click on
// the backdrop — the only ways to get null, so null really is the operator's decision.
function askReason({ title, body, label, confirmText, danger }) {
  const ov = document.getElementById('reason-dialog');
  const form = document.getElementById('reason-form');
  const input = document.getElementById('reason-input');
  const submit = document.getElementById('reason-submit');
  document.getElementById('reason-title').textContent = title;
  document.getElementById('reason-body').textContent = body;
  document.getElementById('reason-label').textContent = label;
  submit.textContent = confirmText || 'Confirm';
  submit.className = danger ? 'btn btn-danger' : 'btn';
  input.value = '';
  return new Promise((resolve) => {
    const done = (v) => {
      ov.classList.remove('open');
      form.removeEventListener('submit', onSubmit);
      document.getElementById('reason-cancel').removeEventListener('click', onCancel);
      ov.removeEventListener('click', onBackdrop);
      document.removeEventListener('keydown', onKey);
      resolve(v);
    };
    const onSubmit = (e) => { e.preventDefault(); done(input.value.trim()); };
    const onCancel = () => done(null);
    const onBackdrop = (e) => { if (e.target === ov) done(null); };
    const onKey = (e) => { if (e.key === 'Escape') done(null); };
    form.addEventListener('submit', onSubmit);
    document.getElementById('reason-cancel').addEventListener('click', onCancel);
    ov.addEventListener('click', onBackdrop);
    document.addEventListener('keydown', onKey);
    ov.classList.add('open');
    input.focus();
  });
}

// ── Review queue ────────────────────────────────────────────────────────────────────
let _queueStatus = 'pending';
// A reason typed into a queue row must survive a re-render (a search keystroke or page change
// repaints the rows), so the inputs write through to this map and the row reads it back.
const _reasons = new Map();

function requestCell(r) {
  if (r.kind === 'name') {
    const cur = r.current && r.current.name != null
      ? `<div class="req-meta">replaces the live name <span class="donor-name">${escHtml(r.current.name)}</span></div>` : '';
    return `<span class="badge badge-dim">name</span> <span class="req-name">${escHtml(r.name)}</span>${cur}`;
  }
  const w = Number(r.width) || 0, h = Number(r.height) || 0;
  // A plain same-origin src (design §18.11 Part 3 #1): the httpOnly session cookie rides along,
  // and every way of viewing the image keeps the route's own headers — the stored mime, nosniff
  // and a sandbox CSP — which an object URL copy would drop. No img-src widening is needed.
  const img = r.has_image
    ? `<img class="req-banner" data-req-img="${escHtml(String(r.id))}" alt="Banner request #${escHtml(String(r.id))}" ` +
      `src="/api/admin/donors/requests/${encodeURIComponent(String(r.id))}/image" ` +
      `${w && h ? `width="${w}" height="${h}"` : ''}>`
    : '<span class="donor-none">image discarded after the decision</span>';
  const cur = r.current && bannerUrl(r.current.url)
    ? `<div class="req-meta">replaces the <a href="${escHtml(bannerUrl(r.current.url))}" target="_blank" rel="noopener">live banner</a></div>` : '';
  return `<span class="badge badge-dim">banner</span>
    <div style="margin-top:.35rem;">${img}</div>
    <div class="req-meta">${w} × ${h} px · ${escHtml(fmtKb(r.bytes))} · ${escHtml(r.mime || '?')}</div>${cur}`;
}

function donorCell(r) {
  const rank = r.rank ? `league #${r.rank}` : 'not in the league window';
  return `${addrButton(r.address)}
    <div class="req-meta">${escHtml(rank)} · ${fmtGrin(r.lifetime_donated)} ツ lifetime</div>
    ${r.blocked ? '<div class="donor-state"><span class="badge badge-error">blocked</span></div>' : ''}`;
}

function decisionCell(r) {
  const id = escHtml(String(r.id));
  if (r.status === 'pending') {
    const val = escHtml(_reasons.get(String(r.id)) || '');
    return `<div class="req-decide">
      <input type="text" class="settings-skip" maxlength="200" placeholder="Reason for a rejection (optional)"
             aria-label="Rejection reason for request ${id}" data-reason-for="${id}" value="${val}">
      <span class="req-reason-note">The reason is shown to the donor on their account page, which anyone holding the address can open.</span>
      <div class="req-btns">
        <button type="button" class="btn btn-primary" data-id="${id}" data-action="approve-request">Approve</button>
        <button type="button" class="btn btn-danger" data-id="${id}" data-action="reject-request">Reject</button>
      </div>
    </div>`;
  }
  const badge = { approved: 'badge-ok', rejected: 'badge-error', removed: 'badge-error' }[r.status] || 'badge-dim';
  const by = r.decided_by ? ` · admin #${escHtml(String(r.decided_by))}` : '';
  return `<span class="badge ${badge}">${escHtml(r.status)}</span>
    <div class="req-meta">${escHtml(fmtDateTime(r.decided_at))} UTC${by}</div>
    ${r.reason ? `<div class="req-meta">reason: ${escHtml(r.reason)}</div>` : ''}`;
}

const queueTable = AdminTable.create({
  tbody: 'queue-tbody',
  search: 'Filter by address or name…',
  empty: 'Nothing to review. A request appears here when a donor submits a banner.',
  text: r => (r.address || '') + ' ' + (r.mime || '') + ' ' + (r.reason || ''),
  row: r => `<tr>
      <td class="mono" style="white-space:nowrap;">${escHtml(fmtDateTime(r.submitted_at))}</td>
      <td>${donorCell(r)}</td>
      <td>${requestCell(r)}</td>
      <td>${decisionCell(r)}</td>
    </tr>`,
  onRender: tbody => {
    tbody.querySelectorAll('input[data-reason-for]').forEach(inp => {
      inp.addEventListener('input', () => _reasons.set(inp.dataset.reasonFor, inp.value));
    });
    // Attached in the same task that painted the rows; an image's error event is always queued
    // for later, so none can fire before its listener exists.
    tbody.querySelectorAll('img[data-req-img]').forEach(img => {
      img.addEventListener('error', () => imageFailed(img), { once: true });
    });
  }
});

// A preview that cannot load (the request was decided meanwhile, the file is gone, the session
// expired) becomes a line of text instead of a broken-image icon.
function imageFailed(img) {
  if (!img.isConnected) return;
  img.replaceWith(Object.assign(document.createElement('span'), {
    className: 'donor-none',
    textContent: 'preview unavailable — reload the queue (the request may have been decided, or your session expired)'
  }));
}

async function loadQueue(reset) {
  const sel = document.getElementById('queue-status');
  _queueStatus = sel.value;
  try {
    // Banners only (C4): a name is never pending since names went automatic. The history of the
    // pre-C4 name decisions is in the audit log; the live and removed names are listed below.
    const data = await API.get('/api/admin/donors/requests?kind=banner&status=' + encodeURIComponent(_queueStatus));
    // API.get (Auth.fetch) hands back the parsed ERROR body on a non-2xx — a 429 is JSON too.
    if (!data || data.success !== true || !Array.isArray(data.requests)) {
      queueTable.setError((data && data.error) || 'Could not load the review queue');
      return;
    }
    const ids = new Set(data.requests.map(r => String(r.id)));
    for (const id of [..._reasons.keys()]) if (!ids.has(id)) _reasons.delete(id);
    document.getElementById('queue-summary').textContent = _queueStatus === 'pending'
      ? `${data.total} waiting for review`
      : `${data.total} ${_queueStatus}` + (data.total > data.requests.length ? ` (newest ${data.requests.length} shown)` : '');
    queueTable.setRows(data.requests, { reset: reset === true });
  } catch (err) {
    queueTable.setError(err.message);
  }
}

async function approveRequest(id) {
  await postAction('/api/admin/donors/requests/' + encodeURIComponent(id) + '/approve', {},
                   'Approved — it is live now.', 'queue-msg');
}
async function rejectRequest(id) {
  const reason = _reasons.get(String(id)) || '';
  const ok = await postAction('/api/admin/donors/requests/' + encodeURIComponent(id) + '/reject', { reason },
                              'Rejected' + (reason ? ' — the donor will see your reason.' : '.'), 'queue-msg');
  if (ok) _reasons.delete(String(id));
}

// ── Donor names (design §19.17.6, Part C4) ──────────────────────────────────────────
// One table, three views (live / removed / banned). The five headers keep their count, so the
// AdminTable loading/empty rows span right; their TEXT follows the view (textContent only).
let _namesView = 'live';
const NAMES_HEADERS = {
  live:    ['Set (UTC)', 'Donor', 'Name', 'Hints', 'Actions'],
  removed: ['Removed (UTC)', 'Donor', 'Name', 'By', 'Reason'],
  banned:  ['Banned (UTC)', 'Name as typed', 'Matching form', 'Reason', 'Actions'],
};
// Which list a hint came from, in the operator's words (the server sends the list key + entry).
const HIT_WORDS = {
  reserved: 'a reserved word', pool_name: 'your pool name', seed: 'the built-in word list',
  operator: 'your word list (Settings → Names)', prefix: 'a reserved prefix'
};

function nameHints(n) {
  const b = [];
  if (n.hit) {
    const what = n.hit.code === 'name_address' ? 'looks like a GRIN address'
      : `${HIT_WORDS[n.hit.list] || 'the rule'}${n.hit.entry ? ` ("${n.hit.entry}")` : ''}`;
    b.push(`<span class="badge badge-warn" title="Still live — remove it if it should go">Now refused by ${escHtml(what)}</span>`);
  }
  if (n.banned) b.push('<span class="badge badge-error" title="Its matching form is on the ban list">banned form</span>');
  if (n.same_as && n.same_as.length) {
    b.push(`<span class="badge badge-warn" title="${escHtml('Same name (any spelling) as: ' + n.same_as.join(' '))}">same as ${escHtml(n.same_as.map(shortAddr).join(', '))}</span>`);
  }
  if (n.blocked) b.push('<span class="badge badge-error">donor blocked</span>');
  b.push(n.approved_by == null
    ? '<span class="badge badge-dim" title="Passed the automatic check">auto</span>'
    : `<span class="badge badge-dim" title="Approved by hand before names were checked automatically">admin #${escHtml(String(n.approved_by))}</span>`);
  return `<div class="donor-state">${b.join(' ')}</div>`;
}

const namesTable = AdminTable.create({
  tbody: 'names-tbody',
  search: 'Filter by address, name or reason…',
  empty: 'Nothing here.',
  text: n => [n.address, n.name, n.norm, n.reason].filter(Boolean).join(' '),
  row: n => {
    if (_namesView === 'banned') {
      const norm = escHtml(n.norm);
      return `<tr>
        <td class="mono" style="white-space:nowrap;">${escHtml(fmtDateTime(n.banned_at))}</td>
        <td><span class="name-cell">${escHtml(n.name)}</span></td>
        <td class="mono">${norm}</td>
        <td>${n.reason ? escHtml(n.reason) : '<span class="donor-none">—</span>'}</td>
        <td><div class="row-actions"><button class="btn-icon" data-norm="${norm}" data-action="unban-name" data-tip="Unban — the name can be set again (nothing is restored)" aria-label="Unban ${norm}">✅</button></div></td>
      </tr>`;
    }
    if (_namesView === 'removed') {
      return `<tr>
        <td class="mono" style="white-space:nowrap;">${escHtml(fmtDateTime(n.removed_at))}</td>
        <td>${addrButton(n.address)}</td>
        <td><span class="name-cell">${escHtml(n.name)}</span></td>
        <td>${n.removed_by == null ? 'the donor' : `admin #${escHtml(String(n.removed_by))}`}</td>
        <td>${n.reason ? escHtml(n.reason) : '<span class="donor-none">—</span>'}</td>
      </tr>`;
    }
    const addr = escHtml(n.address);
    const nm = escHtml(n.name);
    return `<tr>
      <td class="mono" style="white-space:nowrap;">${escHtml(fmtDateTime(n.set_at))}</td>
      <td>${addrButton(n.address)}</td>
      <td><span class="name-cell">${nm}</span></td>
      <td>${nameHints(n)}</td>
      <td><div class="row-actions">
        <button class="btn-icon btn-icon-danger" data-addr="${addr}" data-kind="name" data-action="remove-live-names" data-tip="Remove this name (the donor sees your reason)" aria-label="Remove the name">✂️</button>
        <button class="btn-icon btn-icon-danger" data-name="${nm}" data-action="ban-name" data-tip="Ban this name — every spelling, every holder" aria-label="Ban the name">⛔</button>
        ${n.blocked ? '' : `<button class="btn-icon btn-icon-danger" data-addr="${addr}" data-action="block-donor-names" data-tip="Block this donor from setting a name or banner" aria-label="Block this address">🚫</button>`}
      </div></td>
    </tr>`;
  }
});

async function loadNames(reset) {
  _namesView = document.getElementById('names-view').value;
  NAMES_HEADERS[_namesView].forEach((t, i) => { document.getElementById('names-h' + (i + 1)).textContent = t; });
  try {
    const url = _namesView === 'banned' ? '/api/admin/donors/banned-names'
      : '/api/admin/donors/names?state=' + encodeURIComponent(_namesView);
    const data = await API.get(url);
    const rows = data && (_namesView === 'banned' ? data.banned : data.names);
    if (!data || data.success !== true || !Array.isArray(rows)) {
      namesTable.setError((data && data.error) || 'Could not load donor names');
      return;
    }
    document.getElementById('names-summary').textContent = _namesView === 'banned'
      ? `${rows.length} banned`
      : `${data.total} ${_namesView}` + (data.total > rows.length ? ` (newest ${rows.length} shown)` : '') +
        (_namesView === 'live' ? ` · ${rows.filter(n => n.hit).length} with a hint` : '');
    namesTable.setRows(rows, { reset: reset === true });
  } catch (err) {
    namesTable.setError(err.message);
  }
}

async function banName(name) {
  const reason = await askReason({
    title: 'Ban a donor name',
    body: `${name}\n\nEvery spelling of it (case, spaces, - _ . & ' and the leet digits 0 1 3 4 5 7 are ignored) can never be set again, and every donor who holds it now loses it.`,
    label: 'Reason (optional) — shown to anyone who holds it now, on their public account page',
    confirmText: 'Ban', danger: true
  });
  if (reason === null) return;
  await postAction('/api/admin/donors/banned-names', { name, reason }, 'Name banned.', 'names-msg');
}
async function unbanName(norm) {
  if (!confirm(`Unban "${norm}"?\n\nIt can be set again. Nothing is restored: a name removed by the ban stays removed.`)) return;
  await postAction('/api/admin/donors/banned-names/' + encodeURIComponent(norm) + '/unban', {}, 'Ban lifted.', 'names-msg');
}
document.getElementById('ban-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const nameEl = document.getElementById('ban-name');
  const reasonEl = document.getElementById('ban-reason');
  const name = nameEl.value.trim();
  if (!name) { flashInto('names-msg', 'Type the name to ban.', true); return; }
  const ok = await postAction('/api/admin/donors/banned-names', { name, reason: reasonEl.value.trim() }, 'Name banned.', 'names-msg');
  if (ok) { nameEl.value = ''; reasonEl.value = ''; }
});

// ── Donors list ─────────────────────────────────────────────────────────────────────

function profileCell(d) {
  const parts = [];
  if (d.name && d.name.text != null) {
    parts.push(`<span class="donor-name">${escHtml(d.name.text)}</span>`);
  } else {
    parts.push('<span class="donor-none">masked address</span>');
  }
  const b = [];
  if (d.name) b.push(d.name.state === 'expired'
    ? '<span class="badge badge-dim" title="Approved, but aged out — shows again after the next donation">name expired</span>'
    : '<span class="badge badge-ok">name live</span>');
  if (d.banner) b.push(d.banner.state === 'expired'
    ? '<span class="badge badge-dim">banner expired</span>'
    : (d.rank && d.rank <= _bannerSlots
        ? '<span class="badge badge-ok" title="In the banner slots — shown on the wall">banner showing</span>'
        : `<span class="badge badge-dim" title="Approved; shows while the donor is in the top ${escHtml(String(_bannerSlots))}">banner (not in top ${escHtml(String(_bannerSlots))})</span>`));
  if (d.pending && d.pending.name) b.push('<span class="badge badge-warn">name waiting</span>');
  if (d.pending && d.pending.banner) b.push('<span class="badge badge-warn">banner waiting</span>');
  if (d.blocked) b.push(`<span class="badge badge-error" title="${escHtml('Blocked ' + fmtDate(d.blocked.at) + (d.blocked.reason ? ' — ' + d.blocked.reason : ''))}">blocked</span>`);
  const url = d.banner && bannerUrl(d.banner.url);
  const thumb = url
    ? `<img class="req-thumb" src="${escHtml(url)}" alt="Banner of ${escHtml(d.name && d.name.text ? d.name.text : shortAddr(d.address))}" loading="lazy"` +
      `${d.banner.width && d.banner.height ? ` width="${Number(d.banner.width)}" height="${Number(d.banner.height)}"` : ''}>`
    : '';
  return `${parts.join('')}<div class="donor-state">${b.join(' ')}</div>${thumb}`;
}

function nowCell(d) {
  if (!_donationsActive) return '<span class="badge badge-dim" title="Miner donations are switched off">off</span>';
  if (!(d.rigs_donating > 0)) {
    return `<span class="badge badge-dim" title="${escHtml(String(d.rigs_online || 0))} rig(s) online, none tagged">paused</span>`;
  }
  const pct = d.pct_min === d.pct_max ? `${d.pct_max} %` : `${d.pct_min}–${d.pct_max} %`;
  return `<span class="badge badge-ok">${escHtml(pct)}</span>
    <div class="req-meta">${escHtml(String(d.rigs_donating))} of ${escHtml(String(d.rigs_online))} rigs</div>`;
}

function workersCell(ws) {
  if (!ws || !ws.length) return '<span class="donor-none">none in 24 h</span>';
  const shown = ws.slice(0, 6).map(w => {
    const dot = w.online ? '<span class="dot dot-green"></span>' : '<span class="dot dot-red"></span>';
    const tagged = w.donate_percent != null && w.donate_percent > 0;
    const cls = tagged ? 'w-tag' : (w.online ? '' : 'w-off');
    const tip = tagged ? ` title="This rig donates ${escHtml(String(w.donate_percent))} % of what it earns"` : '';
    return `<span class="${cls}"${tip}>${dot}${escHtml(w.name)}${tagged ? ' 🏷' : ''}</span>`;
  });
  if (ws.length > 6) shown.push(`<span class="w-off">+${ws.length - 6} more</span>`);
  return `<div class="worker-list">${shown.join('')}</div>`;
}

// Search + 20-per-page paging come from AdminTable (admin-shell.js); the state select stays
// page-side and feeds it a pre-filtered array.
const donorsTable = AdminTable.create({
  tbody: 'donors-tbody',
  search: 'Filter by address or name…',
  empty: 'No donors yet — a row appears when a miner tags a rig with donateN or a donation is debited.',
  note: 'Donors are kept permanently (the ledger behind them is rolled up daily, never deleted). ' +
        'Workers are read from the 24 h share window. Dates are UTC.',
  text: d => (d.address || '') + ' ' + (d.name && d.name.text ? d.name.text : ''),
  row: d => {
    const addr = escHtml(d.address);
    const medal = d.rank === 1 ? '🥇' : d.rank === 2 ? '🥈' : d.rank === 3 ? '🥉' : '';
    const rankCell = d.rank
      ? (medal ? `<span class="rank-medal">${medal}</span>` : String(d.rank))
      : '<span class="donor-none" title="Nothing donated inside the ranking window">—</span>';
    const live = d.banner && d.banner.state;
    const actions =
      (d.name ? `<button class="btn-icon btn-icon-danger" data-addr="${addr}" data-kind="name" data-action="remove-live" data-tip="Remove the live name" aria-label="Remove the live name">✂️</button>` : '') +
      (live ? `<button class="btn-icon btn-icon-danger" data-addr="${addr}" data-kind="banner" data-action="remove-live" data-tip="Remove the live banner" aria-label="Remove the live banner">🖼</button>` : '') +
      (d.blocked
        ? `<button class="btn-icon" data-addr="${addr}" data-action="unblock-donor" data-tip="Unblock — allow profile submissions again" aria-label="Unblock this address">✅</button>`
        : `<button class="btn-icon btn-icon-danger" data-addr="${addr}" data-action="block-donor" data-tip="Block profile submissions from this address" aria-label="Block this address">🚫</button>`);
    return `<tr>
      <td class="mono">${rankCell}</td>
      <td class="mono" title="${escHtml(fmtGrin(d.in_window_donated))} × ${escHtml(String(d.multiplier))}">${fmtGrin(d.score)}</td>
      <td>${addrButton(d.address)}</td>
      <td>${profileCell(d)}</td>
      <td>${nowCell(d)}</td>
      <td class="mono">${fmtGrin(d.lifetime_donated)}</td>
      <td class="mono">${fmtGrin(d.in_window_donated)}</td>
      <td class="mono">${d.active_months || 0} · ×${escHtml(String(d.multiplier))}</td>
      <td class="mono" style="white-space:nowrap;">${fmtDate(d.first_donated_at)}<br>${fmtDate(d.last_donated_at)}</td>
      <td>${workersCell(d.workers)}</td>
      <td><div class="row-actions">${actions}</div></td>
    </tr>`;
  }
});

async function loadDonors() {
  try {
    const data = await API.get('/api/admin/donors?limit=500');
    // `null`/error and "no donors" are different facts; never render the first as the second.
    if (!data || data.success !== true || !Array.isArray(data.donors)) {
      donorsTable.setError((data && data.error) || 'Could not load donors');
      return;
    }
    _allDonors = data.donors;
    _donationsActive = data.donations_active !== false;
    _windowDays = Number(data.window_days) || 0;
    _bannerSlots = Number.isFinite(Number(data.banner_slots)) ? Number(data.banner_slots) : 5;
    const withProfile = _allDonors.filter(d => d.name || d.banner).length;
    const blocked = _allDonors.filter(d => d.blocked).length;
    const donating = _allDonors.filter(d => d.rigs_donating > 0).length;
    document.getElementById('donor-summary').textContent =
      `${data.count} total · ${withProfile} with a profile · ${donating} donating now · ${blocked} blocked · ` +
      `window ${_windowDays > 0 ? _windowDays + ' d' : 'lifetime'} · banner slots ${_bannerSlots}`;
    filterDonors();
  } catch (err) {
    donorsTable.setError(err.message);
  }
}

// `reset` is passed only when the select changed — the refresh timer must not yank the
// operator back to page 1 while they are reading page 3.
function filterDonors(reset) {
  const mode = document.getElementById('donor-filter').value;
  let rows = _allDonors;
  if (mode === 'profile')  rows = rows.filter(d => d.name || d.banner);
  if (mode === 'pending')  rows = rows.filter(d => d.pending && (d.pending.name || d.pending.banner));
  if (mode === 'donating') rows = rows.filter(d => d.rigs_donating > 0);
  if (mode === 'blocked')  rows = rows.filter(d => !!d.blocked);
  donorsTable.setRows(rows, { reset: reset === true });   // server order = league order
}

async function removeLive(addr, kind, msgId) {
  const reason = await askReason({
    title: kind === 'banner' ? 'Remove the live banner' : 'Remove the live name',
    body: kind === 'banner'
      ? `${addr}\n\nIt comes off the donor wall now. The donor can submit a new one, which goes through review again.`
      : `${addr}\n\nIt comes off the donor wall now. The donor can set another name when their 7-day change limit allows; it is checked automatically. To stop this name coming back in any spelling, ban it instead.`,
    label: 'Reason (optional) — shown to the donor on their public account page',
    confirmText: 'Remove', danger: true
  });
  if (reason === null) return;
  await postAction('/api/admin/donors/' + encodeURIComponent(addr) + '/remove', { kind, reason },
                   kind === 'banner' ? 'Banner removed.' : 'Name removed.', msgId || 'donor-msg');
}
async function blockDonor(addr, msgId) {
  const reason = await askReason({
    title: 'Block donor-profile submissions',
    body: `${addr}\n\nThis address can no longer set a name or submit a banner, and a banner it has waiting is withdrawn. A live name or banner stays until you remove it. Donations are unaffected.`,
    label: 'Note (optional) — kept for the admin side only, never shown to the donor',
    confirmText: 'Block', danger: true
  });
  if (reason === null) return;
  await postAction('/api/admin/donors/' + encodeURIComponent(addr) + '/block', { reason }, 'Address blocked.', msgId || 'donor-msg');
}
async function unblockDonor(addr) {
  if (!confirm(`Unblock ${addr}?\n\nIt can set a donor name (checked automatically) and submit a banner (still reviewed by you) again.`)) return;
  await postAction('/api/admin/donors/' + encodeURIComponent(addr) + '/unblock', {}, 'Address unblocked.', 'donor-msg');
}

// ── Donation settings (incentives section, page-local form) ──────────────────────────
// The harvester follows settings-common.js's three rules (bind by id; skip `settings-skip`;
// drop EMPTY scalars unless `settings-allow-empty`, send checkboxes and textareas always), so a
// stray id here fails the save the same way it would there — and updateSection() upserts only
// the keys it is sent, so this partial form and the Incentives page never clobber each other.
const FORM_SEL = '#donation-settings .settings-form';

async function loadDonationSettings() {
  try {
    const d = await API.get('/api/admin/settings/incentives');
    if (!d || d.success !== true || !d.data) throw new Error((d && d.error) || 'Could not load settings');
    const v = d.data;
    document.querySelectorAll(FORM_SEL + ' input, ' + FORM_SEL + ' select, ' + FORM_SEL + ' textarea').forEach(el => {
      if (!el.id || el.classList.contains('settings-skip')) return;
      if (!(el.id in v)) return;
      const val = v[el.id];
      if (el.type === 'checkbox') el.checked = val === true || val === 'true';
      else el.value = val == null ? '' : String(val);
    });
  } catch (err) { flashInto('settings-msg', err.message, true); }
}

function harvestDonationSettings() {
  const data = {};
  document.querySelectorAll(FORM_SEL + ' input, ' + FORM_SEL + ' select, ' + FORM_SEL + ' textarea').forEach(el => {
    if (!el.id || el.classList.contains('settings-skip')) return;
    if (el.type === 'checkbox') data[el.id] = el.checked;
    else if (el.tagName === 'TEXTAREA') data[el.id] = el.value;
    else if (el.value || el.classList.contains('settings-allow-empty')) data[el.id] = el.value;
  });
  return data;
}

async function saveDonationSettings() {
  try {
    const res = await adminFetch('/api/admin/settings/incentives', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(harvestDonationSettings())
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || ('HTTP ' + res.status));   // the server's reason, §J14
    flashInto('settings-msg', 'Donation settings saved.', false);
    // Slots/expiry feed the list's badges.
    loadQueue();
    loadDonors();
  } catch (err) { flashInto('settings-msg', 'Not saved: ' + err.message, true); }
}

document.addEventListener('DOMContentLoaded', () => { loadQueue(); loadNames(); loadDonors(); loadDonationSettings(); });
// The donors list re-polls; the queue does NOT — a timer repaint would throw away a reason the
// operator is typing. It reloads after every decision and on the Refresh button.
setInterval(loadDonors, 60000);

// ==== F5: event wiring — replaces the inline on*= attributes (strict script-src, no inline handlers).
// One delegated listener per event type; data-action names the handler. Every old handler ignored
// the Event and `this` except where noted, so the wrappers pass exactly the arguments the attribute did.
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  switch (el.dataset.action) {
    case 'load-queue':             loadQueue(); break;
    case 'load-names':             loadNames(); break;
    case 'save-donation-settings': saveDonationSettings(); break;
    case 'approve-request':        approveRequest(el.dataset.id); break;
    case 'reject-request':         rejectRequest(el.dataset.id); break;
    case 'unban-name':             unbanName(el.dataset.norm); break;
    case 'remove-live-names':      removeLive(el.dataset.addr, el.dataset.kind, 'names-msg'); break;
    case 'ban-name':               banName(el.dataset.name); break;
    case 'block-donor-names':      blockDonor(el.dataset.addr, 'names-msg'); break;
    case 'remove-live':            removeLive(el.dataset.addr, el.dataset.kind); break;
    case 'unblock-donor':          unblockDonor(el.dataset.addr); break;
    case 'block-donor':            blockDonor(el.dataset.addr); break;
  }
});
document.addEventListener('change', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  switch (el.dataset.action) {
    case 'load-queue-change':     loadQueue(true); break;
    case 'load-names-change':     loadNames(true); break;
    case 'filter-donors-change':  filterDonors(true); break;
  }
});
