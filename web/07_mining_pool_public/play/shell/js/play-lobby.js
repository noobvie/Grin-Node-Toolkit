/* play-lobby.js — "Play a person" on /play/ (design §19.8, Part 10).
 *
 * Posting a seek or a direct challenge, the open seeks, and the challenges addressed to the
 * signed-in player. It talks to play-shell.js only through DOM events, as the other panels do:
 *   in   play:me     { me }   signed in (an object) or out (null) — load or clear the panel
 *   in   play:turns  { … }    the shell's cheap poll; a change in `challenges` reloads the lists
 *   out  play:open   { id }   show this match on the board
 *   out  play:changed         a match was created / accepted / closed: reload My games + /me
 *
 * Nothing polls here: the lists load when the player signs in, after every action, when the
 * shell's turns poll sees a new challenge, and on "Refresh". Every value from the API reaches
 * the DOM through textContent — this file has NO innerHTML (test-shell.js enforces it). The
 * opponent's address is typed by the player and goes in a JSON body, never in a URL.
 */
(function () {
  'use strict';

  var Api = window.PlayApi;
  if (!Api) return;

  var CONFIRM_MS = 5000;

  function $(id) { return document.getElementById(id); }
  function text(el, s) { if (el) el.textContent = s == null ? '' : String(s); }
  function show(el, on) { if (el) el.hidden = !on; }
  function clear(el) { while (el && el.firstChild) el.removeChild(el.firstChild); }
  function msg(el, s, kind) {
    if (!el) return;
    el.textContent = s || '';
    el.className = 'acct-msg' + (s ? (kind === 'ok' ? ' ok' : ' err') : '');
  }
  function int(n) { return typeof n === 'number' && isFinite(n) ? String(Math.trunc(n)) : '—'; }
  function fmtLeft(sec) {
    if (sec <= 0) return 'expiring';
    var d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
    if (d > 0) return d + 'd ' + h + 'h left';
    if (h > 0) return h + 'h ' + m + 'm left';
    return Math.max(1, m) + 'm left';
  }
  function fmtMoveTime(s) {
    if (s % 86400 === 0) { var d = s / 86400; return d + (d === 1 ? ' day' : ' days'); }
    if (s % 3600 === 0) { var h = s / 3600; return h + (h === 1 ? ' hour' : ' hours'); }
    return Math.round(s / 60) + ' min';
  }
  var nowS = function () { return Math.floor(Date.now() / 1000); };
  function emit(name, detail) {
    try { document.dispatchEvent(new CustomEvent(name, { detail: detail || {} })); } catch (e) { /* nobody listening */ }
  }

  var EL = {};
  ['lobby-panel', 'pvp-form', 'pvp-game-field', 'pvp-game', 'pvp-target', 'pvp-colour', 'pvp-time', 'pvp-hint', 'pvp-submit', 'pvp-msg',
   'lobby-challenges', 'lobby-challenges-empty', 'lobby-seeks', 'lobby-seeks-empty', 'lobby-refresh', 'lobby-msg',
   'rule-pvp', 'rule-pvp-cost'].forEach(function (id) { EL[id] = $(id); });
  if (!EL['lobby-panel']) return;

  var S = { me: null, games: [], game: null, busy: false, challenges: null, seq: 0, rules: null };

  // Errors the player can act on, in their words. Anything else: the server's own sentence.
  var ERROR_TEXT = {
    no_plays: 'You have no plays left. Plays come from your mining minutes.',
    too_many_open: 'You already have the most open seeks and challenges allowed. Cancel one first.',
    too_many_matches: 'You already have the most games in progress allowed. Finish one first.',
    opponent_busy: 'That player already has the most games in progress allowed. Try again later.',
    self_match: 'That is your own address.',
    not_open: 'Someone else took that game first, or it was withdrawn.',
    expired: 'That game expired — the play was refunded to whoever posted it.'
  };
  function errText(e) {
    if (e && e.kind === 'offline') return e.message;
    if (e && e.code === 'bad_request' && e.body && e.body.field === 'target') return 'That is not a GRIN address for this pool\'s network.';
    return (e && ERROR_TEXT[e.code]) || (e && e.message) || 'Something went wrong.';
  }

  // ── Setup from the loaded games + the live rules ────────────────────────────────────
  // The games that offer play between people, in registry order. With more than one, the
  // form shows a Game picker; a new game folder appears here with no shell change.
  function pvpGames(games) {
    return games.filter(function (g) {
      return g && typeof g.id === 'string' && Array.isArray(g.modes) && g.modes.indexOf('pvp') !== -1;
    });
  }

  function fillGames(games) {
    S.games = pvpGames(games);
    var sel = EL['pvp-game'];
    clear(sel);
    S.games.forEach(function (g) {
      var o = document.createElement('option');
      o.value = g.id;
      o.textContent = g.title;
      sel.appendChild(o);
    });
    show(EL['pvp-game-field'], S.games.length > 1);
    fillForm();
  }

  function fillForm() {
    var g = null;
    for (var i = 0; i < S.games.length; i++) if (S.games[i].id === EL['pvp-game'].value) g = S.games[i];
    g = g || S.games[0] || null;
    var sel = EL['pvp-time'];
    clear(sel);
    S.game = g;
    EL['pvp-submit'].disabled = !g;
    if (!g) { msg(EL['pvp-msg'], 'No game against people is available right now.'); return; }
    msg(EL['pvp-msg'], '');
    (g.move_seconds_options || []).forEach(function (s) {
      if (typeof s !== 'number' || !(s > 0)) return;
      var o = document.createElement('option');
      o.value = String(s);
      o.textContent = fmtMoveTime(s) + ' per move';
      if (s === g.default_move_seconds) o.selected = true;
      sel.appendChild(o);
    });
  }
  EL['pvp-game'].addEventListener('change', fillForm);

  function applyRules(r) {
    var p = (r && r.plays) || {}, v = (r && r.pvp) || {};
    if (typeof p.pvp_play_cost === 'number') {
      text(EL['pvp-hint'], 'Empty address = an open seek anyone can take. ' + (p.pvp_play_cost === 0
        ? 'Games against people are free right now, and a free game pays no points.'
        : 'Each side pays ' + int(p.pvp_play_cost) + (p.pvp_play_cost === 1 ? ' play' : ' plays') +
          '; it comes back if nobody accepts within 3 days, or if the game is aborted before both sides have moved.'));
      text(EL['rule-pvp-cost'], p.pvp_play_cost === 0
        ? 'Games against other miners are free right now — and a free game pays no points;'
        : 'A game against another miner costs each side ' + int(p.pvp_play_cost) + (p.pvp_play_cost === 1 ? ' play;' : ' plays;'));
    }
    if (typeof v.pair_rated_daily === 'number') {
      text(EL['rule-pvp'], v.pair_rated_daily === 0
        ? 'Right now no game against a person is rated: none moves the rating or pays points.'
        : 'The first ' + int(v.pair_rated_daily) + ' game' + (v.pair_rated_daily === 1 ? '' : 's') +
          ' a UTC day between the same two addresses ' + (v.pair_rated_daily === 1 ? 'is' : 'are') +
          ' rated: ' + (v.pair_rated_daily === 1 ? 'it moves' : 'they move') + ' the Elo rating and pay points for a win or a draw.');
    }
  }

  // ── Lists ───────────────────────────────────────────────────────────────────────────
  // A two-click button: the first click arms it for 5 s, the second acts.
  function armed(btn, label, confirmLabel, action) {
    var on = false, timer = null;
    btn.textContent = label;
    btn.addEventListener('click', function () {
      if (!on) {
        on = true;
        btn.textContent = confirmLabel;
        btn.classList.add('play-armed');
        timer = setTimeout(function () { on = false; btn.textContent = label; btn.classList.remove('play-armed'); }, CONFIRM_MS);
        return;
      }
      if (timer) clearTimeout(timer);
      on = false;
      btn.classList.remove('play-armed');
      btn.textContent = label;
      action();
    });
    return btn;
  }

  function button(label) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn sm';
    b.textContent = label;
    return b;
  }

  function costWord() {
    var c = S.rules && S.rules.plays && typeof S.rules.plays.pvp_play_cost === 'number' ? S.rules.plays.pvp_play_cost : 1;
    return c === 0 ? 'free' : c + (c === 1 ? ' play' : ' plays');
  }

  // row = a lobby entry: { id, game_id, name, you_play, move_seconds, expires_at, own }
  function lobbyRow(row, kind) {
    var li = document.createElement('li');
    li.className = 'play-mine-row';
    var info = document.createElement('span');
    info.className = 'play-mine-info';
    var line1 = document.createElement('span');
    var colour = row.you_play === 1 ? 'white' : row.you_play === 2 ? 'black' : '';
    line1.textContent = (row.own ? 'Your seek' : row.name) + (colour && !row.own ? ' · you would play ' + colour : '');
    var line2 = document.createElement('small');
    line2.textContent = fmtMoveTime(row.move_seconds) + ' per move · ' + fmtLeft(row.expires_at - nowS());
    info.appendChild(line1);
    info.appendChild(line2);
    li.appendChild(info);

    var btns = document.createElement('span');
    btns.className = 'play-account-btns';
    var view = button('View');
    view.addEventListener('click', function () { emit('play:open', { id: row.id }); });
    btns.appendChild(view);
    if (row.own) {
      btns.appendChild(armed(button(''), 'Cancel', 'Confirm cancel', function () { act(row.id, 'cancel', 'Seek withdrawn; your play is back.'); }));
    } else {
      btns.appendChild(armed(button(''), 'Accept', 'Accept · ' + costWord(), function () { act(row.id, 'accept', null); }));
      if (kind === 'challenge') btns.appendChild(armed(button(''), 'Decline', 'Confirm decline', function () { act(row.id, 'decline', 'Challenge declined.'); }));
    }
    li.appendChild(btns);
    return li;
  }

  function render(r) {
    var ch = Array.isArray(r.challenges) ? r.challenges : [];
    var sk = Array.isArray(r.seeks) ? r.seeks : [];
    clear(EL['lobby-challenges']);
    ch.forEach(function (x) { EL['lobby-challenges'].appendChild(lobbyRow(x, 'challenge')); });
    show(EL['lobby-challenges-empty'], ch.length === 0);
    clear(EL['lobby-seeks']);
    sk.forEach(function (x) { EL['lobby-seeks'].appendChild(lobbyRow(x, 'seek')); });
    show(EL['lobby-seeks-empty'], sk.length === 0);
    S.challenges = ch.length;
  }

  function load() {
    if (!S.me) return;
    var seq = ++S.seq;
    msg(EL['lobby-msg'], '');
    Api.get('lobby').then(function (r) {
      if (seq !== S.seq || !S.me) return;
      render(r);
    }, function (e) {
      if (seq !== S.seq) return;
      msg(EL['lobby-msg'], errText(e));
    });
  }
  EL['lobby-refresh'].addEventListener('click', load);

  function act(id, what, done) {
    if (S.busy || typeof id !== 'number' || !(id > 0)) return;
    S.busy = true;
    msg(EL['lobby-msg'], '');
    Api.post('matches/' + int(id) + '/' + what, {}).then(function (r) {
      S.busy = false;
      if (done) msg(EL['lobby-msg'], done, 'ok');
      emit('play:changed');
      if (what === 'accept' && r.match) emit('play:open', { id: r.match.id });
      load();
    }, function (e) {
      S.busy = false;
      msg(EL['lobby-msg'], errText(e));
      load();
    });
  }

  // ── Post a seek / challenge ─────────────────────────────────────────────────────────
  EL['pvp-form'].addEventListener('submit', function (ev) {
    ev.preventDefault();
    var g = S.game;
    if (!g || S.busy) return;
    var target = EL['pvp-target'].value.trim();
    var colour = EL['pvp-colour'].value;
    var secs = parseInt(EL['pvp-time'].value, 10);
    if (target && !/^t?grin1[a-z0-9]{58}$/.test(target)) { msg(EL['pvp-msg'], 'That is not a GRIN address.'); return; }
    if (S.me && target && target === S.me.address) { msg(EL['pvp-msg'], ERROR_TEXT.self_match); return; }
    if (['random', 'seat1', 'seat2'].indexOf(colour) === -1 || !(secs > 0)) return;
    var body = { game_id: g.id, mode: 'pvp', colour: colour, move_seconds: secs };
    if (target) body.target = target;
    S.busy = true;
    EL['pvp-submit'].disabled = true;
    msg(EL['pvp-msg'], 'Posting…', 'ok');
    Api.post('matches', body).then(function (r) {
      EL['pvp-target'].value = '';
      msg(EL['pvp-msg'], target
        ? 'Challenge sent. It waits up to 3 days for them to accept.'
        : 'Seek posted. Anyone signed in can take it within 3 days.', 'ok');
      emit('play:changed');
      if (r.match) emit('play:open', { id: r.match.id });
      load();
    }, function (e) {
      msg(EL['pvp-msg'], errText(e));
    }).then(function () {
      S.busy = false;
      EL['pvp-submit'].disabled = !S.game;
    });
  });

  // ── Page state (from play-shell.js) ─────────────────────────────────────────────────
  document.addEventListener('play:me', function (e) {
    var me = e && e.detail ? e.detail.me : null;
    var was = S.me;
    S.me = me && typeof me === 'object' ? me : null;
    if (!S.me) {
      S.challenges = null;
      clear(EL['lobby-challenges']);
      clear(EL['lobby-seeks']);
      msg(EL['pvp-msg'], '');
      msg(EL['lobby-msg'], '');
      return;
    }
    if (was) return;               // a /me refresh, not a sign-in
    Api.get('games').then(function (r) {
      fillGames(Array.isArray(r.games) ? r.games : []);
    }, function (e2) { msg(EL['pvp-msg'], errText(e2)); });
    if (!S.rules) {
      Api.get('rules').then(function (r) { S.rules = r; applyRules(r); }, function () { /* the defaults stay */ });
    }
    load();
  });

  // The shell's cheap poll: a new (or answered) challenge reloads the lists.
  document.addEventListener('play:turns', function (e) {
    var t = e && e.detail;
    if (!S.me || !t || typeof t.challenges !== 'number') return;
    if (S.challenges !== null && t.challenges !== S.challenges) load();
  });
})();
