/* play-chat.js — the Chat panel on /play/ (design §19.10, D9, D21; Part 9).
 *
 * Reading is public while the games are open and the pool's chat switch is on, so the panel
 * shows signed in or out (it follows play-shell.js's `play:view`, like the boards panel).
 * Posting, reporting and the moderator tools follow the caller's /me, which play-shell.js
 * announces as `play:me` (null when signed out).
 *
 * Rendering rules — the reason this file exists in this shape:
 *   - every message is built with createElement + textContent. There is NO innerHTML here
 *     (test-shell.js fails on one), so a body is only ever text: `<img onerror=…>` shows as
 *     those characters, and a link is inert text, never an <a>;
 *   - the only badges are "Operator" and "Mod", and they come from the server's `role`,
 *     which no player can set. A name is a masked address, and a mask can be ground (§19.13
 *     #10), so the panel says the badge is the only proof;
 *   - no native dialog: a report, delete or mute is a two-click in-page confirm.
 *
 * Polling (§19.10 + the change feed in lib/chat.js): every 4 s while the tab is visible and
 * signed in, 15 s signed out, 30 s while hidden, 60 s while chat is closed; one request at a
 * time. A poll sends the newest id it has plus the change revision; the answer carries new
 * messages AND the ids that were deleted, held or approved since, so a message the operator
 * removes disappears from every open page. `reset` (the service restarted) redraws.
 */
(function () {
  'use strict';

  var Api = window.PlayApi;
  if (!Api) return;

  function $(id) { return document.getElementById(id); }
  function text(el, s) { if (el) el.textContent = s == null ? '' : String(s); }
  function show(el, on) { if (el) el.hidden = !on; }
  function clear(el) { while (el && el.firstChild) el.removeChild(el.firstChild); }
  function msg(el, s, kind) { if (!el) return; el.textContent = s || ''; el.className = 'acct-msg' + (s ? (kind === 'ok' ? ' ok' : ' err') : ''); }
  function int(n) { return typeof n === 'number' && isFinite(n) ? String(Math.trunc(n)) : '—'; }
  function pad(n) { return n < 10 ? '0' + n : String(n); }
  function isId(n) { return typeof n === 'number' && isFinite(n) && n > 0 && Math.floor(n) === n; }
  function cpLen(s) { var n = 0; for (var _ of s) n++; return n; }   // code points, as the server counts
  function utc(s, withDate) {
    var d = new Date(s * 1000);
    var hm = pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes());
    return withDate ? d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()) + ' ' + hm + ' UTC' : hm;
  }
  function when(s) {
    if (typeof s !== 'number' || !isFinite(s)) return '';
    var today = new Date().toISOString().slice(0, 10);
    var day = new Date(s * 1000).toISOString().slice(0, 10);
    return day === today ? utc(s, false) : day.slice(5) + ' ' + utc(s, false);
  }
  function duration(sec) {
    if (!(sec > 0)) return '';
    if (sec < 90) return int(sec) + ' s';
    if (sec < 5400) return int(Math.round(sec / 60)) + ' min';
    if (sec < 172800) return int(Math.round(sec / 3600)) + ' h';
    return int(Math.round(sec / 86400)) + ' days';
  }

  var EL = {};
  ['play-chat', 'chat-sub', 'chat-closed', 'chat-list', 'chat-empty', 'chat-form', 'chat-input', 'chat-count',
   'chat-send', 'chat-gate', 'chat-msg', 'mod-fold', 'mod-count', 'mod-note', 'mod-list', 'mod-empty', 'mod-refresh',
   'mod-msg', 'rule-plays', 'rule-cost', 'rule-chat'].forEach(function (id) { EL[id] = $(id); });
  if (!EL['play-chat']) return;

  var POLL_IN = 4000, POLL_OUT = 15000, POLL_HIDDEN = 30000, POLL_CLOSED = 60000, POLL_MORE = 250;
  var KEEP = 200;             // messages kept on the page
  var BODY_MAX = 280;
  var CONFIRM_MS = 5000;
  var MOD_MUTE_MIN = 60;

  var S = {
    open: false, me: null, enabled: null,
    epoch: null, rev: null, after: null,
    rows: {},                 // id → { li, m }
    timer: null, inflight: false, soon: false,
    rules: null
  };

  // ── Gate text (the reasons lib/auth.js chatStatus / modStatus give) ─────────────────
  function gateText(c) {
    if (!c) return 'Sign in above to post in chat.';
    switch (c.reason) {
      case 'chat_off': return 'Chat is closed right now.';
      case 'muted': return 'You are muted' + (c.available_at ? ' until ' + utc(c.available_at, true) : '') + '.';
      case 'anchor_proof': return 'This sign-in used a proof the pool keeps only as a last resort, so it cannot be used for chat. Log out and sign in again with a current mining IP or your rig password.';
      case 'password_required': return 'Chat needs a sign-in with your rig PASSWORD, not an IP. Log out and sign in with the password.';
      case 'no_recent_mining':
        return c.mining
          ? 'Chat is for the pool\'s active miners: it needs ' + int(c.mining.need_minutes) + ' minutes of mining in the last ' + int(c.mining.days) + ' days, and this address has ' + int(c.mining.have_minutes) + '.'
          : 'Chat is for the pool\'s active miners: this address has not mined enough recently.';
      case 'proof_too_new':
        return 'You can post from ' + (c.available_at ? utc(c.available_at, true) : 'later') + '. A new proof has to age first, so someone who only just mined to your address cannot post as you.';
      default: return 'You cannot post in chat right now.';
    }
  }
  function modReasonText(r) {
    if (r === 'mod_password_required') return 'Moderator tools need a sign-in with your rig PASSWORD. Log out and sign in with the password to use them.';
    return 'Moderator tools are paused for this session: ' + gateText({ reason: r });
  }

  function canPost() { return !!(S.me && S.me.chat && S.me.chat.can_post); }
  function canModerate() { return !!(S.me && S.me.moderator && S.me.moderator.can_act); }

  // ── Two-click confirm (no native dialogs) ───────────────────────────────────────────
  function armButton(btn, label, confirmLabel, action) {
    var armed = false, timer = null;
    function disarm() { armed = false; btn.textContent = label; btn.classList.remove('play-armed'); if (timer) { clearTimeout(timer); timer = null; } }
    btn.textContent = label;
    btn.addEventListener('click', function () {
      if (!armed) { armed = true; btn.textContent = confirmLabel; btn.classList.add('play-armed'); timer = setTimeout(disarm, CONFIRM_MS); return; }
      disarm();
      btn.disabled = true;
      action().then(function () { btn.disabled = false; }, function () { btn.disabled = false; });
    });
    return btn;
  }
  function smallBtn() { var b = document.createElement('button'); b.type = 'button'; b.className = 'btn sm play-chat-act'; return b; }

  // ── One message row ─────────────────────────────────────────────────────────────────
  function valid(m) {
    return m && isId(m.id) && typeof m.body === 'string' && typeof m.name === 'string'
      && (m.role === 'player' || m.role === 'moderator' || m.role === 'operator');
  }

  function buildRow(m) {
    var li = document.createElement('li');
    li.className = 'play-chat-row' + (m.role === 'operator' ? ' is-operator' : '') + (m.role === 'moderator' ? ' is-mod' : '')
      + (m.own ? ' is-own' : '') + (m.held ? ' is-held' : '');
    li.setAttribute('data-id', String(m.id));
    var meta = document.createElement('div');
    meta.className = 'play-chat-meta';
    var name = document.createElement('span');
    name.className = 'play-chat-name';
    text(name, m.name);
    meta.appendChild(name);
    if (m.role === 'operator' || m.role === 'moderator') {
      var badge = document.createElement('span');
      badge.className = 'play-chat-badge' + (m.role === 'operator' ? ' is-operator' : ' is-mod');
      text(badge, m.role === 'operator' ? 'Operator' : 'Mod');
      meta.appendChild(badge);
    }
    if (m.own) {
      var you = document.createElement('span');
      you.className = 'play-chat-you';
      text(you, 'you');
      meta.appendChild(you);
    }
    var t = document.createElement('time');
    t.className = 'play-chat-time';
    text(t, when(m.created_at));
    if (typeof m.created_at === 'number') t.title = utc(m.created_at, true);
    meta.appendChild(t);
    li.appendChild(meta);

    var body = document.createElement('p');
    body.className = 'play-chat-body';
    text(body, m.body);                       // plain text, always
    li.appendChild(body);

    if (m.held) {
      var h = document.createElement('p');
      h.className = 'play-chat-held';
      text(h, 'Awaiting review — only you can see this. Links and some words wait for a moderator.');
      li.appendChild(h);
    }
    li.appendChild(buildActions(m));
    return li;
  }

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
    }
    return box;
  }

  function upsert(m) {
    if (!valid(m)) return;
    var old = S.rows[m.id];
    var li = buildRow(m);
    if (old) {
      EL['chat-list'].replaceChild(li, old.li);
    } else {
      // Keep id order: almost always an append.
      var next = null;
      var kids = EL['chat-list'].children;
      for (var i = kids.length - 1; i >= 0; i--) {
        var kid = Number(kids[i].getAttribute('data-id'));
        if (kid < m.id) break;
        next = kids[i];
      }
      EL['chat-list'].insertBefore(li, next);
    }
    S.rows[m.id] = { li: li, m: m };
  }

  function drop(id) {
    var r = S.rows[id];
    if (!r) return;
    if (r.li.parentNode) r.li.parentNode.removeChild(r.li);
    delete S.rows[id];
  }

  function trim() {
    var kids = EL['chat-list'].children;
    while (kids.length > KEEP) drop(Number(kids[0].getAttribute('data-id')));
  }

  function redrawActions() {
    Object.keys(S.rows).forEach(function (id) { upsert(S.rows[id].m); });
  }

  function resetList() {
    clear(EL['chat-list']);
    S.rows = {};
    S.after = null; S.rev = null; S.epoch = null;
  }

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
    var path = 'chat?room=global';
    if (S.after !== null && S.epoch !== null && S.rev !== null) {
      path += '&after=' + int(S.after) + '&rev=' + int(S.rev) + '&epoch=' + S.epoch;
    }
    Api.get(path).then(apply, function (e) {
      // A blip keeps what is on screen; the page-level states (offline, closed) are the
      // shell's to show — it hears them on its own next call.
      if (e instanceof Api.Error && e.status === 404) { setEnabled(false); }
    }).then(function () { S.inflight = false; schedule(); });
  }

  function setEnabled(on) {
    S.enabled = on;
    show(EL['chat-closed'], !on);
    if (!on) { resetList(); show(EL['chat-empty'], false); }
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
    if (r.reset || S.after === null || typeof r.epoch !== 'string' || r.epoch !== S.epoch) resetList();

    var msgs = Array.isArray(r.messages) ? r.messages : [];
    var maxId = S.after;
    msgs.forEach(function (m) {
      upsert(m);
      if (valid(m) && !m.held && (maxId === null || m.id > maxId)) maxId = m.id;
    });
    var ch = r.changes;
    if (ch && typeof ch === 'object') {
      (Array.isArray(ch.removed) ? ch.removed : []).forEach(function (id) { if (isId(id)) drop(id); });
      (Array.isArray(ch.held) ? ch.held : []).forEach(function (id) {
        var row = isId(id) ? S.rows[id] : null;
        if (!row) return;
        // The author keeps seeing their message, flagged; everyone else loses it.
        if (row.m.own) { row.m.held = true; upsert(row.m); } else drop(id);
      });
      (Array.isArray(ch.shown) ? ch.shown : []).forEach(function (m) { if (valid(m)) { m.held = false; upsert(m); } });
    }
    if (maxId === null) maxId = 0;              // an empty (or only-held) first page
    S.after = maxId;
    S.epoch = typeof r.epoch === 'string' && /^[0-9a-f]{16}$/.test(r.epoch) ? r.epoch : null;
    S.rev = typeof r.rev === 'number' && r.rev >= 0 ? r.rev : null;
    trim();
    show(EL['chat-empty'], list.children.length === 0);
    if (atBottom) list.scrollTop = list.scrollHeight;
    if (r.more) S.soon = true;
  }

  document.addEventListener('visibilitychange', function () {
    if (S.open && document.visibilityState === 'visible' && !S.inflight) poll();
  });

  // ── Posting ─────────────────────────────────────────────────────────────────────────
  function errText(e) {
    if (!(e instanceof Api.Error)) return 'Something went wrong.';
    var b = e.body || {};
    if (e.code === 'chat_refused') return gateText(b);
    if (e.status === 429) {
      var ra = typeof b.retry_after === 'number' ? b.retry_after : 0;
      return 'Slow down — you can send again in ' + (ra > 0 ? duration(ra) : 'a moment') + '.';
    }
    if (e.code === 'bad_request' && b.field === 'body') return 'A message is 1 to ' + BODY_MAX + ' characters of text.';
    return e.message;
  }

  function updateCount() {
    var n = cpLen(EL['chat-input'].value.trim());
    text(EL['chat-count'], int(n) + ' / ' + BODY_MAX);
    EL['chat-count'].classList.toggle('is-over', n > BODY_MAX);
  }
  EL['chat-input'].addEventListener('input', updateCount);

  EL['chat-form'].addEventListener('submit', function (ev) {
    ev.preventDefault();
    var body = EL['chat-input'].value.trim();
    var n = cpLen(body);
    if (n === 0) return;
    if (n > BODY_MAX) { msg(EL['chat-msg'], 'A message is at most ' + BODY_MAX + ' characters.'); return; }
    EL['chat-send'].disabled = true;
    msg(EL['chat-msg'], '');
    Api.post('chat', { body: body }).then(function (r) {
      EL['chat-input'].value = '';
      updateCount();
      if (r.message) upsert(r.message);
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

  // ── Moderator queue (D21) ───────────────────────────────────────────────────────────
  var HOLD_LABEL = { link: 'held: link or address', word: 'held: word list', reports: 'held: reported' };

  function modAct(id, action, body) {
    return Api.post('mod/messages/' + id + '/' + action, body).then(function (r) {
      var done = { delete: 'Deleted.', approve: 'Kept.', mute: 'Author muted' + (r.muted_until ? ' until ' + utc(r.muted_until, true) : '') + '.' }[action];
      msg(EL['mod-msg'], done, 'ok');
      msg(EL['chat-msg'], action === 'delete' || action === 'mute' ? done : '', 'ok');
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
  function loadRules() {
    if (S.rules) return;
    Api.get('rules').then(function (r) {
      S.rules = r;
      var p = r.plays || {}, c = r.chat || {};
      if (typeof p.minutes_per_play === 'number') {
        text(EL['rule-plays'], int(p.minutes_per_play) + ' active minutes earn 1 play, up to ' + int(p.daily_cap) + ' plays a UTC day and ' + int(p.balance_cap) + ' held at once');
      }
      if (typeof p.bot_play_cost === 'number') {
        text(EL['rule-cost'], p.bot_play_cost === 0 ? 'Games against the bot are free right now — and a free game pays no points.' : 'One game against the bot costs ' + int(p.bot_play_cost) + (p.bot_play_cost === 1 ? ' play.' : ' plays.'));
      }
      if (typeof c.min_minutes === 'number') {
        text(EL['rule-chat'], (c.min_minutes > 0 ? 'You need ' + int(c.min_minutes) + ' minutes of mining in the last ' + int(c.recent_days) + ' days' : 'Any miner can post')
          + ', and a sign-in proof at least ' + duration(c.min_proof_age_s) + ' old, so someone who only just mined to your address cannot post as you.'
          + (c.requires_password ? ' Chat needs a sign-in with your rig password.' : ''));
      }
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
    if (open) { loadRules(); poll(); } else { stop(); resetList(); S.enabled = null; }
  }
  document.addEventListener('play:view', function (e) {
    if (e && e.detail && typeof e.detail.view === 'string') onView(e.detail.view);
  });
  document.addEventListener('play:me', function (e) {
    var me = e && e.detail ? e.detail.me : null;
    var signChange = !!me !== !!S.me || (me && S.me && me.address !== S.me.address);
    S.me = me && typeof me === 'object' ? me : null;
    renderGate();
    redrawActions();
    // Signing in or out changes what the page holds (the caller's own held messages).
    if (signChange && S.open) { resetList(); poll(); }
    if (S.me && S.me.moderator && S.me.moderator.can_act && EL['mod-fold'].open) loadQueue();
  });
  if (document.body && document.body.getAttribute('data-play-view')) onView(document.body.getAttribute('data-play-view'));
})();
