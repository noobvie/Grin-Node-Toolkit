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

// Additive, non-destructive: add the ownership-gate proof columns to an existing
// miner_accounts table (older DBs predate them). last_ip/prev_ip + last_pass_hash/
// prev_pass_hash back the address-as-identity ownership gate (lib/owner-proof.js): the
// last-2 mining source IPs and last-2 stratum passwords, all stored as salted scrypt
// hashes (`v1$…`) — the *_ip names are kept for schema continuity but no longer hold raw
// IPs after migrateOwnerProofHashes() runs. min_payout is a legacy column from the retired
// per-account payout threshold (2026-07-17) — kept in the schema, read by nothing.
function migrateMinerAccounts() {
  try {
    const cols = db.prepare("PRAGMA table_info(miner_accounts)").all();
    if (cols.length === 0) return; // fresh DB: CREATE TABLE below has the columns
    const have = new Set(cols.map(c => c.name));
    const additions = {
      min_payout: 'REAL DEFAULT NULL',
      last_ip: 'TEXT DEFAULT NULL',
      prev_ip: 'TEXT DEFAULT NULL',
      last_pass_hash: 'TEXT DEFAULT NULL',
      prev_pass_hash: 'TEXT DEFAULT NULL',
      is_banned: 'INTEGER NOT NULL DEFAULT 0',
      ban_reason: 'TEXT DEFAULT NULL',
      banned_at: 'INTEGER DEFAULT NULL',
      // Goblin/Nostr payout destination (design §15). nostr_username = display form
      // (name@domain or npub); nostr_npub = the resolved 64-hex pubkey (matched against
      // the seal-sender on an incoming response, and TOFU-re-pinned at send time);
      // nostr_registered_at arms the destination cooldown (a payout is refused until
      // now - registered_at >= nostr_destination_cooldown_hours). Re-registration
      // overwrites all three and resets the clock.
      nostr_username: 'TEXT DEFAULT NULL',
      nostr_npub: 'TEXT DEFAULT NULL',
      nostr_registered_at: 'INTEGER DEFAULT NULL'
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

// Additive, non-destructive: add impression/click counters + the admin-only sponsor
// memo to an existing ads table (2026-07-17; older DBs predate them). Counters are
// coarse aggregates bumped by the public beacon endpoint — no per-visitor rows.
function migrateAds() {
  try {
    const cols = db.prepare("PRAGMA table_info(ads)").all();
    if (cols.length === 0) return; // fresh DB: CREATE TABLE below has the columns
    const have = new Set(cols.map(c => c.name));
    const additions = {
      impressions: 'INTEGER NOT NULL DEFAULT 0',
      clicks: 'INTEGER NOT NULL DEFAULT 0',
      notes: 'TEXT DEFAULT NULL'
    };
    for (const [name, def] of Object.entries(additions)) {
      if (!have.has(name)) {
        db.exec(`ALTER TABLE ads ADD COLUMN ${name} ${def}`);
        console.warn(`[db] ads: added missing column ${name}`);
      }
    }
  } catch (e) {
    console.error(`[db] ads migration check failed: ${e.message}`);
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

// Additive, non-destructive: link an existing lottery_draws table to campaigns (older DBs
// predate the campaigns feature). campaign_id NULL = a plain weekly/special draw.
function migrateLotteryDraws() {
  try {
    const cols = db.prepare("PRAGMA table_info(lottery_draws)").all();
    if (cols.length === 0) return; // fresh DB: CREATE TABLE below has the column
    const have = new Set(cols.map(c => c.name));
    if (!have.has('campaign_id')) {
      db.exec(`ALTER TABLE lottery_draws ADD COLUMN campaign_id INTEGER DEFAULT NULL`);
      console.warn(`[db] lottery_draws: added missing column campaign_id`);
    }
  } catch (e) {
    console.error(`[db] lottery_draws migration check failed: ${e.message}`);
  }
}

// Additive, non-destructive: add the sampled network hashrate to an existing
// pool_metrics_hourly table (older DBs predate it). NULL = hour rolled up before the
// column existed / node unreachable at rollup time — trend charts skip those points.
function migratePoolMetricsHourly() {
  try {
    const cols = db.prepare("PRAGMA table_info(pool_metrics_hourly)").all();
    if (cols.length === 0) return; // fresh DB: CREATE TABLE below has the column
    const have = new Set(cols.map(c => c.name));
    if (!have.has('network_hashrate_gps')) {
      db.exec(`ALTER TABLE pool_metrics_hourly ADD COLUMN network_hashrate_gps REAL DEFAULT NULL`);
      console.warn(`[db] pool_metrics_hourly: added missing column network_hashrate_gps`);
    }
  } catch (e) {
    console.error(`[db] pool_metrics_hourly migration check failed: ${e.message}`);
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

// Additive, non-destructive: add moderation columns to an existing miner_accounts table
// (older DBs predate them). is_banned blocks new stratum logins for an abusive address;
// the balance is untouched so the operator can still pay out what's owed before/after a ban.
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
      last_pass_hash TEXT DEFAULT NULL,
      prev_pass_hash TEXT DEFAULT NULL,
      is_banned INTEGER NOT NULL DEFAULT 0,
      ban_reason TEXT DEFAULT NULL,
      banned_at INTEGER DEFAULT NULL,
      nostr_username TEXT DEFAULT NULL,
      nostr_npub TEXT DEFAULT NULL,
      nostr_registered_at INTEGER DEFAULT NULL,
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

    // Pool-wide hourly rollup — one row per hour, aggregated across ALL miners, so its size is
    // independent of miner count (~1 MB/year). NEVER pruned (kept out of lib/retention.js) so the
    // public trend charts (miners-stats.html) have Day→All-Time history. Written each hour by
    // HashrateTracker.rollupCompletedHours() from shares/blocks/withdrawals BEFORE those tables
    // prune. No backfill: the series grows from first run forward.
    `CREATE TABLE IF NOT EXISTS pool_metrics_hourly (
      bucket_start      INTEGER PRIMARY KEY,   -- unix ts floored to the hour
      pool_hashrate_gps REAL    NOT NULL DEFAULT 0,  -- avg pool GPS that hour (from shares)
      miner_count       INTEGER NOT NULL DEFAULT 0,  -- distinct miners active that hour
      blocks_found      INTEGER NOT NULL DEFAULT 0,  -- blocks found that hour (by found_at)
      earnings          REAL    NOT NULL DEFAULT 0,  -- block rewards confirmed that hour (by confirmed_at)
      payout            REAL    NOT NULL DEFAULT 0,  -- withdrawals confirmed that hour (by confirmed_at)
      network_hashrate_gps REAL DEFAULT NULL,  -- network GPS sampled at rollup time (NULL = no sample)
      updated_at        INTEGER NOT NULL DEFAULT (unixepoch())
    )`,

    // Per-region companion to pool_metrics_hourly — one row per (hour, region), aggregated
    // from the region tag the stratum listeners stamp on shares. Backs the public
    // "miners per gateway" trend charts, so like its parent it is NEVER pruned (kept out of
    // lib/retention.js); size is bounded by region count (~8) — still a few MB/year.
    `CREATE TABLE IF NOT EXISTS pool_region_metrics_hourly (
      bucket_start  INTEGER NOT NULL,          -- unix ts floored to the hour
      region        TEXT    NOT NULL,          -- shares.region ('default' = single-box/public listener)
      hashrate_gps  REAL    NOT NULL DEFAULT 0,-- avg region GPS that hour (from shares)
      miner_count   INTEGER NOT NULL DEFAULT 0,-- distinct miners active on the region that hour
      shares        INTEGER NOT NULL DEFAULT 0,-- accepted shares that hour
      updated_at    INTEGER NOT NULL DEFAULT (unixepoch()),
      PRIMARY KEY (bucket_start, region)
    )`,

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

    // Daily rollup of balance_log — one row per (UTC day, address, event_type, reference_type),
    // written by lib/ledger-rollup.js from the retention pass BEFORE raw rows are pruned
    // (verify-before-delete). NEVER pruned: these dimensions exactly reconstruct every lifetime
    // consumer (payments/transparency totals + long-range series, reconciliation flows and the
    // integrity invariant, pool_fee/prize_pool bucket detail) at ~150 MB per 10 years, so the
    // raw ledger can be kept to a short window (database.balance_log_keep_days). Composite-read
    // rule (rollup vs raw split at the rollup horizon) is documented in lib/ledger-rollup.js.
    `CREATE TABLE IF NOT EXISTS balance_log_daily (
      day INTEGER NOT NULL,
      grin_address TEXT NOT NULL,
      event_type TEXT NOT NULL,
      reference_type TEXT NOT NULL,
      total_amount REAL NOT NULL DEFAULT 0,
      event_count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (day, grin_address, event_type, reference_type)
    )`,

    `CREATE INDEX IF NOT EXISTS idx_bld_address ON balance_log_daily(grin_address, day)`,

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

    // Single-row (id=1) payout kill-switch. When frozen=1 the withdrawal scheduler skips all
    // outbound send paths. Set automatically by AlertMonitor on a critical money trip
    // (coverage shortfall / integrity drift / wallet drain) and manually from the admin
    // Payments page. A missing row means "not frozen" (scheduler treats absence as unfrozen).
    `CREATE TABLE IF NOT EXISTS payout_control (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      frozen INTEGER NOT NULL DEFAULT 0,
      reason TEXT DEFAULT NULL,
      frozen_by TEXT DEFAULT NULL,
      frozen_at INTEGER DEFAULT NULL,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    )`,

    // Wallet-identity anchor (single row, id=1). Stores the pool wallet's slatepack address at
    // derivation index 0 — deterministic from the seed, so a stable per-wallet fingerprint. The
    // AlertMonitor compares the live wallet's address against this; a mismatch means the wallet at
    // the owner API is not the one the pool adopted (accidental/malicious swap, or an unannounced
    // switch) → critical alert + auto-freeze. A planned switch re-adopts via the switch wizard.
    // Absence = never adopted; the first reachable money check adopts on first-use (TOFU).
    `CREATE TABLE IF NOT EXISTS wallet_identity (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      slatepack_address TEXT NOT NULL,
      adopted_at INTEGER NOT NULL DEFAULT (unixepoch()),
      adopted_by TEXT DEFAULT NULL
    )`,

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
      campaign_id INTEGER DEFAULT NULL,
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

    // Contest campaigns — operator-defined draws with an explicit date-range window and optional
    // per-campaign rule overrides (pot split, min active days, whale cap). A campaign runs one
    // lottery draw at/after ends_at (via the scheduler or a manual "run now"); the resulting
    // lottery_draws row is linked back via draw_id. NULL override columns inherit the global
    // lottery_* settings. Eligibility/scoring uses hashrate_history (persistent ~30d), so a
    // multi-day/week window counts real sustained activity — see lib/lottery.js.
    `CREATE TABLE IF NOT EXISTS campaigns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT DEFAULT NULL,
      status TEXT NOT NULL DEFAULT 'scheduled',   -- scheduled | drawn | paid | empty | cancelled
      starts_at INTEGER NOT NULL,
      ends_at INTEGER NOT NULL,                    -- draw fires at/after this time
      recurring TEXT NOT NULL DEFAULT 'none',      -- none | weekly | yearly
      pot_grin REAL NOT NULL DEFAULT 0,            -- fixed pot; 0 = use pot_fraction_percent of the bucket
      pot_fraction_percent REAL DEFAULT NULL,      -- override; NULL = global lottery_pot_fraction_percent
      weighted_percent REAL DEFAULT NULL,          -- Pot A split; NULL = global
      equal_chance_percent REAL DEFAULT NULL,      -- Pot B split; NULL = global
      min_active_days INTEGER DEFAULT NULL,        -- small-miner / anti-sybil gate; NULL = global
      max_ticket_share_percent REAL DEFAULT NULL,  -- whale cap on Pot A tickets; NULL/0 = off
      draw_id INTEGER DEFAULT NULL REFERENCES lottery_draws(id),
      seed_height INTEGER DEFAULT NULL,
      seed_hash TEXT DEFAULT NULL,
      drawn_at INTEGER DEFAULT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    )`,

    `CREATE INDEX IF NOT EXISTS idx_campaigns_status ON campaigns(status, ends_at)`,

    // ─── Multi-region — operator-declared regional endpoints (Model C) ───
    // One row per region/gateway the pool advertises. `region` matches the tag the central
    // stratum-server stamps on shares (from the per-region listener), so /api/pool/stats/regions
    // can left-join live share aggregates onto these labels. Purely descriptive: the real region
    // wiring is the WireGuard peer + per-region port set up by Script 07 (W) Multi-region).
    `CREATE TABLE IF NOT EXISTS pool_locations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      region TEXT NOT NULL UNIQUE,
      label TEXT DEFAULT NULL,
      country TEXT DEFAULT NULL,
      country_code TEXT DEFAULT NULL,
      api_url TEXT DEFAULT NULL,
      stratum_url TEXT DEFAULT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    )`,

    `CREATE INDEX IF NOT EXISTS idx_pool_locations_active ON pool_locations(is_active)`,

    // ─── Network-map geo layers (COUNTRY-ONLY; feeds /api/pool/topology + /api/network/peers) ──
    // Privacy contract (lib/geoip.js): a miner's transient real IP is resolved to a COUNTRY
    // CODE at its first accepted share and ONLY the country is kept here — never the IP, never
    // a city, never coordinates. Map dots are randomized within the country server-side. One
    // row per address; upserted (throttled) so a miner's country stays current without history.
    `CREATE TABLE IF NOT EXISTS miner_geo (
      grin_address TEXT PRIMARY KEY,
      country_code TEXT DEFAULT NULL,
      country      TEXT DEFAULT NULL,
      first_seen   INTEGER NOT NULL DEFAULT (unixepoch()),
      last_seen    INTEGER NOT NULL DEFAULT (unixepoch())
    )`,
    `CREATE INDEX IF NOT EXISTS idx_miner_geo_cc ON miner_geo(country_code)`,

    // Rolling 30-day view of Grin P2P peers seen by THIS pool's node, aggregated to country.
    // peer_key is a truncated sha256(ip) — a stable dedup handle so the same peer isn't double
    // counted across snapshots — the raw IP is NEVER stored. net = 'main' | 'test' (this node's
    // network). Populated by the peer-snapshot collector in index.js; read by /api/network/peers.
    `CREATE TABLE IF NOT EXISTS network_peers (
      peer_key     TEXT PRIMARY KEY,
      country_code TEXT DEFAULT NULL,
      country      TEXT DEFAULT NULL,
      net          TEXT NOT NULL DEFAULT 'main',
      first_seen   INTEGER NOT NULL DEFAULT (unixepoch()),
      last_seen    INTEGER NOT NULL DEFAULT (unixepoch())
    )`,
    `CREATE INDEX IF NOT EXISTS idx_network_peers_seen ON network_peers(last_seen)`,
    `CREATE INDEX IF NOT EXISTS idx_network_peers_cc ON network_peers(country_code, net)`,

    // ─── Ads (operator-managed promotions shown on public pages) ──────────────
    // Two kinds: a self-hosted `banner` (image_url + link_url) or a raw `code` snippet
    // (operator-trusted HTML/JS from an ad network). Each is bound to a named placement
    // (header | sidebar | in-content | footer) with an optional active window + weight.
    `CREATE TABLE IF NOT EXISTS ads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      placement TEXT NOT NULL,
      ad_type TEXT NOT NULL DEFAULT 'banner',
      image_url TEXT DEFAULT NULL,
      link_url TEXT DEFAULT NULL,
      alt_text TEXT DEFAULT NULL,
      html_code TEXT DEFAULT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      weight INTEGER NOT NULL DEFAULT 0,
      start_at INTEGER DEFAULT NULL,
      end_at INTEGER DEFAULT NULL,
      impressions INTEGER NOT NULL DEFAULT 0,
      clicks INTEGER NOT NULL DEFAULT 0,
      notes TEXT DEFAULT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    )`,

    `CREATE INDEX IF NOT EXISTS idx_ads_placement ON ads(placement, is_active, weight DESC)`,

    // ─── Content pages (dynamic CMS — replaces the fixed 5-slot config section) ────
    // Operator-authored standalone pages (About / Terms / a custom Rules page, …),
    // served at /page.html?p=<slug>. Unlimited pages; nav_location decides where it's
    // auto-linked (footer | header | none). HTML is operator-trusted (rendered as-is).
    `CREATE TABLE IF NOT EXISTS pages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      html TEXT NOT NULL DEFAULT '',
      is_published INTEGER NOT NULL DEFAULT 1,
      nav_location TEXT NOT NULL DEFAULT 'footer',
      sort_order INTEGER NOT NULL DEFAULT 0,
      seo_title TEXT DEFAULT NULL,
      seo_desc TEXT DEFAULT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    )`,

    `CREATE INDEX IF NOT EXISTS idx_pages_published ON pages(is_published, nav_location, sort_order)`,

    // ─── Blog posts (dated, chronological — the WordPress-style "Posts" content type) ──
    // Distinct from pages: posts have a publish date, appear in a reverse-chronological
    // feed (/blog), have a clean permalink (/blog/<slug>) and a draft|published status.
    `CREATE TABLE IF NOT EXISTS posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      body_html TEXT NOT NULL DEFAULT '',
      excerpt TEXT DEFAULT NULL,
      cover_image TEXT DEFAULT NULL,
      tags TEXT DEFAULT NULL,
      status TEXT NOT NULL DEFAULT 'draft',
      published_at INTEGER DEFAULT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    )`,

    `CREATE INDEX IF NOT EXISTS idx_posts_published ON posts(status, published_at DESC)`
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
  migrateLotteryDraws();
  migratePoolMetricsHourly();
  migrateLocations();
  migrateAds();
  migratePagesFromConfig();
  // The default grinium regional endpoints are seeded once (see seedDefaultRegions,
  // called from index.js with the configured stratum port). The pool server also
  // self-registers its own region via ensureLocalRegion(); extra zones come from
  // regional gateways the operator declares in admin → Regions.
}

// Additive, non-destructive: add the country grouping columns to an existing
// pool_locations table (older DBs predate them). Lets the public connect grid group
// regional cards under country headings + show a flag.
function migrateLocations() {
  try {
    const cols = db.prepare("PRAGMA table_info(pool_locations)").all();
    if (cols.length === 0) return; // fresh DB: CREATE TABLE above has the columns
    const have = new Set(cols.map(c => c.name));
    const additions = {
      country: 'TEXT DEFAULT NULL',
      country_code: 'TEXT DEFAULT NULL'
    };
    for (const [name, def] of Object.entries(additions)) {
      if (!have.has(name)) {
        db.exec(`ALTER TABLE pool_locations ADD COLUMN ${name} ${def}`);
        console.warn(`[db] pool_locations: added missing column ${name}`);
      }
    }
  } catch (e) {
    console.error(`[db] pool_locations migration check failed: ${e.message}`);
  }
}

// One-time seed of the dynamic `pages` table from the legacy fixed `pool_config`
// 'pages' section (about/terms/privacy/faq/impressum). Runs exactly once, guarded by a
// persistent marker (see below), so it never clobbers operator edits made through the new
// CMS — and never re-seeds even if the operator later deletes every page. Pages with empty
// HTML in the old config are seeded as unpublished drafts (slug preserved) so the operator
// can fill them in later rather than losing the slot.
function migratePagesFromConfig() {
  try {
    // One-time marker so this NEVER re-runs — not even if the operator later deletes every
    // page (a bare "table is empty" guard would wrongly re-seed the legacy drafts on the
    // next restart). The marker lives in pool_config under a private section.
    const marker = db.prepare(
      "SELECT value FROM pool_config WHERE section = '_migrations' AND key = 'pages_seeded'"
    ).get();
    if (marker) return;
    const stamp = db.prepare(`
      INSERT INTO pool_config (section, key, value, value_type)
      VALUES ('_migrations', 'pages_seeded', '1', 'string')
      ON CONFLICT(section, key) DO NOTHING
    `);
    const titles = {
      about: 'About', terms: 'Terms of Service', privacy: 'Privacy Policy',
      faq: 'FAQ', impressum: 'Impressum',
    };
    const rows = db.prepare(
      "SELECT key, value FROM pool_config WHERE section = 'pages'"
    ).all();
    const byKey = {};
    for (const r of rows) byKey[r.key] = r.value;
    // Fall back to the shipped GRINIUM defaults (about/terms/privacy/faq) when the operator
    // never saved a 'pages' config row, so a fresh install gets real, published pages.
    // Required lazily to avoid a load-order cycle at module top.
    const defaultPages = (require('./pool-settings').defaults || {}).pages || {};
    const insert = db.prepare(`
      INSERT OR IGNORE INTO pages (slug, title, html, is_published, nav_location, sort_order)
      VALUES (?, ?, ?, ?, 'footer', ?)
    `);
    let order = 0;
    const tx = db.transaction(() => {
      for (const slug of Object.keys(titles)) {
        const html = (byKey[slug] || defaultPages[slug] || '').trim();
        // INSERT OR IGNORE: if the operator somehow already created one of these slugs,
        // keep theirs. The marker still records that the seed ran. Non-empty pages are
        // published immediately (footer-linked); empty ones (e.g. impressum) stay drafts.
        insert.run(slug, titles[slug], html, html ? 1 : 0, order++);
      }
      stamp.run();   // commit the seeds + the "done" marker atomically
    });
    tx();
  } catch (e) {
    console.error(`[db] migratePagesFromConfig failed: ${e.message}`);
  }
}

// Self-register the pool server's own region (role=singlebox) so the central box
// shows as a real region and auto-joins the connect grid the moment a gateway for
// another zone forwards shares in. Creates ONE row for `region` (skipping the generic
// 'default'), backfills stratum_url once the public hostname is known, and never
// clobbers an operator's label/active/url edits made in admin → Regions.
// One-time seed of the default grinium regional endpoints, grouped by country so the
// public connect grid can show "Point your miner at your nearest region" cards under
// country headings. Runs exactly once, guarded by a persistent marker (like
// migratePagesFromConfig), so it never re-seeds even after the operator deletes/edits
// rows in admin → Regions. INSERT OR IGNORE keeps any operator row that already owns a
// region tag. `stratumPort` is the configured public stratum port (default 3333).
//
// `poolDomain` is the pool's own public hostname (config.subdomain). These are GRINIUM's
// real regional endpoints, so they're seeded ONLY for the actual grinium.com deployment —
// a fork running its own domain must never advertise grinium.com hosts (its miners would
// connect to the wrong pool). Forks get a clean slate and rely on ensureLocalRegion()
// (their own domain as region 1) + admin → Regions to declare more. No marker is stamped
// on the skip path, so once a grinium domain is configured the seed still runs on restart.
function seedDefaultRegions(stratumPort, poolDomain) {
  try {
    const dom = String(poolDomain || '').toLowerCase();
    if (!(dom === 'grinium.com' || dom.endsWith('.grinium.com'))) return;
    // Versioned seed: v1 (2026-06) originally shipped han/nyc/lax/yyz/ams; v2 adds sgn
    // (Saigon). The 'han' (Hanoi) row was later dropped from the seed — fresh installs no
    // longer get it; already-seeded installs keep any han row until the operator removes it
    // via the admin Regions page (the seed never retroactively deletes).
    // The marker value stores the applied version — the legacy marker wrote '1', which
    // reads back as "v1 applied", so an already-seeded install inserts ONLY the newer
    // additions. Rows the operator deleted from an already-applied version are never
    // re-created (that version doesn't re-run).
    const SEED_VERSION = 2;
    const marker = db.prepare(
      "SELECT value FROM pool_config WHERE section = '_migrations' AND key = 'regions_seeded'"
    ).get();
    const applied = marker ? (parseInt(marker.value, 10) || 1) : 0;
    if (applied >= SEED_VERSION) return;
    const port = stratumPort || 3333;
    // city = label; country/country_code drive grouping + flag on the dashboard.
    const REGIONS = [
      { v: 1, region: 'nyc', label: 'New York',    country: 'United States',  cc: 'US', host: 'nyc.grinium.com' },
      { v: 1, region: 'lax', label: 'Los Angeles', country: 'United States',  cc: 'US', host: 'lax.grinium.com' },
      { v: 1, region: 'yyz', label: 'Toronto',     country: 'Canada',         cc: 'CA', host: 'yyz.grinium.com' },
      { v: 1, region: 'ams', label: 'Amsterdam',   country: 'Netherlands',    cc: 'NL', host: 'ams.grinium.com' },
      { v: 2, region: 'sgn', label: 'Saigon',      country: 'Vietnam',        cc: 'VN', host: 'sgn.grinium.com' }
    ];
    const pending = REGIONS.filter(r => r.v > applied);
    const insert = db.prepare(`
      INSERT OR IGNORE INTO pool_locations
        (region, label, country, country_code, stratum_url, is_active)
      VALUES (?, ?, ?, ?, ?, 1)
    `);
    const stamp = db.prepare(`
      INSERT INTO pool_config (section, key, value, value_type)
      VALUES ('_migrations', 'regions_seeded', ?, 'string')
      ON CONFLICT(section, key) DO UPDATE SET value = excluded.value
    `);
    const tx = db.transaction(() => {
      for (const r of pending) {
        insert.run(r.region, r.label, r.country, r.cc, `${r.host}:${port}`);
      }
      stamp.run(String(SEED_VERSION)); // seed + "done" marker committed atomically
    });
    tx();
    console.warn(`[db] seeded ${pending.length} default regional endpoints (v${applied}→v${SEED_VERSION}, port ${port})`);
  } catch (e) {
    console.error(`[db] seedDefaultRegions failed: ${e.message}`);
  }
}

// Register / keep up to date the central box's own region row. `opts` carries the
// operator-supplied location (set in 2) Configure → region_label/country/country_code):
//   { label, country, country_code }
// Backfilling rule mirrors stratum_url: only fill a field that is still empty/NULL, so a
// fresh config edit applies on the next restart but admin → Regions edits are never clobbered.
function ensureLocalRegion(region, stratumUrl, opts = {}) {
  if (!region || region === 'default') return;
  const label = opts.label || (region.charAt(0).toUpperCase() + region.slice(1));
  const country = opts.country || null;
  const cc = opts.country_code ? String(opts.country_code).toUpperCase() : null;
  try {
    const row = db.prepare(
      'SELECT region, label, country, country_code, stratum_url FROM pool_locations WHERE region = ?'
    ).get(region);
    if (!row) {
      db.prepare(
        'INSERT INTO pool_locations (region, label, country, country_code, stratum_url, is_active) VALUES (?, ?, ?, ?, ?, 1)'
      ).run(region, label, country, cc, stratumUrl || null);
      console.warn(`[db] registered local region '${region}'${stratumUrl ? ' (' + stratumUrl + ')' : ''}`);
      return;
    }
    // Backfill only empty fields (the row may predate these columns, or have been created
    // on a pre-nginx first boot when subdomain/location were still blank).
    const sets = [], vals = [];
    if (stratumUrl && !row.stratum_url)      { sets.push('stratum_url = ?');  vals.push(stratumUrl); }
    if (opts.label && !row.label)            { sets.push('label = ?');        vals.push(label); }
    if (country && !row.country)             { sets.push('country = ?');      vals.push(country); }
    if (cc && !row.country_code)             { sets.push('country_code = ?'); vals.push(cc); }
    if (sets.length) {
      vals.push(region);
      db.prepare(`UPDATE pool_locations SET ${sets.join(', ')} WHERE region = ?`).run(...vals);
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
  ensureLocalRegion,
  seedDefaultRegions
};
