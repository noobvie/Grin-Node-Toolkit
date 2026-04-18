'use strict';
/**
 * config.js — Load and update grin_drop_<net>.conf
 *
 * Config path is supplied via the DROP_CONF environment variable:
 *   Mainnet: /opt/grin/drop-main/grin_drop_main.conf
 *   Testnet: /opt/grin/drop-test/grin_drop_test.conf
 *
 * All reads use a fresh fs.readFileSync so runtime changes (e.g. from
 * the admin settings panel) take effect without restarting the process.
 */

const fs   = require('fs');
const path = require('path');

const CONF_PATH = process.env.DROP_CONF
  || '/opt/grin/drop-test/grin_drop_test.conf';

const DEFAULTS = {
  // ── Identity ──────────────────────────────────────────────────────────────
  drop_name:              'Grin Drop',
  theme_default:          'matrix',
  network:                'testnet',     // 'testnet' | 'mainnet'

  // ── Giveaway ──────────────────────────────────────────────────────────────
  giveaway_enabled:          true,
  claim_grin_per_tx:         1.0,        // max GRIN sent in one claim transaction (server-side cap)
  claim_cooldown_hours:         24,       // per-address/IP: hours before the same address can claim again (1 claim per window)
  slatepack_expire_min:         30,       // minutes user has to paste response slatepack
  global_daily_claims_cap:      2000,     // 0 = unlimited; max total claims site-wide per day (all users combined, resets midnight UTC)
  global_hourly_claims_cap:     100,      // 0 = unlimited; max total claims site-wide per hour (all users combined)

  // ── Donation ──────────────────────────────────────────────────────────────
  donation_enabled:          true,
  donation_invoice_timeout:  30,   // minutes before invoice expires

  // ── Wallet identity ───────────────────────────────────────────────────────
  wallet_address:            '',

  // ── Wallet HTTP API ports (set by bash option 4 Configure) ────────────────
  wallet_foreign_api_port:   13415,
  wallet_owner_api_port:     13420,

  // ── Wallet API secret files (absolute paths, chmod 600) ───────────────────
  wallet_foreign_secret:  '/opt/grin/drop-test/.foreign_api_secret',
  wallet_owner_secret:    '/opt/grin/drop-test/.owner_api_secret',

  // ── Wallet pass file (read by wallet.js, never logged) ────────────────────
  wallet_pass_file:       '/opt/grin/drop-test/.temp_test',

  // ── Service ───────────────────────────────────────────────────────────────
  service_port:           3004,

  // ── Public stats ──────────────────────────────────────────────────────────
  show_public_stats:      true,

  // ── Maintenance ───────────────────────────────────────────────────────────
  maintenance_mode:       false,
  maintenance_message:    "We'll be back soon. Thank you for your patience.",

  // ── Alerts (logged to journal; use fail2ban / monitoring to act on them) ──
  low_balance_alert_grin: -1,   // -1 = auto (1000 testnet / 100 mainnet), 0 = disabled, >0 = fixed floor

  // ── Wallet cleanup ────────────────────────────────────────────────────────
  wallet_cleanup_hours:   1,     // auto-cancel unfinalized wallet txs older than this; 0 = disabled

  // ── Anonymous claim IP salt (set once by bash drop_ensure_defaults) ──────
  ip_salt:                '',    // empty = falls back to env IP_SALT or built-in default

  // ── Logging ───────────────────────────────────────────────────────────────
  log_path:               '/opt/grin/drop-test/grin_drop_test.log',
};

/** Load config, merging with defaults for any missing keys. */
function loadConfig() {
  const cfg = { ...DEFAULTS };
  if (fs.existsSync(CONF_PATH)) {
    try {
      const raw = fs.readFileSync(CONF_PATH, 'utf8');
      Object.assign(cfg, JSON.parse(raw));
    } catch {
      // Corrupted config — fall back to defaults
    }
  }
  return cfg;
}

/**
 * Write a single key/value into the config file.
 * Numeric and boolean keys are coerced automatically.
 */
function writeConfigKey(key, value) {
  const cfg = loadConfig();
  const numKeys = new Set([
    'claim_grin_per_tx', 'claim_cooldown_hours', 'slatepack_expire_min',
    'global_daily_claims_cap', 'global_hourly_claims_cap',
    'service_port', 'wallet_foreign_api_port', 'wallet_owner_api_port',
    'donation_invoice_timeout', 'low_balance_alert_grin', 'wallet_cleanup_hours',
  ]);
  const boolKeys = new Set([
    'giveaway_enabled', 'donation_enabled', 'show_public_stats',
    'maintenance_mode',
  ]);
  if (numKeys.has(key)) {
    cfg[key] = parseFloat(value);
  } else if (boolKeys.has(key)) {
    cfg[key] = (value === true || value === 'true' || value === '1' || value === 'yes');
  } else {
    cfg[key] = value;
  }
  saveConfig(cfg);
}

/** Overwrite the entire config file with the given object. */
function saveConfig(cfg) {
  const dir = path.dirname(CONF_PATH);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(CONF_PATH, JSON.stringify(cfg, null, 2), { mode: 0o600 });
}

module.exports = { loadConfig, writeConfigKey, CONF_PATH };
