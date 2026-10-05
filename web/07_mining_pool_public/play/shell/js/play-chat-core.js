/* play-chat-core.js — the ONE chat client (design §19.10, §19.17.7; Part C7).
 *
 * Two surfaces draw the same public chat: the G-07 panel on /play/ (play-chat.js, which adds
 * the moderator tools and the rules fold) and the floating bubble on every other pool page
 * (chat-bubble.js, which adds its own sign-in). Everything both need lives here, once:
 *
 *   PlayChatCore.createFeed({ list, actions })   the message list + the change feed
 *     .path()      the next GET path — `after`, `rev` and `epoch` once a page has landed
 *     .apply(r)    a GET chat answer → rows in `list`; returns { more, added }
 *     .reset()     forget everything (sign-in change, chat closed)
 *     .redraw()    rebuild every row (the caller's actions depend on who is signed in)
 *     .upsert(m)   one message (a post's own answer)
 *   PlayChatCore.gateText(chat, rules, signedOutText)   why this session cannot post
 *   PlayChatCore.errText(e, rules)                      one sentence for a refused call
 *   PlayChatCore.armButton / smallBtn                   the two-click confirm (no dialogs)
 *   + the small text helpers both use (text, int, utc, when, duration, inText, cpLen, isId)
 *
 * Rendering rules — the reason this file exists in this shape:
 *   - every message is built with createElement + textContent. There is NO innerHTML here
 *     (test-shell.js fails on one), so a body is only ever text: `<img onerror=…>` shows as
 *     those characters, and a link is inert text, never an <a>;
 *   - the only badges are "Operator" and "Mod", and they come from the server's `role`,
 *     which no player can set. A name is a masked address or a guest name, and either can be
 *     imitated (§19.13 #10), so both surfaces say the badge is the only proof.
 *
 * It needs window.PlayApi (play-api.js) only for errText's `instanceof`; it makes no request
 * of its own — the caller owns the polling budget (the panel and the bubble differ there).
 */
(function () {
  'use strict';

  var BODY_MAX = 280;
  var KEEP = 200;             // messages kept on the page
  var CONFIRM_MS = 5000;

  function text(el, s) { if (el) el.textContent = s == null ? '' : String(s); }
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
  // "in 5 h 12 min" from now, for a wait with an end.
  function inText(at) {
    var left = at - Math.floor(Date.now() / 1000);
    return left > 0 ? ' (in ' + duration(left) + ')' : '';
  }

  // ── Gate text (the reasons lib/auth.js chatStatus / modStatus give) ─────────────────
  // signedOutText: what to say with no session — the panel's sign-in card is above it, the
  // bubble's is below.
  function gateText(c, rules, signedOutText) {
    if (!c) return signedOutText || 'Sign in to post in chat.';
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
        return 'You can post from ' + (c.available_at ? utc(c.available_at, true) + inText(c.available_at) : 'later') + '. A new proof has to age first, so someone who only just mined to your address cannot post as you.';
      // Guests (§19.17.3, D26): the account's age replaces the mining bar.
      case 'account_too_new': {
        var age = rules && rules.guests && typeof rules.guests.chat_min_age_s === 'number' ? duration(rules.guests.chat_min_age_s) : null;
        return 'You can post from ' + (c.available_at ? utc(c.available_at, true) + inText(c.available_at) : 'later') + '. '
          + (age ? 'A guest account has to be ' + age + ' old before it can post' : 'A new guest account has to wait before it can post')
          + ', so nobody can flood the chat with fresh accounts. Reading is open now.';
      }
      case 'guests_off': return 'Chat is open to miners only right now. You can still read along.';
      default: return 'You cannot post in chat right now.';
    }
  }

  function errText(e, rules) {
    var Api = window.PlayApi;
    if (!Api || !(e instanceof Api.Error)) return 'Something went wrong.';
    var b = e.body || {};
    if (e.code === 'chat_refused') return gateText(b, rules);
    if (e.status === 429) {
      var ra = typeof b.retry_after === 'number' ? b.retry_after : 0;
      return 'Slow down — you can send again in ' + (ra > 0 ? duration(ra) : 'a moment') + '.';
    }
    if (e.code === 'bad_request' && b.field === 'body') return 'A message is 1 to ' + BODY_MAX + ' characters of text.';
    return e.message;
  }

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

  // actions: an element (the caller's buttons for this message) or null.
  function buildRow(m, actions) {
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
    if (actions) li.appendChild(actions);
    return li;
  }

  // ── The feed: one list, kept current by the change feed (§19.10) ────────────────────
  // A poll asks only for ids after the newest it has, plus the change revision; the answer
  // carries new messages AND the ids deleted, held or approved since, so a message the
  // operator removes disappears from every open page. `reset` (the service restarted, or the
  // bounded change log dropped our revision) redraws from a fresh page.
  function createFeed(opts) {
    var list = opts.list;
    var actionsFor = typeof opts.actions === 'function' ? opts.actions : function () { return null; };
    var F = { epoch: null, rev: null, after: null, rows: {} };   // rows: id → { li, m }

    function upsert(m) {
      if (!valid(m)) return false;
      var old = F.rows[m.id];
      var li = buildRow(m, actionsFor(m));
      if (old) {
        list.replaceChild(li, old.li);
      } else {
        // Keep id order: almost always an append.
        var next = null;
        var kids = list.children;
        for (var i = kids.length - 1; i >= 0; i--) {
          var kid = Number(kids[i].getAttribute('data-id'));
          if (kid < m.id) break;
          next = kids[i];
        }
        list.insertBefore(li, next);
      }
      F.rows[m.id] = { li: li, m: m };
      return !old;
    }
    function drop(id) {
      var r = F.rows[id];
      if (!r) return;
      if (r.li.parentNode) r.li.parentNode.removeChild(r.li);
      delete F.rows[id];
    }
    function trim() {
      var kids = list.children;
      while (kids.length > KEEP) drop(Number(kids[0].getAttribute('data-id')));
    }
    function reset() {
      while (list.firstChild) list.removeChild(list.firstChild);
      F.rows = {};
      F.after = null; F.rev = null; F.epoch = null;
    }
    function redraw() {
      Object.keys(F.rows).forEach(function (id) { upsert(F.rows[id].m); });
    }
    function path() {
      var p = 'chat?room=global';
      if (F.after !== null && F.epoch !== null && F.rev !== null) {
        p += '&after=' + int(F.after) + '&rev=' + int(F.rev) + '&epoch=' + F.epoch;
      }
      return p;
    }
    // r: a GET chat answer with enabled === true (the caller handles a closed chat).
    // added: the messages this answer put on the page for the first time, visible ones only —
    // the bubble's unread dot reads it.
    function apply(r) {
      var added = [];
      if (r.reset || F.after === null || typeof r.epoch !== 'string' || r.epoch !== F.epoch) reset();
      var msgs = Array.isArray(r.messages) ? r.messages : [];
      var maxId = F.after;
      msgs.forEach(function (m) {
        if (upsert(m) && !m.held) added.push(m);
        if (valid(m) && !m.held && (maxId === null || m.id > maxId)) maxId = m.id;
      });
      var ch = r.changes;
      if (ch && typeof ch === 'object') {
        (Array.isArray(ch.removed) ? ch.removed : []).forEach(function (id) { if (isId(id)) drop(id); });
        (Array.isArray(ch.held) ? ch.held : []).forEach(function (id) {
          var row = isId(id) ? F.rows[id] : null;
          if (!row) return;
          // The author keeps seeing their message, flagged; everyone else loses it.
          if (row.m.own) { row.m.held = true; upsert(row.m); } else drop(id);
        });
        (Array.isArray(ch.shown) ? ch.shown : []).forEach(function (m) { if (valid(m)) { m.held = false; upsert(m); } });
      }
      if (maxId === null) maxId = 0;              // an empty (or only-held) first page
      F.after = maxId;
      F.epoch = typeof r.epoch === 'string' && /^[0-9a-f]{16}$/.test(r.epoch) ? r.epoch : null;
      F.rev = typeof r.rev === 'number' && r.rev >= 0 ? r.rev : null;
      trim();
      return { more: !!r.more, added: added };
    }

    return {
      path: path, apply: apply, reset: reset, redraw: redraw, upsert: upsert,
      size: function () { return list.children.length; },
      newest: function () { return F.after; }
    };
  }

  window.PlayChatCore = Object.freeze({
    BODY_MAX: BODY_MAX,
    text: text, int: int, utc: utc, when: when, duration: duration, inText: inText, cpLen: cpLen, isId: isId,
    gateText: gateText, errText: errText,
    armButton: armButton, smallBtn: smallBtn,
    valid: valid, buildRow: buildRow, createFeed: createFeed
  });
})();
