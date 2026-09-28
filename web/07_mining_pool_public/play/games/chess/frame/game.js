/* game.js — the chess frame (design §19.7, D13). Runs sandboxed; NEVER an authority.
 *
 * It draws the `state` the shell sends and posts back one `move`. The server re-checks
 * every move (rules.apply inside the move transaction, §19.8); the copy of rules.js loaded
 * here is used for UI hints only — the optimistic board after a move and the check marker.
 *
 * Protocol (§19.7, protocol 1). Inbound messages are accepted only from window.parent and
 * only when they match the schema exactly:
 *   shell → frame  state { position, last_move, you, to_move, legal?, status, labels }
 *   shell → frame  theme { mode: 'dark' | 'light' }
 *   frame → shell  ready { protocol: 1 }        move { move }
 * Posted to the parent with targetOrigin '*': this document's origin is opaque, so it cannot
 * name the parent's origin, and frame-ancestors 'self' already fixes who the parent is. A
 * move is not a secret.
 *
 * After posting a move the frame shows it provisionally and takes no more input until the
 * next `state` arrives — which is the server's board, legal or not (a rejected move redraws).
 */
(function () {
  'use strict';

  var PROTOCOL = 1;
  var MOVE_RE = /^[a-h][1-8][a-h][1-8][qrbn]?$/;   // manifest move_pattern
  var FEN_MAX = 100;
  var LEGAL_MAX = 512;
  var LABEL_MAX = 64;
  var R = window.GrinChessRules || null;
  var FILES = 'abcdefgh';

  // Solid glyphs for both sides (CSS colours them); U+FE0E asks for the text presentation so
  // a phone does not swap in an emoji pawn.
  var GLYPH = { k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟' };
  var NAME = { k: 'king', q: 'queen', r: 'rook', b: 'bishop', n: 'knight', p: 'pawn' };
  var VS = '︎';

  var boardEl = document.getElementById('board');
  var promoEl = document.getElementById('promo');
  var promoRow = document.getElementById('promo-row');
  var liveEl = document.getElementById('live');

  var state = null;          // the last valid `state` from the shell
  var awaiting = false;      // a move was posted; input is locked until the next state
  var provisional = null;    // { fen, move } shown while awaiting
  var sel = null;            // selected square name, e.g. 'e2'
  var focusSq = 'e2';        // roving tabindex target
  var orientation = 1;       // 1 = white at the bottom
  var squares = {};          // name → button
  var drag = null;
  var suppressClick = false;
  var lastAnnounced = null;

  // ── Validation of inbound messages ───────────────────────────────────────────────
  function isPlain(v) { return v !== null && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype; }
  function keysWithin(o, allowed, required) {
    var k = Object.keys(o);
    for (var i = 0; i < k.length; i++) if (allowed.indexOf(k[i]) === -1) return false;
    for (var j = 0; j < required.length; j++) if (!Object.prototype.hasOwnProperty.call(o, required[j])) return false;
    return true;
  }
  function seatOrNull(v) { return v === 1 || v === 2 || v === null; }
  function validState(d) {
    if (!keysWithin(d, ['type', 'position', 'last_move', 'you', 'to_move', 'legal', 'status', 'labels'],
      ['type', 'position', 'last_move', 'you', 'to_move', 'status', 'labels'])) return false;
    if (typeof d.position !== 'string' || !d.position || d.position.length > FEN_MAX) return false;
    if (!/^[pnbrqkPNBRQK1-8/]+ [wb] (-|[KQkq]{1,4}) (-|[a-h][36]) \d{1,3} \d{1,4}$/.test(d.position)) return false;
    if (d.last_move !== null && (typeof d.last_move !== 'string' || !MOVE_RE.test(d.last_move))) return false;
    if (!seatOrNull(d.you) || !seatOrNull(d.to_move)) return false;
    if (d.legal !== undefined) {
      if (!Array.isArray(d.legal) || d.legal.length > LEGAL_MAX) return false;
      for (var i = 0; i < d.legal.length; i++) if (typeof d.legal[i] !== 'string' || !MOVE_RE.test(d.legal[i])) return false;
    }
    if (!isPlain(d.status) || typeof d.status.over !== 'boolean') return false;
    if (!isPlain(d.labels)) return false;
    if (typeof d.labels[1] !== 'string' || typeof d.labels[2] !== 'string') return false;
    if (d.labels[1].length > LABEL_MAX || d.labels[2].length > LABEL_MAX) return false;
    return true;
  }

  // ── FEN helpers (drawing only) ───────────────────────────────────────────────────
  function pieceMap(fen) {
    var out = {};
    var rows = fen.split(' ')[0].split('/');
    for (var r = 0; r < 8 && r < rows.length; r++) {
      var f = 0;
      for (var i = 0; i < rows[r].length && f < 8; i++) {
        var c = rows[r].charAt(i);
        if (c >= '1' && c <= '8') { f += c.charCodeAt(0) - 48; continue; }
        out[FILES.charAt(f) + (8 - r)] = c;
        f++;
      }
    }
    return out;
  }
  function sideOf(pc) { return pc === pc.toUpperCase() ? 1 : 2; }
  function activeSeat(fen) { return fen.split(' ')[1] === 'b' ? 2 : 1; }

  // ── Board construction (once per orientation) ────────────────────────────────────
  function coord(kind, s) {
    var c = document.createElement('span');
    c.className = 'coord ' + kind;
    c.setAttribute('aria-hidden', 'true');
    c.textContent = s;
    return c;
  }

  function build() {
    while (boardEl.firstChild) boardEl.removeChild(boardEl.firstChild);
    squares = {};
    for (var row = 0; row < 8; row++) {
      var line = document.createElement('div');
      line.setAttribute('role', 'row');
      line.className = 'rank';
      for (var col = 0; col < 8; col++) {
        var file = orientation === 1 ? col : 7 - col;
        var rank = orientation === 1 ? 8 - row : row + 1;
        var name = FILES.charAt(file) + rank;
        var b = document.createElement('button');
        b.type = 'button';
        b.setAttribute('role', 'gridcell');
        b.className = 'sq ' + ((file + rank) % 2 === 1 ? 'dark' : 'light');   // a1 (0+1) dark, h1 light
        b.setAttribute('data-sq', name);
        b.tabIndex = -1;
        var pc = document.createElement('span');   // stays firstChild: render() writes it
        pc.className = 'pc';
        pc.setAttribute('aria-hidden', 'true');
        b.appendChild(pc);
        if (row === 7) b.appendChild(coord('file', FILES.charAt(file)));
        if (col === 0) b.appendChild(coord('rank', String(rank)));
        line.appendChild(b);
        squares[name] = b;
      }
      boardEl.appendChild(line);
    }
    boardEl.setAttribute('data-orientation', orientation === 1 ? 'white' : 'black');
  }

  // ── Input rules ──────────────────────────────────────────────────────────────────
  function canMove() {
    return !!(state && !awaiting && Array.isArray(state.legal) && state.legal.length &&
      !state.status.over && state.you !== null && state.you === state.to_move);
  }
  function movesFrom(sq) {
    if (!canMove()) return [];
    return state.legal.filter(function (m) { return m.slice(0, 2) === sq; });
  }
  function targetsOf(sq) {
    var t = {};
    movesFrom(sq).forEach(function (m) { t[m.slice(2, 4)] = true; });
    return t;
  }

  // ── Render ───────────────────────────────────────────────────────────────────────
  function render() {
    if (!state) return;
    var fen = provisional ? provisional.fen : state.position;
    var pieces = pieceMap(fen);
    var last = provisional ? provisional.move : state.last_move;
    var lastFrom = last ? last.slice(0, 2) : null;
    var lastTo = last ? last.slice(2, 4) : null;
    var targets = sel ? targetsOf(sel) : {};
    var checkSq = null;
    if (R && !state.status.over) {
      try {
        if (R.inCheck(fen)) {
          var kc = activeSeat(fen) === 1 ? 'K' : 'k';
          for (var s in pieces) if (pieces[s] === kc) checkSq = s;
        }
      } catch (e) { /* a hint only */ }
    }
    var mine = canMove();
    for (var name in squares) {
      var b = squares[name];
      var pc = pieces[name] || null;
      var span = b.firstChild;
      span.textContent = pc ? GLYPH[pc.toLowerCase()] + VS : '';
      span.className = 'pc' + (pc ? (sideOf(pc) === 1 ? ' w' : ' b') : '');
      b.classList.toggle('last', name === lastFrom || name === lastTo);
      b.classList.toggle('sel', name === sel);
      b.classList.toggle('target', !!targets[name]);
      b.classList.toggle('capture', !!targets[name] && !!pc);
      b.classList.toggle('check', name === checkSq);
      b.classList.toggle('movable', mine && !!pc && sideOf(pc) === state.you && movesFrom(name).length > 0);
      b.setAttribute('aria-label', name + (pc ? ', ' + (sideOf(pc) === 1 ? 'white ' : 'black ') + NAME[pc.toLowerCase()] : ', empty') +
        (targets[name] ? ', move here' : '') + (name === sel ? ', selected' : ''));
      b.tabIndex = name === focusSq ? 0 : -1;
    }
    boardEl.classList.toggle('locked', !mine);
    boardEl.classList.toggle('over', state.status.over);

    // Player strips: the viewer's own side at the bottom.
    var bottomSeat = orientation;
    var topSeat = orientation === 1 ? 2 : 1;
    var turnSeat = state.status.over ? null : (provisional ? (state.to_move === 1 ? 2 : 1) : state.to_move);
    setStrip('top', topSeat, turnSeat);
    setStrip('bottom', bottomSeat, turnSeat);

    if (last && last !== lastAnnounced && !provisional) {
      lastAnnounced = last;
      liveEl.textContent = 'Last move ' + last.slice(0, 2) + ' to ' + last.slice(2, 4) +
        (last.length === 5 ? ', promoted to ' + NAME[last.charAt(4)] : '') + '.';
    }
  }

  function setStrip(which, seat, turnSeat) {
    var strip = document.getElementById('strip-' + which);
    var name = document.getElementById('name-' + which);
    var label = state.labels[seat] || '';
    var you = state.you === seat;
    name.textContent = (seat === 1 ? 'White' : 'Black') + ' · ' + label + (you ? ' (you)' : '');
    strip.classList.toggle('to-move', turnSeat === seat);
    strip.classList.toggle('side-w', seat === 1);
    strip.classList.toggle('side-b', seat === 2);
  }

  // ── Moving ───────────────────────────────────────────────────────────────────────
  function send(move) {
    if (!MOVE_RE.test(move) || !canMove() || state.legal.indexOf(move) === -1) return;
    awaiting = true;
    sel = null;
    var fen = null;
    if (R) { try { fen = R.apply(state.position, move); } catch (e) { fen = null; } }
    provisional = fen ? { fen: fen, move: move } : null;
    hidePromo();
    render();
    window.parent.postMessage({ type: 'move', move: move }, '*');
  }

  function tryMove(from, to) {
    var cands = movesFrom(from).filter(function (m) { return m.slice(2, 4) === to; });
    if (!cands.length) return false;
    if (cands.length === 1) { send(cands[0]); return true; }
    showPromo(cands);
    return true;
  }

  function showPromo(cands) {
    while (promoRow.firstChild) promoRow.removeChild(promoRow.firstChild);
    ['q', 'r', 'b', 'n'].forEach(function (p) {
      var m = cands.filter(function (c) { return c.charAt(4) === p; })[0];
      if (!m) return;
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'promo-pc ' + (state.you === 1 ? 'w' : 'b');
      b.textContent = GLYPH[p] + VS;
      b.setAttribute('aria-label', 'Promote to ' + NAME[p]);
      b.addEventListener('click', function () { send(m); });
      promoRow.appendChild(b);
    });
    promoEl.hidden = false;
    if (promoRow.firstChild) promoRow.firstChild.focus();
  }
  function hidePromo() { promoEl.hidden = true; }
  document.getElementById('promo-cancel').addEventListener('click', function () {
    hidePromo();
    sel = null;
    render();
  });

  function onSquare(name) {
    if (!canMove() || !promoEl.hidden) return;
    focusSq = name;
    if (sel && sel !== name && tryMove(sel, name)) return;
    sel = movesFrom(name).length ? (sel === name ? null : name) : null;
    render();
  }

  boardEl.addEventListener('click', function (e) {
    if (suppressClick) { suppressClick = false; return; }
    var b = e.target.closest && e.target.closest('.sq');
    if (b) onSquare(b.getAttribute('data-sq'));
  });

  // Keyboard: one square is tabbable; arrows move around the board, Enter/Space selects
  // (the squares are buttons). Escape drops a selection.
  boardEl.addEventListener('keydown', function (e) {
    var b = e.target.closest && e.target.closest('.sq');
    if (!b) return;
    var name = b.getAttribute('data-sq');
    var f = FILES.indexOf(name.charAt(0));
    var r = Number(name.charAt(1));
    var up = orientation === 1 ? 1 : -1;
    var right = orientation === 1 ? 1 : -1;
    if (e.key === 'ArrowUp') r += up;
    else if (e.key === 'ArrowDown') r -= up;
    else if (e.key === 'ArrowRight') f += right;
    else if (e.key === 'ArrowLeft') f -= right;
    else if (e.key === 'Escape') { sel = null; render(); return; }
    else return;
    e.preventDefault();
    if (f < 0 || f > 7 || r < 1 || r > 8) return;
    focusSq = FILES.charAt(f) + r;
    render();
    squares[focusSq].focus();
  });

  // Drag: press on a movable piece, move a few pixels, release over a square.
  boardEl.addEventListener('pointerdown', function (e) {
    if (e.button !== 0 || !canMove() || !promoEl.hidden) return;
    var b = e.target.closest && e.target.closest('.sq');
    if (!b) return;
    var from = b.getAttribute('data-sq');
    if (!movesFrom(from).length) return;
    drag = { from: from, x: e.clientX, y: e.clientY, id: e.pointerId, ghost: null, src: b };
  });
  boardEl.addEventListener('pointermove', function (e) {
    if (!drag || e.pointerId !== drag.id) return;
    if (!drag.ghost) {
      if (Math.abs(e.clientX - drag.x) + Math.abs(e.clientY - drag.y) < 6) return;
      var g = document.createElement('span');
      var src = drag.src.firstChild;
      g.className = 'ghost ' + src.className;
      g.textContent = src.textContent;
      g.style.fontSize = getComputedStyle(src).fontSize;
      document.body.appendChild(g);
      drag.ghost = g;
      drag.src.classList.add('dragging');
      sel = drag.from;
      render();
      try { boardEl.setPointerCapture(e.pointerId); } catch (err) { /* ok */ }
    }
    drag.ghost.style.left = e.clientX + 'px';
    drag.ghost.style.top = e.clientY + 'px';
  });
  function endDrag(e, cancel) {
    if (!drag || e.pointerId !== drag.id) return;
    var d = drag;
    drag = null;
    if (!d.ghost) return;   // it was a click; the click handler takes it
    suppressClick = true;
    setTimeout(function () { suppressClick = false; }, 0);
    d.ghost.parentNode.removeChild(d.ghost);
    d.src.classList.remove('dragging');
    if (cancel) { sel = null; render(); return; }
    var under = document.elementFromPoint(e.clientX, e.clientY);
    var t = under && under.closest && under.closest('.sq');
    var to = t ? t.getAttribute('data-sq') : null;
    if (!to || to === d.from || !tryMove(d.from, to)) { sel = null; render(); }
  }
  boardEl.addEventListener('pointerup', function (e) { endDrag(e, false); });
  boardEl.addEventListener('pointercancel', function (e) { endDrag(e, true); });

  // ── Messages from the shell ──────────────────────────────────────────────────────
  window.addEventListener('message', function (e) {
    if (e.source !== window.parent) return;
    var d = e.data;
    if (!isPlain(d) || typeof d.type !== 'string') return;
    if (d.type === 'theme') {
      if (!keysWithin(d, ['type', 'mode'], ['type', 'mode']) || (d.mode !== 'dark' && d.mode !== 'light')) return;
      document.body.className = 'theme-' + d.mode;
      return;
    }
    if (d.type !== 'state' || !validState(d)) return;
    var newOrientation = d.you === 2 ? 2 : 1;
    var samePos = state && state.position === d.position;
    state = d;
    awaiting = false;
    provisional = null;
    if (!samePos) sel = null;
    hidePromo();
    if (newOrientation !== orientation || !boardEl.firstChild) {
      orientation = newOrientation;
      build();
    }
    render();
  });

  build();
  window.parent.postMessage({ type: 'ready', protocol: PROTOCOL }, '*');
})();
