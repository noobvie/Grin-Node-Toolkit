const Database = require('./sqlite-compat');
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

// Drop admin_audit_log if its columns don't match the canonical shape.
// The pool isn't in production; auditing a fresh table is preferable to
// silently swallowing INSERT errors against a stale schema (BUG-18).
function migrateAdminAuditLog() {
  try {
    const cols = db.prepare("PRAGMA table_info(admin_audit_log)").all();
    if (cols.length === 0) return;
    const expected = new Set(['id', 'admin_id', 'action', 'target_type', 'target_id', 'details', 'ip', 'created_at']);
    const colNames = new Set(cols.map(c => c.name));
    const missing = [...expected].filter(c => !colNames.has(c));
    const obsolete = [...colNames].filter(c => !expected.has(c));
    if (missing.length > 0 || obsolete.length > 0) {
      console.warn(
        `[db] admin_audit_log schema mismatch (missing: [${missing.join(',')}], obsolete: [${obsolete.join(',')}]); dropping and recreating. Existing audit rows will be lost.`
      );
      db.exec('DROP TABLE admin_audit_log');
    }
  } catch (e) {
    console.error(`[db] admin_audit_log migration check failed: ${e.message}`);
  }
}

// Additive, non-destructive: add account-lockout + token-version columns to an
// existing users table (older testnet DBs predate them). Unlike migrateAdminAuditLog
// we never drop users — that would delete admin accounts. ADD COLUMN with a default
// backfills existing rows safely.
function migrateUsers() {
  try {
    const cols = db.prepare("PRAGMA table_info(users)").all();
    if (cols.length === 0) return; // fresh DB: CREATE TABLE below has the columns
    const have = new Set(cols.map(c => c.name));
    const additions = {
      failed_login_attempts: 'INTEGER NOT NULL DEFAULT 0',
      locked_until: 'INTEGER NOT NULL DEFAULT 0',
      token_version: 'INTEGER NOT NULL DEFAULT 0',
      // Optional admin TOTP 2FA. totp_secret = confirmed base32 secret (NULL until enabled);
      // totp_pending_secret = secret mid-enrollment, before the confirm code is entered.
      totp_secret: 'TEXT DEFAULT NULL',
      totp_enabled: 'INTEGER NOT NULL DEFAULT 0',
      totp_pending_secret: 'TEXT DEFAULT NULL'
    };
    for (const [name, def] of Object.entries(additions)) {
      if (!have.has(name)) {
        db.exec(`ALTER TABLE users ADD COLUMN ${name} ${def}`);
        console.warn(`[db] users: added missing column ${name}`);
      }
    }
  } catch (e) {
    console.error(`[db] users migration check failed: ${e.message}`);
  }
}

// Additive, non-destructive: add per-miner payout threshold + last-seen source IPs to an
// existing miner_accounts table (older DBs predate them). min_payout NULL = use the pool
// default (config.min_withdrawal). last_ip/prev_ip back the address-as-identity ownership
// gate (one of the address's last-2 mining source IPs must be supplied for sensitive actions).
function migrateMinerAccounts() {
  try {
    const cols = db.prepare("PRAGMA table_info(miner_accounts)").all();
    if (cols.length === 0) return; // fresh DB: CREATE TABLE below has the columns
    const have = new Set(cols.map(c => c.name));
    const additions = {
      min_payout: 'REAL DEFAULT NULL',
      last_ip: 'TEXT DEFAULT NULL',
      prev_ip: 'TEXT DEFAULT NULL'
    };
    for (const [name, def] of Object.entries(additions)) {
      if (!have.has(name)) {
        db.exec(`ALTER TABLE miner_accounts ADD COLUMN ${name} ${def}`);
        console.warn(`[db] miner_accounts: added missing column ${name}`);
      }
    }
  } catch (e) {
    console.error(`[db] miner_accounts migration check failed: ${e.message}`);
  }
}

// Additive, non-destructive: add the per-block stats backing round effort / luck to an existing
// blocks table (older DBs predate them). Both NULL on legacy rows → those blocks are skipped by
// the luck calc. Captured at find time so luck-over-N-blocks stays exact even after raw shares are
// pruned to the PPLNS window:
//   network_difficulty — the block's C32 network difficulty (total_diff[h] − total_diff[h-1])
//   round_shares       — accumulated pool share-difficulty for the round that found the block
function migrateBlocks() {
  try {
    const cols = db.prepare("PRAGMA table_info(blocks)").all();
    if (cols.length === 0) return; // fresh DB: CREATE TABLE below has the columns
    const have = new Set(cols.map(c => c.name));
    const additions = {
      network_difficulty: 'REAL DEFAULT NULL',
      round_shares: 'REAL DEFAULT NULL'
    };
    for (const [name, def] of Object.entries(additions)) {
      if (!have.has(name)) {
        db.exec(`ALTER TABLE blocks ADD COLUMN ${name} ${def}`);
        console.warn(`[db] blocks: added missing column ${name}`);
      }
    }
  } catch (e) {
    console.error(`[db] blocks migration check failed: ${e.message}`);
  }
}

// Additive, non-destructive: add the slatepack-payout columns to an existing withdrawals table
// (older DBs predate them). `method` distinguishes 'tor' (default) from 'slatepack'; `slate_id`
// records the grin-wallet slate UUID so a pending slatepack can be cancelled/expired and matched
// on finalize. The status column is free-text, so slatepack_* states need no migration.
function migrateWithdrawals() {
  try {
    const cols = db.prepare("PRAGMA table_info(withdrawals)").all();
    if (cols.length === 0) return; // fresh DB: CREATE TABLE below has the columns
    const have = new Set(cols.map(c => c.name));
    const additions = {
      method: "TEXT NOT NULL DEFAULT 'tor'",
      slate_id: 'TEXT DEFAULT NULL'
    };
    for (const [name, def] of Object.entries(additions)) {
      if (!have.has(name)) {
        db.exec(`ALTER TABLE withdrawals ADD COLUMN ${name} ${def}`);
        console.warn(`[db] withdrawals: added missing column ${name}`);
      }
    }
  } catch (e) {
    console.error(`[db] withdrawals migration check failed: ${e.message}`);
  }
}

// Additive, non-destructive: add the multi-region `region` column to an existing
// shares table (older testnet DBs predate it). NOT NULL DEFAULT 'default' backfills
// every existing row, so legacy single-region shares group under 'default'.
function migrateShares() {
  try {
    const cols = db.prepare("PRAGMA table_info(shares)").all();
    if (cols.length === 0) return; // fresh DB: CREATE TABLE below has the column
    const have = new Set(cols.map(c => c.name));
    if (!have.has('region')) {
      db.exec(`ALTER TABLE shares ADD COLUMN region TEXT NOT NULL DEFAULT 'default'`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_share_region ON shares(region, created_at)`);
      console.warn(`[db] shares: added missing column region`);
    }
  } catch (e) {
    console.error(`[db] shares migration check failed: ${e.message}`);
  }
}

function createSchema() {
  migrateAdminAuditLog();

  const statements = [
    `CREATE TABLE IF NOT EXISTS miner_accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      grin_address TEXT NOT NULL UNIQUE,
      balance REAL NOT NULL DEFAULT 0.0,
      balance_locked REAL NOT NULL DEFAULT 0.0,
      is_online INTEGER NOT NULL DEFAULT 0,
      last_seen_at INTEGER DEFAULT NULL,
      min_payout REAL DEFAULT NULL,
      last_ip TEXT DEFAULT NULL,
      prev_ip TEXT DEFAULT NULL,
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
      network_difficulty REAL DEFAULT NULL,
      round_shares REAL DEFAULT NULL,
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
      region TEXT NOT NULL DEFAULT 'default',
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    )`,

    `CREATE INDEX IF NOT EXISTS idx_share_address ON shares(grin_address)`,
    `CREATE INDEX IF NOT EXISTS idx_share_block_height ON shares(block_height)`,
    `CREATE INDEX IF NOT EXISTS idx_share_created ON shares(created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_share_region ON shares(region, created_at)`,

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
      method TEXT NOT NULL DEFAULT 'tor',
      slate_id TEXT DEFAULT NULL,
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
      failed_login_attempts INTEGER NOT NULL DEFAULT 0,
      locked_until INTEGER NOT NULL DEFAULT 0,
      token_version INTEGER NOT NULL DEFAULT 0,
      totp_secret TEXT DEFAULT NULL,
      totp_enabled INTEGER NOT NULL DEFAULT 0,
      totp_pending_secret TEXT DEFAULT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    )`,

    `CREATE INDEX IF NOT EXISTS idx_user_username ON users(username)`,

    // One-time backup recovery codes for admin 2FA (bcrypt-hashed, single-use). Shown to the
    // admin once at enrollment; let an admin who lost their authenticator still log in.
    `CREATE TABLE IF NOT EXISTS admin_recovery_codes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      code_hash TEXT NOT NULL,
      used_at INTEGER DEFAULT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    )`,

    `CREATE INDEX IF NOT EXISTS idx_recovery_user ON admin_recovery_codes(user_id, used_at)`,

    `CREATE TABLE IF NOT EXISTS admin_audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      admin_id INTEGER REFERENCES users(id),
      action TEXT NOT NULL,
      target_type TEXT,
      target_id TEXT,
      details TEXT,
      ip TEXT,
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
    `CREATE INDEX IF NOT EXISTS idx_alert_time ON alerts(triggered_at DESC)`,

    `CREATE TABLE IF NOT EXISTS pool_config (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      section TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      value_type TEXT NOT NULL DEFAULT 'string',
      updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_by INTEGER REFERENCES users(id),
      UNIQUE(section, key)
    )`,

    `CREATE INDEX IF NOT EXISTS idx_pool_config_section ON pool_config(section)`,
    `CREATE INDEX IF NOT EXISTS idx_pool_config_updated ON pool_config(updated_at DESC)`,

    `CREATE TABLE IF NOT EXISTS pool_assets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      asset_type TEXT NOT NULL,
      filename TEXT NOT NULL UNIQUE,
      original_name TEXT,
      mime_type TEXT,
      size_bytes INTEGER,
      uploaded_by INTEGER REFERENCES users(id),
      uploaded_at INTEGER NOT NULL DEFAULT (unixepoch()),
      is_active INTEGER NOT NULL DEFAULT 1
    )`,

    `CREATE INDEX IF NOT EXISTS idx_pool_assets_type ON pool_assets(asset_type, is_active)`,
    `CREATE INDEX IF NOT EXISTS idx_pool_assets_uploaded ON pool_assets(uploaded_at DESC)`,

    // ─── Incentives (Script 07 incentive features) ────────────────────────────
    // Per-address incentive state. Identity-ready (address-keyed) but register-free —
    // there is no account, the grin_address IS the identity.
    `CREATE TABLE IF NOT EXISTS miner_incentives (
      grin_address TEXT PRIMARY KEY REFERENCES miner_accounts(grin_address),
      join_bonus_paid INTEGER NOT NULL DEFAULT 0,
      donation_percent REAL NOT NULL DEFAULT 0,
      streak_days INTEGER NOT NULL DEFAULT 0,
      last_active_day INTEGER DEFAULT NULL,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    )`,

    // One row per lottery draw. seed_height/seed_hash make the draw publicly verifiable:
    // anyone can recompute the winners from the node block hash + public share data.
    `CREATE TABLE IF NOT EXISTS lottery_draws (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      draw_type TEXT NOT NULL,
      event_name TEXT DEFAULT NULL,
      period_start INTEGER NOT NULL,
      period_end INTEGER NOT NULL,
      seed_height INTEGER DEFAULT NULL,
      seed_hash TEXT DEFAULT NULL,
      pot_a_amount REAL NOT NULL DEFAULT 0,
      pot_b_amount REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending',
      drawn_at INTEGER DEFAULT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    )`,

    `CREATE INDEX IF NOT EXISTS idx_lottery_draws_time ON lottery_draws(created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_lottery_draws_status ON lottery_draws(status)`,

    `CREATE TABLE IF NOT EXISTS lottery_winners (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      draw_id INTEGER NOT NULL REFERENCES lottery_draws(id),
      grin_address TEXT NOT NULL,
      pot TEXT NOT NULL,
      ticket_count INTEGER NOT NULL DEFAULT 0,
      amount REAL NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    )`,

    `CREATE INDEX IF NOT EXISTS idx_lottery_winners_draw ON lottery_winners(draw_id)`,
    `CREATE INDEX IF NOT EXISTS idx_lottery_winners_address ON lottery_winners(grin_address, created_at DESC)`,

    // ─── Multi-region — operator-declared regional endpoints (hub-and-spoke) ───
    // One row per region/satellite the hub knows about. `region` matches the tag the
    // satellite relay stamps on shares (config.region → POST /api/shares { region }),
    // so /api/pool/stats/regions can left-join live share aggregates onto these labels.
    // Purely descriptive: the IP allowlist + shared secret in pool.json (not this table)
    // are what actually authorise ingestion.
    `CREATE TABLE IF NOT EXISTS pool_locations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      region TEXT NOT NULL UNIQUE,
      label TEXT DEFAULT NULL,
      api_url TEXT DEFAULT NULL,
      stratum_url TEXT DEFAULT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    )`,

    `CREATE INDEX IF NOT EXISTS idx_pool_locations_active ON pool_locations(is_active)`
  ];

  const transaction = db.transaction(() => {
    for (const stmt of statements) {
      db.exec(stmt);
    }
  });

  transaction();

  // Additive column migrations run after the tables exist.
  migrateUsers();
  migrateShares();
  migrateMinerAccounts();
  migrateBlocks();
  migrateWithdrawals();
  // No demo regions are seeded. The pool server self-registers its own region via
  // ensureLocalRegion() (called from index.js with config); extra zones come from
  // real satellites the operator declares in admin → Regions.
}

// Self-register the pool server's own region (role=singlebox) so the central box
// shows as a real region and auto-joins the connect grid the moment a satellite for
// another zone reports in. Creates ONE row for `region` (skipping the generic
// 'default'), backfills stratum_url once the public hostname is known, and never
// clobbers an operator's label/active/url edits made in admin → Regions.
function ensureLocalRegion(region, stratumUrl) {
  if (!region || region === 'default') return;
  try {
    const row = db.prepare('SELECT region, stratum_url FROM pool_locations WHERE region = ?').get(region);
    if (!row) {
      const label = region.charAt(0).toUpperCase() + region.slice(1);
      db.prepare(
        'INSERT INTO pool_locations (region, label, stratum_url, is_active) VALUES (?, ?, ?, 1)'
      ).run(region, label, stratumUrl || null);
      console.warn(`[db] registered local region '${region}'${stratumUrl ? ' (' + stratumUrl + ')' : ''}`);
    } else if (stratumUrl && !row.stratum_url) {
      // Backfill the connect address once the public hostname is configured (the row may
      // have been created on a pre-nginx first boot when subdomain was still empty).
      db.prepare('UPDATE pool_locations SET stratum_url = ? WHERE region = ?').run(stratumUrl, region);
    }
  } catch (e) {
    console.error(`[db] ensureLocalRegion failed: ${e.message}`);
  }
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
  createSchema,
  ensureLocalRegion
};
