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
  // ── Site ──────────────────────────────────────────────────────────────────
  drop_name:              'Grin Drop',
  site_description:       'Claim free GRIN or donate to keep the drop running.',
  og_image_url:           '',
  subdomain:              '',
  theme_default:          'matrix',

  // ── Giveaway ──────────────────────────────────────────────────────────────
  claim_amount_grin:      2.0,
  claim_window_hours:     24,
  finalize_timeout_min:   5,
  giveaway_enabled:       true,

  // ── Donation ──────────────────────────────────────────────────────────────
  donation_enabled:       true,
  donation_invoice_timeout: 30,   // minutes before invoice expires

  // ── Wallet identity ───────────────────────────────────────────────────────
  wallet_address:         '',

  // ── Wallet HTTP API ports (set by bash option 4 Configure) ────────────────
  wallet_foreign_api_port: 13415,
  wallet_owner_api_port:   13420,

  // ── Wallet API secret files (absolute paths, chmod 600) ───────────────────
  wallet_foreign_secret:  '/opt/grin/drop-test/wallet/wallet_data/.api_secret',
  wallet_owner_secret:    '/opt/grin/drop-test/wallet/.owner_api_secret',

  // ── Wallet pass file (read by wallet.js, never logged) ────────────────────
  wallet_pass_file:       '/opt/grin/drop-test/.wallet_pass_test',

  // ── Service ───────────────────────────────────────────────────────────────
  service_port:           3004,
  network:                'testnet',     // 'testnet' | 'mainnet'

  // ── Public stats ──────────────────────────────────────────────────────────
  show_public_stats:      true,

  // ── Admin ─────────────────────────────────────────────────────────────────
  admin_secret_path:      '',

  // ── Maintenance ───────────────────────────────────────────────────────────
  maintenance_mode:       false,
  maintenance_message:    "We'll be back soon. Thank you for your patience.",

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
    'claim_amount_grin', 'claim_window_hours', 'finalize_timeout_min',
    'service_port', 'wallet_foreign_api_port', 'wallet_owner_api_port',
    'donation_invoice_timeout',
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

module.exports = { loadConfig, writeConfigKey, saveConfig, CONF_PATH };
