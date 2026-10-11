// miners.html page script — moved BYTE-verbatim out of the page's inline script block (code-layout F5).
// Classic script (no defer/module) loaded at the same position as the old block, after the <script src> tags before it, whose globals it uses (H14).
// Auth gate (httpOnly-cookie aware): redirects to /login.html if not an admin, else wires
// up the topbar username + Logout. Pool name + testnet banner are handled by admin-shell.js.
// stepup.js provides adminFetch() for the step-up-gated ban/unban/clear actions.
API.guardAdminPage();

// ── State ────────────────────────────────────────────────────────────────────
let _allMiners = [];
// Status windows (seconds) — replaced by the server's own values on the first load, so the
// labels below can never describe a window the API is not using (lib/miner-status.js).
let _win = { hashrate_s: 600, seen_s: 3600, stall_s: 900 };
let _filter = '';
let _sort = { key: 'balance', dir: -1 };
const _open = new Set();       // addresses whose row is expanded (survives the 30 s refresh)
const _detail = new Map();     // address → { miner, factsAt, workers, at, err }
const _inflight = new Set();   // addresses with a detail fetch in progress
const _factsDue = new Set();   // addresses whose account facts must be re-read on the next fetch
let _loading = false;
// The account facts (GET /api/admin/miners/:addr) are re-read at most this often by the timer;
// opening a row or acting on it re-reads them at once. That route counts every retained share of
// the address, on the DB the stratum server shares, so it must not ride the 30 s refresh.
const FACTS_MAX_AGE_S = 300;
// The list is capped (LIST_LIMIT, the route's maximum): every account that mined recently, banned
// ones, then the rest by balance. `_scope` is what the server said about the cut. When it cut
// something, the address filter ALSO asks the server (?search=), and the accounts it finds that
// the list lacks sit in `_found` for as long as that query stays in the box. They are listed,
// but not counted in the chips, which describe the list the server chose.
const LIST_LIMIT = 1000;
const SEARCH_MIN = 8;          // below this a substring matches half the pool ("grin1…" is 5)
let _scope = null;             // { total_accounts, mined_accounts, truncated, count }
let _found = new Map();        // address → row, for the query in _foundQ
let _foundQ = '';
let _searchSeq = 0;            // drops a slower, older search response
let _searchTimer = null;

// ── Formatting ───────────────────────────────────────────────────────────────
function escHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function fmtGrin(v) { return (Number(v) || 0).toFixed(4); }
// G/s → kG/s → MG/s, the toolkit-wide display units (CLAUDE.md, Cuckatoo32 hashrate).
function fmtGps(v) {
  v = Number(v) || 0;
  if (!(v > 0)) return '—';
  if (v >= 1e6) return (v / 1e6).toFixed(2) + ' MG/s';
  if (v >= 1e3) return (v / 1e3).toFixed(2) + ' kG/s';
  return v.toFixed(2) + ' G/s';
}
function timeAgo(t) {
  if (!t) return '—';
  const diff = Math.max(0, Math.floor(Date.now() / 1000 - t));
  if (diff < 60)    return diff + 's ago';
  if (diff < 3600)  return Math.floor(diff / 60) + 'm ago';
  if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
  return Math.floor(diff / 86400) + 'd ago';
}
function fmtUtc(t) { return t ? new Date(t * 1000).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : '—'; }
function fmtClock(t) { return t ? new Date(t * 1000).toISOString().slice(11, 19) + ' UTC' : '—'; }
function fmtMins(s) { return s >= 3600 && s % 3600 === 0 ? (s / 3600) + ' h' : Math.round(s / 60) + ' min'; }
function plural(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }
function shortAddr(a) {
  a = String(a || '');
  return a.length > 22 ? a.slice(0, 12) + '…' + a.slice(-7) : a;
}

// ── Status ───────────────────────────────────────────────────────────────────
// A row's state = banned (an account flag) on top of the server's live status
// (mining | degraded | connecting | offline — rules in lib/miner-status.js).
const STATE_LABEL = { mining: 'Mining', degraded: 'Degraded', connecting: 'Connecting', offline: 'Offline', banned: 'Banned' };
// Sort order for the Miner column: what needs attention first.
const STATE_ORDER = { degraded: 0, connecting: 1, mining: 2, offline: 3, banned: 4 };
function stateOf(m) { return m.is_banned ? 'banned' : (STATE_LABEL[m.status] ? m.status : 'offline'); }
function stateText(m) {
  const st = stateOf(m);
  if (st === 'banned') return 'Banned' + (m.ban_reason ? ' — ' + m.ban_reason : '');
  if (st === 'mining') return 'Mining — ' + plural(m.workers_online, 'rig') + ' live';
  if (st === 'connecting') return 'Connecting — a session is open but no share has been accepted on it yet';
  if (st === 'degraded') {
    const why = [];
    if (m.workers_stalled) why.push(plural(m.workers_stalled, 'live rig') + ' with no accepted share in ' + fmtMins(_win.stall_s));
    if (m.workers_missing) why.push(plural(m.workers_missing, 'rig') + ' that shared in the last ' + fmtMins(_win.seen_s) + ' ' + (m.workers_missing === 1 ? 'is' : 'are') + ' not connected');
    return 'Degraded — ' + (why.join('; ') || 'a rig needs attention');
  }
  return 'Offline';
}

// ── Table ────────────────────────────────────────────────────────────────────
const COLS = document.querySelectorAll('#miners-table thead th').length;

// Address search + paging from AdminTable (admin-shell.js); the status chips and the sort
// stay page-side and feed it a prepared array. An expanded miner renders as a SECOND <tr>
// from the same row() call, so paging still counts miners, not table rows.
const minersTable = AdminTable.create({
  tbody: 'miners-tbody',
  search: 'Filter by address…',
  empty: 'No miners in this view.',
  urlQuery: true,
  note: 'Miner accounts are kept permanently — the share and hashrate history behind ' +
        'them is pruned per <a href="/admin/settings-database.html">Settings → Database</a>.',
  text: m => [m.grin_address, m.ban_reason].join(' '),
  onSearch: q => {
    clearTimeout(_searchTimer);
    _searchTimer = setTimeout(() => searchServer(q), 300);
  },
  row: (m, i) => {
    const addr = escHtml(m.grin_address);
    const st = stateOf(m);
    const open = _open.has(m.grin_address);
    const detailId = 'mn-d-' + i;
    // data-addr + this.dataset, NOT a value spliced into a JS string literal. escHtml() is an
    // HTML escaper: inside onclick="…" the parser decodes its &#39; back to a real ' BEFORE the
    // JS is parsed, so an apostrophe in the value closes the string and the rest executes. The
    // bech32 address charset is what stops that today (§J6-6) — a validator on another route, in
    // another file, is not the escaping this needs. Audit §J14.
    const action = m.is_banned
      ? `<button class="btn-icon" data-addr="${addr}" data-action="unban-miner" data-tip="Unban this miner" aria-label="Unban this miner">✅</button>`
      : `<button class="btn-icon btn-icon-danger" data-addr="${addr}" data-action="ban-miner" data-tip="Ban this miner" aria-label="Ban this miner">🚫</button>`;
    // The address expands the row; copying is the ⧉ beside it (admin-shell.js handles
    // [data-copy]). data-fk lets a repaint put keyboard focus back on the same control.
    const state = escHtml(stateText(m));
    const toggle =
      `<button type="button" class="mn-toggle" data-addr="${addr}" data-fk="t:${addr}" ` +
      `aria-expanded="${open}" aria-controls="${detailId}" ` +
      `aria-label="${open ? 'Hide' : 'Show'} rigs and details for ${escHtml(shortAddr(m.grin_address))}. ${state}" ` +
      `data-tip="${state}&#10;${addr}&#10;Click to ${open ? 'hide' : 'show'} rigs and details">` +
      `<span class="mn-chev" aria-hidden="true">▸</span>` +
      `<span class="mn-dot mn-st-${st}" aria-hidden="true"></span>` +
      `<span>${escHtml(shortAddr(m.grin_address))}</span></button>`;
    const copy = `<button type="button" class="addr-copy mn-copy" data-copy="${addr}" data-fk="c:${addr}" ` +
      `data-tip="Copy the full address" aria-label="Copy address ${escHtml(shortAddr(m.grin_address))}"></button>`;

    const main = `<tr class="mn-row${open ? ' is-open' : ''}" data-addr="${addr}">
      <td><div class="mn-cell">${toggle}${copy}</div></td>
      <td>${rigsCell(m)}</td>
      <td class="mono">${fmtGps(m.hashrate_gps)}</td>
      <td class="mono">${fmtGrin(m.balance)}</td>
      <td class="mono">${fmtGrin(m.balance_locked)}</td>
      <td class="mono">${fmtGrin(m.total_paid)}</td>
      <td>${lastCell(m)}</td>
      <td><div class="row-actions">${action}</div></td>
    </tr>`;
    return open ? main + detailRow(m, detailId) : main;
  },
  onRender: restoreFocus
});

function rigsCell(m) {
  if (!m.workers_total) return '<span class="mn-dim">—</span>';
  const cls = (m.workers_online < m.workers_total || m.workers_stalled) ? 'mn-warn' : '';
  const tip = `${m.workers_online} of ${plural(m.workers_total, 'rig')} connected and mining` +
              (m.workers_stalled ? ` (${m.workers_stalled} stalled)` : '') +
              ` — counting rigs seen in the last ${fmtMins(_win.seen_s)}`;
  return `<span class="mono ${cls}" data-tip="${escHtml(tip)}">${m.workers_online}/${m.workers_total}</span>`;
}

// last_share_at is only known inside the server's seen window (one hour). Past that the
// column falls back to last_seen_at — the last connect or disconnect — and says so.
function lastCell(m) {
  const now = Date.now() / 1000;
  if (m.last_share_at) {
    const cls = (now - m.last_share_at) > _win.stall_s ? 'mn-warn' : '';
    return `<span class="${cls}" data-tip="Last accepted share: ${escHtml(fmtUtc(m.last_share_at))}">${timeAgo(m.last_share_at)}</span>`;
  }
  if (m.last_seen_at) {
    return `<span class="mn-dim" data-tip="${escHtml('No share in the last ' + fmtMins(_win.seen_s) + '. Last connect or disconnect: ' + fmtUtc(m.last_seen_at))}">seen ${timeAgo(m.last_seen_at)}</span>`;
  }
  return '<span class="mn-dim">—</span>';
}
function lastActiveOf(m) { return m.last_share_at || m.last_seen_at || 0; }

// ── Expanded row ─────────────────────────────────────────────────────────────
function detailRow(m, id) {
  const d = _detail.get(m.grin_address);
  let body;
  if (!d || (!d.miner && !d.err)) {
    body = '<span class="spinner"></span>Loading rigs and account details…';
  } else if (!d.miner) {
    body = `<p class="error-msg" style="margin:0;">Could not load this miner: ${escHtml(d.err)}</p>`;
  } else {
    body = (d.err ? `<p class="mn-stale-note">Refresh failed (${escHtml(d.err)}) — showing data from ${escHtml(fmtUtc(d.at))}.</p>` : '') +
           factsHtml(m, d.miner) + rigsHtml(d.workers) + linksHtml(m, d);
  }
  return `<tr class="mn-detail" id="${id}"><td colspan="${COLS}"><div class="mn-inner">${body}</div></td></tr>`;
}

function fact(label, html, wide) {
  return `<div class="mn-fact${wide ? ' mn-fact-wide' : ''}"><dt>${escHtml(label)}</dt><dd>${html}</dd></div>`;
}

// `m` = the list row (live status, refreshed every 30 s); `d` = GET /api/admin/miners/:addr.
function factsHtml(m, d) {
  const out = [];
  out.push(fact('Status', `<span class="mn-dot mn-st-${stateOf(m)}" aria-hidden="true"></span> ${escHtml(stateText(m))}`, true));
  out.push(fact('Hashrate · 1 h average', escHtml(fmtGps(d.hashrate_gps))));
  out.push(fact('Blocks found', escHtml(d.blocks_found != null ? d.blocks_found : 0)));
  out.push(fact('Shares retained', `<span data-tip="Counts only what share retention has kept (Settings → Database)">${escHtml(d.shares_count != null ? d.shares_count : 0)}</span>`));
  out.push(fact('First seen', escHtml(fmtUtc(d.created_at))));
  out.push(fact('Last connect / disconnect', escHtml(fmtUtc(d.last_seen_at))));

  const p = d.proofs;
  if (p && p.ip && p.pass) {
    const anchor = (p.ip.anchor_live || p.pass.anchor_live) ? 'original proof on record' : 'original proof no longer on record';
    const pw = d.pass_proof_state ? ` · rig password check: ${escHtml(d.pass_proof_state)}` : '';
    out.push(fact('Ownership proofs',
      `${escHtml(p.ip.live)} IP · ${escHtml(p.pass.live)} password (max ${escHtml(p.max)} each) · ${escHtml(anchor)}${pw}`));
  }
  if (d.nostr_username) out.push(fact('Goblin username', escHtml(d.nostr_username)));
  if (d.is_banned) {
    out.push(fact('Ban', `<span class="badge badge-error">Banned</span> ${escHtml(fmtUtc(d.banned_at))}` +
      (d.ban_reason ? ` · ${escHtml(d.ban_reason)}` : ' · no reason given'), true));
  }
  out.push(fact('Tor payouts', torPauseHtml(m.grin_address, d), true));
  out.push(fact('Pending payouts', pendingHtml(d.pending_withdrawals), true));
  return `<dl class="mn-facts">${out.join('')}</dl>`;
}

// The Tor pause is anti-abuse: 5 counted failed Tor payouts in 24 h (only "the miner's wallet
// did not answer" counts) pause Tor for that address for 24 h; Slatepack stays open. Clear it
// when the failures were the pool's fault — the rows are re-coded, never deleted. Nothing here
// computes a pause: paused ⇔ the server sent paused_until. Times UTC.
function torPauseHtml(addr, m) {
  const tp = m.tor_pause;
  let html;
  if (!tp) {
    html = '<span class="mn-dim">unavailable (scheduler not running)</span>';
  } else if (tp.paused_until) {
    html = `<span class="badge badge-error">Tor paused</span> until <strong>${escHtml(fmtUtc(tp.paused_until))}</strong>` +
           ` · ${escHtml(tp.failures_24h)} of ${escHtml(tp.max)} counted failures in the last 24 h`;
  } else {
    html = `<span class="badge badge-ok">Tor open</span> · ${escHtml(tp.failures_24h)} of ${escHtml(tp.max)} counted failures in the last 24 h`;
  }
  const n = tp ? Number(tp.failures_24h) || 0 : 0;
  if (n > 0) {
    html += ` <button type="button" class="btn btn-sm btn-outline" style="margin-left:.4rem;" data-addr="${escHtml(addr)}" ` +
            `data-fk="p:${escHtml(addr)}" data-action="clear-tor-pause" ` +
            `data-tip="Un-count these failures (history is kept). Use it when they were the pool’s fault." ` +
            `aria-label="Clear the Tor pause for this miner">Clear Tor pause</button>`;
  }
  return html;
}

function pendingHtml(list) {
  const pending = Array.isArray(list) ? list : [];
  if (!pending.length) return '<span class="mn-dim">none</span>';
  return pending.map(w => `payout ID ${escHtml(w.id)} · ${escHtml(w.method)} · ${escHtml(w.status)} · ${fmtGrin(w.amount)} ツ`).join('<br>');
}

const RIG_STATUS = {
  mining:  ['mining',   'Mining'],
  stalled: ['degraded', 'Stalled'],
  offline: ['offline',  'Offline']
};
function rigsHtml(workers) {
  const rows = Array.isArray(workers) ? workers : [];
  const head = `<p class="mn-sub">Rigs — seen in the last ${escHtml(fmtMins(_win.seen_s))}</p>`;
  if (!rows.length) {
    return head + `<p class="mn-dim" style="margin:0;font-size:.88rem;">No rig has shared in the last ${escHtml(fmtMins(_win.seen_s))} and none is connected.</p>`;
  }
  const pct = v => v == null ? '<span class="mn-dim">—</span>' : escHtml(v) + '%';
  const body = rows.map(w => {
    const [dot, label] = RIG_STATUS[w.status] || RIG_STATUS.offline;
    const tip = w.status === 'stalled'
      ? `Connected, but no accepted share in ${fmtMins(_win.stall_s)}` : label;
    const donate = w.donate_percent != null
      ? ` <span class="badge badge-dim" data-tip="This rig's donateN tag gives ${escHtml(w.donate_percent)}% of what it earns to the prize pool">donates ${escHtml(w.donate_percent)}%</span>` : '';
    const last = w.last_share_at
      ? `<span data-tip="${escHtml(fmtUtc(w.last_share_at))}">${timeAgo(w.last_share_at)}</span>`
      : '<span class="mn-dim">—</span>';
    return `<tr>
      <td><span class="mn-rig-name"><span class="mn-dot mn-st-${dot}" aria-hidden="true"></span>${escHtml(w.worker_name)}</span>${donate}</td>
      <td><span data-tip="${escHtml(tip)}">${escHtml(label)}</span></td>
      <td class="mono">${fmtGps(w.hashrate_gps_10m)}</td>
      <td class="mono">${fmtGps(w.hashrate_gps_1h)}</td>
      <td class="mono">${escHtml(w.share_count != null ? w.share_count : 0)}</td>
      <td>${last}</td>
      <td class="mono">${pct(w.reject_pct)}</td>
      <td class="mono">${pct(w.stale_pct)}</td>
      <td>${w.regions && w.regions.length ? escHtml(w.regions.join(', ')) : '<span class="mn-dim">—</span>'}</td>
      <td>${w.connected_since ? `<span data-tip="${escHtml(fmtUtc(w.connected_since))}">${timeAgo(w.connected_since)}</span>` : '<span class="mn-dim">—</span>'}</td>
    </tr>`;
  }).join('');
  // Reject/stale are LIVE session counters: they reset when a rig reconnects and are blank
  // for an offline rig, so the header says so rather than implying an hour's figure.
  return head + `<div class="mn-rigs-wrap"><table class="mn-rigs">
    <thead><tr>
      <th>Rig</th><th>Status</th>
      <th>Hashrate · ${escHtml(fmtMins(_win.hashrate_s))}</th><th>Hashrate · ${escHtml(fmtMins(_win.seen_s))}</th>
      <th>Shares · ${escHtml(fmtMins(_win.seen_s))}</th><th>Last share</th>
      <th><span data-tip="Since this rig's session started">Reject</span></th>
      <th><span data-tip="Since this rig's session started">Stale</span></th>
      <th>Region</th><th>Connected</th>
    </tr></thead><tbody>${body}</tbody></table></div>`;
}

// payments.html reads ?q= into its filter box (AdminTable urlQuery). It loads the 100 most
// recent payouts, so the link says "recent" rather than promising the full history.
// The two halves refresh on different clocks (see FACTS_MAX_AGE_S), so both times are shown.
function linksHtml(m, d) {
  const href = '/admin/payments.html?q=' + encodeURIComponent(m.grin_address);
  return `<div class="mn-links">
    <a class="btn btn-sm btn-outline" href="${escHtml(href)}">Recent payouts for this address →</a>
    <span class="mn-dim" style="font-size:.78rem;">Rigs as of ${escHtml(fmtClock(d.at))} · account details as of ${escHtml(fmtClock(d.factsAt))}</span>
  </div>`;
}

// ── Expand / collapse ────────────────────────────────────────────────────────
function toggleMiner(addr) {
  if (!addr) return;
  if (_open.has(addr)) {
    _open.delete(addr);
    // Re-opening later must show a spinner, not minutes-old figures as if they were current.
    _detail.delete(addr);
    _factsDue.delete(addr);
  } else {
    _open.add(addr);
    fetchDetail(addr);
  }
  repaint();
}

// The rigs every time; the account facts only on first open, when asked ({ facts: true }, after
// an action on this miner) or once they are FACTS_MAX_AGE_S old. A failed REFRESH keeps the last
// good data on screen with a note instead of blanking the row the operator is reading.
function fetchDetail(addr, opts) {
  if (opts && opts.facts) _factsDue.add(addr);
  // Already fetching: a facts request that arrived meanwhile is picked up by the finally below.
  if (_inflight.has(addr)) return;
  const prev = _detail.get(addr);
  const nowS = Math.floor(Date.now() / 1000);
  const wantFacts = _factsDue.has(addr) || !prev || !prev.miner || !prev.factsAt || prev.factsRetry ||
                    (nowS - prev.factsAt) >= FACTS_MAX_AGE_S;
  _factsDue.delete(addr);
  _inflight.add(addr);
  Promise.all([
    wantFacts ? API.get('/api/admin/miners/' + encodeURIComponent(addr)) : null,
    API.get('/api/admin/miners/' + encodeURIComponent(addr) + '/workers')
  ]).then(([d, w]) => {
    if (!_open.has(addr)) return;     // collapsed while in flight: keep nothing
    if (w && w.windows) _win = w.windows;
    const at = Math.floor(Date.now() / 1000);
    const base = _detail.get(addr) || {};
    _detail.set(addr, {
      miner: wantFacts ? ((d && d.miner) || {}) : base.miner,
      factsAt: wantFacts ? at : base.factsAt,
      workers: (w && w.workers) || [],
      at, err: null
    });
  }).catch(err => {
    if (!_open.has(addr)) return;
    const prev = _detail.get(addr) || {};
    // A failed facts read is retried on the next 30 s refresh (factsRetry), not in 5 min — and
    // not straight away either, so a down API is not hammered in a loop.
    _detail.set(addr, { ...prev, factsRetry: !!(wantFacts || prev.factsRetry), err: (err && err.message) || 'request failed' });
  }).finally(() => {
    _inflight.delete(addr);
    if (!_open.has(addr)) { _factsDue.delete(addr); return; }
    repaint();
    // _factsDue was cleared when this fetch started, so it is set now only by an action that
    // asked for fresh facts WHILE this fetch was in flight (possibly one without facts). Honour it.
    if (_factsDue.has(addr)) fetchDetail(addr);
  });
}

// Every repaint rebuilds the tbody, which would drop keyboard focus onto <body>. Controls that
// can trigger one carry data-fk; the focused one is found again after the paint.
let _focusKey = null;
function captureFocus() {
  const a = document.activeElement;
  _focusKey = (a && a.getAttribute && document.getElementById('miners-tbody').contains(a)) ? a.getAttribute('data-fk') : null;
}
function restoreFocus(tbody) {
  if (!_focusKey) return;
  const key = _focusKey;
  _focusKey = null;
  // Only when the repaint actually LOST focus. A key left over from a paint that had no rows
  // (so no onRender) must not later pull focus out of the search box the operator is typing in.
  const a = document.activeElement;
  if (a && a !== document.body) return;
  const el = Array.prototype.find.call(tbody.querySelectorAll('[data-fk]'), e => e.getAttribute('data-fk') === key);
  if (el) el.focus({ preventScroll: true });
}
function repaint() { captureFocus(); minersTable.refresh(); }

document.getElementById('miners-tbody').addEventListener('click', (e) => {
  const t = e.target;
  const tog = t.closest('.mn-toggle');
  if (tog) { toggleMiner(tog.dataset.addr); return; }
  // Anything interactive keeps its own meaning, and nothing inside the details collapses it.
  if (t.closest('button, a, input, select, textarea, label, [data-copy], tr.mn-detail')) return;
  const tr = t.closest('tr.mn-row');
  if (!tr) return;
  // Selecting a figure to copy it must not toggle the row.
  if (window.getSelection && String(window.getSelection())) return;
  toggleMiner(tr.dataset.addr);
});

// ── Load, filter, sort ───────────────────────────────────────────────────────
async function loadMiners() {
  if (_loading) return;            // a slow server must not stack 30 s refreshes
  _loading = true;
  try {
    const data = await API.get('/api/admin/miners?limit=' + LIST_LIMIT);
    _allMiners = (data && data.miners) || [];
    if (data && data.windows) _win = data.windows;
    _scope = {
      total_accounts: Number(data && data.total_accounts) || _allMiners.length,
      mined_accounts: Number(data && data.mined_accounts) || 0,
      truncated: !!(data && data.truncated),
      count: _allMiners.length
    };
    document.getElementById('hr-win').textContent = fmtMins(_win.hashrate_s);
    updateCounts();
    updateScope();
    // Keep an active server-side lookup (typed, or a ?q= deep link) as fresh as the list.
    if (minersTable.query) searchServer(minersTable.query);
    document.getElementById('miner-updated').textContent =
      'updated ' + new Date().toISOString().slice(11, 19) + ' UTC';
    applyView();
    // Keep open rows as fresh as the list, but only the ones on screen (another page or chip
    // hides the rest; the as-of line tells the operator how old those are when they come back)
    // and not while the tab is hidden: each refresh reads every retained share of that address.
    if (!document.hidden) {
      document.querySelectorAll('#miners-tbody tr.mn-row.is-open').forEach(tr => fetchDetail(tr.dataset.addr));
    }
  } catch (err) {
    minersTable.setError(err.message);
  } finally {
    _loading = false;
  }
}

function updateCounts() {
  const n = { mining: 0, degraded: 0, connecting: 0, offline: 0, banned: 0 };
  for (const m of _allMiners) n[stateOf(m)]++;
  document.getElementById('n-all').textContent = _allMiners.length;
  for (const k of Object.keys(n)) document.getElementById('n-' + k).textContent = n[k];
  // Connecting is brief and usually zero; its chip appears only when it has something (or is
  // the active filter, so the operator is never left on an invisible chip).
  document.getElementById('chip-connecting').hidden = !n.connecting && _filter !== 'connecting';
}

function updateScope() {
  const el = document.getElementById('miner-scope');
  const s = _scope;
  if (!s) { el.textContent = ''; return; }
  let t;
  if (!s.truncated) {
    t = `All ${plural(s.total_accounts, 'account')}.`;
  } else if (s.mined_accounts > s.count) {
    t = `Showing ${s.count} of ${s.total_accounts} accounts: the ${s.count} biggest of the ` +
        `${s.mined_accounts} that mined in the last ${fmtMins(_win.seen_s)}. The rest are not listed.`;
  } else {
    t = `Showing ${s.count} of ${s.total_accounts} accounts: every one that mined in the last ` +
        `${fmtMins(_win.seen_s)} (${s.mined_accounts}), banned ones, then the rest by balance.`;
  }
  if (s.truncated) t += ` The address filter also searches every account (${SEARCH_MIN}+ characters).`;
  if (_found.size) t += ` ${plural(_found.size, 'account')} found by that search ${_found.size === 1 ? 'is' : 'are'} added below.`;
  el.textContent = t;
}

// Server-side lookup for an address the capped list does not hold. Only when the list IS capped
// and the query is long enough to mean one account; otherwise it just drops earlier finds.
async function searchServer(q) {
  q = String(q || '').trim().toLowerCase();
  const seq = ++_searchSeq;
  if (!_scope || !_scope.truncated || q.length < SEARCH_MIN) {
    if (_found.size || _foundQ) { _found = new Map(); _foundQ = ''; updateScope(); applyView(); }
    return;
  }
  try {
    const data = await API.get('/api/admin/miners?limit=50&search=' + encodeURIComponent(q));
    if (seq !== _searchSeq) return;               // a newer keystroke or refresh owns the result
    const listed = new Set(_allMiners.map(m => m.grin_address));
    _found = new Map(((data && data.miners) || [])
      .filter(m => !listed.has(m.grin_address))
      .map(m => [m.grin_address, m]));
    _foundQ = q;
  } catch (err) {
    if (seq !== _searchSeq) return;
    _found = new Map(); _foundQ = '';
  }
  updateScope();
  applyView();
}

const SORT_VAL = {
  status:   m => STATE_ORDER[stateOf(m)],
  workers:  m => m.workers_online || 0,
  hashrate: m => m.hashrate_gps || 0,
  balance:  m => m.balance || 0,
  locked:   m => m.balance_locked || 0,
  paid:     m => m.total_paid || 0,
  last:     m => lastActiveOf(m)
};
// First click on a column: status ascending (problems first), every number descending.
const SORT_FIRST_DIR = { status: 1 };

// `reset` is passed only when the operator changed a chip or the sort — the 30 s refresh must
// not yank them back to page 1 while they are reading page 4.
function applyView(reset) {
  // Search finds are added only where the list lacks them: a refresh can pull a found account
  // into the list before the refreshed search answers, and it must not show twice meanwhile.
  let pool = _allMiners;
  if (_found.size) {
    const listed = new Set(_allMiners.map(m => m.grin_address));
    pool = _allMiners.concat([..._found.values()].filter(m => !listed.has(m.grin_address)));
  }
  let rows = _filter ? pool.filter(m => stateOf(m) === _filter) : pool.slice();
  const val = SORT_VAL[_sort.key] || SORT_VAL.balance;
  const dir = _sort.dir;
  // Ties fall back to balance (the server's order), so equal rows do not shuffle between refreshes.
  rows.sort((a, b) => ((val(a) - val(b)) * dir) || ((b.balance || 0) - (a.balance || 0)));
  captureFocus();
  minersTable.setRows(rows, { reset: reset === true });
}

document.getElementById('status-chips').addEventListener('click', (e) => {
  const btn = e.target.closest('.tab-btn');
  if (!btn) return;
  _filter = btn.dataset.filter || '';
  document.querySelectorAll('#status-chips .tab-btn').forEach(b => {
    const on = b === btn;
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', String(on));
  });
  applyView(true);
});

document.querySelector('#miners-table thead').addEventListener('click', (e) => {
  const btn = e.target.closest('.mn-sort');
  if (!btn) return;
  const key = btn.dataset.sort;
  _sort = (_sort.key === key) ? { key, dir: -_sort.dir } : { key, dir: SORT_FIRST_DIR[key] || -1 };
  document.querySelectorAll('#miners-table thead th').forEach(th => {
    const b = th.querySelector('.mn-sort');
    th.setAttribute('aria-sort', b && b.dataset.sort === _sort.key
      ? (_sort.dir === 1 ? 'ascending' : 'descending') : 'none');
  });
  applyView(true);
});

// ── Messages + dialog ────────────────────────────────────────────────────────
function flash(msg, isErr) {
  const el = document.getElementById('miner-msg');
  el.textContent = msg;
  el.className = isErr ? 'error-msg' : 'success-msg';
  el.style.display = '';
  clearTimeout(flash._t);
  flash._t = setTimeout(() => { el.style.display = 'none'; }, 6000);
}

// Resolves { value } on confirm (Enter submits), or null on Cancel, Escape or a click on the
// backdrop — the only ways to get null, so null really is the operator's decision.
// ONE dialog at a time. The backdrop stops a second click, but keyboard focus can still Tab out
// to a row button behind it; a second open would then attach a second submit listener to the
// same form, and one Submit would resolve BOTH — banning the first address too. So a new open
// cancels the old one first.
let _dialogClose = null;
function askDialog({ title, body, addr, confirmLabel, danger, input }) {
  if (_dialogClose) _dialogClose(null);
  return new Promise((resolve) => {
    const q = id => document.getElementById(id);
    const overlay = q('mn-dialog'), form = q('mn-dialog-form'), ok = q('mn-dialog-ok'),
          cancel = q('mn-dialog-cancel'), field = q('mn-dialog-field'), inp = q('mn-dialog-input');
    const previous = document.activeElement;
    q('mn-dialog-title').textContent = title;
    q('mn-dialog-body').textContent = body;
    q('mn-dialog-addr').textContent = addr || '';
    ok.textContent = confirmLabel;
    ok.className = 'btn' + (danger ? ' btn-danger' : '');
    field.style.display = input ? '' : 'none';
    q('mn-dialog-label').textContent = input ? input.label : '';
    inp.value = '';
    inp.placeholder = input && input.placeholder ? input.placeholder : '';

    function close(result) {
      _dialogClose = null;
      overlay.classList.remove('open');
      form.removeEventListener('submit', onSubmit);
      cancel.removeEventListener('click', onCancel);
      overlay.removeEventListener('click', onBackdrop);
      document.removeEventListener('keydown', onKey);
      if (previous && typeof previous.focus === 'function' && document.body.contains(previous)) previous.focus();
      resolve(result);
    }
    function onSubmit(e) { e.preventDefault(); close({ value: inp.value.trim() }); }
    function onCancel() { close(null); }
    function onBackdrop(e) { if (e.target === overlay) close(null); }
    function onKey(e) { if (e.key === 'Escape') { e.preventDefault(); close(null); } }
    form.addEventListener('submit', onSubmit);
    cancel.addEventListener('click', onCancel);
    overlay.addEventListener('click', onBackdrop);
    document.addEventListener('keydown', onKey);
    _dialogClose = close;
    overlay.classList.add('open');
    (input ? inp : ok).focus();
  });
}

// ── Actions (all step-up gated server-side: adminFetch opens the password dialog) ──────────
async function banMiner(addr) {
  const ans = await askDialog({
    title: 'Ban this miner?',
    body: 'Blocks new stratum logins and drops its live sessions. The balance is kept and can still be paid out.',
    addr, confirmLabel: 'Ban miner', danger: true,
    input: { label: 'Reason (optional, shown to admins only)', placeholder: 'e.g. share flooding from many IPs' }
  });
  if (!ans) return;
  try {
    const res = await adminFetch('/api/admin/miners/' + encodeURIComponent(addr) + '/ban', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason: ans.value })
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || ('HTTP ' + res.status));
    flash('Miner banned.', false);
    if (_open.has(addr)) fetchDetail(addr, { facts: true });
    loadMiners();
  } catch (err) { flash(err.message, true); }
}

async function unbanMiner(addr) {
  const ans = await askDialog({
    title: 'Unban this miner?',
    body: 'Its rigs can log in and mine again straight away.',
    addr, confirmLabel: 'Unban miner'
  });
  if (!ans) return;
  try {
    const res = await adminFetch('/api/admin/miners/' + encodeURIComponent(addr) + '/unban', { method: 'POST' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || ('HTTP ' + res.status));
    flash('Miner unbanned.', false);
    if (_open.has(addr)) fetchDetail(addr, { facts: true });
    loadMiners();
  } catch (err) { flash(err.message, true); }
}

async function clearTorPause(addr) {
  if (!addr) return;
  const ans = await askDialog({
    title: 'Clear the Tor pause?',
    body: 'Its counted Tor failures in the last 24 h stop counting (they stay in the history). ' +
          'Use it when the failures were the pool’s fault, not the miner’s wallet.',
    addr, confirmLabel: 'Clear Tor pause'
  });
  if (!ans) return;
  try {
    const res = await adminFetch('/api/admin/miners/' + encodeURIComponent(addr) + '/tor-pause/clear', { method: 'POST' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || ('HTTP ' + res.status));
    flash(`Tor pause cleared — ${body.cleared} failure(s) un-counted.`, false);
    if (_open.has(addr)) fetchDetail(addr, { facts: true });
  } catch (err) { flash(err.message, true); }
}

document.addEventListener('DOMContentLoaded', loadMiners);
setInterval(loadMiners, 30000);

// ==== F5: event wiring — replaces the inline on*= attributes (strict script-src, no inline handlers).
// One delegated listener per event type; data-action names the handler. Every old handler ignored
// the Event and `this` except where noted, so the wrappers pass exactly the arguments the attribute did.
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  switch (el.dataset.action) {
    case 'unban-miner':     unbanMiner(el.dataset.addr); break;
    case 'ban-miner':       banMiner(el.dataset.addr); break;
    case 'clear-tor-pause': clearTorPause(el.dataset.addr); break;
  }
});
