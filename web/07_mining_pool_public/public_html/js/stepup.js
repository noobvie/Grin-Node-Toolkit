// stepup.js — step-up (re-authentication) helper for admin-panel money/destructive actions.
//
// Money/destructive admin endpoints are gated server-side by `freshAdmin` (requireFreshAuth):
// a valid session is not enough — the admin must have re-entered their password within the
// last few minutes. When such an endpoint is hit without a fresh session it returns
// 403 { challenge_required: true }. adminFetch() transparently handles that: prompt for the
// password → POST /api/admin/reauth → retry the original request once.
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

  async function reauth() {
    var pw = window.prompt('This action is protected. Re-enter your admin password to authorize it:');
    if (pw === null || pw === '') return false; // cancelled
    try {
      var res = await post({ password: pw });
      if (res.ok) return true;

      // The pool may require a second factor for step-up as well as for login
      // (access.require_admin_totp). The server answers the password-only attempt with
      // totp_code_required so the code is asked for ONLY where it is actually needed —
      // prompting unconditionally would train operators on a pool that never uses 2FA.
      if (res.data.totp_code_required) {
        var code = window.prompt('Enter the 6-digit code from your authenticator app (or a recovery code):');
        if (code === null || code === '') return false;   // cancelled
        res = await post({ password: pw, code: code });
        if (res.ok) return true;
      }

      // Say why. The step-up route now has a real lockout and a 10/min budget behind it, so a
      // silent false here would leave the operator re-typing a correct password into a window
      // that has already stopped accepting it.
      if (res.data.locked || res.data.retry_after_seconds) {
        var mins = Math.ceil((res.data.retry_after_seconds || 0) / 60);
        window.alert('Too many failed attempts from this location. Try again in about ' +
                     (mins > 0 ? mins + ' minute(s)' : 'a few minutes') + '.');
      } else if (res.data.error) {
        window.alert(res.data.error);
      }
      return false;
    } catch (e) {
      return false;
    }
  }

  async function adminFetch(url, opts) {
    opts = Object.assign({ credentials: 'include' }, opts || {});
    var res = await fetch(url, opts);
    if (res.status !== 403) return res;

    // Only step up on a freshness challenge — an IP/allowlist/role 403 is NOT recoverable here.
    var body = null;
    try { body = await res.clone().json(); } catch (e) { /* not json */ }
    if (!body || !body.challenge_required) return res;

    var ok = await reauth();
    if (!ok) return res;            // cancelled or reauth failed → hand back the original 403
    return fetch(url, opts);        // retry once with the now-fresh session
  }

  window.adminFetch = adminFetch;
})();
