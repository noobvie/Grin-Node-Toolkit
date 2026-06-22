/**
 * Rate Limiter Middleware — Flexible per-endpoint request throttling
 *
 * Tracks requests per IP address and enforces limits.
 * Supports burst allowance and exponential backoff on violations.
 */

class RateLimiter {
  constructor(config = {}) {
    this.config = config;
    // Buckets are keyed by `<limitType>|<ip>`, NOT by IP alone — each limit type
    // (public/auth/api/admin) gets its OWN per-IP counter. Sharing one per-IP array
    // across all types meant the strict `auth` budget (10/min) was measured against the
    // IP's TOTAL request volume (captcha + /api/config + admin dashboard polls + assets),
    // so a single login-page load tripped "Too many requests" before the first real login
    // attempt — and the resulting violation lockout then blocked every endpoint.
    this.requests = new Map();      // `<type>|<ip>` → array of timestamps
    this.violations = new Map();    // `<type>|<ip>` → violation count + lockout time
    this.cleanupInterval = null;

    // Default limits (requests per minute). NOTE: the values below carry the 2026-06
    // ×20 "loosen now" bump (see the assignment); the rationale numbers in this comment
    // are the PRE-bump baselines that explain why each bucket exists.
    // `auth` covers POST login / register / 2FA. It is intentionally low (baseline 10/min)
    // to blunt password brute force, but must still allow a human to fumble the form a few
    // times. The peek/consume split below (a failed CAPTCHA never spends a token — see
    // index.js) keeps legit operators from locking themselves out.
    // `admin` covers the authenticated admin panel, which is a POLLING dashboard: a single
    // page load fires several /api/admin/* calls (guardAdminPage's /me, health x3, settings
    // sections, db status…) and health.html auto-refreshes every 30s. The old 10/min baseline
    // locked operators out instantly and cascaded into spurious logouts (a 429 used to bounce
    // to /login), which is why it was raised to 120/min, then ×20. The admin surface is already
    // gated by JWT + login captcha + per-account lockout + IP auto-ban + (optional) the nginx
    // admin_allowlist, so this limiter is DoS-padding, not the brute-force control.
    // NOTE: all four buckets were multiplied ×20 in 2026-06 ("loosen now, tighten
    // later" testing posture) so request throttling never breaks normal browsing or
    // admin polling. These are DoS-padding only — the real brute-force controls are
    // JWT + login captcha + per-account lockout + IP auto-ban (in index.js), which were
    // deliberately NOT loosened. Dial these back down when you tighten security.
    this.limits = {
      public: 1200,
      auth: 200,
      api: 600,
      admin: 2400
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

      const key = this.bucketKey(limitType, clientIp);
      const isAllowed = this.checkLimit(key, limit);

      if (!isAllowed) {
        const violation = this.violations.get(key);
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
      const remaining = this.getRemainingRequests(key, limit);
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
    const key = this.bucketKey(limitType, ip);
    const now = Date.now();

    if (this.violations.has(key)) {
      const v = this.violations.get(key);
      if (v.lockedUntil > now) {
        return { allowed: false, ip, limit, retryAfter: Math.ceil((v.lockedUntil - now) / 1000) };
      }
    }

    const windowMs = 60 * 1000;
    const recent = (this.requests.get(key) || []).filter(t => now - t < windowMs);
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
    return this.checkLimit(this.bucketKey(limitType, this.getClientIp(req)), limit);
  }

  /**
   * Build the per-(type,IP) bucket key. limitType comes from a fixed internal set
   * (public/auth/api/admin) with no '|', so this never collides across IPs.
   */
  bucketKey(limitType, ip) {
    return `${limitType}|${ip}`;
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
  checkLimit(key, limit) {
    const now = Date.now();
    const windowMs = 60 * 1000; // 1 minute window

    // Check if this bucket is in violation (lockout)
    if (this.violations.has(key)) {
      const violation = this.violations.get(key);
      if (violation.lockedUntil > now) {
        // Still locked out
        violation.attemptedRequests++;
        return false;
      } else {
        // Lockout expired — reset
        this.violations.delete(key);
      }
    }

    // Get requests for this bucket in current window
    if (!this.requests.has(key)) {
      this.requests.set(key, []);
    }

    const bucketRequests = this.requests.get(key);
    const recentRequests = bucketRequests.filter(t => now - t < windowMs);

    if (recentRequests.length >= limit) {
      // Limit exceeded — enter lockout
      const violationCount = (this.violations.get(key)?.count || 0) + 1;
      const lockoutDuration = Math.min(
        30000 * Math.pow(2, violationCount - 1), // Exponential backoff: 30s → 60s → 120s
        3600000 // Cap at 1 hour
      );

      this.violations.set(key, {
        count: violationCount,
        lockedUntil: now + lockoutDuration,
        attemptedRequests: 1
      });

      return false;
    }

    // Request allowed — record it
    recentRequests.push(now);
    this.requests.set(key, recentRequests);

    return true;
  }

  /**
   * Get remaining requests for IP in current window
   */
  getRemainingRequests(key, limit) {
    const now = Date.now();
    const windowMs = 60 * 1000;

    if (!this.requests.has(key)) {
      return limit;
    }

    const bucketRequests = this.requests.get(key);
    const recentRequests = bucketRequests.filter(t => now - t < windowMs);

    return Math.max(0, limit - recentRequests.length);
  }

  /**
   * Get current status for an IP (for debugging)
   */
  getStatus(ip) {
    const now = Date.now();
    const windowMs = 60 * 1000;
    const suffix = '|' + ip;

    // Sum across this IP's per-type buckets.
    let requestCount = 0;
    this.requests.forEach((timestamps, key) => {
      if (key.endsWith(suffix)) {
        requestCount += timestamps.filter(t => now - t < windowMs).length;
      }
    });

    let violationStatus = null;
    this.violations.forEach((v, key) => {
      if (key.endsWith(suffix) && v.lockedUntil > now) {
        violationStatus = {
          count: v.count,
          locked_until: v.lockedUntil,
          seconds_remaining: Math.max(0, (v.lockedUntil - now) / 1000)
        };
      }
    });

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
    const suffix = '|' + ip;
    for (const key of [...this.requests.keys()]) {
      if (key.endsWith(suffix)) this.requests.delete(key);
    }
    for (const key of [...this.violations.keys()]) {
      if (key.endsWith(suffix)) this.violations.delete(key);
    }
    this.log(`Rate limit reset for ${ip}`);
  }

  /**
   * Get all IPs currently in violation
   */
  getViolations() {
    const now = Date.now();
    const active = [];

    this.violations.forEach((v, key) => {
      if (v.lockedUntil > now) {
        const sep = key.indexOf('|');
        active.push({
          ip: sep >= 0 ? key.slice(sep + 1) : key,
          limit_type: sep >= 0 ? key.slice(0, sep) : '',
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
      this.requests.forEach((timestamps, key) => {
        const recent = timestamps.filter(t => now - t < windowMs);
        if (recent.length === 0) {
          this.requests.delete(key);
        } else {
          this.requests.set(key, recent);
        }
      });

      // Clean expired violations
      this.violations.forEach((v, key) => {
        if (v.lockedUntil <= now) {
          this.violations.delete(key);
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
