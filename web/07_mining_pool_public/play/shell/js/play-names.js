/* play-names.js — the Nickname fold in the account strip (design §19.17.5, Part C3; §19.16 before).
 *
 * It follows play-shell.js's `play:me` (null when signed out) and reads `me.nickname`:
 *   { enabled, live, shown_as, refused: {name, state, reason, at, by} | null,
 *     can_submit, reason, available_at, can_remove, rule, change_days }
 *
 * A name is checked by the server and goes live AT ONCE — there is no review queue. What the page
 * shows is what the SERVER composed: `shown_as` is the mask, or `Nick (mask)`. The page never
 * builds a public name itself, so it cannot show a nickname without its mask.
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
  ['nick-fold', 'nick-state', 'nick-shown', 'nick-refused', 'nick-form', 'nick-input', 'nick-submit',
   'nick-rule', 'nick-rule-text', 'nick-example-miner', 'nick-example-guest', 'nick-cooldown', 'nick-gate', 'nick-remove', 'nick-msg'].forEach(function (id) { EL[id] = $(id); });
  if (!EL['nick-fold']) return;

  var CONFIRM_MS = 5000;
  var S = { nick: null, guest: false };

  // The reasons lib/names.js gives (the chat gate's, minus the chat switch, plus its own).
  var GATE = {
    nicknames_off: 'Nicknames are switched off on this pool right now.',
    nick_blocked: 'The pool has turned nicknames off for your account.',
    muted: 'You are muted, so you cannot change your nickname for now.',
    anchor_proof: 'This sign-in used a proof the pool keeps only as a last resort. Log out and sign in again with a current mining IP or your rig password to set a nickname.',
    password_required: 'Setting a nickname needs a sign-in with your rig PASSWORD on this pool. Log out and sign in with the password.',
    no_recent_mining: 'Nicknames are for the pool\'s active miners: mine a little more first (the same bar as chat).',
    proof_too_new: 'A new sign-in proof has to age first, so someone who only just mined to your address cannot name you.',
    cooldown: 'You changed your nickname recently.',
  };
  function gateText(n) {
    var t = GATE[n.reason] || 'You cannot change your nickname right now.';
    if (n.reason === 'cooldown' && n.available_at) t += ' You can change it again from ' + utc(n.available_at) + '.';
    else if (n.reason === 'proof_too_new' && n.available_at) t = 'You can set a nickname from ' + utc(n.available_at) + '. ' + t;
    return t;
  }
  var ERR = {
    name_invalid: null, name_length: null, name_charset: null, name_no_letter: null, name_address: null,
    // Deliberately vague (§19.17.5): which word, or that a name is banned, is the pool's to know.
    name_not_allowed: 'That nickname isn\'t allowed. Try another.',
    name_unavailable: 'That nickname isn\'t available. Try another.',
    unchanged: 'That is already your nickname.',
    too_many_refusals: 'That is enough tries for today. Try again after midnight UTC.',
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

  var BY = { pool: 'the pool', moderator: 'a moderator', rule: 'the pool (it no longer fits the name rule)' };

  function render(n) {
    S.nick = valid(n) ? n : null;
    show(EL['nick-fold'], !!S.nick);
    if (!S.nick) return;
    n = S.nick;
    var live = typeof n.live === 'string' ? n.live : null;
    text(EL['nick-state'], !n.enabled ? 'off' : live || 'none');
    text(EL['nick-shown'], n.shown_as);
    var r = n.refused && typeof n.refused.name === 'string' ? n.refused : null;
    text(EL['nick-refused'], r ? '“' + r.name + '” was removed by ' + (BY[r.by] || 'the pool') + (r.reason ? ': ' + r.reason : '.') : '');
    show(EL['nick-refused'], !!r && !live);
    // The rule text is the server's (lib/name-rule.js NAME_RULE); the page's copy is the default.
    if (typeof n.rule === 'string' && n.rule) text(EL['nick-rule-text'], n.rule);
    var days = typeof n.change_days === 'number' && n.change_days > 0 ? n.change_days : 0;
    text(EL['nick-cooldown'], days ? 'You can change it once every ' + days + ' day' + (days === 1 ? '' : 's') + '.' : '');
    show(EL['nick-cooldown'], n.enabled === true && days > 0);
    text(EL['nick-submit'], live ? 'Change' : 'Set');
    show(EL['nick-form'], n.can_submit === true);
    show(EL['nick-rule'], n.enabled === true);
    // A guest's name shows as `Nick · guest`, a miner's always with the mask (§19.17.5).
    show(EL['nick-example-miner'], !S.guest);
    show(EL['nick-example-guest'], S.guest);
    text(EL['nick-gate'], n.can_submit ? '' : gateText(n));
    show(EL['nick-gate'], !n.can_submit);
    show(EL['nick-remove'], n.can_remove === true);
  }

  function after(r) {
    if (r && r.nickname) render(r.nickname);
  }

  EL['nick-form'].addEventListener('submit', function (ev) {
    ev.preventDefault();
    var name = EL['nick-input'].value.trim();
    if (!name) { msg(EL['nick-msg'], 'Type the nickname you would like.'); return; }
    EL['nick-submit'].disabled = true;
    msg(EL['nick-msg'], '');
    Api.post('nickname', { name: name }).then(function (r) {
      after(r);
      EL['nick-input'].value = '';
      msg(EL['nick-msg'], 'Done: others now see you as ' + (r && r.nickname ? r.nickname.shown_as : name) + '.', 'ok');
    }, function (e) { msg(EL['nick-msg'], errText(e)); }).then(function () { EL['nick-submit'].disabled = false; });
  });

  // Two-click confirm: removing does not reset the change cooldown.
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
        msg(EL['nick-msg'], 'Removed. Others now see you as ' + (r && r.nickname ? r.nickname.shown_as : (S.guest ? 'your guest tag' : 'your masked address')) + '.', 'ok');
      }, function (e) { msg(EL['nick-msg'], errText(e)); }).then(function () { btn.disabled = false; });
    });
  })();

  document.addEventListener('play:me', function (e) {
    var me = e && e.detail ? e.detail.me : null;
    if (!me) { msg(EL['nick-msg'], ''); S.guest = false; render(null); return; }
    S.guest = me.kind === 'guest';
    render(me.nickname);
  });
})();
