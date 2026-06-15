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

  async function reauth() {
    var pw = window.prompt('This action is protected. Re-enter your admin password to authorize it:');
    if (pw === null || pw === '') return false; // cancelled
    try {
      var r = await fetch('/api/admin/reauth', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: pw })
      });
      return r.ok;
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
