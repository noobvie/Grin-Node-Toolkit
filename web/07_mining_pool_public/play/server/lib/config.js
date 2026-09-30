'use strict';

// Service configuration — environment only (the systemd unit's Environment= lines,
// design §19.12). Every value is validated, and a bad one refuses the start with a
// one-line reason (index.js exits with EX_CONFIG) rather than running on a guess.
//
// What is deliberately NOT configurable:
//   - the listen address. It is 127.0.0.1, always: nginx is the only way in (§19.2), and
//     a knob here is one typo from exposing the service on every interface.
//   - the link secret itself. Only its PATH is configured; the secret is read from the
//     file when it is needed (§19.3), because an Environment= line is visible to anyone
//     who can run `systemctl show`.

const path = require('node:path');

const NETS = {
  mainnet: { port: 8081, poolPort: 8080 },
  testnet: { port: 8091, poolPort: 8090 },
};

// The server's own code dir: /opt/grin/pubgames/<net>/ on the box. It is
// `rsync --delete`d on every deploy (§19.12), so nothing the service writes may live in it.
const CODE_DIR = path.resolve(__dirname, '..');

// Every GAMES_* variable this build reads. An unknown one is refused, so a typo'd key
// (GAMES_PROT=9000) fails the start instead of silently leaving the default in force.
// A later part that adds a variable adds it here.
const KNOWN_GAMES_KEYS = new Set([
  'GAMES_NET', 'GAMES_PORT', 'GAMES_DB', 'GAMES_LINK_SECRET_FILE', 'GAMES_GAMES_DIR',
]);

class ConfigError extends Error {}

// Quote a value for the error line, bounded so a pasted blob cannot flood the log.
function shown(v) {
  const s = JSON.stringify(String(v));
  return s.length > 82 ? `${s.slice(0, 80)}…"` : s;
}

function fail(key, value, why) {
  throw new ConfigError(`${key}=${shown(value)}: ${why}`);
}

function isInside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function absPath(key, value) {
  if (typeof value !== 'string' || value === '') fail(key, value, 'must be an absolute path');
  if (value.includes('\0')) fail(key, '(contains NUL)', 'must not contain a NUL byte');
  if (value.length > 4096) fail(key, value, 'path too long');
  if (!path.isAbsolute(value)) fail(key, value, 'must be an absolute path');
  return path.resolve(value);
}

// A port is digits only: parseInt would take '8081abc', Number would take '1e4' and '0x1f91'.
function port(key, value) {
  if (!/^[1-9][0-9]{0,4}$/.test(value)) fail(key, value, 'must be an integer 1024-65535');
  const n = Number(value);
  if (n < 1024 || n > 65535) fail(key, value, 'must be an integer 1024-65535');
  return n;
}

// The pool's internal listener. The link secret is sent to this URL (Part 4), so it must
// be the pool on THIS box: plain http to a literal loopback address with an explicit port,
// nothing else. `localhost` is refused because it is a name, and a name can resolve away.
function poolUrl(key, value) {
  let u;
  try { u = new URL(value); } catch { fail(key, value, 'not a URL'); }
  if (u.protocol !== 'http:') fail(key, value, 'must be http:// (loopback, never via nginx)');
  if (u.hostname !== '127.0.0.1' && u.hostname !== '[::1]') {
    fail(key, value, 'host must be 127.0.0.1 or [::1]');
  }
  if (u.username || u.password) fail(key, value, 'must not carry credentials');
  if (!u.port) fail(key, value, 'must name the port explicitly');
  if (u.pathname !== '/' || u.search || u.hash) fail(key, value, 'must be an origin only (no path, query or fragment)');
  return { url: `http://${u.hostname}:${u.port}`, port: Number(u.port) };
}

function loadConfig(env = process.env) {
  for (const k of Object.keys(env)) {
    if (k.startsWith('GAMES_') && !KNOWN_GAMES_KEYS.has(k)) {
      fail(k, env[k], 'unknown GAMES_* variable (typo?)');
    }
  }

  // No default network: opening the wrong net's DB is the mistake this whole layout exists
  // to prevent, and db.js also refuses a DB stamped with the other net.
  const net = env.GAMES_NET;
  if (!Object.prototype.hasOwnProperty.call(NETS, net)) {
    fail('GAMES_NET', net === undefined ? '' : net, 'must be mainnet or testnet');
  }
  const d = NETS[net];

  const listenPort = env.GAMES_PORT === undefined ? d.port : port('GAMES_PORT', env.GAMES_PORT);

  const dbPath = absPath('GAMES_DB', env.GAMES_DB === undefined
    ? `/opt/grin/pubgames-data/${net}/grinium-games.db`
    : env.GAMES_DB);
  if (!/\.db$/.test(dbPath)) fail('GAMES_DB', dbPath, 'must end in .db');
  if (isInside(dbPath, CODE_DIR)) {
    fail('GAMES_DB', dbPath, `must live outside the code dir ${CODE_DIR} (deploy rsync --delete would remove it)`);
  }

  const linkSecretFile = absPath('GAMES_LINK_SECRET_FILE', env.GAMES_LINK_SECRET_FILE === undefined
    ? `/opt/grin/conf/grin_pubgames_link_${net}`
    : env.GAMES_LINK_SECRET_FILE);

  const pool = poolUrl('POOL_INTERNAL_URL', env.POOL_INTERNAL_URL === undefined
    ? `http://127.0.0.1:${d.poolPort}`
    : env.POOL_INTERNAL_URL);
  if (pool.port === listenPort) fail('GAMES_PORT', listenPort, 'must differ from the pool\'s port');

  // Where the game folders (manifest.json + rules.js) are deployed: <code dir>/games/ on the
  // box. Existence is the registry's concern (Part 5) — no games is a valid, logged state.
  const gamesDir = absPath('GAMES_GAMES_DIR', env.GAMES_GAMES_DIR === undefined
    ? path.join(CODE_DIR, 'games')
    : env.GAMES_GAMES_DIR);
  if (isInside(dbPath, gamesDir)) fail('GAMES_DB', dbPath, 'must not live inside GAMES_GAMES_DIR');

  return Object.freeze({
    net,
    host: '127.0.0.1',
    port: listenPort,
    dbPath,
    linkSecretFile,
    poolInternalUrl: pool.url,
    gamesDir,
    codeDir: CODE_DIR,
  });
}

module.exports = { loadConfig, ConfigError, KNOWN_GAMES_KEYS, CODE_DIR, isInside };
