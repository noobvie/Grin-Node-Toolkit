// games-players.html page script — moved BYTE-verbatim out of the page's inline script block (code-layout F5).
// Classic script (no defer/module) loaded at the same position as the old block, after the <script src> tags before it, whose globals it uses (H14).
// Games → Players (design §19.10, §19.11, D21; games Part 9). Every call goes through
// GamesAdmin.call (the admin proxy, adminFetch — never API.*); step-up is the pool's rule.
// Chat bodies are player text: built with GamesAdmin.el (textContent), never HTML strings.
// Match void (§19.8, games Part 10): step-up, like ban — the pool asks for the password before
// proxying. The answer carries the match, not the player, so the page re-reads the player.
API.guardAdminPage();
const G = window.GamesAdmin;
const { el } = G;

let _addr = null;
let _p = null;

function fig(label, value) {
  const d = el('div', 'gp-fig', label);
  d.appendChild(el('b', null, value));
  return d;
}
function emptyRow(tb, cols, text) {
  const tr = el('tr'); const td = el('td', 'empty-row', text); td.colSpan = cols; tr.appendChild(td); tb.appendChild(tr);
}

function render() {
  const p = _p;
  document.getElementById('gp-card').hidden = false;
  const head = document.getElementById('gp-head');
  G.clear(head);
  head.appendChild(G.addrChip(p.address));
  if (p.moderator) head.appendChild(el('span', 'badge badge-warn', 'Moderator'));
  if (p.player && p.player.banned) head.appendChild(el('span', 'badge badge-error', p.player.banned_until >= 253402300799 ? 'Banned forever' : 'Banned until ' + G.fmtUtc(p.player.banned_until)));
  if (p.player && p.player.muted) head.appendChild(el('span', 'badge badge-warn', 'Muted until ' + G.fmtUtc(p.player.muted_until)));
  if (!p.known) head.appendChild(el('span', 'badge badge-dim', 'Never seen by the games'));
  // A guest (§19.17.3): no mining, never a moderator (D32), deletable. Its login name is never
  // shown here — only its dates (§19.13 #29).
  const isGuest = p.kind === 'guest';
  if (isGuest) head.appendChild(el('span', 'badge badge-dim', p.deleted_at ? 'Deleted guest (' + G.fmtUtc(p.deleted_at) + ')' : 'Guest account'));
  if (isGuest && !p.deleted_at && p.guest) head.appendChild(G.btn('Delete guest account', 'btn-danger', deleteGuest));

  const figs = document.getElementById('gp-figs');
  G.clear(figs);
  const pl = p.player;
  figs.appendChild(fig('Plays', pl ? pl.plays : 0));
  figs.appendChild(fig('Points', pl ? pl.points : 0));
  figs.appendChild(isGuest ? fig('Signed in now', p.sessions.guest || 0) : fig('Signed in now (IP / password)', p.sessions.ip + ' / ' + p.sessions.password));
  if (isGuest && p.guest) {
    figs.appendChild(fig('Account created', G.fmtUtc(p.guest.created_at)));
    figs.appendChild(fig('Last sign-in', G.fmtUtc(p.guest.last_login_at)));
  }
  figs.appendChild(fig('First seen', pl ? G.fmtUtc(pl.first_seen) : '—'));
  figs.appendChild(fig('Last seen', pl ? G.fmtUtc(pl.last_seen) : '—'));
  figs.appendChild(fig('Badges', pl && pl.badges.length ? pl.badges.map(b => b.label).join(', ') : '—'));
  document.getElementById('gp-note').textContent = p.known ? '' : 'This address has never mined minutes the games synced, nor signed in. You can still mute, ban or appoint it.';

  document.getElementById('gp-unmute').disabled = !(pl && pl.muted);
  document.getElementById('gp-unban').disabled = !(pl && pl.banned);
  document.getElementById('gp-mod-add').disabled = isGuest || !!p.moderator || !!(pl && pl.banned);
  document.getElementById('gp-mod-remove').disabled = !p.moderator;
  document.getElementById('gp-mod-state').textContent = p.moderator
    ? 'Moderator since ' + G.fmtUtc(p.moderator.added_at) + ' (appointed by ' + p.moderator.added_by + ')' + (p.moderator.note ? ' — ' + p.moderator.note : '') + '.'
    : 'Not a moderator.';
  // Nickname (design §19.17.5) — player text, so textContent only.
  const nk = p.nickname || {};
  const parts = [];
  if (nk.live) parts.push('Shown as “' + nk.live.shown_as + '” since ' + G.fmtUtc(nk.live.decided_at) + '.');
  if (nk.blocked) parts.push('Blocked from nicknames.');
  document.getElementById('gp-nick-state').textContent = parts.length ? parts.join(' ') : 'No nickname: shown as the masked address.';

  const msgs = document.getElementById('gp-msgs');
  G.clear(msgs);
  if (!p.messages.length) emptyRow(msgs, 4, 'No messages kept.');
  p.messages.forEach(m => {
    const tr = el('tr');
    tr.appendChild(el('td', 'mono', m.id));
    tr.appendChild(el('td', 'mono', G.fmtUtc(m.created_at)));
    const b = el('td'); b.appendChild(el('div', 'gp-body', m.body)); tr.appendChild(b);    // player text: textContent only
    const st = el('td', null, m.state + (m.state === 'held' && m.hold_reason ? ' (' + m.hold_reason + ')' : '') + (m.open_reports ? ' · ' + m.open_reports + ' report(s)' : ''));
    tr.appendChild(st);
    msgs.appendChild(tr);
  });

  const mt = document.getElementById('gp-matches');
  G.clear(mt);
  if (!p.matches.length) emptyRow(mt, 7, 'No matches.');
  p.matches.forEach(m => {
    const tr = el('tr');
    tr.appendChild(el('td', 'mono', m.id));
    tr.appendChild(el('td', null, m.game_id + ' · ' + m.mode + (m.rated ? ' · rated' : '')));
    const opp = el('td');
    if (m.opponent && G.ADDR_RE.test(m.opponent)) opp.appendChild(G.addrChip(m.opponent));
    else opp.textContent = m.opponent && m.opponent.indexOf('bot:') === 0 ? 'Bot level ' + m.opponent.slice(4) : (m.opponent || 'open seat');
    tr.appendChild(opp);
    tr.appendChild(el('td', null, m.state));
    const res = m.result ? (m.result === 'draw' ? 'Draw' : (Number(m.result.slice(4)) === m.seat ? 'Won' : 'Lost')) + (m.reason ? ' · ' + m.reason : '') : '—';
    tr.appendChild(el('td', null, res));
    tr.appendChild(el('td', 'mono', G.fmtUtc(m.created_at)));
    const act = el('td');
    if (VOIDABLE.has(m.state)) act.appendChild(G.btn('Void', 'btn-outline', () => voidMatch(m)));
    tr.appendChild(act);
    mt.appendChild(tr);
  });

  const ac = document.getElementById('gp-activity');
  G.clear(ac);
  if (!p.activity.length) emptyRow(ac, 3, 'No mining minutes synced in the last 14 days.');
  p.activity.forEach(a => {
    const tr = el('tr');
    tr.appendChild(el('td', 'mono', a.day));
    tr.appendChild(el('td', 'mono', a.minutes));
    tr.appendChild(el('td', 'mono', a.plays_awarded));
    ac.appendChild(tr);
  });
}

async function lookup(address) {
  if (!G.isPlayer(address)) { G.flash('gp-msg', 'Enter a full GRIN address, or a guest id (g:…).', true); return; }
  try {
    _p = await G.call('GET', 'players/' + G.playerSeg(address));
    _addr = address;
    document.getElementById('gp-address').value = address;
    document.getElementById('gp-offline').style.display = 'none';
    history.replaceState(null, '', 'games-players.html?address=' + encodeURIComponent(address));
    render();
  } catch (err) {
    const e = document.getElementById('gp-offline');
    e.textContent = err.message;
    e.style.display = '';
  }
}
document.getElementById('gp-lookup').addEventListener('click', () => lookup(document.getElementById('gp-address').value.trim()));
document.getElementById('gp-address').addEventListener('keydown', e => { if (e.key === 'Enter') lookup(e.target.value.trim()); });

const VOIDABLE = new Set(['active', 'seek', 'challenge', 'finished']);
const VOID_TEXT = {
  active: 'The game ends with no result and every seat gets its play back.',
  seek: 'The open seek closes and its creator gets the play back.',
  challenge: 'The challenge closes and its creator gets the play back.',
  finished: 'The result stays on record, but the points it paid are taken back (never below 0), it leaves the daily results, and if it was rated every rating in the game is recomputed without it. Event rewards already paid are not clawed back.',
};
async function voidMatch(m) {
  const ok = await G.askConfirm({ title: 'Void match #' + m.id + '?', body: VOID_TEXT[m.state] + '\nPlays and points are never GRIN.',
    withReason: true, confirmText: 'Void it', danger: true });
  if (!ok) return;
  try {
    const r = await G.call('POST', 'matches/' + m.id + '/void', ok.reason ? { reason: ok.reason } : {});
    await lookup(_addr);
    const v = r.voided || {};
    G.flash('gp-msg', 'Match #' + m.id + ' voided' + (v.refunded ? '; ' + v.refunded + ' play refund(s)' : '')
      + (v.reversed && v.reversed.length ? '; points taken back: ' + v.reversed.map(x => x.points).join(' + ') : '')
      + (v.ratings ? '; ratings recomputed from ' + v.ratings.matches + ' rated game(s)' : '') + '.', false);
  } catch (err) {
    G.flash('gp-msg', err.message, true);
  }
}

// One write: confirm (optional), call, re-render from the answer (every write returns the player view).
async function write(rel, body, confirm, done) {
  if (!_addr) return;
  if (confirm) {
    const ok = await G.askConfirm(confirm);
    if (!ok) return;
    if (confirm.withReason && ok.reason) body = Object.assign({}, body, { reason: ok.reason });
  }
  try {
    const r = await G.call('POST', 'players/' + G.playerSeg(_addr) + rel, body);
    if (r.address) { _p = r; render(); } else { await lookup(_addr); }
    G.flash('gp-msg', typeof done === 'function' ? done(r) : done, false);
  } catch (err) {
    G.flash('gp-msg', err.message, true);
  }
}

document.getElementById('gp-mute').addEventListener('click', () => {
  const minutes = Number(document.getElementById('gp-mute-min').value);
  write('/mute', { minutes }, { title: 'Mute ' + G.short(_addr) + '?', body: 'They can still read and play, but cannot post or report until the mute ends.', withReason: true, confirmText: 'Mute' }, 'Muted.');
});
document.getElementById('gp-unmute').addEventListener('click', () => write('/unmute', {}, null, 'Unmuted.'));
document.getElementById('gp-ban').addEventListener('click', () => {
  const v = document.getElementById('gp-ban-days').value;
  const body = v === 'forever' ? { forever: true } : { days: Number(v) };
  write('/ban', body, { title: 'Ban ' + G.short(_addr) + (v === 'forever' ? ' forever' : ' for ' + v + ' day(s)') + '?',
    body: 'Signs the address out on every device now and blocks sign-in, games and chat. Mining and payouts are not affected. If it is a moderator, the appointment ends. A nickname is removed (an unban does not bring it back).',
    withReason: true, confirmText: 'Ban', danger: true }, r => 'Banned; ' + r.sessions_revoked + ' session(s) signed out' + (r.moderator_removed ? ', moderator appointment ended.' : '.'));
});
document.getElementById('gp-unban').addEventListener('click', () => write('/unban', {}, null, 'Unbanned.'));
document.getElementById('gp-purge').addEventListener('click', () => {
  const days = Number(document.getElementById('gp-purge-days').value);
  write('/purge', { days }, { title: 'Delete every message of ' + G.short(_addr) + ' from the last ' + days + ' day(s)?', body: 'They disappear from every open /play/ page. Each one can still be restored from Chat & moderation while it is kept.', withReason: true, confirmText: 'Delete them', danger: true },
    r => r.deleted + ' message(s) deleted.');
});
document.getElementById('gp-adjust').addEventListener('click', () => {
  const kind = document.getElementById('gp-adj-kind').value;
  const delta = Number(document.getElementById('gp-adj-delta').value);
  const note = document.getElementById('gp-adj-note').value.trim();
  if (!Number.isInteger(delta) || delta === 0) { G.flash('gp-msg', 'Enter a whole number, positive or negative, not 0.', true); return; }
  write('/adjust', note ? { kind, delta, note } : { kind, delta },
    { title: (delta > 0 ? 'Add ' : 'Remove ') + Math.abs(delta) + ' ' + kind + (delta > 0 ? ' to ' : ' from ') + G.short(_addr) + '?', body: 'Written to the games ledger as an admin adjustment. Points and plays are never GRIN.', withReason: false, confirmText: 'Apply' },
    'Adjusted.').then(() => { document.getElementById('gp-adj-delta').value = ''; document.getElementById('gp-adj-note').value = ''; });
});

async function modChange(add) {
  if (!_addr) return;
  const ok = await G.askConfirm(add
    ? { title: 'Appoint ' + G.short(_addr) + ' as a chat moderator?', body: 'They will be able to delete and approve chat messages and mute authors for up to 24 hours, from /play/. Every action is logged under their address.', withReason: false, confirmText: 'Appoint' }
    : { title: 'Remove ' + G.short(_addr) + ' as a moderator?', body: 'Their next moderator request is refused. Nothing they did is undone.', withReason: false, confirmText: 'Remove', danger: true });
  if (!ok) return;
  try {
    await G.call('POST', add ? 'moderators/' + _addr : 'moderators/' + _addr + '/remove', {});
    G.flash('gp-msg', add ? 'Appointed.' : 'Removed.', false);
  } catch (err) { G.flash('gp-msg', err.message, true); }
  lookup(_addr);
}
document.getElementById('gp-mod-add').addEventListener('click', () => modChange(true));

// Guest accounts (§19.17.3): step-up, like ban — the pool asks for the password before proxying.
async function deleteGuest() {
  if (!_addr || !G.GUEST_RE.test(_addr)) return;
  const ok = await G.askConfirm({ title: 'Delete this guest account?',
    body: 'Signs it out everywhere, removes its nickname, cancels its open seeks and frees its login name. Its old games and messages stay, shown as "deleted guest". This cannot be undone.',
    withReason: true, confirmText: 'Delete account', danger: true });
  if (!ok) return;
  try {
    await G.call('POST', 'guests/' + G.playerSeg(_addr) + '/delete', ok.reason ? { reason: ok.reason } : {});
    G.flash('gp-msg', 'Guest account deleted.', false);
  } catch (err) { G.flash('gp-msg', err.message, true); }
  lookup(_addr);
}
document.getElementById('gp-mod-remove').addEventListener('click', () => modChange(false));

// ── Lists ──────────────────────────────────────────────────────────────────────────────
document.querySelectorAll('#gp-lists .tab-btn').forEach(b => b.addEventListener('click', async () => {
  document.querySelectorAll('#gp-lists .tab-btn').forEach(x => x.classList.toggle('active', x === b));
  const f = b.dataset.filter;
  const tb = document.getElementById('gp-list');
  document.getElementById('gp-list-card').hidden = false;
  document.getElementById('gp-list-col').textContent = f === 'moderators' ? 'Appointed' : 'Until';
  G.clear(tb);
  try {
    const r = await G.call('GET', 'players?filter=' + f);
    if (!r.players.length) emptyRow(tb, 3, { muted: 'Nobody is muted.', banned: 'Nobody is banned.', moderators: 'No moderators.' }[f]);
    r.players.forEach(x => {
      const tr = el('tr');
      const a = el('td'); a.appendChild(G.addrChip(x.address)); tr.appendChild(a);
      tr.appendChild(el('td', 'mono', f === 'moderators' ? G.fmtUtc(x.added_at) : (x.until >= 253402300799 ? 'forever' : G.fmtUtc(x.until))));
      const o = el('td'); o.appendChild(G.btn('Open', 'btn-secondary', () => lookup(x.address))); tr.appendChild(o);
      tb.appendChild(tr);
    });
  } catch (err) { emptyRow(tb, 3, err.message); }
}));

document.addEventListener('DOMContentLoaded', () => {
  const q = new URLSearchParams(location.search).get('address');
  if (q && G.isPlayer(q)) lookup(q);
});
