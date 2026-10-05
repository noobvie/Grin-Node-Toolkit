/* play-shell.js — the /play/ page controller (design §19, Part 6).
 *
 * Owns the page's states (loading · offline/closed · sign-in · signed in), the account
 * strip, the new-game form, "My games", the board (through FrameHost) and its buttons, and
 * the two PvP polls (§19.8): the open board every 5 s while the opponent is to move, and
 * the cheap "turns" poll (15 s visible / 60 s hidden) that keeps My games current. The
 * lobby ("Play a person") is play-lobby.js, reached through play:open / play:changed; guest sign-in,
 * sign-up and the guest account box are play-guest.js, which hands a new session over through
 * play:signed-in and an ended one through play:signed-out. All data comes
 * from PlayApi; every value from the API reaches the DOM through textContent or a value
 * property — this file has NO innerHTML. The page runs under script-src 'self' with no
 * 'unsafe-inline', so every handler is attached here, never as an attribute.
 *
 * What the browser is NOT: an authority. The server holds the board, the ply, the result
 * and the balances (§19.8). The shell sends { ply, move } and draws whatever comes back.
 */
(function () {
  'use strict';

  var Api = window.PlayApi;
  var FH = window.FrameHost;
  if (!Api || !FH) return;

  var ME_REFRESH_MS = 5 * 60 * 1000;   // tickets arrive with the 5-min activity sync (§19.6)
  var CONFIRM_MS = 5000;               // two-click confirm window (resign, log out everywhere)
  // §19.8 polling, correspondence pace. setTimeout, one request in flight, never setInterval.
  var BOARD_POLL_MS = 5000;            // an open PvP board while the opponent is to move
  var TURNS_VISIBLE_MS = 15000;
  var TURNS_HIDDEN_MS = 60000;

  function $(id) { return document.getElementById(id); }
  function show(el, on) { if (el) el.hidden = !on; }
  function text(el, s) { if (el) el.textContent = s == null ? '' : String(s); }
  function msg(el, s, kind) {
    if (!el) return;
    el.textContent = s || '';
    el.className = 'acct-msg' + (s ? (kind === 'ok' ? ' ok' : ' err') : '');
  }
  function int(n) { return typeof n === 'number' && isFinite(n) ? String(Math.trunc(n)) : '—'; }

  // All times UTC, and said so (memory feedback_pool_utc_display).
  function pad(n) { return n < 10 ? '0' + n : String(n); }
  function fmtUtc(s) {
    if (typeof s !== 'number' || !isFinite(s)) return '—';
    var d = new Date(s * 1000);
    return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()) + ' ' +
      pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) + ' UTC';
  }
  function fmtLeft(sec) {
    if (sec <= 0) return 'no time left';
    var d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
    if (d > 0) return d + 'd ' + h + 'h left';
    if (h > 0) return h + 'h ' + m + 'm left';
    return Math.max(1, m) + 'm left';
  }
  var nowS = function () { return Math.floor(Date.now() / 1000); };

  // ── Page state ──────────────────────────────────────────────────────────────────────
  var S = {
    me: null,
    games: {},          // id → /games summary
    gameOrder: [],
    current: null,      // the open match view
    host: null,         // FrameHost for current.game_id
    hostGame: null,
    busy: false,        // a move/resign/create request in flight
    mineBefore: null,
    meTimer: null,
    boardTimer: null,
    turnsTimer: null,
    turnsSig: null
  };

  var EL = {};
  ['play-loading', 'play-offline', 'play-offline-title', 'play-offline-text', 'play-retry',
   'play-login', 'login-note', 'login-form', 'login-address', 'login-proof', 'login-reveal', 'login-submit', 'login-msg',
   'play-account', 'acct-plays', 'acct-points', 'acct-addr', 'acct-guest-line', 'acct-badges', 'acct-sessions', 'sessions-fold',
   'sessions-list', 'btn-logout', 'btn-logout-all', 'account-msg',
   'play-game-area', 'board-title', 'board-sub', 'board-status', 'frame-slot', 'frame-empty',
   'btn-resign', 'btn-abort', 'btn-draw-offer', 'btn-draw-accept', 'btn-draw-decline',
   'btn-accept', 'btn-decline', 'btn-cancel', 'board-deadline', 'board-msg', 'mine-turns',
   'new-form', 'new-game-field', 'new-game', 'new-level', 'new-colour', 'new-submit', 'new-msg',
   'mine-list', 'mine-empty', 'mine-more'].forEach(function (id) { EL[id] = $(id); });

  function setView(v) {   // 'loading' | 'offline' | 'login' | 'in'
    show(EL['play-loading'], v === 'loading');
    show(EL['play-offline'], v === 'offline');
    show(EL['play-login'], v === 'login');
    show(EL['play-account'], v === 'in');
    show(EL['play-game-area'], v === 'in');
    // play-boards.js (Leaderboards & events) follows the page state from this: the attribute
    // for a late listener, the event for a change.
    document.body.setAttribute('data-play-view', v);
    try { document.dispatchEvent(new CustomEvent('play:view', { detail: { view: v } })); } catch (e) { /* no panel then */ }
  }

  function showOffline(title, body) {
    text(EL['play-offline-title'], title);
    text(EL['play-offline-text'], body);
    setView('offline');
  }

  // One place decides what an error means for the whole page. Returns true when handled
  // (the page changed state), false when the caller should show the message locally.
  function pageLevel(e) {
    if (!(e instanceof Api.Error)) {
      showOffline('Games are offline', 'Something went wrong loading the games. Mining is not affected.');
      return true;
    }
    if (e.kind === 'offline') {
      showOffline('Games are offline', e.message + ' Mining is not affected.');
      return true;
    }
    if (e.status === 404 && e.code === 'not_found') {
      // Mode `off`: every public route answers 404 (D12).
      showOffline('Games are closed', 'The pool\'s games are not open right now. Mining is not affected.');
      return true;
    }
    if (e.status === 401) {
      signedOut('Your session has ended. Sign in again.');
      return true;
    }
    if (e.status === 403 && e.code === 'banned') {
      signedOut(e.message);
      return true;
    }
    return false;
  }

  // ── Two-click confirm (no native dialogs) ───────────────────────────────────────────
  function confirmButton(btn, label, confirmLabel, action) {
    var armed = false;
    var timer = null;
    function disarm() {
      armed = false;
      btn.textContent = label;
      btn.classList.remove('play-armed');
      if (timer) { clearTimeout(timer); timer = null; }
    }
    btn.addEventListener('click', function () {
      if (!armed) {
        armed = true;
        btn.textContent = confirmLabel;
        btn.classList.add('play-armed');
        timer = setTimeout(disarm, CONFIRM_MS);
        return;
      }
      disarm();
      action();
    });
    return disarm;
  }

  // ── Theme → frame ───────────────────────────────────────────────────────────────────
  function themeMode() {
    try { return window.GriniumTheme && window.GriniumTheme.isLight() ? 'light' : 'dark'; } catch (e) { return 'dark'; }
  }
  function pushTheme() { if (S.host) S.host.sendTheme(themeMode()); }
  try {
    new MutationObserver(pushTheme).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  } catch (e) { /* the frame just keeps its first theme */ }

  // ── The bubble's two hints (design §19.17.7, Part C7) ───────────────────────────────
  // The floating chat bubble on the pool's other pages (chat-bubble.js) cannot see the session
  // cookie (HttpOnly), so this page leaves it two localStorage hints. Neither holds a token or
  // a name — a stale one costs the bubble one request:
  //   grin_play_signed_in  '1' while this browser has a games session — a closed bubble polls
  //                        the change feed (60 s) only then; cleared on sign-out and on a 401;
  //   grin_play_preview    '1' once this page has loaded in PREVIEW — the pool's loader shows the
  //                        bubble in preview only to a browser that has been here; removed when
  //                        the games are fully on (the nav shows /play/ to everyone then).
  // Every access is in try/catch: storage off means no hint, never a broken page.
  var HINT_SIGNED = 'grin_play_signed_in', HINT_PREVIEW = 'grin_play_preview';
  function hint(key, on) {
    try { if (on) localStorage.setItem(key, '1'); else localStorage.removeItem(key); } catch (e) { /* no hint, no harm */ }
  }
  function notePreview() {
    Api.rules().then(function (r) {
      if (r.mode === 'preview') hint(HINT_PREVIEW, true);
      else if (r.mode === 'on') hint(HINT_PREVIEW, false);
    }, function () { /* leave the hint as it was */ });
  }

  // ── Boot ────────────────────────────────────────────────────────────────────────────
  function boot() {
    setView('loading');
    notePreview();
    Api.get('me').then(function (me) {
      signedIn(me);
    }, function (e) {
      if (e instanceof Api.Error && e.status === 401) { signedOut(''); return; }
      pageLevel(e);
    });
  }
  EL['play-retry'].addEventListener('click', boot);

  // ── Sign in / out ───────────────────────────────────────────────────────────────────
  var LOGIN_FIELD_TEXT = {
    address: 'That is not a GRIN address for this pool\'s network.',
    proof: 'Enter a mining IP or your rig password (up to 256 characters).',
    client_ip: 'The games could not see your IP address. Try again in a minute.'
  };

  // kind: 'ok' for a sign-out the player asked for, an error style otherwise.
  function signedOut(note, kind) {
    S.me = null;
    hint(HINT_SIGNED, false);
    announceMe(null);
    closeBoard();
    stopMeTimer();
    stopTurns();
    EL['login-proof'].value = '';
    setView('login');
    msg(EL['login-msg'], '');
    msg(EL['login-note'], note || '', kind === 'ok' ? 'ok' : 'err');
  }

  EL['login-reveal'].addEventListener('click', function () {
    var p = EL['login-proof'];
    var reveal = p.type === 'password';
    p.type = reveal ? 'text' : 'password';
    EL['login-reveal'].textContent = reveal ? 'Hide' : 'Show';
    EL['login-reveal'].setAttribute('aria-pressed', reveal ? 'true' : 'false');
  });

  EL['login-form'].addEventListener('submit', function (ev) {
    ev.preventDefault();
    var address = EL['login-address'].value.trim();
    var proof = EL['login-proof'].value.trim();
    if (!/^t?grin1[a-z0-9]{58}$/.test(address)) { msg(EL['login-msg'], LOGIN_FIELD_TEXT.address); return; }
    if (!proof) { msg(EL['login-msg'], 'Enter a mining IP or your rig password.'); return; }
    EL['login-submit'].disabled = true;
    msg(EL['login-msg'], 'Checking with the pool…', 'ok');
    Api.post('login', { address: address, proof: proof }).then(function (r) {
      EL['login-proof'].value = '';
      msg(EL['login-msg'], '');
      msg(EL['login-note'], '');
      signedIn(r.me);
    }, function (e) {
      if (!(e instanceof Api.Error) || e.kind === 'offline') { pageLevel(e); return; }
      if (e.status === 404 && e.code === 'not_found') { pageLevel(e); return; }
      var b = e.body || {};
      var s;
      if (e.code === 'login_failed' || (e.status === 429 && typeof b.hint === 'string')) {
        s = typeof b.hint === 'string' ? b.hint : e.message;
      } else if (e.status === 429) {
        var ra = typeof b.retry_after === 'number' ? b.retry_after : 0;
        s = 'Too many attempts from here.' + (ra > 0 ? ' Try again in ' + fmtLeft(ra).replace(' left', '') + '.' : ' Try again later.');
      } else if (e.code === 'bad_request' && LOGIN_FIELD_TEXT[b.field]) {
        s = LOGIN_FIELD_TEXT[b.field];
      } else {
        s = e.message;   // banned, pool_unavailable, cross_origin … — the server's own sentence
      }
      msg(EL['login-msg'], s);
    }).then(function () { EL['login-submit'].disabled = false; });
  });

  EL['btn-logout'].addEventListener('click', function () {
    Api.post('logout', {}).then(function () { signedOut('You are signed out.', 'ok'); }, function (e) {
      if (!pageLevel(e)) msg(EL['account-msg'], e.message);
    });
  });
  confirmButton(EL['btn-logout-all'], 'Log out everywhere', 'Confirm: every device', function () {
    Api.post('logout-all', {}).then(function (r) {
      signedOut('Signed out on ' + int(r.revoked) + ' device(s).', 'ok');
    }, function (e) {
      if (!pageLevel(e)) msg(EL['account-msg'], e.message);
    });
  });

  // play-guest.js: a guest signed in or signed up (the body's `me` is /me's shape), or the
  // guest's account or session ended.
  document.addEventListener('play:signed-in', function (e) {
    var d = e && e.detail;
    if (!d || !d.me || typeof d.me !== 'object') return;
    msg(EL['login-msg'], '');
    msg(EL['login-note'], '');
    signedIn(d.me);
    if (typeof d.note === 'string' && d.note) msg(EL['account-msg'], d.note, 'ok');
  });
  document.addEventListener('play:signed-out', function (e) {
    var d = e && e.detail;
    signedOut(d && typeof d.note === 'string' ? d.note : '', d && d.kind === 'ok' ? 'ok' : 'err');
  });
  // play-chat.js asks for a fresh /me when a chat wait (account age, proof age) runs out.
  document.addEventListener('play:refresh-me', function () { if (S.me) refreshMe(); });

  // ── Signed in ───────────────────────────────────────────────────────────────────────
  // The chat panel (play-chat.js, Part 9) follows the caller's chat + moderator status from
  // this: every /me that renders is announced, and signing out announces null.
  function announceMe(me) {
    try { document.dispatchEvent(new CustomEvent('play:me', { detail: { me: me } })); } catch (e) { /* no chat panel then */ }
  }

  // A guest's day (§19.17.4): the count is SET back to the daily number at 00:00 UTC.
  function guestLine(me) {
    var g = me.guest;
    if (!g || typeof g.daily_tickets !== 'number') return '';
    var left = typeof g.resets_at === 'number' ? g.resets_at - nowS() : 0;
    return 'Guest account · ' + int(g.daily_tickets) + (g.daily_tickets === 1 ? ' ticket' : ' tickets') +
      ' a day — the count goes back to ' + int(g.daily_tickets) + ' at 00:00 UTC' +
      (left > 0 ? ' (' + fmtLeft(left).replace(' left', '') + ' from now)' : '') + '.';
  }

  function renderMe(me) {
    S.me = me;
    announceMe(me);
    var guest = me.kind === 'guest' && !!me.guest && typeof me.guest.login_name === 'string';
    text(EL['acct-plays'], int(me.plays));
    text(EL['acct-points'], int(me.points));
    // A guest signs in with a NAME, so that is who they are here; /me shows it to its owner only.
    var who = guest ? me.guest.login_name + ' · guest' : me.address_masked;
    text(EL['acct-addr'], who);
    EL['acct-addr'].title = who;
    text(EL['acct-guest-line'], guest ? guestLine(me) : '');
    show(EL['acct-guest-line'], guest);
    // Event badges (§19.9): ids from the server's list, labels from the server — text only.
    var badges = Array.isArray(me.badges) ? me.badges.filter(function (b) { return b && typeof b.label === 'string'; }) : [];
    text(EL['acct-badges'], badges.length ? 'Badges: ' + badges.map(function (b) { return b.label; }).join(' · ') : '');
    show(EL['acct-badges'], badges.length > 0);
    text(EL['acct-sessions'], 'Signed in on ' + int(me.sessions) + (me.sessions === 1 ? ' device' : ' devices'));
  }

  function refreshMe() {
    // A background refresh keeps the last numbers through a blip; only an answer that
    // changes the page (session gone, games closed) acts.
    return Api.get('me').then(renderMe, function (e) {
      if (e instanceof Api.Error && e.kind === 'offline') return;
      pageLevel(e);
    });
  }
  function stopMeTimer() { if (S.meTimer) { clearInterval(S.meTimer); S.meTimer = null; } }
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && S.me) refreshMe();
  });

  function signedIn(me) {
    hint(HINT_SIGNED, true);
    renderMe(me);
    setView('in');
    msg(EL['account-msg'], '');
    stopMeTimer();
    S.meTimer = setInterval(function () {
      if (document.visibilityState === 'visible' && S.me) refreshMe();
    }, ME_REFRESH_MS);

    Api.get('games').then(function (r) {
      S.games = {};
      S.gameOrder = [];
      (Array.isArray(r.games) ? r.games : []).forEach(function (g) {
        if (g && typeof g.id === 'string') { S.games[g.id] = g; S.gameOrder.push(g.id); }
      });
      fillNewForm();
      return loadMine(true);
    }).then(function (rows) {
      startTurns();
      var id = hashMatchId();
      if (id) { openMatch(id); return; }
      // A game waiting for this player's move first, else an active game against the bot.
      var list = rows || [];
      var pick = list.filter(function (m) { return m.state === 'active' && m.your_turn; })[0]
        || list.filter(function (m) { return m.state === 'active' && m.mode === 'bot'; })[0];
      if (pick) openMatch(pick.id);
    }, function (e) { if (!pageLevel(e)) msg(EL['board-msg'], e.message); });
  }

  // The games that offer bot play, in registry order. With more than one, the form shows a
  // Game picker; a new game folder appears here with no shell change (play/README.md).
  function botGames() {
    return S.gameOrder.map(function (id) { return S.games[id]; }).filter(function (g) {
      return g && Array.isArray(g.modes) && g.modes.indexOf('bot') !== -1;
    });
  }
  function botGame() {
    var list = botGames();
    for (var i = 0; i < list.length; i++) if (list[i].id === EL['new-game'].value) return list[i];
    return list[0] || null;
  }

  function fillNewForm() {
    var list = botGames();
    var gsel = EL['new-game'];
    var keep = gsel.value;
    while (gsel.firstChild) gsel.removeChild(gsel.firstChild);
    list.forEach(function (g) {
      var o = document.createElement('option');
      o.value = g.id;
      o.textContent = g.title;
      gsel.appendChild(o);
    });
    if (keep && list.some(function (g) { return g.id === keep; })) gsel.value = keep;
    show(EL['new-game-field'], list.length > 1);
    fillLevels();
  }

  function fillLevels() {
    var g = botGame();
    var sel = EL['new-level'];
    while (sel.firstChild) sel.removeChild(sel.firstChild);
    if (!g) {
      EL['new-submit'].disabled = true;
      msg(EL['new-msg'], 'No game is available right now.');
      return;
    }
    EL['new-submit'].disabled = false;
    msg(EL['new-msg'], '');
    (g.bot_levels || []).forEach(function (lvl) {
      if (typeof lvl !== 'number') return;
      var o = document.createElement('option');
      o.value = String(lvl);
      o.textContent = 'Level ' + lvl + (lvl === 1 ? ' — beginner' : lvl === 2 ? ' — casual' : lvl === 3 ? ' — thinker' : '');
      sel.appendChild(o);
    });
    if (!S.current) text(EL['board-title'], g.title);
  }
  EL['new-game'].addEventListener('change', fillLevels);

  // ── Sessions fold ───────────────────────────────────────────────────────────────────
  EL['sessions-fold'].addEventListener('toggle', function () {
    if (!EL['sessions-fold'].open) return;
    var ul = EL['sessions-list'];
    while (ul.firstChild) ul.removeChild(ul.firstChild);
    Api.get('sessions').then(function (r) {
      (r.sessions || []).forEach(function (s) {
        var li = document.createElement('li');
        var parts = [s.ua_hint || 'Unknown browser'];
        if (s.ip_coarse) parts.push(s.ip_coarse);
        parts.push('signed in ' + fmtUtc(s.created_at));
        parts.push('last seen ' + fmtUtc(s.last_seen));
        li.textContent = parts.join(' · ');
        if (s.current) {
          var b = document.createElement('b');
          b.textContent = ' (this device)';
          li.appendChild(b);
        }
        ul.appendChild(li);
      });
    }, function (e) { if (!pageLevel(e)) msg(EL['account-msg'], e.message); });
  });

  // ── My games ────────────────────────────────────────────────────────────────────────
  var REASON_TEXT = {
    checkmate: 'checkmate', stalemate: 'stalemate', repetition: 'threefold repetition',
    fifty: 'fifty-move rule', material: 'insufficient material', max_plies: 'move limit',
    resign: 'resignation', timeout: 'time ran out', agreement: 'agreement'
  };
  function reasonText(r) { return REASON_TEXT[r] || (r ? String(r) : ''); }

  // The outcome from the viewer's side. `result` is 'seat1' | 'seat2' | 'draw'.
  function outcome(state, result, reason, you) {
    if (state === 'aborted' && reason === 'cancelled') return 'Withdrawn before anyone accepted, ticket refunded';
    if (state === 'aborted') return 'Aborted' + (reason === 'timeout' ? ' — no move in time, tickets refunded' : ', tickets refunded');
    if (state === 'declined') return 'Challenge declined, ticket refunded';
    if (state === 'expired') return 'Nobody accepted within 3 days, ticket refunded';
    if (state === 'void') return 'Voided by the pool';
    if (state !== 'finished') return null;
    var why = reasonText(reason);
    if (result === 'draw') return 'Draw' + (why ? ' by ' + why : '');
    if (you !== 1 && you !== 2) return (result === 'seat1' ? 'White' : 'Black') + ' won' + (why ? ' by ' + why : '');
    return (result === 'seat' + you ? 'You won' : 'You lost') + (why ? ' by ' + why : '');
  }

  function colourOf(you) { return you === 1 ? 'White' : you === 2 ? 'Black' : ''; }

  function mineRow(m) {
    var li = document.createElement('li');
    li.className = 'play-mine-row' + (m.your_turn ? ' is-turn' : '');
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn sm';
    btn.textContent = 'Open';
    btn.setAttribute('aria-label', 'Open game #' + m.id);
    btn.addEventListener('click', function () { openMatch(m.id); });
    var info = document.createElement('span');
    info.className = 'play-mine-info';
    var opp = m.you === 1 ? m.labels && m.labels[2] : m.labels && m.labels[1];
    var line1 = document.createElement('span');
    line1.textContent = '#' + m.id + ' · ' + colourOf(m.you) + ' vs ' +
      (opp || (m.state === 'challenge' && m.target_label ? m.target_label : m.state === 'seek' ? 'anyone' : '—')) +
      (m.mode === 'pvp' && m.rated ? ' · rated' : '');
    var line2 = document.createElement('small');
    var o = outcome(m.state, m.result, m.reason, m.you);
    if (m.state === 'seek' || m.state === 'challenge') {
      line2.textContent = (m.state === 'seek' ? 'Waiting for an opponent' : 'Waiting for them to accept') +
        (m.expires_at ? ' · ' + fmtLeft(m.expires_at - nowS()) : '');
    } else if (m.state === 'active') {
      line2.textContent = (m.your_turn ? 'Your move' : 'Waiting') +
        (m.you && m.draw_offer_by && m.draw_offer_by !== m.you ? ' · draw offered' : '') +
        (m.turn_deadline ? ' · ' + fmtLeft(m.turn_deadline - nowS()) : '');
    } else {
      line2.textContent = (o || m.state) + (m.finished_at ? ' · ' + fmtUtc(m.finished_at) : '');
    }
    info.appendChild(line1);
    info.appendChild(line2);
    li.appendChild(info);
    li.appendChild(btn);
    return li;
  }

  // reset = true reloads page 1; otherwise appends the next page. Resolves to the rows.
  function loadMine(reset) {
    var path = 'matches/mine' + (!reset && S.mineBefore ? '?before=' + int(S.mineBefore) : '');
    return Api.get(path).then(function (r) {
      var rows = Array.isArray(r.matches) ? r.matches : [];
      var ul = EL['mine-list'];
      if (reset) while (ul.firstChild) ul.removeChild(ul.firstChild);
      rows.forEach(function (m) { ul.appendChild(mineRow(m)); });
      S.mineBefore = typeof r.next_before === 'number' ? r.next_before : null;
      show(EL['mine-more'], S.mineBefore !== null);
      show(EL['mine-empty'], !ul.firstChild);
      return rows;
    });
  }
  EL['mine-more'].addEventListener('click', function () {
    loadMine(false).catch(function (e) { pageLevel(e); });
  });

  // ── New game ────────────────────────────────────────────────────────────────────────
  EL['new-form'].addEventListener('submit', function (ev) {
    ev.preventDefault();
    var g = botGame();
    if (!g || S.busy) return;
    var level = parseInt(EL['new-level'].value, 10);
    var colour = EL['new-colour'].value;
    if (!(level > 0) || ['random', 'seat1', 'seat2'].indexOf(colour) === -1) return;
    S.busy = true;
    EL['new-submit'].disabled = true;
    msg(EL['new-msg'], 'Setting up the board…', 'ok');
    Api.post('matches', { game_id: g.id, mode: 'bot', bot_level: level, colour: colour }).then(function (r) {
      msg(EL['new-msg'], '');
      showMatch(r.match);
      refreshMe();
      loadMine(true).catch(function () {});
    }, function (e) {
      if (pageLevel(e)) return;
      if (e.code === 'active_match' && e.body && typeof e.body.match_id === 'number') {
        msg(EL['new-msg'], 'You already have a game against the bot in progress — here it is. Finish or resign it first.');
        openMatch(e.body.match_id);
        return;
      }
      msg(EL['new-msg'], boardErrText(e));
    }).then(function () {
      S.busy = false;
      EL['new-submit'].disabled = false;
    });
  });

  // ── The board ───────────────────────────────────────────────────────────────────────
  function hashMatchId() {
    var m = /^#m=([1-9][0-9]{0,14})$/.exec(location.hash || '');
    return m ? Number(m[1]) : null;
  }
  function setHash(id) {
    try { history.replaceState(null, '', id ? '#m=' + id : location.pathname + location.search); } catch (e) {}
  }

  function openMatch(id) {
    if (typeof id !== 'number' || !(id > 0)) return;
    msg(EL['board-msg'], '');
    Api.get('matches/' + id).then(function (r) { showMatch(r.match); }, function (e) {
      if (pageLevel(e)) return;
      if (e.status === 404) { setHash(null); msg(EL['board-msg'], 'That game does not exist.'); return; }
      msg(EL['board-msg'], e.message);
    });
  }

  function closeBoard() {
    if (S.host) { S.host.destroy(); S.host = null; S.hostGame = null; }
    S.current = null;
    stopBoardPoll();
    show(EL['frame-empty'], true);
    showActions([]);
    text(EL['board-status'], '');
    text(EL['board-sub'], '');
    text(EL['board-deadline'], '');
  }

  function ensureHost(gameId) {
    if (S.host && S.hostGame === gameId) return S.host;
    if (S.host) { S.host.destroy(); S.host = null; S.hostGame = null; }
    var g = S.games[gameId];
    if (!g) return null;
    S.host = FH.create({
      container: EL['frame-slot'],
      game: g,
      onMove: onFrameMove,
      onReady: pushTheme
    });
    S.hostGame = gameId;
    show(EL['frame-empty'], false);
    pushTheme();
    return S.host;
  }

  // The board buttons: exactly the server's `actions` for this viewer (§19.8), so the page
  // never re-derives who may abort, resign, answer a draw or accept a seat.
  var ACTION_BTN = {
    accept: 'btn-accept', decline: 'btn-decline', cancel: 'btn-cancel',
    draw_accept: 'btn-draw-accept', draw_decline: 'btn-draw-decline', draw_offer: 'btn-draw-offer',
    abort: 'btn-abort', resign: 'btn-resign'
  };
  function showActions(list) {
    var on = Array.isArray(list) ? list : [];
    Object.keys(ACTION_BTN).forEach(function (a) { show(EL[ACTION_BTN[a]], on.indexOf(a) !== -1); });
  }

  function isOpenState(st) { return st === 'seek' || st === 'challenge'; }

  function statusLine(v) {
    if (v.state === 'seek') return v.you ? 'Your open seek — waiting for an opponent.' : 'An open seek — waiting for an opponent.';
    if (v.state === 'challenge') {
      if (v.invited) return 'You have been challenged. Accept to start, or decline.';
      return v.you ? 'Challenge sent' + (v.target_label ? ' to ' + v.target_label : '') + ' — waiting for them to accept.' : 'A challenge waiting to be accepted.';
    }
    if (v.state !== 'active') return (outcome(v.state, v.status && v.status.result, v.status && v.status.reason, v.you) || 'Game over') + '.';
    var s = v.your_turn ? 'Your move.' : (v.you ? 'Waiting for the other side.' : (colourOf(v.to_move) + ' to move.'));
    if (v.you && v.draw_offer_by) s += v.draw_offer_by === v.you ? ' You offered a draw.' : ' Your opponent offers a draw.';
    return s;
  }

  function showMatch(v) {
    if (!v || typeof v.id !== 'number') return;
    var prev = S.current;
    S.current = v;
    setHash(v.id);
    var host = ensureHost(v.game_id);
    if (!host) {
      msg(EL['board-msg'], 'This game is not available any more.');
      return;
    }
    host.sendState(v);

    var g = S.games[v.game_id];
    text(EL['board-title'], (g && g.title ? g.title : v.game_id) + ' · #' + v.id);
    var opp = v.you === 1 ? v.labels[2] : v.you === 2 ? v.labels[1] : null;
    var sub = v.you ? 'you play ' + colourOf(v.you) + (opp ? ' vs ' + opp : '') : ((v.labels[1] || 'open seat') + ' vs ' + (v.labels[2] || 'open seat'));
    if (v.mode === 'pvp' && v.rated) sub += ' · rated';
    text(EL['board-sub'], sub);

    var active = v.state === 'active';
    var open = isOpenState(v.state);
    text(EL['board-status'], statusLine(v));
    EL['board-status'].className = 'play-status' + (active ? (v.your_turn ? ' is-turn' : '') : open ? (v.invited ? ' is-turn' : '') : ' is-over');
    showActions(v.actions);
    if (open) {
      text(EL['board-deadline'], v.expires_at ? 'Expires ' + fmtUtc(v.expires_at) + ' (' + fmtLeft(v.expires_at - nowS()) + ')' : '');
    } else {
      text(EL['board-deadline'], active && v.turn_deadline
        ? (v.your_turn ? 'Move by ' : 'Next move due by ') + fmtUtc(v.turn_deadline) + ' (' + fmtLeft(v.turn_deadline - nowS()) + ')'
        : (v.finished_at ? 'Ended ' + fmtUtc(v.finished_at) : ''));
    }

    // A game that just ended or started changed plays/points and the list.
    if (prev && prev.id === v.id && prev.state !== v.state) {
      refreshMe();
      loadMine(true).catch(function () {});
    }
    scheduleBoardPoll();
  }

  // ── PvP polling (§19.8) ─────────────────────────────────────────────────────────────
  // The open board: every 5 s while it is a PvP game this player sits in and the other side
  // is to move (or it is their own seek/challenge waiting for an answer), only while the tab
  // is visible — a hidden tab relies on the turns poll. It asks with since_ply so the answer
  // carries no move list it already has.
  function stopBoardPoll() { if (S.boardTimer) { clearTimeout(S.boardTimer); S.boardTimer = null; } }
  function wantsBoardPoll(v) {
    if (!v || v.mode !== 'pvp' || !v.you || !S.me) return false;
    if (isOpenState(v.state)) return true;
    return v.state === 'active' && !v.your_turn;
  }
  function scheduleBoardPoll() {
    stopBoardPoll();
    if (!wantsBoardPoll(S.current) || document.visibilityState !== 'visible') return;
    S.boardTimer = setTimeout(pollBoard, BOARD_POLL_MS);
  }
  function pollBoard() {
    S.boardTimer = null;
    var v = S.current;
    if (!wantsBoardPoll(v) || S.busy) { scheduleBoardPoll(); return; }
    Api.get('matches/' + int(v.id) + '?since_ply=' + int(v.ply)).then(function (r) {
      var n = r.match;
      if (!S.current || S.current.id !== v.id || S.busy) return;
      if (n.ply !== v.ply || n.state !== v.state || n.draw_offer_by !== v.draw_offer_by) showMatch(n);
      else scheduleBoardPoll();
    }, function (e) {
      if (e instanceof Api.Error && e.kind === 'offline') { scheduleBoardPoll(); return; }
      if (!pageLevel(e)) scheduleBoardPoll();
    });
  }

  // The cheap poll: how many games wait for this player's move, new challenges, the newest
  // move. My games reloads only when one of these changes; play-lobby.js hears it too.
  function stopTurns() {
    if (S.turnsTimer) { clearTimeout(S.turnsTimer); S.turnsTimer = null; }
    S.turnsSig = null;
    text(EL['mine-turns'], '');
  }
  function scheduleTurns() {
    if (S.turnsTimer) clearTimeout(S.turnsTimer);
    S.turnsTimer = setTimeout(pollTurns, document.visibilityState === 'visible' ? TURNS_VISIBLE_MS : TURNS_HIDDEN_MS);
  }
  function startTurns() { stopTurns(); pollTurns(); }
  function pollTurns() {
    if (S.turnsTimer) { clearTimeout(S.turnsTimer); S.turnsTimer = null; }
    if (!S.me) return;
    Api.get('matches/turns').then(function (t) {
      if (!S.me) return;
      text(EL['mine-turns'], t.your_turn > 0 ? int(t.your_turn) + ' to move' : '');
      try { document.dispatchEvent(new CustomEvent('play:turns', { detail: t })); } catch (e) { /* no lobby then */ }
      var sig = [t.your_turn, t.active, t.draw_offers, t.challenges, t.last_move_at].join('|');
      if (S.turnsSig !== null && sig !== S.turnsSig) loadMine(true).catch(function () {});
      S.turnsSig = sig;
      scheduleTurns();
    }, function (e) {
      if (e instanceof Api.Error && e.kind === 'offline') { scheduleTurns(); return; }
      if (!pageLevel(e)) scheduleTurns();
    });
  }
  document.addEventListener('visibilitychange', function () {
    if (!S.me) return;
    if (document.visibilityState === 'visible') { scheduleBoardPoll(); pollTurns(); } else stopBoardPoll();
  });

  // play-lobby.js asks the board to open a match, and tells the page a match changed.
  document.addEventListener('play:open', function (e) {
    var id = e && e.detail ? e.detail.id : null;
    if (S.me && typeof id === 'number') openMatch(id);
  });
  document.addEventListener('play:changed', function () {
    if (!S.me) return;
    refreshMe();
    loadMine(true).catch(function () {});
  });

  var MOVE_ERROR_TEXT = {
    stale: 'The board changed — your opponent moved, or another tab did. Here is the current position.',
    timeout: 'The move time ran out, so the game has ended.',
    illegal_move: 'That move is not legal.',
    not_your_turn: 'It is not your turn.',
    not_active: 'This game is already over.',
    too_late: 'Both sides have moved, so the game can no longer be aborted. Resign instead.',
    no_draw_offer: 'The draw offer is no longer there.',
    not_open: 'Someone else took that game first, or it was withdrawn.',
    expired: 'That game expired — the ticket was refunded to whoever posted it.',
    too_many_matches: 'You already have the most games in progress allowed. Finish one first.',
    opponent_busy: 'That player already has the most games in progress allowed.'
  };

  // Out of tickets: a guest waits for 00:00 UTC, a miner mines (§19.17.4).
  function noTicketsText() {
    var g = S.me && S.me.kind === 'guest' && S.me.guest;
    if (g && typeof g.resets_at === 'number') {
      var left = g.resets_at - nowS();
      return 'You have no tickets left today. You get ' + int(g.daily_tickets) + ' new ones at 00:00 UTC' +
        (left > 0 ? ' (' + fmtLeft(left).replace(' left', '') + ' from now)' : '') + '.';
    }
    return 'You have no tickets left. Miners earn them from mining minutes — see "How tickets are earned" below.';
  }
  function boardErrText(e) { return e.code === 'no_plays' ? noTicketsText() : (MOVE_ERROR_TEXT[e.code] || e.message); }

  function onFrameMove(move) {
    var v = S.current;
    // The frame locks its own input until the next `state`; a move that arrives anyway is
    // redrawn back, unless a request is in flight (its answer will redraw).
    if (S.busy) return;
    if (!v || v.state !== 'active' || !v.your_turn || !Array.isArray(v.legal)) { if (S.host && v) S.host.sendState(v); return; }
    if (v.legal.indexOf(move) === -1) { S.host.sendState(v); return; }
    S.busy = true;
    msg(EL['board-msg'], '');
    text(EL['board-status'], v.mode === 'bot' ? 'The bot is thinking…' : 'Sending your move…');
    Api.post('matches/' + v.id + '/move', { ply: v.ply, move: move }).then(function (r) {
      S.busy = false;
      showMatch(r.match);
    }, function (e) {
      S.busy = false;
      if (pageLevel(e)) return;
      if (e.status === 429) msg(EL['board-msg'], 'Slow down a little — one move a second.');
      else msg(EL['board-msg'], boardErrText(e));
      // Whatever went wrong, draw the server's board again (§19.7: a rejected move redraws).
      reloadCurrent();
    });
  }

  function reloadCurrent() {
    var v = S.current;
    if (!v) return;
    Api.get('matches/' + v.id).then(function (r) { showMatch(r.match); }, function (e) {
      if (!pageLevel(e) && S.host && S.current) S.host.sendState(S.current);
    });
  }

  // One board action: POST matches/<id>/<path>, then draw whatever the server answers. A
  // refusal redraws the server's board too (the game may have moved on under us).
  function boardAct(path, body, after) {
    var v = S.current;
    if (!v || S.busy) return;
    S.busy = true;
    msg(EL['board-msg'], '');
    Api.post('matches/' + int(v.id) + '/' + path, body || {}).then(function (r) {
      S.busy = false;
      showMatch(r.match);
      if (after) after(r.match);
    }, function (e) {
      S.busy = false;
      if (pageLevel(e)) return;
      if (e.status === 429) msg(EL['board-msg'], 'Slow down a little — one action a second.');
      else msg(EL['board-msg'], boardErrText(e));
      reloadCurrent();
    });
  }
  // A seat was taken or a seek/challenge closed: balances and both lists changed.
  function changed() {
    refreshMe();
    loadMine(true).catch(function () {});
    pollTurns();
  }

  confirmButton(EL['btn-resign'], 'Resign', 'Confirm resign', function () { boardAct('resign'); });
  confirmButton(EL['btn-abort'], 'Abort', 'Confirm abort', function () { boardAct('abort'); });
  EL['btn-draw-offer'].addEventListener('click', function () { boardAct('draw', { action: 'offer' }); });
  confirmButton(EL['btn-draw-accept'], 'Accept draw', 'Confirm draw', function () { boardAct('draw', { action: 'accept' }); });
  EL['btn-draw-decline'].addEventListener('click', function () { boardAct('draw', { action: 'decline' }); });
  confirmButton(EL['btn-accept'], 'Accept', 'Confirm — costs a ticket', function () { boardAct('accept', {}, changed); });
  confirmButton(EL['btn-decline'], 'Decline', 'Confirm decline', function () { boardAct('decline', {}, changed); });
  confirmButton(EL['btn-cancel'], 'Cancel seek', 'Confirm cancel', function () { boardAct('cancel', {}, changed); });

  window.addEventListener('hashchange', function () {
    var id = hashMatchId();
    if (id && S.me && (!S.current || S.current.id !== id)) openMatch(id);
  });

  boot();
})();
