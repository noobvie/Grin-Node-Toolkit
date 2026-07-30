const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const totp = require('./totp');
const { getDb } = require('./db');

class AuthManager {
  constructor(config) {
    this.config = config;
    this.db = getDb();
    this.jwtSecret = config.jwt_secret;
    // Access-token lifetime = the IDLE timeout. The admin client silently refreshes while
    // the operator is actually interacting (see AdminSession in admin-shell.js), so a token
    // expiring means "nobody touched the panel for this long", not "you've been here an hour".
    // This is the FALLBACK only: the live value comes from access.session_timeout_hours via
    // sessionPolicyProvider below, so it stays correct if the setting is unreadable.
    this.jwtExpiresIn = 3600;                // 1 h idle
    this.refreshTokenExpiresIn = 86400 * 7;  // refresh token: 7d (outer bound; see sessionAbsoluteSeconds)
    this.sessionAbsoluteSeconds = 12 * 3600; // fallback absolute cap (see _sessionPolicy)

    // Set by index.js once PoolSettings exists: () => { idle_seconds, absolute_seconds }.
    // A function, not a snapshot — the operator must be able to change the timeout without
    // restarting the pool, exactly like require_admin_totp.
    this.sessionPolicyProvider = null;
    // Login lockout, keyed on (username, IP) — NOT on username alone.
    //
    // A username-only lock is a remote denial-of-service on the operator: the admin
    // username is guessable ('admin'), so anyone could fail 5 logins every 15 min and keep
    // the real operator permanently locked out of their own pool — including during an
    // incident, when payouts and the freeze kill-switch are exactly what's needed. Keying
    // the lock on the PAIR keeps the anti-guessing property (one source can't grind a
    // username) while leaving every other source unaffected, so the operator always has a
    // way in from their own address.
    //
    // In-memory and per-process, like ipFilter.tempBans and the rate limiter: a restart
    // clears locks, which is an accepted trade for short cooldowns.
    //
    // Residual, deliberately not papered over: a large BOTNET defeats any per-source lock,
    // because each new IP starts with a clean counter. What bounds that is the per-IP auth
    // rate limit plus the fail2ban-style auto-ban in index.js — and, properly, mandatory
    // TOTP (access.require_admin_totp), which is the only control here that a distributed
    // password grind cannot out-scale. A global cross-IP lock is NOT the answer: it would
    // hand the same operator-lockout DoS back to any attacker willing to trip it.
    this.maxFailedAttempts = config.max_failed_login_attempts || 5;
    this.lockoutDurationSeconds = config.lockout_duration_seconds || 900; // 15 min
    this.lockoutWindowSeconds = config.lockout_window_seconds || 900;     // failure-count window
    this.lockouts = new Map();   // `${username}\0${ip}` -> { attempts, firstAt, lockedUntil }
    this.lockoutMaxEntries = 20000;  // flood guard: bound the Map (see _pruneLockouts)
    // bcrypt work factor (cost). ≥12 per the security audit.
    this.bcryptRounds = config.bcrypt_rounds || 12;
  }

  // Live session policy: { idle, abs } in seconds. Every value is clamped and every failure
  // path falls back to the constructor defaults — a broken/missing setting must degrade to
  // today's behaviour (1 h idle), never to "no expiry" and never to an unusably short one.
  _sessionPolicy() {
    let idle = this.jwtExpiresIn;
    let abs = this.sessionAbsoluteSeconds;
    try {
      const p = this.sessionPolicyProvider && this.sessionPolicyProvider();
      if (p) {
        const i = Number(p.idle_seconds);
        const a = Number(p.absolute_seconds);
        // Floor of 5 min on idle: a typo'd 0 would otherwise expire the token before the
        // client's first refresh and lock the operator into a login loop.
        //
        // CEILING OF 24 H, and it is a security bound, not a UX preference. Access tokens are
        // NOT checked against users.token_version (only refresh tokens are — that asymmetry is
        // what makes multi-tab rotation safe), so a live access token is UNREVOCABLE until it
        // expires: neither /api/auth/logout nor the "revoke sessions" kill-switch nor a
        // password change can kill it. The idle window IS the access-token TTL, so it is also
        // the window in which those controls do nothing. 24 h is a defensible worst case for
        // "operator clicked revoke after a laptop theft"; the 168 h the settings validator
        // used to allow was a week of unrevocable admin access.
        if (Number.isFinite(i) && i >= 300 && i <= 24 * 3600) idle = Math.floor(i);
        // Ceiling of 168 h = the refresh token's own lifetime. Above that the refresh JWT
        // expires first, so a "30 day" cap would silently behave as 7 days — the same
        // silent-underdelivery trap as writing "10d" into a seconds-only fail2ban field.
        if (Number.isFinite(a) && a >= 3600 && a <= 168 * 3600) abs = Math.floor(a);
      }
    } catch (e) { /* fall through to defaults */ }
    // An absolute cap below the idle window is incoherent (the session would die mid-use
    // with no way to renew). Validators can't catch it — they see one key at a time.
    if (abs < idle) abs = idle;
    return { idle, abs };
  }

  async registerAdmin(username, password) {
    try {
      if (!username || !password) {
        throw new Error('Username and password required');
      }

      if (username.length < 3) {
        throw new Error('Username must be at least 3 characters');
      }

      if (password.length < 8) {
        throw new Error('Password must be at least 8 characters');
      }

      const existing = this.db.prepare(
        'SELECT id FROM users WHERE username = ?'
      ).get(username);

      if (existing) {
        throw new Error('Username already exists');
      }

      const hashedPassword = await this.hashPassword(password);

      const stmt = this.db.prepare(`
        INSERT INTO users (username, password_hash, is_admin, is_active)
        VALUES (?, ?, 1, 1)
      `);

      const result = stmt.run(username, hashedPassword);

      return {
        success: true,
        user_id: result.lastInsertRowid,
        username,
        is_admin: true
      };
    } catch (err) {
      return {
        success: false,
        error: err.message
      };
    }
  }

  // ─── Login lockout, keyed on (username, IP) ─────────────────────────────────
  // See the constructor for why the key is the pair and not the username alone.

  _lockKey(username, ip) {
    // \0 can't occur in either part, so the key is unambiguous even for odd usernames.
    return `${String(username == null ? '' : username).toLowerCase()}\0${ip || 'unknown'}`;
  }

  // Drop expired entries; hard-cap the Map so a botnet spraying random usernames can't
  // grow it without bound (oldest-inserted go first — Map preserves insertion order).
  _pruneLockouts() {
    const now = Math.floor(Date.now() / 1000);
    for (const [k, v] of this.lockouts) {
      const dead = (v.lockedUntil || 0) <= now &&
                   (now - (v.firstAt || 0)) > this.lockoutWindowSeconds;
      if (dead) this.lockouts.delete(k);
    }
    if (this.lockouts.size > this.lockoutMaxEntries) {
      let excess = this.lockouts.size - this.lockoutMaxEntries;
      for (const k of this.lockouts.keys()) {
        this.lockouts.delete(k);
        if (--excess <= 0) break;
      }
    }
  }

  // Is this (username, IP) pair currently locked? Seconds remaining, or 0 if not locked.
  lockoutRemaining(username, ip) {
    const e = this.lockouts.get(this._lockKey(username, ip));
    if (!e || !e.lockedUntil) return 0;
    const now = Math.floor(Date.now() / 1000);
    return e.lockedUntil > now ? (e.lockedUntil - now) : 0;
  }

  // Count one failed attempt for the pair; lock it once the threshold is hit inside the
  // window. Returns true if this failure caused (or extended) a lock.
  _recordPairFailure(username, ip) {
    this._pruneLockouts();
    const now = Math.floor(Date.now() / 1000);
    const key = this._lockKey(username, ip);
    let e = this.lockouts.get(key);
    // Start a fresh count if there's no entry or the previous window has elapsed.
    if (!e || (now - (e.firstAt || 0)) > this.lockoutWindowSeconds) {
      e = { attempts: 0, firstAt: now, lockedUntil: 0 };
    }
    e.attempts++;
    if (e.attempts >= this.maxFailedAttempts) {
      e.lockedUntil = now + this.lockoutDurationSeconds;
      e.attempts = 0;          // restart counting after the cooldown
      e.firstAt = now;
    }
    this.lockouts.set(key, e);
    return !!e.lockedUntil && e.lockedUntil > now;
  }

  _clearPairFailures(username, ip) {
    this.lockouts.delete(this._lockKey(username, ip));
  }

  // Active locks, for the admin Login Security panel. Username is reported because the
  // operator needs to know WHICH account is being ground; the IP is the operator's own
  // security data (see the audit-IP note in lib/owner-proof.js) and is reported in full so
  // it can be blackholed.
  getActiveLockouts() {
    this._pruneLockouts();
    const now = Math.floor(Date.now() / 1000);
    const out = [];
    for (const [k, v] of this.lockouts) {
      if (!v.lockedUntil || v.lockedUntil <= now) continue;
      const sep = k.indexOf('\0');
      out.push({
        username: k.slice(0, sep),
        ip: k.slice(sep + 1),
        locked_until: v.lockedUntil,
        seconds_remaining: v.lockedUntil - now,
      });
    }
    return out.sort((a, b) => b.locked_until - a.locked_until);
  }

  async login(username, password, ip = null) {
    try {
      const now = Math.floor(Date.now() / 1000);

      // Pair lockout is checked FIRST — before the user lookup — so a locked source costs
      // no bcrypt work at all. It behaves identically for existing and non-existing
      // usernames, so it adds no enumeration oracle.
      const remaining = this.lockoutRemaining(username, ip);
      if (remaining > 0) {
        return {
          success: false,
          error: 'Too many failed attempts from this location. Try again later.',
          locked: true,
          retry_after_seconds: remaining
        };
      }
      const user = this.db.prepare(
        'SELECT * FROM users WHERE username = ?'
      ).get(username);

      if (!user) {
        // Equalize timing with the valid-username path. Without a bcrypt compare here the
        // response for an unknown username returns measurably faster than for a known one,
        // giving a remote attacker a username-enumeration oracle (the generic error message
        // alone doesn't close this — the timing does). Run one throwaway compare against a
        // cached dummy hash at the same cost so both paths take ~the same wall-clock time.
        await this.comparePassword(password, await this._dummyHash());
        // Count it: username guessing must be rate-limited the same way password guessing
        // is, or the lock could be sidestepped by spraying names.
        this._recordPairFailure(username, ip);
        return {
          success: false,
          error: 'Invalid username or password'
        };
      }

      if (!user.is_active) {
        return {
          success: false,
          error: 'Account is disabled'
        };
      }

      const passwordValid = await this.comparePassword(password, user.password_hash);

      if (!passwordValid) {
        // Lock the (username, IP) pair, not the account — see the constructor note.
        this._recordPairFailure(username, ip);
        // users.failed_login_attempts is still maintained as a VISIBILITY signal ("this
        // account is being ground, from somewhere"), surfaced in the admin Login Security
        // panel. users.locked_until is deliberately no longer written or read: it was the
        // remotely-triggerable operator lockout. Force it to 0 so a value left over from
        // an older build can't keep an operator out after upgrading.
        this.db.prepare(
          'UPDATE users SET failed_login_attempts = ?, locked_until = 0, updated_at = ? WHERE id = ?'
        ).run((user.failed_login_attempts || 0) + 1, now, user.id);
        return {
          success: false,
          error: 'Invalid username or password'
        };
      }

      // Success: clear failure state for this pair and the account's visibility counter.
      this._clearPairFailures(username, ip);
      if (user.failed_login_attempts || user.locked_until) {
        this.db.prepare(
          'UPDATE users SET failed_login_attempts = 0, locked_until = 0, updated_at = ? WHERE id = ?'
        ).run(now, user.id);
      }

      // pwa = "password-verified-at": login is a real password check, so stamp it now.
      // Step-up (requireFreshAuth) checks this, NOT iat — a silent token refresh must not
      // grant freshness (see refreshAccessToken, which passes pwa=0).
      const now2 = Math.floor(Date.now() / 1000);
      const tokens = this.generateTokens(user.id, user.username, user.is_admin, user.token_version || 0, now2);

      this.logLoginAttempt(user.id, true, ip);

      return {
        success: true,
        user_id: user.id,
        username: user.username,
        is_admin: user.is_admin,
        access_token: tokens.accessToken,
        refresh_token: tokens.refreshToken,
        expires_in: this._sessionPolicy().idle
      };
    } catch (err) {
      return {
        success: false,
        error: err.message
      };
    }
  }

  // Public read of the live policy — index.js needs it for cookie lifetimes and to tell the
  // admin client its idle window (/api/admin/me).
  sessionPolicy() {
    return this._sessionPolicy();
  }

  // pwa = password-verified-at (unix seconds). 0 = "not freshly password-verified"
  // (e.g. minted by a silent refresh). Step-up auth reads this, never iat.
  //
  // sst = session-started-at (unix seconds), the anchor for the ABSOLUTE cap. It must be
  // carried unchanged through every silent refresh and every step-up — if any of those reset
  // it, sliding refresh becomes an unbounded session and the cap is decorative. Omitted =
  // this is a brand-new session (a real password login), so it starts at now.
  generateTokens(userId, username, isAdmin, tokenVersion = 0, pwa = 0, sst = 0) {
    const now = Math.floor(Date.now() / 1000);
    const sessionStart = sst > 0 ? sst : now;
    const { idle } = this._sessionPolicy();

    const accessToken = jwt.sign(
      {
        user_id: userId,
        username,
        is_admin: isAdmin ? 1 : 0,
        tv: tokenVersion,
        pwa: pwa,
        sst: sessionStart,
        iat: now,
        type: 'access'
      },
      this.jwtSecret,
      { expiresIn: idle }
    );

    // The refresh token carries the token_version it was minted against. On each
    // refresh we bump the user's token_version, so a previously issued (or stolen)
    // refresh token no longer matches and is rejected — see refreshAccessToken().
    const refreshToken = jwt.sign(
      {
        user_id: userId,
        tv: tokenVersion,
        sst: sessionStart,
        type: 'refresh'
      },
      this.jwtSecret,
      { expiresIn: this.refreshTokenExpiresIn }
    );

    return { accessToken, refreshToken };
  }

  verifyToken(token) {
    try {
      const decoded = jwt.verify(token, this.jwtSecret);
      return {
        valid: true,
        payload: decoded
      };
    } catch (err) {
      return {
        valid: false,
        error: err.message
      };
    }
  }

  verifyAccessToken(token) {
    const result = this.verifyToken(token);
    if (!result.valid) return result;

    if (result.payload.type !== 'access') {
      return {
        valid: false,
        error: 'Invalid token type'
      };
    }

    return result;
  }

  refreshAccessToken(refreshToken) {
    try {
      const decoded = jwt.verify(refreshToken, this.jwtSecret);

      if (decoded.type !== 'refresh') {
        throw new Error('Invalid token type');
      }

      const user = this.db.prepare(
        'SELECT * FROM users WHERE id = ?'
      ).get(decoded.user_id);

      if (!user || !user.is_active) {
        throw new Error('User not found or inactive');
      }

      // Revocation/rotation check: the presented refresh token must match the current
      // token_version. A stale token (already rotated, or revoked via logout/password
      // change) is rejected here — closing the "stolen refresh token valid for its full
      // lifetime" gap.
      const currentVersion = user.token_version || 0;
      if ((decoded.tv || 0) !== currentVersion) {
        throw new Error('Refresh token revoked');
      }

      // Absolute cap: a sliding refresh can extend a session indefinitely while the operator
      // keeps interacting, so the only thing bounding total session age is this check. The
      // anchor is the ORIGINAL login (sst), carried through every rotation. Legacy tokens
      // minted before sst existed fall back to iat — one cap-length grace, then normal rules.
      const nowSec = Math.floor(Date.now() / 1000);
      const policy = this._sessionPolicy();
      const sessionStart = Number(decoded.sst) || Number(decoded.iat) || nowSec;
      if ((nowSec - sessionStart) > policy.abs) {
        // Distinct code so the client can say "please sign in again" rather than showing a
        // generic failure and retrying forever.
        return { success: false, error: 'Session expired — please sign in again', session_expired: true };
      }

      // Rotate: bump the version so THIS refresh token can't be replayed.
      const nextVersion = currentVersion + 1;
      this.db.prepare(
        'UPDATE users SET token_version = ?, updated_at = ? WHERE id = ?'
      ).run(nextVersion, nowSec, user.id);

      // pwa stays 0: a silent refresh is NOT a password check and must never grant step-up
      // freshness. sst is preserved so the cap above keeps counting from the real login.
      const tokens = this.generateTokens(user.id, user.username, user.is_admin, nextVersion, 0, sessionStart);

      return {
        success: true,
        access_token: tokens.accessToken,
        refresh_token: tokens.refreshToken,
        expires_in: policy.idle,
        session_started_at: sessionStart,
        session_absolute_seconds: policy.abs
      };
    } catch (err) {
      return {
        success: false,
        error: err.message
      };
    }
  }

  // Logout helper: verify a refresh token and revoke that user's sessions. Returns
  // true if a user was revoked. Invalid/expired tokens are ignored (nothing to revoke).
  revokeByRefreshToken(refreshToken) {
    if (!refreshToken) return false;
    try {
      const decoded = jwt.verify(refreshToken, this.jwtSecret);
      if (decoded && decoded.user_id) return this.revokeUserTokens(decoded.user_id);
    } catch (_) { /* invalid/expired → nothing to revoke */ }
    return false;
  }

  // Invalidate all of a user's refresh tokens (logout / password change / disable).
  // Bumping token_version makes every previously issued refresh token stale.
  revokeUserTokens(userId) {
    try {
      this.db.prepare(
        'UPDATE users SET token_version = token_version + 1, updated_at = ? WHERE id = ?'
      ).run(Math.floor(Date.now() / 1000), userId);
      return true;
    } catch (err) {
      console.error(`Error revoking tokens for user ${userId}: ${err.message}`);
      return false;
    }
  }

  async changePassword(userId, oldPassword, newPassword) {
    try {
      const user = this.db.prepare(
        'SELECT * FROM users WHERE id = ?'
      ).get(userId);

      if (!user) {
        throw new Error('User not found');
      }

      const passwordValid = await this.comparePassword(oldPassword, user.password_hash);
      if (!passwordValid) {
        throw new Error('Current password is incorrect');
      }

      if (newPassword.length < 8) {
        throw new Error('New password must be at least 8 characters');
      }

      const hashedPassword = await this.hashPassword(newPassword);

      const stmt = this.db.prepare(
        'UPDATE users SET password_hash = ? WHERE id = ?'
      );
      stmt.run(hashedPassword, userId);

      // Revoke all existing refresh tokens after a password change.
      this.revokeUserTokens(userId);

      return {
        success: true,
        message: 'Password changed successfully'
      };
    } catch (err) {
      return {
        success: false,
        error: err.message
      };
    }
  }

  // ─── Optional admin TOTP 2FA ───────────────────────────────────────────────
  isTotpEnabled(userId) {
    const u = this.db.prepare('SELECT totp_enabled FROM users WHERE id = ?').get(userId);
    return !!(u && u.totp_enabled);
  }

  // Start enrollment: generate a secret, stash it as pending (NOT yet active), return the
  // secret + otpauth URI for the QR / manual entry. Activated only by begin→confirm.
  begin2faEnrollment(userId, issuer = 'Grin Pool') {
    const u = this.db.prepare('SELECT username FROM users WHERE id = ?').get(userId);
    if (!u) return { success: false, error: 'User not found' };
    const secret = totp.generateSecret();
    this.db.prepare('UPDATE users SET totp_pending_secret = ?, updated_at = ? WHERE id = ?')
      .run(secret, Math.floor(Date.now() / 1000), userId);
    return { success: true, secret, otpauth_uri: totp.keyuri(secret, u.username, issuer) };
  }

  // Confirm enrollment: the admin proves the authenticator works by entering a current code.
  // On success the pending secret becomes active and a fresh set of recovery codes is issued
  // (returned in plaintext ONCE — only hashes are stored).
  async confirm2faEnrollment(userId, code) {
    const u = this.db.prepare('SELECT totp_pending_secret FROM users WHERE id = ?').get(userId);
    if (!u || !u.totp_pending_secret) return { success: false, error: 'No enrollment in progress' };
    if (!totp.verify(u.totp_pending_secret, code)) return { success: false, error: 'Incorrect code — check your authenticator and try again' };
    this.db.prepare('UPDATE users SET totp_secret = ?, totp_enabled = 1, totp_pending_secret = NULL, updated_at = ? WHERE id = ?')
      .run(u.totp_pending_secret, Math.floor(Date.now() / 1000), userId);
    const recovery_codes = await this.generateRecoveryCodes(userId);
    return { success: true, recovery_codes };
  }

  // Disable 2FA — requires a valid current TOTP or recovery code (verified by the caller's
  // route via verifyTotpOrRecovery before calling, or pass the code here).
  async disable2fa(userId, code) {
    const ok = await this.verifyTotpOrRecovery(userId, code);
    if (!ok) return { success: false, error: 'Incorrect 2FA / recovery code' };
    this.db.prepare('UPDATE users SET totp_secret = NULL, totp_enabled = 0, totp_pending_secret = NULL, updated_at = ? WHERE id = ?')
      .run(Math.floor(Date.now() / 1000), userId);
    this.db.prepare('DELETE FROM admin_recovery_codes WHERE user_id = ?').run(userId);
    return { success: true };
  }

  // Verify a 6-digit TOTP OR a one-time backup recovery code. Recovery codes are consumed.
  async verifyTotpOrRecovery(userId, code) {
    const u = this.db.prepare('SELECT totp_secret FROM users WHERE id = ?').get(userId);
    if (!u || !u.totp_secret) return false;
    const raw = String(code == null ? '' : code).trim();
    if (/^\d{6}$/.test(raw.replace(/\s+/g, ''))) {
      return totp.verify(u.totp_secret, raw);
    }
    // Recovery code path: normalise (strip separators, uppercase), compare against unused hashes.
    const norm = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!norm) return false;
    const rows = this.db.prepare('SELECT id, code_hash FROM admin_recovery_codes WHERE user_id = ? AND used_at IS NULL').all(userId);
    for (const row of rows) {
      if (await bcrypt.compare(norm, row.code_hash)) {
        this.db.prepare('UPDATE admin_recovery_codes SET used_at = ? WHERE id = ?')
          .run(Math.floor(Date.now() / 1000), row.id);
        return true;
      }
    }
    return false;
  }

  // (Re)generate 10 one-time backup codes; replaces any existing ones. Returns plaintext.
  // async + await bcrypt.hash so 10 hashes don't block the shared event loop (stratum/API).
  async generateRecoveryCodes(userId, count = 10) {
    this.db.prepare('DELETE FROM admin_recovery_codes WHERE user_id = ?').run(userId);
    const codes = [];
    const ins = this.db.prepare('INSERT INTO admin_recovery_codes (user_id, code_hash) VALUES (?, ?)');
    for (let i = 0; i < count; i++) {
      // 10 base32 chars, shown grouped as XXXXX-XXXXX (stored uppercase, no dash).
      const raw = totp.base32Encode(crypto.randomBytes(7)).slice(0, 10);
      const pretty = raw.slice(0, 5) + '-' + raw.slice(5);
      const hash = await bcrypt.hash(raw, this.bcryptRounds);
      ins.run(userId, hash);
      codes.push(pretty);
    }
    return codes;
  }

  unusedRecoveryCount(userId) {
    const r = this.db.prepare('SELECT COUNT(*) AS c FROM admin_recovery_codes WHERE user_id = ? AND used_at IS NULL').get(userId);
    return r ? r.c : 0;
  }

  // Short-lived token that proves the password step passed; the holder may complete the 2FA
  // step (POST /api/auth/login/totp). Not a session — confers no admin access by itself.
  generate2faToken(userId) {
    return jwt.sign({ user_id: userId, type: '2fa' }, this.jwtSecret, { expiresIn: 300 });
  }

  verify2faToken(token) {
    try {
      const d = jwt.verify(token, this.jwtSecret);
      if (d.type !== '2fa') return null;
      return d.user_id;
    } catch (e) { return null; }
  }

  // Build session tokens for an already-authenticated user (used after the 2FA step). pwa=now
  // because the password WAS verified in the preceding step (step-up-fresh on login).
  issueSessionFor(userId) {
    const user = this.db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    if (!user || !user.is_active) return { success: false, error: 'User not found or inactive' };
    const now = Math.floor(Date.now() / 1000);
    const tokens = this.generateTokens(user.id, user.username, user.is_admin, user.token_version || 0, now);
    return {
      success: true,
      user_id: user.id,
      username: user.username,
      is_admin: user.is_admin,
      access_token: tokens.accessToken,
      refresh_token: tokens.refreshToken,
    };
  }

  // Cached dummy bcrypt hash (at the configured cost) used only to burn the same CPU time
  // as a real comparePassword when the username doesn't exist — see login(). Computed once,
  // lazily, against a random throwaway secret; it never matches any real password.
  async _dummyHash() {
    if (!this._dummyHashCache) {
      this._dummyHashCache = await bcrypt.hash(crypto.randomBytes(16).toString('hex'), this.bcryptRounds);
    }
    return this._dummyHashCache;
  }

  async hashPassword(password) {
    const salt = await bcrypt.genSalt(this.bcryptRounds);
    return bcrypt.hash(password, salt);
  }

  async comparePassword(password, hash) {
    return bcrypt.compare(password, hash);
  }

  logLoginAttempt(userId, success, ip = null) {
    try {
      const stmt = this.db.prepare(`
        INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, ip)
        VALUES (?, ?, 'auth', 'login', ?)
      `);
      // 'login_failed' is the canonical failure action — index.js's login route writes that
      // spelling, and the Login Security reader filters on it. This branch must not disagree.
      stmt.run(userId, success ? 'login_success' : 'login_failed', ip);
    } catch (err) {
      console.error(`Error logging login attempt: ${err.message}`);
    }
  }

  // Freshness for step-up auth = time since the last PASSWORD verification (pwa), not iat.
  // A token minted by a silent refresh carries pwa=0 and is therefore never "fresh", so an
  // attacker with a stolen cookie can't refresh their way into sensitive actions — they must
  // present the password again via stepUp().
  isTokenFresh(token, maxAgeSeconds = 300) {
    const result = this.verifyAccessToken(token);
    if (!result.valid) return false;

    const pwa = result.payload.pwa || 0;
    if (!pwa) return false;

    const now = Math.floor(Date.now() / 1000);
    return (now - pwa) <= maxAgeSeconds;
  }

  // Re-authenticate an already-logged-in admin: verify the password and mint a NEW access
  // token stamped pwa=now (same token_version, so the existing refresh token stays valid).
  // Powers the step-up challenge on money/destructive endpoints.
  async stepUp(userId, password, sst = 0) {
    try {
      const user = this.db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
      if (!user || !user.is_active) return { success: false, error: 'User not found' };
      const ok = await this.comparePassword(password, user.password_hash);
      if (!ok) return { success: false, error: 'Incorrect password' };
      const now = Math.floor(Date.now() / 1000);
      // sst comes from the CALLER's existing token: a step-up re-verifies the password but
      // does not start a new session, so it must not reset the absolute cap. (Without this,
      // any admin could sit past the cap forever by stepping up.)
      const tokens = this.generateTokens(user.id, user.username, user.is_admin, user.token_version || 0, now, sst);
      return { success: true, access_token: tokens.accessToken };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }
}

module.exports = AuthManager;
