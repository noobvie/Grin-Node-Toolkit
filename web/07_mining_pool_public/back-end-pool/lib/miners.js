const crypto = require('crypto');
const { getDb } = require('./db');
const { recordSourceIp } = require('./owner-proof');

class MinerManager {
  constructor(config) {
    this.config = config;
    this.db = getDb();
    this.activeSessions = new Map();
  }

  createSession(grinAddress, workerName, ip) {
    const sessionId = crypto.randomBytes(16).toString('hex');
    const session = {
      sessionId,
      grinAddress,
      workerName,
      ip,
      difficulty: 1.0,
      subscribedAt: Date.now(),
      lastShareAt: null,
      shareCount: 0,
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

  // Record the source IP seen for an address into its last-2 distinct-IP window (backs the
  // address-as-identity ownership gate). Delegates to owner-proof.recordSourceIp; cheap no-op
  // when the IP is unchanged. Called from stratum login (local) and hub share ingestion (relay).
  recordSourceIp(grinAddress, ip) {
    return recordSourceIp(this.db, grinAddress, ip);
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
