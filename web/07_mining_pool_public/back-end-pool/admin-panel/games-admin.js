/* games-admin.js — shared by the admin panel's games pages: games.html, games-chat.html,
 * games-players.html, games-names.html (design §19.10, §19.11, §19.16, D11, D21; games Parts 9, 12). games-events.html
 * (Part 7) predates it and carries its own copy of call().
 *
 * Two rules every games page follows, and the reason this file exists:
 *
 *   1. Proxied calls go through call() → adminFetch('/api/admin/games/' + rel), NEVER API.*.
 *      Auth.fetch sends the admin to the login page on ANY 401, and the pool's proxy passes the
 *      games service's own 401 (a link-secret mismatch) through. A games answer always carries
 *      `ok`; the pool's own 401 (session over) never does — that is how the two are told apart.
 *      adminFetch (stepup.js) shows the in-page password dialog when the POOL asks for step-up;
 *      which writes need it is the pool's rule (lib/games-link.js FAST_WRITES), not ours.
 *
 *   2. Player- and moderator-written text — chat bodies, report reasons, the reasons in the mod
 *      log — reaches the DOM through textContent ONLY (§19.10: "never innerHTML, in the shell and
 *      the admin pages alike"). el() below is the builder; this file has no HTML sink at all, and
 *      the pages build those rows with it rather than through an HTML-string table.
 */
(function () {
  'use strict';

  var ADDR_RE = /^t?grin1[ac-hj-np-z02-9]{58}$/;

  var ERROR_TEXT = {
    games_offline: 'The games service is not answering. Mining is unaffected; check the service under P) Play & chat in the Script 07 pool menu.',
    link_not_configured: 'The games link is not set up. Install or repair the games from P) Play & chat in the Script 07 pool menu.',
    unauthorised: 'The pool and the games service disagree on the link secret. Rotate it from P) Play & chat → 7 in the Script 07 pool menu.',
    games_bad_response: 'The games service sent an unreadable answer.',
    step_up_required: 'This action needs your admin password again.',
    no_plays: 'That would take the plays below zero.',
    no_points: 'That would take the points below zero.',
    banned: 'That address is banned.',
    too_many_moderators: 'The moderator list is full (50). Remove one first.',
    nickname_taken: 'Another player already has a nickname that reads the same.',
    not_pending: 'That request was already decided — refresh the list.',
    not_live: 'That nickname is no longer live — refresh the list.',
  };
  var FIELD_TEXT = {
    address: 'That is not a GRIN address on this pool\'s network.',
    minutes: 'Minutes (1 to 43 200 — 30 days)',
    days: 'Days',
    forever: 'Forever',
    reason: 'Reason (up to 200 characters of text)',
    note: 'Note (up to 200 characters of text)',
    body: 'Message (1 to 280 characters of text)',
    kind: 'Kind', delta: 'Amount (a whole number, not 0, at most 1 000 000 either way)',
    add: 'Words to add (1–40 characters each, at most 500 words in the list)', remove: 'Words to remove',
    values: 'Settings', state: 'State', before: 'Paging', limit: 'Page size', filter: 'Filter',
  };

  async function call(method, rel, body) {
    var opts = { method: method, credentials: 'include', headers: { Accept: 'application/json' } };
    if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    var res = await adminFetch('/api/admin/games/' + rel, opts);
    var data = null;
    try { data = await res.json(); } catch (e) { /* not JSON */ }
    if (res.status === 401 && !(data && data.ok === false)) {
      window.location.href = '/login.html';
      throw new Error('Your admin session has ended.');
    }
    if (res.ok && data && data.ok === true) return data;
    var code = data && data.error;
    var msg = ERROR_TEXT[code] || (data && (data.message || data.error)) || ('HTTP ' + res.status);
    if (code === 'bad_request' && data.field) msg = 'Check: ' + (FIELD_TEXT[data.field] || String(data.field).replace(/_/g, ' '));
    var err = new Error(msg);
    err.code = code;
    err.status = res.status;
    err.data = data;
    throw err;
  }

  // el('td', 'mono', text) — a new element; text (if given) set with textContent.
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = String(text);
    return e;
  }
  function clear(node) { while (node && node.firstChild) node.removeChild(node.firstChild); }

  function pad(n) { return n < 10 ? '0' + n : String(n); }
  function fmtUtc(s) {
    if (typeof s !== 'number' || !isFinite(s)) return '—';
    var d = new Date(s * 1000);
    return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()) + ' ' + pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) + ' UTC';
  }
  function short(a) { return typeof a === 'string' && a.length > 16 ? a.slice(0, 9) + '…' + a.slice(-4) : String(a || ''); }

  // A full address as the panel's click-to-copy chip (admin-shell.js handles [data-copy]).
  function addrChip(a) {
    var b = el('button', 'addr-copy', short(a));
    b.type = 'button';
    b.setAttribute('data-copy', a);
    b.setAttribute('data-tip', a + '\nClick to copy');
    b.setAttribute('aria-label', 'Copy address ' + a);
    return b;
  }
  // A link to the Players page for one address. The address goes through encodeURIComponent
  // into a query string on our own page — never into script.
  function playerLink(a, label) {
    var l = el('a', null, label || 'Player →');
    l.href = 'games-players.html?address=' + encodeURIComponent(a);
    return l;
  }
  function btn(label, cls, onClick) {
    var b = el('button', 'btn btn-sm ' + (cls || 'btn-secondary'), label);
    b.type = 'button';
    if (onClick) b.addEventListener('click', function () {
      b.disabled = true;
      Promise.resolve(onClick()).then(function () { b.disabled = false; }, function () { b.disabled = false; });
    });
    return b;
  }

  function flash(id, msg, isErr) {
    var e = document.getElementById(id);
    if (!e) return;
    e.textContent = msg || '';
    e.className = isErr ? 'error-msg' : 'success-msg';
    e.style.display = msg ? '' : 'none';
    if (msg) setTimeout(function () { if (e.textContent === msg) e.style.display = 'none'; }, isErr ? 12000 : 6000);
  }

  // The in-page confirm dialog (the page carries #confirm-dialog, as games-events.html does).
  // → Promise<{ reason } | null>. The title and body are set with textContent.
  function askConfirm(o) {
    var ov = document.getElementById('confirm-dialog');
    var form = document.getElementById('confirm-form');
    var input = document.getElementById('confirm-reason');
    var submit = document.getElementById('confirm-submit');
    var cancel = document.getElementById('confirm-cancel');
    document.getElementById('confirm-title').textContent = o.title;
    document.getElementById('confirm-body').textContent = o.body;
    document.getElementById('confirm-reason-group').style.display = o.withReason ? '' : 'none';
    submit.textContent = o.confirmText || 'Confirm';
    submit.className = o.danger ? 'btn btn-danger' : 'btn';
    input.value = '';
    return new Promise(function (resolve) {
      function done(v) {
        ov.classList.remove('open');
        form.removeEventListener('submit', onSubmit);
        cancel.removeEventListener('click', onCancel);
        ov.removeEventListener('click', onBackdrop);
        document.removeEventListener('keydown', onKey);
        resolve(v);
      }
      function onSubmit(e) { e.preventDefault(); done({ reason: input.value.trim() }); }
      function onCancel() { done(null); }
      function onBackdrop(e) { if (e.target === ov) done(null); }
      function onKey(e) { if (e.key === 'Escape') done(null); }
      form.addEventListener('submit', onSubmit);
      cancel.addEventListener('click', onCancel);
      ov.addEventListener('click', onBackdrop);
      document.addEventListener('keydown', onKey);
      ov.classList.add('open');
      (o.withReason ? input : submit).focus();
    });
  }

  // Who did it, for the mod log: an admin name, or "Moderator grin1abcd…wxyz" (D21).
  function actorNode(actor) {
    if (typeof actor === 'string' && actor.indexOf('mod:') === 0 && ADDR_RE.test(actor.slice(4))) {
      var span = el('span');
      span.appendChild(el('span', 'badge badge-warn', 'Moderator'));
      span.appendChild(document.createTextNode(' '));
      span.appendChild(addrChip(actor.slice(4)));
      return span;
    }
    return el('span', null, actor);
  }

  window.GamesAdmin = Object.freeze({
    call: call, el: el, clear: clear, fmtUtc: fmtUtc, short: short, addrChip: addrChip, playerLink: playerLink,
    btn: btn, flash: flash, askConfirm: askConfirm, actorNode: actorNode, ADDR_RE: ADDR_RE,
  });
})();
