const crypto = require('crypto');
const { getDb } = require('./db');
const { recordOwnerEvidence, isUsablePassword } = require('./owner-proof');
const geoip = require('./geoip');

class MinerManager {
  constructor(config) {
    this.config = config;
    this.db = getDb();
    this.activeSessions = new Map();
  }

  createSession(grinAddress, workerName, ip, region, pass) {
    const sessionId = crypto.randomBytes(16).toString('hex');
    const session = {
      sessionId,
      grinAddress,
      workerName,
      ip,
      // Stratum password as typed by the rig — in-memory only, hashed into the ownership-proof
      // window on the first accepted share (owner-proof.js), never persisted or logged raw.
      pass: typeof pass === 'string' ? pass : '',
      // Region the miner connected through (which stratum listener accepted it). Stamped on
      // every share for per-region aggregation; falls back to this box's configured region.
      region: region || this.config.region || 'default',
      difficulty: 1.0,
      subscribedAt: Date.now(),
      lastShareAt: null,
      // ⚠ shareCount is an ADDRESS-wide counter, not this session's work: recordShare() below
      // increments it on EVERY live session sharing the address, so a connection that has never
      // submitted anything still shows a rising count. It is fine for the per-address stats it
      // feeds — and useless as evidence about THIS connection.
      shareCount: 0,
      // Accepted shares submitted BY THIS SESSION. Incremented only by the submit handler that
      // owns the socket (stratum-server.handleSubmit), so it is the only per-connection proof of
      // work available. Both §J3 guards read this and must never be moved back to shareCount:
      // an attacker who merely opens a session under a victim's address would otherwise be
      // credited with the victim's own mining, which defeats both of them silently.
      acceptedShares: 0,
      // `donateN` parsed from the worker name at login, but NOT applied until this session has
      // mined (audit §J3-5) — see stratum-server.handleSubmit. Login is unauthenticated, so
      // applying it here would let a bare TCP connect redirect a stranger's earnings.
      donationPercent: null,
      lastSeenAt: Date.now()
    };

    this.activeSessions.set(sessionId, session);
    this.updateMinerOnline(grinAddress, true);

    return sessionId;
  }

  getSession(sessionId) {
    return this.activeSessions.get(sessionId);
  }

  updateSession(sessionId, updates) {
    const session = this.activeSessions.get(sessionId);
    if (session) {
      Object.assign(session, updates);
      session.lastSeenAt = Date.now();
    }
    return session;
  }

  // Mark a session as alive RIGHT NOW. Called from the stratum message loop on every
  // well-formed message that survives the token bucket, which is the only thing standing
  // between a working rig and pruneInactiveSessions() below.
  //
  // ⚠ This is the fix for audit §J6-2, and the bug it closes was not an attack: lastSeenAt was
  // written once by createSession and NEVER again (updateSession above had zero call sites
  // repo-wide, and recordShare touches lastShareAt, which the sweeper does not read). So every
  // session — including one whose socket was open and actively submitting — was deleted ten
  // minutes after login. After that the socket stayed up, the rig kept hashing, and every
  // submit on it was answered "Session not found" BEFORE forwardSubmit, so a solution that
  // solved a block was never handed to the node. Note the asymmetry that hid it:
  // socket.setTimeout() is an INACTIVITY timer and resets on every byte, so the two timers of
  // the same length were guaranteed to disagree for exactly the busy connections.
  touchSession(sessionId) {
    const session = this.activeSessions.get(sessionId);
    if (session) session.lastSeenAt = Date.now();
    return !!session;
  }

  closeSession(sessionId) {
    const session = this.activeSessions.get(sessionId);
    if (session) {
      this.updateMinerOnline(session.grinAddress, false);
      this.activeSessions.delete(sessionId);
      return true;
    }
    return false;
  }

  updateMinerOnline(grinAddress, isOnline) {
    try {
      const stmt = this.db.prepare(`
        UPDATE miner_accounts SET is_online = ?, last_seen_at = unixepoch() WHERE grin_address = ?
      `);
      stmt.run(isOnline ? 1 : 0, grinAddress);
    } catch (err) {
      console.error(`Error updating miner online status: ${err.message}`);
    }
  }

  ensureMinerExists(grinAddress) {
    try {
      const stmt = this.db.prepare(`
        INSERT OR IGNORE INTO miner_accounts (grin_address, balance, balance_locked)
        VALUES (?, 0.0, 0.0)
      `);
      stmt.run(grinAddress);
    } catch (err) {
      console.error(`Error ensuring miner exists: ${err.message}`);
    }
  }

  // Record the ownership-gate evidence for an address — source IP (last-2 window) and, when
  // usable, the rig's stratum password — both as salted hashes. Delegates to
  // owner-proof.recordOwnerEvidence; no-op when both are unchanged. Called from stratum-server
  // on a session's first ACCEPTED share (never at login — that would let a bare TCP connect
  // poison the windows) with the real miner IP (direct socket address, or the gateway's
  // PROXY-protocol v2 header value under Model C). Async (scrypt); errors are swallowed inside.
  recordOwnerEvidence(grinAddress, ip, pass, opts) {
    return recordOwnerEvidence(this.db, grinAddress, ip, pass, opts);
  }

  // Network-map geo capture (lib/geoip.js). Resolves the miner's transient real IP to an ISO
  // COUNTRY CODE and upserts miner_geo — COUNTRY ONLY, the IP is never stored. Throttled to one
  // write per address per 6h (a miner rarely changes country). Silent no-op when geoip-lite is
  // not installed or the IP has no country. Called beside recordOwnerEvidence on a session's
  // first accepted share (same once-per-session gate), so it never touches the hot share path
  // for an already-known miner and never blocks (best-effort, errors swallowed).
  recordMinerCountry(grinAddress, ip) {
    try {
      if (!geoip.available()) return;
      const geo = geoip.lookupCountry(ip);
      if (!geo) return;
      const now = Math.floor(Date.now() / 1000);
      const row = this.db.prepare('SELECT last_seen FROM miner_geo WHERE grin_address = ?').get(grinAddress);
      if (row && (now - row.last_seen) < 6 * 3600) return; // throttle repeat writes
      this.db.prepare(`
        INSERT INTO miner_geo (grin_address, country_code, country, first_seen, last_seen)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(grin_address) DO UPDATE SET
          country_code = excluded.country_code, country = excluded.country, last_seen = excluded.last_seen
      `).run(grinAddress, geo.cc, geo.name, now, now);
    } catch (err) {
      // geo is best-effort decoration for the public map — never disturb mining.
      console.error(`[geoip] recordMinerCountry failed: ${err.message}`);
    }
  }

  // Moderation — is this address banned from logging in / submitting shares?
  // Cheap single-row lookup; called on every stratum login (see stratum-server handleLogin).
  isBanned(grinAddress) {
    try {
      const row = this.db.prepare(
        'SELECT is_banned FROM miner_accounts WHERE grin_address = ?'
      ).get(grinAddress);
      return !!(row && row.is_banned);
    } catch (err) {
      // Fail open: a lookup error must never silently lock everyone out of mining.
      console.error(`Error checking ban status: ${err.message}`);
      return false;
    }
  }

  // Ban an abusive address: blocks future stratum logins. Balance is intentionally left
  // intact so anything already owed can still be paid out. Idempotent (ensures the row).
  banMiner(grinAddress, reason = null) {
    this.ensureMinerExists(grinAddress);
    this.db.prepare(
      `UPDATE miner_accounts SET is_banned = 1, ban_reason = ?, banned_at = unixepoch(), updated_at = unixepoch()
       WHERE grin_address = ?`
    ).run(reason ? String(reason).slice(0, 280) : null, grinAddress);
    // Drop any live sessions for the address so the ban takes effect without waiting for
    // a reconnect.
    for (const [sid, session] of this.activeSessions) {
      if (session.grinAddress === grinAddress) this.activeSessions.delete(sid);
    }
    return true;
  }

  unbanMiner(grinAddress) {
    this.db.prepare(
      `UPDATE miner_accounts SET is_banned = 0, ban_reason = NULL, banned_at = NULL, updated_at = unixepoch()
       WHERE grin_address = ?`
    ).run(grinAddress);
    return true;
  }

  recordShare(grinAddress, difficulty) {
    try {
      for (const [, session] of this.activeSessions) {
        if (session.grinAddress === grinAddress) {
          session.shareCount++;
          session.lastShareAt = Date.now();
        }
      }
    } catch (err) {
      console.error(`Error recording share: ${err.message}`);
    }
  }

  getActiveSessions() {
    return Array.from(this.activeSessions.values());
  }

  getActiveMinersCount() {
    const uniqueAddresses = new Set();
    for (const [, session] of this.activeSessions) {
      uniqueAddresses.add(session.grinAddress);
    }
    return uniqueAddresses.size;
  }

  // Do all of this address's live rigs use the SAME stratum password?
  //
  // This matters because miner_accounts keeps only last_pass_hash + prev_pass_hash — a last-2
  // window. Three rigs on three different passwords keep overwriting each other, so only the
  // two most recently rotated survive, and WHICH one works depends on which rig last submitted
  // an accepted share. Silent, and confusing exactly when the miner needs the gate to work.
  //
  // Computed from the in-memory sessions, which already hold the password as typed by the rig
  // (createSession above). It cannot be done from the stored hashes: those are SALTED, so two
  // rigs on an identical password produce different digests and can never compare equal. The
  // alternative — a deterministic HMAC fingerprint column — would put an offline-grindable
  // digest at rest for a purely informational readout, which isn't worth it.
  //
  // Returns COUNTS ONLY, never a password or any digest of one. Live sessions only, so it
  // resets on restart and reflects currently-connected rigs — which is the useful scope for a
  // "check your rig config" hint.
  getPasswordConsistency(grinAddress) {
    const usable = new Set();
    let sessions = 0;
    let unusable = 0; // rigs sending nothing, or something that can never be proof
    try {
      for (const [, s] of this.activeSessions) {
        if (s.grinAddress !== grinAddress) continue;
        // MINING sessions only (audit §J3-2). This readout is published unauthenticated on
        // GET /api/account/:addr, and a stratum session exists from LOGIN — which is
        // unauthenticated, since the address is the username. So a stranger could open a
        // session under any address carrying a candidate password, read `distinct` back, and
        // learn from whether the count moved whether their candidate matched a live rig's
        // password: an exact equality oracle that reached none of the controls guarding that
        // secret (no failed-attempt lockout, no per-IP counter, no 16 MB scrypt, no audit row),
        // batches — 320 connections per IP against a 1200/min bucket. Requiring an accepted
        // share puts the oracle behind real proof of work, which is the same bar every other
        // ownership signal in this subsystem already has to clear, and costs the diagnostic
        // nothing: a rig that is not mining is not a rig this hint is about.
        if (!(s.acceptedShares > 0)) continue;
        sessions++;
        const p = typeof s.pass === 'string' ? s.pass.trim() : '';
        if (p && isUsablePassword(p, this.db)) usable.add(p);
        else unusable++;
      }
    } catch (err) {
      console.error(`Error checking password consistency: ${err.message}`);
      return null;
    }
    return { sessions, distinct: usable.size, unusable };
  }

  getSessionsByMiner(grinAddress) {
    const sessions = [];
    for (const [, session] of this.activeSessions) {
      if (session.grinAddress === grinAddress) {
        sessions.push(session);
      }
    }
    return sessions;
  }

  setSessionDifficulty(sessionId, difficulty) {
    const session = this.activeSessions.get(sessionId);
    if (session) {
      session.difficulty = difficulty;
      return true;
    }
    return false;
  }

  // Reap sessions that have sent NOTHING for timeoutMs. Correct only because touchSession()
  // above is called from the stratum message loop — without it this deletes live miners
  // (audit §J6-2). Anything that changes how a session stays alive belongs in that pair.
  pruneInactiveSessions(timeoutMs = 600000) {
    const now = Date.now();
    const toDelete = [];

    for (const [sessionId, session] of this.activeSessions) {
      if (now - session.lastSeenAt > timeoutMs) {
        toDelete.push(sessionId);
      }
    }

    toDelete.forEach(sessionId => this.closeSession(sessionId));
    return toDelete.length;
  }
}

module.exports = MinerManager;
