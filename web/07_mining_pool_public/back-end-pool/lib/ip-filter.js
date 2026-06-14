/**
 * IP Filter Middleware — Allowlist and blacklist support
 *
 * - Allowlist: Only allow specified IPs/CIDRs (whitelist mode)
 * - Blacklist: Block specified IPs/CIDRs (blacklist mode)
 * - CIDR support: 192.168.1.0/24, 10.0.0.0/8
 * - Single IPs: 203.0.113.42
 */

const ipaddr = require('ipaddr.js');

class IpFilter {
  constructor(config = {}) {
    this.config = config;
    this.allowlist = config.allowlist || [];
    this.blacklist = config.blacklist || [];

    this.allowedRanges = [];
    this.blockedRanges = [];

    // Temporary auto-bans (single IP → expiry ms). Populated by the failed-login
    // auto-ban (fail2ban-style); pruned lazily on lookup. In-memory only — a restart
    // clears them, which is fine for short cooldowns.
    this.tempBans = new Map();

    // Parse CIDR/IP on init
    this.parseAllowlist(this.allowlist);
    this.parseBlacklist(this.blacklist);

    this.log(`Initialized (allowlist: ${this.allowlist.length} entries, blacklist: ${this.blacklist.length} entries)`);
  }

  /**
   * Middleware factory: returns express middleware
   * Usage: app.use(ipFilter.middleware('admin'))
   */
  middleware(filterType = 'admin') {
    return (req, res, next) => {
      const clientIp = this.getClientIp(req);

      // Check blacklist first (deny explicit entries)
      if (this.isBlocked(clientIp)) {
        this.log(`Blocked by blacklist: ${clientIp}`);
        return res.status(403).json({
          error: 'Access denied',
          message: 'Your IP address has been blocked.',
          your_ip: clientIp
        });
      }

      // If allowlist is set, check it (allow only explicit entries)
      if (this.allowedRanges.length > 0) {
        if (!this.isAllowed(clientIp)) {
          this.log(`Rejected by allowlist: ${clientIp}`);
          return res.status(403).json({
            error: 'Access denied',
            message: 'Your IP address is not in the allowed list.',
            your_ip: clientIp
          });
        }
      }

      // Access allowed
      next();
    };
  }

  /**
   * Check if IP is on allowlist
   */
  isAllowed(ipStr) {
    try {
      const ip = ipaddr.process(ipStr);
      return this.allowedRanges.some(range => {
        if (range.type === 'single') {
          return ip.toString() === range.ip.toString();
        } else if (range.type === 'cidr') {
          return ip.match(range.prefix, range.prefixLength);
        }
        return false;
      });
    } catch (err) {
      this.log(`Error processing IP ${ipStr}: ${err.message}`);
      return false;
    }
  }

  /**
   * Check if IP is on blacklist
   */
  isBlocked(ipStr) {
    // Temporary auto-bans take precedence and short-circuit the CIDR scan.
    if (this.isTempBanned(ipStr)) return true;
    try {
      const ip = ipaddr.process(ipStr);
      return this.blockedRanges.some(range => {
        if (range.type === 'single') {
          return ip.toString() === range.ip.toString();
        } else if (range.type === 'cidr') {
          return ip.match(range.prefix, range.prefixLength);
        }
        return false;
      });
    } catch (err) {
      this.log(`Error processing IP ${ipStr}: ${err.message}`);
      return false;
    }
  }

  /**
   * Temporarily ban a single IP for ttlMs (auto-ban / fail2ban-style cooldown).
   */
  tempBan(ipStr, ttlMs) {
    const ip = String(ipStr).replace('::ffff:', '');
    this.tempBans.set(ip, Date.now() + ttlMs);
    this.log(`Temp-banned ${ip} for ${Math.round(ttlMs / 1000)}s`);
  }

  /**
   * Is this IP under an active temporary ban? Prunes the entry when expired.
   */
  isTempBanned(ipStr) {
    const ip = String(ipStr).replace('::ffff:', '');
    const exp = this.tempBans.get(ip);
    if (!exp) return false;
    if (exp <= Date.now()) { this.tempBans.delete(ip); return false; }
    return true;
  }

  /**
   * Parse allowlist entries (IPs and CIDRs)
   */
  parseAllowlist(entries) {
    this.allowedRanges = [];
    (entries || []).forEach(entry => {
      try {
        this.parseEntry(entry, 'allowed');
      } catch (err) {
        this.log(`Invalid allowlist entry '${entry}': ${err.message}`);
      }
    });
  }

  /**
   * Parse blacklist entries (IPs and CIDRs)
   */
  parseBlacklist(entries) {
    this.blockedRanges = [];
    (entries || []).forEach(entry => {
      try {
        this.parseEntry(entry, 'blocked');
      } catch (err) {
        this.log(`Invalid blacklist entry '${entry}': ${err.message}`);
      }
    });
  }

  /**
   * Parse a single entry (IP or CIDR)
   */
  parseEntry(entry, listType) {
    const targets = listType === 'allowed' ? this.allowedRanges : this.blockedRanges;

    if (entry.includes('/')) {
      // CIDR format: 192.168.1.0/24
      const [ipPart, prefixLengthStr] = entry.split('/');
      const prefixLength = parseInt(prefixLengthStr, 10);

      const prefix = ipaddr.process(ipPart);
      targets.push({
        type: 'cidr',
        original: entry,
        prefix,
        prefixLength
      });

      this.log(`Parsed ${listType} CIDR: ${entry}`);
    } else {
      // Single IP: 192.168.1.42
      const ip = ipaddr.process(entry);
      targets.push({
        type: 'single',
        original: entry,
        ip
      });

      this.log(`Parsed ${listType} IP: ${entry}`);
    }
  }

  /**
   * Add IP to allowlist (dynamic)
   */
  addAllowed(entry) {
    try {
      this.parseEntry(entry, 'allowed');
      this.allowlist.push(entry);
      this.log(`Added to allowlist: ${entry}`);
      return { success: true };
    } catch (err) {
      this.log(`Failed to add allowlist entry: ${err.message}`);
      return { success: false, error: err.message };
    }
  }

  /**
   * Add IP to blacklist (dynamic)
   */
  addBlocked(entry) {
    try {
      this.parseEntry(entry, 'blocked');
      this.blacklist.push(entry);
      this.log(`Added to blacklist: ${entry}`);
      return { success: true };
    } catch (err) {
      this.log(`Failed to add blacklist entry: ${err.message}`);
      return { success: false, error: err.message };
    }
  }

  /**
   * Remove IP from allowlist
   */
  removeAllowed(entry) {
    this.allowlist = this.allowlist.filter(e => e !== entry);
    this.parseAllowlist(this.allowlist);
    this.log(`Removed from allowlist: ${entry}`);
  }

  /**
   * Remove IP from blacklist
   */
  removeBlocked(entry) {
    this.blacklist = this.blacklist.filter(e => e !== entry);
    this.parseBlacklist(this.blacklist);
    this.log(`Removed from blacklist: ${entry}`);
  }

  /**
   * Get current filter status
   */
  getStatus() {
    return {
      allowlist_enabled: this.allowedRanges.length > 0,
      allowlist_entries: this.allowlist,
      blacklist_enabled: this.blacklist.length > 0,
      blacklist_entries: this.blacklist,
      mode: this.allowedRanges.length > 0 ? 'whitelist' : (this.blockedRanges.length > 0 ? 'blacklist' : 'disabled')
    };
  }

  /**
   * Extract client IP from request.
   * Uses Express's req.ip, which — with `app.set('trust proxy', 1)` in index.js —
   * resolves to the real client IP from X-Forwarded-For while IGNORING client-supplied
   * XFF beyond the one trusted nginx hop. Reading the raw x-forwarded-for header here
   * (as before) let any client spoof an allowlisted IP and bypass this filter.
   */
  getClientIp(req) {
    const ip = (req && (req.ip || (req.socket && req.socket.remoteAddress))) || 'unknown';
    return String(ip).replace('::ffff:', '');
  }

  log(msg) {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] [IpFilter] ${msg}`);
  }
}

module.exports = IpFilter;
