// blocks.html page script — moved BYTE-verbatim out of the page's inline script block (code-layout F5).
// Classic script (no defer/module) loaded at the same position as the old block, after the <script src> tags before it, whose globals it uses (H14).
let _filter = '';

// Auth gate (httpOnly-cookie aware): redirects to /login.html if not an admin, else wires
// up the topbar username + Logout. Pool name + testnet banner are handled by admin-shell.js.
API.guardAdminPage();

function escHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function fmtTs(t) { return t ? new Date(t * 1000).toLocaleString() : '—'; }
function shortAddr(a) {
  a = String(a || '');
  return a.length > 16 ? a.slice(0, 8) + '…' + a.slice(-5) : a;
}
// 2miners-style luck/variance: round_shares ÷ network_difficulty. <100% = lucky (green),
// >100% = unlucky (red). Older blocks captured before the columns existed show "—".
function luckCell(b) {
  const nd = Number(b.network_difficulty) || 0;
  const rs = Number(b.round_shares) || 0;
  if (nd <= 0 || rs <= 0) return '<td class="mono" style="color:var(--text-dim)">—</td>';
  const v = (rs / nd) * 100;
  const color = v <= 100 ? '#3fb950' : '#f85149';
  return `<td class="mono" style="color:${color}" title="round shares ÷ network difficulty">${v.toFixed(0)}%</td>`;
}

// Every status lib/blocks.js and lib/rewards.js can write. 'paid' is the TERMINAL success
// state — rewards.js flips confirmed→paid ~30 s after maturity — so on a pool that has been
// running a while it is the status of almost every block. It was missing here, so those rows
// fell through to ['badge-dim', <raw status>]: the grey the panel uses for dead rows, on the
// blocks that actually paid. Audit §J14; same class as §J5-4, which fixed the counters only.
const STATUS = {
  immature:  ['badge-warn',  'Maturing'],
  confirmed: ['badge-ok',    'Confirmed'],
  paid:      ['badge-ok',    'Paid out'],
  orphaned:  ['badge-error', 'Orphaned'],
};

// Search + 20-per-page paging + the retention line, from AdminTable (admin-shell.js).
// Blocks are never pruned by the retention job — the note says so rather than leaving
// the operator to guess how far back this table goes.
const blocksTable = AdminTable.create({
  tbody: 'blocks-tbody',
  search: 'Filter by height, miner or status…',
  empty: 'No blocks in this view.',
  note: 'Block history is kept permanently — no retention window.',
  text: b => [b.height, b.status, (STATUS[b.status] || [])[1], b.found_by, b.reward,
              fmtTs(b.found_at)].join(' '),
  row: b => {
    const [cls, label] = STATUS[b.status] || ['badge-dim', b.status];
    // 'paid' belongs with confirmed/orphaned: maturity is behind it, so the countdown cell is
    // meaningless. Without it a fully-distributed block rendered its maturity as "ready",
    // i.e. still-waiting (audit §J14).
    const maturity = (b.status === 'confirmed' || b.status === 'paid' || b.status === 'orphaned')
      ? '—'
      : (b.blocks_to_maturity > 0 ? `${b.blocks_to_maturity.toLocaleString()} blocks left` : 'ready');
    return `<tr>
      <td class="mono">${Explorer.link('block', b.height, b.height.toLocaleString())}</td>
      <td><span class="badge ${cls}">${escHtml(label)}</span></td>
      <td>${escHtml(maturity)}</td>
      ${luckCell(b)}
      <td class="mono">${(Number(b.reward) || 0).toFixed(2)}</td>
      <td><span class="mono" title="${escHtml(b.found_by)}">${escHtml(shortAddr(b.found_by))}</span></td>
      <td>${fmtTs(b.found_at)}</td>
    </tr>`;
  }
});

// resetPage: a filter chip changed, so page 3 of the old result set means nothing.
async function loadBlocks(resetPage) {
  try {
    const q = _filter ? ('?status=' + encodeURIComponent(_filter)) : '';
    const data = await API.get('/api/admin/blocks' + q);
    const s = data.summary || {};
    document.getElementById('kpi-total').textContent     = s.total_blocks_found ?? '—';
    document.getElementById('kpi-confirmed').textContent = s.confirmed_blocks ?? '—';
    document.getElementById('kpi-immature').textContent  = s.immature_blocks ?? '—';
    document.getElementById('kpi-recent').textContent    = `${s.blocks_24h ?? 0} / ${s.blocks_7d ?? 0}`;
    document.getElementById('kpi-reward').textContent    = (Number(s.total_reward) || 0).toFixed(2);
    document.getElementById('tip-summary').innerHTML     =
      data.tip_height
        ? `chain tip ${Explorer.link('block', data.tip_height, data.tip_height.toLocaleString())}`
        : 'node unreachable';
    document.getElementById('depth-note').textContent    = data.confirm_depth || '—';

    blocksTable.setRows(data.blocks || [], { reset: resetPage });
  } catch (err) {
    blocksTable.setError(err.message);
  }
}

function setFilter(f, btn) {
  _filter = f;
  document.querySelectorAll('#filter-chips .tab-btn').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  loadBlocks(true);
}

document.addEventListener('DOMContentLoaded', () => loadBlocks());
setInterval(loadBlocks, 60000);

// ==== F5: event wiring — replaces the inline on*= attributes (strict script-src, no inline handlers).
// One delegated listener per event type; data-action names the handler. Every old handler ignored
// the Event and `this` except where noted, so the wrappers pass exactly the arguments the attribute did.
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  switch (el.dataset.action) {
    case 'set-filter': setFilter(el.dataset.filter, el); break;
  }
});
