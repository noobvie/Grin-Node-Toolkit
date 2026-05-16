const fs = require('fs');
const path = require('path');

function loadConfig(configPath = './pool.json') {
  let config = {};

  if (fs.existsSync(configPath)) {
    const raw = fs.readFileSync(configPath, 'utf-8');
    config = JSON.parse(raw);
  }

  config = mergeEnvVars(config);

  validateConfig(config);

  return config;
}

function mergeEnvVars(config) {
  return {
    port: config.port || parseInt(process.env.POOL_PORT || '8080', 10),
    stratum_port: config.stratum_port || parseInt(process.env.STRATUM_PORT || '3333', 10),
    network: config.network || process.env.POOL_NETWORK || 'testnet',
    jwt_secret: config.jwt_secret || process.env.JWT_SECRET || generateSecret(),
    pool_fee_percent: config.pool_fee_percent !== undefined ? config.pool_fee_percent : 2.0,
    min_withdrawal: config.min_withdrawal !== undefined ? config.min_withdrawal : 0.1,
    confirm_depth_mainnet: config.confirm_depth_mainnet || 1441,
    confirm_depth_testnet: config.confirm_depth_testnet || 100,

    wallet_dir: config.wallet_dir || process.env.POOL_WALLET_DIR || '/opt/grin/pool-test/',
    wallet_owner_port: config.wallet_owner_port || 13420,
    wallet_foreign_port: config.wallet_foreign_port || 13415,

    node_api_url: config.node_api_url || process.env.NODE_API_URL || 'http://127.0.0.1:13413',
    node_api_secret: config.node_api_secret || process.env.NODE_API_SECRET || '',

    db_path: config.db_path || process.env.POOL_DB || './pool.sqlite',

    tor_enabled: config.tor_enabled !== undefined ? config.tor_enabled : true,
    tor_socks_port: config.tor_socks_port || 9050,
    tor_check_timeout_ms: config.tor_check_timeout_ms || 3000,

    alert_large_withdrawal: config.alert_large_withdrawal || 100,
    alert_tor_fails_per_week: config.alert_tor_fails_per_week || 3,
    alert_rapid_creates: config.alert_rapid_creates || 2,

    withdrawal_retry_delays: config.withdrawal_retry_delays || [
      6 * 3600,
      12 * 3600,
      24 * 3600,
      48 * 3600
    ]
  };
}

function validateConfig(config) {
  const required = ['jwt_secret', 'wallet_dir', 'node_api_url', 'db_path'];
  const missing = required.filter(key => !config[key]);

  if (missing.length > 0) {
    throw new Error(`Missing required config keys: ${missing.join(', ')}`);
  }

  if (!['mainnet', 'testnet'].includes(config.network)) {
    throw new Error(`Invalid network: ${config.network}. Must be 'mainnet' or 'testnet'`);
  }

  if (config.pool_fee_percent < 0 || config.pool_fee_percent > 100) {
    throw new Error(`Invalid pool_fee_percent: ${config.pool_fee_percent}`);
  }

  if (config.min_withdrawal <= 0) {
    throw new Error(`Invalid min_withdrawal: ${config.min_withdrawal}`);
  }
}

function generateSecret() {
  return require('crypto').randomBytes(32).toString('hex');
}

function getConfirmDepth(network) {
  const config = loadConfig();
  return network === 'mainnet'
    ? config.confirm_depth_mainnet
    : config.confirm_depth_testnet;
}

function mergeDbSettings(config, db) {
  try {
    const PoolSettings = require('./pool-settings');
    const settings = new PoolSettings(db);
    const allSettings = settings.getAll();

    // Apply DB settings to config (only non-infrastructure keys)
    config = PoolSettings.applyToConfig(config, allSettings);
  } catch (err) {
    console.error(`[Config] Warning: Failed to merge DB settings: ${err.message}`);
    // Continue with file-based config if DB merge fails
  }

  return config;
}

module.exports = {
  loadConfig,
  getConfirmDepth,
  mergeDbSettings
};
