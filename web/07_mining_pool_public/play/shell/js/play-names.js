/* play-names.js — the Nickname fold in the account strip (design §19.16, Part 12).
 *
 * It follows play-shell.js's `play:me` (null when signed out) and reads `me.nickname`:
 *   { enabled, live, shown_as, pending: {name, at} | null, refused: {name, state, reason, at} | null,
 *     can_submit, reason, available_at, rule }
 *
 * What the page shows is what the SERVER composed: `shown_as` is the mask, or `Nick (mask)`.
 * The page never builds a public name itself, so it cannot show a nickname without its mask.
 * The pending name is the caller's own (the session proves it) and is shown only here.
 *
 * Rendering: textContent only — no innerHTML anywhere in this file (test-shell.js fails on
 * one). No native dialog: removing a live nickname is a two-click confirm.
 */
(function () {
  'use strict';

  var Api = window.PlayApi;
  if (!Api) return;

  function $(id) { return document.getElementById(id); }
  function text(el, s) { if (el) el.textContent = s == null ? '' : String(s); }
  function show(el, on) { if (el) el.hidden = !on; }
  function msg(el, s, kind) { if (!el) return; el.textContent = s || ''; el.className = 'acct-msg' + (s ? (kind === 'ok' ? ' ok' : ' err') : ''); }
  function pad(n) { return n < 10 ? '0' + n : String(n); }
  function utc(s) {
    if (typeof s !== 'number' || !isFinite(s)) return '';
    var d = new Date(s * 1000);
    return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()) + ' ' + pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) + ' UTC';
  }

  var EL = {};
  ['nick-fold', 'nick-state', 'nick-shown', 'nick-pending', 'nick-refused', 'nick-form', 'nick-input', 'nick-submit',
   'nick-rule', 'nick-rule-text', 'nick-gate', 'nick-withdraw', 'nick-remove', 'nick-msg'].forEach(function (id) { EL[id] = $(id); });
  if (!EL['nick-fold']) return;

  var CONFIRM_MS = 5000;
  var S = { nick: null };

  // The reasons lib/names.js gives (the chat gate's, minus the chat switch, plus its own).
  var GATE = {
    nicknames_off: 'Nicknames are switched off on this pool right now.',
    muted: 'You are muted, so you cannot change your nickname for now.',
    anchor_proof: 'This sign-in used a proof the pool keeps only as a last resort. Log out and sign in again with a current mining IP or your rig password to set a nickname.',
    password_required: 'Setting a nickname needs a sign-in with your rig PASSWORD on this pool. Log out and sign in with the password.',
    no_recent_mining: 'Nicknames are for the pool\'s active miners: mine a little more first (the same bar as chat).',
    proof_too_new: 'A new sign-in proof has to age first, so someone who only just mined to your address cannot name you.',
  };
  function gateText(n) {
    var t = GATE[n.reason] || 'You cannot change your nickname right now.';
    if (n.reason === 'proof_too_new' && n.available_at) t = 'You can ask for a nickname from ' + utc(n.available_at) + '. ' + t;
    return t;
  }
  var ERR = {
    name_invalid: null, name_length: null, name_charset: null, name_no_letter: null, name_address: null, name_role: null,
    nickname_taken: 'Another player already has that nickname (or one that reads the same). Pick another.',
    unchanged: 'That is already your nickname, or the one waiting for review.',
    too_many_requests: 'That is enough requests for today. Try again tomorrow.',
    nicknames_off: GATE.nicknames_off,
  };
  function errText(e) {
    if (!(e instanceof Api.Error) || e.kind === 'offline') return e && e.message ? e.message : 'The games could not be reached.';
    var b = e.body || {};
    if (Object.prototype.hasOwnProperty.call(ERR, e.code)) return ERR[e.code] || (typeof b.hint === 'string' ? b.hint : e.message);
    if (e.code === 'nickname_refused') return gateText({ reason: b.reason, available_at: b.available_at });
    return e.message;
  }

  function valid(n) {
    return n && typeof n === 'object' && typeof n.enabled === 'boolean' && typeof n.shown_as === 'string';
  }

  function render(n) {
    S.nick = valid(n) ? n : null;
    show(EL['nick-fold'], !!S.nick);
    if (!S.nick) return;
    n = S.nick;
    var pending = n.pending && typeof n.pending.name === 'string' ? n.pending : null;
    var live = typeof n.live === 'string' ? n.live : null;
    text(EL['nick-state'], !n.enabled ? 'off' : live ? live + (pending ? ' (a change is waiting for review)' : '') : pending ? 'waiting for review' : 'none');
    text(EL['nick-shown'], n.shown_as);
    text(EL['nick-pending'], pending ? '“' + pending.name + '” is waiting for the pool\'s review (sent ' + utc(pending.at) + '). Only you can see it until it is approved.' : '');
    show(EL['nick-pending'], !!pending);
    var r = n.refused && typeof n.refused.name === 'string' ? n.refused : null;
    text(EL['nick-refused'], r ? '“' + r.name + '” was ' + (r.state === 'removed' ? 'removed' : 'not approved') + ' by the pool'
      + (r.reason ? ': ' + r.reason : '.') : '');
    show(EL['nick-refused'], !!r && !pending);
    // The rule text is the server's (lib/names.js NAME_RULE); the page's copy is the default.
    if (typeof n.rule === 'string' && n.rule) text(EL['nick-rule-text'], n.rule);
    show(EL['nick-form'], n.can_submit === true);
    show(EL['nick-rule'], n.enabled === true);
    text(EL['nick-gate'], n.can_submit ? '' : gateText(n));
    show(EL['nick-gate'], !n.can_submit);
    show(EL['nick-withdraw'], !!pending && n.can_submit === true);
    show(EL['nick-remove'], !!live && n.can_submit === true);
  }

  function after(r) {
    if (r && r.nickname) render(r.nickname);
  }

  EL['nick-form'].addEventListener('submit', function (ev) {
    ev.preventDefault();
    var name = EL['nick-input'].value.replace(/\s+/g, ' ').trim();
    if (!name) { msg(EL['nick-msg'], 'Type the nickname you would like.'); return; }
    EL['nick-submit'].disabled = true;
    msg(EL['nick-msg'], '');
    Api.post('nickname', { name: name }).then(function (r) {
      after(r);
      EL['nick-input'].value = '';
      msg(EL['nick-msg'], 'Sent. It shows once the pool approves it.', 'ok');
    }, function (e) { msg(EL['nick-msg'], errText(e)); }).then(function () { EL['nick-submit'].disabled = false; });
  });

  EL['nick-withdraw'].addEventListener('click', function () {
    EL['nick-withdraw'].disabled = true;
    Api.post('nickname/withdraw', {}).then(function (r) {
      after(r);
      msg(EL['nick-msg'], 'Request withdrawn.', 'ok');
    }, function (e) { msg(EL['nick-msg'], errText(e)); }).then(function () { EL['nick-withdraw'].disabled = false; });
  });

  // Two-click confirm: a removed nickname needs a new review to come back.
  (function () {
    var btn = EL['nick-remove'], armed = false, timer = null;
    var LABEL = 'Remove my nickname', CONFIRM = 'Confirm: remove it';
    function disarm() { armed = false; btn.textContent = LABEL; btn.classList.remove('play-armed'); if (timer) { clearTimeout(timer); timer = null; } }
    btn.addEventListener('click', function () {
      if (!armed) { armed = true; btn.textContent = CONFIRM; btn.classList.add('play-armed'); timer = setTimeout(disarm, CONFIRM_MS); return; }
      disarm();
      btn.disabled = true;
      Api.post('nickname/remove', {}).then(function (r) {
        after(r);
        msg(EL['nick-msg'], 'Removed. Others see your masked address again.', 'ok');
      }, function (e) { msg(EL['nick-msg'], errText(e)); }).then(function () { btn.disabled = false; });
    });
  })();

  document.addEventListener('play:me', function (e) {
    var me = e && e.detail ? e.detail.me : null;
    if (!me) { msg(EL['nick-msg'], ''); render(null); return; }
    render(me.nickname);
  });
})();
