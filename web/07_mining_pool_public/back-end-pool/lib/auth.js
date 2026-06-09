const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { getDb } = require('./db');

class AuthManager {
  constructor(config) {
    this.config = config;
    this.db = getDb();
    this.jwtSecret = config.jwt_secret;
    this.jwtExpiresIn = 3600;
    this.refreshTokenExpiresIn = 86400 * 7;
    this.sessionTimeout = 300;
    // Account lockout (per-username): blunts online password guessing even when the
    // attacker rotates source IPs (which defeats the per-IP rate limiter alone).
    this.maxFailedAttempts = config.max_failed_login_attempts || 5;
    this.lockoutDurationSeconds = config.lockout_duration_seconds || 900; // 15 min
    // bcrypt work factor (cost). ≥12 per the security audit.
    this.bcryptRounds = config.bcrypt_rounds || 12;
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

  async login(username, password, ip = null) {
    try {
      const now = Math.floor(Date.now() / 1000);
      const user = this.db.prepare(
        'SELECT * FROM users WHERE username = ?'
      ).get(username);

      if (!user) {
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

      // Account lockout: reject while locked, without revealing whether the password
      // was right (returns a generic locked message).
      if (user.locked_until && user.locked_until > now) {
        return {
          success: false,
          error: 'Account temporarily locked due to failed login attempts. Try again later.',
          locked: true
        };
      }

      const passwordValid = await this.comparePassword(password, user.password_hash);

      if (!passwordValid) {
        // Increment the failure counter; lock the account once the threshold is hit.
        const attempts = (user.failed_login_attempts || 0) + 1;
        if (attempts >= this.maxFailedAttempts) {
          this.db.prepare(
            'UPDATE users SET failed_login_attempts = ?, locked_until = ?, updated_at = ? WHERE id = ?'
          ).run(attempts, now + this.lockoutDurationSeconds, now, user.id);
        } else {
          this.db.prepare(
            'UPDATE users SET failed_login_attempts = ?, updated_at = ? WHERE id = ?'
          ).run(attempts, now, user.id);
        }
        return {
          success: false,
          error: 'Invalid username or password'
        };
      }

      // Success: clear any failure state.
      if (user.failed_login_attempts || user.locked_until) {
        this.db.prepare(
          'UPDATE users SET failed_login_attempts = 0, locked_until = 0, updated_at = ? WHERE id = ?'
        ).run(now, user.id);
      }

      const tokens = this.generateTokens(user.id, user.username, user.is_admin, user.token_version || 0);

      this.logLoginAttempt(user.id, true, ip);

      return {
        success: true,
        user_id: user.id,
        username: user.username,
        is_admin: user.is_admin,
        access_token: tokens.accessToken,
        refresh_token: tokens.refreshToken,
        expires_in: this.jwtExpiresIn
      };
    } catch (err) {
      return {
        success: false,
        error: err.message
      };
    }
  }

  generateTokens(userId, username, isAdmin, tokenVersion = 0) {
    const now = Math.floor(Date.now() / 1000);

    const accessToken = jwt.sign(
      {
        user_id: userId,
        username,
        is_admin: isAdmin ? 1 : 0,
        tv: tokenVersion,
        iat: now,
        type: 'access'
      },
      this.jwtSecret,
      { expiresIn: this.jwtExpiresIn }
    );

    // The refresh token carries the token_version it was minted against. On each
    // refresh we bump the user's token_version, so a previously issued (or stolen)
    // refresh token no longer matches and is rejected — see refreshAccessToken().
    const refreshToken = jwt.sign(
      {
        user_id: userId,
        tv: tokenVersion,
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

      // Rotate: bump the version so THIS refresh token can't be replayed.
      const nextVersion = currentVersion + 1;
      this.db.prepare(
        'UPDATE users SET token_version = ?, updated_at = ? WHERE id = ?'
      ).run(nextVersion, Math.floor(Date.now() / 1000), user.id);

      const tokens = this.generateTokens(user.id, user.username, user.is_admin, nextVersion);

      return {
        success: true,
        access_token: tokens.accessToken,
        refresh_token: tokens.refreshToken,
        expires_in: this.jwtExpiresIn
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
      stmt.run(userId, success ? 'login_success' : 'login_failure', ip);
    } catch (err) {
      console.error(`Error logging login attempt: ${err.message}`);
    }
  }

  isTokenFresh(token, maxAgeSeconds = 300) {
    const result = this.verifyAccessToken(token);
    if (!result.valid) return false;

    const now = Math.floor(Date.now() / 1000);
    const age = now - result.payload.iat;

    return age <= maxAgeSeconds;
  }
}

module.exports = AuthManager;
