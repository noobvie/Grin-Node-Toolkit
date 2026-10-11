// games-names.html page script — moved BYTE-verbatim out of the page's inline script block (code-layout F5).
// Classic script (no defer/module) loaded at the same position as the old block, after the <script src> tags before it, whose globals it uses (H14).
// Games → Nicknames (design §19.17.5; games Part C3, which replaced Part 12's review queue).
// Every call goes through GamesAdmin.call (the admin proxy, adminFetch — never API.*); every
// write is step-up (none is in the pool's FAST_WRITES). A nickname, a banned name and a reason
// are PLAYER/ADMIN TEXT: every row here is built with GamesAdmin.el (textContent), never as an
// HTML string.
API.guardAdminPage();
const G = window.GamesAdmin;
const { el } = G;

let _tab = 'live';
let _q = '';

const LIST_TEXT = {
  reserved: 'a reserved word', pool_name: 'the pool\'s name', prefix: 'the "guest" prefix', seed: 'the built-in list',
  operator: 'your blocked words', chat: 'the chat word list', banned: 'a banned name',
};
const HEADS = {
  live: ['Nickname', 'Address', 'Live since (UTC)', 'Rule check', 'Actions'],
  removed: ['Nickname', 'Address', 'Removed (UTC)', 'Reason', 'Actions'],
  banned: ['Banned name', 'Matching form', 'Banned (UTC)', 'Reason', 'Actions'],
  blocked: ['Address', '', 'Last name change (UTC)', '', 'Actions'],
};

function head() {
  const tr = document.getElementById('gn-head');
  G.clear(tr);
  HEADS[_tab].forEach(h => tr.appendChild(el('th', null, h)));
  document.getElementById('gn-search-form').style.display = _tab === 'live' || _tab === 'removed' ? '' : 'none';
  document.getElementById('gn-ban-form').style.display = _tab === 'banned' ? '' : 'none';
  document.getElementById('gn-block-form').style.display = _tab === 'blocked' ? '' : 'none';
}

function empty(tb, text) {
  const tr = el('tr');
  const td = el('td', 'empty-row', text);
  td.colSpan = 5;
  tr.appendChild(td);
  tb.appendChild(tr);
}

function counts(c) {
  if (!c) return;
  ['live', 'removed', 'banned', 'blocked'].forEach(k => {
    document.getElementById('gn-count-' + k).textContent = typeof c[k] === 'number' ? '(' + c[k] + ')' : '';
  });
}

function whenCell(t, by) {
  const td = el('td', 'mono', G.fmtUtc(t));
  if (by) {
    const sub = el('div', 'gn-sub');
    sub.appendChild(document.createTextNode('by '));
    sub.appendChild(by === 'self' ? el('span', null, 'the player') : by === 'system' ? el('span', null, 'the v2 rule migration') : G.actorNode(by));
    td.appendChild(sub);
  }
  return td;
}

function nickRow(n) {
  const tr = el('tr');
  const name = el('td');
  name.appendChild(el('div', 'gn-name', n.name));                 // player text: textContent only
  name.appendChild(el('div', 'gn-sub', 'shows as ' + n.shown_as));
  tr.appendChild(name);
  const who = el('td');
  who.appendChild(G.addrChip(n.address));
  tr.appendChild(who);
  tr.appendChild(whenCell(n.decided_at, n.state === 'approved' ? null : n.decided_by));
  const info = el('td');
  if (n.state === 'approved') {
    if (n.hit) info.appendChild(el('span', 'badge badge-warn', 'Now refused by ' + (LIST_TEXT[n.hit.list] || n.hit.list) + (n.hit.entry ? ': ' + n.hit.entry : '')));
    else info.appendChild(el('span', 'gn-sub', 'passes'));
  } else if (n.reason) {
    info.appendChild(el('span', null, '“' + n.reason + '”'));
  } else {
    info.appendChild(el('span', 'gn-sub', '—'));
  }
  tr.appendChild(info);
  const td = el('td');
  const box = el('div', 'row-actions');
  if (n.state === 'approved') box.appendChild(G.btn('Remove', 'btn-danger', () => removeName(n)));
  box.appendChild(G.btn('Ban name', 'btn-outline', () => banName(n.name, n.state === 'approved' ? n : null)));
  if (n.state === 'approved') box.appendChild(G.btn('Block player', 'btn-outline', () => block(n.address)));
  box.appendChild(G.playerLink(n.address));
  td.appendChild(box);
  tr.appendChild(td);
  return tr;
}

function bannedRow(b) {
  const tr = el('tr');
  tr.appendChild(el('td', 'gn-name', b.name));
  tr.appendChild(el('td', 'mono', b.norm));
  tr.appendChild(whenCell(b.banned_at, b.banned_by));
  tr.appendChild(b.reason ? el('td', null, '“' + b.reason + '”') : el('td', 'gn-sub', '—'));
  const td = el('td');
  td.appendChild(G.btn('Unban', 'btn-secondary', () => unban(b)));
  tr.appendChild(td);
  return tr;
}

function blockedRow(b) {
  const tr = el('tr');
  const who = el('td');
  who.appendChild(G.addrChip(b.address));
  tr.appendChild(who);
  tr.appendChild(el('td'));
  tr.appendChild(el('td', 'mono', G.fmtUtc(b.changed_at)));
  tr.appendChild(el('td'));
  const td = el('td');
  const box = el('div', 'row-actions');
  box.appendChild(G.btn('Unblock', 'btn-secondary', () => unblock(b.address)));
  box.appendChild(G.playerLink(b.address));
  td.appendChild(box);
  tr.appendChild(td);
  return tr;
}

async function load() {
  const tb = document.getElementById('gn-tbody');
  head();
  try {
    let r;
    G.clear(tb);
    if (_tab === 'banned') {
      r = await G.call('GET', 'banned-names');
      G.clear(tb);
      if (!r.banned.length) empty(tb, 'No banned names.');
      r.banned.forEach(b => tb.appendChild(bannedRow(b)));
    } else if (_tab === 'blocked') {
      r = await G.call('GET', 'nick-blocked');
      G.clear(tb);
      if (!r.blocked.length) empty(tb, 'Nobody is blocked from nicknames.');
      r.blocked.forEach(b => tb.appendChild(blockedRow(b)));
    } else {
      r = await G.call('GET', 'nicknames?state=' + _tab + (_q ? '&q=' + encodeURIComponent(_q) : ''));
      G.clear(tb);
      document.getElementById('gn-off').style.display = r.enabled ? 'none' : '';
      if (!r.nicknames.length) empty(tb, _q ? 'Nothing matches “' + _q + '”.' : (_tab === 'live' ? 'No live nicknames.' : 'Nothing removed.'));
      r.nicknames.forEach(n => tb.appendChild(nickRow(n)));
    }
    counts(r.counts);
    document.getElementById('gn-offline').style.display = 'none';
  } catch (e) {
    G.clear(tb);
    const off = document.getElementById('gn-offline');
    off.textContent = e.message;
    off.style.display = '';
  }
}

async function write(rel, body, done) {
  try {
    const r = await G.call('POST', rel, body);
    G.flash('gn-msg', typeof done === 'function' ? done(r) : done);
  } catch (e) {
    G.flash('gn-msg', e.message, true);
  }
  await load();
}

async function removeName(n) {
  const ok = await G.askConfirm({ title: 'Remove “' + n.name + '”?', withReason: true, confirmText: 'Remove', danger: true,
    body: 'Every page shows ' + G.short(n.address) + ' as the masked address again. The player sees your reason and can choose another name once their change cooldown is over.' });
  if (!ok) return;
  await write('nicknames/' + n.id + '/remove', ok.reason ? { reason: ok.reason } : {}, 'Removed.');
}

async function banName(name, holder) {
  const ok = await G.askConfirm({ title: 'Ban the name “' + name + '”?', withReason: true, confirmText: 'Ban name', danger: true,
    body: 'Nobody can take it again, in any spelling that reads the same.' + (holder ? '\n' + G.short(holder.address) + ' loses it now and sees your reason.' : '') });
  if (!ok) return;
  await write('banned-names', ok.reason ? { name, reason: ok.reason } : { name },
    r => (r.changed ? 'Banned.' : 'Already banned.') + (r.removed ? ' Removed from ' + G.short(r.removed.address) + '.' : ''));
}

async function unban(b) {
  const ok = await G.askConfirm({ title: 'Unban “' + b.name + '”?', withReason: false, confirmText: 'Unban',
    body: 'Anyone may take it again. Nothing is given back to whoever held it.' });
  if (!ok) return;
  await write('banned-names/' + encodeURIComponent(b.norm) + '/unban', {}, 'Unbanned.');
}

async function block(address) {
  const ok = await G.askConfirm({ title: 'Block ' + G.short(address) + ' from nicknames?', withReason: true, confirmText: 'Block player', danger: true,
    body: 'Their live name (if any) is removed and they cannot set another until you unblock them. Chat and games are not affected.' });
  if (!ok) return;
  await write('players/' + G.playerSeg(address) + '/nick-block', ok.reason ? { reason: ok.reason } : {}, r => r.removed ? 'Blocked; their name was removed.' : 'Blocked.');
}

async function unblock(address) {
  const ok = await G.askConfirm({ title: 'Unblock ' + G.short(address) + '?', withReason: false, confirmText: 'Unblock',
    body: 'They can set a nickname again. A removed name is not given back.' });
  if (!ok) return;
  await write('players/' + G.playerSeg(address) + '/nick-unblock', {}, 'Unblocked.');
}

document.querySelectorAll('#gn-tabs .tab-btn').forEach(b => b.addEventListener('click', () => {
  document.querySelectorAll('#gn-tabs .tab-btn').forEach(x => x.classList.toggle('active', x === b));
  _tab = b.getAttribute('data-tab');
  load();
}));
document.getElementById('gn-search-form').addEventListener('submit', e => {
  e.preventDefault();
  _q = document.getElementById('gn-q').value.trim();
  load();
});
document.getElementById('gn-ban-form').addEventListener('submit', e => {
  e.preventDefault();
  const v = document.getElementById('gn-ban-name').value.trim();
  if (v) banName(v, null).then(() => { document.getElementById('gn-ban-name').value = ''; });
});
document.getElementById('gn-block-form').addEventListener('submit', e => {
  e.preventDefault();
  const v = document.getElementById('gn-block-addr').value.trim();
  if (!G.isPlayer(v)) { G.flash('gn-msg', 'That is not a GRIN address or a guest id (g:…).', true); return; }
  block(v).then(() => { document.getElementById('gn-block-addr').value = ''; });
});
document.getElementById('gn-refresh').addEventListener('click', load);
load();
