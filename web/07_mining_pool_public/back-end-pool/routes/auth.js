// /api/auth/* plus /api/admin/reauth and /api/admin/2fa/* — login, session and 2FA live together regardless of prefix.
// Moved verbatim out of routes/index.js (code-layout refactor P3); registrations stay at 2-space
// indent and write FULL paths. Instances/state come from ctx; the guard chains are the ONE
// instance routes/index.js built with createGuards (I7), handed in as `guards`.

const express = require('express');
const { requireAdmin } = require('../lib/auth-middleware');
const { isLocalRequest } = require('../lib/http-util');

module.exports = function createAuthRoutes(ctx, guards) {
  const {
    authManager, db, ipFilter, loginCaptcha, poolSettings, rateLimiter,
    adminLoginFailures, admin2faFailures, ADMIN_LOGIN_FAIL_THRESHOLD, ADMIN_LOGIN_FAIL_WINDOW_MS,
    ADMIN_LOGIN_BAN_MS, ADMIN_FAIL_MAP_MAX, ADMIN_2FA_FAIL_THRESHOLD
  } = ctx;
  const { secureAdmin, freshAdmin, freshAdminEnroll, totpIsMandatory } = guards;
  const router = express.Router();

  // Auto-ban bookkeeping for the two login steps: count failures per IP within the window,
  // temp-ban on threshold. `kind` selects the counter — 'password' and '2fa' are tracked
  // independently (see ADMIN_2FA_FAIL_THRESHOLD), so a run of rejected codes can never
  // consume the password budget or vice versa.
  const recordAdminLoginFailure = (ip, kind = 'password') => {
    const isTwofa = kind === '2fa';
    const store = isTwofa ? admin2faFailures : adminLoginFailures;
    const threshold = isTwofa ? ADMIN_2FA_FAIL_THRESHOLD : ADMIN_LOGIN_FAIL_THRESHOLD;
    const now = Date.now();
    // Sweep expired entries before adding a new one (audit §J12-11). Both maps were pruned
    // ONLY on the next failure from the same IP, or on threshold/success — so an IP that
    // failed once and never came back held its entry for the life of the process. Each entry
    // costs an attacker a solved CAPTCHA, which is why this is a tidy-up rather than a fix for
    // a live lever, but "grows forever" is not a property a security counter should have.
    // Amortised: only runs when a NEW IP appears, and only past a floor no real pool reaches.
    if (!store.has(ip) && store.size >= ADMIN_FAIL_MAP_MAX) {
      for (const [k, v] of store) {
        if (now - v.firstAt > ADMIN_LOGIN_FAIL_WINDOW_MS) store.delete(k);
      }
    }
    let rec = store.get(ip);
    if (!rec || now - rec.firstAt > ADMIN_LOGIN_FAIL_WINDOW_MS) rec = { count: 0, firstAt: now };
    rec.count++;
    store.set(ip, rec);
    if (rec.count >= threshold) {
      ipFilter.tempBan(ip, ADMIN_LOGIN_BAN_MS);
      store.delete(ip);
      try {
        db.prepare(`INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, details, ip)
                    VALUES (NULL, 'ip_autoban', 'security', ?, ?, ?)`)
          .run(ip, JSON.stringify({
            reason: isTwofa ? 'failed_admin_2fa_codes' : 'failed_admin_logins',
            threshold,
            ban_minutes: ADMIN_LOGIN_BAN_MS / 60000
          }), ip);
      } catch (e) { /* non-fatal */ }
    }
  };

  // Cookie lifetimes must track the live session policy, not a hardcoded hour. A cookie that
  // outlives its token is harmless (the request 401s and the client refreshes), but a cookie
  // that dies FIRST silently logs the operator out mid-session with a valid token in hand —
  // which is exactly the bug that made "session timeout" feel arbitrary.
  const accessCookieOpts = () => ({
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: authManager.sessionPolicy().idle * 1000
  });
  // The refresh cookie is capped at the ABSOLUTE session limit: past that, refreshAccessToken
  // refuses anyway, so holding the cookie for the full 7 days would only invite pointless
  // 401s. Whichever is shorter wins.
  const refreshCookieOpts = () => ({
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: Math.min(authManager.refreshTokenExpiresIn, authManager.sessionPolicy().abs) * 1000
  });

  // Issue a self-hosted CAPTCHA challenge for the login/register forms. On the `public`
  // bucket (1200/min) so the form can fetch one without spending the stricter `auth` budget
  // (200/min) — both are the ×20 "loosen now" values; see this.limits in lib/rate-limiter.js.
  router.get('/api/auth/captcha', rateLimiter.middleware('public'), (req, res) => {
    // Pass the client IP so the challenge store caps THIS source's outstanding challenges
    // instead of letting it evict everyone else's. This endpoint is unauthenticated and free
    // at 1200/min, and the store used to be one global 5000-entry Map evicting oldest-first —
    // so an anonymous flood locked the operator out of their own login form with no failed
    // login, no auto-ban and no audit row. See lib/captcha.js and audit §J2-4.
    res.json(loginCaptcha.issue(req.ip));
  });

  // Rate limiting + first-admin gating + httpOnly cookies.
  router.post('/api/auth/register',
    async (req, res) => {
      try {
        // Rate gate (peek, don't spend yet) — refuse early if locked/over budget.
        const rl = rateLimiter.peek('auth', req);
        if (!rl.allowed) return rateLimiter.sendLimited(res, rl);

        // ON-BOX ONLY (audit §J17-1). First-admin registration is open to whoever asks whenever
        // the users table holds no admin, and BOTH mitigations the pre-mainnet gate plan named
        // for that window are inert:
        //   · `admin_allowlist` is emitted into `location /admin/` and `location /api/admin/`
        //     only — this route is `/api/auth/`, which carries no allowlist at any setting.
        //   · "register before the vhost is publicly resolvable" is contradicted by the
        //     installer's own order: step 4 runs `certbot --nginx`, which REQUIRES public DNS
        //     and publishes the hostname to Certificate Transparency; the backend goes live at
        //     step 6 and the admin is not created until step 7.
        // And the window re-opens on a live, already-published pool every time pool.db is
        // reset (Script 07 → Reset Pool Database restarts the service immediately with zero
        // admins). The captcha below is not a barrier — it is single-digit `a+b`/`a×b` by its
        // own module description, there to price scripted brute force, not to stop one request.
        // The installer always POSTs to 127.0.0.1:<port> (pool_setup_admin), so this costs the
        // supported path nothing. Registering from another machine: SSH-forward the API port
        // (`ssh -L 8080:127.0.0.1:8080 root@pool`) and register against the forwarded port.
        if (!isLocalRequest(req)) {
          return res.status(403).json({
            success: false,
            error: 'Admin registration is on-box only. Run Script 07 → Create admin account on the pool server.'
          });
        }

        // Cheap early refusal so a closed pool answers without doing captcha or bcrypt work.
        // This is NOT the gate — it cannot be, because the authoritative check has to happen
        // on the far side of the ~300 ms password hash below, and that await yields the event
        // loop. registerAdmin({ firstAdminOnly: true }) re-checks and inserts atomically; two
        // concurrent registrations used to sail past this line and BOTH become admins
        // (audit §J2-2, demonstrated). Keep both: this one for the common case, that one for
        // correctness.
        const adminCount = db.prepare('SELECT COUNT(*) as cnt FROM users WHERE is_admin=1').get();
        if (adminCount.cnt > 0) {
          return res.status(403).json({ error: 'Admin registration closed.' });
        }

        // CAPTCHA gate (before any credential work — a wrong/expired captcha never counts
        // as a password attempt and can't trip the account lockout). Skipped for direct
        // on-box (loopback) calls: this is first-admin-only registration, run once by the
        // trusted root operator via Script 07's guided installer. The captcha only exists
        // to slow REMOTE brute force, which can't reach this loopback-bound endpoint anyway.
        if (!isLocalRequest(req) &&
            !loginCaptcha.verify(req.body?.captcha_id, req.body?.captcha_answer)) {
          return res.status(400).json({ success: false, error: 'Captcha incorrect or expired. Try again.' });
        }

        // Genuine credential attempt — spend one token against the auth limit.
        rateLimiter.consume('auth', req);

        const { username, password } = req.body;
        const result = await authManager.registerAdmin(username, password, { firstAdminOnly: true });
        if (result.success) {
          // Generate tokens and set them as httpOnly cookies. pwa=now — the admin just
          // set this password, so the first session starts step-up-fresh.
          const tokens = authManager.generateTokens(result.user_id, username, true, 0, Math.floor(Date.now() / 1000));

          res.cookie('access_token', tokens.accessToken, accessCookieOpts());
          res.cookie('refresh_token', tokens.refreshToken, refreshCookieOpts());

          // Log registration event
          const auditStmt = db.prepare(`
            INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, details, ip)
            VALUES (?, 'register', 'auth', 'register', ?, ?)
          `);
          auditStmt.run(
            result.user_id,
            JSON.stringify({ username }),
            req.ip
          );

          // Don't return tokens (in cookies now)
          res.json({ success: true, username: result.username, is_admin: result.is_admin });
        } else {
          // "Registration closed" must keep its 403 even when it comes from the atomic gate
          // inside registerAdmin rather than the pre-check above. Script 07's installer
          // branches on the status code — 403 prints "an admin already exists", 400 prints
          // "username >= 3, password >= 8" — so a closed-pool refusal arriving as 400 tells
          // the operator to fix a password that was never the problem.
          const closed = /registration closed/i.test(result.error || '');
          res.status(closed ? 403 : 400).json({ success: false, error: result.error });
        }
      } catch (err) {
        res.status(500).json({ error: 'Server error' });
      }
    }
  );

  // Rate limiting + audit logging + httpOnly cookies.
  router.post('/api/auth/login',
    async (req, res) => {
      try {
        const ip = req.ip;

        // Rate gate (peek, don't spend yet): if already locked/over budget, refuse now.
        const rl = rateLimiter.peek('auth', req);
        if (!rl.allowed) return rateLimiter.sendLimited(res, rl);

        // Auto-ban: reject IPs that tripped the failed-login threshold (temporary cooldown).
        if (ipFilter && ipFilter.isBlocked(ip)) {
          return res.status(403).json({ success: false, error: 'Too many failed attempts from your network. Try again later.' });
        }

        // CAPTCHA gate next — a wrong/expired captcha is rejected before the password is
        // ever checked, so it can't be used to probe credentials or trip account lockout.
        // It is checked BEFORE consuming the auth budget, so fumbling the captcha is free
        // and a human can't lock themselves out just by mistyping the verification answer.
        if (!loginCaptcha.verify(req.body?.captcha_id, req.body?.captcha_answer)) {
          return res.status(400).json({ success: false, error: 'Captcha incorrect or expired. Try again.' });
        }

        // Genuine credential attempt — now spend one token against the auth limit.
        rateLimiter.consume('auth', req);

        const { username, password } = req.body;
        const result = await authManager.login(username, password, ip);

        if (result.success) {
          // Password is correct → clear the PASSWORD auto-ban counter for this IP.
          // Deliberately does NOT clear admin2faFailures: an attacker holding a stolen
          // password could otherwise reset the code counter by simply logging in again
          // between guesses, making the 2FA threshold unreachable. Only completing 2FA
          // clears it.
          adminLoginFailures.delete(ip);

          // 2FA gate: if this admin has TOTP enabled, DON'T issue a session yet. Return a
          // short-lived 2fa token; the client completes via POST /api/auth/login/totp. (CAPTCHA
          // was already consumed here, so the second step doesn't require solving it again.)
          if (authManager.isTotpEnabled(result.user_id)) {
            return res.json({ success: false, totp_required: true, twofa_token: authManager.generate2faToken(result.user_id) });
          }

          // httpOnly (no JS access → no XSS theft), Secure in production, sameSite strict.
          // Lifetime comes from the live session policy — see accessCookieOpts.
          res.cookie('access_token', result.access_token, accessCookieOpts());
          res.cookie('refresh_token', result.refresh_token, refreshCookieOpts());

          // Log successful login
          const auditStmt = db.prepare(`
            INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, details, ip)
            VALUES (?, 'login_success', 'auth', 'login', ?, ?)
          `);
          auditStmt.run(
            result.user_id || null,
            JSON.stringify({ username }),
            ip
          );

          // Don't return tokens in response body (they're in httpOnly cookies)
          res.json({ success: true, username: result.username, is_admin: result.is_admin });
        } else {
          // Log failed login attempt (admin_id NULL — bad username may not exist in users)
          const auditStmt = db.prepare(`
            INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, details, ip)
            VALUES (NULL, 'login_failed', 'auth', 'login', ?, ?)
          `);
          auditStmt.run(JSON.stringify({ username }), ip);
          recordAdminLoginFailure(ip);
          res.status(401).json({ success: false, error: 'Invalid credentials' });
        }
      } catch (err) {
        res.status(500).json({ error: 'Server error' });  // Don't expose error details
      }
    }
  );

  // Second login step for 2FA-enabled admins. Takes the short-lived twofa_token from step 1
  // (proves the password passed) plus a TOTP or recovery code. No CAPTCHA here — it was solved
  // in step 1. Issues the real session on success.
  router.post('/api/auth/login/totp', rateLimiter.middleware('auth'), async (req, res) => {
    try {
      const ip = req.ip;
      if (ipFilter && ipFilter.isBlocked(ip)) {
        return res.status(403).json({ success: false, error: 'Too many failed attempts from your network. Try again later.' });
      }
      const { twofa_token, code } = req.body || {};
      // verify2faToken returns { userId, jti } — the jti carries the token's OWN guess budget,
      // so the code-guessing cost follows the account instead of the requesting host. A token
      // whose jti has been spent or burned through is refused here even though its JWT still
      // verifies; see authManager.generate2faToken and audit §J2-3.
      const tok = authManager.verify2faToken(twofa_token);
      if (!tok) return res.status(401).json({ success: false, error: '2FA session expired — please log in again.' });
      const userId = tok.userId;

      const ok = await authManager.verifyTotpOrRecovery(userId, code);
      if (!ok) {
        const burned = authManager.record2faFailure(tok.jti);
        try {
          db.prepare(`INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, details, ip)
                      VALUES (?, 'login_2fa_failed', 'auth', 'login', ?, ?)`)
            .run(userId, JSON.stringify({ token_budget_spent: burned }), ip);
        } catch (e) { /* non-fatal */ }
        recordAdminLoginFailure(ip, '2fa');
        // Distinguishing "wrong code" from "this token is finished" is not an oracle — the
        // caller already proved the password to get the token — and without it the operator
        // sees the same message forever while every further attempt is silently refused.
        return res.status(401).json({
          success: false,
          error: burned
            ? 'Too many incorrect codes — please log in again.'
            : 'Invalid 2FA code',
          restart_login: burned
        });
      }
      // Success destroys the token: it must not be re-presented to mint a second session or
      // to buy a fresh guess budget.
      authManager.consume2faToken(tok.jti);

      const sess = authManager.issueSessionFor(userId);
      if (!sess.success) return res.status(401).json({ success: false, error: sess.error || 'Login failed' });

      res.cookie('access_token', sess.access_token, accessCookieOpts());
      res.cookie('refresh_token', sess.refresh_token, refreshCookieOpts());
      // Full authentication completed — clear BOTH counters for this IP.
      adminLoginFailures.delete(ip);
      admin2faFailures.delete(ip);
      try {
        db.prepare(`INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, details, ip)
                    VALUES (?, 'login_success', 'auth', 'login', ?, ?)`).run(userId, JSON.stringify({ via: '2fa' }), ip);
      } catch (e) { /* non-fatal */ }
      res.json({ success: true, username: sess.username, is_admin: sess.is_admin });
    } catch (err) {
      res.status(500).json({ error: 'Server error' });
    }
  });

  router.post('/api/auth/refresh', rateLimiter.middleware('auth'), (req, res) => {
    // Refresh token comes from the cookie; the body form is the legacy fallback.
    const refreshToken = req.cookies.refresh_token || req.body.refresh_token;
    if (!refreshToken) {
      return res.status(401).json({ error: 'No refresh token' });
    }

    const result = authManager.refreshAccessToken(refreshToken);
    if (result.success) {
      // Set new access token in httpOnly cookie
      res.cookie('access_token', result.access_token, accessCookieOpts());

      // Set new refresh token if provided
      if (result.refresh_token) {
        res.cookie('refresh_token', result.refresh_token, refreshCookieOpts());
      }

      // expires_in lets the client schedule the next silent refresh; session_started_at is
      // what it needs to count down the absolute cap without guessing from page-load time.
      res.json({
        success: true,
        expires_in: result.expires_in,
        session_started_at: result.session_started_at,
        session_absolute_seconds: result.session_absolute_seconds
      });
    } else {
      // session_expired = the absolute cap was reached; a new access token will never be
      // issued for this session, so the client must stop retrying and send the operator to
      // the login page instead of looping.
      res.status(401).json({
        success: false,
        error: result.error,
        session_expired: !!result.session_expired
      });
    }
  });

  // Step-up re-authentication: a logged-in admin re-enters their password to authorize a
  // money/destructive action. Mints a fresh (pwa=now) access token; the client then retries
  // the freshAdmin-gated request. It is gated at the secureAdmin TIER (a valid session, not a
  // fresh one — requiring freshness to become fresh is unsatisfiable), but on its own rate
  // bucket rather than the shared `admin` one; the chain is spelled out below rather than
  // reusing the `secureAdmin` array for exactly that reason.
  //
  // This route IS the freshAdmin tier. Everything behind requireFreshAuth — withdrawal
  // retry/cancel, payout freeze, dormancy send-payout, prize-pool topup, wallet
  // adopt-identity — opens the moment it returns, so it is defended like the login route and
  // not like an admin read (audit §J2-1). Three things were missing and are now here:
  //
  //   1. `stepup` rate bucket, not `admin`. 10/min instead of 2400/min. This is the control
  //      that bounds the CPU as well as the guessing: the bcrypt runs before any counter can
  //      see its result, so a lockout alone would not have stopped a session thief from
  //      burning the shared event loop (and with it stratum share intake).
  //   2. The (username, IP) lockout and the fail2ban-style per-IP auto-ban, i.e. the same
  //      three-layer policy /api/auth/login has. The pair key is what keeps this from becoming
  //      a remote operator lockout.
  //   3. A second factor when the pool mandates one. freshAdmin's requireTotpEnrolled only
  //      checks that the account HAS 2FA and never asks for a code, so on a pool with
  //      access.require_admin_totp ON the money gate was still password-only.
  router.post('/api/admin/reauth',
    rateLimiter.middleware('stepup'),
    ipFilter.middleware('admin'),
    requireAdmin(authManager),
    async (req, res) => {
    try {
      const { password, code } = req.body || {};
      if (!password) return res.status(400).json({ error: 'Password required' });

      // Ask for a code only where the pool has decided 2FA is mandatory AND this admin is
      // enrolled. Demanding one from an un-enrolled admin would make step-up unsatisfiable and
      // hard-lock the panel — the same trap freshAdminEnroll exists to avoid.
      const requireCode = totpIsMandatory() && authManager.isTotpEnabled(req.user.user_id);

      // Pass the caller's session start through: a step-up re-verifies the password but does
      // NOT start a new session, so it must not reset the absolute-cap clock.
      const result = await authManager.stepUp(
        req.user.user_id,
        password,
        Number(req.user.sst) || 0,
        { ip: req.ip, requireCode, code }
      );

      // "You must also send a code" is a protocol answer, not a failed credential attempt —
      // counting it would let a correct-password client lock itself out by not knowing the
      // pool's policy yet. 401 + the flag; the client re-prompts and posts both.
      if (!result.success && result.totp_code_required && !code) {
        return res.status(401).json({
          error: result.error || 'Two-factor code required',
          totp_code_required: true
        });
      }

      if (!result.success) {
        try {
          db.prepare(`INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, details, ip)
                      VALUES (?, 'reauth_failed', 'auth', 'reauth', ?, ?)`)
            .run(req.user.user_id, JSON.stringify({ locked: !!result.locked, factor: result.totp_code_required ? '2fa' : 'password' }), req.ip);
        } catch (e) { /* non-fatal */ }
        // Don't spend auto-ban budget on a source that is ALREADY locked out — it is being
        // refused before the password is even read, so counting it would let a lock convert
        // itself into a longer ban with no new information.
        if (!result.locked) {
          recordAdminLoginFailure(req.ip, result.totp_code_required ? '2fa' : 'password');
        }
        return res.status(result.locked ? 429 : 401).json({
          error: result.error || 'Re-authentication failed',
          locked: !!result.locked,
          retry_after_seconds: result.retry_after_seconds || undefined,
          totp_code_required: !!result.totp_code_required,
          code_replay: !!result.code_replay
        });
      }

      // A completed step-up is a full credential proof — clear this IP's counters, exactly as
      // a successful login does.
      adminLoginFailures.delete(req.ip);
      if (requireCode) admin2faFailures.delete(req.ip);

      res.cookie('access_token', result.access_token, accessCookieOpts());
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: 'Server error' });
    }
  });

  // ─── Admin TOTP 2FA management ──────────────────────────────────────────────
  // Status is readable with a normal admin session; enabling/disabling requires step-up
  // (freshAdmin) so a hijacked live session can't silently turn 2FA off.
  router.get('/api/admin/2fa/status', secureAdmin, (req, res) => {
    try {
      const enabled = authManager.isTotpEnabled(req.user.user_id);
      const mandatory = totpIsMandatory();
      res.json({
        success: true,
        enabled,
        recovery_codes_remaining: authManager.unusedRecoveryCount(req.user.user_id),
        // Lets the panel show the real state instead of a generic 403 the first time a
        // step-up action is refused: mandatory = the pool requires 2FA;
        // must_enroll = required but this admin hasn't set it up, so step-up is blocked.
        mandatory,
        must_enroll: mandatory && !enabled,
      });
    } catch (err) { res.status(500).json({ error: 'Server error' }); }
  });

  router.post('/api/admin/2fa/enroll/begin', freshAdminEnroll, (req, res) => {
    try {
      if (authManager.isTotpEnabled(req.user.user_id)) {
        return res.status(400).json({ error: '2FA is already enabled. Disable it first to re-enroll.' });
      }
      let issuer = 'Grin Pool';
      try { issuer = (poolSettings.getSection('pool_info').pool_name) || issuer; } catch (e) {}
      const r = authManager.begin2faEnrollment(req.user.user_id, issuer);
      if (!r.success) return res.status(400).json({ error: r.error });
      res.json({ success: true, secret: r.secret, otpauth_uri: r.otpauth_uri });
    } catch (err) { res.status(500).json({ error: 'Server error' }); }
  });

  router.post('/api/admin/2fa/enroll/confirm', freshAdminEnroll, async (req, res) => {
    try {
      const r = await authManager.confirm2faEnrollment(req.user.user_id, (req.body || {}).code);
      if (!r.success) return res.status(400).json({ error: r.error });
      db.prepare(`INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, details, ip)
                  VALUES (?, '2fa_enabled', 'auth', '2fa', NULL, ?)`).run(req.user.user_id, req.ip);
      res.json({ success: true, recovery_codes: r.recovery_codes });
    } catch (err) { res.status(500).json({ error: 'Server error' }); }
  });

  router.post('/api/admin/2fa/disable', freshAdmin, async (req, res) => {
    try {
      const r = await authManager.disable2fa(req.user.user_id, (req.body || {}).code);
      if (!r.success) {
        // Three routes in this file verify a 2FA code and only ONE of them fed the counter.
        // That asymmetry is not an escalation path today (both 2FA management routes are
        // freshAdmin, so reaching them already means beating 2FA) — it is the kind of gap
        // that becomes one the next time a tier moves. Audit §J2-3.
        recordAdminLoginFailure(req.ip, '2fa');
        return res.status(400).json({ error: r.error, code_replay: !!r.code_replay });
      }
      db.prepare(`INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, details, ip)
                  VALUES (?, '2fa_disabled', 'auth', '2fa', NULL, ?)`).run(req.user.user_id, req.ip);
      res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'Server error' }); }
  });

  router.post('/api/admin/2fa/recovery/regenerate', freshAdmin, async (req, res) => {
    try {
      if (!authManager.isTotpEnabled(req.user.user_id)) {
        return res.status(400).json({ error: 'Enable 2FA first.' });
      }
      // Require a current code so only the genuine 2FA holder can mint new recovery codes.
      const codeDetail = {};
      const ok = await authManager.verifyTotpOrRecovery(req.user.user_id, (req.body || {}).code, codeDetail);
      if (!ok) {
        recordAdminLoginFailure(req.ip, '2fa');   // same shared counter — see 2fa/disable
        return res.status(401).json({
          error: codeDetail.replay
            ? 'That code has already been used. Wait for your authenticator to show the next one.'
            : 'Incorrect 2FA / recovery code',
          code_replay: !!codeDetail.replay
        });
      }
      const recovery_codes = await authManager.generateRecoveryCodes(req.user.user_id);
      db.prepare(`INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, details, ip)
                  VALUES (?, '2fa_recovery_regenerated', 'auth', '2fa', NULL, ?)`).run(req.user.user_id, req.ip);
      res.json({ success: true, recovery_codes });
    } catch (err) { res.status(500).json({ error: 'Server error' }); }
  });

  router.post('/api/auth/logout', rateLimiter.middleware('auth'), (req, res) => {
    // Server-side revoke: bump the user's token_version so the issued refresh token
    // can't be replayed after logout (clearing the cookie alone only affects this browser).
    authManager.revokeByRefreshToken(req.cookies?.refresh_token || req.body?.refresh_token);
    res.clearCookie('access_token', { httpOnly: true });
    res.clearCookie('refresh_token', { httpOnly: true });
    res.json({ success: true });
  });


  // The second place in this file that verifies a password, and it used to be the quieter one:
  // `auth` bucket (200/min), the non-admin `requireAuth` guard, no ipFilter, no lockout and no
  // audit row at all — 288 k guesses/day for a hijacked session, leaving no trace. It now runs
  // the same three-layer policy as the other two: the `stepup` bucket (10/min), the admin IP
  // filter, the (username, IP) lockout inside changePassword, and the per-IP auto-ban. Audit
  // §J2-1.
  //
  // Deliberately `secureAdmin` and not `freshAdmin`: the request already carries the current
  // password, so demanding a step-up first would mean typing the same secret twice for one
  // action — ceremony an operator learns to click through, which is the failure mode the
  // step-up prompt can least afford. Promoting it to requireAdmin is what retires `requireAuth`
  // (it had exactly one caller, this one — §J1's handoff called it dead code, which it was not
  // until this line changed).
  router.post('/api/auth/change-password',
    rateLimiter.middleware('stepup'),
    ipFilter.middleware('admin'),
    requireAdmin(authManager),
    (req, res) => {
    const { old_password, new_password } = req.body;
    authManager.changePassword(req.user.user_id, old_password, new_password, req.ip)
      .then(result => {
        if (result.success) {
          try {
            db.prepare(`INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, details, ip)
                        VALUES (?, 'password_changed', 'auth', 'password', NULL, ?)`)
              .run(req.user.user_id, req.ip);
          } catch (e) { /* non-fatal */ }
          res.json(result);
        } else {
          try {
            db.prepare(`INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, details, ip)
                        VALUES (?, 'password_change_failed', 'auth', 'password', NULL, ?)`)
              .run(req.user.user_id, req.ip);
          } catch (e) { /* non-fatal */ }
          recordAdminLoginFailure(req.ip);
          // Don't expose detailed error messages
          res.status(400).json({ success: false, error: 'Password change failed' });
        }
      })
      .catch(err => {
        res.status(500).json({ error: 'Server error' });
      });
  });
  return router;
};
