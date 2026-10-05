'use strict';

// Part 6 (design §19.7, D4, D13): the /play/ shell and the chess frame — the rules a
// browser probe checked once, kept here so a later edit cannot quietly undo them.
//
//   [1] static: no inline script / on* handler (the shell's CSP has no 'unsafe-inline'),
//       no HTML sinks, the exact sandbox value, classic scripts only, every asset stamped
//   [2] FrameHost in a vm with a fake DOM: the inbound message filter and what it posts
//   [3] PlayApi in a vm with a fake fetch: which answers count as "offline"
//   [4] the nginx snippet still carries the frame's sandbox + connect-src 'none'
//   [6] (C7) the floating chat bubble: static rules (shared core, fixed URLs, storage in
//       try/catch, no mod paths, wiped passwords, Esc/aria) + the polling budget MEASURED in a
//       vm with a fake clock: closed + signed out = 0 requests, closed + signed in = 60 s,
//       hidden = paused, open = the panel's cadence; the unread dot; a body stays text
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
  const boardsSection = (shellBody.match(/<section class="panel" id="play-boards"[\s\S]*?<\/section>/) || [''])[0];
  ok('boards: the panel exists, starts hidden, and is a real tablist (two tabs, two panels)',
    /<section class="panel" id="play-boards" hidden>/.test(shellBody) && /role="tablist"/.test(boardsSection)
    && (boardsSection.match(/role="tab"/g) || []).length === 2 && (boardsSection.match(/role="tabpanel"/g) || []).length === 2);
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
  // C7: the list, the change feed, the rows and the refusal sentences moved into the shared
  // chat core (the bubble draws the same rows) — the panel checks below read both files.
  const coreJs = stripComments(read(path.join(SHELL, 'js', 'play-chat-core.js')));
  const chatAll = chatJs + ' ' + coreJs;
  ok('chat: the panel exists and starts hidden, with the anti-scam line (§19.10)',
    /<section class="panel" id="play-chat" hidden>/.test(shellBody) && /will never ask you for funds, keys or seeds in chat/.test(shellBody));
  ok('chat: play-chat-core.js then play-chat.js load after play-boards.js, stamped',
    /play-boards\.js\?v=__GRIN_PLAY_VERSION__"><\/script>\s*<script src="\/play\/js\/play-chat-core\.js\?v=__GRIN_PLAY_VERSION__"><\/script>\s*<script src="\/play\/js\/play-chat\.js\?v=__GRIN_PLAY_VERSION__"><\/script>/.test(shellHtml));
  ok('chat: play-shell announces /me (play:me) on every render and null on sign-out',
    /new CustomEvent\('play:me', \{ detail: \{ me: me \} \}\)/.test(shellJs) && /S\.me = me;\s*announceMe\(me\);/.test(shellJs) && /S\.me = null;\s*hint\(HINT_SIGNED, false\);\s*announceMe\(null\);/.test(shellJs));
  ok('chat: the body is written with textContent (text(body, m.body)), never as markup',
    /text\(body, m\.body\);/.test(coreJs) && /text\(body, m\.body\);/.test(chatJs) && !/createElement\('a'\)/.test(chatAll) && !/\.href\s*=/.test(chatAll));
  ok('chat: badges come from the server role only (Operator / Mod), never from the body or name',
    /m\.role === 'operator' \? 'Operator' : 'Mod'/.test(coreJs) && !/m\.body[^;]*badge/.test(chatAll));
  ok('chat: shown only in the login and signed-in views', /var open = view === 'login' \|\| view === 'in';/.test(chatJs));
  ok('chat: polls with setTimeout, one request at a time, and backs off while hidden',
    !/setInterval\(/.test(chatJs) && /if \(!S\.open \|\| S\.inflight\) return;/.test(chatJs) && /visibilityState === 'hidden'\) return POLL_HIDDEN/.test(chatJs));
  const chatPaths = [...chatJs.matchAll(/Api\.(get|post)\(([^,)]*)/g)].map((m) => m[2].trim());
  ok('chat: the only API paths are chat…, rules and mod/…',
    chatPaths.length > 0 && !/Api\.(get|post)\(/.test(coreJs) && chatPaths.every((a) => /^(feed\.path\(|'chat'|'rules'|'mod\/queue'|'chat\/' \+ m\.id \+ '\/report'|'mod\/messages\/' \+ id \+ '\/' \+ action)$/.test(a)), chatPaths.join(' | '));
  ok('chat: no native dialog (confirm / alert / prompt) — two-click confirms only', !/\b(confirm|alert|prompt)\s*\(/.test(chatJs));

  // Part 12 → C3: the Nickname fold (play-names.js, design §19.17.5).
  const namesJs = stripComments(read(path.join(SHELL, 'js', 'play-names.js')));
  ok('names: the fold sits in the account strip, hidden until /me fills it',
    /<details class="play-fold play-nick" id="nick-fold" hidden>/.test(shellBody)
    && shellBody.indexOf('id="play-account"') < shellBody.indexOf('id="nick-fold"') && shellBody.indexOf('id="nick-fold"') < shellBody.indexOf('id="play-game-area"'));
  ok('names: play-names.js loads after play-lobby.js, stamped',
    /play-lobby\.js\?v=__GRIN_PLAY_VERSION__"><\/script>\s*<script src="\/play\/js\/play-names\.js\?v=__GRIN_PLAY_VERSION__"><\/script>/.test(shellHtml));
  const namesPaths = [...namesJs.matchAll(/Api\.(get|post)\(([^,)]*)/g)].map((m) => m[2].trim());
  ok('names: the only API paths are nickname and nickname/remove (the name goes in the body; no review queue to withdraw from)',
    namesPaths.length === 2 && namesPaths.every((a) => /^'nickname(\/remove)?'$/.test(a)), namesPaths.join(' | '));
  ok('names: a list refusal is shown as the server\'s generic answer — the page names no word and no list',
    /name_not_allowed: 'That nickname isn\\'t allowed\. Try another\.'/.test(namesJs) && /name_unavailable: 'That nickname isn\\'t available\. Try another\.'/.test(namesJs)
    && !/nick-pending|nick-withdraw/.test(namesJs + shellBody));
  ok('chat: a moderator\'s "Remove name" goes through the same mod/messages/<id>/<action> call, only on a label that carries a nickname',
    /modAct\(m\.id, 'remove-name', \{\}\)/.test(chatJs) && /function hasNick\(m\) \{ return typeof m\.name === 'string' && \/ \\\(t\?grin1\[\^\)\]\*\\\)\$\/\.test\(m\.name\); \}/.test(chatJs));
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

  // C6: guest accounts on /play/ (design §19.17.3/§19.17.4).
  const guestJs = stripComments(read(path.join(SHELL, 'js', 'play-guest.js')));
  const loginSection = (shellBody.match(/<section class="panel" id="play-login"[\s\S]*?<\/section>/) || [''])[0];
  ok('guest: the sign-in card has two tabs (Miner, Guest) and two panels, Miner selected first',
    (loginSection.match(/role="tab"/g) || []).length === 2 && (loginSection.match(/role="tabpanel"/g) || []).length === 2
    && /id="login-tab-miner" aria-selected="true" aria-controls="login-pane-miner"/.test(loginSection)
    && /id="login-tab-guest" aria-selected="false" aria-controls="login-pane-guest" tabindex="-1"/.test(loginSection)
    && /<div id="login-pane-guest" role="tabpanel" aria-labelledby="login-tab-guest" hidden>/.test(loginSection));
  ok('guest: the guest sign-in form, the sign-up form (hidden until asked for) and "Create a guest account" live in the Guest tab',
    /id="guest-login-form"/.test(loginSection) && /<form id="signup-form"[^>]*\bhidden>/.test(loginSection) && /id="guest-to-signup"/.test(loginSection)
    && loginSection.indexOf('id="login-pane-guest"') < loginSection.indexOf('id="signup-form"') && /id="miner-to-signup"/.test(loginSection));
  const credInputs = [...shellBody.matchAll(/<input\b[^>]*>/g)].map((m) => m[0]);
  const PW_IDS = ['login-proof', 'guest-password', 'signup-password', 'signup-password2', 'pw-current', 'pw-next', 'pw-next2', 'del-password'];
  ok('guest: no input on the page carries a name= (a fallback submit sends nothing — no proof, no password)',
    credInputs.length > 10 && credInputs.every((t) => !/\bname=/.test(t)), credInputs.filter((t) => /\bname=/.test(t)).join(' | '));
  ok('guest: every password box is type=password',
    PW_IDS.every((id) => credInputs.some((t) => new RegExp(`id="${id}"`).test(t) && /type="password"/.test(t))));
  ok('guest: password managers can save the guest password (username / current-password / new-password)',
    /id="guest-name"[^>]*autocomplete="username"/.test(shellBody) && /id="guest-password"[^>]*autocomplete="current-password"/.test(shellBody)
    && /id="signup-password"[^>]*autocomplete="new-password"/.test(shellBody) && /id="pw-next"[^>]*autocomplete="new-password"/.test(shellBody));
  ok('guest: the sign-up form says there is no email and no reset', /no email/.test(loginSection) && /cannot be reset/.test(loginSection));
  ok('guest: the account box sits in the account strip, hidden until a guest /me fills it; delete starts disabled',
    /<details class="play-fold play-guest" id="guest-fold" hidden>/.test(shellBody)
    && shellBody.indexOf('id="play-account"') < shellBody.indexOf('id="guest-fold"') && shellBody.indexOf('id="guest-fold"') < shellBody.indexOf('id="play-game-area"')
    && /id="del-submit" disabled>/.test(shellBody));
  ok('guest: play-pow.js then play-guest.js load after play-names.js, stamped',
    /play-names\.js\?v=__GRIN_PLAY_VERSION__"><\/script>\s*<script src="\/play\/js\/play-pow\.js\?v=__GRIN_PLAY_VERSION__"><\/script>\s*<script src="\/play\/js\/play-guest\.js\?v=__GRIN_PLAY_VERSION__"><\/script>/.test(shellHtml));
  const guestPaths = [...guestJs.matchAll(/Api\.(get|post)\(([^,)]*)/g)].map((m) => m[2].trim());
  ok('guest: the only API paths are signup/challenge, signup, login/guest, account/password and account/delete (+ the shared rules)',
    guestPaths.length === 5 && guestPaths.every((a) => /^'(signup\/challenge|signup|login\/guest|account\/password|account\/delete)'$/.test(a))
    && /Api\.rules\(\)/.test(guestJs), guestPaths.join(' | '));
  ok('guest: the delete confirmation sent is exactly the server\'s DELETE_CONFIRM',
    /confirm: '([A-Z]+)'/.test(guestJs) && guestJs.match(/confirm: '([A-Z]+)'/)[1] === require('../lib/guests.js').DELETE_CONFIRM);
  ok('guest: every password box is wiped after use', ['guest-password', 'signup-password', 'signup-password2', 'pw-current', 'pw-next', 'pw-next2', 'del-password']
    .every((id) => guestJs.includes(`EL['${id}'].value = ''`) || new RegExp(`'${id}'[^\\]]*\\]\\.forEach\\(function \\(id\\) \\{ EL\\[id\\]\\.value = ''`).test(guestJs)));
  ok('guest: the name SHAPE is checked before any request (a refused name after the PoW costs a new one)',
    /var np = name \? nameProblem\(name\)[\s\S]*?if \(np\)[\s\S]*?return; \}[\s\S]*?Api\.get\('signup\/challenge'\)/.test(guestJs));
  ok('guest: a fresh challenge per attempt, solved by PlayPow, then POST signup with {name, password, challenge, nonce}',
    /Pow\.solve\(c\.challenge, c\.bits,/.test(guestJs) && /Api\.post\('signup', \{ name: name, password: pw, challenge: challenge, nonce: nonce \}\)/.test(guestJs));
  ok('guest: every C5 refusal code has a sentence', ['signup_closed', 'pow_failed', 'too_many_requests', 'busy', 'name_not_allowed', 'name_unavailable', 'password_weak']
    .every((c) => new RegExp(`case '${c}':`).test(guestJs)) && ['expired', 'ip_changed', 'invalid'].every((r) => new RegExp(`\\b${r}: '`).test(guestJs)));
  ok('guest: a list hit says only "isn\'t allowed" / "isn\'t available" — no word, no list',
    /case 'name_not_allowed': return 'That name isn\\'t allowed\. Try another\.';/.test(guestJs) && /case 'name_unavailable': return 'That name isn\\'t available\. Try another\.';/.test(guestJs));
  ok('guest: hands sessions to the shell only through play:signed-in / play:signed-out, and the shell listens',
    /emit\('play:signed-in'/.test(guestJs) && /emit\('play:signed-out'/.test(guestJs)
    && /addEventListener\('play:signed-in'/.test(shellJs) && /addEventListener\('play:signed-out'/.test(shellJs));
  ok('guest: /play/#signup opens the sign-up form (the C7 bubble links there)', /location\.hash === '#signup'/.test(guestJs) && /addEventListener\('hashchange', fromHash\)/.test(guestJs));
  ok('guest: no timer, no native dialog; the tab memory is localStorage inside try/catch',
    !/setInterval\(/.test(guestJs) && !/\b(confirm|alert|prompt)\s*\(/.test(guestJs)
    && [...guestJs.matchAll(/localStorage\.[a-zA-Z]+\(/g)].length === 2 && /try \{ localStorage\.setItem/.test(guestJs) && /try \{ var v = localStorage\.getItem/.test(guestJs));
  ok('guest: the login name is shown to its owner only, from /me (text only)',
    /text\(EL\['guest-login-name'\], g\.login_name\)/.test(guestJs) && /me\.guest\.login_name \+ ' · guest'/.test(shellJs));
  const chatJs6 = chatAll;
  ok('chat: the guest gates have sentences (account age with its time, guests off) and the guest link note shows',
    /case 'account_too_new':/.test(chatJs6) && /case 'guests_off':/.test(chatJs6) && /show\(EL\['chat-guest-note'\], posting && S\.me\.kind === 'guest'\)/.test(chatJs6)
    && /id="chat-guest-note" hidden>/.test(shellBody));
  ok('chat: a wait that runs out asks the shell for a fresh /me (one timer, capped)',
    /dispatchEvent\(new CustomEvent\('play:refresh-me'\)\)/.test(chatJs6) && /addEventListener\('play:refresh-me'/.test(shellJs) && /ms > 6 \* 3600 \* 1000/.test(chatJs6));
  // The visible word is "tickets" (operator, C0) everywhere on /play/ — the internal name stays.
  const visible = shellBody.replace(/<script\b[\s\S]*?<\/script>/g, '').replace(/<[^>]+>/g, ' ');
  const literals = [SHELL].flatMap(() => fs.readdirSync(path.join(SHELL, 'js')).map((n) => stripComments(read(path.join(SHELL, 'js', n)))))
    .flatMap((src) => [...src.matchAll(/'((?:[^'\\\n]|\\.)*)'/g)].map((m) => m[1]).filter((x) => / /.test(x)));
  const PLAYS_WORD = /\bplays\b|\ba play\b|\bplay (refunded|is back)\b|\bplays? left\b/i;
  ok('tickets: no visible "plays" / "a play" left in the page text', !PLAYS_WORD.test(visible), (visible.match(PLAYS_WORD) || [''])[0]);
  ok('tickets: no "plays" in any sentence the shell scripts write', !literals.some((x) => PLAYS_WORD.test(x)), literals.filter((x) => PLAYS_WORD.test(x)).join(' | '));
  const serverMsgs = require('../lib/http.js').MESSAGES;
  ok('tickets: the server\'s no_plays / expired sentences say tickets too', /tickets/.test(serverMsgs.no_plays) && /ticket/.test(serverMsgs.expired) && !PLAYS_WORD.test(serverMsgs.no_plays + ' ' + serverMsgs.expired));
  ok('tickets: the fold is "How tickets are earned" and explains miners AND guests from the live rules',
    /How tickets are earned/.test(shellBody) && ['rule-plays', 'rule-guest', 'rule-guest-idle', 'rule-guest-chat'].every((id) => new RegExp(`<span id="${id}">`).test(shellBody))
    && /text\(EL\['rule-guest'\]/.test(guestJs) && /text\(EL\['rule-guest-chat'\]/.test(guestJs));

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

    // C6: one GET rules per page, shared by the chat panel, the lobby and the guest forms.
    calls.length = 0;
    next = mkRes(502, 'text/html', '<html>502</html>');
    r = await outcome(Api.rules());
    ok('rules(): a failure is not cached', !r.ok && r.kind === 'offline' && calls.length === 1);
    next = mkRes(200, 'application/json', { ok: true, guests: { daily_tickets: 5 } });
    const [r1, r2] = await Promise.all([Api.rules(), Api.rules()]);
    const r3 = await Api.rules();
    ok('rules(): after a failure the next call asks again, and then ONE request serves every caller',
      calls.length === 2 && calls[1].url === '/play/api/rules' && r1 === r2 && r2 === r3 && r3.guests.daily_tickets === 5);
  }

  console.log('\n[5] PlayPow (vm) — checked against Node\'s SHA-256 and the server\'s own verify');
  {
    const crypto = require('node:crypto');
    const G = require('../lib/guests.js');
    const win = {};
    const ctx = { window: win, crypto: globalThis.crypto, setTimeout };
    vm.createContext(ctx);
    vm.runInContext(read(path.join(SHELL, 'js', 'play-pow.js')), ctx);
    const Pow = win.PlayPow;
    let mismatch = 0;
    for (let len = 0; len < 300; len++) {
      const s = Array.from({ length: len }, (_, i) => String.fromCharCode(33 + ((i * 37 + len * 11) % 94))).join('');
      if (Pow.sha256hex(s) !== crypto.createHash('sha256').update(s).digest('hex')) mismatch++;
    }
    ok('the hand-written SHA-256 equals Node\'s on 300 inputs of length 0–299 (every padding layout)', mismatch === 0, `${mismatch} mismatches`);
    ok('the known vector: sha256("abc")', Pow.sha256hex('abc') === 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');

    const pow = G.createPow();
    let good = 0;
    const coarse = ['203.0.113.0/24', '2001:db8:1234::/48', '198.51.100.0/24'];
    for (const c of coarse) {
      for (const bits of [14, 15]) {
        const ch = pow.issue(c, bits);
        const nonce = await Pow.solve(ch.challenge, bits);
        if (/^[0-9A-Za-z]{1,32}$/.test(nonce) && pow.verify(ch.challenge, nonce, c) === null) good++;
      }
    }
    ok('solve() answers that the SERVER accepts (createPow().verify → null), IPv4 + IPv6 challenges, 14–15 bits', good === 6, `${good}/6`);
    // Challenges of every length 40–200 (the prefix's last block moves through all 64 offsets).
    let lenGood = 0;
    for (let len = 40; len <= 200; len += 7) {
      const ch = 'v1.' + 'x'.repeat(len - 3);
      const nonce = await Pow.solve(ch, 8);
      const h = crypto.createHash('sha256').update(`${ch}:${nonce}`).digest();
      if (G.leadingZeroBits(h) >= 8) lenGood++;
    }
    ok('solve() is right for challenge lengths 40–200 (checked with Node\'s hash)', lenGood === 23, `${lenGood}/23`);
    let cancelled = null;
    await Pow.solve('v1.never', 32, { cancelled: () => true }).catch((e) => { cancelled = e && e.code; });
    ok('solve() stops when cancelled', cancelled === 'cancelled');
    let badIn = 0;
    for (const [c, b] of [['', 14], ['has space', 14], ['x'.repeat(201), 14], ['ok', 0], ['ok', 33], [5, 14]]) {
      await Pow.solve(c, b).catch((e) => { if (e && e.code === 'bad_input') badIn++; });
    }
    ok('solve() refuses a malformed challenge or bits', badIn === 6, `${badIn}/6`);
    const src = stripComments(read(path.join(SHELL, 'js', 'play-pow.js')));
    ok('play-pow: no network, no storage, no DOM — it only computes', !/fetch\(|XMLHttpRequest|localStorage|document\./.test(src));
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

  console.log('\n[6] the floating chat bubble (design §19.17.7, D23, threat note #30; Part C7)');
  {
    const bubbleSrc = read(path.join(SHELL, 'js', 'chat-bubble.js'));
    const bubble = stripComments(bubbleSrc);
    const bubbleCss = read(path.join(SHELL, 'css', 'chat-bubble.css'));
    const shellJs6 = stripComments(read(path.join(SHELL, 'js', 'play-shell.js')));
    // Static rules.
    ok('bubble: rows come from the shared core (no second chat client)',
      /Core\.createFeed\(\{ list: list, actions: buildActions \}\)/.test(bubble) && !/m\.body/.test(bubble) && !/play-chat-body/.test(bubble));
    ok('bubble: skips an exempt page itself too (the loader is the first check)',
      /if \(docEl\.getAttribute\('data-untrusted-html'\) === 'exempt'\) return;/.test(bubble));
    const lsCalls = [...bubble.matchAll(/localStorage\.[a-zA-Z]+\(/g)].length;
    ok('bubble: storage only through sget/sset, each in try/catch',
      lsCalls === 3 && /function sget\(k\) \{ try \{ return localStorage\.getItem\(k\); \} catch/.test(bubble)
      && /function sset\(k, v\) \{ try \{ if \(v === null\) localStorage\.removeItem\(k\); else localStorage\.setItem\(k, v\); \} catch/.test(bubble), `${lsCalls}`);
    const urls = [...bubble.matchAll(/'(\/play\/[^']*)'/g)].map((m) => m[1]).sort();
    ok('bubble: the only URLs are fixed /play/ paths (the page, #signup, its CSS, its two scripts)',
      JSON.stringify([...new Set(urls)]) === JSON.stringify(['/play/', '/play/#signup', '/play/css/chat-bubble.css', '/play/js/']), urls.join(' '));
    ok('bubble: the stamp it reuses is exactly 12 hex from its own src',
      /\/\[\?&\]v=\(\[0-9a-f\]\{12\}\)\$\/\.exec\(cs\.src \|\| ''\)/.test(bubble));
    const bubblePaths = [...bubble.matchAll(/Api\.(get|post)\(([^,)]*)/g)].map((m) => m[2].trim());
    ok('bubble: API paths are chat, report, me, the two login routes (via runSignIn), logout — no mod/ path',
      bubblePaths.length > 0 && bubblePaths.every((a) => /^(S\.feed\.path\(|'me'|'chat'|'chat\/' \+ m\.id \+ '\/report'|path|'logout')$/.test(a))
      && /runSignIn\('login', \{ address: address, proof: proof \}/.test(bubble) && /runSignIn\('login\/guest', \{ name: name, password: password \}/.test(bubble)
      && !/mod\//.test(bubble), bubblePaths.join(' | '));
    ok('bubble: the anti-scam line is always in the panel (not behind sign-in)',
      /'The operator will never ask you for funds, keys or seeds in chat\.'/.test(bubble) && /panel\.appendChild\(warn\);/.test(bubble));
    ok('bubble: sign-up is a link to /play/#signup, never a form here (the PoW lives on /play/)',
      /href: '\/play\/#signup'/.test(bubble) && !/signup\/challenge|'signup'/.test(bubble));
    ok('bubble: no input carries a name attribute', !/attrs\([^;]*\bname: '/.test(bubble) && !/setAttribute\('name'/.test(bubble));
    ok('bubble: every password box is wiped after every sign-in attempt',
      /runSignIn\('login'[^;]*function \(\) \{ mProof\.value = ''; \}\);/.test(bubble) && /runSignIn\('login\/guest'[^;]*function \(\) \{ gPass\.value = ''; \}\);/.test(bubble)
      && /\(r\) \{\s*wipe\(\);/.test(bubble) && /\(e\) \{\s*wipe\(\);/.test(bubble));
    ok('bubble: a successful sign-in clears the typed address / name too (no full address left in the DOM, #30)',
      /function signedIn\(me\) \{\s*sset\(K_SIGNED, '1'\);\s*mAddr\.value = '';\s*gName\.value = '';/.test(bubble));
    ok('bubble: Esc closes and focus returns to the button; dialog + aria labels',
      /e\.key === 'Escape' \|\| e\.key === 'Esc'\) \{ e\.preventDefault\(\); close\(true\); \}/.test(bubble) && /if \(returnFocus\) \{ try \{ launch\.focus\(\);/.test(bubble)
      && /role: 'dialog'/.test(bubble) && /'aria-label': 'Open chat'/.test(bubble) && /'aria-label': 'Close chat'/.test(bubble) && /'aria-expanded'/.test(bubble));
    ok('bubble: no setInterval; the closed cadence is 60 s; hidden = paused',
      !/setInterval\(/.test(bubble) && /POLL_CLOSED = 60000/.test(bubble)
      && /if \(document\.visibilityState === 'hidden'\) return false;\s*return S\.open \|\| sessionLikely\(\);/.test(bubble)
      && /if \(document\.visibilityState === 'hidden'\) \{ stop\(\); return; \}/.test(bubble));
    ok('bubble css: below the consent bar / banners (z 9990 < 9998), a ≤ 600 px sheet, nothing fetched from CSS',
      /z-index: 9990;/.test(bubbleCss) && /@media \(max-width: 600px\)/.test(bubbleCss) && !/url\(|@import/.test(bubbleCss)
      && /bottom: calc\(var\(--gcb-gap\) \+ var\(--gcb-lift\)\)/.test(bubbleCss));
    ok('bubble css: ink on an accent fill is var(--bg)', /background: var\(--accent\); color: var\(--bg\);/.test(bubbleCss));
    ok('shell: writes the signed-in hint on sign-in and clears it on sign-out (no token, try/catch)',
      /function signedIn\(me\) \{\s*hint\(HINT_SIGNED, true\);/.test(shellJs6) && /S\.me = null;\s*hint\(HINT_SIGNED, false\);/.test(shellJs6)
      && /function hint\(key, on\) \{\s*try \{ if \(on\) localStorage\.setItem\(key, '1'\); else localStorage\.removeItem\(key\); \} catch/.test(shellJs6));
    ok('shell: the preview hint follows rules.mode (preview sets, on removes)',
      /if \(r\.mode === 'preview'\) hint\(HINT_PREVIEW, true\);\s*else if \(r\.mode === 'on'\) hint\(HINT_PREVIEW, false\);/.test(shellJs6)
      && /HINT_SIGNED = 'grin_play_signed_in', HINT_PREVIEW = 'grin_play_preview'/.test(shellJs6));

    // Behaviour: the polling budget, measured — the bubble in a vm with a fake DOM, a fake
    // clock and a fake fetch that counts every request. The two dependencies are the real
    // files, run when the bubble appends them.
    const runBubble = async (o) => {
      let clock = 1_000_000;
      const timers = [];
      let tid = 0;
      const fakeSetTimeout = (fn, ms) => { const id = ++tid; timers.push({ id, at: clock + Math.max(0, ms || 0), fn }); return id; };
      const fakeClearTimeout = (id) => { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1); };
      const flush = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r)); };
      const advance = async (ms) => {
        const end = clock + ms;
        for (;;) {
          timers.sort((a, b) => a.at - b.at);
          const t = timers[0];
          if (!t || t.at > end) break;
          timers.shift();
          clock = t.at;
          t.fn();
          await flush();
        }
        clock = end;
        await flush();
      };
      const store = Object.assign({}, o.storage || {});
      const requests = [];
      const scripts = [];
      const docListeners = {};
      const mk = (tag) => {
        const L = {};
        const e = {
          tagName: String(tag).toUpperCase(), children: [], parentNode: null, attributes: {}, hidden: false,
          className: '', value: '', type: '', disabled: false, tabIndex: 0, scrollTop: 0, scrollHeight: 0, clientHeight: 0, offsetHeight: 0,
          _text: '', style: { setProperty() {}, cssText: '' },
          classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, toggle(c, on) { if (on === undefined ? !this._s.has(c) : on) this._s.add(c); else this._s.delete(c); }, contains(c) { return this._s.has(c); } },
          get textContent() { return this._text; }, set textContent(v) { this._text = String(v); this.children = []; },
          get firstChild() { return this.children[0] || null; },
          setAttribute(k, v) { this.attributes[k] = String(v); }, getAttribute(k) { return k in this.attributes ? this.attributes[k] : null; },
          addEventListener(t, fn) { (L[t] = L[t] || []).push(fn); }, _fire(t, ev) { (L[t] || []).forEach((fn) => fn(ev || { type: t, preventDefault() {} })); },
          appendChild(c) { if (c.parentNode) c.parentNode.removeChild(c); c.parentNode = this; this.children.push(c); return c; },
          insertBefore(c, ref) { if (!ref) return this.appendChild(c); if (c.parentNode) c.parentNode.removeChild(c); c.parentNode = this; this.children.splice(this.children.indexOf(ref), 0, c); return c; },
          replaceChild(n, old) { const i = this.children.indexOf(old); if (n.parentNode) n.parentNode.removeChild(n); n.parentNode = this; this.children[i] = n; old.parentNode = null; return old; },
          removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); c.parentNode = null; return c; },
          focus() {},
        };
        return e;
      };
      const body = mk('body');
      const head = mk('head');
      const html = mk('html');
      const ctx = {
        console, AbortController: undefined, Promise, Object, Array, JSON, Math, Number, String,
        Date: class extends Date { static now() { return clock; } },
        setTimeout: fakeSetTimeout, clearTimeout: fakeClearTimeout,
        localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } },
        innerWidth: 1280,
        MutationObserver: function () { return { observe() {} }; },
        addEventListener() {},
        document: {
          documentElement: html, body, head, visibilityState: 'visible',
          currentScript: { src: '/play/js/chat-bubble.js?v=abcdef012345' },
          createElement: mk, createTextNode: (t) => { const n = mk('#text'); n.textContent = t; return n; },
          getElementById: () => null,
          addEventListener: (t, fn) => { (docListeners[t] = docListeners[t] || []).push(fn); },
        },
        fetch: (url, opts) => {
          const method = (opts && opts.method) || 'GET';
          requests.push(`${method} ${url}`);
          const json = (status, b) => Promise.resolve({ status, ok: status >= 200 && status < 300, headers: { get: () => 'application/json' }, json: () => Promise.resolve(b) });
          if (/\/play\/api\/me$/.test(url)) return o.meStatus === 401 ? json(401, { ok: false, error: 'unauthorized' }) : json(200, { ok: true, kind: 'guest', address: 'g:x', guest: { login_name: 'Tester' }, chat: { can_post: true } });
          if (/\/play\/api\/rules$/.test(url)) return json(200, { ok: true, mode: 'on', guests: { chat_min_age_s: 86400 } });
          if (/\/play\/api\/chat\?/.test(url)) return json(200, { ok: true, enabled: true, epoch: '0123456789abcdef', rev: 1, messages: o.messages || [] });
          return json(404, { ok: false, error: 'not_found' });
        },
      };
      ctx.window = ctx;
      body.appendChild = function (c) {
        mk('x').appendChild.call(this, c);
        if (c.tagName === 'SCRIPT') {
          scripts.push(c.src);
          const m = /^\/play\/js\/(play-api|play-chat-core)\.js\?v=abcdef012345$/.exec(c.src);
          Promise.resolve().then(() => {
            if (m) vm.runInContext(read(path.join(SHELL, 'js', m[1] + '.js')), ctx, { filename: m[1] + '.js' });
            c._fire(m ? 'load' : 'error');
          });
        }
        return c;
      };
      head.appendChild = function (c) { mk('x').appendChild.call(this, c); Promise.resolve().then(() => c._fire('load')); return c; };
      vm.createContext(ctx);
      vm.runInContext(bubbleSrc, ctx, { filename: 'chat-bubble.js' });
      await flush();
      return {
        ctx, store, requests, scripts, advance, flush,
        root: body.children.find((c) => c.attributes.id === 'grin-chat-bubble'),
        setHidden: async (hidden) => { ctx.document.visibilityState = hidden ? 'hidden' : 'visible'; (docListeners.visibilitychange || []).forEach((fn) => fn()); await flush(); },
      };
    };
    const chats = (rs) => rs.filter((r) => /\/play\/api\/chat\?/.test(r)).length;

    // 1. Closed, no session hint: NOTHING — no API request, not even the chat scripts.
    let b = await runBubble({});
    await b.advance(10 * 60_000);
    ok('budget: closed + not signed in → 0 requests in 10 min, no script fetched', b.requests.length === 0 && b.scripts.length === 0, `${b.requests.join(',')} | ${b.scripts.join(',')}`);
    ok('budget: …and the button is on the page (shown once its CSS loaded)', !!b.root && b.root.hidden === false);

    // 2. Closed, with the hint: /me once, then the change feed every 60 s.
    b = await runBubble({ storage: { grin_play_signed_in: '1' } });
    ok('budget: closed + signed in → the two scripts stamped, /me once, one chat read at start',
      JSON.stringify(b.scripts) === JSON.stringify(['/play/js/play-api.js?v=abcdef012345', '/play/js/play-chat-core.js?v=abcdef012345'])
      && b.requests.filter((r) => r === 'GET /play/api/me').length === 1 && chats(b.requests) === 1, b.requests.join(','));
    await b.advance(5 * 60_000);
    const c5 = chats(b.requests);
    ok('budget: …then one chat read per 60 s (5 more in 5 min), /me not repeated', c5 === 6 && b.requests.filter((r) => r === 'GET /play/api/me').length === 1, `${c5}`);
    await b.setHidden(true);
    const before = b.requests.length;
    await b.advance(10 * 60_000);
    ok('budget: hidden tab → paused (0 requests in 10 min)', b.requests.length === before, `${b.requests.length - before}`);
    await b.setHidden(false);
    await b.advance(0);
    ok('budget: visible again → resumes (one read, it was overdue)', chats(b.requests) === c5 + 1, `${chats(b.requests) - c5}`);

    // 3. A stale hint: one 401 clears it, and the closed bubble goes quiet.
    b = await runBubble({ storage: { grin_play_signed_in: '1' }, meStatus: 401 });
    await b.advance(10 * 60_000);
    ok('budget: a stale hint costs exactly one 401 and is cleared; then nothing',
      b.requests.length === 1 && b.requests[0] === 'GET /play/api/me' && !('grin_play_signed_in' in b.store), b.requests.join(','));

    // 4. Open (remembered), signed out: the panel cadence for a reader — every 15 s.
    b = await runBubble({ storage: { grin_play_chat_open: '1' } });
    const r0 = chats(b.requests);
    await b.advance(60_000);
    ok('budget: open + signed out → rules once, no /me, a read every 15 s',
      r0 === 1 && chats(b.requests) === 5 && !b.requests.includes('GET /play/api/me') && b.requests.filter((r) => /rules$/.test(r)).length === 1, `${r0} → ${chats(b.requests)}`);
    // Open + signed in: every 4 s.
    b = await runBubble({ storage: { grin_play_chat_open: '1', grin_play_signed_in: '1' } });
    const s0 = chats(b.requests);
    await b.advance(60_000);
    ok('budget: open + signed in → a read every 4 s (15 a minute)', chats(b.requests) - s0 === 15, `${chats(b.requests) - s0}`);

    // 5. Unread dot: the first sight is the baseline; a newer message from someone else lights it.
    const msg = (id, own) => ({ id, created_at: 1_700_000_000 + id, name: 'grin1abcd…wxyz', role: 'player', body: '<img src=x onerror=alert(1)>', own: !!own });
    b = await runBubble({ storage: { grin_play_signed_in: '1' }, messages: [msg(7)] });
    const dot = (bb) => bb.root.children.find((c) => c.className === 'gcb-launch').children.find((c) => c.className === 'gcb-dot');
    ok('unread: first sight sets the baseline (no dot), stored per viewer', dot(b).hidden === true && b.store.grin_play_chat_seen === '7');
    b = await runBubble({ storage: { grin_play_signed_in: '1', grin_play_chat_seen: '5' }, messages: [msg(7)] });
    ok('unread: a message newer than the stored baseline lights the dot (and relabels the button)',
      dot(b).hidden === false && /new messages/.test(b.root.children.find((c) => c.className === 'gcb-launch').attributes['aria-label']));
    b = await runBubble({ storage: { grin_play_signed_in: '1', grin_play_chat_seen: '5' }, messages: [msg(7, true)] });
    ok('unread: your own message never lights it', dot(b).hidden === true);
    // The body went in as text: the row's <p> holds the literal characters, no element children.
    b = await runBubble({ storage: { grin_play_chat_open: '1' }, messages: [msg(9)] });
    const panel = b.root.children.find((c) => c.attributes.id === 'gcb-panel');
    const listEl = panel.children.find((c) => /gcb-list/.test(c.className));
    const row = listEl.children[0];
    const bodyP = row && row.children.find((c) => c.className === 'play-chat-body');
    ok('render: a body with markup is a text node in a <p> (textContent), never parsed',
      !!bodyP && bodyP.textContent === '<img src=x onerror=alert(1)>' && bodyP.children.length === 0);

    // 6. Storage that throws: the bubble still works, as "not set".
    const throwing = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); }, removeItem() { throw new Error('denied'); } };
    b = await runBubble({});
    b.ctx.localStorage = throwing;
    let threw = false;
    try { b.root.children.find((c) => c.className === 'gcb-launch')._fire('click'); await b.flush(); } catch (e) { threw = true; }
    ok('storage throws: opening still works (no exception; a throw reads as not set)', !threw && b.requests.some((r) => /\/play\/api\/chat\?/.test(r)));
  }
}

main().catch((e) => { fail++; console.error(`  FAIL  unexpected error: ${e && e.stack}`); })
  .finally(() => {
    console.log(`\nRESULT pass=${pass} fail=${fail}`);
    process.exitCode = fail ? 1 : 0;
  });
