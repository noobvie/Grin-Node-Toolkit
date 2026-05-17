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

// Derive network from the config file path so fallback defaults are self-consistent.
const _IS_MAINNET = CONF_PATH.includes('drop-main');
const _NET        = _IS_MAINNET ? 'mainnet' : 'testnet';
const _DIR        = _IS_MAINNET ? '/opt/grin/drop-main' : '/opt/grin/drop-test';
const _SUFFIX     = _IS_MAINNET ? 'main' : 'test';

const DEFAULTS = {
  // ── Identity ──────────────────────────────────────────────────────────────
  drop_name:              _IS_MAINNET ? 'Grin Drop' : 'Grin Drop [TESTNET]',
  theme_default:          _IS_MAINNET ? 'win98' : 'matrix',
  network:                _NET,

  // ── Giveaway ──────────────────────────────────────────────────────────────
  giveaway_enabled:          true,
  claim_grin_per_tx:         _IS_MAINNET ? 0.008 : 3.0,  // server-side cap per claim
  claim_cooldown_minutes:       240,      // per-address/IP cooldown (240 = 4h)
  slatepack_expire_min:         30,       // minutes user has to paste response slatepack
  global_daily_claims_cap:      2000,     // 0 = unlimited; resets midnight UTC
  global_hourly_claims_cap:     100,      // 0 = unlimited

  // ── Donation ──────────────────────────────────────────────────────────────
  donation_enabled:          true,
  donation_invoice_timeout:  30,   // minutes before invoice expires

  // ── Wallet identity ───────────────────────────────────────────────────────
  wallet_address:            '',

  // ── Wallet HTTP API ports ──────────────────────────────────────────────────
  wallet_foreign_api_port:   _IS_MAINNET ? 3415  : 13415,
  wallet_owner_api_port:     _IS_MAINNET ? 3420  : 13420,

  // ── Wallet API secret files (absolute paths, chmod 600) ───────────────────
  wallet_foreign_secret:  `${_DIR}/.foreign_api_secret`,
  wallet_owner_secret:    `${_DIR}/.owner_api_secret`,

  // ── Wallet pass file (read by wallet.js, never logged) ────────────────────
  wallet_pass_file:       `${_DIR}/.temp_${_SUFFIX}`,

  // ── Service ───────────────────────────────────────────────────────────────
  service_port:           _IS_MAINNET ? 3005 : 3004,

  // ── Public stats ──────────────────────────────────────────────────────────
  show_public_stats:      true,

  // ── Maintenance ───────────────────────────────────────────────────────────
  maintenance_mode:       false,
  maintenance_message:    "We'll be back soon. Thank you for your patience.",

  // ── Alerts (logged to journal; use fail2ban / monitoring to act on them) ──
  low_balance_alert_grin: -1,   // -1 = auto (1000 testnet / 100 mainnet), 0 = disabled, >0 = fixed floor

  // ── Wallet cleanup ────────────────────────────────────────────────────────
  wallet_cleanup_hours:   1,     // auto-cancel unfinalized wallet txs older than this; 0 = disabled

  // ── Cloudflare Turnstile (optional bot protection) ────────────────────────
  turnstile_secret:       '',    // server-side secret key; empty = Turnstile disabled

  // ── Anonymous claim IP salt (set once by bash drop_ensure_defaults) ──────
  ip_salt:                '',    // empty = falls back to env IP_SALT or built-in default

  // ── Logging ───────────────────────────────────────────────────────────────
  log_path:               `${_DIR}/grin_drop_${_SUFFIX}.log`,
};

/** Load config, merging with defaults for any missing keys. */
function loadConfig() {
  const cfg = { ...DEFAULTS };
  if (fs.existsSync(CONF_PATH)) {
    try {
      const raw = fs.readFileSync(CONF_PATH, 'utf8');
      const fileData = JSON.parse(raw);
      // Migrate old claim_cooldown_hours → claim_cooldown_minutes
      if (fileData.claim_cooldown_hours != null && fileData.claim_cooldown_minutes == null) {
        fileData.claim_cooldown_minutes = Math.round(fileData.claim_cooldown_hours * 60);
        delete fileData.claim_cooldown_hours;
      }
      Object.assign(cfg, fileData);
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
    'claim_grin_per_tx', 'claim_cooldown_minutes', 'slatepack_expire_min',
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
