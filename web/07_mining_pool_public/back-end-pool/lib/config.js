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
    // NOTE: no auto-generate fallback — a missing secret must fail loudly at boot
    // (see validateConfig). Auto-minting one here would silently invalidate every admin
    // session on each restart. The Script 07 installer writes it once into pool.json.
    jwt_secret: config.jwt_secret || process.env.JWT_SECRET || '',
    pool_fee_percent: config.pool_fee_percent !== undefined ? config.pool_fee_percent : 1.0,
    min_withdrawal: config.min_withdrawal !== undefined ? config.min_withdrawal : 5.0,
    // Grin COINBASE_MATURITY = 1440; a coinbase cannot be spent until 1440 confirmations,
    // so payouts must wait at least that long to be reorg-safe.
    confirm_depth_mainnet: config.confirm_depth_mainnet || 1440,
    confirm_depth_testnet: config.confirm_depth_testnet || 100,

    wallet_dir: config.wallet_dir || process.env.POOL_WALLET_DIR || '/opt/grin/pool-test/',
    wallet_owner_port: config.wallet_owner_port || 13420,
    wallet_foreign_port: config.wallet_foreign_port || 13415,

    node_api_url: config.node_api_url || process.env.NODE_API_URL || 'http://127.0.0.1:13413',
    // Owner + Foreign API secrets. Either pass the value directly, or a *_path to the
    // node's secret file, or leave all blank and let grin-node.js read the standard
    // /opt/grin/node/<net>-prune/.{api,foreign_api}_secret files (pool runs as root).
    node_api_secret: config.node_api_secret || process.env.NODE_API_SECRET || '',
    node_api_secret_path: config.node_api_secret_path || process.env.NODE_API_SECRET_PATH || '',
    node_foreign_api_secret: config.node_foreign_api_secret || process.env.NODE_FOREIGN_API_SECRET || '',
    node_foreign_api_secret_path: config.node_foreign_api_secret_path || process.env.NODE_FOREIGN_API_SECRET_PATH || '',
    node_dir: config.node_dir || process.env.NODE_DIR || '',

    node_stratum_host: config.node_stratum_host || '127.0.0.1',
    node_stratum_port: config.node_stratum_port || (config.network === 'mainnet' ? 3334 : 13334),
    pool_address:      config.pool_address || '',
    wallet_pass_file:  config.wallet_pass_file || '',

    db_path: config.db_path || process.env.POOL_DB || './pool.sqlite',

    // Directory for operator-uploaded white-label assets (logos, icons, OG image).
    // Served by nginx at /custom/<file>; defaults under the app's working directory.
    assets_dir: config.assets_dir || process.env.POOL_ASSETS_DIR || './custom_assets',

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
    ],

    // ─── Multi-region (Model C: thin stratum gateways) ──────────────────────
    // role: singlebox (default) | hub. Regional GATEWAYS are NOT a pool app role — they
    // run no Node process; they are HAProxy+WireGuard forwarders (scripts/lib/07_lib_gateway.sh)
    // that tunnel miner stratum to a per-region internal port on this central box. So this
    // app only ever runs as singlebox or hub. (The legacy 'satellite' role + relay are gone.)
    role: config.role || process.env.POOL_ROLE || 'singlebox',
    region: config.region || process.env.POOL_REGION || 'default',

    // ─── Model C: regional stratum gateways ─────────────────────────────────
    // Internal per-region stratum listener ports on THIS central box, bound to the
    // WireGuard interface ONLY (never public). A regional gateway forwards its miners'
    // stratum traffic — prefixed with a PROXY-protocol v2 header carrying the real miner
    // IP — over the tunnel to its region's port here; the central stratum-server stamps
    // that listener's region label on every share. Map of { "<region>": <port> },
    // e.g. { "asia": 3391, "us": 3392 }. Empty {} = single-box (only the public
    // stratum_port listener runs). Miners ALWAYS connect to the public stratum_port on
    // their nearest gateway — these ports are internal plumbing, never miner-facing.
    region_ports: config.region_ports || {},
    // Address the per-region listeners bind to. MUST be the WireGuard server IP in prod so
    // only tunnelled gateways can reach them; defaults to loopback so a misconfigured box
    // never exposes them publicly. The Script 07 installer sets this to the wg server IP.
    region_listen_host: config.region_listen_host || process.env.REGION_LISTEN_HOST || '127.0.0.1',

    // Public web/stratum hostname (e.g. grinium.com). Used to derive the local
    // region's connect address (subdomain:stratum_port) in db.ensureLocalRegion.
    subdomain: config.subdomain || process.env.POOL_SUBDOMAIN || ''
  };
}

function validateConfig(config) {
  // Both remaining roles (singlebox/hub) serve the admin auth surface, so a persistent
  // jwt_secret is always required. Fail loudly on a missing/weak one rather than
  // auto-generating at boot — a fresh secret each restart silently logs out every admin
  // and breaks refresh tokens. The Script 07 installer writes it once into pool.json.
  if (!config.jwt_secret || String(config.jwt_secret).length < 32) {
    throw new Error(
      'FATAL: jwt_secret is missing or too short (need ≥32 chars) in pool.json. ' +
      'It must be generated ONCE at install and persisted, never minted at boot. ' +
      'Re-run the Script 07 installer/configure step to set it.'
    );
  }

  const required = ['wallet_dir', 'node_api_url', 'db_path'];
  const missing = required.filter(key => !config[key]);

  if (missing.length > 0) {
    throw new Error(`Missing required config keys: ${missing.join(', ')}`);
  }

  if (!['mainnet', 'testnet'].includes(config.network)) {
    throw new Error(`Invalid network: ${config.network}. Must be 'mainnet' or 'testnet'`);
  }

  if (config.pool_fee_percent < 0 || config.pool_fee_percent > 50) {
    throw new Error(`Invalid pool_fee_percent: ${config.pool_fee_percent}`);
  }

  if (config.min_withdrawal <= 0) {
    throw new Error(`Invalid min_withdrawal: ${config.min_withdrawal}`);
  }
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
