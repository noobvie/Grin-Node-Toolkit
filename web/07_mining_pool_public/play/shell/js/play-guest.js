/* play-guest.js — guest accounts on /play/ (design §19.17.3/§19.17.4, Part C6).
 *
 * Owns the sign-in card's two tabs (Miner · Guest), the guest sign-in form, the sign-up form
 * (inside the Guest tab; /play/#signup opens it), the guest lines of the "How tickets are earned"
 * fold, and the Guest account box (change password, delete). The miner form stays
 * play-shell.js's. It talks to the shell only through DOM events, as the other panels do:
 *   in   play:view       { view }      'login' clears every password here and honours #signup
 *   in   play:me         { me }        a guest's /me fills the account box; null clears it
 *   out  play:signed-in  { me, note }  a guest signed in or signed up — the shell takes over
 *   out  play:signed-out { note, kind } the account was deleted ('ok'), or the session ended
 *
 * Sign-up order (the server's, §19.17.3): the name's SHAPE is checked here first, because the
 * proof-of-work is spent the moment the server verifies it — a name refused after that costs a
 * new one. Then GET signup/challenge → PlayPow.solve → POST signup. Every refusal code maps to
 * one plain sentence; a list hit says only "isn't allowed" / "isn't available" (the server
 * says no more than that either).
 *
 * Rendering: textContent only — no innerHTML anywhere in this file (test-shell.js fails on
 * one). No native dialog: delete is a typed confirmation. Passwords go in JSON bodies only and
 * are wiped from the inputs after every attempt.
 */
(function () {
  'use strict';

  var Api = window.PlayApi;
  var Pow = window.PlayPow;
  if (!Api) return;

  function $(id) { return document.getElementById(id); }
  function text(el, s) { if (el) el.textContent = s == null ? '' : String(s); }
  function show(el, on) { if (el) el.hidden = !on; }
  function msg(el, s, kind) { if (!el) return; el.textContent = s || ''; el.className = 'acct-msg' + (s ? (kind === 'ok' ? ' ok' : ' err') : ''); }
  function int(n) { return typeof n === 'number' && isFinite(n) ? String(Math.trunc(n)) : '—'; }
  function cpLen(s) { var n = 0; for (var _ of s) n++; return n; }   // code points, as the server counts
  function pad(n) { return n < 10 ? '0' + n : String(n); }
  function utcDate(s) {
    if (typeof s !== 'number' || !isFinite(s)) return '';
    var d = new Date(s * 1000);
    return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
  }
  function wait(sec) {
    if (!(sec > 0)) return 'a moment';
    if (sec < 90) return int(sec) + ' seconds';
    if (sec < 5400) return int(Math.round(sec / 60)) + ' minutes';
    return int(Math.round(sec / 3600)) + ' hours';
  }
  function span(sec) {   // a setting's length, said the way a person would
    if (sec % 86400 === 0) { var d = sec / 86400; return d + (d === 1 ? ' day' : ' days'); }
    if (sec % 3600 === 0) { var h = sec / 3600; return h + (h === 1 ? ' hour' : ' hours'); }
    return Math.round(sec / 60) + ' minutes';
  }
  function emit(name, detail) {
    try { document.dispatchEvent(new CustomEvent(name, { detail: detail || {} })); } catch (e) { /* nobody listening */ }
  }

  var EL = {};
  ['play-login', 'login-tab-miner', 'login-tab-guest', 'login-pane-miner', 'login-pane-guest', 'miner-signup-offer', 'miner-to-signup',
   'guest-login-form', 'guest-name', 'guest-password', 'guest-reveal', 'guest-submit', 'guest-msg', 'guest-signup-offer', 'guest-to-signup',
   'signup-form', 'signup-tickets', 'signup-name', 'signup-name-hint', 'signup-password', 'signup-password2', 'signup-reveal',
   'signup-submit', 'signup-back', 'signup-progress', 'signup-msg', 'signup-closed',
   'guest-fold', 'guest-login-name', 'guest-created', 'pw-form', 'pw-current', 'pw-next', 'pw-next2', 'pw-submit', 'pw-msg',
   'del-form', 'del-password', 'del-confirm', 'del-submit', 'del-msg',
   'rule-guest', 'rule-guest-idle', 'rule-guest-chat'].forEach(function (id) { EL[id] = $(id); });
  if (!EL['play-login'] || !EL['signup-form']) return;

  var TAB_KEY = 'grin_play_login_tab';   // per-viewer convenience only; every access in try/catch
  var PASSWORD_MIN = 10, PASSWORD_MAX = 128;
  var DEFAULT_NAME_HINT = EL['signup-name-hint'].textContent;

  var S = {
    me: null,
    tab: 'miner',
    signup: false,         // the Guest tab shows the sign-up form instead of sign-in
    signupOpen: true,      // GET rules → guests.signup_enabled
    daily: null,           // GET rules → guests.daily_tickets
    run: 0,                // bumped to cancel a sign-up in progress
    busy: false
  };

  // ── Tabs (Miner · Guest) ────────────────────────────────────────────────────────────
  function remember(tab) { try { localStorage.setItem(TAB_KEY, tab); } catch (e) { /* storage off: no memory, no harm */ } }
  function remembered() { try { var v = localStorage.getItem(TAB_KEY); return v === 'guest' ? 'guest' : 'miner'; } catch (e) { return 'miner'; } }

  function selectTab(tab, focus) {
    var guest = tab === 'guest';
    if (S.tab !== tab) cancelSignup();
    S.tab = guest ? 'guest' : 'miner';
    EL['login-tab-miner'].setAttribute('aria-selected', guest ? 'false' : 'true');
    EL['login-tab-guest'].setAttribute('aria-selected', guest ? 'true' : 'false');
    EL['login-tab-miner'].tabIndex = guest ? -1 : 0;
    EL['login-tab-guest'].tabIndex = guest ? 0 : -1;
    show(EL['login-pane-miner'], !guest);
    show(EL['login-pane-guest'], guest);
    if (focus) (guest ? EL['login-tab-guest'] : EL['login-tab-miner']).focus();
    remember(S.tab);
  }
  EL['login-tab-miner'].addEventListener('click', function () { selectTab('miner'); });
  EL['login-tab-guest'].addEventListener('click', function () { selectTab('guest'); });
  [EL['login-tab-miner'], EL['login-tab-guest']].forEach(function (b) {
    b.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Home' || e.key === 'End') {
        e.preventDefault();
        var to = e.key === 'Home' ? 'miner' : e.key === 'End' ? 'guest' : (S.tab === 'miner' ? 'guest' : 'miner');
        selectTab(to, true);
      }
    });
  });

  // ── Sign-in ⇄ sign-up inside the Guest tab ──────────────────────────────────────────
  function setHash(on) {
    try { history.replaceState(null, '', on ? '#signup' : location.pathname + location.search); } catch (e) { /* the URL just stays */ }
  }
  function renderSignupState() {
    var form = S.signup && S.signupOpen;
    show(EL['signup-form'], form);
    show(EL['signup-closed'], S.signup && !S.signupOpen);
    show(EL['guest-login-form'], !S.signup);
    show(EL['guest-signup-offer'], S.signupOpen);
    show(EL['miner-signup-offer'], S.signupOpen);
  }
  function showSignup(on, focus) {
    if (!on) cancelSignup();
    S.signup = !!on;
    renderSignupState();
    if (focus) (on ? (S.signupOpen ? EL['signup-name'] : EL['login-tab-guest']) : EL['guest-name']).focus();
  }
  function openSignup() {
    selectTab('guest');
    showSignup(true, true);
    setHash(true);
  }
  EL['miner-to-signup'].addEventListener('click', openSignup);
  EL['guest-to-signup'].addEventListener('click', openSignup);
  EL['signup-back'].addEventListener('click', function () {
    showSignup(false, true);
    setHash(false);
    msg(EL['signup-msg'], '');
  });

  // /play/#signup (the C7 chat bubble links here): open the sign-up form when signed out.
  function fromHash() {
    if (location.hash === '#signup' && !S.me) { selectTab('guest'); showSignup(true); }
  }
  window.addEventListener('hashchange', fromHash);

  function reveal(btn, inputs) {
    btn.addEventListener('click', function () {
      var on = inputs[0].type === 'password';
      inputs.forEach(function (i) { i.type = on ? 'text' : 'password'; });
      btn.textContent = on ? 'Hide' : 'Show';
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }
  reveal(EL['guest-reveal'], [EL['guest-password']]);
  reveal(EL['signup-reveal'], [EL['signup-password'], EL['signup-password2']]);

  // ── Guest sign-in ───────────────────────────────────────────────────────────────────
  function loginErr(e) {
    if (!(e instanceof Api.Error)) return 'Something went wrong. Try again.';
    if (e.kind === 'offline') return e.message;
    var b = e.body || {};
    if (e.code === 'login_failed') return typeof b.hint === 'string' ? b.hint : 'That name and password do not match a guest account.';
    if (e.status === 429) return 'Too many sign-in attempts. Try again in ' + wait(b.retry_after) + '.';
    if (e.code === 'banned') return 'This guest account is banned from the games.';
    if (e.code === 'bad_request' && b.field === 'name') return 'A guest name is letters and digits only.';
    if (e.status === 404) return 'The games are closed right now.';
    return e.message;
  }

  EL['guest-login-form'].addEventListener('submit', function (ev) {
    ev.preventDefault();
    var name = EL['guest-name'].value.trim();
    var password = EL['guest-password'].value;
    if (!name) { msg(EL['guest-msg'], 'Enter your guest name.'); return; }
    if (!/^[A-Za-z0-9]{1,40}$/.test(name)) { msg(EL['guest-msg'], 'A guest name is letters and digits only.'); return; }
    if (!password) { msg(EL['guest-msg'], 'Enter your password.'); return; }
    EL['guest-submit'].disabled = true;
    msg(EL['guest-msg'], 'Signing in…', 'ok');
    Api.post('login/guest', { name: name, password: password }).then(function (r) {
      EL['guest-password'].value = '';
      msg(EL['guest-msg'], '');
      emit('play:signed-in', { me: r.me, note: '' });
    }, function (e) {
      EL['guest-password'].value = '';
      msg(EL['guest-msg'], loginErr(e));
    }).then(function () { EL['guest-submit'].disabled = false; });
  });

  // ── Sign-up ─────────────────────────────────────────────────────────────────────────
  // The SHAPE only (lib/name-rule.js checkShape + the address test). Whether the name is
  // allowed and free is the server's to say, after the proof-of-work.
  var NAME_TEXT = {
    length: 'Use 3 to 20 characters.',
    charset: 'Letters A–Z and digits 0–9 only — no spaces, accents or symbols.',
    no_letter: 'Use at least one letter.',
    address: 'A name cannot look like a GRIN address.'
  };
  function nameProblem(n) {
    if (n.length < 3 || n.length > 20) return 'length';
    if (!/^[A-Za-z0-9]+$/.test(n)) return 'charset';
    if (!/[A-Za-z]/.test(n)) return 'no_letter';
    if (/^t?grin1/i.test(n)) return 'address';
    return null;
  }
  function nameHint() {
    var hint = EL['signup-name-hint'];
    var n = EL['signup-name'].value.trim();
    hint.classList.remove('is-ok', 'is-err');
    if (!n) { text(hint, DEFAULT_NAME_HINT); return; }
    var p = nameProblem(n);
    if (p) { text(hint, NAME_TEXT[p]); hint.classList.add('is-err'); return; }
    text(hint, 'Looks good. When you create the account, the pool checks that nobody has it and that it is allowed.');
    hint.classList.add('is-ok');
  }
  EL['signup-name'].addEventListener('input', nameHint);

  function passwordProblem(pw, again, name) {
    var n = cpLen(pw);
    if (n < PASSWORD_MIN) return 'Use at least ' + PASSWORD_MIN + ' characters for the password.';
    if (n > PASSWORD_MAX) return 'Use at most ' + PASSWORD_MAX + ' characters for the password.';
    if (again !== null && pw !== again) return 'The two passwords are not the same.';
    if (name && pw.toLowerCase() === name.toLowerCase()) return 'Your password cannot be your name.';
    return null;
  }

  var POW_TEXT = {
    expired: 'The check that you\'re not a bot took too long and expired. Press Create account to try again.',
    ip_changed: 'Your network changed during the check (a VPN, or a phone switching between Wi-Fi and mobile data). Press Create account to try again.',
    invalid: 'The check that you\'re not a bot didn\'t go through. Press Create account to try again.'
  };
  function signupErr(e) {
    if (e instanceof Api.Error) {
      if (e.kind === 'offline') return e.message;
      var b = e.body || {};
      switch (e.code) {
        case 'signup_closed':
          S.signupOpen = false;
          renderSignupState();
          return '';
        case 'pow_failed': return POW_TEXT[b.reason] || POW_TEXT.invalid;
        case 'too_many_requests':
          return b.reason === 'signup_limit'
            ? 'Your network has made the most guest accounts allowed for one day. Try again in ' + wait(b.retry_after) + '.'
            : 'Too many tries from here. Try again in ' + wait(b.retry_after) + '.';
        case 'busy': return 'The games are busy right now. Try again in a moment.';
        case 'name_not_allowed': return 'That name isn\'t allowed. Try another.';
        case 'name_unavailable': return 'That name isn\'t available. Try another.';
        case 'password_weak': return typeof b.hint === 'string' ? b.hint : 'Choose a longer, less common password.';
        case 'not_found': return 'The games are closed right now.';
        case 'bad_request':
          if (b.field === 'name') return NAME_TEXT.charset;
          if (b.field === 'password') return 'Use ' + PASSWORD_MIN + ' to ' + PASSWORD_MAX + ' characters for the password.';
          if (b.field === 'client_ip') return 'The games could not see your network address. Try again in a minute.';
          return POW_TEXT.invalid;
      }
      if (/^name_/.test(e.code) && typeof b.hint === 'string') return b.hint;
      return e.message;
    }
    if (Pow && e instanceof Pow.Error && e.code === 'cancelled') return '';
    return 'The check that you\'re not a bot could not run in this browser. Try another browser.';
  }

  function progress(s) { text(EL['signup-progress'], s); show(EL['signup-progress'], !!s); }
  function cancelSignup() {
    S.run++;
    if (S.busy) { S.busy = false; EL['signup-submit'].disabled = false; progress(''); }
  }

  EL['signup-form'].addEventListener('submit', function (ev) {
    ev.preventDefault();
    if (S.busy) return;
    var name = EL['signup-name'].value.trim();
    var pw = EL['signup-password'].value;
    var pw2 = EL['signup-password2'].value;
    var np = name ? nameProblem(name) : 'length';
    if (np) { msg(EL['signup-msg'], name ? NAME_TEXT[np] : 'Choose a name first.'); EL['signup-name'].focus(); return; }
    var pp = passwordProblem(pw, pw2, name);
    if (pp) { msg(EL['signup-msg'], pp); EL['signup-password'].focus(); return; }
    if (!Pow) { msg(EL['signup-msg'], signupErr(null)); return; }
    var run = ++S.run;
    var live = function () { return run === S.run; };
    S.busy = true;
    EL['signup-submit'].disabled = true;
    msg(EL['signup-msg'], '');
    progress('Checking you\'re not a bot — this takes a few seconds…');
    var challenge = null;
    // A fresh challenge for every attempt: the server spends one the moment it checks it.
    Api.get('signup/challenge').then(function (c) {
      if (!c || typeof c.challenge !== 'string' || typeof c.bits !== 'number') throw new Api.Error('http', 0, 'pow_failed', '', { reason: 'invalid' });
      challenge = c.challenge;
      return Pow.solve(c.challenge, c.bits, {
        cancelled: function () { return !live(); },
        onProgress: function (tries, ms) {
          if (live() && ms >= 2000) progress('Checking you\'re not a bot — this takes a few seconds… ' + int(ms / 1000) + ' s');
        }
      });
    }).then(function (nonce) {
      if (!live()) throw new Pow.Error('cancelled', '');
      progress('Creating your account…');
      return Api.post('signup', { name: name, password: pw, challenge: challenge, nonce: nonce });
    }).then(function (r) {
      if (!live()) return;
      EL['signup-name'].value = '';
      nameHint();
      setHash(false);
      showSignup(false);
      var daily = S.daily !== null ? S.daily : null;
      emit('play:signed-in', {
        me: r.me,
        note: 'Welcome, ' + name + '! Your guest account is ready' +
          (daily ? ', with ' + int(daily) + (daily === 1 ? ' ticket' : ' tickets') + ' to play today' : '') +
          '. Keep your password safe: it cannot be reset.'
      });
    }, function (e) {
      if (!live()) return;
      msg(EL['signup-msg'], signupErr(e));
    }).then(function () {
      EL['signup-password'].value = '';
      EL['signup-password2'].value = '';
      if (!live()) return;
      S.busy = false;
      EL['signup-submit'].disabled = false;
      progress('');
    });
  });

  // ── The live rules: the sign-up switch + the guest lines of the fold ─────────────────
  function applyRules(r) {
    var g = r && r.guests;
    if (!g || typeof g !== 'object') return;
    if (typeof g.signup_enabled === 'boolean') { S.signupOpen = g.signup_enabled; renderSignupState(); }
    if (typeof g.daily_tickets === 'number') {
      var n = g.daily_tickets;
      S.daily = n;
      text(EL['signup-tickets'], n > 0 ? 'You get ' + int(n) + (n === 1 ? ' ticket' : ' tickets') + ' to play with every day.' : 'Right now guest accounts get no daily tickets.');
      text(EL['rule-guest'], (n > 0
        ? 'A guest has ' + int(n) + (n === 1 ? ' ticket' : ' tickets') + ' every UTC day: at 00:00 UTC the count goes back to ' + int(n) + ', so unused tickets are not saved up.'
        : 'Right now guest accounts get no daily tickets.') +
        (g.signup_enabled === false ? ' New guest accounts are closed right now.' : ''));
    }
    if (typeof g.idle_days === 'number') {
      text(EL['rule-guest-idle'], 'A guest account nobody signs in to for ' + int(g.idle_days) + ' days is deleted.');
    }
    if (typeof g.chat_enabled === 'boolean') {
      text(EL['rule-guest-chat'], !g.chat_enabled
        ? 'Guests can read the chat but not post in it right now.'
        : 'Guests can post once their account is ' + (typeof g.chat_min_age_s === 'number' ? span(g.chat_min_age_s) : 'a day') + ' old' +
          (typeof g.chat_min_interval_s === 'number' && typeof g.chat_posts_per_hour === 'number'
            ? ', at most one message every ' + int(g.chat_min_interval_s) + ' seconds and ' + int(g.chat_posts_per_hour) + ' an hour'
            : '') + ', and a guest\'s message with a link always waits for a moderator.');
    }
  }
  Api.rules().then(applyRules, function () { /* the defaults stay in the page */ });

  // ── The Guest account box (signed-in guests) ─────────────────────────────────────────
  function accountErr(e) {
    if (!(e instanceof Api.Error)) return 'Something went wrong. Try again.';
    if (e.kind === 'offline') return e.message;
    var b = e.body || {};
    if (e.code === 'wrong_password') return 'That is not your current password.';
    if (e.status === 429) return 'Too many wrong passwords. Try again in ' + wait(b.retry_after) + '.';
    if (e.code === 'password_weak') return typeof b.hint === 'string' ? b.hint : 'Choose a longer, less common password.';
    if (e.code === 'conflict') return 'Your password was just changed from another device. Reload the page and try again.';
    if (e.code === 'busy') return 'The games are busy right now. Try again in a moment.';
    return e.message;
  }
  // A 401 here means the session itself is gone (a password change elsewhere, a ban, expiry).
  function sessionGone(e) {
    return e instanceof Api.Error && (e.code === 'unauthorised' || e.code === 'not_guest' || e.code === 'banned');
  }
  function clearAccountForms() {
    ['pw-current', 'pw-next', 'pw-next2', 'del-password', 'del-confirm'].forEach(function (id) { EL[id].value = ''; });
    EL['del-submit'].disabled = true;
  }

  function renderAccount(me) {
    var g = me && me.kind === 'guest' && me.guest && typeof me.guest.login_name === 'string' ? me.guest : null;
    show(EL['guest-fold'], !!g);
    if (!g) { clearAccountForms(); msg(EL['pw-msg'], ''); msg(EL['del-msg'], ''); return; }
    text(EL['guest-login-name'], g.login_name);
    text(EL['guest-created'], typeof g.created_at === 'number' ? '· account made ' + utcDate(g.created_at) + ' UTC' : '');
  }

  EL['pw-form'].addEventListener('submit', function (ev) {
    ev.preventDefault();
    var current = EL['pw-current'].value;
    var next = EL['pw-next'].value;
    if (!current) { msg(EL['pw-msg'], 'Enter your current password.'); return; }
    var pp = passwordProblem(next, EL['pw-next2'].value, S.me && S.me.guest ? S.me.guest.login_name : '');
    if (pp) { msg(EL['pw-msg'], pp); return; }
    if (next === current) { msg(EL['pw-msg'], 'The new password is the same as the current one.'); return; }
    EL['pw-submit'].disabled = true;
    msg(EL['pw-msg'], 'Changing…', 'ok');
    Api.post('account/password', { current: current, next: next }).then(function (r) {
      var n = typeof r.revoked === 'number' ? r.revoked : 0;
      msg(EL['pw-msg'], 'Password changed.' + (n > 0 ? ' Signed out on ' + int(n) + ' other device' + (n === 1 ? '' : 's') + '.' : ''), 'ok');
    }, function (e) {
      if (sessionGone(e)) { emit('play:signed-out', { note: 'Your session has ended. Sign in again.' }); return; }
      msg(EL['pw-msg'], accountErr(e));
    }).then(function () {
      ['pw-current', 'pw-next', 'pw-next2'].forEach(function (id) { EL[id].value = ''; });
      EL['pw-submit'].disabled = false;
    });
  });

  function confirmTyped() { return EL['del-confirm'].value.trim().toUpperCase() === 'DELETE'; }
  EL['del-confirm'].addEventListener('input', function () { EL['del-submit'].disabled = !confirmTyped(); });
  EL['del-form'].addEventListener('submit', function (ev) {
    ev.preventDefault();
    if (!confirmTyped()) { msg(EL['del-msg'], 'Type DELETE to confirm.'); return; }
    var password = EL['del-password'].value;
    if (!password) { msg(EL['del-msg'], 'Enter your password.'); return; }
    EL['del-submit'].disabled = true;
    msg(EL['del-msg'], 'Deleting…', 'ok');
    Api.post('account/delete', { password: password, confirm: 'DELETE' }).then(function () {
      clearAccountForms();
      emit('play:signed-out', { note: 'Your guest account is deleted. Thanks for playing.', kind: 'ok' });
    }, function (e) {
      EL['del-password'].value = '';
      EL['del-submit'].disabled = !confirmTyped();
      if (sessionGone(e)) { emit('play:signed-out', { note: 'Your session has ended. Sign in again.' }); return; }
      msg(EL['del-msg'], accountErr(e));
    });
  });

  // ── Page state (from play-shell.js) ─────────────────────────────────────────────────
  function clearLoginPasswords() {
    EL['guest-password'].value = '';
    EL['signup-password'].value = '';
    EL['signup-password2'].value = '';
  }
  document.addEventListener('play:view', function (e) {
    var view = e && e.detail ? e.detail.view : null;
    clearLoginPasswords();
    if (view !== 'login') { cancelSignup(); return; }
    fromHash();
  });
  document.addEventListener('play:me', function (e) {
    var me = e && e.detail ? e.detail.me : null;
    S.me = me && typeof me === 'object' ? me : null;
    renderAccount(S.me);
  });

  selectTab(location.hash === '#signup' ? 'guest' : remembered());
  renderSignupState();
})();
