/* frame-host.js — hosts one game in a sandboxed iframe (design §19.7, D13).
 *
 * The frame is <iframe sandbox="allow-scripts">, NEVER with allow-same-origin: its origin is
 * opaque, so it has no cookies, no storage of ours and no way to call /play/api/ (its CSP
 * also says connect-src 'none'). The shell does every API call; the frame only draws and
 * captures input. What crosses the boundary is exactly §19.7's four message types.
 *
 * Inbound (frame → shell): accepted only when event.source === this frame's contentWindow
 * and the data is a plain object whose `type` is known and whose fields match that type's
 * schema exactly (no extra keys). Anything else is dropped without a word. Origins are
 * never compared: a sandboxed frame's origin is the string "null", which any other
 * sandboxed document shares.
 *
 * Outbound (shell → frame): posted to the frame's window with targetOrigin '*'. That is the
 * only target an opaque origin can be addressed by — there is no narrower one to name. It is
 * safe because of what we send, not where: a `state` carries the board, the masked labels
 * and the legal moves, all already on screen. NEVER put a token, a cookie, a full address or
 * anything not on screen into a message to a frame.
 *
 *   var host = FrameHost.create({ container, game, onMove, onReady })
 *     game   — the /play/api/games summary ({ id, title, move_pattern, … })
 *     onMove(move) — the frame asked for this move (already schema- and pattern-checked)
 *   host.sendState(state) · host.sendTheme('dark'|'light') · host.destroy()
 */
(function () {
  'use strict';

  var PROTOCOL = 1;
  var GAME_ID_RE = /^[a-z0-9-]{2,32}$/;   // registry.js's folder rule (§19.7)
  var MOVE_MAX = 16;

  function isPlainObject(v) {
    return v !== null && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype;
  }
  function hasExactly(o, keys) {
    var k = Object.keys(o);
    if (k.length !== keys.length) return false;
    for (var i = 0; i < keys.length; i++) if (!Object.prototype.hasOwnProperty.call(o, keys[i])) return false;
    return true;
  }

  function version() {
    var v = window.GRIN_PLAY_VERSION;
    return typeof v === 'string' && /^[0-9a-f]{12}$/.test(v) ? v : 'dev';
  }

  function create(opts) {
    var game = opts.game;
    if (!game || typeof game.id !== 'string' || !GAME_ID_RE.test(game.id)) throw new Error('bad game id');
    var moveRe;
    try { moveRe = new RegExp(game.move_pattern); } catch (e) { throw new Error('bad move_pattern'); }

    var frame = document.createElement('iframe');
    frame.className = 'play-frame';
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.setAttribute('title', (game.title || game.id) + ' board');
    frame.setAttribute('referrerpolicy', 'no-referrer');
    // No permissions of any kind for game code (camera, fullscreen, payment, …).
    frame.setAttribute('allow', '');
    frame.src = '/play/games/' + game.id + '/frame/?v=' + version();

    var ready = false;
    var pendingState = null;
    var pendingTheme = null;

    function post(msg) {
      if (!frame.contentWindow) return;
      frame.contentWindow.postMessage(msg, '*');   // see the header: nothing secret, ever
    }

    function valid(d) {
      if (!isPlainObject(d) || typeof d.type !== 'string') return false;
      if (d.type === 'ready') return hasExactly(d, ['type', 'protocol']) && d.protocol === PROTOCOL;
      if (d.type === 'move') {
        return hasExactly(d, ['type', 'move']) && typeof d.move === 'string' &&
          d.move.length > 0 && d.move.length <= MOVE_MAX && moveRe.test(d.move);
      }
      return false;
    }

    function onMessage(e) {
      if (e.source !== frame.contentWindow || !frame.contentWindow) return;
      var d = e.data;
      if (!valid(d)) return;
      if (d.type === 'ready') {
        ready = true;
        if (pendingTheme) post(pendingTheme);
        if (pendingState) post(pendingState);
        if (typeof opts.onReady === 'function') opts.onReady();
        return;
      }
      if (!ready) return;
      if (typeof opts.onMove === 'function') opts.onMove(d.move);
    }
    window.addEventListener('message', onMessage);
    // No reset on the iframe's `load` event: the frame's `ready` is posted while its scripts
    // run, and can be handled BEFORE the parent sees `load` — a reset there would strand it.
    // A frame that reloads simply sends `ready` again, which re-sends the latest theme+state.

    opts.container.appendChild(frame);

    return {
      frame: frame,
      // state: §19.7's `state` fields. Built here from the match view so the caller cannot
      // add a field by accident.
      sendState: function (s) {
        var msg = {
          type: 'state',
          position: String(s.position),
          last_move: s.last_move === null || s.last_move === undefined ? null : String(s.last_move),
          you: s.you === 1 || s.you === 2 ? s.you : null,
          to_move: s.to_move === 1 || s.to_move === 2 ? s.to_move : null,
          status: s.status && s.status.over
            ? { over: true, result: String(s.status.result || ''), reason: String(s.status.reason || '') }
            : { over: false },
          // A null label is the empty seat of an open seek/challenge (§19.8).
          labels: { 1: String(s.labels && s.labels[1] || 'Open seat'), 2: String(s.labels && s.labels[2] || 'Open seat') }
        };
        // `legal` only when it is the viewer's turn (§19.7). A null means "look, don't touch".
        if (Array.isArray(s.legal)) msg.legal = s.legal.map(String);
        pendingState = msg;
        if (ready) post(msg);
      },
      sendTheme: function (mode) {
        var msg = { type: 'theme', mode: mode === 'light' ? 'light' : 'dark' };
        pendingTheme = msg;
        if (ready) post(msg);
      },
      destroy: function () {
        window.removeEventListener('message', onMessage);
        if (frame.parentNode) frame.parentNode.removeChild(frame);
        ready = false;
      }
    };
  }

  window.FrameHost = Object.freeze({ create: create, PROTOCOL: PROTOCOL });
})();
