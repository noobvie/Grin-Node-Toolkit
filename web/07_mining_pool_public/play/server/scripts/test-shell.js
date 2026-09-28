'use strict';

// Part 6 (design §19.7, D4, D13): the /play/ shell and the chess frame — the rules a
// browser probe checked once, kept here so a later edit cannot quietly undo them.
//
//   [1] static: no inline script / on* handler (the shell's CSP has no 'unsafe-inline'),
//       no HTML sinks, the exact sandbox value, classic scripts only, every asset stamped
//   [2] FrameHost in a vm with a fake DOM: the inbound message filter and what it posts
//   [3] PlayApi in a vm with a fake fetch: which answers count as "offline"
//   [4] the nginx snippet still carries the frame's sandbox + connect-src 'none'
//
// Pure file reads + vm contexts: no server, no browser, nothing left running.
// Run: node scripts/test-shell.js

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

let pass = 0, fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else      { fail++; console.error(`  FAIL  ${name}${extra ? ' — ' + extra : ''}`); }
}

const PLAY = path.join(__dirname, '..', '..');
const SHELL = path.join(PLAY, 'shell');
const FRAME = path.join(PLAY, 'games', 'chess', 'frame');
const REPO = path.join(PLAY, '..', '..', '..');
const read = (p) => fs.readFileSync(p, 'utf8');
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\'"])\/\/.*$/gm, '$1');
const stripHtmlComments = (s) => s.replace(/<!--[\s\S]*?-->/g, '');

async function main() {
  console.log('\n[1] static rules');
  const pages = { 'shell/index.html': path.join(SHELL, 'index.html'), 'chess frame/index.html': path.join(FRAME, 'index.html') };
  for (const [name, file] of Object.entries(pages)) {
    const html = stripHtmlComments(read(file));
    const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
    ok(`${name}: every <script> is a file (no inline script)`, scripts.length > 0 && scripts.every((m) => /\bsrc=/.test(m[1]) && m[2].trim() === ''),
      scripts.filter((m) => !/\bsrc=/.test(m[1]) || m[2].trim()).map((m) => m[0].slice(0, 60)).join(' | '));
    ok(`${name}: no on* handler attribute`, !/<[^>]+\son[a-z]+\s*=/i.test(html));
    ok(`${name}: no module script (an opaque-origin frame would need CORS)`, !/type\s*=\s*["']module/i.test(html));
    ok(`${name}: no javascript: URL`, !/javascript:/i.test(html));
    // Own assets (not the pool's /css + /js, which the pool serves unversioned) carry the stamp.
    const own = [...html.matchAll(/\b(?:src|href)="([^"]+)"/g)].map((m) => m[1])
      .filter((u) => !/^(https?:|data:|#|\/#|\/images\/|\/css\/|\/js\/)/.test(u) && /\.(js|css)(\?|$)/.test(u));
    ok(`${name}: every own script/style URL carries ?v=__GRIN_PLAY_VERSION__`, own.length > 0 && own.every((u) => u.endsWith('?v=__GRIN_PLAY_VERSION__')), own.join(', '));
  }
  const shellHtml = read(pages['shell/index.html']);
  ok('shell: <html data-untrusted-html="exempt"> (no analytics / operator HTML / ads — a rig password is typed here)',
    /<html\b[^>]*\bdata-untrusted-html="exempt"/.test(shellHtml));
  ok('shell: loads /play/version.js (§19.15 Part 3 #6)', /<script src="\/play\/version\.js\?v=__GRIN_PLAY_VERSION__"><\/script>/.test(shellHtml));
  ok('shell: pool chrome loads before the shell scripts, in the pool order',
    /public-shell\.js[\s\S]*public-theme\.js[\s\S]*branding\.js[\s\S]*play-api\.js[\s\S]*frame-host\.js[\s\S]*play-shell\.js/.test(shellHtml));
  ok('shell: login inputs carry no name= (a fallback submit sends nothing)',
    !/<input[^>]*id="login-(address|proof)"[^>]*\bname=/.test(shellHtml));
  ok('shell: the proof box is type=password', /<input[^>]*type="password"[^>]*id="login-proof"/.test(shellHtml));

  const jsFiles = [
    ...fs.readdirSync(path.join(SHELL, 'js')).map((n) => path.join(SHELL, 'js', n)),
    path.join(FRAME, 'game.js'),
  ];
  for (const f of jsFiles) {
    const src = stripComments(read(f));
    const rel = path.relative(PLAY, f).replace(/\\/g, '/');
    ok(`${rel}: no HTML sink (innerHTML / outerHTML / insertAdjacentHTML / document.write)`,
      !/\b(innerHTML|outerHTML|insertAdjacentHTML)\b|document\.write/.test(src));
    ok(`${rel}: no eval / Function / string timers`, !/\beval\s*\(|new Function\s*\(|set(Timeout|Interval)\(\s*['"`]/.test(src));
    ok(`${rel}: never grants allow-same-origin`, !/['"`][^'"`]*allow-same-origin/.test(src));
  }
  const host = read(path.join(SHELL, 'js', 'frame-host.js'));
  ok("frame-host: sandbox is exactly 'allow-scripts'", /setAttribute\('sandbox', 'allow-scripts'\)/.test(host) &&
    (host.match(/setAttribute\('sandbox'/g) || []).length === 1);
  ok('frame-host: inbound messages gated on event.source === the frame window', /e\.source !== frame\.contentWindow/.test(host));
  ok('frame-host: origins are never compared', !/\.origin\s*[!=]==/.test(stripComments(host)));
  const game = read(path.join(FRAME, 'game.js'));
  ok('frame: inbound messages accepted only from window.parent', /e\.source !== window\.parent/.test(game));
  ok('frame: posts only ready + move', JSON.stringify([...stripComments(game).matchAll(/postMessage\(\{ type: '([a-z]+)'/g)].map((m) => m[1]).sort()) === '["move","ready"]');

  // Part 7: the Leaderboards & events panel.
  const boards = stripComments(read(path.join(SHELL, 'js', 'play-boards.js')));
  const shellJs = stripComments(read(path.join(SHELL, 'js', 'play-shell.js')));
  const shellBody = stripHtmlComments(shellHtml);
  ok('boards: the panel exists, starts hidden, and is a real tablist (two tabs, two panels)',
    /<section class="panel" id="play-boards" hidden>/.test(shellBody) && /role="tablist"/.test(shellBody)
    && (shellBody.match(/role="tab"/g) || []).length === 2 && (shellBody.match(/role="tabpanel"/g) || []).length === 2);
  ok('boards: play-boards.js loads after play-shell.js, stamped', /play-shell\.js\?v=__GRIN_PLAY_VERSION__"><\/script>\s*<script src="\/play\/js\/play-boards\.js\?v=__GRIN_PLAY_VERSION__"><\/script>/.test(shellHtml));
  ok('boards: play-shell announces every view change (attribute + play:view event)',
    /setAttribute\('data-play-view', v\)/.test(shellJs) && /new CustomEvent\('play:view', \{ detail: \{ view: v \} \}\)/.test(shellJs));
  ok('boards: shown only in the login and signed-in views (never over the offline panel)',
    /var open = view === 'login' \|\| view === 'in';/.test(boards));
  ok('boards: nothing polls (no setInterval) — boards are fetched on open / change / Refresh', !/setInterval\(/.test(boards));
  ok('boards: the only API paths are games, leaderboard?… and events[/<int>]',
    [...boards.matchAll(/Api\.get\(([^)]*)\)/g)].map((m) => m[1].trim()).every((a) => /^(path|'games'|'events'|'events\/' \+ int\(id)$/.test(a)),
    [...boards.matchAll(/Api\.get\(([^)]*)\)/g)].map((m) => m[1]).join(' | '));
  ok('boards: badges on the account strip are written with textContent from server labels',
    /text\(EL\['acct-badges'\], badges\.length \? 'Badges: '/.test(shellJs));

  // Part 9: the Chat panel (§19.10, D21).
  const chatJs = stripComments(read(path.join(SHELL, 'js', 'play-chat.js')));
  ok('chat: the panel exists and starts hidden, with the anti-scam line (§19.10)',
    /<section class="panel" id="play-chat" hidden>/.test(shellBody) && /will never ask you for funds, keys or seeds in chat/.test(shellBody));
  ok('chat: play-chat.js loads after play-boards.js, stamped',
    /play-boards\.js\?v=__GRIN_PLAY_VERSION__"><\/script>\s*<script src="\/play\/js\/play-chat\.js\?v=__GRIN_PLAY_VERSION__"><\/script>/.test(shellHtml));
  ok('chat: play-shell announces /me (play:me) on every render and null on sign-out',
    /new CustomEvent\('play:me', \{ detail: \{ me: me \} \}\)/.test(shellJs) && /S\.me = me;\s*announceMe\(me\);/.test(shellJs) && /S\.me = null;\s*announceMe\(null\);/.test(shellJs));
  ok('chat: the body is written with textContent (text(body, m.body)), never as markup',
    /text\(body, m\.body\);/.test(chatJs) && !/createElement\('a'\)/.test(chatJs) && !/\.href\s*=/.test(chatJs));
  ok('chat: badges come from the server role only (Operator / Mod), never from the body or name',
    /m\.role === 'operator' \? 'Operator' : 'Mod'/.test(chatJs) && !/m\.body[^;]*badge/.test(chatJs));
  ok('chat: shown only in the login and signed-in views', /var open = view === 'login' \|\| view === 'in';/.test(chatJs));
  ok('chat: polls with setTimeout, one request at a time, and backs off while hidden',
    !/setInterval\(/.test(chatJs) && /if \(!S\.open \|\| S\.inflight\) return;/.test(chatJs) && /visibilityState === 'hidden'\) return POLL_HIDDEN/.test(chatJs));
  const chatPaths = [...chatJs.matchAll(/Api\.(get|post)\(([^,)]*)/g)].map((m) => m[2].trim());
  ok('chat: the only API paths are chat…, rules and mod/…',
    chatPaths.every((a) => /^(path|'chat'|'rules'|'mod\/queue'|'chat\/' \+ m\.id \+ '\/report'|'mod\/messages\/' \+ id \+ '\/' \+ action)$/.test(a)), chatPaths.join(' | '));
  ok('chat: no native dialog (confirm / alert / prompt) — two-click confirms only', !/\b(confirm|alert|prompt)\s*\(/.test(chatJs));

  // Part 12: the Nickname fold (play-names.js, design §19.16).
  const namesJs = stripComments(read(path.join(SHELL, 'js', 'play-names.js')));
  ok('names: the fold sits in the account strip, hidden until /me fills it',
    /<details class="play-fold play-nick" id="nick-fold" hidden>/.test(shellBody)
    && shellBody.indexOf('id="play-account"') < shellBody.indexOf('id="nick-fold"') && shellBody.indexOf('id="nick-fold"') < shellBody.indexOf('id="play-game-area"'));
  ok('names: play-names.js loads after play-lobby.js, stamped',
    /play-lobby\.js\?v=__GRIN_PLAY_VERSION__"><\/script>\s*<script src="\/play\/js\/play-names\.js\?v=__GRIN_PLAY_VERSION__"><\/script>/.test(shellHtml));
  const namesPaths = [...namesJs.matchAll(/Api\.(get|post)\(([^,)]*)/g)].map((m) => m[2].trim());
  ok('names: the only API paths are nickname, nickname/withdraw and nickname/remove (the name goes in the body)',
    namesPaths.length === 3 && namesPaths.every((a) => /^'nickname(\/withdraw|\/remove)?'$/.test(a)), namesPaths.join(' | '));
  ok('names: the public name shown is the SERVER\'s shown_as — the page never composes one',
    /text\(EL\['nick-shown'\], n\.shown_as\)/.test(namesJs) && !/\+ ' \(' \+/.test(namesJs));
  ok('names: follows play:me only, no timer, no native dialog',
    /addEventListener\('play:me'/.test(namesJs) && !/setInterval\(/.test(namesJs) && !/\b(confirm|alert|prompt)\s*\(/.test(namesJs));
  ok('names: the input carries no name= and is capped at the rule\'s 20', /<input class="input" type="text" id="nick-input" maxlength="20"/.test(shellBody)
    && !/<input[^>]*id="nick-input"[^>]*\bname=/.test(shellBody));

  // Part 10: "Play a person" (play-lobby.js) + the PvP board in play-shell.js.
  const lobbyJs = stripComments(read(path.join(SHELL, 'js', 'play-lobby.js')));
  ok('lobby: the G-08 panel sits in the signed-in game area, with the post form and both lists',
    /<section class="panel" id="lobby-panel">/.test(shellBody) && /id="pvp-form"/.test(shellBody)
    && /id="lobby-challenges"/.test(shellBody) && /id="lobby-seeks"/.test(shellBody)
    && shellBody.indexOf('id="play-game-area"') < shellBody.indexOf('id="lobby-panel"'));
  ok('lobby: play-lobby.js loads after play-chat.js, stamped',
    /play-chat\.js\?v=__GRIN_PLAY_VERSION__"><\/script>\s*<script src="\/play\/js\/play-lobby\.js\?v=__GRIN_PLAY_VERSION__"><\/script>/.test(shellHtml));
  const lobbyPaths = [...lobbyJs.matchAll(/Api\.(get|post)\(([^,)]*)/g)].map((m) => m[2].trim());
  // (the extractor stops at the first ')' — 'matches/' + int(id … is the action call)
  ok('lobby: the only API paths are lobby, games, rules, matches and matches/<int>/…',
    lobbyPaths.length > 0 && lobbyPaths.every((a) => /^('lobby'|'games'|'rules'|'matches'|'matches\/' \+ int\(id)$/.test(a))
    && /Api\.post\('matches\/' \+ int\(id\) \+ '\/' \+ what, \{\}\)/.test(lobbyJs), lobbyPaths.join(' | '));
  ok('lobby: the typed opponent address goes in the JSON body, never in a URL',
    /body\.target = target;/.test(lobbyJs) && !/Api\.(get|post)\([^)]*target/.test(lobbyJs));
  ok('lobby: nothing polls (no setInterval) and no native dialog',
    !/setInterval\(/.test(lobbyJs) && !/\b(confirm|alert|prompt)\s*\(/.test(lobbyJs));
  ok('lobby: talks to the shell only through play:open / play:changed / play:me / play:turns',
    /'play:open'/.test(lobbyJs) && /'play:changed'/.test(lobbyJs) && /'play:me'/.test(lobbyJs) && /'play:turns'/.test(lobbyJs)
    && /addEventListener\('play:open'/.test(shellJs) && /addEventListener\('play:changed'/.test(shellJs) && /'play:turns'/.test(shellJs));
  ok('pvp board: every server action has a button, shown from the view\'s actions list',
    ['accept', 'decline', 'cancel', 'draw_accept', 'draw_decline', 'draw_offer', 'abort', 'resign'].every((a) => new RegExp(`\\b${a}: 'btn-`).test(shellJs))
    && ['btn-accept', 'btn-decline', 'btn-cancel', 'btn-draw-accept', 'btn-draw-decline', 'btn-draw-offer', 'btn-abort', 'btn-resign']
      .every((id) => new RegExp(`id="${id}" hidden`).test(shellBody))
    && /showActions\(v\.actions\)/.test(shellJs));
  ok('pvp board: both polls are setTimeout chains (board 5 s; turns 15 s visible / 60 s hidden)',
    /setTimeout\(pollBoard, BOARD_POLL_MS\)/.test(shellJs) && /setTimeout\(pollTurns, document\.visibilityState === 'visible' \? TURNS_VISIBLE_MS : TURNS_HIDDEN_MS\)/.test(shellJs)
    && /BOARD_POLL_MS = 5000/.test(shellJs) && /TURNS_VISIBLE_MS = 15000/.test(shellJs) && /TURNS_HIDDEN_MS = 60000/.test(shellJs));
  ok('pvp board: the board poll asks with since_ply and never runs in a hidden tab',
    /'\?since_ply=' \+ int\(v\.ply\)/.test(shellJs) && /document\.visibilityState !== 'visible'\) return;/.test(shellJs));
  ok('boards: the picker offers the rating + PvP boards for a game with a pvp mode',
    /'rating\|' \+ g\.id \+ '\|pvp'/.test(boards) && /'wins\|' \+ g\.id \+ '\|pvp'/.test(boards) && /'points\|' \+ g\.id \+ '\|pvp'/.test(boards));

  console.log('\n[2] FrameHost (vm, fake DOM)');
  {
    const posted = [];
    const listeners = {};
    const contentWindow = { postMessage: (msg, target) => posted.push({ msg: JSON.parse(JSON.stringify(msg)), target }) };
    const frame = {
      attrs: {}, src: '', className: '', parentNode: null, contentWindow,
      setAttribute(k, v) { this.attrs[k] = v; },
      addEventListener() {},
    };
    const container = { appendChild(el) { el.parentNode = this; }, removeChild(el) { el.parentNode = null; } };
    const win = {
      GRIN_PLAY_VERSION: '0123456789ab',
      addEventListener: (t, fn) => { (listeners[t] = listeners[t] || []).push(fn); },
      removeEventListener: (t, fn) => { listeners[t] = (listeners[t] || []).filter((f) => f !== fn); },
    };
    // The context keeps its OWN builtins (Object, RegExp, …): passing ours in would make the
    // plain-object test compare against the wrong realm's Object.prototype.
    const ctx = { window: win, document: { createElement: () => frame } };
    vm.createContext(ctx);
    vm.runInContext(read(path.join(SHELL, 'js', 'frame-host.js')), ctx);
    const FH = win.FrameHost;
    const moves = [];
    let readies = 0;
    const game = { id: 'chess', title: 'Chess', move_pattern: '^[a-h][1-8][a-h][1-8][qrbn]?$' };
    const h = FH.create({ container, game, onMove: (m) => moves.push(m), onReady: () => { readies++; } });
    ok('iframe gets sandbox="allow-scripts" and nothing more permissive', frame.attrs.sandbox === 'allow-scripts');
    ok('iframe src is the game frame with the version stamp', frame.src === '/play/games/chess/frame/?v=0123456789ab', frame.src);
    ok('iframe has an empty permissions policy', frame.attrs.allow === '');
    let threw = false;
    try { FH.create({ container, game: { id: '../x', move_pattern: '.' } }); } catch (_) { threw = true; }
    ok('a game id outside ^[a-z0-9-]{2,32}$ never becomes a URL', threw);

    const fire = (data, source = contentWindow) => (listeners.message || []).forEach((fn) => fn({ source, data, origin: 'null' }));
    // A plain object built in THIS realm, as structured clone would deliver it.
    const O = (o) => vm.runInContext(`(${JSON.stringify(o)})`, ctx);

    h.sendState({ position: 'P', last_move: null, you: 1, to_move: 1, legal: ['e2e4'], status: { over: false }, labels: { 1: 'a', 2: 'b' } });
    ok('state before `ready` is held, not posted', posted.length === 0);
    fire(O({ type: 'move', move: 'e2e4' }));
    ok('a move before `ready` is ignored', moves.length === 0);
    fire(O({ type: 'ready', protocol: 2 }));
    ok('ready with the wrong protocol is dropped', readies === 0);
    fire(O({ type: 'ready', protocol: 1 }), {});
    ok('ready from another window is dropped', readies === 0);
    fire(O({ type: 'ready', protocol: 1 }));
    ok('ready from the frame → onReady + the held state is posted', readies === 1 && posted.length === 1 && posted[0].msg.type === 'state');
    ok("posts go to the frame window with target '*' (opaque origin)", posted[0].target === '*');
    ok('the state carries exactly §19.7 fields',
      JSON.stringify(Object.keys(posted[0].msg).sort()) === JSON.stringify(['labels', 'last_move', 'legal', 'position', 'status', 'to_move', 'type', 'you']),
      Object.keys(posted[0].msg).join(','));

    fire(O({ type: 'move', move: 'e2e4' }));
    ok('a well-formed move from the frame reaches onMove', moves.length === 1 && moves[0] === 'e2e4');
    const bad = [
      { type: 'move', move: 'e2e4', extra: 1 },
      { type: 'move', move: 'e2e9' },
      { type: 'move', move: 'e2e4qq' },
      { type: 'move', move: 12 },
      { type: 'move' },
      { type: 'resign' },
      { type: 'state', position: 'x' },
    ];
    for (const b of bad) fire(O(b));
    fire('move e2e4');
    fire(null);
    fire(O({ type: 'move', move: 'd2d4' }), win);
    ok('extra keys, bad patterns, wrong types, unknown types, strings and other sources are all dropped', moves.length === 1, moves.join(','));
    // An object whose prototype is not this realm's Object.prototype is not "plain".
    fire({ type: 'move', move: 'd2d4' });
    ok('a non-plain (foreign-prototype) object is dropped', moves.length === 1);

    h.sendState({ position: 'P2', last_move: 'e2e4', you: 1, to_move: 2, legal: null, status: { over: true, result: 'seat1', reason: 'checkmate' },
      labels: { 1: 'a', 2: 'b' }, token: 'SECRET', address: 'grin1full', seed: 'abc' });
    const last = posted[posted.length - 1].msg;
    ok('no field outside §19.7 can ride along in a state (token/address/seed dropped)', !('token' in last) && !('address' in last) && !('seed' in last));
    ok('legal is omitted when not the viewer\'s turn', !('legal' in last));
    h.sendTheme('solarized');
    ok('theme is dark|light only', posted[posted.length - 1].msg.mode === 'dark');
    h.destroy();
    fire(O({ type: 'move', move: 'e2e4' }));
    ok('after destroy the listener is gone', moves.length === 1);
  }

  console.log('\n[3] PlayApi (vm, fake fetch)');
  {
    let next = null;
    const calls = [];
    const mkRes = (status, ct, body) => ({
      status, ok: status >= 200 && status < 300,
      headers: { get: (k) => (k.toLowerCase() === 'content-type' ? ct : null) },
      json: () => (typeof body === 'string' ? Promise.reject(new Error('parse')) : Promise.resolve(body)),
    });
    const win = {};
    const ctx = {
      window: win, setTimeout, clearTimeout, AbortController,
      fetch: (url, opts) => { calls.push({ url, opts }); return typeof next === 'function' ? next() : Promise.resolve(next); },
    };
    vm.createContext(ctx);
    vm.runInContext(read(path.join(SHELL, 'js', 'play-api.js')), ctx);
    const Api = win.PlayApi;
    const outcome = (p) => p.then((b) => ({ ok: true, b }), (e) => ({ ok: false, kind: e.kind, code: e.code, status: e.status }));

    next = mkRes(200, 'application/json; charset=utf-8', { ok: true, plays: 3 });
    let r = await outcome(Api.get('me'));
    ok('JSON { ok:true } → resolves with the body', r.ok && r.b.plays === 3);
    ok('same-origin credentials, no-store, no redirects', calls[0].opts.credentials === 'same-origin' && calls[0].opts.cache === 'no-store' && calls[0].opts.redirect === 'error');
    next = mkRes(502, 'text/html', '<html>502</html>');
    r = await outcome(Api.get('me'));
    ok('a 502 HTML page → offline', !r.ok && r.kind === 'offline');
    next = mkRes(200, 'text/html', '<html>parked</html>');
    r = await outcome(Api.get('me'));
    ok('a 200 HTML page → offline (a 200 is not data)', !r.ok && r.kind === 'offline');
    next = mkRes(200, 'text/plain', { ok: true, plays: 3 });
    r = await outcome(Api.get('me'));
    ok('a body that parses but is not served as JSON → offline (the content type is the rule)', !r.ok && r.kind === 'offline');
    next = mkRes(200, 'application/json', [1, 2]);
    r = await outcome(Api.get('me'));
    ok('JSON without an `ok` field → offline', !r.ok && r.kind === 'offline');
    next = mkRes(200, 'application/json', 'not json');
    r = await outcome(Api.get('me'));
    ok('JSON content type that does not parse → offline', !r.ok && r.kind === 'offline');
    next = () => Promise.reject(new TypeError('network'));
    r = await outcome(Api.get('me'));
    ok('a network error → offline', !r.ok && r.kind === 'offline');
    next = mkRes(503, 'application/json', { ok: false, error: 'shutting_down', message: 'x' });
    r = await outcome(Api.get('me'));
    ok('503 shutting_down → offline (a restart is an outage, not a refusal)', !r.ok && r.kind === 'offline');
    next = mkRes(401, 'application/json', { ok: false, error: 'unauthorised', message: 'Not authorised.' });
    r = await outcome(Api.get('me'));
    ok('401 JSON → http error with its code', !r.ok && r.kind === 'http' && r.status === 401 && r.code === 'unauthorised');
    next = mkRes(200, 'application/json', { ok: true });
    calls.length = 0;
    r = await outcome(Api.post('matches/5/move', { ply: 0, move: 'e2e4' }));
    ok('POST sends application/json + the body as JSON', calls[0].opts.method === 'POST' && calls[0].opts.headers['Content-Type'] === 'application/json' && calls[0].opts.body === '{"ply":0,"move":"e2e4"}');
    ok('POST goes under /play/api/', calls[0].url === '/play/api/matches/5/move');
    calls.length = 0;
    r = await outcome(Api.get('../../api/admin/x'));
    ok('a path with dots never reaches fetch', !r.ok && calls.length === 0);
  }

  console.log('\n[4] nginx snippet vs the frame');
  {
    const lib = read(path.join(REPO, 'scripts', 'lib', '07_lib_pool_games.sh'));
    const games = (lib.match(/location \^~ \/play\/games\/ \{[\s\S]*?\n\}/) || [''])[0];
    ok('frame CSP: connect-src \'none\'', /connect-src 'none'/.test(games));
    ok('frame CSP: sandbox allow-scripts (and nothing more)', /sandbox allow-scripts" always;/.test(games) && !/allow-same-origin/.test(games));
    ok('frame CSP: frame-ancestors \'self\'', /frame-ancestors 'self'/.test(games));
    const shell = (lib.match(/location \^~ \/play\/ \{[\s\S]*?\n\}/) || [''])[0];
    const csp = (shell.match(/Content-Security-Policy "([^"]+)"/) || [])[1] || '';
    const scriptSrc = (csp.match(/script-src ([^;]+);/) || [])[1] || '';
    ok("shell CSP: script-src 'self' only", scriptSrc.trim() === "'self'", scriptSrc);
    ok('deploy stamps __GRIN_PLAY_VERSION__ into staged HTML', /sed -i "s\/__GRIN_PLAY_VERSION__\/\$ver\/g"/.test(lib));
  }
}

main().catch((e) => { fail++; console.error(`  FAIL  unexpected error: ${e && e.stack}`); })
  .finally(() => {
    console.log(`\nRESULT pass=${pass} fail=${fail}`);
    process.exitCode = fail ? 1 : 0;
  });
