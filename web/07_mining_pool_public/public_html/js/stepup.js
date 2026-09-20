// stepup.js — step-up (re-authentication) helper for admin-panel money/destructive actions.
//
// Money/destructive admin endpoints are gated server-side by `freshAdmin` (requireFreshAuth):
// a valid session is not enough — the admin must have re-entered their password within the
// last few minutes. When such an endpoint is hit without a fresh session it returns
// 403 { challenge_required: true }. adminFetch() transparently handles that: ask for the
// password → POST /api/admin/reauth → retry the original request once.
//
// The password is asked for in an IN-PAGE dialog, never window.prompt(). Two reasons, both
// from the first live use (design §13.12r):
//   · Browsers throttle native dialogs. The step-up asks right after the action's own
//     confirm() and from an async continuation (the 403 has to arrive first) — exactly the
//     "successive dialogs without a click" pattern Firefox and Chrome guard against. The
//     prompt can come back null WITHOUT ever being shown, and the page cannot tell that from
//     a Cancel: an operator was told "the prompt was closed" about a prompt that never opened.
//   · window.prompt() echoes what is typed. An admin password belongs in a masked field.
// The dialog reuses the panel's .modal-overlay/.modal rules (pool.css, loaded by every admin
// page) and is built lazily, once, on first use — no page has to carry markup for it.
//
// Drop-in replacement for fetch() in admin pages: `const r = await adminFetch(url, opts);`
(function () {
  'use strict';

  async function post(body) {
    var r = await fetch('/api/admin/reauth', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    var data = null;
    try { data = await r.json(); } catch (e) { /* not json */ }
    return { ok: r.ok, data: data || {} };
  }

  // ── In-page authorization dialog ─────────────────────────────────────────────
  var ui = null;

  function build() {
    var overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.id = 'stepup-dialog';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', 'stepup-title');
    // Static markup only. Everything that comes from the server or the operator is written
    // with textContent further down, never interpolated into this string.
    overlay.innerHTML =
      '<form class="modal" id="stepup-form" novalidate>' +
        '<h3 id="stepup-title">Authorize this action</h3>' +
        '<p class="helper-text dim" id="stepup-body" style="margin:0 0 1rem;"></p>' +
        '<div class="form-group" id="stepup-password-group">' +
          '<label for="stepup-password">Admin password</label>' +
          '<input type="password" id="stepup-password" autocomplete="current-password" autocapitalize="off" spellcheck="false">' +
        '</div>' +
        '<div class="form-group" id="stepup-code-group" style="display:none;">' +
          '<label for="stepup-code">Authenticator code (or a recovery code)</label>' +
          '<input type="text" id="stepup-code" inputmode="numeric" autocomplete="one-time-code" autocapitalize="off" spellcheck="false">' +
        '</div>' +
        '<p class="error-msg" id="stepup-error" style="display:none;margin:.2rem 0 0;"></p>' +
        '<div class="modal-actions">' +
          '<button type="button" class="btn btn-outline" id="stepup-cancel">Cancel</button>' +
          '<button type="submit" class="btn" id="stepup-submit">Authorize</button>' +
        '</div>' +
      '</form>';
    document.body.appendChild(overlay);
    var q = function (id) { return overlay.querySelector('#' + id); };
    ui = {
      overlay: overlay, form: q('stepup-form'), body: q('stepup-body'),
      pwGroup: q('stepup-password-group'), pw: q('stepup-password'),
      codeGroup: q('stepup-code-group'), code: q('stepup-code'),
      err: q('stepup-error'), cancel: q('stepup-cancel')
    };
  }

  // Opens the dialog. Resolves { password, code } on Authorize (Enter submits), or null on
  // Cancel, Escape or a click on the backdrop — those are the ONLY ways to get null, so a
  // null really is the operator's decision. `step` is 'password' or 'code' (the second
  // factor, asked only after the server accepted the password); `error` is the server's
  // reason for rejecting the previous attempt, shown above the buttons.
  function ask(step, error) {
    return new Promise(function (resolve) {
      if (!ui) build();
      var o = ui, needCode = step === 'code';
      var previous = document.activeElement;
      o.body.textContent = needCode
        ? 'Password accepted. Your pool also requires a second factor for protected actions — enter the current code from your authenticator app.'
        : 'This is a protected action. Re-enter your admin password to authorize it; it stays valid for the next few minutes.';
      o.pwGroup.style.display = needCode ? 'none' : '';
      o.codeGroup.style.display = needCode ? '' : 'none';
      o.pw.value = '';
      o.code.value = '';
      o.err.textContent = error || '';
      o.err.style.display = error ? '' : 'none';

      function close(result) {
        o.overlay.classList.remove('open');
        o.form.removeEventListener('submit', onSubmit);
        o.cancel.removeEventListener('click', onCancel);
        o.overlay.removeEventListener('click', onBackdrop);
        document.removeEventListener('keydown', onKey);
        o.pw.value = ''; o.code.value = '';       // never leave a password in the DOM
        if (previous && typeof previous.focus === 'function') previous.focus();
        resolve(result);
      }
      function showErr(msg, field) { o.err.textContent = msg; o.err.style.display = ''; field.focus(); }
      function onSubmit(e) {
        e.preventDefault();
        var pw = o.pw.value, code = o.code.value.trim();
        if (!needCode && !pw) return showErr('Enter your password.', o.pw);
        if (needCode && !code) return showErr('Enter the code.', o.code);
        close({ password: pw, code: code });
      }
      function onCancel() { close(null); }
      function onBackdrop(e) { if (e.target === o.overlay) close(null); }
      function onKey(e) { if (e.key === 'Escape') { e.preventDefault(); close(null); } }

      o.form.addEventListener('submit', onSubmit);
      o.cancel.addEventListener('click', onCancel);
      o.overlay.addEventListener('click', onBackdrop);
      document.addEventListener('keydown', onKey);
      o.overlay.classList.add('open');
      (needCode ? o.code : o.pw).focus();
    });
  }

  // ── Re-authentication ────────────────────────────────────────────────────────
  // Resolves { outcome: 'ok' | 'cancelled' | 'failed', reason }. A wrong password or code
  // re-opens the dialog with the server's reason — a typo must not cost the whole action —
  // while a lockout, a rate-limit refusal or an unreachable pool ends it with `reason` set.
  // The step-up route has a real lockout and a 10/min budget behind it, so the loop stops
  // the moment the server says it has stopped accepting attempts.
  async function doReauth() {
    var step = 'password', error = '', pw = '';
    for (;;) {
      var creds = await ask(step, error);
      if (!creds) return { outcome: 'cancelled' };
      if (step === 'password') pw = creds.password;
      var res;
      try {
        res = await post(step === 'code' ? { password: pw, code: creds.code } : { password: pw });
      } catch (e) {
        return { outcome: 'failed', reason: 'the pool could not be reached to check it' };
      }
      if (res.ok) return { outcome: 'ok' };

      if (res.data.locked || res.data.retry_after_seconds) {
        var mins = Math.ceil((res.data.retry_after_seconds || 0) / 60);
        return { outcome: 'failed', reason: 'too many failed attempts from this location — try again in about '
                                            + (mins > 0 ? mins + ' minute(s)' : 'a few minutes') };
      }
      // The pool may require a second factor for step-up as well as for login
      // (access.require_admin_totp). The server answers the password-only attempt with
      // totp_code_required — after verifying the password — so the code is asked for ONLY
      // where it is actually needed: prompting unconditionally would train operators on a
      // pool that never uses 2FA. A wrong code comes back the same way and stays on this step.
      if (res.data.totp_code_required) {
        error = step === 'code' ? (res.data.error || 'That code was not accepted.') : '';
        step = 'code';
        continue;
      }
      error = res.data.error || 'Not accepted.';
    }
  }

  // Two protected requests in flight at once (a double-click, a page firing two saves)
  // share one dialog: the second waits for the first, then retries against the fresh session.
  var inflight = null;
  function reauth() {
    if (!inflight) inflight = doReauth().finally(function () { inflight = null; });
    return inflight;
  }

  // A 403 whose body says what actually happened. The server's challenge body reads
  // "Session expired", which is the wrong story for a cancelled dialog — the session is
  // fine, the step-up simply never completed — and every caller prints `body.error`
  // verbatim. `step_up` lets a caller tell this browser-side refusal from a server one.
  function refused(message, why) {
    return new Response(JSON.stringify({ error: message, challenge_required: true, step_up: why }),
                        { status: 403, headers: { 'Content-Type': 'application/json' } });
  }

  async function adminFetch(url, opts) {
    opts = Object.assign({ credentials: 'include' }, opts || {});
    var res = await fetch(url, opts);
    if (res.status !== 403) return res;

    // Only step up on a freshness challenge — an IP/allowlist/role 403 is NOT recoverable here.
    var body = null;
    try { body = await res.clone().json(); } catch (e) { /* not json */ }
    if (!body || !body.challenge_required) return res;

    var r = await reauth();
    if (r.outcome === 'cancelled') {
      return refused('Not done — this action needs your admin password and the authorization dialog '
                   + 'was cancelled. Click the button again to retry.', 'cancelled');
    }
    if (r.outcome !== 'ok') {
      return refused('Not done — the password re-check did not pass (' + (r.reason || 'refused')
                   + '), so the action was not performed. Click the button again to retry.', 'failed');
    }
    return fetch(url, opts);        // retry once with the now-fresh session
  }

  window.adminFetch = adminFetch;
})();
