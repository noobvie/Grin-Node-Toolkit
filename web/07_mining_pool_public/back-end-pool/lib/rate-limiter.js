/**
 * Rate Limiter Middleware — Flexible per-endpoint request throttling
 *
 * Tracks requests per IP address and enforces limits.
 * Supports burst allowance and exponential backoff on violations.
 */

class RateLimiter {
  constructor(config = {}) {
    this.config = config;
    this.requests = new Map();      // IP → array of timestamps
    this.violations = new Map();    // IP → violation count + lockout time
    this.cleanupInterval = null;

    // Default limits (requests per minute)
    // `auth` covers POST login / register / 2FA. It is intentionally low to blunt
    // password brute force, but must still allow a human to fumble the form a few
    // times. 10/min + the peek/consume split below (a failed CAPTCHA never spends a
    // token — see index.js) keeps legit operators from locking themselves out.
    this.limits = {
      public: 60,
      auth: 10,
      api: 30,
      admin: 10
    };

    // Override with config
    if (config.rate_limits) {
      Object.assign(this.limits, config.rate_limits);
    }

    this.log(`Initialized (public: ${this.limits.public}/min, admin: ${this.limits.admin}/min)`);

    // Cleanup old entries every 5 minutes
    this.startCleanup();
  }

  /**
   * Middleware factory: returns express middleware
   * Usage: app.use(rateLimiter.middleware('public'))
   */
  middleware(limitType = 'api') {
    return (req, res, next) => {
      const clientIp = this.getClientIp(req);
      const limit = this.limits[limitType];

      if (!limit) {
        // No limit configured for this type
        return next();
      }

      const isAllowed = this.checkLimit(clientIp, limit);

      if (!isAllowed) {
        const violation = this.violations.get(clientIp);
        const retryAfter = Math.ceil((violation.lockedUntil - Date.now()) / 1000);

        res.set('Retry-After', Math.max(retryAfter, 1));
        res.set('X-RateLimit-Limit', limit);
        res.set('X-RateLimit-Remaining', 0);
        res.set('X-RateLimit-Reset', new Date(violation.lockedUntil).toISOString());

        this.log(`Rate limit exceeded: ${clientIp} (${limitType}, limit: ${limit}/min)`);

        return res.status(429).json({
          error: 'Too many requests',
          message: `Rate limit exceeded. Retry after ${retryAfter} seconds.`,
          retry_after_seconds: retryAfter,
          limit: limit,
          window_minutes: 1
        });
      }

      // Add rate limit headers
      const remaining = this.getRemainingRequests(clientIp, limit);
      res.set('X-RateLimit-Limit', limit);
      res.set('X-RateLimit-Remaining', remaining);
      res.set('X-RateLimit-Reset', new Date(Date.now() + 60000).toISOString());

      next();
    };
  }

  /**
   * Peek: would this request be allowed, WITHOUT recording it?
   * Lets a handler gate on the limit before deciding whether the request is a
   * genuine credential attempt (consume) or should be free (e.g. a wrong CAPTCHA).
   * Returns { allowed:true } or { allowed:false, ip, limit, retryAfter }.
   */
  peek(limitType, req) {
    const limit = this.limits[limitType];
    if (!limit) return { allowed: true };

    const ip = this.getClientIp(req);
    const now = Date.now();

    if (this.violations.has(ip)) {
      const v = this.violations.get(ip);
      if (v.lockedUntil > now) {
        return { allowed: false, ip, limit, retryAfter: Math.ceil((v.lockedUntil - now) / 1000) };
      }
    }

    const windowMs = 60 * 1000;
    const recent = (this.requests.get(ip) || []).filter(t => now - t < windowMs);
    if (recent.length >= limit) {
      return { allowed: false, ip, limit, retryAfter: 60 };
    }
    return { allowed: true, ip, limit };
  }

  /**
   * Consume one token against a limit (records the request; may trigger lockout).
   * Call only for requests that should count — typically after a CAPTCHA has passed.
   */
  consume(limitType, req) {
    const limit = this.limits[limitType];
    if (!limit) return true;
    return this.checkLimit(this.getClientIp(req), limit);
  }

  /**
   * Emit the standard 429 response for a failed peek/consume. Mirrors the body
   * produced by middleware() so clients see one consistent shape.
   */
  sendLimited(res, peekResult) {
    const limit = peekResult.limit;
    const retryAfter = Math.max(peekResult.retryAfter || 1, 1);
    res.set('Retry-After', retryAfter);
    res.set('X-RateLimit-Limit', limit);
    res.set('X-RateLimit-Remaining', 0);
    this.log(`Rate limit exceeded: ${peekResult.ip} (limit: ${limit}/min)`);
    return res.status(429).json({
      error: 'Too many requests',
      message: `Rate limit exceeded. Retry after ${retryAfter} seconds.`,
      retry_after_seconds: retryAfter,
      limit: limit,
      window_minutes: 1
    });
  }

  /**
   * Check if request is allowed under rate limit
   * Returns true if allowed, false if limit exceeded
   */
  checkLimit(ip, limit) {
    const now = Date.now();
    const windowMs = 60 * 1000; // 1 minute window

    // Check if IP is in violation (lockout)
    if (this.violations.has(ip)) {
      const violation = this.violations.get(ip);
      if (violation.lockedUntil > now) {
        // Still locked out
        violation.attemptedRequests++;
        return false;
      } else {
        // Lockout expired — reset
        this.violations.delete(ip);
      }
    }

    // Get requests for this IP in current window
    if (!this.requests.has(ip)) {
      this.requests.set(ip, []);
    }

    const ipRequests = this.requests.get(ip);
    const recentRequests = ipRequests.filter(t => now - t < windowMs);

    if (recentRequests.length >= limit) {
      // Limit exceeded — enter lockout
      const violationCount = (this.violations.get(ip)?.count || 0) + 1;
      const lockoutDuration = Math.min(
        30000 * Math.pow(2, violationCount - 1), // Exponential backoff: 30s → 60s → 120s
        3600000 // Cap at 1 hour
      );

      this.violations.set(ip, {
        count: violationCount,
        lockedUntil: now + lockoutDuration,
        attemptedRequests: 1
      });

      return false;
    }

    // Request allowed — record it
    recentRequests.push(now);
    this.requests.set(ip, recentRequests);

    return true;
  }

  /**
   * Get remaining requests for IP in current window
   */
  getRemainingRequests(ip, limit) {
    const now = Date.now();
    const windowMs = 60 * 1000;

    if (!this.requests.has(ip)) {
      return limit;
    }

    const ipRequests = this.requests.get(ip);
    const recentRequests = ipRequests.filter(t => now - t < windowMs);

    return Math.max(0, limit - recentRequests.length);
  }

  /**
   * Get current status for an IP (for debugging)
   */
  getStatus(ip) {
    const now = Date.now();
    const windowMs = 60 * 1000;

    let requestCount = 0;
    if (this.requests.has(ip)) {
      requestCount = this.requests.get(ip)
        .filter(t => now - t < windowMs).length;
    }

    let violationStatus = null;
    if (this.violations.has(ip)) {
      const v = this.violations.get(ip);
      violationStatus = {
        count: v.count,
        locked_until: v.lockedUntil,
        seconds_remaining: Math.max(0, (v.lockedUntil - now) / 1000)
      };
    }

    return {
      ip,
      requests_in_last_minute: requestCount,
      violations: violationStatus
    };
  }

  /**
   * Reset limit for an IP (admin action)
   */
  resetIp(ip) {
    this.requests.delete(ip);
    this.violations.delete(ip);
    this.log(`Rate limit reset for ${ip}`);
  }

  /**
   * Get all IPs currently in violation
   */
  getViolations() {
    const now = Date.now();
    const active = [];

    this.violations.forEach((v, ip) => {
      if (v.lockedUntil > now) {
        active.push({
          ip,
          violation_count: v.count,
          locked_until: new Date(v.lockedUntil).toISOString(),
          seconds_remaining: (v.lockedUntil - now) / 1000
        });
      }
    });

    return active;
  }

  /**
   * Extract client IP from request.
   * Uses Express's req.ip, which — with `app.set('trust proxy', 1)` in index.js —
   * resolves to the real client IP from X-Forwarded-For while IGNORING client-supplied
   * XFF beyond the one trusted nginx hop. Reading the raw x-forwarded-for header here
   * (as before) let a client rotate forged IPs and evade per-IP throttling/lockout.
   */
  getClientIp(req) {
    const ip = (req && (req.ip || (req.socket && req.socket.remoteAddress))) || 'unknown';
    return String(ip).replace('::ffff:', '');
  }

  /**
   * Start cleanup timer to remove old request records
   */
  startCleanup() {
    if (this.cleanupInterval) {
      return;
    }

    this.cleanupInterval = setInterval(() => {
      const now = Date.now();
      const windowMs = 60 * 1000;

      // Clean request records older than window
      this.requests.forEach((timestamps, ip) => {
        const recent = timestamps.filter(t => now - t < windowMs);
        if (recent.length === 0) {
          this.requests.delete(ip);
        } else {
          this.requests.set(ip, recent);
        }
      });

      // Clean expired violations
      this.violations.forEach((v, ip) => {
        if (v.lockedUntil <= now) {
          this.violations.delete(ip);
        }
      });
    }, 5 * 60 * 1000); // Every 5 minutes
  }

  stopCleanup() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }

  log(msg) {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] [RateLimiter] ${msg}`);
  }
}

module.exports = RateLimiter;
