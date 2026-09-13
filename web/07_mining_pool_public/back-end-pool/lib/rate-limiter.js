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
    // (public/auth/admin/…) gets its OWN per-IP counter. Sharing one per-IP array
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
    //
    // There was an `api: 600` bucket here until 2026-09-02. It was defined, documented, and was
    // middleware()'s default argument — and a sweep of every middleware()/peek()/consume() call
    // in index.js found ZERO uses of it (audit §J12-10). A bucket nobody references is a number
    // the next reviewer assumes covers something. Removed; middleware()'s default moved to
    // `public`. If a genuinely separate API tier is ever wanted, add it AND attach it.
    this.limits = {
      public: 1200,
      auth: 200,
      admin: 2400,
      // Bulk CSV downloads (account ledger / withdrawal history). Deliberately tight and
      // SEPARATE from `public` (1200/min) so a human's occasional export works but automated
      // download-spam of the all-time extract is cut off fast. Per-IP, per-minute.
      export: 10,
      // Tor reachability probes (GET /api/account/:addr/tor-check). SEPARATE from `public`
      // (1200/min) because this is the one read endpoint that does real OUTBOUND work per call —
      // a Tor circuit build plus up to torCheckRetries SOCKS connects — so on the shared public
      // budget one client could turn cheap HTTP into seconds of network work, 1200 times a minute.
      // It could not be fixed by tightening `public`: every page read shares that counter.
      //
      // The 60s response cache in index.js already makes REPEAT probes of one address free, so
      // this number is really about ENUMERATION — how many DISTINCT addresses one IP can probe
      // per minute. At 1200 you could walk the whole leaderboard sampling every miner's wallet
      // uptime in seconds; at 10 you cannot. Overridable via config.rate_limits.torcheck
      // (a value of 0 there DISABLES the bucket — see middleware()).
      torcheck: 10,
      // Money-write actions (withdraw / slatepack finalize / nostr-destination register+remove).
      // SEPARATE from `public` (1200/min) so ownership-proof guessing and payout spam are cut off
      // per-IP long before they can exhaust the (memory-hard) scrypt verify, WITHOUT touching the
      // loose budget every read endpoint shares. A real payout is only ~2 requests (create then
      // finalize); 20/min/IP leaves ample headroom for a small NAT'd farm while still blocking
      // automation. The per-IP proof throttle in owner-proof.js is the finer brute-force control;
      // this bucket is the coarse DoS pad in front of it. Overridable via config.rate_limits.withdraw
      // (a value of 0 there DISABLES the bucket — see middleware()).
      withdraw: 20,
      // Password RE-verification: POST /api/admin/reauth and POST /api/auth/change-password.
      // Deliberately the tightest bucket here, and deliberately NOT `admin` (2400/min) or
      // `auth` (200/min), which is what these two ran on.
      //
      // reauth is the entire step-up gate on every money/destructive route, so its budget is
      // the budget for guessing the admin password against a stolen session. At 2400/min that
      // was 3.46 M guesses/day against a password the register form only requires to be 8
      // characters. It is also the CPU lever: bcryptjs is pure JS on the same event loop that
      // validates stratum shares, ~304 ms per compare at cost 12, so 2400/min demanded 730
      // CPU-seconds per 60 s of wall clock — a session thief who never guesses the password
      // still stalls share intake. The (username, IP) lockout added in auth.js cannot fix that
      // half: the bcrypt runs BEFORE any counter can see the result. Only the bucket bounds it.
      //
      // 10/min is generous for the human it serves: a step-up lasts 5 minutes, so an operator
      // working through a payout run steps up a handful of times an hour. Audit §J2-1.
      stepup: 10
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
  middleware(limitType = 'public') {
    return (req, res, next) => {
      const clientIp = this.getClientIp(req);
      const limit = this.limits[limitType];

      if (!limit) {
        // No limit configured for this type — and note that a limit of 0 lands here too.
        // `config.rate_limits: { "torcheck": 0 }` therefore means DISABLED, not "block
        // everything". That is deliberate (it is the only way an operator can switch a bucket
        // off), but it is the opposite of what "0" reads like, so both comments above that
        // advertise an override say so explicitly. Audit §J12-10.
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
   * (the keys of this.limits: public/auth/admin/export/torcheck/withdraw/stepup), none of
   * which contains '|', so this never collides across IPs.
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
      }
      // Lockout EXPIRED — but the record is deliberately kept, with its `count` intact.
      //
      // This used to `delete` it here, which made the exponential backoff below unreachable
      // code (audit §J12-4): the only path that reads `violations.get(key)?.count` is the
      // escalation line, and by the time it ran the record had always just been removed — so
      // `count` was always 1, every lockout was 30 s, and the documented 30→60→120 ladder and
      // the one-hour cap never happened. `getViolations()` reported `violation_count: 1`
      // forever, and the admin Login Security panel's escalation column was a constant.
      //
      // An expired record is invisible everywhere it matters: peek(), getStatus() and
      // getViolations() all test `lockedUntil > now`, so keeping it does not extend a lockout
      // by one millisecond. It only remembers that this bucket has misbehaved before.
      //
      // The memory is dropped by the cleanup sweep once the bucket has been quiet for a full
      // VIOLATION_MEMORY_MS, so a client that backs off starts again at the base 30 s.
    }

    // Get requests for this bucket in current window
    if (!this.requests.has(key)) {
      // Bound the map before adding a NEW key (audit §J12-11). One entry per distinct source IP
      // per bucket type, swept only every 5 minutes and previously with no cap at all — so a
      // distributed flood grew it unchecked between sweeps, while getStatus(), getViolations()
      // and resetIp() each walk it end to end.
      //
      // Eviction only ever touches `requests`, NEVER `violations`: evicting a violation would
      // LIFT A LOCKOUT, which turns a memory bound into a security bypass. The violations map
      // is bounded by its own TTL sweep instead. Losing a request-count entry can only grant a
      // client a fresh window — exactly what the sweep does for an idle key anyway.
      //
      // Stale entries first (a bucket with no timestamp inside the window is already dead);
      // only if every tracked bucket is genuinely live do we drop oldest-insert-first, which
      // Map iteration order gives for free.
      if (this.requests.size >= RateLimiter.MAX_TRACKED_BUCKETS) {
        let dropped = 0;
        for (const k of this.requests.keys()) {
          const ts = this.requests.get(k);
          if (!ts || !ts.some(t => now - t < windowMs)) { this.requests.delete(k); dropped++; }
          if (dropped >= RateLimiter.EVICT_BATCH) break;
        }
        if (dropped === 0) {
          for (const k of this.requests.keys()) {
            this.requests.delete(k);
            if (++dropped >= RateLimiter.EVICT_BATCH) break;
          }
        }
      }
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

    // Request allowed — record it.
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
   * Uses Express's req.ip, which — with `app.set('trust proxy', 'loopback')` in index.js —
   * resolves to the real client IP from X-Forwarded-For for requests proxied by the local
   * nginx, while a direct off-box hit keeps its real socket IP. Reading the raw
   * x-forwarded-for header here (as before) let a client rotate forged IPs and evade
   * per-IP throttling/lockout.
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

      // Clean expired violations — but only once they have been expired for a full
      // VIOLATION_MEMORY_MS. An expired record is already inert everywhere (peek/getStatus/
      // getViolations all test `lockedUntil > now`); the only thing it still carries is the
      // `count` the exponential backoff escalates from. Deleting it the instant the lockout
      // lapsed — here and in checkLimit — is what made that backoff unreachable (§J12-4).
      // A client that goes quiet for the memory window is forgiven and starts again at 30 s.
      this.violations.forEach((v, key) => {
        if (v.lockedUntil + RateLimiter.VIOLATION_MEMORY_MS <= now) {
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

// How long a lapsed violation is remembered so the NEXT one escalates (30s → 60s → 120s …).
// Ten minutes: long enough that a client hammering back through every lockout climbs the
// ladder, short enough that an operator who tripped the admin budget once during a busy
// afternoon is back to a 30 s penalty by the time they notice. Audit §J12-4.
RateLimiter.VIOLATION_MEMORY_MS = 10 * 60 * 1000;

// Hard cap on tracked (type, IP) request buckets, and how many to reclaim when it is hit.
// 200 k entries is far above any legitimate load — a busy pool sees one entry per active
// visitor per bucket type — so this only ever engages under a distributed flood, which is
// precisely when an unbounded Map is the wrong thing to have. Audit §J12-11.
RateLimiter.MAX_TRACKED_BUCKETS = 200000;
RateLimiter.EVICT_BATCH = 1000;

module.exports = RateLimiter;
