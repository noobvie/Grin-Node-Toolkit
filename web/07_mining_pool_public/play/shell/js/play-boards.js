/* play-boards.js — the Leaderboards & events panel on /play/ (design §19.9, Part 7).
 *
 * Public while the games are open: shown signed in OR out (play-shell.js announces the page
 * state with a `play:view` event and on <body data-play-view>). Signed in, the server also
 * flags the caller's own row and returns their rank as `you` — it never needs to send the
 * caller's address for that, and no list here ever carries a full one (D19).
 *
 * Every value reaches the DOM through textContent — this file has NO innerHTML (test-shell.js
 * enforces it) and no inline handler. Event titles are operator text and rendered as text.
 *
 * Nothing polls: boards are cached for a minute server-side, so a board is fetched when the
 * panel opens, when a control changes, and on "Refresh".
 */
(function () {
  'use strict';

  var Api = window.PlayApi;
  if (!Api) return;

  function $(id) { return document.getElementById(id); }
  function text(el, s) { if (el) el.textContent = s == null ? '' : String(s); }
  function show(el, on) { if (el) el.hidden = !on; }
  function clear(el) { while (el && el.firstChild) el.removeChild(el.firstChild); }
  function msg(el, s) { if (!el) return; el.textContent = s || ''; el.className = 'acct-msg' + (s ? ' err' : ''); }
  function int(n) { return typeof n === 'number' && isFinite(n) ? String(Math.trunc(n)) : '—'; }
  function pad(n) { return n < 10 ? '0' + n : String(n); }
  function fmtUtc(s) {
    if (typeof s !== 'number' || !isFinite(s)) return '—';
    var d = new Date(s * 1000);
    return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()) + ' ' +
      pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) + ' UTC';
  }

  var EL = {};
  ['play-boards', 'tab-boards', 'tab-events', 'pane-boards', 'pane-events',
   'lb-board', 'lb-period', 'lb-note', 'lb-unit', 'lb-rows', 'lb-empty', 'lb-you', 'lb-msg', 'lb-refresh',
   'ev-list', 'ev-empty', 'ev-detail', 'ev-title', 'ev-state', 'ev-desc', 'ev-when', 'ev-rewards', 'ev-unit',
   'ev-rows', 'ev-rows-empty', 'ev-note', 'ev-you', 'ev-back', 'ev-msg'].forEach(function (id) { EL[id] = $(id); });
  if (!EL['play-boards']) return;

  var S = { open: false, signedIn: false, tab: 'boards', boards: null, event: null };

  var UNIT = { points: 'Points', wins: 'Wins', rating: 'Rating', minutes: 'Minutes', days: 'Days' };
  var STATE = {
    scheduled: 'Upcoming', running: 'Running', finalising: 'Counting results', done: 'Finished', cancelled: 'Cancelled'
  };
  var PERIOD_NOTE = {
    day: 'Today, UTC.', week: 'This week, Monday to Sunday UTC.', month: 'This calendar month, UTC.', all: 'All time.'
  };

  // ── Tabs ────────────────────────────────────────────────────────────────────────────
  function selectTab(tab, focus) {
    S.tab = tab;
    var boards = tab === 'boards';
    EL['tab-boards'].setAttribute('aria-selected', boards ? 'true' : 'false');
    EL['tab-events'].setAttribute('aria-selected', boards ? 'false' : 'true');
    EL['tab-boards'].tabIndex = boards ? 0 : -1;
    EL['tab-events'].tabIndex = boards ? -1 : 0;
    show(EL['pane-boards'], boards);
    show(EL['pane-events'], !boards);
    if (focus) (boards ? EL['tab-boards'] : EL['tab-events']).focus();
    load();
  }
  EL['tab-boards'].addEventListener('click', function () { selectTab('boards'); });
  EL['tab-events'].addEventListener('click', function () { selectTab('events'); });
  [EL['tab-boards'], EL['tab-events']].forEach(function (b) {
    b.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        e.preventDefault();
        selectTab(S.tab === 'boards' ? 'events' : 'boards', true);
      }
    });
  });

  function load() {
    if (!S.open) return;
    if (S.tab === 'boards') loadBoard(); else if (S.event) openEvent(S.event); else loadEvents();
  }

  // ── Leaderboards ────────────────────────────────────────────────────────────────────
  // The board picker is built from the loaded games: the points-held board, then per game
  // wins and points against the bot (a bot mode) and the rating, wins and points between
  // players (a pvp mode). Only RATED PvP games count on the PvP boards (§19.8).
  function fillBoards(games) {
    var sel = EL['lb-board'];
    var keep = sel.value;
    clear(sel);
    var opts = [{ v: 'points', t: 'Points held — all time' }];
    games.forEach(function (g) {
      if (!g || typeof g.id !== 'string' || !/^[a-z0-9-]{2,32}$/.test(g.id)) return;
      if (Array.isArray(g.modes) && g.modes.indexOf('bot') !== -1) {
        opts.push({ v: 'wins|' + g.id + '|bot', t: g.title + ' — wins vs the bot' });
        opts.push({ v: 'points|' + g.id + '|bot', t: g.title + ' — points vs the bot' });
      }
      if (Array.isArray(g.modes) && g.modes.indexOf('pvp') !== -1) {
        opts.push({ v: 'rating|' + g.id + '|pvp', t: g.title + ' — rating (players)' });
        opts.push({ v: 'wins|' + g.id + '|pvp', t: g.title + ' — wins vs players' });
        opts.push({ v: 'points|' + g.id + '|pvp', t: g.title + ' — points vs players' });
      }
    });
    opts.forEach(function (o) {
      var el = document.createElement('option');
      el.value = o.v;
      el.textContent = o.t;
      sel.appendChild(el);
    });
    if (keep && opts.some(function (o) { return o.v === keep; })) sel.value = keep;
    syncPeriod();
  }

  // Points held and the rating are all-time boards only.
  function allTimeOnly(v) { return v === 'points' || v.indexOf('rating|') === 0; }
  function syncPeriod() {
    var held = allTimeOnly(EL['lb-board'].value);
    EL['lb-period'].disabled = held;
    if (held) EL['lb-period'].value = 'all';
  }

  function boardPath() {
    var v = EL['lb-board'].value || 'points';
    if (v === 'points') return 'leaderboard?board=points';
    var p = v.split('|');
    if (p[0] === 'rating') return 'leaderboard?board=rating&game=' + p[1];
    var period = EL['lb-period'].value;
    if (['day', 'week', 'month', 'all'].indexOf(period) === -1) period = 'all';
    return 'leaderboard?board=' + p[0] + '&game=' + p[1] + '&mode=' + p[2] + '&period=' + period;
  }

  function rankRow(r, cells) {
    var tr = document.createElement('tr');
    if (r.own) tr.className = 'is-own';
    cells.forEach(function (c, i) {
      var td = document.createElement('td');
      if (i === 1) td.className = 'mono';
      td.textContent = c;
      tr.appendChild(td);
    });
    if (r.own) {
      var you = document.createElement('span');
      you.className = 'play-you-tag';
      you.textContent = ' you';
      tr.children[1].appendChild(you);
    }
    return tr;
  }

  var boardSeq = 0;
  function loadBoard() {
    var seq = ++boardSeq;
    msg(EL['lb-msg'], '');
    var path = boardPath();
    function go() {
      return Api.get(path).then(function (b) {
        if (seq !== boardSeq) return;
        var unit = UNIT[b.unit] || 'Value';
        text(EL['lb-unit'], unit);
        var note = b.board === 'points' && !b.game
          ? 'Points held now, all time. Event rewards count here too.'
          : b.board === 'rating'
            ? 'Elo from rated games between players, all time. A player appears after 5 rated games.'
            : (PERIOD_NOTE[b.period] || '') + (b.from ? ' ' + b.from + (b.to !== b.from ? ' to ' + b.to : '') + '.' : '');
        text(EL['lb-note'], note + ' Updated about once a minute.');
        var tb = EL['lb-rows'];
        clear(tb);
        (Array.isArray(b.rows) ? b.rows : []).forEach(function (r) {
          tb.appendChild(rankRow(r, [int(r.rank), r.name, int(r.value)]));
        });
        show(EL['lb-empty'], !tb.firstChild);
        if (b.you && S.signedIn) {
          text(EL['lb-you'], b.you.rank ? 'You are #' + int(b.you.rank) + ' of ' + int(b.total) + ' with ' + int(b.you.value) + ' ' + unit.toLowerCase() + '.'
            : 'You are not on this board yet.');
          show(EL['lb-you'], true);
        } else {
          show(EL['lb-you'], false);
        }
      });
    }
    var p = S.boards ? go() : Api.get('games').then(function (r) {
      S.boards = Array.isArray(r.games) ? r.games : [];
      fillBoards(S.boards);
      path = boardPath();
      return go();
    });
    p.catch(function (e) {
      if (seq !== boardSeq) return;
      msg(EL['lb-msg'], e && e.message ? e.message : 'The leaderboard could not be loaded.');
    });
  }
  EL['lb-board'].addEventListener('change', function () { syncPeriod(); loadBoard(); });
  EL['lb-period'].addEventListener('change', loadBoard);
  EL['lb-refresh'].addEventListener('click', loadBoard);

  // ── Events ──────────────────────────────────────────────────────────────────────────
  function when(ev) {
    var days = ev.first_day === ev.last_day ? ev.first_day : ev.first_day + ' to ' + ev.last_day;
    return days + ' (UTC)';
  }

  function stateChip(state) {
    var s = document.createElement('span');
    s.className = 'play-chip st-' + (STATE[state] ? state : 'unknown');
    s.textContent = STATE[state] || state;
    return s;
  }

  function rewardLines(ev) {
    var out = [];
    var unit = (UNIT[ev.unit] || 'value').toLowerCase();
    var rw = ev.reward || {};
    (rw.tiers || []).forEach(function (t) {
      var who = t.rank_from === t.rank_to ? '#' + int(t.rank_from) : '#' + int(t.rank_from) + '–' + int(t.rank_to);
      var what = [];
      if (t.points > 0) what.push(int(t.points) + ' points');
      if (t.badge_label) what.push('the ' + t.badge_label + ' badge');
      if (what.length) out.push(who + ': ' + what.join(' + '));
    });
    var p = rw.participation;
    if (p) {
      var pw = [];
      if (p.points > 0) pw.push(int(p.points) + ' points');
      if (p.badge_label) pw.push('the ' + p.badge_label + ' badge');
      if (pw.length) out.push('Everyone else with at least ' + int(p.min_value) + ' ' + unit + ': ' + pw.join(' + '));
    }
    return out;
  }

  function loadEvents() {
    msg(EL['ev-msg'], '');
    show(EL['ev-detail'], false);
    show(EL['ev-list'], true);
    Api.get('events').then(function (r) {
      var ul = EL['ev-list'];
      clear(ul);
      (Array.isArray(r.events) ? r.events : []).forEach(function (ev) {
        if (!ev || typeof ev.id !== 'number') return;
        var li = document.createElement('li');
        li.className = 'play-event-row';
        var info = document.createElement('span');
        info.className = 'play-event-info';
        var head = document.createElement('span');
        head.className = 'play-event-head';
        var title = document.createElement('b');
        title.textContent = ev.title;
        head.appendChild(title);
        head.appendChild(stateChip(ev.state));
        var sub = document.createElement('small');
        sub.textContent = when(ev) + ' · ' + (ev.description || ev.kind_label || '');
        info.appendChild(head);
        info.appendChild(sub);
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn sm';
        btn.textContent = ev.state === 'scheduled' ? 'Details' : 'Standings';
        btn.setAttribute('aria-label', btn.textContent + ': ' + ev.title);
        btn.addEventListener('click', function () { openEvent(ev.id); });
        li.appendChild(info);
        li.appendChild(btn);
        ul.appendChild(li);
      });
      show(EL['ev-empty'], !ul.firstChild);
    }, function (e) {
      msg(EL['ev-msg'], e && e.message ? e.message : 'Events could not be loaded.');
    });
  }

  function openEvent(id) {
    S.event = id;
    msg(EL['ev-msg'], '');
    Api.get('events/' + int(id)).then(function (r) {
      if (S.event !== id) return;
      var ev = r.event;
      show(EL['ev-list'], false);
      show(EL['ev-empty'], false);
      show(EL['ev-detail'], true);
      text(EL['ev-title'], ev.title);
      clear(EL['ev-state']);
      EL['ev-state'].appendChild(stateChip(ev.state));
      text(EL['ev-desc'], ev.description);
      text(EL['ev-when'], when(ev));
      var ul = EL['ev-rewards'];
      clear(ul);
      rewardLines(ev).forEach(function (line) {
        var li = document.createElement('li');
        li.textContent = line;
        ul.appendChild(li);
      });
      if (!ul.firstChild) {
        var none = document.createElement('li');
        none.textContent = 'No rewards: this one is for bragging rights.';
        ul.appendChild(none);
      }
      var unit = UNIT[ev.unit] || 'Value';
      text(EL['ev-unit'], unit);
      var st = r.standings;
      var tb = EL['ev-rows'];
      clear(tb);
      if (st && Array.isArray(st.rows)) {
        st.rows.forEach(function (x) {
          var reward = st.final
            ? ((x.reward_points > 0 ? '+' + int(x.reward_points) : '') + (x.badge_label ? (x.reward_points > 0 ? ' · ' : '') + x.badge_label : '')) || '—'
            : '—';
          tb.appendChild(rankRow(x, [int(x.rank), x.name, int(x.value), reward]));
        });
      }
      show(EL['ev-rows'].parentNode, !!(st && tb.firstChild));
      // The Reward column only means something once results are counted.
      EL['ev-rows'].parentNode.classList.toggle('no-reward', !(st && st.final));
      var empty = !st ? (ev.state === 'scheduled' ? 'Starts ' + ev.first_day + ' (UTC). Standings appear once it is running.'
        : ev.state === 'cancelled' ? 'This event was cancelled. No rewards are paid.' : '')
        : (!tb.firstChild ? 'Nobody has scored yet.' : '');
      text(EL['ev-rows-empty'], empty);
      show(EL['ev-rows-empty'], !!empty);
      text(EL['ev-note'], st && !st.final
        ? 'Provisional. Final results are counted after the event ends, at about ' + fmtUtc(ev.finalises_at) + '. Rewards are points and badges, never GRIN.'
        : (st && st.final ? int(st.total) + ' ranked. Rewards are points and badges, never GRIN.' : ''));
      if (r.you && S.signedIn) {
        text(EL['ev-you'], r.you.rank
          ? 'You are #' + int(r.you.rank) + ' with ' + int(r.you.value) + ' ' + unit.toLowerCase() + '.'
            + (st && st.final && (r.you.reward_points > 0 || r.you.badge) ? ' Your reward has been added.' : '')
          : 'You are not ranked in this event yet.');
        show(EL['ev-you'], true);
      } else {
        show(EL['ev-you'], false);
      }
    }, function (e) {
      if (S.event !== id) return;
      S.event = null;
      loadEvents();
      msg(EL['ev-msg'], e && e.status === 404 ? 'That event is not available.' : (e && e.message ? e.message : 'The event could not be loaded.'));
    });
  }
  EL['ev-back'].addEventListener('click', function () { S.event = null; loadEvents(); EL['tab-events'].focus(); });

  // ── Page state (from play-shell.js) ─────────────────────────────────────────────────
  function onView(view) {
    var open = view === 'login' || view === 'in';
    var signedIn = view === 'in';
    var changed = open !== S.open || signedIn !== S.signedIn;
    S.open = open;
    S.signedIn = signedIn;
    show(EL['play-boards'], open);
    if (open && changed) load();
  }
  document.addEventListener('play:view', function (e) {
    if (e && e.detail && typeof e.detail.view === 'string') onView(e.detail.view);
  });
  if (document.body && document.body.getAttribute('data-play-view')) onView(document.body.getAttribute('data-play-view'));
})();
