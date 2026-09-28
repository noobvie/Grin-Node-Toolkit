/*
 * Chess rules for the GRINIUM games platform (design §19.7, D20).
 *
 * UMD, PURE and DETERMINISTIC. The games service evaluates this file in a sandboxed vm
 * context (lib/registry.js) with no require, no Date and a Math.random that throws, and
 * the sandboxed frame loads a copy of it for UI hints only. It is never an authority in
 * the browser: the server runs every move through apply() (§19.8).
 *
 * Notation: a position is a FEN; a move is UCI (`e2e4`, `e7e8q`), castling as the king's
 * two-square move (`e1g1`). Our own implementation, proved by perft in
 * server/scripts/test-matches.js — no vendored engine, no WASM (D20).
 *
 * The match API (§19.7):
 *   initial(params)                 → FEN of the standard start position
 *   toMove(fen)                     → 1 (white = seat1) | 2 (black = seat2)
 *   legal(fen)                      → [uci, …]
 *   apply(fen, uci)                 → the next FEN, or null when the move is illegal
 *   status(fen, history)            → { over:false } | { over:true, result:'seat1'|'seat2'|'draw', reason }
 *                                     history = the prior positions, oldest first (repetition)
 *   bot(fen, level, seed, ply)      → a legal uci move, deterministic in its arguments
 *
 * Game end is AUTOMATIC — there are no draw claims (§19.7): checkmate, stalemate, threefold
 * repetition, the fifty-move rule, insufficient material, and MAX_PLIES (a draw).
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module && module.exports) module.exports = factory();
  else root.GrinChessRules = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var MAX_PLIES = 600;
  var BOT_NODE_BUDGET = 20000;
  var START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  var MOVE_RE = /^[a-h][1-8][a-h][1-8][qrbn]?$/;
  var FEN_MAX = 100;

  // ── Board: 0x88, a8 = 0 … h1 = 119. Piece = colour | type. ──────────────────────────
  var WHITE = 0, BLACK = 8;
  var PAWN = 1, KNIGHT = 2, BISHOP = 3, ROOK = 4, QUEEN = 5, KING = 6;
  var N_OFF = [-33, -31, -18, -14, 14, 18, 31, 33];
  var K_OFF = [-17, -16, -15, -1, 1, 15, 16, 17];
  var B_DIR = [-17, -15, 15, 17];
  var R_DIR = [-16, -1, 1, 16];
  var PIECE_CHARS = ' pnbrqk';
  var PROMO_CHARS = { 2: 'n', 3: 'b', 4: 'r', 5: 'q' };
  var PROMO_TYPES = { n: KNIGHT, b: BISHOP, r: ROOK, q: QUEEN };

  // Move flags.
  var F_EP = 1, F_CASTLE = 2, F_DOUBLE = 4;

  // Castling rights: 1 = K, 2 = Q, 4 = k, 8 = q. A move that touches a square ANDs the
  // rights with its mask (a king or rook leaving home, or a rook captured at home).
  var CASTLE_MASK = [];
  (function () {
    for (var i = 0; i < 128; i++) CASTLE_MASK[i] = 15;
    CASTLE_MASK[116] = 15 & ~3;   // e1
    CASTLE_MASK[119] = 15 & ~1;   // h1
    CASTLE_MASK[112] = 15 & ~2;   // a1
    CASTLE_MASK[4] = 15 & ~12;    // e8
    CASTLE_MASK[7] = 15 & ~4;     // h8
    CASTLE_MASK[0] = 15 & ~8;     // a8
  }());

  function sqName(sq) { return 'abcdefgh'.charAt(sq & 15) + String(8 - (sq >> 4)); }
  function sqParse(s) { return (8 - (s.charCodeAt(1) - 48)) * 16 + (s.charCodeAt(0) - 97); }

  // ── FEN ───────────────────────────────────────────────────────────────────────────
  // Strict: anything malformed THROWS (the platform catches, §19.7). A position whose side
  // NOT to move is in check is illegal and refused too.
  function parse(fen) {
    if (typeof fen !== 'string' || fen.length > FEN_MAX) throw new Error('bad FEN');
    var f = fen.split(' ');
    if (f.length !== 6) throw new Error('bad FEN: fields');
    var rows = f[0].split('/');
    if (rows.length !== 8) throw new Error('bad FEN: ranks');
    var b = new Int8Array(128);
    var king = [-1, -1];
    for (var r = 0; r < 8; r++) {
      var file = 0;
      var row = rows[r];
      for (var i = 0; i < row.length; i++) {
        var ch = row.charAt(i);
        if (ch >= '1' && ch <= '8') { file += ch.charCodeAt(0) - 48; continue; }
        var lower = ch.toLowerCase();
        var t = PIECE_CHARS.indexOf(lower);
        if (t < 1 || file > 7) throw new Error('bad FEN: placement');
        var colour = ch === lower ? BLACK : WHITE;
        var sq = r * 16 + file;
        if (t === PAWN && (r === 0 || r === 7)) throw new Error('bad FEN: pawn on a back rank');
        if (t === KING) {
          if (king[colour >> 3] !== -1) throw new Error('bad FEN: two kings');
          king[colour >> 3] = sq;
        }
        b[sq] = colour | t;
        file++;
      }
      if (file !== 8) throw new Error('bad FEN: rank width');
    }
    if (king[0] === -1 || king[1] === -1) throw new Error('bad FEN: missing king');
    var turn;
    if (f[1] === 'w') turn = WHITE; else if (f[1] === 'b') turn = BLACK; else throw new Error('bad FEN: side');
    var castle = 0;
    if (f[2] !== '-') {
      if (!/^K?Q?k?q?$/.test(f[2]) || f[2] === '') throw new Error('bad FEN: castling');
      if (f[2].indexOf('K') !== -1) castle |= 1;
      if (f[2].indexOf('Q') !== -1) castle |= 2;
      if (f[2].indexOf('k') !== -1) castle |= 4;
      if (f[2].indexOf('q') !== -1) castle |= 8;
    }
    var ep = -1;
    if (f[3] !== '-') {
      if (!/^[a-h][36]$/.test(f[3])) throw new Error('bad FEN: en passant');
      if ((turn === WHITE) !== (f[3].charAt(1) === '6')) throw new Error('bad FEN: en passant rank');
      ep = sqParse(f[3]);
    }
    if (!/^(0|[1-9][0-9]{0,2})$/.test(f[4])) throw new Error('bad FEN: halfmove');
    if (!/^[1-9][0-9]{0,3}$/.test(f[5])) throw new Error('bad FEN: fullmove');
    var st = { b: b, turn: turn, castle: castle, ep: ep, half: Number(f[4]), full: Number(f[5]), king: king };
    if (attacked(st, king[(turn ^ 8) >> 3], turn)) throw new Error('bad FEN: side not to move is in check');
    return st;
  }

  function placement(st) {
    var out = '';
    for (var r = 0; r < 8; r++) {
      var empty = 0;
      for (var file = 0; file < 8; file++) {
        var p = st.b[r * 16 + file];
        if (!p) { empty++; continue; }
        if (empty) { out += empty; empty = 0; }
        var c = PIECE_CHARS.charAt(p & 7);
        out += (p & 8) ? c : c.toUpperCase();
      }
      if (empty) out += empty;
      if (r < 7) out += '/';
    }
    return out;
  }

  function castleStr(c) {
    var s = (c & 1 ? 'K' : '') + (c & 2 ? 'Q' : '') + (c & 4 ? 'k' : '') + (c & 8 ? 'q' : '');
    return s || '-';
  }

  function serialize(st) {
    return placement(st) + ' ' + (st.turn === WHITE ? 'w' : 'b') + ' ' + castleStr(st.castle) + ' ' +
      (st.ep === -1 ? '-' : sqName(st.ep)) + ' ' + st.half + ' ' + st.full;
  }

  // ── Attacks ───────────────────────────────────────────────────────────────────────
  function attacked(st, sq, by) {
    var b = st.b, s, i, p;
    if (by === WHITE) {
      s = sq + 15; if (!(s & 0x88) && b[s] === (WHITE | PAWN)) return true;
      s = sq + 17; if (!(s & 0x88) && b[s] === (WHITE | PAWN)) return true;
    } else {
      s = sq - 15; if (!(s & 0x88) && b[s] === (BLACK | PAWN)) return true;
      s = sq - 17; if (!(s & 0x88) && b[s] === (BLACK | PAWN)) return true;
    }
    for (i = 0; i < 8; i++) {
      s = sq + N_OFF[i]; if (!(s & 0x88) && b[s] === (by | KNIGHT)) return true;
      s = sq + K_OFF[i]; if (!(s & 0x88) && b[s] === (by | KING)) return true;
    }
    for (i = 0; i < 4; i++) {
      var d = R_DIR[i];
      s = sq + d;
      while (!(s & 0x88)) {
        p = b[s];
        if (p) { if (p === (by | ROOK) || p === (by | QUEEN)) return true; break; }
        s += d;
      }
      d = B_DIR[i];
      s = sq + d;
      while (!(s & 0x88)) {
        p = b[s];
        if (p) { if (p === (by | BISHOP) || p === (by | QUEEN)) return true; break; }
        s += d;
      }
    }
    return false;
  }

  function inCheck(st) { return attacked(st, st.king[st.turn >> 3], st.turn ^ 8); }

  // ── Move generation ───────────────────────────────────────────────────────────────
  function mv(from, to, piece, captured, promo, flags) {
    return { from: from, to: to, piece: piece, captured: captured, promo: promo, flags: flags };
  }

  function pushPawn(out, from, to, piece, captured, promoRow) {
    if ((to >> 4) === promoRow) {
      out.push(mv(from, to, piece, captured, QUEEN, 0));
      out.push(mv(from, to, piece, captured, ROOK, 0));
      out.push(mv(from, to, piece, captured, BISHOP, 0));
      out.push(mv(from, to, piece, captured, KNIGHT, 0));
    } else {
      out.push(mv(from, to, piece, captured, 0, 0));
    }
  }

  // Pseudo-legal moves (may leave the mover's king in check); castling is fully checked
  // here — not in check, the squares between empty, the king's path not attacked.
  function pseudo(st) {
    var out = [];
    var b = st.b, us = st.turn, them = us ^ 8;
    var fwd = us === WHITE ? -16 : 16;
    var startRow = us === WHITE ? 6 : 1;
    var promoRow = us === WHITE ? 0 : 7;
    var capL = us === WHITE ? -17 : 15;
    var capR = us === WHITE ? -15 : 17;
    for (var sq = 0; sq < 120; sq++) {
      if (sq & 0x88) { sq += 7; continue; }
      var p = b[sq];
      if (!p || (p & 8) !== us) continue;
      var t = p & 7, to, c, i;
      if (t === PAWN) {
        to = sq + fwd;
        if (!(to & 0x88) && !b[to]) {
          pushPawn(out, sq, to, p, 0, promoRow);
          if ((sq >> 4) === startRow && !b[to + fwd]) out.push(mv(sq, to + fwd, p, 0, 0, F_DOUBLE));
        }
        for (i = 0; i < 2; i++) {
          to = sq + (i ? capR : capL);
          if (to & 0x88) continue;
          c = b[to];
          if (c && (c & 8) === them) pushPawn(out, sq, to, p, c, promoRow);
          else if (to === st.ep) out.push(mv(sq, to, p, them | PAWN, 0, F_EP));
        }
      } else if (t === KNIGHT || t === KING) {
        var offs = t === KNIGHT ? N_OFF : K_OFF;
        for (i = 0; i < 8; i++) {
          to = sq + offs[i];
          if (to & 0x88) continue;
          c = b[to];
          if (!c) out.push(mv(sq, to, p, 0, 0, 0));
          else if ((c & 8) === them) out.push(mv(sq, to, p, c, 0, 0));
        }
      } else {
        var dirs = t === BISHOP ? B_DIR : t === ROOK ? R_DIR : K_OFF;
        for (i = 0; i < dirs.length; i++) {
          var d = dirs[i];
          to = sq + d;
          while (!(to & 0x88)) {
            c = b[to];
            if (!c) out.push(mv(sq, to, p, 0, 0, 0));
            else { if ((c & 8) === them) out.push(mv(sq, to, p, c, 0, 0)); break; }
            to += d;
          }
        }
      }
    }
    // Castling. The rook must really be there: rights read from a FEN may not match it.
    if (st.castle) {
      var k = us | KING, r = us | ROOK;
      if (us === WHITE && b[116] === k) {
        if ((st.castle & 1) && b[119] === r && !b[117] && !b[118] &&
            !attacked(st, 116, them) && !attacked(st, 117, them) && !attacked(st, 118, them)) {
          out.push(mv(116, 118, k, 0, 0, F_CASTLE));
        }
        if ((st.castle & 2) && b[112] === r && !b[115] && !b[114] && !b[113] &&
            !attacked(st, 116, them) && !attacked(st, 115, them) && !attacked(st, 114, them)) {
          out.push(mv(116, 114, k, 0, 0, F_CASTLE));
        }
      } else if (us === BLACK && b[4] === k) {
        if ((st.castle & 4) && b[7] === r && !b[5] && !b[6] &&
            !attacked(st, 4, them) && !attacked(st, 5, them) && !attacked(st, 6, them)) {
          out.push(mv(4, 6, k, 0, 0, F_CASTLE));
        }
        if ((st.castle & 8) && b[0] === r && !b[3] && !b[2] && !b[1] &&
            !attacked(st, 4, them) && !attacked(st, 3, them) && !attacked(st, 2, them)) {
          out.push(mv(4, 2, k, 0, 0, F_CASTLE));
        }
      }
    }
    return out;
  }

  function rookSquares(to) {
    // king destination → [rook from, rook to]
    if (to === 118) return [119, 117];
    if (to === 114) return [112, 115];
    if (to === 6) return [7, 5];
    return [0, 3];   // to === 2
  }

  function make(st, m) {
    var b = st.b, us = st.turn;
    var u = { m: m, castle: st.castle, ep: st.ep, half: st.half, full: st.full };
    b[m.to] = m.promo ? (us | m.promo) : m.piece;
    b[m.from] = 0;
    if (m.flags & F_EP) b[m.to + (us === WHITE ? 16 : -16)] = 0;
    if (m.flags & F_CASTLE) {
      var rs = rookSquares(m.to);
      b[rs[1]] = b[rs[0]];
      b[rs[0]] = 0;
    }
    if ((m.piece & 7) === KING) st.king[us >> 3] = m.to;
    st.castle &= CASTLE_MASK[m.from] & CASTLE_MASK[m.to];
    st.ep = (m.flags & F_DOUBLE) ? (m.from + m.to) >> 1 : -1;
    st.half = ((m.piece & 7) === PAWN || m.captured) ? 0 : st.half + 1;
    if (us === BLACK) st.full++;
    st.turn = us ^ 8;
    return u;
  }

  function unmake(st, u) {
    var m = u.m, b = st.b, us = m.piece & 8;
    st.turn = us;
    b[m.from] = m.piece;
    if (m.flags & F_EP) {
      b[m.to] = 0;
      b[m.to + (us === WHITE ? 16 : -16)] = m.captured;
    } else {
      b[m.to] = m.captured;
    }
    if (m.flags & F_CASTLE) {
      var rs = rookSquares(m.to);
      b[rs[0]] = b[rs[1]];
      b[rs[1]] = 0;
    }
    if ((m.piece & 7) === KING) st.king[us >> 3] = m.from;
    st.castle = u.castle;
    st.ep = u.ep;
    st.half = u.half;
    st.full = u.full;
  }

  // Makes m; true if it left the mover's king safe. The move stays MADE either way — the
  // caller unmakes.
  function legalAfterMake(st) {
    var mover = st.turn ^ 8;
    return !attacked(st, st.king[mover >> 3], st.turn);
  }

  function legalMoves(st) {
    var ps = pseudo(st), out = [];
    for (var i = 0; i < ps.length; i++) {
      var u = make(st, ps[i]);
      if (legalAfterMake(st)) out.push(ps[i]);
      unmake(st, u);
    }
    return out;
  }

  function hasLegal(st) {
    var ps = pseudo(st);
    for (var i = 0; i < ps.length; i++) {
      var u = make(st, ps[i]);
      var ok = legalAfterMake(st);
      unmake(st, u);
      if (ok) return true;
    }
    return false;
  }

  function uci(m) { return sqName(m.from) + sqName(m.to) + (m.promo ? PROMO_CHARS[m.promo] : ''); }

  // ── Game end ──────────────────────────────────────────────────────────────────────
  // FIDE dead position, the cases that are certain: no pawns, rooks or queens, and either
  // at most one minor piece in total, or only bishops, all on one square colour.
  function insufficient(st) {
    var minors = 0, knights = 0, light = 0, dark = 0;
    for (var sq = 0; sq < 120; sq++) {
      if (sq & 0x88) { sq += 7; continue; }
      var t = st.b[sq] & 7;
      if (!t || t === KING) continue;
      if (t === PAWN || t === ROOK || t === QUEEN) return false;
      minors++;
      if (t === KNIGHT) knights++;
      else if (((sq >> 4) + (sq & 15)) % 2) dark++; else light++;
    }
    if (minors <= 1) return true;
    return knights === 0 && (light === 0 || dark === 0);
  }

  // Repetition identity (FIDE): placement, side to move, castling rights, and the en
  // passant square ONLY when an en passant capture is actually legal. The clocks are not
  // part of it.
  function epKey(st) {
    if (st.ep === -1) return '-';
    var ps = pseudo(st);
    for (var i = 0; i < ps.length; i++) {
      if (!(ps[i].flags & F_EP)) continue;
      var u = make(st, ps[i]);
      var ok = legalAfterMake(st);
      unmake(st, u);
      if (ok) return sqName(st.ep);
    }
    return '-';
  }

  function keyOf(fen) {
    var f = fen.split(' ');
    return f[0] + ' ' + f[1] + ' ' + f[2] + ' ' + (f[3] === '-' ? '-' : epKey(parse(fen)));
  }

  function plyOf(st) { return (st.full - 1) * 2 + (st.turn === BLACK ? 1 : 0); }

  // ── The match API ─────────────────────────────────────────────────────────────────
  function initial() { return START_FEN; }

  function toMove(fen) {
    var f = typeof fen === 'string' ? fen.split(' ') : [];
    if (f[1] === 'w') return 1;
    if (f[1] === 'b') return 2;
    throw new Error('bad FEN: side');
  }

  function legal(fen) {
    var ms = legalMoves(parse(fen)), out = [];
    for (var i = 0; i < ms.length; i++) out.push(uci(ms[i]));
    return out;
  }

  // Only the one matching pseudo-legal move is made and checked — much cheaper than
  // generating the full legal list, which matters because the server replays a match's
  // whole move list through apply() on every move (§19.8, the repetition history).
  function apply(fen, move) {
    if (typeof move !== 'string' || !MOVE_RE.test(move)) return null;
    var st = parse(fen);
    var from = sqParse(move.slice(0, 2)), to = sqParse(move.slice(2, 4));
    var promo = move.length === 5 ? PROMO_TYPES[move.charAt(4)] : 0;
    var ps = pseudo(st);
    for (var i = 0; i < ps.length; i++) {
      var m = ps[i];
      if (m.from !== from || m.to !== to || m.promo !== promo) continue;
      make(st, m);
      return legalAfterMake(st) ? serialize(st) : null;
    }
    return null;
  }

  function status(fen, history) {
    var st = parse(fen);
    if (!hasLegal(st)) {
      if (inCheck(st)) return { over: true, result: st.turn === WHITE ? 'seat2' : 'seat1', reason: 'checkmate' };
      return { over: true, result: 'draw', reason: 'stalemate' };
    }
    if (insufficient(st)) return { over: true, result: 'draw', reason: 'material' };
    // A repeat needs at least 4 reversible plies, and nothing before the last capture or
    // pawn move (the halfmove clock) can equal the current position.
    if (history && history.length && st.half >= 4) {
      var key = keyOf(fen);
      var n = 1;
      var stop = Math.max(0, history.length - st.half);
      for (var i = history.length - 1; i >= stop; i--) {
        if (typeof history[i] === 'string' && keyOf(history[i]) === key && ++n >= 3) {
          return { over: true, result: 'draw', reason: 'repetition' };
        }
      }
    }
    if (st.half >= 100) return { over: true, result: 'draw', reason: 'fifty' };
    if (plyOf(st) >= MAX_PLIES) return { over: true, result: 'draw', reason: 'max_plies' };
    return { over: false };
  }

  // ── Bot ───────────────────────────────────────────────────────────────────────────
  // Deterministic given (fen, level, seed, ply): the only randomness is a PRNG seeded from
  // those arguments (never Math.random, which the server's sandbox makes throw).
  //   level 1: a seeded random legal move
  //   level 2: greedy 1-ply by material (mate-in-1 first), seeded tie-break
  //   level 3: 2-ply alpha-beta over material + piece-square tables, seeded tie-break
  // Every level respects BOT_NODE_BUDGET: a search that runs out keeps the best move among
  // the root moves it finished, so a crowded position costs a bounded amount of CPU.

  // FNV-1a over the UTF-16 code units, then splitmix32.
  function hash32(s) {
    var h = 0x811c9dc5;
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return h >>> 0;
  }
  function splitmix32(a) {
    return function () {
      a = (a + 0x9e3779b9) | 0;
      var t = a ^ (a >>> 16);
      t = Math.imul(t, 0x21f0aaad);
      t ^= t >>> 15;
      t = Math.imul(t, 0x735a2d97);
      t ^= t >>> 15;
      return (t >>> 0) / 4294967296;
    };
  }

  var VAL = [0, 100, 320, 330, 500, 900, 0];
  var MATE = 1000000;
  // Simplified Evaluation Function (Tomasz Michniewski) tables, a8 … h1, white's view.
  var PST = [null,
    [0, 0, 0, 0, 0, 0, 0, 0, 50, 50, 50, 50, 50, 50, 50, 50, 10, 10, 20, 30, 30, 20, 10, 10, 5, 5, 10, 25, 25, 10, 5, 5,
      0, 0, 0, 20, 20, 0, 0, 0, 5, -5, -10, 0, 0, -10, -5, 5, 5, 10, 10, -20, -20, 10, 10, 5, 0, 0, 0, 0, 0, 0, 0, 0],
    [-50, -40, -30, -30, -30, -30, -40, -50, -40, -20, 0, 0, 0, 0, -20, -40, -30, 0, 10, 15, 15, 10, 0, -30, -30, 5, 15, 20, 20, 15, 5, -30,
      -30, 0, 15, 20, 20, 15, 0, -30, -30, 5, 10, 15, 15, 10, 5, -30, -40, -20, 0, 5, 5, 0, -20, -40, -50, -40, -30, -30, -30, -30, -40, -50],
    [-20, -10, -10, -10, -10, -10, -10, -20, -10, 0, 0, 0, 0, 0, 0, -10, -10, 0, 5, 10, 10, 5, 0, -10, -10, 5, 5, 10, 10, 5, 5, -10,
      -10, 0, 10, 10, 10, 10, 0, -10, -10, 10, 10, 10, 10, 10, 10, -10, -10, 5, 0, 0, 0, 0, 5, -10, -20, -10, -10, -10, -10, -10, -10, -20],
    [0, 0, 0, 0, 0, 0, 0, 0, 5, 10, 10, 10, 10, 10, 10, 5, -5, 0, 0, 0, 0, 0, 0, -5, -5, 0, 0, 0, 0, 0, 0, -5,
      -5, 0, 0, 0, 0, 0, 0, -5, -5, 0, 0, 0, 0, 0, 0, -5, -5, 0, 0, 0, 0, 0, 0, -5, 0, 0, 0, 5, 5, 0, 0, 0],
    [-20, -10, -10, -5, -5, -10, -10, -20, -10, 0, 0, 0, 0, 0, 0, -10, -10, 0, 5, 5, 5, 5, 0, -10, -5, 0, 5, 5, 5, 5, 0, -5,
      0, 0, 5, 5, 5, 5, 0, -5, -10, 5, 5, 5, 5, 5, 0, -10, -10, 0, 5, 0, 0, 0, 0, -10, -20, -10, -10, -5, -5, -10, -10, -20],
    [-30, -40, -40, -50, -50, -40, -40, -30, -30, -40, -40, -50, -50, -40, -40, -30, -30, -40, -40, -50, -50, -40, -40, -30, -30, -40, -40, -50, -50, -40, -40, -30,
      -20, -30, -30, -40, -40, -30, -30, -20, -10, -20, -20, -20, -20, -20, -20, -10, 20, 20, 0, 0, 0, 0, 20, 20, 20, 30, 10, 0, 0, 10, 30, 20]];

  // Material only (level 2), from the side to move's view.
  function material(st) {
    var s = 0;
    for (var sq = 0; sq < 120; sq++) {
      if (sq & 0x88) { sq += 7; continue; }
      var p = st.b[sq];
      if (p) s += (p & 8) ? -VAL[p & 7] : VAL[p & 7];
    }
    return st.turn === WHITE ? s : -s;
  }

  // Material + piece-square (level 3), from the side to move's view.
  function evaluate(st) {
    var s = 0;
    for (var sq = 0; sq < 120; sq++) {
      if (sq & 0x88) { sq += 7; continue; }
      var p = st.b[sq];
      if (!p) continue;
      var t = p & 7, row = sq >> 4, file = sq & 15;
      if (p & 8) s -= VAL[t] + PST[t][(7 - row) * 8 + file];
      else s += VAL[t] + PST[t][row * 8 + file];
    }
    return st.turn === WHITE ? s : -s;
  }

  // Captures first (most valuable victim, least valuable attacker), then promotions; the
  // sort is stable, so equal keys keep the seeded shuffle's order — that is the tie-break.
  function orderMoves(ms) {
    for (var i = 0; i < ms.length; i++) {
      var m = ms[i];
      m.key = (m.captured ? 10 * VAL[m.captured & 7] - VAL[m.piece & 7] + 10000 : 0) + (m.promo ? VAL[m.promo] : 0);
    }
    return ms.sort(function (a, b) { return b.key - a.key; });
  }

  function shuffle(ms, rnd) {
    for (var i = ms.length - 1; i > 0; i--) {
      var j = Math.floor(rnd() * (i + 1));
      var t = ms[i]; ms[i] = ms[j]; ms[j] = t;
    }
    return ms;
  }

  // Negamax alpha-beta; score from the side to move's view. A leaf in check with no legal
  // move is scored as mate, so the bot never walks into a mate-in-1.
  function search(st, depth, alpha, beta, ply, ctx) {
    if (depth === 0) {
      ctx.nodes++;
      if (inCheck(st) && !hasLegal(st)) return -(MATE - ply);
      return evaluate(st);
    }
    var ms = legalMoves(st);
    if (!ms.length) return inCheck(st) ? -(MATE - ply) : 0;
    orderMoves(ms);
    for (var i = 0; i < ms.length; i++) {
      if (ctx.nodes >= ctx.budget) { ctx.aborted = true; return alpha; }
      ctx.nodes++;
      var u = make(st, ms[i]);
      var score = -search(st, depth - 1, -beta, -alpha, ply + 1, ctx);
      unmake(st, u);
      if (ctx.aborted) return alpha;
      if (score > alpha) { alpha = score; if (alpha >= beta) break; }
    }
    return alpha;
  }

  // budget: tests only — a 2-ply alpha-beta search rarely comes near BOT_NODE_BUDGET, so the
  // tests pass a small one to prove the cut-off path. bot() always uses the constant.
  function botStats(fen, level, seed, ply, budget) {
    var st = parse(fen);
    var ms = legalMoves(st);
    if (!ms.length) throw new Error('bot: no legal move');
    var rnd = splitmix32(hash32(String(seed) + '|' + String(ply) + '|' + fen + '|' + String(level)));
    shuffle(ms, rnd);
    var ctx = { nodes: 0, budget: budget > 0 ? budget : BOT_NODE_BUDGET, aborted: false };
    var best = ms[0];
    if (level === 1) return { move: uci(best), nodes: 0 };
    var bestScore = -Infinity, i, u, score;
    if (level === 2) {
      for (i = 0; i < ms.length && ctx.nodes < ctx.budget; i++) {
        ctx.nodes++;
        u = make(st, ms[i]);
        if (!hasLegal(st)) score = inCheck(st) ? MATE : 0;
        else score = -material(st);
        unmake(st, u);
        if (score > bestScore) { bestScore = score; best = ms[i]; }
      }
      return { move: uci(best), nodes: ctx.nodes };
    }
    if (level === 3) {
      orderMoves(ms);
      best = ms[0];
      for (i = 0; i < ms.length; i++) {
        if (ctx.nodes >= ctx.budget) break;
        ctx.nodes++;
        u = make(st, ms[i]);
        score = -search(st, 1, -Infinity, bestScore === -Infinity ? Infinity : -bestScore, 1, ctx);
        unmake(st, u);
        if (ctx.aborted) break;          // this root move was not finished — do not trust it
        if (score > bestScore) { bestScore = score; best = ms[i]; }
      }
      return { move: uci(best), nodes: ctx.nodes, aborted: ctx.aborted };
    }
    throw new Error('bot: unknown level');
  }

  function bot(fen, level, seed, ply) { return botStats(fen, level, seed, ply, 0).move; }

  // ── Tests only ────────────────────────────────────────────────────────────────────
  function perftSt(st, depth) {
    var ms = legalMoves(st);
    if (depth === 1) return ms.length;
    var n = 0;
    for (var i = 0; i < ms.length; i++) {
      var u = make(st, ms[i]);
      n += perftSt(st, depth - 1);
      unmake(st, u);
    }
    return n;
  }
  function perft(fen, depth) { return depth < 1 ? 1 : perftSt(parse(fen), depth); }

  return Object.freeze({
    MAX_PLIES: MAX_PLIES,
    BOT_NODE_BUDGET: BOT_NODE_BUDGET,
    START_FEN: START_FEN,
    initial: initial,
    toMove: toMove,
    legal: legal,
    apply: apply,
    status: status,
    bot: bot,
    botStats: botStats,
    perft: perft,
    inCheck: function (fen) { return inCheck(parse(fen)); },
  });
}));
