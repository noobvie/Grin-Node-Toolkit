const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

let db = null;

function initDb(dbPath = './pool.sqlite') {
  if (db) return db;

  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  createSchema();
  return db;
}

function getDb() {
  if (!db) {
    throw new Error('Database not initialized. Call initDb() first.');
  }
  return db;
}

function createSchema() {
  const statements = [
    `CREATE TABLE IF NOT EXISTS miner_accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      grin_address TEXT NOT NULL UNIQUE,
      balance REAL NOT NULL DEFAULT 0.0,
      balance_locked REAL NOT NULL DEFAULT 0.0,
      is_online INTEGER NOT NULL DEFAULT 0,
      last_seen_at INTEGER DEFAULT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    )`,

    `CREATE INDEX IF NOT EXISTS idx_miner_address ON miner_accounts(grin_address)`,
    `CREATE INDEX IF NOT EXISTS idx_miner_online ON miner_accounts(is_online)`,

    `CREATE TABLE IF NOT EXISTS blocks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      height INTEGER NOT NULL,
      hash TEXT NOT NULL UNIQUE,
      nonce INTEGER NOT NULL,
      reward REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'immature',
      found_by TEXT NOT NULL REFERENCES miner_accounts(grin_address),
      found_at INTEGER NOT NULL,
      confirmed_at INTEGER DEFAULT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    )`,

    `CREATE INDEX IF NOT EXISTS idx_block_height ON blocks(height)`,
    `CREATE INDEX IF NOT EXISTS idx_block_status ON blocks(status)`,
    `CREATE INDEX IF NOT EXISTS idx_block_found_by ON blocks(found_by)`,

    `CREATE TABLE IF NOT EXISTS shares (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      grin_address TEXT NOT NULL REFERENCES miner_accounts(grin_address),
      worker_name TEXT DEFAULT NULL,
      difficulty REAL NOT NULL,
      block_height INTEGER NOT NULL,
      share_hash TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    )`,

    `CREATE INDEX IF NOT EXISTS idx_share_address ON shares(grin_address)`,
    `CREATE INDEX IF NOT EXISTS idx_share_block_height ON shares(block_height)`,
    `CREATE INDEX IF NOT EXISTS idx_share_created ON shares(created_at)`,

    `CREATE TABLE IF NOT EXISTS hashrate_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      grin_address TEXT NOT NULL REFERENCES miner_accounts(grin_address),
      hashrate_gps REAL NOT NULL,
      window_seconds INTEGER NOT NULL DEFAULT 60,
      recorded_at INTEGER NOT NULL DEFAULT (unixepoch())
    )`,

    `CREATE INDEX IF NOT EXISTS idx_hashrate_address ON hashrate_history(grin_address, recorded_at DESC)`,

    `CREATE TABLE IF NOT EXISTS withdrawals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      grin_address TEXT NOT NULL REFERENCES miner_accounts(grin_address),
      amount REAL NOT NULL,
      fee REAL NOT NULL DEFAULT 0.0,
      status TEXT NOT NULL DEFAULT 'tor_checking',
      retry_count INTEGER NOT NULL DEFAULT 0,
      next_retry_at INTEGER DEFAULT NULL,
      tor_check_result TEXT DEFAULT NULL,
      cancelled_by INTEGER DEFAULT NULL,
      cancel_reason TEXT DEFAULT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      confirmed_at INTEGER DEFAULT NULL
    )`,

    `CREATE INDEX IF NOT EXISTS idx_withdrawal_address ON withdrawals(grin_address, status)`,
    `CREATE INDEX IF NOT EXISTS idx_withdrawal_retry ON withdrawals(status, next_retry_at)`,

    `CREATE TABLE IF NOT EXISTS balance_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      grin_address TEXT NOT NULL REFERENCES miner_accounts(grin_address),
      event_type TEXT NOT NULL,
      amount REAL NOT NULL,
      balance_before REAL NOT NULL,
      balance_after REAL NOT NULL,
      locked_before REAL NOT NULL,
      locked_after REAL NOT NULL,
      reference_type TEXT NOT NULL,
      reference_id INTEGER NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    )`,

    `CREATE INDEX IF NOT EXISTS idx_balance_log_address ON balance_log(grin_address, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_balance_log_time ON balance_log(created_at DESC)`,

    `CREATE TABLE IF NOT EXISTS withdrawal_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      withdrawal_id INTEGER NOT NULL REFERENCES withdrawals(id),
      from_status TEXT DEFAULT NULL,
      to_status TEXT NOT NULL,
      triggered_by TEXT NOT NULL,
      actor_id INTEGER DEFAULT NULL,
      note TEXT DEFAULT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    )`,

    `CREATE INDEX IF NOT EXISTS idx_withdrawal_events ON withdrawal_events(withdrawal_id, created_at)`,

    `CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      is_admin INTEGER NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    )`,

    `CREATE INDEX IF NOT EXISTS idx_user_username ON users(username)`,

    `CREATE TABLE IF NOT EXISTS admin_audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      admin_id INTEGER NOT NULL REFERENCES users(id),
      action TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_id TEXT NOT NULL,
      before_state TEXT DEFAULT NULL,
      after_state TEXT DEFAULT NULL,
      ip TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    )`,

    `CREATE INDEX IF NOT EXISTS idx_audit_admin ON admin_audit_log(admin_id, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_audit_target ON admin_audit_log(target_type, target_id, created_at DESC)`,

    `CREATE TABLE IF NOT EXISTS alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      level TEXT NOT NULL DEFAULT 'warning',
      message TEXT NOT NULL,
      data TEXT DEFAULT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      occurrence_count INTEGER NOT NULL DEFAULT 1,
      triggered_at TEXT NOT NULL,
      last_seen TEXT NOT NULL,
      resolved_at TEXT DEFAULT NULL,
      acknowledged_at TEXT DEFAULT NULL,
      acknowledged_by TEXT DEFAULT NULL,
      snoozed_until TEXT DEFAULT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    )`,

    `CREATE INDEX IF NOT EXISTS idx_alert_type ON alerts(type, status)`,
    `CREATE INDEX IF NOT EXISTS idx_alert_status ON alerts(status, triggered_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_alert_time ON alerts(triggered_at DESC)`
  ];

  const transaction = db.transaction(() => {
    for (const stmt of statements) {
      db.exec(stmt);
    }
  });

  transaction();
}

function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}

module.exports = {
  initDb,
  getDb,
  closeDb,
  createSchema
};
