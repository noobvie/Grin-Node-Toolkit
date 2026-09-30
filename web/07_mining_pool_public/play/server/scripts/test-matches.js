'use strict';

// Part 5 (design §19.7, §19.8, D13, D14, D17, D20): chess rules (perft), the bot, the game
// registry, and the match platform in bot mode over a real loopback server.
//
// The pool is a stub (in-process fakes); a planted "toy" game drives the settle paths the
// chess bot cannot be steered into (win / draw / max_plies / a throwing rules.js). Servers
// are closed before the suite ends; temp files live under os.tmpdir() and are removed.
// Run: node scripts/test-matches.js

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const { openDb } = require('../lib/db.js');
const { createLogger } = require('../lib/log.js');
const { loadGames, validateManifest, evaluateRules, ManifestError } = require('../lib/registry.js');
const { buildApp, createServer, listen } = require('../lib/app.js');
const { BOT_MOVES_KEEP_S } = require('../lib/matches.js');

let pass = 0, fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else      { fail++; console.error(`  FAIL  ${name}${extra ? ' — ' + extra : ''}`); }
}

const SERVER = path.join(__dirname, '..');
const GAMES = path.join(SERVER, '..', 'games');
const CHESS_DIR = path.join(GAMES, 'chess');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'grin-games-matches-'));
const lines = [];
const log = createLogger((level, line) => lines.push(`${level} ${line}`));

// The chess rules exactly as the server runs them: evaluated in the registry's sandbox.
const R = evaluateRules(fs.readFileSync(path.join(CHESS_DIR, 'rules.js'), 'utf8'), path.join(CHESS_DIR, 'rules.js'));
const START = R.START_FEN;
const KIWI = 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1';

const CS = 'acdefghjklmnpqrstuvwxyz023456789';
function addr(n, prefix = 'grin1') {
  let x = (n * 7919 + 13) >>> 0;
  let s = '';
  for (let i = 0; i < 58; i++) { x = (Math.imul(x, 1103515245) + 12345) >>> 0; s += CS[(x >>> 16) % 32]; }
  return prefix + s;
}

function request(port, { method = 'GET', path: p, headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers, agent: false }, (res) => {
      const parts = [];
      res.on('data', (c) => parts.push(c));
      res.on('end', () => {
        const text = Buffer.concat(parts).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

const TOY_RULES = `
(function (root, f) { if (typeof module === 'object' && module.exports) module.exports = f(); else root.Toy = f(); }(this, function () {
  function parse(p) { var a = p.split('|'); return { n: Number(a[0]), last: a[1], by: a[2] }; }
  var MOVES = ['x', 'win', 'draw', 'boom'];
  return {
    initial: function () { return '0|-|-'; },
    toMove: function (p) { return parse(p).n % 2 === 0 ? 1 : 2; },
    legal: function () { return MOVES.slice(); },
    apply: function (p, m) {
      if (m === 'boom') throw new Error('toy apply exploded');
      if (MOVES.indexOf(m) < 0) return null;
      var s = parse(p);
      return (s.n + 1) + '|' + m + '|' + (s.n % 2 === 0 ? '1' : '2');
    },
    status: function (p) {
      var s = parse(p);
      if (s.last === 'win') return { over: true, result: 'seat' + s.by, reason: 'win' };
      if (s.last === 'draw') return { over: true, result: 'draw', reason: 'agreement' };
      return { over: false };
    },
    bot: function () { return 'x'; }
  };
}));
`;
const TOY_MANIFEST = {
  id: 'toy', title: 'Toy', kind: 'match', version: 't1', seats: 2, modes: ['bot'], bot_levels: [1, 2],
  move_pattern: '^[a-z]{1,4}$', move_seconds_options: [3600], default_move_seconds: 3600, max_plies: 6,
  points: { bot: { 1: 5, 2: 7 } },
};

function plantGame(root, name, manifest, rules) {
  const d = path.join(root, name);
  fs.mkdirSync(d, { recursive: true });
  if (manifest !== null) fs.writeFileSync(path.join(d, 'manifest.json'), typeof manifest === 'string' ? manifest : JSON.stringify(manifest));
  if (rules !== null) fs.writeFileSync(path.join(d, 'rules.js'), rules);
}
const chessManifest = () => JSON.parse(fs.readFileSync(path.join(CHESS_DIR, 'manifest.json'), 'utf8'));
const chessRules = () => fs.readFileSync(path.join(CHESS_DIR, 'rules.js'), 'utf8');

async function main() {
  // ── [a] chess rules ─────────────────────────────────────────────────────────────────
  console.log('\n[a] chess rules: perft + special moves + game end\n');
  const perfts = [
    ['start d1', START, 1, 20], ['start d2', START, 2, 400], ['start d3', START, 3, 8902], ['start d4', START, 4, 197281],
    ['Kiwipete d1', KIWI, 1, 48], ['Kiwipete d2', KIWI, 2, 2039], ['Kiwipete d3', KIWI, 3, 97862],
    ['pos3 d4 (ep pins, rank checks)', '8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1', 4, 43238],
    ['pos4 d3 (promotions, castling)', 'r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1', 3, 9467],
    ['pos5 d3', 'rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8', 3, 62379],
  ];
  for (const [name, fen, d, want] of perfts) {
    const t0 = Date.now();
    const n = R.perft(fen, d);
    ok(`a. perft ${name} = ${want}`, n === want, `got ${n} (${Date.now() - t0}ms)`);
  }

  ok('a. initial() is the standard start, white (seat1) to move', R.initial({}) === START && R.toMove(START) === 1);
  ok('a. apply round-trips to a canonical FEN', R.apply(START, 'e2e4') === 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1');
  ok('a. apply refuses a malformed / impossible / wrong-side move → null',
    R.apply(START, 'e2e5') === null && R.apply(START, 'e7e5') === null && R.apply(START, 'E2E4') === null
    && R.apply(START, 'e2e4 ') === null && R.apply(START, 42) === null && R.apply(START, 'e2e4q') === null);
  let threw = false;
  try { R.legal('not a fen'); } catch { threw = true; }
  ok('a. a malformed FEN throws (the platform turns that into game_error)', threw);
  threw = false;
  try { R.legal('4k3/8/8/8/8/8/8/4K2r b - - 0 1'); } catch { threw = true; }
  ok('a. a position whose side NOT to move is in check is refused', threw);

  // Castling.
  const thru = '4k3/8/8/8/8/8/5r2/R3K2R w KQ - 0 1';
  ok('a. castling THROUGH check refused (f1 attacked), queenside allowed',
    R.apply(thru, 'e1g1') === null && R.apply(thru, 'e1c1') !== null);
  ok('a. castling OUT of check refused', R.apply('4k3/8/8/8/8/8/4r3/R3K2R w KQ - 0 1', 'e1g1') === null
    && R.apply('4k3/8/8/8/8/8/4r3/R3K2R w KQ - 0 1', 'e1c1') === null);
  ok('a. castling moves the rook and clears both rights', R.apply('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1', 'e1g1')
    === 'r3k2r/8/8/8/8/8/8/R4RK1 b kq - 1 1');
  ok('a. a rook captured at home clears that castling right',
    R.apply('r3k2r/8/8/8/8/8/6b1/R3K2R b KQkq - 0 1', 'g2h1') === 'r3k2r/8/8/8/8/8/8/R3K2b w Qkq - 0 2');
  // En passant.
  ok('a. en passant: legal, removes the passed pawn', R.apply('4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 2', 'e5d6') === '4k3/8/3P4/8/8/8/8/4K3 b - - 0 2');
  ok('a. en passant that exposes the king on the rank is refused',
    !R.legal('8/8/8/K2pP2q/8/8/8/7k w - d6 0 1').includes('e5d6'));
  // Promotion.
  const promo = '8/P7/8/8/8/8/8/k6K w - - 0 1';
  const pl = R.legal(promo);
  ok('a. promotion offers q/r/b/n, never a bare pawn move', ['a7a8q', 'a7a8r', 'a7a8b', 'a7a8n'].every((m) => pl.includes(m)) && !pl.includes('a7a8'));
  ok('a. under-promotion to a knight', R.apply(promo, 'a7a8n') === 'N7/8/8/8/8/8/8/k6K b - - 0 1' && R.apply(promo, 'a7a8') === null);
  ok('a. a pinned knight cannot move', !R.legal('4k3/4r3/8/8/8/8/4N3/4K3 w - - 0 1').some((m) => m.startsWith('e2')));

  // Game end (all automatic).
  const foolsHist = [START];
  let pos = START;
  for (const m of ['f2f3', 'e7e5', 'g2g4']) { pos = R.apply(pos, m); foolsHist.push(pos); }
  const mated = R.apply(pos, 'd8h4');
  let st = R.status(mated, foolsHist);
  ok('a. checkmate (fool\'s mate) → seat2 wins', st.over && st.result === 'seat2' && st.reason === 'checkmate');
  st = R.status('7k/5Q2/6K1/8/8/8/8/8 b - - 0 1', []);
  ok('a. stalemate → draw', st.over && st.result === 'draw' && st.reason === 'stalemate');
  ok('a. insufficient: K v K, K+B v K, K+N v K, same-colour bishops → draw',
    ['8/8/8/8/8/8/8/k6K w - - 0 1', '8/8/8/8/8/8/8/kb5K w - - 0 1', '8/8/8/8/8/8/8/kn5K w - - 0 1', '8/8/8/8/5B2/8/8/k1b4K w - - 0 1']
      .every((f) => { const s = R.status(f, []); return s.over && s.reason === 'material'; }));
  ok('a. K+N v K+N and opposite-colour bishops are NOT dead',
    !R.status('8/8/8/8/8/8/8/kn4NK w - - 0 1', []).over && !R.status('8/8/8/8/4B3/8/8/k1b4K w - - 0 1', []).over);
  st = R.status('k7/8/8/8/8/8/1q6/7K w - - 100 80', []);
  ok('a. fifty-move rule (halfmove 100) → draw, automatic', st.over && st.reason === 'fifty');
  st = R.status('k7/8/8/8/8/8/1q6/7K w - - 0 301', []);
  ok('a. ply 600 (fullmove 301, white to move) → draw max_plies', st.over && st.reason === 'max_plies' && R.MAX_PLIES === 600);
  const rep = [START];
  pos = START;
  for (const m of ['g1f3', 'g8f6', 'f3g1', 'f6g8', 'g1f3', 'g8f6', 'f3g1']) { pos = R.apply(pos, m); rep.push(pos); }
  const before3 = R.status(pos, rep.slice(0, -1));
  pos = R.apply(pos, 'f6g8');
  st = R.status(pos, rep);
  ok('a. threefold repetition → draw on the 3rd occurrence, not before', !before3.over && st.over && st.reason === 'repetition');
  ok('a. …the clocks are not part of the identity (start FEN recurs with other counters)', pos !== START);
  // An en passant square with no legal capture does not make a position distinct.
  const epA = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1';
  const epB = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 8 5';
  st = R.status(epB, [epA, 'x', 'x', 'x', epB.replace(' 8 5', ' 4 3'), 'x', 'x', 'x'].map((f) => (f === 'x' ? START : f)));
  ok('a. an unusable en passant square does not break repetition identity', st.over && st.reason === 'repetition');

  // ── [b] bot ─────────────────────────────────────────────────────────────────────────
  console.log('\n[b] bot: deterministic, always legal, budgeted\n');
  const R2 = evaluateRules(chessRules(), path.join(CHESS_DIR, 'rules.js'));   // a second, independent load
  let same = true;
  for (const lvl of [1, 2, 3]) for (const seed of ['aa', 'bb', '0123456789abcdef']) for (const fen of [START, KIWI]) {
    const a = R.bot(fen, lvl, seed, 7), b = R.bot(fen, lvl, seed, 7), c = R2.bot(fen, lvl, seed, 7);
    if (a !== b || a !== c) same = false;
  }
  ok('b. same (position, level, seed, ply) → same move, across calls and separate loads', same);
  const l1 = new Set();
  for (let i = 0; i < 12; i++) l1.add(R.bot(START, 1, `seed${i}`, 0));
  ok('b. level 1 varies with the seed (seeded, not fixed)', l1.size > 3, `${l1.size} distinct`);
  let allLegal = true, games = 0, worst = 0;
  for (const lvl of [1, 2, 3]) {
    for (let g = 0; g < 6; g++) {
      games++;
      let p = START;
      const hist = [];
      for (let ply = 0; ply < 60; ply++) {
        if (R.status(p, hist).over) break;
        const t0 = Date.now();
        const m = R.bot(p, lvl, `g${g}`, ply);
        worst = Math.max(worst, Date.now() - t0);
        if (!R.legal(p).includes(m)) { allLegal = false; break; }
        hist.push(p);
        p = R.apply(p, m);
      }
    }
  }
  ok(`b. every bot move is legal (${games} self-play games, levels 1-3; slowest move ${worst}ms)`, allLegal);
  const backRank = '6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1';
  ok('b. levels 2 and 3 find mate in 1, whatever the seed',
    ['s1', 's2', 's3', 's4'].every((s) => R.bot(backRank, 2, s, 0) === 'a1a8' && R.bot(backRank, 3, s, 0) === 'a1a8'));
  // Black threatens …Ra1# (back rank). Level 3 sees two plies, so whatever the seed it must
  // play a move after which no black reply mates.
  const threat = 'r5k1/5ppp/8/8/8/8/5PPP/6K1 w - - 0 1';
  ok('b. level 3 never allows a mate in 1', ['s1', 's2', 's3', 's4', 's5'].every((s) => {
    const after = R.apply(threat, R.bot(threat, 3, s, 0));
    return R.legal(after).every((reply) => R.status(R.apply(after, reply), []).reason !== 'checkmate');
  }));
  ok('b. …while level 1 is weak enough to allow it for some seed', ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8'].some((s) => {
    const after = R.apply(threat, R.bot(threat, 1, s, 0));
    return R.legal(after).some((reply) => R.status(R.apply(after, reply), []).reason === 'checkmate');
  }));
  const crowded = '7k/qqqqqqqq/qqqqqqqq/8/8/QQQQQQQQ/QQQQQQQQ/K7 w - - 0 1';
  const t0 = Date.now();
  const cs = R.botStats(crowded, 3, 'crowd', 0);
  const crowdMs = Date.now() - t0;
  ok(`b. a crowded position stays within BOT_NODE_BUDGET (${cs.nodes} nodes, ${crowdMs}ms)`,
    cs.nodes <= R.BOT_NODE_BUDGET + 1 && R.legal(crowded).includes(cs.move) && crowdMs < 5000);
  // 2-ply alpha-beta prunes so hard that no real position comes near 20 000 nodes, so the
  // cut-off is proved with a small tests-only budget.
  let maxNodes = 0;
  for (const f of [START, KIWI, crowded, backRank, threat]) for (const s of ['p', 'q', 'r']) maxNodes = Math.max(maxNodes, R.botStats(f, 3, s, 0).nodes);
  const cut = R.botStats(KIWI, 3, 'cut', 3, 40);
  ok(`b. a search that hits its budget stops (budget 40 → ${cut.nodes} nodes, aborted) and still returns a legal move`,
    cut.aborted === true && cut.nodes <= 41 && R.legal(KIWI).includes(cut.move));
  ok('b. …deterministically', R.botStats(KIWI, 3, 'cut', 3, 40).move === cut.move);
  ok(`b. the real worst case seen here is far below the budget (${maxNodes} nodes)`, maxNodes < R.BOT_NODE_BUDGET);
  ok('b. BOT_NODE_BUDGET is 20000 (§19.7)', R.BOT_NODE_BUDGET === 20000);

  // ── [c] registry ────────────────────────────────────────────────────────────────────
  console.log('\n[c] registry: validation, sandbox, containment, bad games skipped\n');
  const REG = path.join(TMP, 'games-a');
  fs.mkdirSync(REG);
  plantGame(REG, 'chess', chessManifest(), chessRules());
  plantGame(REG, 'toy', TOY_MANIFEST, TOY_RULES);
  plantGame(REG, 'Bad_Name', TOY_MANIFEST, TOY_RULES);
  plantGame(REG, 'unk', { ...TOY_MANIFEST, id: 'unk', foo: 1 }, TOY_RULES);
  plantGame(REG, 'mismatch', { ...TOY_MANIFEST, id: 'other' }, TOY_RULES);
  plantGame(REG, 'reserved', { ...TOY_MANIFEST, id: 'reserved', kind: 'chance' }, TOY_RULES);
  plantGame(REG, 'skillgame', { ...TOY_MANIFEST, id: 'skillgame', kind: 'skill' }, TOY_RULES);
  plantGame(REG, 'usesreq', { ...TOY_MANIFEST, id: 'usesreq' }, "require('fs');\n" + TOY_RULES); // scan:ignore
  plantGame(REG, 'usesdate', { ...TOY_MANIFEST, id: 'usesdate' }, TOY_RULES.replace("return '0|-|-';", "return String(Date.now());"));
  plantGame(REG, 'usesrand', { ...TOY_MANIFEST, id: 'usesrand' }, TOY_RULES.replace('return MOVES.slice();', 'return Math.random() > 2 ? [] : MOVES.slice();'));
  plantGame(REG, 'useseval', { ...TOY_MANIFEST, id: 'useseval' }, TOY_RULES.replace("return '0|-|-';", "return eval('\"0|-|-\"');"));
  plantGame(REG, 'loops', { ...TOY_MANIFEST, id: 'loops' }, 'for (;;) {}');
  plantGame(REG, 'norules', { ...TOY_MANIFEST, id: 'norules' }, null);
  plantGame(REG, 'badjson', '{ "id": "badjson", ', TOY_RULES);
  plantGame(REG, 'nobot', { ...TOY_MANIFEST, id: 'nobot' }, TOY_RULES.replace("bot: function () { return 'x'; }", 'nobot: 1'));
  plantGame(REG, 'illegalstart', { ...TOY_MANIFEST, id: 'illegalstart', move_pattern: '^[0-9]$' }, TOY_RULES);
  // A folder that is a junction/symlink to a valid game OUTSIDE the games dir.
  const OUTSIDE = path.join(TMP, 'outside', 'escape');
  plantGame(path.join(TMP, 'outside'), 'escape', { ...TOY_MANIFEST, id: 'escape' }, TOY_RULES);
  let linked = false;
  try { fs.symlinkSync(OUTSIDE, path.join(REG, 'escape'), 'junction'); linked = true; } catch { /* no symlink support */ }
  lines.length = 0;
  const reg = loadGames({ gamesDir: REG, log });
  const skipped = (n) => lines.some((l) => l.includes(`skipped "${n}"`));
  ok('c. chess and toy load', reg.get('chess') !== null && reg.get('toy') !== null && lines.some((l) => /loaded chess 1\.0\.0 \(match; bot\+pvp\)/.test(l)));
  ok('c. exactly the two good games load (every bad one skipped, boot survives)', reg.size === 2, `size ${reg.size}`);
  ok('c. folder name outside ^[a-z0-9-]{2,32}$ skipped', skipped('Bad_Name'));
  ok('c. unknown manifest key skipped (strict manifest)', lines.some((l) => /skipped "unk": manifest foo: unknown key/.test(l)));
  ok('c. id ≠ folder name skipped', lines.some((l) => /skipped "mismatch": manifest id: must equal the folder name/.test(l)));
  ok('c. reserved kinds chance + skill refused with a reason (§19.8)',
    lines.some((l) => /skipped "reserved": .*"chance" is reserved/.test(l)) && lines.some((l) => /skipped "skillgame": .*"skill" is reserved/.test(l)));
  ok('c. the sandbox gives rules.js no require function', lines.some((l) => /skipped "usesreq": require is not defined/.test(l)));
  ok('c. rules.js has no Date (sandbox)', lines.some((l) => /skipped "usesdate": Date is not defined/.test(l)));
  ok('c. rules.js Math.random throws (sandbox)', lines.some((l) => /skipped "usesrand": .*Math\.random/.test(l)));
  ok('c. rules.js string eval refused (codeGeneration)', skipped('useseval'));
  ok('c. an endless loop at load is cut by the 1 s timeout', lines.some((l) => /skipped "loops": .*timed out/.test(l)));
  ok('c. missing rules.js / broken JSON skipped',
    lines.some((l) => /skipped "norules": manifest\.json or rules\.js is missing/.test(l)) && lines.some((l) => /skipped "badjson": manifest\.json is not valid JSON/.test(l)));
  ok('c. modes has bot but rules.bot missing → skipped', lines.some((l) => /skipped "nobot": rules\.bot is missing/.test(l)));
  ok('c. smoke test: legal(initial) must match move_pattern', lines.some((l) => /skipped "illegalstart": .*fails move_pattern/.test(l)));
  if (linked) ok('c. a folder linked OUTSIDE the games dir is refused (real-path containment)', skipped('escape') && reg.get('escape') === null);
  else ok('c. (symlink containment not testable here — no link support)', true);
  const sum = reg.list().find((g) => g.id === 'chess');
  ok('c. list() is a public summary (no rules, no points)', sum && sum.title === 'Chess' && !('rules' in sum) && !('points' in sum)
    && JSON.stringify(sum.move_seconds_options) === '[86400,259200,604800]');
  ok('c. the manifest is deep-frozen', Object.isFrozen(reg.get('chess').manifest.points.bot));
  lines.length = 0;
  const none = loadGames({ gamesDir: path.join(TMP, 'does-not-exist'), log });
  ok('c. a missing games dir → no games, one warning, no throw', none.size === 0 && lines.some((l) => /no games loaded/.test(l)));
  const vm = (patch) => { try { validateManifest({ ...TOY_MANIFEST, ...patch }, 'toy'); return 'ok'; } catch (e) { return e instanceof ManifestError ? e.message : 'other'; } };
  ok('c. manifest: default_move_seconds must be an option', /default_move_seconds/.test(vm({ default_move_seconds: 60 })));
  ok('c. manifest: move_pattern must be anchored', /move_pattern/.test(vm({ move_pattern: '[a-z]+' })));
  ok('c. manifest: points.bot must match bot_levels', /points\.bot/.test(vm({ points: { bot: { 1: 5 } } })));
  ok('c. manifest: pvp points required with mode pvp', /points\.pvp_win/.test(vm({ modes: ['bot', 'pvp'] })));
  ok('c. manifest: a title with a control character is refused', /title/.test(vm({ title: `To${String.fromCharCode(10)}y` })));
  ok('c. manifest: max_plies bounded', /max_plies/.test(vm({ max_plies: 5000 })) && vm({}) === 'ok');

  // ── [d] match API ───────────────────────────────────────────────────────────────────
  console.log('\n[d] matches (bot mode) over a loopback server\n');
  let T = 1_780_000_000_000;                       // ms
  const nowS = () => Math.floor(T / 1000);
  const db = openDb(':memory:', { net: 'mainnet', log });
  const fakeLink = {
    secretConfigured: () => true,
    async verifyProof() { return { ok: true, method: 'ip', slot: 'set', age_seconds: null }; },
    async activity() { return { rows: [], dropped: 0 }; },
    async config() { return { mode: 'preview', chat_enabled: false }; },
  };
  const modeState = { mode: 'preview', chat_enabled: false };
  const fakeMode = { get: () => modeState, isOff: () => modeState.mode === 'off', start() {}, stop() {} };
  const cfg = { net: 'mainnet', poolInternalUrl: 'http://127.0.0.1:9', linkSecretFile: path.join(TMP, 'none') };
  const app = buildApp({ config: cfg, db, log, clock: () => T, poolLink: fakeLink, mode: fakeMode, registry: reg });
  const { ledger, settings, matches } = app.services;
  const srv = createServer(app.handler);
  const { port } = await listen(srv, 0, '127.0.0.1');
  const HOST = 'pool.example';
  const J = { 'Content-Type': 'application/json', Host: HOST };
  let ipN = 1;
  const post = (p, body, { cookie, headers = {} } = {}) => request(port, {
    method: 'POST', path: p, body: JSON.stringify(body),
    headers: { ...J, 'X-Real-IP': '203.0.113.9', ...(cookie ? { Cookie: cookie } : {}), ...headers },
  });
  const get = (p, { cookie } = {}) => request(port, { path: p, headers: { Host: HOST, 'X-Real-IP': '203.0.113.9', ...(cookie ? { Cookie: cookie } : {}) } });
  async function login(address) {
    const res = await request(port, { method: 'POST', path: '/play/api/login', body: JSON.stringify({ address, proof: 'ip-ok' }),
      headers: { ...J, 'X-Real-IP': `198.51.100.${ipN++}` } });
    const sc = res.headers['set-cookie'];
    return (Array.isArray(sc) ? sc[0] : sc).split(';')[0];
  }
  let wref = 0;
  const givePlays = (a, n) => ledger.credit(a, 'plays', n, 'mining_minutes', `w:${++wref}`);
  const plays = (a) => db.raw.prepare('SELECT plays, points FROM players WHERE address = ?').get(a);
  const tick = (s = 5) => { T += s * 1000; };      // refills the per-address move bucket
  const row = (id) => db.raw.prepare('SELECT * FROM matches WHERE id = ?').get(id);
  const countMatches = () => db.raw.prepare('SELECT COUNT(*) AS n FROM matches').get().n;

  const A = addr(1), B = addr(2), C = addr(3), D = addr(4);
  const ca = await login(A), cb = await login(B), cc = await login(C), cd = await login(D);
  givePlays(A, 50); givePlays(B, 5); givePlays(D, 60);

  let res = await get('/play/api/games');
  ok('d. GET /games lists the loaded games', res.status === 200 && res.json.games.map((g) => g.id).sort().join() === 'chess,toy');

  // Create validation.
  const create = (cookie, body) => post('/play/api/matches', body, { cookie });
  res = await create(null, { game_id: 'chess', mode: 'bot', bot_level: 1 });
  ok('d. create without a session → 401', res.status === 401);
  ok('d. unknown game → 404 unknown_game', (await create(ca, { game_id: 'nope', mode: 'bot', bot_level: 1 })).json.error === 'unknown_game');
  // PvP (Part 10) is covered by test-pvp.js; here only that its fields do not mix with bot's.
  ok('d. pvp with a bot_level / bot with a target → 400, nothing created',
    (await create(ca, { game_id: 'chess', mode: 'pvp', bot_level: 1 })).json.field === 'bot_level'
    && (await create(ca, { game_id: 'chess', mode: 'bot', bot_level: 1, target: B })).json.field === 'target' && countMatches() === 0);
  ok('d. bad bot_level / colour / move_seconds → 400 naming the field',
    (await create(ca, { game_id: 'chess', mode: 'bot', bot_level: 4 })).json.field === 'bot_level'
    && (await create(ca, { game_id: 'chess', mode: 'bot', bot_level: 1, colour: 'white' })).json.field === 'colour'
    && (await create(ca, { game_id: 'chess', mode: 'bot', bot_level: 1, move_seconds: 60 })).json.field === 'move_seconds'
    && (await create(ca, { game_id: 'chess', mode: 'bot', bot_level: '1' })).json.field === 'bot_level');
  ok('d. a forged field on create (position) → 400, nothing created',
    (await create(ca, { game_id: 'chess', mode: 'bot', bot_level: 1, position: '8/8/8/8/8/8/8/k6K w - - 0 1' })).json.field === 'body' && countMatches() === 0);
  ok('d. a cross-site POST is refused (CSRF layer 3)', (await post('/play/api/matches', { game_id: 'chess', mode: 'bot', bot_level: 1 },
    { cookie: ca, headers: { Origin: 'https://evil.example' } })).status === 403);
  ok('d. no plays → 409 no_plays, and no match row is left behind',
    (await create(cc, { game_id: 'chess', mode: 'bot', bot_level: 1 })).json.error === 'no_plays' && countMatches() === 0);

  // A chess game as white.
  res = await create(ca, { game_id: 'chess', mode: 'bot', bot_level: 1, colour: 'seat1' });
  const m1 = res.json.match;
  ok('d. create as white: active, you=1, your turn, 20 legal moves, ply 0', res.status === 200 && m1.state === 'active'
    && m1.you === 1 && m1.your_turn && m1.legal.length === 20 && m1.ply === 0 && m1.position === START);
  ok('d. …labels are masked / "Bot level 1", and no seed is sent', m1.labels[1] === `${A.slice(0, 9)}…${A.slice(-4)}`
    && m1.labels[2] === 'Bot level 1' && !res.text.includes('seed') && !res.text.includes(A));
  ok('d. …one play debited, ledger ref m:<id>:1', plays(A).plays === 49
    && db.raw.prepare("SELECT ref FROM ledger WHERE address = ? AND reason = 'match_cost'").get(A).ref === `m:${m1.id}:1`);
  ok('d. a second bot chess game while one is active → 409 active_match with its id',
    (await create(ca, { game_id: 'chess', mode: 'bot', bot_level: 2 })).json.match_id === m1.id && plays(A).plays === 49);

  const mv = (cookie, id, body) => post(`/play/api/matches/${id}/move`, body, { cookie });
  tick();
  res = await mv(ca, m1.id, { ply: 0, move: 'e2e4' });
  ok('d. a move → the bot replies in the same request (ply 2, your turn again)', res.status === 200 && res.json.match.ply === 2
    && res.json.match.your_turn && res.json.match.moves.length === 2 && res.json.match.moves[0] === 'e2e4'
    && res.json.match.last_move === res.json.match.moves[1]);
  const p2 = res.json.match.position;
  tick();
  ok('d. stale ply → 409 stale, unchanged', (await mv(ca, m1.id, { ply: 0, move: 'd2d4' })).json.error === 'stale' && row(m1.id).ply === 2);
  tick();
  ok('d. illegal move → 400 illegal_move, unchanged', (await mv(ca, m1.id, { ply: 2, move: 'e4e6' })).json.error === 'illegal_move' && row(m1.id).position === p2);
  tick();
  ok('d. a move failing move_pattern → 400 illegal_move', (await mv(ca, m1.id, { ply: 2, move: 'O-O' })).json.error === 'illegal_move');
  tick();
  const forged = await mv(ca, m1.id, { ply: 2, move: 'd2d4', position: START, result: 'seat1', score: 99, points: 5 });
  ok('d. forged position/result/score/points → 400 body, unchanged (refused, never applied)',
    forged.status === 400 && forged.json.field === 'body' && row(m1.id).ply === 2 && row(m1.id).position === p2);
  tick();
  ok('d. ply as a string / move too long → 400', (await mv(ca, m1.id, { ply: '2', move: 'd2d4' })).json.field === 'ply'
    && (await mv(ca, m1.id, { ply: 2, move: 'x'.repeat(17) })).json.field === 'move');
  tick();
  ok('d. another address\'s match → 403 not_your_match', (await mv(cb, m1.id, { ply: 2, move: 'd2d4' })).json.error === 'not_your_match');
  ok('d. an unknown match → 404; a non-numeric id → 404', (await mv(ca, 99999, { ply: 0, move: 'e2e4' })).status === 404
    && (await mv(ca, 'abc', { ply: 0, move: 'e2e4' })).status === 404);

  // Two racing moves for the same ply: exactly one wins.
  tick();
  const [r1, r2] = await Promise.all([mv(ca, m1.id, { ply: 2, move: 'd2d4' }), mv(ca, m1.id, { ply: 2, move: 'g1f3' })]);
  ok('d. two racing moves for one ply → exactly one 200, the other 409 stale',
    [r1.status, r2.status].sort().join() === '200,409' && row(m1.id).ply === 4);

  // Rate limit: burst 3, then 429.
  tick();
  const burst = [];
  for (let i = 0; i < 4; i++) burst.push((await mv(ca, m1.id, { ply: 0, move: 'e2e4' })).status);
  ok('d. ≤ 1 move/s per address (burst 3) → 429 with Retry-After', burst.join() === '409,409,409,429');

  // Public view.
  res = await get(`/play/api/matches/${m1.id}?since_ply=2`);
  ok('d. GET /:id is public: you=null, no legal list, masked, no full address, no seed', res.status === 200
    && res.json.match.you === null && res.json.match.legal === null && !res.text.includes(A) && !res.text.includes('seed'));
  ok('d. since_ply returns only the moves from that ply', res.json.match.moves.length === 2 && res.json.match.since_ply === 2);
  ok('d. bad since_ply → 400', (await get(`/play/api/matches/${m1.id}?since_ply=-1`)).status === 400
    && (await get(`/play/api/matches/${m1.id}?since_ply=1&since_ply=2`)).status === 400);
  res = await get(`/play/api/matches/${m1.id}`, { cookie: ca });
  ok('d. GET /:id with the player\'s session → you=1 + legal moves', res.json.match.you === 1 && Array.isArray(res.json.match.legal));

  // Resign: settles once.
  res = await post(`/play/api/matches/${m1.id}/resign`, {}, { cookie: ca });
  ok('d. resign → finished, the bot seat wins, reason resign', res.status === 200 && res.json.match.state === 'finished'
    && res.json.match.status.result === 'seat2' && res.json.match.status.reason === 'resign');
  ok('d. resign twice → 409 not_active (settles once)', (await post(`/play/api/matches/${m1.id}/resign`, {}, { cookie: ca })).json.error === 'not_active');
  tick();
  ok('d. a move after the end → 409 not_active', (await mv(ca, m1.id, { ply: 4, move: 'a2a3' })).json.error === 'not_active');
  const rd = db.raw.prepare("SELECT * FROM results_daily WHERE address = ? AND game_id = 'chess'").get(A);
  ok('d. results_daily: one bot game, one loss, 0 points', rd && rd.mode === 'bot' && rd.games === 1 && rd.losses === 1 && rd.points === 0);
  ok('d. resign with a body field → 400', (await post(`/play/api/matches/${m1.id}/resign`, { result: 'seat1' }, { cookie: ca })).status === 400);

  // Black: the bot opens.
  res = await create(ca, { game_id: 'chess', mode: 'bot', bot_level: 3, colour: 'seat2' });
  const m2 = res.json.match;
  ok('d. create as black: the bot has already moved (ply 1), your turn', m2.you === 2 && m2.ply === 1 && m2.your_turn
    && m2.labels[1] === 'Bot level 3' && R.toMove(m2.position) === 2);
  // Timeout at ply < 2 → aborted + refunded, by the sweep.
  const beforeAbort = plays(A).plays;
  T += (259200 + 1) * 1000;
  let sw = matches.sweepTimeouts();
  ok('d. deadline passed at ply < 2 → the sweep ABORTS and refunds the play', sw.finalised === 1 && row(m2.id).state === 'aborted'
    && row(m2.id).reason === 'timeout' && plays(A).plays === beforeAbort + 1);
  sw = matches.sweepTimeouts();
  ok('d. the sweep is idempotent (nothing left, no second refund)', sw.finalised === 0 && plays(A).plays === beforeAbort + 1);

  // Timeout at ply ≥ 2 → the side to move loses, lazily on a read.
  res = await create(ca, { game_id: 'chess', mode: 'bot', bot_level: 2, colour: 'seat1' });
  const m3 = res.json.match;
  tick();
  await mv(ca, m3.id, { ply: 0, move: 'd2d4' });
  T += (259200 + 1) * 1000;
  res = await get(`/play/api/matches/${m3.id}`);
  ok('d. deadline passed at ply ≥ 2 → a read finalises it: the side to move loses (timeout)',
    res.json.match.state === 'finished' && res.json.match.status.result === 'seat2' && res.json.match.status.reason === 'timeout');
  // A move after the deadline: the timeout is COMMITTED, then 409.
  res = await create(ca, { game_id: 'chess', mode: 'bot', bot_level: 1, colour: 'seat1' });
  const m4 = res.json.match;
  T += (259200 + 1) * 1000;
  res = await mv(ca, m4.id, { ply: 0, move: 'e2e4' });
  ok('d. a move after the deadline → 409 timeout, and the abort is committed', res.json.error === 'timeout' && row(m4.id).state === 'aborted');
  // An expired active bot game does not block a new one.
  res = await create(ca, { game_id: 'chess', mode: 'bot', bot_level: 1, colour: 'seat1' });
  const m5 = res.json.match;
  T += (259200 + 1) * 1000;
  res = await create(ca, { game_id: 'chess', mode: 'bot', bot_level: 1, colour: 'seat1' });
  ok('d. creating over an EXPIRED active bot game finalises the old one first', res.status === 200 && row(m5.id).state === 'aborted');
  await post(`/play/api/matches/${res.json.match.id}/resign`, {}, { cookie: ca });

  // ── Toy game: settle paths, points, caps ──────────────────────────────────────────
  const toy = async (cookie, level, moves) => {
    const r0 = await create(cookie, { game_id: 'toy', mode: 'bot', bot_level: level, colour: 'seat1' });
    let r = r0;
    for (const m of moves) { tick(); r = await mv(cookie, r0.json.match.id, { ply: r.json.match.ply, move: m }); }
    return r;
  };
  const pD = () => plays(D);
  let before = pD();
  res = await toy(cd, 2, ['win']);
  ok('d. a win vs bot level 2 → bot_points[2] = 7 points, ledger ref m:<id>:1', res.json.match.status.result === 'seat1'
    && pD().points === before.points + 7 && pD().plays === before.plays - 1
    && db.raw.prepare("SELECT ref FROM ledger WHERE address = ? AND reason = 'match_result'").get(D).ref === `m:${res.json.match.id}:1`);
  before = pD();
  res = await toy(cd, 2, ['draw']);
  ok('d. a draw → half, rounded down (3)', res.json.match.status.result === 'draw' && pD().points === before.points + 3);
  before = pD();
  res = await toy(cd, 1, ['x', 'x', 'x']);
  ok('d. max_plies (toy: 6) is enforced by the PLATFORM → draw max_plies', res.json.match.state === 'finished'
    && res.json.match.status.reason === 'max_plies' && res.json.match.ply === 6 && pD().points === before.points + 2);
  settings.set('points_daily_cap', 15, 'test');
  before = pD();
  res = await toy(cd, 2, ['win']);
  ok('d. the daily points cap clips the award (12 so far + 7 → capped at 15)', pD().points === before.points + 3);
  before = pD();
  await toy(cd, 2, ['win']);
  ok('d. …and pays nothing more that UTC day', pD().points === before.points);
  const rdToy = db.raw.prepare("SELECT * FROM results_daily WHERE address = ? AND game_id = 'toy'").get(D);
  ok('d. results_daily records games + the points actually credited', rdToy.games === 5 && rdToy.wins === 3 && rdToy.draws === 2 && rdToy.points === 15);
  T += 86400 * 1000;
  before = pD();
  await toy(cd, 1, ['win']);
  ok('d. the cap resets at the next UTC day', pD().points === before.points + 5);
  settings.set('points_daily_cap', 100, 'test');
  settings.set('bot_play_cost', 0, 'test');
  before = pD();
  const rdBefore = db.raw.prepare("SELECT games, wins FROM results_daily WHERE address = ? AND game_id = 'toy' AND day = ?")
    .get(D, new Date(T).toISOString().slice(0, 10));
  res = await toy(cd, 2, ['win']);
  ok('d. bot_play_cost 0: the game is free AND pays no points (§19.15 Part 5)', res.json.match.status.result === 'seat1'
    && pD().plays === before.plays && pD().points === before.points);
  const rdAfter = db.raw.prepare("SELECT games, wins FROM results_daily WHERE address = ? AND game_id = 'toy' AND day = ?")
    .get(D, new Date(T).toISOString().slice(0, 10));
  ok('d. …and enters no results_daily row, so it feeds no wins board or event (§19.15 Part 11)',
    rdBefore && rdAfter && rdAfter.games === rdBefore.games && rdAfter.wins === rdBefore.wins);
  settings.set('bot_play_cost', 1, 'test');

  // A throwing rules.js leaves the match unchanged and the service up.
  res = await create(cd, { game_id: 'toy', mode: 'bot', bot_level: 1, colour: 'seat1' });
  const mb = res.json.match;
  tick();
  lines.length = 0;
  res = await mv(cd, mb.id, { ply: 0, move: 'boom' });
  ok('d. rules.apply throws → 500 game_error, the match is unchanged', res.status === 500 && res.json.error === 'game_error'
    && row(mb.id).ply === 0 && row(mb.id).state === 'active');
  ok('d. …logged with the game and the function, and the service still answers',
    lines.some((l) => /toy rules\.apply threw \(match \d+\): toy apply exploded/.test(l)) && (await get('/play/api/health')).status === 200);
  tick();
  ok('d. …and the match still plays afterwards', (await mv(cd, mb.id, { ply: 0, move: 'x' })).json.match.ply === 2);
  await post(`/play/api/matches/${mb.id}/resign`, {}, { cookie: cd });

  // Settle exactly once, even when called twice.
  const done = row(mb.id);
  let settleTwice = false;
  try { db.transaction(() => matches._internal.settle({ ...done }, reg.get('toy'), 'seat1', 'resign', nowS())); } catch { settleTwice = true; }
  ok('d. settle on a finished match throws (UPDATE … WHERE state=active) and writes nothing', settleTwice && row(mb.id).result === 'seat2');

  // /mine paging.
  for (let i = 0; i < 21; i++) {
    const c = await create(cd, { game_id: 'toy', mode: 'bot', bot_level: 1, colour: 'seat1' });
    await post(`/play/api/matches/${c.json.match.id}/resign`, {}, { cookie: cd });
  }
  res = await get('/play/api/matches/mine', { cookie: cd });
  const page1 = res.json.matches;
  ok('d. /mine: 20 per page, newest first, next_before set', page1.length === 20 && page1[0].id > page1[19].id
    && res.json.next_before === page1[19].id);
  res = await get(`/play/api/matches/mine?before=${page1[19].id}`, { cookie: cd });
  const allMine = db.raw.prepare('SELECT COUNT(*) AS n FROM matches WHERE seat1 = ? OR seat2 = ?').get(D, D).n;
  ok('d. /mine?before= pages the rest, no overlap', res.json.matches.length === allMine - 20 && res.json.matches[0].id < page1[19].id
    && res.json.next_before === null);
  ok('d. /mine rows are masked and carry no position or seed', !JSON.stringify(page1).includes(D) && !('position' in page1[0]) && !JSON.stringify(page1).includes('seed'));
  ok('d. /mine?state=aborted filters; a bad state → 400', (await get('/play/api/matches/mine?state=active', { cookie: cd })).json.matches.length === 0
    && (await get('/play/api/matches/mine?state=bogus', { cookie: cd })).status === 400);
  ok('d. /mine without a session → 401', (await get('/play/api/matches/mine')).status === 401);

  // Mode off hides everything.
  modeState.mode = 'off';
  ok('d. mode off → /games, /matches/:id, create all 404', (await get('/play/api/games')).status === 404
    && (await get(`/play/api/matches/${m1.id}`)).status === 404
    && (await create(ca, { game_id: 'chess', mode: 'bot', bot_level: 1 })).status === 404);
  modeState.mode = 'preview';

  // Worst-case move: a long chess game (replay of every ply) + a level-3 reply.
  let longest = null;
  for (let g = 0; g < 40 && !(longest && longest.moves.length >= 400); g++) {
    let p = START;
    const hist = [];
    const moves = [];
    for (let ply = 0; ply < 590; ply++) {
      if (R.status(p, hist).over) break;
      const m = R.bot(p, 1, `long${g}`, ply);
      hist.push(p); moves.push(m); p = R.apply(p, m);
    }
    // End on a position that is still in play: drop the move that ended the game.
    if (R.status(p, hist).over) moves.pop();
    let q = START;
    for (const m of moves) q = R.apply(q, m);
    if (!longest || moves.length > longest.moves.length) longest = { moves, pos: q };
  }
  const human = R.toMove(longest.pos);
  const tS = nowS();
  const ins = db.raw.prepare(
    "INSERT INTO matches (game_id, game_version, mode, state, seat1, seat2, created_by, params_json, seed, position, ply, turn_deadline, created_at, started_at) " +
    "VALUES ('chess', '1.0.0', 'bot', 'active', ?, ?, ?, ?, 'abcd', ?, ?, ?, ?, ?)").run(
    human === 1 ? A : 'bot:3', human === 2 ? A : 'bot:3', A, JSON.stringify({ move_seconds: 259200, colour: 'seat1', bot_level: 3, cost: 1 }),
    longest.pos, longest.moves.length, tS + 259200, tS, tS);
  const longId = Number(ins.lastInsertRowid);
  const insMove = db.raw.prepare('INSERT INTO match_moves (match_id, ply, seat, move, at) VALUES (?, ?, ?, ?, ?)');
  longest.moves.forEach((m, i) => insMove.run(longId, i, (i % 2) + 1, m, tS));
  tick();
  const firstLegal = R.legal(longest.pos)[0];
  const tm0 = process.hrtime.bigint();
  res = await mv(ca, longId, { ply: longest.moves.length, move: firstLegal });
  const moveMs = Number(process.hrtime.bigint() - tm0) / 1e6;
  ok(`d. worst-case move request: replay of ${longest.moves.length} plies + a level-3 reply in ${moveMs.toFixed(1)}ms (< 1500)`,
    res.status === 200 && moveMs < 1500, `status ${res.status} ${res.text.slice(0, 120)}`);

  if (row(longId).state === 'active') db.raw.prepare("UPDATE matches SET state = 'void', finished_at = ? WHERE id = ?").run(nowS(), longId);

  // Replay integrity: a tampered stored position is refused, not trusted. The tamper keeps
  // the side to move (toy: the ply count is unchanged), so the turn check passes and the
  // replay is what catches it.
  res = await create(cd, { game_id: 'toy', mode: 'bot', bot_level: 1, colour: 'seat1' });
  const mt = res.json.match;
  tick();
  await mv(cd, mt.id, { ply: 0, move: 'x' });
  db.raw.prepare('UPDATE matches SET position = ? WHERE id = ?').run('2|x|1', mt.id);
  tick();
  lines.length = 0;
  res = await mv(cd, mt.id, { ply: 2, move: 'x' });
  ok('d. a stored position that the move list does not replay to → 500 game_error, logged, unchanged', res.status === 500
    && res.json.error === 'game_error' && lines.some((l) => /does not replay/.test(l)) && row(mt.id).ply === 2, `${res.status} ${res.text}`);
  await post(`/play/api/matches/${mt.id}/resign`, {}, { cookie: cd });

  // Retention: bot move lists go after 60 days; the watermark never skips.
  const purgeA = await create(ca, { game_id: 'chess', mode: 'bot', bot_level: 1, colour: 'seat1' });
  tick();
  await mv(ca, purgeA.json.match.id, { ply: 0, move: 'e2e4' });
  await post(`/play/api/matches/${purgeA.json.match.id}/resign`, {}, { cookie: ca });
  const stillActive = await create(ca, { game_id: 'toy', mode: 'bot', bot_level: 1, colour: 'seat1' });
  tick();
  await mv(ca, stillActive.json.match.id, { ply: 0, move: 'x' });
  T += (BOT_MOVES_KEEP_S + 3600) * 1000;
  // Keep the active toy game alive past its own deadline for this check.
  db.raw.prepare('UPDATE matches SET turn_deadline = ? WHERE id = ?').run(nowS() + 3600, stillActive.json.match.id);
  const movesOf = (id) => db.raw.prepare('SELECT COUNT(*) AS n FROM match_moves WHERE match_id = ?').get(id).n;
  let pr = matches.purgeBotMoves();
  ok('d. bot moves older than 60 days are purged; the match row stays', movesOf(purgeA.json.match.id) === 0 && row(purgeA.json.match.id) !== undefined && pr.purged > 0);
  ok('d. an ACTIVE bot match keeps its moves and holds the watermark below it',
    movesOf(stillActive.json.match.id) === 2 && pr.through < stillActive.json.match.id);
  res = await get(`/play/api/matches/${purgeA.json.match.id}`);
  ok('d. a purged match still reads: moves = [], position kept', res.status === 200 && res.json.match.moves.length === 0 && res.json.match.ply === 2);
  pr = matches.purgeBotMoves();
  ok('d. a second purge is a no-op', pr.purged === 0);

  ok('d. the plays/points ledger invariant holds after everything above', ledger.verify().length === 0, JSON.stringify(ledger.verify().slice(0, 3)));
  ok('d. no player ever went below 0 plays', db.raw.prepare('SELECT COUNT(*) AS n FROM players WHERE plays < 0 OR points < 0').get().n === 0);
  ok('d. every match_cost has at most one refund and never both a refund and points',
    db.raw.prepare("SELECT COUNT(*) AS n FROM ledger a JOIN ledger b ON a.ref = b.ref AND a.address = b.address " +
      "WHERE a.reason = 'match_refund' AND b.reason = 'match_result'").get().n === 0);

  // Query plans: every hot read is indexed.
  const plan = (sql, ...a) => db.raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...a).map((r) => r.detail).join(' | ');
  const pSweep = plan("SELECT id FROM matches WHERE state = 'active' AND turn_deadline <= ? ORDER BY turn_deadline LIMIT ?", 1, 1);
  const pBot = plan("SELECT id FROM matches WHERE game_id = ? AND created_by = ? AND mode = 'bot' AND state = 'active'", 'chess', A);
  const pMine = plan('SELECT id FROM matches WHERE seat1 = ? AND id < ? UNION ALL SELECT id FROM matches WHERE seat2 = ? AND id < ?', A, 9, A, 9);
  ok('d. EXPLAIN: sweep uses idx_matches_state, active-bot uses uq_matches_one_bot, /mine uses both seat indexes',
    /idx_matches_state/.test(pSweep) && /uq_matches_one_bot/.test(pBot) && /idx_matches_seat1/.test(pMine) && /idx_matches_seat2/.test(pMine)
    && !/SCAN matches/.test(pSweep + pBot + pMine), `${pSweep} ## ${pBot} ## ${pMine}`);

  await new Promise((r) => srv.close(r));
  db.close();
}

main().catch((e) => {
  fail++;
  console.error(`  FAIL  suite crashed: ${e && e.stack ? e.stack : e}`);
}).finally(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }
  console.log(`\nRESULT pass=${pass} fail=${fail}`);
  process.exitCode = fail ? 1 : 0;
});
