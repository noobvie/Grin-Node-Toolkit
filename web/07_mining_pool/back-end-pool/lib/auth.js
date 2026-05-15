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

      const passwordValid = await this.comparePassword(password, user.password_hash);

      if (!passwordValid) {
        return {
          success: false,
          error: 'Invalid username or password'
        };
      }

      const tokens = this.generateTokens(user.id, user.username, user.is_admin);

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

  generateTokens(userId, username, isAdmin) {
    const now = Math.floor(Date.now() / 1000);

    const accessToken = jwt.sign(
      {
        user_id: userId,
        username,
        is_admin: isAdmin ? 1 : 0,
        iat: now,
        type: 'access'
      },
      this.jwtSecret,
      { expiresIn: this.jwtExpiresIn }
    );

    const refreshToken = jwt.sign(
      {
        user_id: userId,
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

      const tokens = this.generateTokens(user.id, user.username, user.is_admin);

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
    const salt = await bcrypt.genSalt(10);
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
      stmt.run(userId, success ? 'login_success' : 'login_failure', ip || 'unknown');
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
