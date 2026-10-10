// Admin guard chains + the step-up helpers, shared by every future admin route file (H4).
// Moved VERBATIM from routes/index.js (P2). ONE instance: routes/index.js calls createGuards(ctx)
// once and hands the result to every route file — the chains hold rateLimiter/ipFilter bindings
// and must never be rebuilt per file (I7).
const { requireAdmin, requireFreshAuth } = require('../../lib/auth-middleware');

module.exports = function createGuards(ctx) {
  const { rateLimiter, ipFilter, authManager, poolSettings } = ctx;

  // ─── Helper middleware: secure admin endpoints (IP filter + auth + rate limit) ────
  const secureAdmin = [
    rateLimiter.middleware('admin'),
    ipFilter.middleware('admin'),
    requireAdmin(authManager)
  ];

  // Is TOTP 2FA mandatory for admins right now? Read live from the DB (not the startup-merged
  // config) so flipping the toggle takes effect without a service restart.
  let _totpMandatoryReadFailAt = 0;
  const totpIsMandatory = () => {
    try {
      return String(poolSettings.getSection('access').require_admin_totp) === 'true';
    } catch (e) {
      // Fail OPEN on a settings read error. Failing closed here would brick every step-up
      // endpoint — including the ones needed to fix the settings — on a transient DB error.
      //
      // But say so (audit §J9-7). This is the only fail-OPEN security switch in the pool, and
      // until this line it downgraded mandatory 2FA to optional in complete silence: no log,
      // no alert, no audit row. Throttled to one line a minute so a persistently broken DB
      // cannot flood the journal on a per-request read.
      const now = Date.now();
      if (now - _totpMandatoryReadFailAt > 60000) {
        _totpMandatoryReadFailAt = now;
        console.error(
          `[SECURITY] access.require_admin_totp is unreadable (${e.message}) — mandatory 2FA ` +
          `is being treated as OFF until the settings read succeeds. Check the database.`
        );
      }
      return false;
    }
  };

  // Enforcement for access.require_admin_totp. Applied to the STEP-UP chain only, so an
  // un-enrolled admin keeps a normal session (and can therefore reach 2FA enrollment) but
  // cannot move money or run destructive actions until 2FA is on. See the setting's comment
  // in lib/pool-settings.js for why this isn't a login refusal.
  const requireTotpEnrolled = (req, res, next) => {
    if (!totpIsMandatory()) return next();
    if (authManager.isTotpEnabled(req.user.user_id)) return next();
    return res.status(403).json({
      error: 'This pool requires two-factor authentication for admin actions. Set up 2FA to continue.',
      totp_enrollment_required: true
    });
  };

  // Step-up gate for money/destructive admin actions: same as secureAdmin but also requires
  // a PASSWORD re-verification within the last 5 min (requireFreshAuth → token.pwa). A live
  // (or stolen) session alone is not enough — the client must call /api/admin/reauth first.
  const STEP_UP_MAX_AGE_S = 300;
  const freshAdmin = [
    rateLimiter.middleware('admin'),
    ipFilter.middleware('admin'),
    requireFreshAuth(authManager, STEP_UP_MAX_AGE_S),
    requireTotpEnrolled
  ];

  // Step-up WITHOUT the mandatory-2FA gate. Used only by the 2FA ENROLLMENT endpoints: on a
  // pool with require_admin_totp on, an admin who hasn't enrolled must be able to reach the
  // very endpoints that enroll them. Putting requireTotpEnrolled in front of enrollment would
  // make the requirement unsatisfiable and hard-lock the panel — recoverable only via the
  // break-glass CLI. Do NOT reuse this chain for anything else.
  const freshAdminEnroll = [
    rateLimiter.middleware('admin'),
    ipFilter.middleware('admin'),
    requireFreshAuth(authManager, STEP_UP_MAX_AGE_S)
  ];

  // Step-up applied CONDITIONALLY, from inside a `secureAdmin` handler, for routes where only
  // some requests are sensitive (a settings section that carries fee/whitelist keys; a region
  // save that carries a wg pubkey). Returns true when it has already answered the request.
  //
  // It exists because those two handlers previously inlined a bare `isTokenFresh()` call, which
  // reproduced requireFreshAuth but silently dropped requireTotpEnrolled — so on a pool with
  // access.require_admin_totp ON, an un-enrolled admin was refused by every freshAdmin route
  // yet could still write the `payout` section with a password-only re-auth (audit §I7).
  // Both halves of the step-up contract live here now; do not re-inline either one.
  const stepUpRefused = (req, res) => {
    if (!authManager.isTokenFresh(req.token, STEP_UP_MAX_AGE_S)) {
      res.status(403).json({ error: 'Session expired', challenge_required: true });
      return true;
    }
    if (totpIsMandatory() && !authManager.isTotpEnabled(req.user.user_id)) {
      res.status(403).json({
        error: 'This pool requires two-factor authentication for admin actions. Set up 2FA to continue.',
        totp_enrollment_required: true
      });
      return true;
    }
    return false;
  };

  return {
    secureAdmin, freshAdmin, freshAdminEnroll,
    requireTotpEnrolled, stepUpRefused, totpIsMandatory, STEP_UP_MAX_AGE_S,
  };
};
