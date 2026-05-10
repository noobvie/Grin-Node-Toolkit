'use strict';

const express  = require('express');
const { DatabaseSync } = require('node:sqlite');
const fs       = require('fs');
const path     = require('path');
const http     = require('http');
const https    = require('https');

// ── Config ───────────────────────────────────────────────────────────────────

const configPath = process.env.GRINSCAN_CONFIG;
if (!configPath) {
  console.error('GRINSCAN_CONFIG environment variable is required');
  process.exit(1);
}
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

const pkg     = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
const VERSION = pkg.version;

// ── Secrets ──────────────────────────────────────────────────────────────────

function readSecret(p) {
  try { return fs.readFileSync(p, 'utf8').trim(); } catch { return ''; }
}
const foreignSecret = readSecret(config.foreign_secret_path);
const ownerSecret   = readSecret(config.owner_secret_path);

// ── Logging ──────────────────────────────────────────────────────────────────

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  process.stdout.write(line);
  try { fs.appendFileSync(config.log_path, line); } catch {}
}

// ── SQLite ───────────────────────────────────────────────────────────────────

const db = new DatabaseSync(config.db_path);
db.exec(`
  CREATE TABLE IF NOT EXISTS blocks (
    height        INTEGER PRIMARY KEY,
    hash          TEXT    NOT NULL,
    prev_hash     TEXT    NOT NULL DEFAULT '',
    timestamp     INTEGER NOT NULL,
    difficulty    INTEGER NOT NULL DEFAULT 0,
    kernel_count  INTEGER NOT NULL DEFAULT 0,
    tx_count      INTEGER NOT NULL DEFAULT 0,
    fee_total     INTEGER NOT NULL DEFAULT 0,
    raw_json      TEXT    NOT NULL DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS idx_blocks_timestamp ON blocks(timestamp DESC);

  CREATE TABLE IF NOT EXISTS prices (
    timestamp   INTEGER PRIMARY KEY,
    price_btc   REAL    NOT NULL DEFAULT 0,
    price_usd   REAL    NOT NULL DEFAULT 0,
    source      TEXT    NOT NULL DEFAULT ''
  );
`);

const stmtInsertBlock = db.prepare(`
  INSERT OR REPLACE INTO blocks
    (height, hash, prev_hash, timestamp, difficulty, kernel_count, tx_count, fee_total, raw_json)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const stmtMaxHeight   = db.prepare('SELECT MAX(height) AS m FROM blocks');
const stmtMinHeight   = db.prepare('SELECT MIN(height) AS m FROM blocks');
const stmtGetByHeight = db.prepare('SELECT raw_json FROM blocks WHERE height = ?');
const stmtGetByHash   = db.prepare('SELECT raw_json FROM blocks WHERE hash = ?');
const stmtListBlocks  = db.prepare(
  'SELECT height, hash, timestamp, tx_count, fee_total, kernel_count, difficulty FROM blocks ORDER BY height DESC LIMIT ? OFFSET ?'
);
const stmtCountBlocks = db.prepare('SELECT COUNT(*) AS c FROM blocks');
const stmtPruneBlocks = db.prepare('DELETE FROM blocks WHERE height < ?');
// Per-block difficulty = total_difficulty[n] - total_difficulty[n-1] via self-join
const stmtHistory = db.prepare(`
  SELECT b1.height, b1.timestamp,
         MAX(0, b1.difficulty - COALESCE(b2.difficulty, 0)) AS difficulty
  FROM   blocks b1
  LEFT JOIN blocks b2 ON b2.height = b1.height - 1
  WHERE  b1.timestamp BETWEEN ? AND ?
  ORDER BY ABS(b1.timestamp - ?)
  LIMIT 1
`);
const stmtTopTwoDiff = db.prepare(
  'SELECT height, difficulty FROM blocks ORDER BY height DESC LIMIT 2'
);
const stmtInsertPrice = db.prepare(
  'INSERT OR REPLACE INTO prices (timestamp, price_btc, price_usd, source) VALUES (?, ?, ?, ?)'
);
const stmtPrunePrice  = db.prepare('DELETE FROM prices WHERE timestamp < ?');
const stmtPrice24h    = db.prepare(
  'SELECT price_usd FROM prices WHERE timestamp <= ? ORDER BY timestamp DESC LIMIT 1'
);
const stmtPriceHist   = db.prepare(
  'SELECT timestamp, price_btc, price_usd FROM prices WHERE timestamp >= ? ORDER BY timestamp ASC'
);

// ── In-memory state ──────────────────────────────────────────────────────────

const tipState = {
  height: 0, hash: '', difficulty: 0, hashrate_gps: 0,
  peer_count: 0, stalled: false, syncing: false, node_version: 'unknown',
  pool_size: 0, stem_pool_size: 0,
  backfill_active: false,
  backfill_min: null,
  backfill_pruned: false,
};
let peerVersionMap = {};
let latestPrice    = null; // { price_btc, price_usd, change_24h_pct, fetched_at, sources, stale }

// ── Stall tracking ───────────────────────────────────────────────────────────

let stallCount    = 0;
let lastTipHeight = 0;

// ── Chain data size (5-min TTL cache) ────────────────────────────────────────

function getDirSizeBytes(dirPath) {
  try {
    let total = 0;
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const e of entries) {
      const fp = path.join(dirPath, e.name);
      if (e.isFile()) total += fs.statSync(fp).size;
      else if (e.isDirectory()) total += getDirSizeBytes(fp);
    }
    return total;
  } catch { return null; }
}

let chainSizeCache = { bytes: null, at: 0 };
function getChainSize() {
  if (Date.now() - chainSizeCache.at < 5 * 60 * 1000) return chainSizeCache.bytes;
  const bytes = config.node_data_dir ? getDirSizeBytes(config.node_data_dir) : null;
  chainSizeCache = { bytes, at: Date.now() };
  return bytes;
}

// ── SSE clients ──────────────────────────────────────────────────────────────

const sseClients = new Set();

function broadcastNewBlock(block) {
  const data = JSON.stringify({ type: 'block', height: block.height });
  for (const client of sseClients) {
    client.write(`data: ${data}\n\n`);
  }
}

// ── Grin API helpers ──────────────────────────────────────────────────────────

function jsonRpc(url, secret, method, params) {
  return new Promise((resolve, reject) => {
    const body   = JSON.stringify({ id: 1, jsonrpc: '2.0', method, params });
    const auth   = Buffer.from('grin:' + secret).toString('base64');
    const parsed = new URL(url);
    const lib    = parsed.protocol === 'https:' ? https : http;
    const opts   = {
      hostname: parsed.hostname,
      port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path:     parsed.pathname,
      method:   'POST',
      headers:  {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
        'Authorization':  'Basic ' + auth,
      },
      timeout: 10000,
    };
    const req = lib.request(opts, res => {
      // Try to parse node version from response Server header
      const srv = res.headers['server'] || res.headers['user-agent'] || '';
      const vm  = srv.match(/(\d+\.\d+\.\d+)/);
      if (vm) tipState.node_version = vm[1];
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end',  () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('JSON parse failed: ' + data.slice(0, 100))); }
      });
    });
    req.on('error',   reject);
    req.on('timeout', () => req.destroy(new Error('Request timeout')));
    req.write(body);
    req.end();
  });
}

function unwrapResult(result) {
  // Grin node serialises Rust Result<T,E> as {"Ok": T} or {"Err": E}
  if (result && typeof result === 'object') {
    if ('Ok'  in result) return result.Ok;
    if ('Err' in result) throw new Error(JSON.stringify(result.Err));
  }
  return result;
}

async function foreignApi(method, params) {
  const data = await jsonRpc(config.node_url, foreignSecret, method, params);
  if (data.error) throw new Error(JSON.stringify(data.error));
  return unwrapResult(data.result);
}

async function ownerApi(method, params) {
  const data = await jsonRpc(config.node_owner_url, ownerSecret, method, params);
  if (data.error) throw new Error(JSON.stringify(data.error));
  return unwrapResult(data.result);
}

// ── Block parsing ────────────────────────────────────────────────────────────

function parseVersionBucket(agent) {
  if (!agent) return 'Other';
  const m = agent.match(/(\d+\.\d+)\.\d+/);
  return m ? m[1] : 'Other';
}

function insertBlock(blockData) {
  const h       = blockData.header;
  const kernels = blockData.kernels || [];
  const txCount = kernels.filter(k => k.features !== 'Coinbase').length;
  const feeTotal = kernels
    .filter(k => k.features !== 'Coinbase')
    .reduce((s, k) => s + (k.fee || 0), 0);
  const ts = Math.floor(new Date(h.timestamp).getTime() / 1000);
  stmtInsertBlock.run(
    h.height, h.hash, h.previous || '',
    ts, h.total_difficulty || 0,
    kernels.length, txCount, feeTotal,
    JSON.stringify(blockData),
  );
}

// ── Startup backfill ──────────────────────────────────────────────────────────

async function startupBackfill(tipHeight) {
  const row       = stmtMaxHeight.get();
  const maxCached = row.m;
  let backfillFrom;

  if (maxCached == null) {
    backfillFrom = Math.max(1, tipHeight - config.blocks_cache);
  } else if (tipHeight > maxCached + 1) {
    backfillFrom = maxCached + 1;
  } else {
    return;
  }

  tipState.syncing = true;
  log(`Backfilling blocks ${backfillFrom} → ${tipHeight}…`);

  for (let h = backfillFrom; h <= tipHeight; h++) {
    try {
      const block = await foreignApi('get_block', [h, null, null]);
      insertBlock(block);
    } catch (e) {
      log(`[WARN] Backfill block ${h}: ${e.message}`);
    }
    if ((h - backfillFrom) % 50 === 0) {
      log(`Backfilling ${h} / ${tipHeight}`);
    }
    await new Promise(r => setTimeout(r, 100));
  }

  tipState.syncing = false;
  log(`Backfill complete.`);
}

// ── Historical backfill ───────────────────────────────────────────────────────

async function historicalBackfill() {
  log('Historical backfill started — walking backwards to genesis.');
  tipState.backfill_active = true;
  tipState.backfill_pruned = false;
  const MAX_CONSECUTIVE_ERRORS = 10;
  let consecutiveErrors = 0;

  while (true) {
    const row = stmtMinHeight.get();
    const minCached = row.m;

    if (minCached == null || minCached <= 1) {
      log('Historical backfill complete — genesis reached.');
      tipState.backfill_active = false;
      tipState.backfill_min = minCached ?? 1;
      return;
    }

    const target = minCached - 1;
    try {
      const block = await foreignApi('get_block', [target, null, null]);
      insertBlock(block);
      tipState.backfill_min = target;
      consecutiveErrors = 0;
    } catch (e) {
      consecutiveErrors++;
      log(`[WARN] Historical backfill block ${target}: ${e.message} (${consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS})`);
      if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        log(`Historical backfill stopped at block ${target} — pruned node horizon. Recent blocks still served normally.`);
        tipState.backfill_active = false;
        tipState.backfill_pruned = true;
        tipState.backfill_min = minCached;
        return;
      }
      await new Promise(r => setTimeout(r, 2000));
      continue;
    }

    if (target % 1000 === 0) log(`Historical backfill progress: block ${target}`);
    await new Promise(r => setTimeout(r, 200));
  }
}

// ── Block poller ─────────────────────────────────────────────────────────────

async function pollBlocks() {
  try {
    // ── Owner API: node status (tip height, connections, version, sync state) ──
    const status    = await ownerApi('get_status', []);
    const tip       = status.tip;
    const tipHeight = tip?.height;
    if (tipHeight == null) throw new Error(`get_status returned no tip height — response: ${JSON.stringify(status).slice(0, 200)}`);

    // Node version from user_agent (more reliable than HTTP Server header)
    const uaMatch = (status.user_agent || '').match(/(\d+\.\d+\.\d+)/);
    if (uaMatch) tipState.node_version = uaMatch[1];

    // Stall detection (suppress when node is actively syncing)
    const nodeSyncing = status.sync_status && status.sync_status !== 'no_sync';
    if (tipHeight === lastTipHeight && !nodeSyncing) { stallCount++; }
    else { stallCount = 0; lastTipHeight = tipHeight; }
    tipState.stalled = stallCount >= 5;

    // ── Foreign API: fetch any new blocks ────────────────────────────────────
    const row       = stmtMaxHeight.get();
    const maxCached = row.m ?? 0;

    if (tipHeight > maxCached) {
      for (let h = maxCached + 1; h <= tipHeight; h++) {
        try {
          const block = await foreignApi('get_block', [h, null, null]);
          insertBlock(block);
        } catch (e) {
          log(`[WARN] Block ${h}: ${e.message}`);
        }
      }
      broadcastNewBlock({ height: tipHeight });
    }

    // Per-block difficulty = total_difficulty[tip] - total_difficulty[tip-1]
    // (DB stores cumulative total_difficulty; the delta gives the actual block target)
    const topTwo = stmtTopTwoDiff.all();
    let perBlockDiff = 0;
    if (topTwo.length >= 2) {
      perBlockDiff = Math.max(0, topTwo[0].difficulty - topTwo[1].difficulty);
    } else if (topTwo.length === 1) {
      perBlockDiff = topTwo[0].difficulty;
    }

    tipState.height       = tipHeight;
    tipState.hash         = tip.last_block_h;
    tipState.difficulty   = perBlockDiff;
    tipState.hashrate_gps = Math.round((perBlockDiff / 60) * 100) / 100;

    // ── Owner API: peer count (quick from status) + version map (full list) ──
    tipState.peer_count = status.connections || 0;
    try {
      const peers    = await ownerApi('get_connected_peers', []);
      const peerList = Array.isArray(peers) ? peers : [];
      tipState.peer_count = peerList.length;
      peerVersionMap = {};
      peerList.forEach(p => {
        const b = parseVersionBucket(p.user_agent);
        peerVersionMap[b] = (peerVersionMap[b] || 0) + 1;
      });
    } catch {}

    // ── Foreign API: mempool (tx pool + stem pool) ────────────────────────────
    try {
      const pool = await foreignApi('get_pool_size', []);
      tipState.pool_size = typeof pool === 'number' ? pool : 0;
    } catch {}

    try {
      const stem = await foreignApi('get_stempool_size', []);
      tipState.stem_pool_size = typeof stem === 'number' ? stem : 0;
    } catch {}

  } catch (e) {
    log(`[WARN] pollBlocks: ${e.message}`);
  }
}

// ── Price poller ──────────────────────────────────────────────────────────────

function httpsGet(hostname, path) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname, path, method: 'GET', timeout: 8000 },
      res => {
        let d = '';
        res.on('data', c => { d += c; });
        res.on('end',  () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
      }
    );
    req.on('error',   reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.end();
  });
}

async function pollPrice() {
  const now = Math.floor(Date.now() / 1000);
  let price_usd = 0, price_btc = 0, btcUsd = 0;
  let volume_usdt = 0, volume_btc = 0, change_gate = null;
  const sources = [];

  // Gate.io: GRIN/USDT + BTC/USDT (parallel)
  // quote_volume is USDT spent; base_volume is GRIN traded — we want the USDT figure
  try {
    const [grin, btc] = await Promise.all([
      httpsGet('api.gateio.ws', '/api/v4/spot/tickers?currency_pair=GRIN_USDT'),
      httpsGet('api.gateio.ws', '/api/v4/spot/tickers?currency_pair=BTC_USDT'),
    ]);
    if (Array.isArray(grin) && grin[0]) {
      price_usd   = parseFloat(grin[0].last)              || 0;
      volume_usdt = parseFloat(grin[0].quote_volume)      || 0;
      change_gate = parseFloat(grin[0].change_percentage) ?? null;
    }
    if (Array.isArray(btc) && btc[0]) btcUsd = parseFloat(btc[0].last) || 0;
    if (price_usd && btcUsd) { price_btc = price_usd / btcUsd; sources.push('gate.io'); }
  } catch {}

  // nonlogs.io: GRIN-BTC — preferred for BTC price + BTC-pair volume
  // base_volume = GRIN traded; quote_volume = BTC actually spent (the real BTC volume)
  try {
    const nlRaw = await httpsGet('api.nonlogs.io', '/api/markets/GRIN-BTC');
    // API may return object or single-element array
    const nl = Array.isArray(nlRaw) ? nlRaw[0] : (nlRaw?.market || nlRaw);
    if (nl) {
      const nlBtc = parseFloat(nl.last || nl.last_price || nl.price) || 0;
      if (nlBtc) {
        price_btc = nlBtc;
        if (!sources.includes('nonlogs.io')) sources.push('nonlogs.io');
        if (!price_usd && btcUsd) price_usd = nlBtc * btcUsd;
      }
      // quote_volume is BTC spent on the GRIN/BTC market
      const nlVolBtc = parseFloat(nl.quote_volume || nl.quoteVolume || nl.volume_quote) || 0;
      if (nlVolBtc) volume_btc = nlVolBtc;
      if (!nlVolBtc) log(`[DEBUG] nonlogs.io GRIN-BTC keys: ${Object.keys(nl).join(', ')} | quote_volume=${nl.quote_volume}`);
    }
  } catch {}

  if (sources.length === 0) {
    if (latestPrice) { latestPrice.stale = true; latestPrice.sources = ['stale']; }
    return;
  }

  // 24h change: use Gate.io live value when available, fall back to DB-computed
  const ts10  = Math.floor(now / 600) * 600;
  const old24 = stmtPrice24h.get(now - 86400);
  const change_24h_pct = change_gate !== null
    ? Math.round(change_gate * 100) / 100
    : (old24 && old24.price_usd
        ? Math.round(((price_usd - old24.price_usd) / old24.price_usd) * 10000) / 100
        : 0);

  stmtInsertPrice.run(ts10, price_btc, price_usd, sources.join(','));
  stmtPrunePrice.run(now - 90 * 86400);

  latestPrice = {
    price_btc, price_usd, change_24h_pct,
    volume_usdt, volume_btc,
    fetched_at: now, sources, stale: false,
  };
}

// ── Emission constants ───────────────────────────────────────────────────────

const EMISSION = {
  block_reward:      60,
  block_time_sec:    60,
  genesis_timestamp: 1547520000,
  genesis_date:      '2019-01-15',
  supply_formula:    'height * 60',
  schedule: [
    { year: 1,  blocks: 525960,    supply: 31557600,   inflation_pct: 100.0 },
    { year: 2,  blocks: 1051920,   supply: 63115200,   inflation_pct: 50.0  },
    { year: 3,  blocks: 1577880,   supply: 94672800,   inflation_pct: 33.3  },
    { year: 5,  blocks: 2629800,   supply: 157788000,  inflation_pct: 20.0  },
    { year: 10, blocks: 5259600,   supply: 315576000,  inflation_pct: 10.0  },
    { year: 20, blocks: 10519200,  supply: 631152000,  inflation_pct: 5.0   },
    { year: 50, blocks: 26298000,  supply: 1577880000, inflation_pct: 2.0   },
  ],
};

// ── Express app ──────────────────────────────────────────────────────────────

const app = express();

// CORS for all /rest/ routes
app.use('/rest', (_req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  next();
});

// ── /rest/ public REST API ───────────────────────────────────────────────────

app.get('/rest/stats.json', (_req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=30');
  const out = {
    height:          tipState.height,
    hash:            tipState.hash,
    supply:          tipState.height * 60,
    difficulty:      tipState.difficulty,
    hashrate_gps:    tipState.hashrate_gps,
    peer_count:      tipState.peer_count,
    pool_size:       tipState.pool_size,
    stem_pool_size:  tipState.stem_pool_size,
    node_version:    tipState.node_version,
    price_usd:       latestPrice?.price_usd       ?? null,
    price_btc:       latestPrice?.price_btc       ?? null,
    change_24h_pct:  latestPrice?.change_24h_pct  ?? null,
    volume_usdt:     latestPrice?.volume_usdt     ?? null,
    volume_btc:      latestPrice?.volume_btc      ?? null,
    node_mode:       tipState.backfill_pruned ? 'pruned' : (tipState.backfill_min != null && tipState.backfill_min <= 1 ? 'archive' : 'syncing'),
    network:         config.network,
  };
  if (Object.keys(peerVersionMap).length) out.versions = { ...peerVersionMap };
  res.json(out);
});

app.get('/rest/supply.json', (_req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=30');
  res.json({ supply: tipState.height * 60, height: tipState.height, network: config.network });
});

app.get('/rest/height.json', (_req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=30');
  res.json({ height: tipState.height, network: config.network });
});

app.get('/rest/difficulty.json', (_req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=30');
  res.json({ difficulty: tipState.difficulty, hashrate_gps: tipState.hashrate_gps, network: config.network });
});

app.get('/rest/emission.json', (_req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.json({ ...EMISSION, network: config.network });
});

app.get('/rest/node.json', async (_req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=30');
  try {
    const raw      = await ownerApi('get_connected_peers', []);
    const peers    = Array.isArray(raw) ? raw : [];
    const versions = {};
    peers.forEach(p => {
      const b = parseVersionBucket(p.user_agent);
      versions[b] = (versions[b] || 0) + 1;
    });
    res.json({
      peer_count: peers.length,
      outbound:   peers.filter(p => p.direction === 'Outbound').length,
      inbound:    peers.filter(p => p.direction === 'Inbound').length,
      versions,
      peers:      peers.map(p => ({ addr: p.addr, user_agent: p.user_agent, direction: p.direction })),
      network:    config.network,
    });
  } catch {
    res.json({ peer_count: 0, outbound: 0, inbound: 0, versions: {}, peers: [], network: config.network });
  }
});

app.get('/rest/price.json', (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=120');
  if (!latestPrice) {
    return res.status(503).json({ error: 'Price data not yet collected', network: config.network });
  }
  const days  = Math.min(90, Math.max(1, parseInt(req.query.days) || 1));
  const since = Math.floor(Date.now() / 1000) - days * 86400;
  const history = stmtPriceHist.all(since);
  res.json({ ...latestPrice, history, network: config.network });
});

// ── /health / /healthz ───────────────────────────────────────────────────────

app.get('/health',  (_req, res) => res.json({ status: 'ok', syncing: tipState.syncing, network: config.network }));
app.get('/healthz', (_req, res) => res.json({ status: 'ok', network: config.network }));

// ── /api/* internal API ──────────────────────────────────────────────────────

app.get('/api/network', (_req, res) => res.json({ network: config.network }));

app.get('/api/tip', (_req, res) => {
  res.json({ height: tipState.height, hash: tipState.hash, network: config.network });
});

app.get('/api/stats', (_req, res) => {
  const nodeMode = tipState.backfill_pruned ? 'pruned'
    : (tipState.backfill_min != null && tipState.backfill_min <= 1 ? 'archive' : 'syncing');
  res.json({
    tip_height:       tipState.height,
    hashrate_gps:     tipState.hashrate_gps,
    difficulty:       tipState.difficulty,
    peer_count:       tipState.peer_count,
    node_version:     tipState.node_version,
    stalled:          tipState.stalled,
    cached_blocks:    stmtCountBlocks.get().c,
    pool_size:        tipState.pool_size,
    stem_pool_size:   tipState.stem_pool_size,
    price_usd:        latestPrice?.price_usd      ?? null,
    price_btc:        latestPrice?.price_btc      ?? null,
    change_24h_pct:   latestPrice?.change_24h_pct ?? null,
    volume_usdt:      latestPrice?.volume_usdt    ?? null,
    volume_btc:       latestPrice?.volume_btc     ?? null,
    node_mode:        nodeMode,
    backfill_active:  tipState.backfill_active,
    backfill_min:     tipState.backfill_min,
    db_size_bytes:    (() => { try { return fs.statSync(config.db_path).size; } catch { return null; } })(),
    chain_size_bytes: getChainSize(),
    network:          config.network,
  });
});

app.get('/api/blocks', (req, res) => {
  const limit  = Math.min(100, Math.max(1, parseInt(req.query.limit)  || 20));
  const offset = Math.max(0,              parseInt(req.query.offset) || 0);
  res.json(stmtListBlocks.all(limit, offset));
});

function findBlock(ref) {
  if (!ref) return null;
  if (/^\d+$/.test(ref)) {
    return stmtGetByHeight.get(parseInt(ref, 10));
  }
  if (/^[0-9a-fA-F]{8,}$/.test(ref)) {
    return stmtGetByHash.get(ref);
  }
  return null;
}

app.get('/api/block/:ref', (req, res) => {
  const ref = req.params.ref;
  if (!/^\d+$/.test(ref) && !/^[0-9a-fA-F]{8,}$/.test(ref)) {
    return res.status(400).json({ error: 'Invalid search query' });
  }
  const row = findBlock(ref);
  if (!row || !row.raw_json) {
    return res.status(404).json({ error: 'Block not found', hint: 'cache_miss' });
  }
  try {
    const block = JSON.parse(row.raw_json);
    const height = block.header?.height;
    if (height > 1) {
      const prevRow = db.prepare('SELECT timestamp FROM blocks WHERE height = ?').get(height - 1);
      if (prevRow) block._prev_timestamp = prevRow.timestamp;
    }
    res.json(block);
  } catch { res.status(500).json({ error: 'Corrupt block data' }); }
});

app.get('/api/search', (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.status(400).json({ error: 'Missing query parameter q' });
  if (!/^\d+$/.test(q) && !/^[0-9a-fA-F]{8,}$/.test(q)) {
    return res.status(400).json({ error: 'Invalid search query' });
  }
  const row = findBlock(q);
  if (!row || !row.raw_json) {
    return res.status(404).json({ error: 'Block not found', hint: 'cache_miss' });
  }
  try { res.json(JSON.parse(row.raw_json)); }
  catch { res.status(500).json({ error: 'Corrupt block data' }); }
});

app.get('/api/history', (req, res) => {
  const GENESIS_TS = 1547520000; // 2019-01-15 UTC
  const now        = Math.floor(Date.now() / 1000);
  let since;
  const daysParam = req.query.days;
  if (daysParam === '0' || daysParam === 'all') {
    since = GENESIS_TS;
  } else {
    const days = Math.min(5000, Math.max(1, parseInt(daysParam) || 7));
    since = now - days * 86400;
  }
  const spanDays = (now - since) / 86400;
  // Adaptive sampling to keep response size reasonable
  let step;
  if      (spanDays <= 7)   step =    3600; // 1h
  else if (spanDays <= 30)  step =   14400; // 4h
  else if (spanDays <= 365) step =   86400; // 1d
  else                      step =  604800; // 1 week
  // Longer ranges change slowly — cache aggressively
  const maxAge = spanDays <= 1 ? 60 : spanDays <= 7 ? 300 : 3600;
  res.setHeader('Cache-Control', `public, max-age=${maxAge}`);

  const points = [];
  for (let t = since; t <= now; t += step) {
    const row = stmtHistory.get(t - step / 2, t + step / 2, t);
    if (row) {
      points.push({
        height:       row.height,
        timestamp:    row.timestamp,
        difficulty:   row.difficulty,
        hashrate_gps: Math.round((row.difficulty / 60) * 100) / 100,
      });
    }
  }
  res.json({ ok: true, rows: points });
});

app.get('/api/price', (_req, res) => {
  if (!latestPrice) {
    return res.status(503).json({ error: 'Price data not yet collected', network: config.network });
  }
  res.json({ ...latestPrice, network: config.network });
});

app.get('/api/peers', async (_req, res) => {
  try {
    const raw = await ownerApi('get_connected_peers', []);
    const peers = Array.isArray(raw) ? raw : [];
    res.json(peers.map(p => ({ addr: p.addr, user_agent: p.user_agent, direction: p.direction })));
  } catch {
    res.json([]);
  }
});

// ── SSE live push ────────────────────────────────────────────────────────────

app.get('/events', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

// ── GA4 analytics route (must be before express.static) ─────────────────────

app.get('/js/analytics.js', (_req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  const id = config.network === 'mainnet' ? (config.ga4_measurement_id || '') : '';
  if (!id) return res.send('/* GrinScan analytics disabled */');
  res.send(`(function(){
  var id='${id}';
  var s=document.createElement('script');
  s.async=true;
  s.src='https://www.googletagmanager.com/gtag/js?id='+id;
  document.head.appendChild(s);
  window.dataLayer=window.dataLayer||[];
  function gtag(){dataLayer.push(arguments);}
  window.gtag=gtag;
  gtag('js',new Date());
  gtag('config',id);
})();`);
});

// ── HTML pages with injected window globals + SEO ─────────────────────────────

const webDir    = config.web_dir;
const baseUrl   = process.env.GRINSCAN_BASE_URL || '';
const blocksCache = config.blocks_cache || 500;

const _net      = config.network;
const _isMain   = _net === 'mainnet';
const _netLabel = _isMain ? 'Mainnet' : 'Testnet';

const _pageMeta = {
  index: {
    title: `GrinScan — Grin ${_netLabel} Block Explorer`,
    desc:  _isMain
      ? 'GrinScan: real-time Grin mainnet block explorer. Track blocks, hashrate, difficulty, supply, and price.'
      : 'GrinScan: lightweight Grin testnet block explorer. Explore testnet blocks and live network stats.',
  },
  block: {
    title: `Block — GrinScan ${_netLabel}`,
    desc:  `Grin ${_netLabel} block details: hash, timestamp, difficulty, kernels, and outputs.`,
  },
  info: {
    title: `Info — GrinScan ${_netLabel}`,
    desc:  `Grin ${_netLabel} network info: emission schedule, live stats, hashrate charts, peer list, and API reference.`,
  },
  api: {
    title: `API — GrinScan ${_netLabel}`,
    desc:  `GrinScan public REST API for the Grin ${_netLabel} block explorer. CORS-enabled, no auth required.`,
  },
};

function injectGlobals(html, pageKey) {
  const meta    = _pageMeta[pageKey] || _pageMeta.index;
  const canon   = baseUrl ? `\n<link rel="canonical" href="${baseUrl}${pageKey === 'index' ? '/' : '/' + pageKey + '.html'}">` : '';
  const ogImage = baseUrl ? `\n<meta property="og:image" content="${baseUrl}/grin-logo.svg">` : '';
  const jsonLd  = pageKey === 'index'
    ? `\n<script type="application/ld+json">{"@context":"https://schema.org","@type":"WebSite","name":"GrinScan ${_netLabel} Block Explorer","url":"${baseUrl || ''}"}</script>`
    : '';

  const seoBlock = `<title>${meta.title}</title>
<meta name="description" content="${meta.desc}">
<meta property="og:title" content="${meta.title}">
<meta property="og:description" content="${meta.desc}">${canon}${ogImage}${jsonLd}`;

  const siblingUrl = config.sibling_url || '';
  const globals = `<script>
window.GRINSCAN_NETWORK='${config.network}';
window.GRINSCAN_VERSION='${VERSION}';
window.GRINSCAN_BASE_URL='${baseUrl}';
window.GRINSCAN_SIBLING_URL=${JSON.stringify(siblingUrl)};
window.GRINSCAN_BLOCKS_CACHE=${blocksCache};
</script>`;

  // Strip static title + description from the HTML file, then inject server-side versions
  let out = html
    .replace(/<title>[^<]*<\/title>/, '')
    .replace(/<meta\s+name="description"[^>]*>/i, '');
  out = out.replace('<head>', '<head>\n' + seoBlock + '\n' + globals);

  // Patch network-dependent static values so the page is correct before any JS runs.
  // Without this, every page starts with hardcoded testnet favicon/badge/theme and relies
  // on JS to fix it — causing a flash of testnet design (or full testnet if JS fails).
  const favIcon      = _isMain ? '/favicon-mainnet.svg' : '/favicon-testnet.svg';
  const badgeClass   = _isMain ? 'mainnet' : 'testnet';
  const badgeText    = _isMain ? 'MAINNET' : 'TESTNET';
  const defaultTheme = _isMain ? '/css/themes/neon.css' : '/css/themes/matrix.css';
  out = out
    .replace(/href="\/favicon-testnet\.svg"/g,          `href="${favIcon}"`)
    .replace(/class="gs-network-badge testnet">TESTNET/, `class="gs-network-badge ${badgeClass}">${badgeText}`)
    .replace(/href="\/css\/themes\/dark\.css"/,          `href="${defaultTheme}"`);

  return out;
}

['index.html', 'block.html', 'info.html', 'api.html'].forEach(page => {
  const route   = page === 'index.html' ? '/' : '/' + page;
  const pageKey = page.replace('.html', '');
  app.get(route, (_req, res) => {
    try {
      const html = fs.readFileSync(path.join(webDir, page), 'utf8');
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.send(injectGlobals(html, pageKey));
    } catch {
      res.status(404).send('Not found');
    }
  });
});

// ── Static files ─────────────────────────────────────────────────────────────

app.use(express.static(webDir));

// ── Start ────────────────────────────────────────────────────────────────────

app.listen(config.port, '127.0.0.1', async () => {
  log(`GrinScan v${VERSION} [${config.network}] listening on 127.0.0.1:${config.port}`);
  log(`Config: ${configPath} | DB: ${config.db_path}`);

  // Initial tip + backfill
  try {
    const status    = await ownerApi('get_status', []);
    const tip       = status.tip;
    const tipHeight = tip?.height;
    if (tipHeight == null) throw new Error(`get_status returned no tip height — response: ${JSON.stringify(status).slice(0, 200)}`);
    tipState.height = tipHeight;
    tipState.hash   = tip.last_block_h;
    lastTipHeight   = tipHeight;
    await startupBackfill(tipHeight);
  } catch (e) {
    log(`[WARN] Initial tip fetch failed: ${e.message}`);
  }

  // Start historical backfill in background
  historicalBackfill().catch(e => log(`[WARN] Historical backfill: ${e.message}`));

  // Set initial backfill_min from DB (so status is accurate before backfill starts)
  const minRow = stmtMinHeight.get();
  if (minRow.m != null) tipState.backfill_min = minRow.m;

  // First price collection (no wait)
  pollPrice().catch(e => log(`[WARN] Initial price fetch: ${e.message}`));

  // Regular poll loops
  setInterval(() => pollBlocks().catch(e => log(`[WARN] pollBlocks: ${e.message}`)),
    config.poll_interval_ms);
  setInterval(() => pollPrice().catch(e => log(`[WARN] pollPrice: ${e.message}`)),
    10 * 60 * 1000);

  // Immediate first poll
  pollBlocks().catch(() => {});
});
