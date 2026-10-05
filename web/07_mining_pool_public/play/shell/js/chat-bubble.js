/* chat-bubble.js — the floating chat on the pool's public pages (design §19.17.7, D23; Part C7).
 *
 * Owned by the games tree, deployed and stamped with the /play/ shell; the POOL carries only
 * a tiny loader (public_html/js/branding.js loadChatBubble) that inserts this file when the
 * branding payload says chat is on in the effective mode. Everything below runs on a POOL
 * page, under the pool's page CSP — so it builds every node with createElement + textContent
 * (no innerHTML, no inline handler), reads nothing from the page, and talks only to the same-
 * origin /play/api/ through PlayApi.
 *
 *   closed           a small button bottom-right, with an unread dot
 *   open             a panel (desktop) / a full-screen sheet (≤ 600 px); Esc closes, focus returns
 *   reading          public, anonymous — the shared chat core (play-chat-core.js) draws the rows
 *   posting/report   for a chat-capable session (the server's /me says so)
 *   sign-in          Miner (address + proof) and Guest (name + password), the same login routes
 *                    as /play/; sign-UP is only on /play/ (it needs the proof-of-work, D24)
 *   moderator tools  stay on /play/ — this links there
 *
 * Polling budget (§19.17.7) — the reason this file is shaped the way it is:
 *   closed + not signed in → NO requests at all (not even the chat scripts are fetched)
 *   closed + signed in     → the change feed every 60 s, for the unread dot
 *   open                   → the /play/ panel's cadence: 4 s signed in, 15 s signed out
 *   hidden tab             → paused (visibilitychange), whatever the state
 * "Signed in" is a localStorage HINT (grin_play_signed_in, written by the shell and by this
 * file): the session cookie is HttpOnly, so no script can see it. The hint holds no token; a
 * stale one costs one 401 on /me and is cleared. Every storage access is in try/catch — a
 * throw reads as "not set".
 */
(function () {
  'use strict';

  if (window.GrinChatBubble) return;                     // one bubble per page, whatever loads it twice
  var docEl = document.documentElement;
  // The loader already skips these pages; this is the second check (§19.13 #30).
  if (docEl.getAttribute('data-untrusted-html') === 'exempt') return;
  if (!document.body) return;

  // The stamp this file was loaded with, reused for its own CSS and its two dependencies.
  var V = '';
  try {
    var cs = document.currentScript;
    var vm = cs && /[?&]v=([0-9a-f]{12})$/.exec(cs.src || '');
    if (vm) V = vm[1];
  } catch (e) { /* no stamp: plain URLs, revalidated (no-cache) */ }
  var QS = V ? '?v=' + V : '';

  var K_OPEN = 'grin_play_chat_open';         // '1' while the viewer left the bubble open
  var K_SIGNED = 'grin_play_signed_in';       // '1' while this browser has a games session (hint)
  var K_SEEN = 'grin_play_chat_seen';         // the newest message id the viewer has had open
  var K_TAB = 'grin_play_login_tab';          // shared with the /play/ sign-in card
  function sget(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function sset(k, v) { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) { /* no memory, no harm */ } }
  function hintOn() { return sget(K_SIGNED) === '1'; }

  var POLL_IN = 4000, POLL_OUT = 15000, POLL_CLOSED = 60000, POLL_MORE = 250;
  var SHEET_MAX = 600;                         // ≤ this width the open bubble is a full-screen sheet

  // ── DOM (createElement + textContent only) ──────────────────────────────────────────
  function el(tag, cls, txt) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (txt != null) n.textContent = String(txt);
    return n;
  }
  function attrs(n, map) { Object.keys(map).forEach(function (k) { n.setAttribute(k, map[k]); }); return n; }
  function show(n, on) { if (n) n.hidden = !on; }
  function say(n, s, kind) { if (!n) return; n.textContent = s || ''; n.className = 'acct-msg gcb-msg' + (s ? (kind === 'ok' ? ' ok' : ' err') : ''); }
  function input(id, type, extra) {
    var i = attrs(el('input', 'input'), { id: id, type: type, spellcheck: 'false', autocapitalize: 'off' });
    if (extra) attrs(i, extra);
    return i;
  }
  function field(labelText, inp) {
    var d = el('div', 'gcb-field');
    var l = el('label', null, labelText);
    l.setAttribute('for', inp.id);
    d.appendChild(l);
    d.appendChild(inp);
    return d;
  }

  var wrap = attrs(el('div', 'gcb'), { id: 'grin-chat-bubble' });
  wrap.hidden = true;                          // until its stylesheet has loaded — never unstyled

  var launch = attrs(el('button', 'gcb-launch'), { type: 'button', 'aria-label': 'Open chat', 'aria-expanded': 'false', 'aria-controls': 'gcb-panel' });
  launch.appendChild(attrs(el('span', 'gcb-launch-ico', '💬'), { 'aria-hidden': 'true' }));
  var dot = attrs(el('span', 'gcb-dot'), { 'aria-hidden': 'true' });
  dot.hidden = true;
  launch.appendChild(dot);

  var panel = attrs(el('section', 'gcb-panel'), { id: 'gcb-panel', role: 'dialog', 'aria-labelledby': 'gcb-title' });
  panel.hidden = true;

  var head = el('div', 'gcb-head');
  var title = attrs(el('h2', 'gcb-title', 'Chat'), { id: 'gcb-title', tabindex: '-1' });
  var who = el('span', 'gcb-who');
  var full = attrs(el('a', 'gcb-full', 'Games ↗'), { href: '/play/', title: 'The games page: the full chat, your account, and the moderator tools' });
  var closeBtn = attrs(el('button', 'gcb-close', '✕'), { type: 'button', 'aria-label': 'Close chat' });
  var headText = el('div', 'gcb-head-text');
  headText.appendChild(title);
  headText.appendChild(who);
  head.appendChild(headText);
  head.appendChild(full);
  head.appendChild(closeBtn);

  // Always visible, open or not signed in (§19.10).
  var warn = el('p', 'gcb-warn');
  warn.appendChild(el('b', null, 'The operator will never ask you for funds, keys or seeds in chat.'));
  warn.appendChild(document.createTextNode(' Only the Operator badge is proof — any name can be imitated.'));

  var state = el('p', 'gcb-state dim');
  state.hidden = true;
  var list = attrs(el('ol', 'play-chat-list gcb-list'), { 'aria-label': 'Chat messages' });
  var empty = el('p', 'gcb-state dim', 'No messages yet. Say hello.');
  empty.hidden = true;

  var foot = el('div', 'gcb-foot');
  // Compose.
  var form = attrs(el('form', 'gcb-form'), { novalidate: '' });
  form.hidden = true;
  var count = attrs(el('span', 'gcb-count dim', '0 / 280'), { 'aria-hidden': 'true' });
  var lab = attrs(el('label', 'gcb-label', 'Your message '), { for: 'gcb-input' });
  lab.appendChild(count);
  var chatInput = input('gcb-input', 'text', { maxlength: '280', autocomplete: 'off', spellcheck: 'true' });
  var send = attrs(el('button', 'btn primary sm', 'Send'), { type: 'submit' });
  var compose = el('div', 'gcb-compose');
  compose.appendChild(chatInput);
  compose.appendChild(send);
  form.appendChild(lab);
  form.appendChild(compose);
  var guestNote = el('p', 'gcb-note dim', 'As a guest, a message with a link in it waits for a moderator before others see it.');
  guestNote.hidden = true;
  var gate = el('p', 'gcb-gate');
  gate.hidden = true;
  var modNote = el('p', 'gcb-note dim', 'Your moderator tools are on the games page.');
  modNote.hidden = true;

  // Sign-in (signed out only).
  var signin = el('div', 'gcb-signin');
  signin.hidden = true;
  var signinOpen = attrs(el('button', 'btn sm gcb-signin-open', 'Sign in to post'), { type: 'button', 'aria-expanded': 'false', 'aria-controls': 'gcb-signin-forms' });
  var forms = attrs(el('div', 'gcb-signin-forms'), { id: 'gcb-signin-forms' });
  forms.hidden = true;
  var tabs = attrs(el('div', 'gcb-tabs'), { role: 'tablist', 'aria-label': 'Sign in as' });
  var tabMiner = attrs(el('button', 'gcb-tab', 'Miner'), { type: 'button', role: 'tab', id: 'gcb-tab-miner', 'aria-controls': 'gcb-pane-miner' });
  var tabGuest = attrs(el('button', 'gcb-tab', 'Guest'), { type: 'button', role: 'tab', id: 'gcb-tab-guest', 'aria-controls': 'gcb-pane-guest' });
  tabs.appendChild(tabMiner);
  tabs.appendChild(tabGuest);

  var paneMiner = attrs(el('form', 'gcb-pane'), { id: 'gcb-pane-miner', role: 'tabpanel', 'aria-labelledby': 'gcb-tab-miner', novalidate: '', autocomplete: 'off' });
  var mAddr = input('gcb-m-address', 'text', { maxlength: '80', autocomplete: 'off', placeholder: 'grin1…' });
  var mProof = input('gcb-m-proof', 'password', { maxlength: '128', autocomplete: 'off', placeholder: 'a mining IP, or your rig password' });
  var mReveal = attrs(el('button', 'btn sm', 'Show'), { type: 'button', 'aria-pressed': 'false', 'aria-controls': 'gcb-m-proof' });
  var proofRow = el('div', 'gcb-compose');
  proofRow.appendChild(mProof);
  proofRow.appendChild(mReveal);
  var proofField = field('A recent mining IP or your rig\'s stratum password', mProof);
  proofField.replaceChild(proofRow, mProof);
  var mSubmit = attrs(el('button', 'btn primary sm', 'Sign in'), { type: 'submit' });
  paneMiner.appendChild(field('The GRIN address your rigs mine to', mAddr));
  paneMiner.appendChild(proofField);
  paneMiner.appendChild(mSubmit);

  var paneGuest = attrs(el('form', 'gcb-pane'), { id: 'gcb-pane-guest', role: 'tabpanel', 'aria-labelledby': 'gcb-tab-guest', novalidate: '', autocomplete: 'on' });
  var gName = input('gcb-g-name', 'text', { maxlength: '40', autocomplete: 'username' });
  var gPass = input('gcb-g-password', 'password', { maxlength: '256', autocomplete: 'current-password' });
  var gSubmit = attrs(el('button', 'btn primary sm', 'Sign in'), { type: 'submit' });
  paneGuest.appendChild(field('Guest name', gName));
  paneGuest.appendChild(field('Password', gPass));
  paneGuest.appendChild(gSubmit);

  var create = el('p', 'gcb-note dim', 'Don\'t mine here? ');
  create.appendChild(attrs(el('a', null, 'Create a free guest account'), { href: '/play/#signup' }));
  create.appendChild(document.createTextNode(' on the games page — it takes a few seconds, no email.'));

  forms.appendChild(tabs);
  forms.appendChild(paneMiner);
  forms.appendChild(paneGuest);
  forms.appendChild(create);
  signin.appendChild(signinOpen);
  signin.appendChild(forms);

  var acct = el('div', 'gcb-acct');
  acct.hidden = true;
  var signout = attrs(el('button', 'btn sm', 'Sign out'), { type: 'button' });
  acct.appendChild(signout);

  var note = attrs(el('div', 'acct-msg gcb-msg'), { role: 'alert' });

  foot.appendChild(form);
  foot.appendChild(guestNote);
  foot.appendChild(gate);
  foot.appendChild(modNote);
  foot.appendChild(signin);
  foot.appendChild(note);
  foot.appendChild(acct);

  panel.appendChild(head);
  panel.appendChild(warn);
  panel.appendChild(state);
  panel.appendChild(list);
  panel.appendChild(empty);
  panel.appendChild(foot);
  wrap.appendChild(panel);
  wrap.appendChild(launch);

  // The page's last lines must be able to scroll clear of the closed button.
  var spacer = attrs(el('div', 'gcb-spacer'), { 'aria-hidden': 'true' });

  var css = attrs(document.createElement('link'), { rel: 'stylesheet', href: '/play/css/chat-bubble.css' + QS });
  css.addEventListener('load', function () { wrap.hidden = false; lift(); });
  document.head.appendChild(css);
  document.body.appendChild(spacer);
  document.body.appendChild(wrap);

  // The pool's cookie-consent bar (branding.js #brand-consent) sits fixed at the bottom; the
  // bubble rides above it rather than covering it (§19.17.7 layout rule).
  function lift() {
    var c = document.getElementById('brand-consent');
    wrap.style.setProperty('--gcb-lift', (c && !c.hidden ? c.offsetHeight : 0) + 'px');
  }
  try { new MutationObserver(lift).observe(document.body, { childList: true }); } catch (e) { /* no lift then */ }
  window.addEventListener('resize', lift);

  // ── State ───────────────────────────────────────────────────────────────────────────
  var S = {
    open: false,
    me: undefined,          // undefined = not asked yet; null = signed out; object = /me
    enabled: null,
    rules: null,
    feed: null,
    timer: null, inflight: false, soon: false, lastPoll: 0,
    seen: null,             // newest id seen with the bubble open (persisted), null = never
    deps: null,
    waitTimer: null,
    tab: sget(K_TAB) === 'guest' ? 'guest' : 'miner'
  };
  var stored = Number(sget(K_SEEN));
  if (isFinite(stored) && stored >= 0 && Math.floor(stored) === stored && sget(K_SEEN) !== null) S.seen = stored;

  var Api = null, Core = null;

  // The two scripts the chat needs, fetched only when the bubble has something to do (opened,
  // or a session to poll for) — a closed bubble with no session costs no request at all.
  // Fixed paths under /play/js/, the stamp this file came with; never a URL from anywhere else.
  function loadDeps() {
    if (S.deps) return S.deps;
    S.deps = new Promise(function (resolve, reject) {
      var need = [];
      if (!window.PlayApi) need.push('play-api.js');
      if (!window.PlayChatCore) need.push('play-chat-core.js');
      if (!need.length) { resolve(); return; }
      var last = null;
      need.forEach(function (name) {
        var s = document.createElement('script');
        s.src = '/play/js/' + name + QS;
        s.async = false;                         // run in this order (api, then core)
        s.addEventListener('error', function () { reject(new Error('load')); });
        document.body.appendChild(s);
        last = s;
      });
      last.addEventListener('load', function () { resolve(); });
    }).then(function () {
      if (!window.PlayApi || !window.PlayChatCore) throw new Error('load');
      Api = window.PlayApi;
      Core = window.PlayChatCore;
      if (!S.feed) S.feed = Core.createFeed({ list: list, actions: buildActions });
    });
    S.deps.catch(function () { S.deps = null; });
    return S.deps;
  }

  function canPost() { return !!(S.me && S.me.chat && S.me.chat.can_post); }
  // Closed, the bubble polls only for a session — a known one, or the hint while /me is unasked.
  function sessionLikely() { return S.me ? true : (S.me === undefined && hintOn()); }
  function wantPoll() {
    if (document.visibilityState === 'hidden') return false;
    return S.open || sessionLikely();
  }

  // ── The rows' buttons: Report only (the moderator tools stay on /play/) ──────────────
  function buildActions(m) {
    if (!(canPost() && !m.own && !m.held && m.role !== 'operator')) return null;
    var box = el('span', 'play-chat-actions');
    box.appendChild(Core.armButton(Core.smallBtn(), 'Report', 'Confirm report', function () {
      return Api.post('chat/' + m.id + '/report', {}).then(function (r) {
        say(note, r.duplicate ? 'You already reported that message.' : 'Reported. A moderator will look at it.', 'ok');
        if (r.held) pollSoon();
      }, function (e) { if (!sessionEnded(e)) say(note, Core.errText(e, S.rules)); });
    }));
    return box;
  }

  // ── Polling ─────────────────────────────────────────────────────────────────────────
  function delay() {
    if (S.soon) { S.soon = false; return POLL_MORE; }
    if (!S.open || S.enabled === false) return POLL_CLOSED;
    return S.me ? POLL_IN : POLL_OUT;
  }
  function stop() { if (S.timer) { clearTimeout(S.timer); S.timer = null; } }
  function schedule(ms) { stop(); if (wantPoll()) S.timer = setTimeout(poll, ms == null ? delay() : ms); }
  function pollSoon() { S.soon = true; if (!S.inflight) schedule(); }

  function poll() {
    stop();
    if (!wantPoll() || S.inflight || !S.feed) return;
    S.inflight = true;
    S.lastPoll = Date.now();
    Api.get(S.feed.path()).then(apply, function (e) {
      if (e instanceof Api.Error && e.status === 404) { setEnabled(false); return; }
      // Offline or a blip: keep what is on screen; say so only when there is nothing to show.
      if (S.open && S.feed.size() === 0) { state.textContent = 'Chat can\'t be reached right now — it will try again.'; show(state, true); }
    }).then(function () { S.inflight = false; schedule(); });
  }

  function setEnabled(on) {
    S.enabled = on;
    if (!on) {
      if (S.feed) S.feed.reset();
      show(empty, false);
      state.textContent = 'Chat is closed right now.';
    }
    show(state, !on);
    setUnread(false);
    render();
  }

  function setSeen(id) {
    if (typeof id !== 'number' || !(id >= 0)) return;
    S.seen = id;
    sset(K_SEEN, String(id));
  }
  function setUnread(on) {
    show(dot, on);
    launch.setAttribute('aria-label', on ? 'Open chat — new messages' : 'Open chat');
  }

  function apply(r) {
    if (!r || r.enabled !== true) { setEnabled(false); return; }
    var was = S.enabled;
    S.enabled = true;
    show(state, false);
    if (was !== true) render();
    var atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 48;
    var res = S.feed.apply(r);
    var newest = S.feed.newest();
    if (S.seen === null || (S.open && document.visibilityState === 'visible')) {
      setSeen(newest);                                  // first sight is the baseline, not "unread"
    } else if (res.added.some(function (m) { return !m.own && m.id > S.seen; })) {
      setUnread(true);
    }
    show(empty, S.open && S.feed.size() === 0);
    if (S.open && atBottom) list.scrollTop = list.scrollHeight;
    if (res.more) S.soon = true;
  }

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') { stop(); return; }
    if (!wantPoll() || S.inflight || !S.feed) return;
    if (S.open) { poll(); return; }
    schedule(Math.max(0, POLL_CLOSED - (Date.now() - S.lastPoll)));
  });

  // ── The session ─────────────────────────────────────────────────────────────────────
  // Only asked when the hint says there may be one: no hint, no request.
  function refreshMe() {
    if (!hintOn()) { setMe(null); return Promise.resolve(); }
    return Api.get('me').then(function (me) { setMe(me); }, function (e) {
      if (sessionEnded(e)) return;
      // Offline or games closed: leave it; the next open asks again.
    });
  }
  // A 401 (or a ban) ends the session: clear the hint and say so once.
  function sessionEnded(e) {
    if (!(e instanceof Api.Error)) return false;
    if (e.status === 401 || (e.status === 403 && e.code === 'banned')) {
      var had = !!S.me;
      sset(K_SIGNED, null);
      setMe(null);
      if (had) say(note, e.status === 401 ? 'Your session has ended. Sign in again to post.' : e.message);
      return true;
    }
    return false;
  }

  function setMe(me) {
    var next = me && typeof me === 'object' ? me : null;
    var prev = S.me;
    var change = !!next !== !!prev || (next && prev && next.address !== prev.address);
    S.me = next;
    render();
    if (S.feed) S.feed.redraw();
    // Signing in or out changes what the list holds (the caller's own held messages).
    if (change && S.feed && prev !== undefined) { S.feed.reset(); if (!S.inflight) poll(); }
    else if (!S.timer && !S.inflight) schedule();
  }

  function whoText(me) {
    if (!me) return '';
    var guest = me.kind === 'guest' && me.guest && typeof me.guest.login_name === 'string';
    return 'as ' + (guest ? me.guest.login_name + ' · guest' : (typeof me.address_masked === 'string' ? me.address_masked : 'a miner'));
  }

  function render() {
    var open = S.enabled === true;
    var posting = open && canPost();
    who.textContent = whoText(S.me);
    show(form, posting);
    show(guestNote, posting && S.me.kind === 'guest');
    var g = '';
    if (open && S.me && !posting) g = Core ? Core.gateText(S.me.chat, S.rules) : '';
    gate.textContent = g;
    show(gate, !!g);
    show(modNote, open && !!(S.me && S.me.moderator));
    show(signin, open && !S.me);
    show(acct, !!S.me);
    scheduleWaitEnd();
  }

  // A wait with an end (a guest account's age, a new proof's age): ask /me again when it runs
  // out, so the form appears without a reload. One timer, capped at 6 h.
  function scheduleWaitEnd() {
    if (S.waitTimer) { clearTimeout(S.waitTimer); S.waitTimer = null; }
    var c = S.me && S.me.chat;
    if (!c || c.can_post || (c.reason !== 'account_too_new' && c.reason !== 'proof_too_new') || typeof c.available_at !== 'number') return;
    var ms = (c.available_at - Math.floor(Date.now() / 1000)) * 1000 + 2000;
    if (!(ms > 0) || ms > 6 * 3600 * 1000) return;
    S.waitTimer = setTimeout(function () { S.waitTimer = null; if (S.open) refreshMe(); }, ms);
  }

  // ── Open / close ────────────────────────────────────────────────────────────────────
  function isSheet() { return window.innerWidth <= SHEET_MAX; }

  function open() {
    if (S.open) return;
    S.open = true;
    sset(K_OPEN, '1');
    show(panel, true);
    show(launch, false);
    launch.setAttribute('aria-expanded', 'true');
    wrap.classList.add('is-open');
    if (isSheet()) document.body.classList.add('gcb-sheet-open');
    setUnread(false);
    try { title.focus(); } catch (e) { /* focus is a nicety */ }
    state.textContent = 'Loading chat…';
    show(state, S.feed === null || S.feed.size() === 0);
    loadDeps().then(function () {
      if (!S.open) return;
      if (!S.rules) Api.rules().then(function (r) { S.rules = r; render(); }, function () { /* the sentences fall back */ });
      render();
      // /me first (only with the hint), so the first page already carries the viewer's own
      // held messages; then the panel's cadence.
      return refreshMe().then(function () { if (S.open && !S.inflight) poll(); });
    }).then(null, function () {
      state.textContent = 'Chat can\'t be loaded right now.';
      show(state, true);
    });
  }

  function close(returnFocus) {
    if (!S.open) return;
    S.open = false;
    sset(K_OPEN, null);
    show(panel, false);
    show(launch, true);
    launch.setAttribute('aria-expanded', 'false');
    wrap.classList.remove('is-open');
    document.body.classList.remove('gcb-sheet-open');
    show(empty, false);
    if (S.feed && S.feed.newest() !== null) setSeen(S.feed.newest());
    if (returnFocus) { try { launch.focus(); } catch (e) { /* nicety */ } }
    schedule();                                       // 60 s with a session, nothing without
  }

  launch.addEventListener('click', open);
  closeBtn.addEventListener('click', function () { close(true); });
  panel.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' || e.key === 'Esc') { e.preventDefault(); close(true); }
  });
  window.addEventListener('resize', function () {
    if (S.open) document.body.classList.toggle('gcb-sheet-open', isSheet());
  });

  // ── Posting ─────────────────────────────────────────────────────────────────────────
  function cp(s) { return Core ? Core.cpLen(s) : s.length; }
  chatInput.addEventListener('input', function () {
    var n = cp(chatInput.value.trim());
    count.textContent = n + ' / 280';
    count.classList.toggle('is-over', n > 280);
  });
  form.addEventListener('submit', function (ev) {
    ev.preventDefault();
    var body = chatInput.value.trim();
    var n = cp(body);
    if (n === 0) return;
    if (n > Core.BODY_MAX) { say(note, 'A message is at most ' + Core.BODY_MAX + ' characters.'); return; }
    send.disabled = true;
    say(note, '');
    Api.post('chat', { body: body }).then(function (r) {
      chatInput.value = '';
      count.textContent = '0 / 280';
      if (r.message) S.feed.upsert(r.message);
      show(empty, false);
      list.scrollTop = list.scrollHeight;
      if (r.held) say(note, 'Sent, and held for review: links, addresses and some words wait for a moderator before others see them.', 'ok');
    }, function (e) {
      if (sessionEnded(e)) return;
      if (e instanceof Api.Error && e.code === 'chat_off') setEnabled(false);
      if (e instanceof Api.Error && e.code === 'chat_refused') refreshMe();
      say(note, Core.errText(e, S.rules));
    }).then(function () { send.disabled = false; });
  });

  // ── Sign in (same routes as /play/) ─────────────────────────────────────────────────
  function setTab(t, focus) {
    S.tab = t === 'guest' ? 'guest' : 'miner';
    sset(K_TAB, S.tab);
    var g = S.tab === 'guest';
    tabMiner.setAttribute('aria-selected', g ? 'false' : 'true');
    tabGuest.setAttribute('aria-selected', g ? 'true' : 'false');
    tabMiner.tabIndex = g ? -1 : 0;
    tabGuest.tabIndex = g ? 0 : -1;
    show(paneMiner, !g);
    show(paneGuest, g);
    if (focus) (g ? tabGuest : tabMiner).focus();
  }
  tabMiner.addEventListener('click', function () { setTab('miner'); });
  tabGuest.addEventListener('click', function () { setTab('guest'); });
  tabs.addEventListener('keydown', function (e) {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); setTab(S.tab === 'guest' ? 'miner' : 'guest', true); }
  });
  setTab(S.tab);

  signinOpen.addEventListener('click', function () {
    var on = forms.hidden;
    show(forms, on);
    signinOpen.setAttribute('aria-expanded', on ? 'true' : 'false');
    signinOpen.textContent = on ? 'Just read' : 'Sign in to post';
    if (on) (S.tab === 'guest' ? gName : mAddr).focus();
  });

  mReveal.addEventListener('click', function () {
    var reveal = mProof.type === 'password';
    mProof.type = reveal ? 'text' : 'password';
    mReveal.textContent = reveal ? 'Hide' : 'Show';
    mReveal.setAttribute('aria-pressed', reveal ? 'true' : 'false');
  });

  function wait(sec) {
    return typeof sec === 'number' && sec > 0 && Core ? Core.duration(sec) : 'a moment';
  }
  // The miner card's sentences on /play/ (play-shell.js), for the same answers.
  var MINER_FIELD_TEXT = {
    address: 'That is not a GRIN address for this pool\'s network.',
    proof: 'Enter a mining IP or your rig password (up to 256 characters).',
    client_ip: 'The games could not see your IP address. Try again in a minute.'
  };
  function signInErr(e, kind) {
    if (!(e instanceof Api.Error)) return 'Something went wrong. Try again.';
    if (e.kind === 'offline') return e.message;
    var b = e.body || {};
    if (e.code === 'login_failed') return typeof b.hint === 'string' ? b.hint
      : (kind === 'guest' ? 'That name and password do not match a guest account.' : 'The pool could not confirm that address with that proof.');
    if (e.status === 429) return typeof b.hint === 'string' ? b.hint : 'Too many sign-in attempts. Try again in ' + wait(b.retry_after) + '.';
    if (e.status === 404) return 'The games are closed right now.';
    if (e.code === 'bad_request' && kind === 'guest' && b.field === 'name') return 'A guest name is letters and digits only.';
    if (e.code === 'bad_request' && kind === 'miner' && MINER_FIELD_TEXT[b.field]) return MINER_FIELD_TEXT[b.field];
    return e.message;                       // banned, pool_unavailable, cross_origin … — the server's own sentence
  }

  function signedIn(me) {
    sset(K_SIGNED, '1');
    // No full address (or sign-in name) left behind in a field once signed in (§19.13 #30).
    mAddr.value = '';
    gName.value = '';
    show(forms, false);
    signinOpen.setAttribute('aria-expanded', 'false');
    signinOpen.textContent = 'Sign in to post';
    setMe(me);
    say(note, 'Signed in.', 'ok');
    if (canPost()) chatInput.focus();
  }

  function runSignIn(path, body, kind, submit, wipe) {
    submit.disabled = true;
    say(note, kind === 'miner' ? 'Checking with the pool…' : 'Signing in…', 'ok');
    loadDeps().then(function () {
      return Api.post(path, body).then(function (r) {
        wipe();
        signedIn(r.me);
      }, function (e) {
        wipe();
        say(note, signInErr(e, kind));
      });
    }, function () { wipe(); say(note, 'Chat can\'t be loaded right now.'); })
      .then(function () { submit.disabled = false; });
  }

  paneMiner.addEventListener('submit', function (ev) {
    ev.preventDefault();
    var address = mAddr.value.trim();
    var proof = mProof.value.trim();
    if (!/^t?grin1[a-z0-9]{58}$/.test(address)) { say(note, MINER_FIELD_TEXT.address); return; }
    if (!proof) { say(note, 'Enter a mining IP or your rig password.'); return; }
    runSignIn('login', { address: address, proof: proof }, 'miner', mSubmit, function () { mProof.value = ''; });
  });
  paneGuest.addEventListener('submit', function (ev) {
    ev.preventDefault();
    var name = gName.value.trim();
    var password = gPass.value;
    if (!name) { say(note, 'Enter your guest name.'); return; }
    if (!/^[A-Za-z0-9]{1,40}$/.test(name)) { say(note, 'A guest name is letters and digits only.'); return; }
    if (!password) { say(note, 'Enter your password.'); return; }
    runSignIn('login/guest', { name: name, password: password }, 'guest', gSubmit, function () { gPass.value = ''; });
  });

  signout.addEventListener('click', function () {
    signout.disabled = true;
    Api.post('logout', {}).then(function () {
      sset(K_SIGNED, null);
      setMe(null);
      say(note, 'You are signed out.', 'ok');
    }, function (e) {
      if (!sessionEnded(e)) say(note, e && e.message ? e.message : 'Something went wrong.');
    }).then(function () { signout.disabled = false; });
  });

  // ── Start ───────────────────────────────────────────────────────────────────────────
  window.GrinChatBubble = Object.freeze({ open: open, close: function () { close(false); } });
  if (sget(K_OPEN) === '1') {
    open();
  } else if (hintOn() && document.visibilityState !== 'hidden') {
    // Closed with a session: check it once, then the 60 s change feed for the unread dot.
    loadDeps().then(function () { return refreshMe(); }).then(function () { if (!S.inflight && wantPoll()) poll(); }, function () { /* no chat scripts: nothing to poll */ });
  }
})();
