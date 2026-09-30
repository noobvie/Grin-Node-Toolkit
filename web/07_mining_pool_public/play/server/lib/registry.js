'use strict';

// Game registry (design §19.7, D17): at boot, load every play/games/<id>/ folder —
// manifest.json + rules.js — from the configured games dir. A game is one folder; adding
// one never touches platform code.
//
// Rules this module enforces, each one a way a game folder could hurt the service:
//   - A bad game is SKIPPED with one log line and never crashes boot: a broken manifest, an
//     unknown or reserved kind, a rules.js that fails to load or fails the smoke test.
//   - Only v1's `match` kind loads. `skill` and `chance` are RESERVED (§19.8): their
//     platform parts (rounds, replay, commit-reveal) are not built, so a game declaring one
//     is refused rather than half-served.
//   - PATH CONTAINMENT. Files are read only from inside the games dir, checked on the
//     REAL path, so a symlinked folder or file pointing elsewhere is refused. Sizes are
//     capped before a byte is parsed.
//   - rules.js is NOT require()d. It is evaluated in its own vm context that has no
//     require, process, console or timers, refuses string eval / WASM codegen, has no Date,
//     and whose Math.random throws. §19.7 says rules.js is pure and deterministic; this
//     makes a slip loud (a throw the platform catches) instead of a quiet
//     nondeterminism. It is NOT a security boundary — rules.js is our own reviewed code,
//     deployed by the operator — it is a purity check.
//   - The manifest is strict: an unknown key is refused, so a typo cannot silently fall
//     back to a default.

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ID_RE = /^[a-z0-9-]{2,32}$/;
const VERSION_RE = /^[A-Za-z0-9._-]{1,16}$/;
const KINDS_RESERVED = new Set(['skill', 'chance']);
const MODES = ['bot', 'pvp'];
const MANIFEST_MAX = 16 * 1024;
const RULES_MAX = 512 * 1024;
const MANIFEST_KEYS = new Set([
  'id', 'title', 'kind', 'version', 'seats', 'modes', 'bot_levels', 'move_pattern',
  'move_seconds_options', 'default_move_seconds', 'max_plies', 'points',
]);
const RULES_API = ['initial', 'toMove', 'legal', 'apply', 'status'];
const MOVE_SECONDS_MIN = 60;
const MOVE_SECONDS_MAX = 30 * 86400;
const MAX_PLIES_MAX = 2000;
const POINTS_MAX = 1000;

class ManifestError extends Error {}

const isInt = (v, min, max) => Number.isSafeInteger(v) && v >= min && v <= max;
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
// Printable text: no control characters (C0, DEL, C1) and no line/paragraph separators.
// Checked by char code, not a regex: a regex source would need the separator characters
// written as escapes, and an editor that expands them breaks the literal (it did, once).
function isPrintable(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || (c >= 0x7f && c <= 0x9f) || c === 0x2028 || c === 0x2029) return false;
  }
  return true;
}

function isInside(child, parent) {
  const rel = path.relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

// → the validated manifest (a frozen copy), or throws ManifestError naming the field.
function validateManifest(m, folder) {
  const bad = (field, why) => { throw new ManifestError(`${field}: ${why}`); };
  if (!isPlainObject(m)) bad('manifest', 'must be a JSON object');
  for (const k of Object.keys(m)) if (!MANIFEST_KEYS.has(k)) bad(k, 'unknown key');

  if (typeof m.id !== 'string' || !ID_RE.test(m.id)) bad('id', 'must match ^[a-z0-9-]{2,32}$');
  if (m.id !== folder) bad('id', 'must equal the folder name');
  if (typeof m.title !== 'string' || m.title.trim() === '' || m.title.length > 40 || !isPrintable(m.title)) {
    bad('title', '1-40 printable characters');
  }
  if (typeof m.kind !== 'string') bad('kind', 'required');
  if (KINDS_RESERVED.has(m.kind)) bad('kind', `"${m.kind}" is reserved and not built in v1 (§19.8)`);
  if (m.kind !== 'match') bad('kind', 'must be "match"');
  if (typeof m.version !== 'string' || !VERSION_RE.test(m.version)) bad('version', '1-16 chars of [A-Za-z0-9._-]');
  if (m.seats !== 2) bad('seats', 'must be 2');

  if (!Array.isArray(m.modes) || m.modes.length === 0 || m.modes.length > MODES.length
      || m.modes.some((x) => !MODES.includes(x)) || new Set(m.modes).size !== m.modes.length) {
    bad('modes', 'a non-empty subset of ["bot","pvp"]');
  }
  const hasBot = m.modes.includes('bot');
  const hasPvp = m.modes.includes('pvp');

  if (hasBot) {
    if (!Array.isArray(m.bot_levels) || m.bot_levels.length === 0 || m.bot_levels.length > 9
        || m.bot_levels.some((x) => !isInt(x, 1, 9)) || new Set(m.bot_levels).size !== m.bot_levels.length) {
      bad('bot_levels', 'distinct integers 1-9');
    }
  } else if (m.bot_levels !== undefined) {
    bad('bot_levels', 'only with mode "bot"');
  }

  if (typeof m.move_pattern !== 'string' || m.move_pattern.length > 200
      || !m.move_pattern.startsWith('^') || !m.move_pattern.endsWith('$')) {
    bad('move_pattern', 'an anchored regex source (^…$), ≤ 200 chars');
  }
  let moveRe;
  try { moveRe = new RegExp(m.move_pattern); } catch { bad('move_pattern', 'does not compile'); }

  if (!Array.isArray(m.move_seconds_options) || m.move_seconds_options.length === 0 || m.move_seconds_options.length > 8
      || m.move_seconds_options.some((x) => !isInt(x, MOVE_SECONDS_MIN, MOVE_SECONDS_MAX))
      || new Set(m.move_seconds_options).size !== m.move_seconds_options.length) {
    bad('move_seconds_options', `1-8 distinct integers ${MOVE_SECONDS_MIN}-${MOVE_SECONDS_MAX}`);
  }
  if (!m.move_seconds_options.includes(m.default_move_seconds)) bad('default_move_seconds', 'must be one of move_seconds_options');
  if (!isInt(m.max_plies, 2, MAX_PLIES_MAX)) bad('max_plies', `an integer 2-${MAX_PLIES_MAX}`);

  const p = m.points;
  if (!isPlainObject(p)) bad('points', 'must be an object');
  const pKeys = new Set([...(hasBot ? ['bot'] : []), ...(hasPvp ? ['pvp_win', 'pvp_draw'] : [])]);
  for (const k of Object.keys(p)) if (!pKeys.has(k)) bad(`points.${k}`, 'unknown key for these modes');
  for (const k of pKeys) if (!(k in p)) bad(`points.${k}`, 'required');
  if (hasBot) {
    if (!isPlainObject(p.bot)) bad('points.bot', 'an object keyed by bot level');
    const want = m.bot_levels.map(String).sort().join();
    if (Object.keys(p.bot).sort().join() !== want) bad('points.bot', 'must have exactly one key per bot level');
    for (const v of Object.values(p.bot)) if (!isInt(v, 0, POINTS_MAX)) bad('points.bot', `values 0-${POINTS_MAX}`);
  }
  if (hasPvp) {
    if (!isInt(p.pvp_win, 0, POINTS_MAX)) bad('points.pvp_win', `0-${POINTS_MAX}`);
    if (!isInt(p.pvp_draw, 0, POINTS_MAX)) bad('points.pvp_draw', `0-${POINTS_MAX}`);
  }

  // A deep, frozen copy: nothing downstream can mutate what the next request reads.
  const copy = JSON.parse(JSON.stringify(m));
  const deepFreeze = (o) => { for (const v of Object.values(o)) if (v && typeof v === 'object') deepFreeze(v); return Object.freeze(o); };
  return { manifest: deepFreeze(copy), moveRe };
}

// Evaluate rules.js in a fresh context. → its module.exports (the API object).
function evaluateRules(source, filename) {
  const sandbox = { module: { exports: {} } };
  sandbox.exports = sandbox.module.exports;
  const ctx = vm.createContext(sandbox, {
    name: `rules:${path.basename(path.dirname(filename))}`,
    codeGeneration: { strings: false, wasm: false },
  });
  // Purity guards, applied inside the context before the game's code runs.
  vm.runInContext(
    "delete globalThis.Date; Math.random = function () { throw new Error('rules.js must not use Math.random (§19.7)'); };",
    ctx, { timeout: 1000 });
  new vm.Script(source, { filename }).runInContext(ctx, { timeout: 1000 });
  return sandbox.module.exports;
}

// The rules API must be present, and must behave on the start position — a rules.js that
// cannot even describe its first move is a broken deploy, found at boot instead of on the
// first player's request.
function smokeTest(rules, manifest, moveRe) {
  for (const fn of RULES_API) if (typeof rules[fn] !== 'function') throw new Error(`rules.${fn} is missing`);
  if (manifest.modes.includes('bot') && typeof rules.bot !== 'function') throw new Error('rules.bot is missing (modes includes "bot")');
  const pos = rules.initial({});
  if (typeof pos !== 'string' || pos === '' || pos.length > 512) throw new Error('initial() must return a non-empty string ≤ 512 chars');
  const who = rules.toMove(pos);
  if (who !== 1 && who !== 2) throw new Error('toMove(initial) must be 1 or 2');
  const moves = rules.legal(pos);
  if (!Array.isArray(moves) || moves.length === 0) throw new Error('legal(initial) must be a non-empty array');
  for (const mv of moves) {
    if (typeof mv !== 'string' || mv.length > 16 || !moveRe.test(mv)) throw new Error('legal(initial) returned a move that fails move_pattern');
  }
  const st = rules.status(pos, []);
  if (!st || st.over !== false) throw new Error('status(initial) must be { over:false }');
  const next = rules.apply(pos, moves[0]);
  if (typeof next !== 'string' || next === '') throw new Error('apply(initial, legal[0]) must return a position');
}

function readCapped(file, max, what) {
  const st = fs.statSync(file);
  if (!st.isFile()) throw new Error(`${what} is not a regular file`);
  if (st.size > max) throw new Error(`${what} is larger than ${max} bytes`);
  return fs.readFileSync(file, 'utf8');
}

// loadGames({ gamesDir, log }) → registry { get(id), list(), size }
function loadGames({ gamesDir, log }) {
  const games = new Map();
  const done = () => ({
    get: (id) => (typeof id === 'string' && games.has(id) ? games.get(id) : null),
    list: () => [...games.values()].map((g) => g.summary),
    size: games.size,
  });

  if (typeof gamesDir !== 'string' || gamesDir === '') {
    log.warn('[games] no games dir configured — no games loaded');
    return done();
  }
  let root;
  try {
    root = fs.realpathSync(gamesDir);
    if (!fs.statSync(root).isDirectory()) throw new Error('not a directory');
  } catch (e) {
    log.warn(`[games] games dir ${gamesDir} unavailable (${e.code || e.message}) — no games loaded`);
    return done();
  }

  const entries = fs.readdirSync(root, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1));
  for (const ent of entries) {
    const name = ent.name;
    if (name.startsWith('.')) continue;
    const skip = (why) => log.warn(`[games] skipped ${JSON.stringify(name).slice(0, 40)}: ${why}`);
    if (!ID_RE.test(name)) { skip('folder name must match ^[a-z0-9-]{2,32}$'); continue; }
    try {
      const dir = fs.realpathSync(path.join(root, name));
      if (!isInside(dir, root) || !fs.statSync(dir).isDirectory()) { skip('not a directory inside the games dir'); continue; }
      const files = {};
      for (const f of ['manifest.json', 'rules.js']) {
        const real = fs.realpathSync(path.join(dir, f));
        if (!isInside(real, dir)) throw new Error(`${f} resolves outside the game folder`);
        files[f] = real;
      }
      let raw;
      try { raw = JSON.parse(readCapped(files['manifest.json'], MANIFEST_MAX, 'manifest.json')); } catch (e) {
        throw new Error(e instanceof SyntaxError ? 'manifest.json is not valid JSON' : e.message);
      }
      const { manifest, moveRe } = validateManifest(raw, name);
      const rules = evaluateRules(readCapped(files['rules.js'], RULES_MAX, 'rules.js'), files['rules.js']);
      smokeTest(rules, manifest, moveRe);
      const summary = Object.freeze({
        id: manifest.id,
        title: manifest.title,
        kind: manifest.kind,
        version: manifest.version,
        modes: manifest.modes,
        bot_levels: manifest.bot_levels || [],
        move_pattern: manifest.move_pattern,
        move_seconds_options: manifest.move_seconds_options,
        default_move_seconds: manifest.default_move_seconds,
        max_plies: manifest.max_plies,
      });
      games.set(manifest.id, Object.freeze({ id: manifest.id, manifest, moveRe, rules, summary }));
      log.info(`[games] loaded ${manifest.id} ${manifest.version} (${manifest.kind}; ${manifest.modes.join('+')})`);
    } catch (e) {
      skip(e instanceof ManifestError ? `manifest ${e.message}` : (e && e.code === 'ENOENT' ? 'manifest.json or rules.js is missing' : String(e && e.message ? e.message : e)));
    }
  }
  if (games.size === 0) log.warn(`[games] no game loaded from ${root}`);
  return done();
}

module.exports = { loadGames, validateManifest, evaluateRules, ManifestError, ID_RE };
