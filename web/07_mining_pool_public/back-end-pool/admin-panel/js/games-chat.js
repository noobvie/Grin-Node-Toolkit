// games-chat.html page script — moved BYTE-verbatim out of the page's inline script block (code-layout F5).
// Classic script (no defer/module) loaded at the same position as the old block, after the <script src> tags before it, whose globals it uses (H14).
// Games → Chat & moderation (design §19.10, §19.11, D21; games Part 9). Every call goes
// through GamesAdmin.call (the admin proxy, adminFetch — never API.*). Chat bodies, report
// reasons and moderator-written reasons are PLAYER TEXT: every row here is built with
// GamesAdmin.el (textContent), never as an HTML string.
API.guardAdminPage();
const G = window.GamesAdmin;
const { el } = G;

let _tab = 'held';
let _rows = [];            // the messages on screen (for "Older")
let _before = null;

const STATE_BADGE = { visible: ['badge-ok', 'Visible'], held: ['badge-warn', 'Held'], deleted: ['badge-error', 'Deleted'] };
const HOLD_TEXT = { link: 'a link or an address', word: 'the word list', reports: 'reports from players' };

function authorCell(m) {
  const td = el('td');
  if (m.role === 'operator') {
    td.appendChild(el('span', 'badge badge-ok', 'Operator'));
    if (m.admin_user) td.appendChild(el('div', 'gc-sub', 'by ' + m.admin_user));
    return td;
  }
  td.appendChild(G.addrChip(m.address));
  if (m.moderator) { td.appendChild(document.createTextNode(' ')); td.appendChild(el('span', 'badge badge-warn', 'Mod')); }
  const sub = el('div', 'gc-sub');
  sub.appendChild(G.playerLink(m.address));
  td.appendChild(sub);
  return td;
}

function stateCell(m) {
  const td = el('td');
  const [cls, label] = STATE_BADGE[m.state] || ['badge-dim', m.state];
  td.appendChild(el('span', 'badge ' + cls, label));
  if (m.state === 'held' && m.hold_reason) td.appendChild(el('div', 'gc-sub', 'by ' + (HOLD_TEXT[m.hold_reason] || m.hold_reason)));
  if (m.state === 'deleted') {
    const sub = el('div', 'gc-sub');
    sub.appendChild(document.createTextNode('by '));
    sub.appendChild(G.actorNode(m.deleted_by || '?'));
    td.appendChild(sub);
    if (m.reason) td.appendChild(el('div', 'gc-sub', '“' + m.reason + '”'));
  }
  if (m.open_reports > 0) td.appendChild(el('div', 'gc-sub', m.open_reports + ' open report' + (m.open_reports === 1 ? '' : 's')));
  return td;
}

function actionsCell(m) {
  const td = el('td');
  const box = el('div', 'row-actions');
  if (m.state === 'held') box.appendChild(G.btn('Approve', 'btn-secondary', () => act(m, 'approve')));
  else if (m.state === 'visible' && m.open_reports > 0) box.appendChild(G.btn('Keep', 'btn-secondary', () => act(m, 'approve')));
  if (m.state !== 'deleted') box.appendChild(G.btn('Delete', 'btn-danger', () => act(m, 'delete')));
  if (m.state === 'deleted') box.appendChild(G.btn('Restore', 'btn-secondary', () => act(m, 'restore')));
  if (m.role === 'player' && m.address) {
    box.appendChild(G.btn('Mute 1 h', 'btn-outline', () => mute(m.address, 60)));
    box.appendChild(G.btn('Mute 24 h', 'btn-outline', () => mute(m.address, 1440)));
  }
  td.appendChild(box);
  return td;
}

function messageRow(m, reports) {
  const tr = el('tr');
  tr.appendChild(el('td', 'mono', m.id));
  tr.appendChild(el('td', 'mono', G.fmtUtc(m.created_at)));
  tr.appendChild(authorCell(m));
  const body = el('td');
  body.appendChild(el('div', 'gc-body', m.body));          // player text: textContent only
  if (reports && reports.length) {
    const ul = el('ul', 'gc-reports');
    reports.forEach(r => {
      const li = el('li');
      li.appendChild(G.addrChip(r.reporter));
      li.appendChild(document.createTextNode(' · ' + G.fmtUtc(r.created_at) + (r.reason ? ' — ' : '')));
      if (r.reason) li.appendChild(el('span', null, '“' + r.reason + '”'));
      ul.appendChild(li);
    });
    body.appendChild(ul);
  }
  tr.appendChild(body);
  tr.appendChild(stateCell(m));
  tr.appendChild(actionsCell(m));
  return tr;
}

function setTbody(rows, empty) {
  const tb = document.getElementById('gc-tbody');
  G.clear(tb);
  if (!rows.length) {
    const tr = el('tr');
    const td = el('td', 'empty-row', empty);
    td.colSpan = 6;
    tr.appendChild(td);
    tb.appendChild(tr);
    return;
  }
  rows.forEach(r => tb.appendChild(r));
}

async function loadMessages(older) {
  const tb = document.getElementById('gc-tbody');
  try {
    if (_tab === 'reports') {
      const r = await G.call('GET', 'chat/reports');
      setTbody(r.reports.map(g => messageRow(g.message, g.reports)), 'No open reports.');
      document.getElementById('gc-older').hidden = true;
    } else {
      if (!older) { _rows = []; _before = null; }
      let rel = 'chat/messages?limit=100' + (_tab === 'all' ? '' : '&state=' + _tab);
      if (older && _before) rel += '&before=' + _before;
      const r = await G.call('GET', rel);
      _rows = older ? _rows.concat(r.messages) : r.messages;
      if (_rows.length) _before = Math.min.apply(null, _rows.map(m => m.id));
      setTbody(_rows.map(m => messageRow(m)), { held: 'Nothing is waiting for review.', visible: 'No messages.', deleted: 'Nothing deleted.', all: 'No messages yet.' }[_tab]);
      document.getElementById('gc-older').hidden = r.messages.length < 100;
    }
    document.getElementById('gc-offline').style.display = 'none';
  } catch (err) {
    G.clear(tb);
    const tr = el('tr');
    const td = el('td', 'error-row', err.message);
    td.colSpan = 6;
    tr.appendChild(td);
    tb.appendChild(tr);
  }
}

async function act(m, action) {
  let body = {};
  if (action === 'delete') {
    const ok = await G.askConfirm({ title: 'Delete message #' + m.id + '?', body: 'It disappears from every open /play/ page within seconds. You can restore it later (with your password) while it is still kept.',
      withReason: true, confirmText: 'Delete', danger: true });
    if (!ok) return;
    if (ok.reason) body = { reason: ok.reason };
  }
  const rel = action === 'approve' ? 'chat/held/' + m.id + '/approve' : 'chat/messages/' + m.id + '/' + action;
  try {
    const r = await G.call('POST', rel, body);
    G.flash('gc-list-msg', r.changed ? { approve: 'Kept — it is visible and its reports are closed.', delete: 'Deleted.', restore: 'Restored.' }[action] : 'Nothing to change.', false);
  } catch (err) {
    G.flash('gc-list-msg', err.message, true);
  }
  loadMessages();
  loadLog();
}

async function mute(address, minutes) {
  const ok = await G.askConfirm({ title: 'Mute ' + G.short(address) + ' for ' + (minutes >= 60 ? minutes / 60 + ' h' : minutes + ' min') + '?',
    body: 'They can still read and play, but cannot post or report until then. Their existing messages stay.\nFor longer mutes and bans, open the player.',
    withReason: true, confirmText: 'Mute' });
  if (!ok) return;
  try {
    await G.call('POST', 'players/' + G.playerSeg(address) + '/mute', ok.reason ? { minutes, reason: ok.reason } : { minutes });
    G.flash('gc-list-msg', 'Muted until ' + G.fmtUtc(Math.floor(Date.now() / 1000) + minutes * 60) + '.', false);
  } catch (err) {
    G.flash('gc-list-msg', err.message, true);
  }
  loadLog();
}

document.querySelectorAll('#gc-tabs .tab-btn').forEach(b => b.addEventListener('click', () => {
  _tab = b.dataset.tab;
  document.querySelectorAll('#gc-tabs .tab-btn').forEach(x => x.classList.toggle('active', x === b));
  loadMessages();
}));
document.getElementById('gc-older').addEventListener('click', () => loadMessages(true));
document.getElementById('gc-refresh').addEventListener('click', () => loadMessages());

// ── Operator post ──────────────────────────────────────────────────────────────────────
const postBox = document.getElementById('gc-post-body');
const cpLen = s => Array.from(s).length;
postBox.addEventListener('input', () => { document.getElementById('gc-post-count').textContent = cpLen(postBox.value.trim()) + ' / 280'; });
document.getElementById('gc-post').addEventListener('click', async () => {
  const body = postBox.value.trim();
  if (!body) return;
  try {
    await G.call('POST', 'chat/post', { body });
    postBox.value = '';
    document.getElementById('gc-post-count').textContent = '0 / 280';
    G.flash('gc-post-msg', 'Posted.', false);
    if (_tab === 'visible' || _tab === 'all') loadMessages();
    loadLog();
  } catch (err) {
    G.flash('gc-post-msg', err.message, true);
  }
});

// ── Moderators ─────────────────────────────────────────────────────────────────────────
async function loadMods() {
  const tb = document.getElementById('gc-mods');
  try {
    const r = await G.call('GET', 'moderators');
    G.clear(tb);
    if (!r.moderators.length) {
      const tr = el('tr'); const td = el('td', 'empty-row', 'No moderators. Only you moderate the chat.'); td.colSpan = 4; tr.appendChild(td); tb.appendChild(tr);
      return;
    }
    r.moderators.forEach(m => {
      const tr = el('tr');
      const a = el('td'); a.appendChild(G.addrChip(m.address)); const sub = el('div', 'gc-sub'); sub.appendChild(G.playerLink(m.address)); a.appendChild(sub);
      tr.appendChild(a);
      tr.appendChild(el('td', null, m.note || '—'));
      tr.appendChild(el('td', 'mono', G.fmtUtc(m.added_at) + ' · ' + m.added_by));
      const x = el('td');
      x.appendChild(G.btn('Remove', 'btn-danger', () => removeMod(m.address)));
      tr.appendChild(x);
      tb.appendChild(tr);
    });
  } catch (err) {
    G.flash('gc-mod-msg', err.message, true);
  }
}
async function removeMod(address) {
  const ok = await G.askConfirm({ title: 'Remove moderator ' + G.short(address) + '?', body: 'Their next request as a moderator is refused. Their messages lose the "Mod" badge. Nothing they did is undone.', withReason: false, confirmText: 'Remove', danger: true });
  if (!ok) return;
  try {
    await G.call('POST', 'moderators/' + address + '/remove', {});
    G.flash('gc-mod-msg', 'Removed.', false);
  } catch (err) { G.flash('gc-mod-msg', err.message, true); }
  loadMods(); loadLog();
}
document.getElementById('gc-mod-add').addEventListener('click', async () => {
  const address = document.getElementById('gc-mod-addr').value.trim();
  const note = document.getElementById('gc-mod-note').value.trim();
  if (!G.ADDR_RE.test(address)) { G.flash('gc-mod-msg', 'Enter the full GRIN address the moderator mines to.', true); return; }
  const ok = await G.askConfirm({ title: 'Appoint ' + G.short(address) + ' as a chat moderator?',
    body: 'They will be able to delete and approve chat messages and mute authors for up to 24 hours, from /play/. Every action is logged under their address, and you can remove them at any time.',
    withReason: false, confirmText: 'Appoint' });
  if (!ok) return;
  try {
    await G.call('POST', 'moderators/' + address, note ? { note } : {});
    document.getElementById('gc-mod-addr').value = '';
    document.getElementById('gc-mod-note').value = '';
    G.flash('gc-mod-msg', 'Appointed. They see the moderator queue on /play/ at their next page load.', false);
  } catch (err) { G.flash('gc-mod-msg', err.message, true); }
  loadMods(); loadLog();
});

// ── Word list ──────────────────────────────────────────────────────────────────────────
function renderWords(words) {
  const box = document.getElementById('gc-words');
  G.clear(box);
  if (!words.length) { box.appendChild(el('span', 'helper-text', 'Empty.')); return; }
  words.forEach(w => {
    const chip = el('span', 'gc-word', w.word);
    const x = el('button', null, '×');
    x.type = 'button';
    x.title = 'Remove "' + w.word + '"';
    x.setAttribute('aria-label', 'Remove ' + w.word);
    x.addEventListener('click', () => editWords({ remove: [w.word] }, 'Removed.'));
    chip.appendChild(x);
    box.appendChild(chip);
  });
}
async function loadWords() {
  try { renderWords((await G.call('GET', 'chat/words')).words); } catch (err) { G.flash('gc-word-msg', err.message, true); }
}
async function editWords(body, done) {
  try {
    const r = await G.call('POST', 'chat/words', body);
    renderWords(r.words);
    G.flash('gc-word-msg', done, false);
    loadLog();
  } catch (err) { G.flash('gc-word-msg', err.message, true); }
}
document.getElementById('gc-word-save').addEventListener('click', () => {
  const words = document.getElementById('gc-word-add').value.split(/[,\n]/).map(s => s.trim()).filter(Boolean);
  if (!words.length) return;
  editWords({ add: words }, 'Added.').then(() => { document.getElementById('gc-word-add').value = ''; });
});

// ── Moderation log ─────────────────────────────────────────────────────────────────────
let _logBefore = null;
function targetNode(t) {
  if (typeof t === 'string' && G.ADDR_RE.test(t)) return G.addrChip(t);
  return el('span', 'mono', t || '—');
}
async function loadLog(older) {
  const tb = document.getElementById('gc-log');
  try {
    const r = await G.call('GET', 'mod-log?limit=50' + (older && _logBefore ? '&before=' + _logBefore : ''));
    if (!older) G.clear(tb);
    r.actions.forEach(a => {
      const tr = el('tr');
      tr.appendChild(el('td', 'mono', G.fmtUtc(a.created_at)));
      const by = el('td'); by.appendChild(G.actorNode(a.actor)); tr.appendChild(by);
      tr.appendChild(el('td', null, a.action.replace(/_/g, ' ')));
      const tg = el('td'); tg.appendChild(targetNode(a.target)); tr.appendChild(tg);
      tr.appendChild(el('td', 'gc-details', a.details ? JSON.stringify(a.details) : ''));   // may hold a moderator's reason: text only
      tb.appendChild(tr);
    });
    if (r.actions.length) _logBefore = r.actions[r.actions.length - 1].id;
    document.getElementById('gc-log-older').hidden = r.actions.length < 50;
  } catch (err) {
    if (!older) { G.clear(tb); const tr = el('tr'); const td = el('td', 'error-row', err.message); td.colSpan = 5; tr.appendChild(td); tb.appendChild(tr); }
  }
}
document.getElementById('gc-log-older').addEventListener('click', () => loadLog(true));

// ── Boot ───────────────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  loadMessages(); loadMods(); loadWords(); loadLog();
});
// The queue refreshes itself while the page is visible and no dialog is open.
setInterval(() => {
  if (!document.hidden && !document.getElementById('confirm-dialog').classList.contains('open') && (_tab === 'held' || _tab === 'reports')) loadMessages();
}, 20000);
