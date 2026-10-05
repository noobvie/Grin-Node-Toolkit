/* play-chat.js — the Chat panel on /play/ (design §19.10, D9, D21; Part 9).
 *
 * Reading is public while the games are open and the pool's chat switch is on, so the panel
 * shows signed in or out (it follows play-shell.js's `play:view`, like the boards panel).
 * Posting, reporting and the moderator tools follow the caller's /me, which play-shell.js
 * announces as `play:me` (null when signed out).
 *
 * The message list, the change feed, the row markup and the refusal sentences are the shared
 * chat core (play-chat-core.js, Part C7) — the floating bubble on the pool's other pages draws
 * the same rows from the same code. What stays here is what only /play/ has: the moderator
 * tools (D21), the rules fold, and this panel's polling budget.
 *
 * Rendering rules: every node is built with createElement + textContent — there is NO
 * innerHTML here or in the core (test-shell.js fails on one); no native dialog: a report,
 * delete or mute is a two-click in-page confirm.
 *
 * Polling (§19.10 + the change feed in lib/chat.js): every 4 s while the tab is visible and
 * signed in, 15 s signed out, 30 s while hidden, 60 s while chat is closed; one request at a
 * time.
 */
(function () {
  'use strict';

  var Api = window.PlayApi;
  var Core = window.PlayChatCore;
  if (!Api || !Core) return;

  var text = Core.text, int = Core.int, utc = Core.utc, when = Core.when, duration = Core.duration;
  var armButton = Core.armButton, smallBtn = Core.smallBtn, valid = Core.valid;

  function $(id) { return document.getElementById(id); }
  function show(el, on) { if (el) el.hidden = !on; }
  function clear(el) { while (el && el.firstChild) el.removeChild(el.firstChild); }
  function msg(el, s, kind) { if (!el) return; el.textContent = s || ''; el.className = 'acct-msg' + (s ? (kind === 'ok' ? ' ok' : ' err') : ''); }

  var EL = {};
  ['play-chat', 'chat-sub', 'chat-closed', 'chat-list', 'chat-empty', 'chat-form', 'chat-input', 'chat-count',
   'chat-send', 'chat-gate', 'chat-guest-note', 'chat-msg', 'mod-fold', 'mod-count', 'mod-note', 'mod-list', 'mod-empty', 'mod-refresh',
   'mod-msg', 'rule-plays', 'rule-cost', 'rule-chat'].forEach(function (id) { EL[id] = $(id); });
  if (!EL['play-chat']) return;

  var POLL_IN = 4000, POLL_OUT = 15000, POLL_HIDDEN = 30000, POLL_CLOSED = 60000, POLL_MORE = 250;
  var BODY_MAX = Core.BODY_MAX;
  var MOD_MUTE_MIN = 60;
  var SIGNED_OUT_TEXT = 'Sign in above to post in chat.';

  var S = {
    open: false, me: null, enabled: null,
    timer: null, inflight: false, soon: false,
    rules: null,
    waitTimer: null           // fires when a chat wait (account age, proof age) runs out
  };

  function gateText(c) { return Core.gateText(c, S.rules, SIGNED_OUT_TEXT); }
  function errText(e) { return Core.errText(e, S.rules); }
  function modReasonText(r) {
    if (r === 'mod_password_required') return 'Moderator tools need a sign-in with your rig PASSWORD. Log out and sign in with the password to use them.';
    return 'Moderator tools are paused for this session: ' + gateText({ reason: r });
  }

  function canPost() { return !!(S.me && S.me.chat && S.me.chat.can_post); }
  function canModerate() { return !!(S.me && S.me.moderator && S.me.moderator.can_act); }

  // A label carries a nickname when the server composed `Nick (grin1abcd…wxyz)` (§19.17.5); a bare
  // mask has none, so there is nothing for "Remove name" to do.
  function hasNick(m) { return typeof m.name === 'string' && / \(t?grin1[^)]*\)$/.test(m.name); }

  // The buttons under one message — they depend on who is signed in, so the feed asks per row.
  function buildActions(m) {
    var box = document.createElement('span');
    box.className = 'play-chat-actions';
    // Report: another player's visible message, from a session that could post.
    if (canPost() && !m.own && !m.held && m.role !== 'operator') {
      box.appendChild(armButton(smallBtn(), 'Report', 'Confirm report', function () {
        return Api.post('chat/' + m.id + '/report', {}).then(function (r) {
          msg(EL['chat-msg'], r.duplicate ? 'You already reported that message.' : 'Reported. A moderator will look at it.', 'ok');
          if (r.held) pollSoon();
        }, function (e) { msg(EL['chat-msg'], errText(e)); });
      }));
    }
    // Moderator tools (D21): only on ordinary players' messages; the server re-checks all of it.
    if (canModerate() && !m.own && m.role === 'player') {
      box.appendChild(armButton(smallBtn(), 'Delete', 'Confirm delete', function () { return modAct(m.id, 'delete', {}); }));
      box.appendChild(armButton(smallBtn(), 'Mute 1 h', 'Confirm mute', function () { return modAct(m.id, 'mute', { minutes: MOD_MUTE_MIN }); }));
      if (hasNick(m)) box.appendChild(armButton(smallBtn(), 'Remove name', 'Confirm remove name', function () { return modAct(m.id, 'remove-name', {}); }));
    }
    return box;
  }

  var feed = Core.createFeed({ list: EL['chat-list'], actions: buildActions });

  // ── Polling ─────────────────────────────────────────────────────────────────────────
  function delay() {
    if (S.soon) { S.soon = false; return POLL_MORE; }
    if (S.enabled === false) return POLL_CLOSED;
    if (document.visibilityState === 'hidden') return POLL_HIDDEN;
    return S.me ? POLL_IN : POLL_OUT;
  }
  function stop() { if (S.timer) { clearTimeout(S.timer); S.timer = null; } }
  function schedule() { stop(); if (S.open) S.timer = setTimeout(poll, delay()); }
  function pollSoon() { S.soon = true; if (!S.inflight) schedule(); }

  function poll() {
    stop();
    if (!S.open || S.inflight) return;
    S.inflight = true;
    Api.get(feed.path()).then(apply, function (e) {
      // A blip keeps what is on screen; the page-level states (offline, closed) are the
      // shell's to show — it hears them on its own next call.
      if (e instanceof Api.Error && e.status === 404) { setEnabled(false); }
    }).then(function () { S.inflight = false; schedule(); });
  }

  function setEnabled(on) {
    S.enabled = on;
    show(EL['chat-closed'], !on);
    if (!on) { feed.reset(); show(EL['chat-empty'], false); }
    renderGate();
  }

  function apply(r) {
    if (!S.open) return;                       // the panel closed while this was in flight
    if (!r || r.enabled !== true) { setEnabled(false); return; }
    var wasEnabled = S.enabled;
    S.enabled = true;
    show(EL['chat-closed'], false);
    if (wasEnabled !== true) renderGate();
    var list = EL['chat-list'];
    var atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 48;
    var res = feed.apply(r);
    show(EL['chat-empty'], feed.size() === 0);
    if (atBottom) list.scrollTop = list.scrollHeight;
    if (res.more) S.soon = true;
  }

  document.addEventListener('visibilitychange', function () {
    if (S.open && document.visibilityState === 'visible' && !S.inflight) poll();
  });

  // ── Posting ─────────────────────────────────────────────────────────────────────────
  function updateCount() {
    var n = Core.cpLen(EL['chat-input'].value.trim());
    text(EL['chat-count'], int(n) + ' / ' + BODY_MAX);
    EL['chat-count'].classList.toggle('is-over', n > BODY_MAX);
  }
  EL['chat-input'].addEventListener('input', updateCount);

  EL['chat-form'].addEventListener('submit', function (ev) {
    ev.preventDefault();
    var body = EL['chat-input'].value.trim();
    var n = Core.cpLen(body);
    if (n === 0) return;
    if (n > BODY_MAX) { msg(EL['chat-msg'], 'A message is at most ' + BODY_MAX + ' characters.'); return; }
    EL['chat-send'].disabled = true;
    msg(EL['chat-msg'], '');
    Api.post('chat', { body: body }).then(function (r) {
      EL['chat-input'].value = '';
      updateCount();
      if (r.message) feed.upsert(r.message);
      show(EL['chat-empty'], false);
      EL['chat-list'].scrollTop = EL['chat-list'].scrollHeight;
      if (r.held) msg(EL['chat-msg'], 'Sent, and held for review: links, addresses and some words wait for a moderator before others see them.', 'ok');
    }, function (e) {
      if (e instanceof Api.Error && e.code === 'chat_off') setEnabled(false);
      msg(EL['chat-msg'], errText(e));
    }).then(function () { EL['chat-send'].disabled = false; });
  });

  function renderGate() {
    var open = S.enabled === true;
    var posting = open && canPost();
    show(EL['chat-form'], posting);
    var gate = open && !posting ? gateText(S.me ? S.me.chat : null) : '';
    text(EL['chat-gate'], gate);
    show(EL['chat-gate'], !!gate);
    // A guest's link always waits for a moderator (D26), whatever the pool's link setting.
    show(EL['chat-guest-note'], posting && S.me.kind === 'guest');
    scheduleWaitEnd();
    // Moderator tools.
    var mod = S.me && S.me.moderator;
    show(EL['mod-fold'], !!mod && open);
    if (mod) {
      text(EL['mod-note'], mod.can_act
        ? 'Held and reported messages. Approve keeps a message; Delete removes it for everyone; Mute silences its author for an hour. Everything you do is logged for the operator.'
        : modReasonText(mod.reason));
      show(EL['mod-refresh'], mod.can_act);
      if (!mod.can_act) { clear(EL['mod-list']); text(EL['mod-count'], ''); show(EL['mod-empty'], false); }
    }
  }

  // A wait with an end (a guest account's age, a new proof's age): when it runs out, ask the
  // shell for a fresh /me so the form appears without a reload. One timer; capped at 6 h —
  // the shell's own 5-minute /me refresh covers anything longer.
  function scheduleWaitEnd() {
    if (S.waitTimer) { clearTimeout(S.waitTimer); S.waitTimer = null; }
    var c = S.me && S.me.chat;
    if (!c || c.can_post || (c.reason !== 'account_too_new' && c.reason !== 'proof_too_new') || typeof c.available_at !== 'number') return;
    var ms = (c.available_at - Math.floor(Date.now() / 1000)) * 1000 + 2000;
    if (!(ms > 0) || ms > 6 * 3600 * 1000) return;
    S.waitTimer = setTimeout(function () {
      S.waitTimer = null;
      try { document.dispatchEvent(new CustomEvent('play:refresh-me')); } catch (e) { /* the 5-minute refresh catches up */ }
    }, ms);
  }

  // ── Moderator queue (D21) ───────────────────────────────────────────────────────────
  var HOLD_LABEL = { link: 'held: link or address', word: 'held: word list', reports: 'held: reported' };

  function modAct(id, action, body) {
    return Api.post('mod/messages/' + id + '/' + action, body).then(function (r) {
      var done = { delete: 'Deleted.', approve: 'Kept.', mute: 'Author muted' + (r.muted_until ? ' until ' + utc(r.muted_until, true) : '') + '.',
        'remove-name': r.changed ? 'Nickname removed: the author shows as the masked address again.' : 'That author has no nickname now.' }[action];
      msg(EL['mod-msg'], done, 'ok');
      msg(EL['chat-msg'], action === 'delete' || action === 'mute' || action === 'remove-name' ? done : '', 'ok');
      pollSoon();
      if (!EL['mod-fold'].hidden && EL['mod-fold'].open) loadQueue();
    }, function (e) {
      var b = (e && e.body) || {};
      var why = { operator_message: 'Operator messages are the operator\'s to manage.', moderator_message: 'Another moderator\'s messages are the operator\'s to manage.', own_message: 'Not on your own messages.' }[b.reason];
      var s = why || (e && e.code === 'mod_refused' ? modReasonText(b.reason) : errText(e));
      msg(EL['mod-msg'], s);
      msg(EL['chat-msg'], s);
    });
  }

  function queueRow(m, extra) {
    var li = document.createElement('li');
    li.className = 'play-mod-row';
    var head = document.createElement('div');
    head.className = 'play-chat-meta';
    var name = document.createElement('span');
    name.className = 'play-chat-name';
    text(name, m.name);
    head.appendChild(name);
    var tag = document.createElement('span');
    tag.className = 'play-chip';
    text(tag, extra.label);
    head.appendChild(tag);
    var t = document.createElement('time');
    t.className = 'play-chat-time';
    text(t, when(m.created_at));
    head.appendChild(t);
    li.appendChild(head);
    var body = document.createElement('p');
    body.className = 'play-chat-body';
    text(body, m.body);
    li.appendChild(body);
    if (extra.reasons && extra.reasons.length) {
      var rs = document.createElement('p');
      rs.className = 'play-mod-reasons';
      text(rs, 'Reports: ' + extra.reasons.join(' · '));
      li.appendChild(rs);
    }
    var acts = document.createElement('span');
    acts.className = 'play-chat-actions';
    var protectedMsg = m.role !== 'player';
    if (!protectedMsg) {
      var keep = smallBtn();
      text(keep, m.state === 'held' ? 'Approve' : 'Keep');
      keep.addEventListener('click', function () { keep.disabled = true; modAct(m.id, 'approve', {}).then(function () { keep.disabled = false; }); });
      acts.appendChild(keep);
      acts.appendChild(armButton(smallBtn(), 'Delete', 'Confirm delete', function () { return modAct(m.id, 'delete', {}); }));
      acts.appendChild(armButton(smallBtn(), 'Mute 1 h', 'Confirm mute', function () { return modAct(m.id, 'mute', { minutes: MOD_MUTE_MIN }); }));
      if (hasNick(m)) acts.appendChild(armButton(smallBtn(), 'Remove name', 'Confirm remove name', function () { return modAct(m.id, 'remove-name', {}); }));
    } else {
      var note = document.createElement('span');
      note.className = 'dim';
      text(note, 'The operator handles this one.');
      acts.appendChild(note);
    }
    li.appendChild(acts);
    return li;
  }

  function loadQueue() {
    if (!canModerate()) return;
    Api.get('mod/queue').then(function (r) {
      clear(EL['mod-list']);
      var seen = {};
      var n = 0;
      (Array.isArray(r.held) ? r.held : []).forEach(function (m) {
        if (!valid(m) || seen[m.id]) return;
        seen[m.id] = true;
        n++;
        EL['mod-list'].appendChild(queueRow(m, { label: HOLD_LABEL[m.hold_reason] || 'held' }));
      });
      (Array.isArray(r.reports) ? r.reports : []).forEach(function (g) {
        var m = g && g.message;
        if (!valid(m) || seen[m.id]) return;
        seen[m.id] = true;
        n++;
        var reasons = (Array.isArray(g.reports) ? g.reports : []).map(function (x) { return x && typeof x.reason === 'string' ? x.reason : null; }).filter(Boolean);
        EL['mod-list'].appendChild(queueRow(m, { label: 'reported ×' + int(g.count), reasons: reasons }));
      });
      text(EL['mod-count'], n ? '(' + int(n) + ')' : '');
      show(EL['mod-empty'], n === 0);
      msg(EL['mod-msg'], '');
    }, function (e) { msg(EL['mod-msg'], errText(e)); });
  }
  EL['mod-fold'].addEventListener('toggle', function () { if (EL['mod-fold'].open) loadQueue(); });
  EL['mod-refresh'].addEventListener('click', loadQueue);

  // ── The live rules (§19.15 Part 6 #10) ─────────────────────────────────────────────
  // The visible word is "tickets" (operator, C0); the API keeps `plays`.
  function loadRules() {
    if (S.rules) return;
    Api.rules().then(function (r) {
      S.rules = r;
      var p = r.plays || {}, c = r.chat || {};
      if (typeof p.minutes_per_play === 'number') {
        text(EL['rule-plays'], int(p.minutes_per_play) + ' active minutes earn 1 ticket, up to ' + int(p.daily_cap) + ' tickets a UTC day and ' + int(p.balance_cap) + ' held at once');
      }
      if (typeof p.bot_play_cost === 'number') {
        text(EL['rule-cost'], p.bot_play_cost === 0 ? 'Games against the bot are free right now — and a free game pays no points.' : 'One game against the bot costs ' + int(p.bot_play_cost) + (p.bot_play_cost === 1 ? ' ticket.' : ' tickets.'));
      }
      if (typeof c.min_minutes === 'number') {
        text(EL['rule-chat'], (c.min_minutes > 0
          ? 'Miners need ' + int(c.min_minutes) + ' minutes of mining in the last ' + int(c.recent_days) + ' days, and a sign-in proof at least '
          : 'Miners need a sign-in proof at least ')
          + duration(c.min_proof_age_s) + ' old, so someone who only just mined to their address cannot post as them.'
          + (c.requires_password ? ' Miners chat with a rig-password sign-in.' : ''));
      }
      renderGate();
      var sub = [];
      if (c.slow_seconds > 0) sub.push('slow mode ' + duration(c.slow_seconds));
      if (typeof c.retention_days === 'number') sub.push('kept ' + int(c.retention_days) + ' days');
      text(EL['chat-sub'], sub.join(' · '));
    }, function () { /* the defaults stay in the page */ });
  }

  // ── Page state (from play-shell.js) ─────────────────────────────────────────────────
  function onView(view) {
    var open = view === 'login' || view === 'in';
    if (open === S.open) return;
    S.open = open;
    show(EL['play-chat'], open);
    if (open) { loadRules(); poll(); } else { stop(); feed.reset(); S.enabled = null; }
  }
  document.addEventListener('play:view', function (e) {
    if (e && e.detail && typeof e.detail.view === 'string') onView(e.detail.view);
  });
  document.addEventListener('play:me', function (e) {
    var me = e && e.detail ? e.detail.me : null;
    var signChange = !!me !== !!S.me || (me && S.me && me.address !== S.me.address);
    S.me = me && typeof me === 'object' ? me : null;
    renderGate();
    feed.redraw();
    // Signing in or out changes what the page holds (the caller's own held messages).
    if (signChange && S.open) { feed.reset(); poll(); }
    if (S.me && S.me.moderator && S.me.moderator.can_act && EL['mod-fold'].open) loadQueue();
  });
  if (document.body && document.body.getAttribute('data-play-view')) onView(document.body.getAttribute('data-play-view'));
})();
