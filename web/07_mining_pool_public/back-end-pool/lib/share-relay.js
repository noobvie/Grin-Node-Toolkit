'use strict';

// Share relay agent (SATELLITE side).
//
// Receives accepted shares + found blocks from the local StratumServer (via
// setShareRelay) and forwards them to the Central Hub:
//   shares  -> POST {hub_url}/api/shares  { region, shares:[...] }   (batched)
//   blocks  -> POST {hub_url}/api/blocks  { region, block }          (immediate)
//
// Resilience: if the hub is unreachable, events are persisted to a local SQLite
// failover file and replayed on the next flush. Delivery is at-least-once; the hub
// is idempotent (shares dedup by share_hash UNIQUE, blocks by hash UNIQUE).
//
// Requires Node 24+ (node:sqlite via sqlite-compat). Sourced by satellite.js, never by index.js.

const path = require('path');
const Database = require('./sqlite-compat');

const DEFAULT_BATCH_INTERVAL_MS = 2000;
const MAX_BATCH = 300;          // ~75 KB/batch — stays under express.json() 100kb limit
const FAILOVER_BLOCK_LIMIT = 50;
const DEFAULT_POST_TIMEOUT_MS = 15000; // abort a hub POST that hangs (half-open connection)
const HEARTBEAT_MS = 60000;     // when idle (no shares), ping the hub at least this often so
                                // the region's public up/down pill stays "online", not "offline"

class ShareRelay {
  constructor(config) {
    this.hubUrl = (config.hub_url || '').replace(/\/+$/, '');
    this.secret = config.hub_shared_secret || '';
    this.region = config.region || 'default';
    this.intervalMs = config.relay_batch_interval_ms || DEFAULT_BATCH_INTERVAL_MS;
    this.postTimeoutMs = config.relay_post_timeout_ms || DEFAULT_POST_TIMEOUT_MS;

    this.buffer = [];           // live, in-memory accepted shares awaiting flush
    this.timer = null;
    this.flushing = false;
    this.lastSentAt = 0;        // ms epoch of the last successful POST to the hub (heartbeat clock)

    // Local failover store — its own file so it never clashes with the pool DB.
    const failoverPath = config.relay_failover_path ||
      path.join(path.dirname(config.db_path || './pool.sqlite'), 'relay_failover.sqlite');
    this.fdb = new Database(failoverPath);
    this.fdb.pragma('journal_mode = WAL');
    this.fdb.exec(`
      CREATE TABLE IF NOT EXISTS relay_shares (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        payload TEXT NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE TABLE IF NOT EXISTS relay_blocks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        payload TEXT NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
    `);
  }

  // Called by StratumServer on every accepted share.
  recordShare(share) {
    this.buffer.push(share);
  }

  // Called by StratumServer when a block is found. Blocks are rare and valuable:
  // persist to failover immediately, then attempt an immediate flush.
  recordBlock(block) {
    try {
      this.fdb.prepare('INSERT INTO relay_blocks (payload) VALUES (?)').run(JSON.stringify(block));
    } catch (e) {
      console.error(`[ShareRelay] block persist failed: ${e.message}`);
    }
    this.flush().catch((e) => console.error(`[ShareRelay] block flush: ${e.message}`));
  }

  start() {
    if (!this.hubUrl || !this.secret) {
      console.warn('[ShareRelay] hub_url / hub_shared_secret not set — relay disabled');
      return this;
    }
    this.timer = setInterval(
      () => this.flush().catch((e) => console.error(`[ShareRelay] ${e.message}`)),
      this.intervalMs
    );
    if (this.timer.unref) this.timer.unref();
    console.log(`[ShareRelay] forwarding to ${this.hubUrl} as region '${this.region}'`);
    return this;
  }

  async _post(pathname, body) {
    // Abort a hung POST so a half-open hub connection can't leave flush() stuck with
    // flushing=true forever (which would silently grow the in-memory buffer unbounded).
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), this.postTimeoutMs);
    try {
      const res = await fetch(`${this.hubUrl}${pathname}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-pool-secret': this.secret },
        body: JSON.stringify(body),
        signal: ac.signal,
      });
      if (!res.ok) throw new Error(`hub ${pathname} -> HTTP ${res.status}`);
      this.lastSentAt = Date.now(); // any successful POST resets the idle-heartbeat clock
      return res;
    } finally {
      clearTimeout(t);
    }
  }

  // One flush pass. Always empties the in-memory buffer (to the hub or to failover),
  // so memory stays bounded even during a long hub outage.
  async flush() {
    if (this.flushing || !this.hubUrl || !this.secret) return;
    this.flushing = true;
    try {
      let hubOk = true;

      // 1. Replay failover backlog first (blocks, then shares).
      try {
        await this._drainFailoverBlocks();
        await this._drainFailoverShares();
      } catch (e) {
        hubOk = false; // hub still down — keep backlog, route live buffer to failover
      }

      // 2. Live buffer — take everything so memory never grows unbounded.
      if (this.buffer.length > 0) {
        const batch = this.buffer.splice(0);
        if (!hubOk) {
          this._persistShares(batch);
        } else {
          try {
            for (let i = 0; i < batch.length; i += MAX_BATCH) {
              await this._post('/api/shares', {
                region: this.region,
                shares: batch.slice(i, i + MAX_BATCH),
              });
            }
          } catch (e) {
            this._persistShares(batch); // failed mid-send → stage remainder for retry
          }
        }
      }

      // 3. Idle heartbeat. A quiet region (no miners → no shares) would otherwise never
      // contact the hub, so its public status pill would read "offline" even though the
      // node + stratum are perfectly healthy. When the hub is reachable and we haven't
      // sent anything for HEARTBEAT_MS, POST an empty batch purely to refresh the hub's
      // per-region last_seen. Empty shares[] is a no-op on the hub (accepted=0).
      if (hubOk && Date.now() - this.lastSentAt >= HEARTBEAT_MS) {
        try {
          await this._post('/api/shares', { region: this.region, shares: [] });
        } catch (e) { /* hub blipped — next flush retries */ }
      }
    } finally {
      this.flushing = false;
    }
  }

  _persistShares(batch) {
    try {
      const stmt = this.fdb.prepare('INSERT INTO relay_shares (payload) VALUES (?)');
      const tx = this.fdb.transaction((rows) => { for (const r of rows) stmt.run(JSON.stringify(r)); });
      tx(batch);
    } catch (e) {
      console.error(`[ShareRelay] failover persist failed: ${e.message}`);
    }
  }

  async _drainFailoverShares() {
    // Loop in chunks until the backlog is cleared or a POST fails (which throws).
    for (;;) {
      const rows = this.fdb.prepare(
        'SELECT id, payload FROM relay_shares ORDER BY id ASC LIMIT ?'
      ).all(MAX_BATCH);
      if (rows.length === 0) return;

      const shares = rows.map((r) => JSON.parse(r.payload));
      await this._post('/api/shares', { region: this.region, shares }); // throws → stays staged

      const del = this.fdb.prepare('DELETE FROM relay_shares WHERE id = ?');
      const tx = this.fdb.transaction((ids) => { for (const id of ids) del.run(id); });
      tx(rows.map((r) => r.id));
    }
  }

  async _drainFailoverBlocks() {
    const rows = this.fdb.prepare(
      'SELECT id, payload FROM relay_blocks ORDER BY id ASC LIMIT ?'
    ).all(FAILOVER_BLOCK_LIMIT);
    for (const row of rows) {
      const block = JSON.parse(row.payload);
      await this._post('/api/blocks', { region: this.region, block }); // throws → retry later
      this.fdb.prepare('DELETE FROM relay_blocks WHERE id = ?').run(row.id);
    }
  }

  backlogDepth() {
    try {
      return {
        shares: this.fdb.prepare('SELECT COUNT(*) AS c FROM relay_shares').get().c,
        blocks: this.fdb.prepare('SELECT COUNT(*) AS c FROM relay_blocks').get().c,
        buffered: this.buffer.length,
      };
    } catch (e) {
      return { shares: null, blocks: null, buffered: this.buffer.length };
    }
  }

  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    try { this.fdb.close(); } catch (e) { /* ignore */ }
  }
}

module.exports = ShareRelay;
