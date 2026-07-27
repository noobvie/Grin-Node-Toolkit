'use strict';

// ── Tiny Explorer — stateless, mainnet-only Grin block explorer ───────────────
// A thin, DB-less proxy in front of an archive Grin node with small in-memory
// TTL caches. Answers /block/<height> (and /block/<hash>) so pool deep-links
// (e.g. https://scan.grin.money/block/<height>) resolve. No SQLite, no crawler,
// no daemon. Derived from web/06b_grinscan/server.js — the Grin API helpers
// (jsonRpc / unwrapResult / foreignApi / ownerApi) are kept verbatim.

const express = require('express');
const fs      = require('fs');
const path    = require('path');
const http    = require('http');
const https   = require('https');

// ── Config ───────────────────────────────────────────────────────────────────

const configPath = process.env.TINY_EXPLORER_CONFIG;
if (!configPath) {
  console.error('TINY_EXPLORER_CONFIG environment variable is required');
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
  process.stdout.write(`[${new Date().toISOString()}] ${msg}\n`);
}

// ── Grin API helpers (verbatim from GrinScan) ─────────────────────────────────

let nodeVersion = 'unknown';

// stringifyKeys: names of numeric JSON fields to quote in the RAW response before
// JSON.parse, so u64 values (e.g. the PoW nonce, ~1.8e19) survive intact —
// JSON.parse silently rounds anything past 2^53. Mirror GrinScan's nonce note.
// Use REGEX LITERALS (not new RegExp(`…\\s…`)) — the template-literal form silently
// drops the backslash in \s/\d, leaving the field unquoted and the value rounded.
const BIGINT_FIELD_RE = {
  nonce: /("nonce"\s*:\s*)(\d+)/g,
};
function jsonRpc(url, secret, method, params, stringifyKeys) {
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
      const srv = res.headers['server'] || res.headers['user-agent'] || '';
      const vm  = srv.match(/(\d+\.\d+\.\d+)/);
      if (vm) nodeVersion = vm[1];
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end',  () => {
        try {
          if (stringifyKeys && stringifyKeys.length) {
            for (const k of stringifyKeys) {
              const re = BIGINT_FIELD_RE[k];
              if (re) data = data.replace(re, '$1"$2"');
            }
          }
          resolve(JSON.parse(data));
        } catch (e) { reject(new Error('JSON parse failed: ' + data.slice(0, 100))); }
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

async function foreignApi(method, params, stringifyKeys) {
  const data = await jsonRpc(config.node_url, foreignSecret, method, params, stringifyKeys);
  if (data.error) throw new Error(JSON.stringify(data.error));
  return unwrapResult(data.result);
}

async function ownerApi(method, params) {
  const data = await jsonRpc(config.node_owner_url, ownerSecret, method, params);
  if (data.error) throw new Error(JSON.stringify(data.error));
  return unwrapResult(data.result);
}

// ── Node mode probe (guard/log only — archive is expected) ────────────────────

let nodeMode = null; // 'archive' | 'pruned' | null
async function detectNodeMode() {
  try {
    await foreignApi('get_block', [1, null, null]);
    nodeMode = 'archive';
    log('Node mode: archive (block #1 reachable via Foreign API)');
  } catch {
    nodeMode = 'pruned';
    log('Node mode: pruned (block #1 not reachable — old permalinks will 404)');
  }
}

// ── Tiny in-memory TTL caches (no eviction daemon; blocks use a size-capped LRU)

function makeTtlCache(ttlMs) {
  return { value: null, at: 0, ttl: ttlMs };
}
function ttlGet(c) { return (Date.now() - c.at < c.ttl) ? c.value : null; }
function ttlSet(c, v) { c.value = v; c.at = Date.now(); return v; }

const tipCache    = makeTtlCache(config.tip_cache_ms   || 30000);
const latestCache = makeTtlCache(config.block_cache_ms || 45000);
const priceCache  = makeTtlCache(config.price_cache_ms || 120000);
const peersCache  = makeTtlCache(config.peers_cache_ms || 3600000);
const dailyHrCache = makeTtlCache(config.daily_hr_cache_ms || 300000);
const syncCache    = makeTtlCache(config.sync_cache_ms || 60000);
const poolCache    = makeTtlCache(config.pool_cache_ms || 30000);

// Block LRU (ref → {block, at}); capped, TTL-checked on read.
const BLOCK_CACHE_MAX = 300;
const blockCache = new Map();
function blockCacheGet(ref) {
  const e = blockCache.get(ref);
  if (!e) return null;
  if (Date.now() - e.at >= (config.block_cache_ms || 45000)) { blockCache.delete(ref); return null; }
  // refresh recency
  blockCache.delete(ref); blockCache.set(ref, e);
  return e.block;
}
function blockCacheSet(ref, block) {
  blockCache.set(ref, { block, at: Date.now() });
  while (blockCache.size > BLOCK_CACHE_MAX) {
    blockCache.delete(blockCache.keys().next().value); // evict oldest
  }
}

// ── Tip ───────────────────────────────────────────────────────────────────────

async function getTip() {
  const cached = ttlGet(tipCache);
  if (cached) return cached;
  const status = await ownerApi('get_status', []);
  const tip = status.tip;
  if (!tip || tip.height == null) throw new Error('get_status returned no tip');
  const ua = (status.user_agent || '').match(/(\d+\.\d+\.\d+)/);
  if (ua) nodeVersion = ua[1];
  return ttlSet(tipCache, {
    height:      tip.height,
    hash:        tip.last_block_h,
    connections: status.connections || 0,
  });
}

// ── Block fetch (ref-validated, LRU-cached, nonce preserved as string) ────────

function isValidRef(ref) {
  return /^\d+$/.test(ref) || /^[0-9a-fA-F]{8,}$/.test(ref);
}

// Kernel excess and output commitment are both 33-byte compressed points → 66 hex
// chars (a block hash is 32 bytes → 64 hex). The two share a format, so the search
// box can't tell them apart — the dedicated /kernel and /output routes are
// unambiguous because the caller (a pool deep-link) already knows the type.
function isCommitLike(s) { return /^[0-9a-fA-F]{64,66}$/.test(s); }

async function fetchBlockLive(ref) {
  if (!ref) return null;
  try {
    if (/^\d+$/.test(ref)) {
      return await foreignApi('get_block', [parseInt(ref, 10), null, null], ['nonce']);
    }
    return await foreignApi('get_block', [null, ref, null], ['nonce']);
  } catch {
    return null;
  }
}

async function getBlock(ref) {
  const hit = blockCacheGet(String(ref));
  if (hit) return hit;
  const block = await fetchBlockLive(ref);
  if (block) {
    const h = block.header;
    // attach previous block timestamp for block-time display (cheap header fetch)
    if (h && h.height > 1) {
      try {
        const prev = await foreignApi('get_header', [h.height - 1, null, null]);
        if (prev && prev.timestamp) block._prev_timestamp = Math.floor(new Date(prev.timestamp).getTime() / 1000);
      } catch {}
    }
    blockCacheSet(String(ref), block);
    // also cache by height and hash so both refs resolve from one fetch
    if (h) { blockCacheSet(String(h.height), block); if (h.hash) blockCacheSet(h.hash, block); }
  }
  return block;
}

// ── Kernel & output lookup (payout / payment-proof deep-links) ────────────────
// get_kernel and get_outputs both live on the Foreign API and both work on a
// PRUNED node: the kernel MMR is fully retained (so any kernel resolves for all
// heights), and get_outputs answers from the live UTXO set (unspent outputs +
// spent-status). A spent output that's been pruned won't be found — that's the
// expected pruned-horizon limit, surfaced to the user as "not found".

const kernelCache = new Map(); // excess → { data, at } — kernels are immutable, long TTL
const outputCache = new Map(); // commit → { data, at } — spent-status mutable, short TTL
const ENTITY_CACHE_MAX = 500;
function entityCacheGet(map, key, ttl) {
  const e = map.get(key);
  if (!e) return undefined;
  if (Date.now() - e.at >= ttl) { map.delete(key); return undefined; }
  map.delete(key); map.set(key, e); // refresh recency
  return e.data;
}
function entityCacheSet(map, key, data) {
  map.set(key, { data, at: Date.now() });
  while (map.size > ENTITY_CACHE_MAX) map.delete(map.keys().next().value);
}

// Cheap header fetch to attach the containing block's hash + timestamp (get_header
// works at any height on a pruned node), so the detail page can link to the block.
async function attachBlockRef(obj, height) {
  if (height == null) return obj;
  try {
    const hdr = await foreignApi('get_header', [height, null, null]);
    if (hdr) {
      obj._block_hash = hdr.hash;
      obj._timestamp  = Math.floor(new Date(hdr.timestamp).getTime() / 1000);
    }
  } catch {}
  return obj;
}

async function getKernel(excess) {
  const ttl = config.entity_cache_ms || 300000;
  const hit = entityCacheGet(kernelCache, excess, ttl);
  if (hit) return hit;
  // Ok(None) → null when the excess isn't in the kernel set.
  const located = await foreignApi('get_kernel', [excess, null, null]);
  if (!located || located.height == null) return null;
  await attachBlockRef(located, located.height);
  entityCacheSet(kernelCache, excess, located);
  return located;
}

async function getOutput(commit) {
  const ttl = config.output_cache_ms || 60000;
  const hit = entityCacheGet(outputCache, commit, ttl);
  if (hit) return hit;
  // get_outputs returns a list for the commits it can locate in the output set.
  const arr = await foreignApi('get_outputs', [[commit], null, null, true, false]);
  const out = Array.isArray(arr) && arr.length ? arr[0] : null;
  if (!out) return null;
  if (out.block_height != null) await attachBlockRef(out, out.block_height);
  entityCacheSet(outputCache, commit, out);
  return out;
}

// ── Latest blocks (summaries) + hashrate ──────────────────────────────────────

function blockSummary(block) {
  const h = block.header;
  const kernels = block.kernels || [];
  const txCount = kernels.filter(k => k.features !== 'Coinbase').length;
  const feeTotal = kernels
    .filter(k => k.features !== 'Coinbase')
    .reduce((s, k) => s + (k.fee || 0), 0);
  return {
    height:     h.height,
    hash:       h.hash,
    timestamp:  Math.floor(new Date(h.timestamp).getTime() / 1000),
    tx_count:   txCount,
    fee_total:  feeTotal,
    kernels:    kernels.length,
    total_difficulty: h.total_difficulty,
  };
}

async function getLatest(n) {
  const cached = ttlGet(latestCache);
  if (cached && cached.length >= n) return cached.slice(0, n);

  const tip = await getTip();
  const count = Math.min(config.latest_count || 20, Math.max(1, n));
  const heights = [];
  for (let h = tip.height; h > tip.height - count && h >= 0; h--) heights.push(h);

  const results = await Promise.allSettled(
    heights.map(h => foreignApi('get_block', [h, null, null], ['nonce']))
  );
  const blocks = [];
  results.forEach(r => { if (r.status === 'fulfilled' && r.value) blocks.push(r.value); });
  // warm the LRU too
  blocks.forEach(b => { const h = b.header; blockCacheSet(String(h.height), b); if (h.hash) blockCacheSet(h.hash, b); });

  const summaries = blocks.map(blockSummary).sort((a, b) => b.height - a.height);
  ttlSet(latestCache, summaries);
  return summaries.slice(0, n);
}

// GPS = diff_delta × 42 / block_time_seconds / 16384  (Cuckatoo32; see CLAUDE.md)
function computeHashrate(summaries) {
  if (!summaries || summaries.length < 2) return 0;
  const newest = summaries[0];
  const oldest = summaries[summaries.length - 1];
  const delta = Number(newest.total_difficulty) - Number(oldest.total_difficulty);
  const dt    = newest.timestamp - oldest.timestamp;
  if (dt > 0 && delta > 0) return Math.round((delta * 42 / dt / 16384) * 100) / 100;
  return 0;
}

// Day-average network hashrate over ~24h (1440 blocks) from two header reads —
// much smoother than the ~20-block instantaneous rate. Used for the G1/day
// estimate so the number doesn't jump around with per-block luck. get_header
// works at any height on a pruned node, so this is cheap and archive-independent.
async function getDailyAvgHashrate() {
  const cached = ttlGet(dailyHrCache);
  if (cached != null) return cached;
  try {
    const tip  = await getTip();
    const span = Math.min(1440, tip.height);
    if (span < 2) return ttlSet(dailyHrCache, 0);
    const [newer, older] = await Promise.all([
      foreignApi('get_header', [tip.height, null, null]),
      foreignApi('get_header', [tip.height - span, null, null]),
    ]);
    const delta = Number(newer.total_difficulty) - Number(older.total_difficulty);
    const dt = Math.floor(new Date(newer.timestamp).getTime() / 1000)
             - Math.floor(new Date(older.timestamp).getTime() / 1000);
    if (dt > 0 && delta > 0) return ttlSet(dailyHrCache, Math.round((delta * 42 / dt / 16384) * 100) / 100);
    return ttlSet(dailyHrCache, 0);
  } catch { return cached != null ? cached : 0; }
}

// ── Price (Gate.io USD + nonlogs.io BTC), on-demand, cached ────────────────────

function httpsGetJson(hostname, urlPath) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname, path: urlPath, method: 'GET', timeout: 8000 },
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

function httpsPostJson(hostname, urlPath, bodyObj) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(bodyObj);
    const req = https.request(
      { hostname, path: urlPath, method: 'POST', timeout: 8000,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
      res => {
        let d = '';
        res.on('data', c => { d += c; });
        res.on('end',  () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
      }
    );
    req.on('error',   reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.write(body);
    req.end();
  });
}

// ── Sync status: cross-check our node's tip against independent public explorers.
// Sources are JSON-only, no-auth, server-side (no browser CORS):
//   1) several public Grin node Foreign APIs `get_tip` (default: api.grin.money,
//      main.gri.mw, grinnode.live — queried in parallel so ≥2 stay independent
//      even when the explorer's own node is one of them)
//   2) the Global Grin Health summary `tip_height` (default world.grin.money)
// "Behind by ≤ tolerance (default 5) — or ahead" counts as synced. grincoin.org
// is intentionally not used: it exposes no JSON API (HTML-only Rocket app).

const DEFAULT_SYNC_NODES = [
  'https://api.grin.money/v2/foreign',
  'https://main.gri.mw/v2/foreign',
  'https://grinnode.live/v2/foreign',
];

async function getSyncStatus() {
  const cached = ttlGet(syncCache);
  if (cached) return cached;

  let ours = null;
  try { ours = (await getTip()).height; } catch {}

  const nodeUrls = (Array.isArray(config.sync_ref_nodes) && config.sync_ref_nodes.length)
    ? config.sync_ref_nodes
    : (config.sync_ref_node_url ? [config.sync_ref_node_url] : DEFAULT_SYNC_NODES);

  const refs = [];
  const nodeResults = await Promise.allSettled(nodeUrls.map(async raw => {
    const nodeRef = new URL(raw);
    const d = await httpsPostJson(nodeRef.hostname, nodeRef.pathname,
      { jsonrpc: '2.0', method: 'get_tip', params: [], id: 1 });
    const h = d?.result?.Ok?.height ?? d?.result?.height;
    if (typeof h !== 'number') throw new Error('no height');
    return { source: nodeRef.hostname, height: h };
  }));
  nodeResults.forEach(r => { if (r.status === 'fulfilled') refs.push(r.value); });

  try {
    const healthBase = (config.peers_stats_url || 'https://world.grin.money').replace(/\/+$/, '');
    const u = new URL(healthBase + '/api/summary');
    const d = await httpsGetJson(u.hostname, u.pathname);
    if (typeof d?.tip_height === 'number') refs.push({ source: u.hostname, height: d.tip_height });
  } catch {}

  if (ours == null || refs.length === 0) {
    return ttlSet(syncCache, { synced: null, our_height: ours, ref_height: null, ref_source: null, lag: null, ref_count: 0 });
  }
  // Reference = the most-ahead external peer (highest height seen).
  const top = refs.reduce((a, b) => (b.height > a.height ? b : a));
  const lag = top.height - ours;                              // >0 → we're behind
  const synced = lag <= (config.sync_tolerance || 5);        // ahead or within tolerance = ok
  return ttlSet(syncCache, {
    synced, our_height: ours, ref_height: top.height, ref_source: top.source, lag,
    ref_count: refs.length,
  });
}

async function getPrice() {
  const cached = ttlGet(priceCache);
  if (cached) return cached;

  let price_usd = 0, price_btc = 0, btcUsd = 0, change_24h_pct = null;
  const sources = [];
  try {
    const [grin, btc] = await Promise.all([
      httpsGetJson('api.gateio.ws', '/api/v4/spot/tickers?currency_pair=GRIN_USDT'),
      httpsGetJson('api.gateio.ws', '/api/v4/spot/tickers?currency_pair=BTC_USDT'),
    ]);
    if (Array.isArray(grin) && grin[0]) {
      price_usd      = parseFloat(grin[0].last) || 0;
      change_24h_pct = parseFloat(grin[0].change_percentage);
      if (isNaN(change_24h_pct)) change_24h_pct = null;
    }
    if (Array.isArray(btc) && btc[0]) btcUsd = parseFloat(btc[0].last) || 0;
    if (price_usd && btcUsd) { price_btc = price_usd / btcUsd; sources.push('gate.io'); }
  } catch {}
  try {
    const nlRaw = await httpsGetJson('api.nonlogs.io', '/api/markets/GRIN-BTC');
    const nl = Array.isArray(nlRaw) ? nlRaw[0] : (nlRaw?.market || nlRaw);
    if (nl) {
      const nlBtc = parseFloat(nl.last || nl.last_price || nl.price) || 0;
      if (nlBtc) {
        price_btc = nlBtc;
        if (!sources.includes('nonlogs.io')) sources.push('nonlogs.io');
        if (!price_usd && btcUsd) price_usd = nlBtc * btcUsd;
      }
    }
  } catch {}

  if (sources.length === 0) return cached || null; // soft fail — keep last good
  const out = { price_usd, price_btc, change_24h_pct, sources };
  return ttlSet(priceCache, out);
}

// ── Peers stat: world.grin.money 30d distinct nodes, else local node now ──────

async function getPeersStat() {
  const cached = ttlGet(peersCache);
  if (cached) return cached;

  // Primary: operator's Global Grin Health stats — /api/versions (and the older
  // /api/countries) carry the 30d distinct-node total in
  // timeframes.month.mainnet.sampled_from. Deployments vary in which alias exists
  // (some serve only /api/versions), so try each until one resolves.
  const statsBase = (config.peers_stats_url || 'https://world.grin.money').replace(/\/+$/, '');
  for (const p of ['/api/versions', '/api/countries']) {
    try {
      const u = new URL(statsBase + p);
      const data = await httpsGetJson(u.hostname, u.pathname + u.search);
      const cnt = data?.timeframes?.month?.mainnet?.sampled_from;
      if (typeof cnt === 'number' && cnt > 0) {
        return ttlSet(peersCache, { count: cnt, source: 'world30d', label: 'Node peers · 30d' });
      }
    } catch {}
  }

  // Fallback: this node's live connected-peer count.
  try {
    const raw   = await ownerApi('get_connected_peers', []);
    const peers = Array.isArray(raw) ? raw : [];
    return ttlSet(peersCache, { count: peers.length, source: 'local', label: 'Local node peers · now' });
  } catch {}
  try {
    const tip = await getTip();
    return ttlSet(peersCache, { count: tip.connections, source: 'local', label: 'Local node peers · now' });
  } catch {}
  return { count: null, source: 'none', label: 'Node peers · 30d' };
}

// ── Mempool size (unconfirmed tx pool) ────────────────────────────────────────
// get_pool_size lives on the Foreign API and returns the current transaction-pool
// count (a plain number). Cheap; fails soft to keep the stats endpoint resilient.
async function getPoolSize() {
  const cached = ttlGet(poolCache);
  if (cached != null) return cached;
  try {
    const n = await foreignApi('get_pool_size', []);
    return ttlSet(poolCache, typeof n === 'number' ? n : null);
  } catch { return cached != null ? cached : null; }
}

// ── Express app ────────────────────────────────────────────────────────────────

const app = express();
const webDir  = config.web_dir;
const baseUrl = (config.base_url || '').replace(/\/+$/, '');
const domain  = config.domain || baseUrl.replace(/^https?:\/\//, '') || 'Tiny Explorer';

// ── /healthz ───────────────────────────────────────────────────────────────────

app.get('/healthz', (_req, res) => res.json({ status: 'ok', node_mode: nodeMode }));

// ── /api/* ──────────────────────────────────────────────────────────────────────

app.get('/api/tip', async (_req, res) => {
  try {
    const tip = await getTip();
    res.setHeader('Cache-Control', 'public, max-age=15');
    res.json({ height: tip.height, hash: tip.hash });
  } catch (e) { res.status(502).json({ error: 'node unreachable' }); }
});

app.get('/api/sync', async (_req, res) => {
  try {
    const s = await getSyncStatus();
    res.setHeader('Cache-Control', 'public, max-age=30');
    res.json(s);
  } catch (e) { res.status(502).json({ error: 'sync check failed' }); }
});

app.get('/api/latest', async (req, res) => {
  const n = Math.min(config.latest_count || 20, Math.max(1, parseInt(req.query.n) || 20));
  try {
    const rows = await getLatest(n);
    res.setHeader('Cache-Control', 'public, max-age=15');
    res.json(rows);
  } catch (e) { res.status(502).json({ error: 'node unreachable' }); }
});

app.get('/api/stats', async (_req, res) => {
  try {
    const [tip, latest, price, peers, dailyHr, mempool] = await Promise.all([
      getTip(),
      getLatest(config.latest_count || 20).catch(() => []),
      getPrice().catch(() => null),
      getPeersStat().catch(() => ({ count: null, source: 'none', label: 'Node peers · 30d' })),
      getDailyAvgHashrate().catch(() => 0),
      getPoolSize().catch(() => null),
    ]);
    const hashrate = computeHashrate(latest);
    const supply   = tip.height * 60;
    const perBlockDiff = latest.length >= 2
      ? Math.max(0, Number(latest[0].total_difficulty) - Number(latest[1].total_difficulty))
      : 0;
    // Est. IPOLLO G1 mini (1.2 G/s) daily yield: 1.2 / net_gps × 86400 ツ (60 ツ × 1440).
    // Basis is the DAY-AVERAGE hashrate (smoother); fall back to the instantaneous
    // rate only if the day-average couldn't be computed.
    const g1Basis  = dailyHr > 0 ? dailyHr : hashrate;
    const g1PerDay = g1Basis > 0 ? Math.round((1.2 / g1Basis * 86400) * 100) / 100 : null;

    res.setHeader('Cache-Control', 'public, max-age=15');
    res.json({
      tip_height:    tip.height,
      hash:          tip.hash,
      difficulty:    perBlockDiff,
      hashrate_gps:  hashrate,
      supply,
      node_version:  nodeVersion,
      node_mode:     nodeMode,
      price_usd:      price?.price_usd      ?? null,
      price_btc:      price?.price_btc      ?? null,
      change_24h_pct: price?.change_24h_pct ?? null,
      market_cap:    (price?.price_usd) ? supply * price.price_usd : null,
      peers_count:   peers.count,
      peers_label:   peers.label,
      peers_source:  peers.source,
      g1_per_day:    g1PerDay,
      mempool:       mempool,
    });
  } catch (e) {
    res.status(502).json({ error: 'node unreachable' });
  }
});

app.get('/api/block/:ref', async (req, res) => {
  const ref = req.params.ref;
  if (!isValidRef(ref)) return res.status(400).json({ error: 'Invalid block reference' });
  try {
    const block = await getBlock(ref);
    if (block) return res.json(block);
    return res.status(404).json({ error: 'Block not found', hint: nodeMode === 'pruned' ? 'pruned_horizon' : 'not_found' });
  } catch (e) {
    return res.status(502).json({ error: 'node unreachable' });
  }
});

app.get('/api/kernel/:excess', async (req, res) => {
  const ex = req.params.excess;
  if (!isCommitLike(ex)) return res.status(400).json({ error: 'Invalid kernel excess' });
  try {
    const located = await getKernel(ex);
    if (!located) return res.status(404).json({ error: 'Kernel not found', hint: nodeMode });
    // Confirmations are live (tip moves) — compute on a shallow copy so the cached
    // kernel keeps only its immutable fields.
    const out = Object.assign({}, located);
    try { const tip = await getTip(); out._confirmations = tip.height - located.height + 1; } catch {}
    res.setHeader('Cache-Control', 'public, max-age=30');
    return res.json(out);
  } catch (e) { return res.status(502).json({ error: 'node unreachable' }); }
});

app.get('/api/output/:commit', async (req, res) => {
  const c = req.params.commit;
  if (!isCommitLike(c)) return res.status(400).json({ error: 'Invalid output commitment' });
  try {
    const output = await getOutput(c);
    if (!output) return res.status(404).json({ error: 'Output not found', hint: nodeMode });
    const out = Object.assign({}, output);
    if (out.block_height != null) {
      try { const tip = await getTip(); out._confirmations = tip.height - out.block_height + 1; } catch {}
    }
    res.setHeader('Cache-Control', 'public, max-age=15');
    return res.json(out);
  } catch (e) { return res.status(502).json({ error: 'node unreachable' }); }
});

// ── GA4 analytics (before static) ────────────────────────────────────────────

app.get('/js/analytics.js', (_req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  const id = config.ga4_measurement_id || '';
  if (!id) return res.send('/* Tiny Explorer — analytics disabled */');
  res.send(`(function(){var id='${id}';var s=document.createElement('script');s.async=true;`
    + `s.src='https://www.googletagmanager.com/gtag/js?id='+id;document.head.appendChild(s);`
    + `window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}`
    + `window.gtag=gtag;gtag('js',new Date());gtag('config',id);})();`);
});

// ── HTML pages with injected SEO + globals ────────────────────────────────────

const SLOGAN = config.slogan || 'Every Grin block, one link away.';

const _pageMeta = {
  index: {
    title: `${domain} — Tiny Grin Explorer`,
    desc:  `${domain}: a fast, lightweight Grin (GRIN) mainnet block explorer. Live tip height, Cuckatoo32 hashrate, difficulty, supply, price, and the latest blocks on the MimbleWimble blockchain.`,
  },
  block: {
    title: `Block — ${domain}`,
    desc:  `Grin mainnet block details on ${domain}: height, hash, timestamp, difficulty, PoW nonce, kernels, inputs, outputs, fees, and reward.`,
  },
  kernel: {
    title: `Kernel — ${domain}`,
    desc:  `Look up a Grin transaction kernel by excess on ${domain}: block height, timestamp, features, fee, and confirmations. The kernel excess is Grin's payment proof — a transaction-ID equivalent that reveals no amount or address.`,
  },
  output: {
    title: `Output — ${domain}`,
    desc:  `Look up a Grin output by commitment on ${domain}: type, spent/unspent status, block height, timestamp, and confirmations on the MimbleWimble blockchain.`,
  },
  slate: {
    title: `Slate Inspector — ${domain}`,
    desc:  `Paste or drop a Grin slatepack to read what is inside it: amount, fee, which transaction step it is on (S1/S2/S3 or I1/I2/I3), and whether it belongs to mainnet or testnet. Decoding runs entirely in your browser — nothing is uploaded.`,
    theme: '#06070d',
  },
  emission: {
    title: `Grin Emission & Supply — ${domain}`,
    desc:  `How Grin's monetary policy works: a constant 1 ツ every second, forever — 60 ツ per block. Verify circulating supply yourself on ${domain}: it is simply block height × 60. No halvening, no premine, no founder reward.`,
  },
  notfound: {
    title: `Not found — ${domain}`,
    desc:  `That block or page could not be found on ${domain}. Try a deeper Grin explorer.`,
  },
};

function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

function injectGlobals(html, pageKey) {
  const meta  = _pageMeta[pageKey] || _pageMeta.index;
  // index and /slate are single pages, so they get a self-canonical; per-entity
  // pages (block/kernel/output) are per-ref so they carry no canonical; anything
  // else points at /404.html.
  const canonPath = pageKey === 'index' ? '/'
    : pageKey === 'slate' ? '/slate'
    : pageKey === 'emission' ? '/emission'
    : (pageKey === 'block' || pageKey === 'kernel' || pageKey === 'output') ? ''
    : '/404.html';
  const canon = (baseUrl && canonPath) ? `\n<link rel="canonical" href="${baseUrl}${canonPath}">` : '';
  const ogImage = baseUrl ? `${baseUrl}/grin-logo.svg` : '/grin-logo.svg';
  const jsonLd = pageKey === 'index'
    ? `\n<script type="application/ld+json">{"@context":"https://schema.org","@type":"WebSite","name":${JSON.stringify(domain + ' — Grin Block Explorer')},"url":${JSON.stringify(baseUrl || '')},"description":${JSON.stringify(meta.desc)}}</script>`
    : '';

  const seoBlock = `<title>${esc(meta.title)}</title>
<meta name="description" content="${esc(meta.desc)}">
<meta name="robots" content="index, follow">
<meta name="theme-color" content="${esc(meta.theme || '#ff8c00')}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="${esc(domain)}">
<meta property="og:title" content="${esc(meta.title)}">
<meta property="og:description" content="${esc(meta.desc)}">
<meta property="og:image" content="${ogImage}">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="${esc(meta.title)}">
<meta name="twitter:description" content="${esc(meta.desc)}">${canon}${jsonLd}`;

  const globals = `<script>
window.TINYEXP_VERSION=${JSON.stringify(VERSION)};
window.TINYEXP_DOMAIN=${JSON.stringify(domain)};
window.TINYEXP_BASE_URL=${JSON.stringify(baseUrl)};
window.TINYEXP_SLOGAN=${JSON.stringify(SLOGAN)};
window.TINYEXP_FALLBACKS=${JSON.stringify(config.fallback_explorers || [])};
</script>`;

  // Strip the shell's own title/description/theme-color so the injected block is
  // the single source of truth — a duplicate theme-color would otherwise win by
  // document order and repaint the dark Slate page in the explorer's orange.
  let out = html
    .replace(/<title>[^<]*<\/title>/i, '')
    .replace(/<meta\s+name="description"[^>]*>/i, '')
    .replace(/<meta\s+name="theme-color"[^>]*>/i, '');
  return out.replace('<head>', '<head>\n' + seoBlock + '\n' + globals);
}

// index (/) and block (/block/:ref) are served with injected SEO; /block/:ref is
// the pool deep-link target — it must reach this app, never a static rule.
app.get('/', (_req, res) => {
  try {
    const html = fs.readFileSync(path.join(webDir, 'index.html'), 'utf8');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.send(injectGlobals(html, 'index'));
  } catch { res.status(500).send('index unavailable'); }
});

// Per-entity deep-link pages share one server-side render path: read the static
// shell, inject SEO + globals for the page key, serve. /block, /kernel and
// /output are all pool deep-link targets — they must reach this app, never a
// static rule (the ref segment is resolved client-side against /api/*).
function sendEntityPage(res, file, pageKey) {
  try {
    const html = fs.readFileSync(path.join(webDir, file), 'utf8');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.send(injectGlobals(html, pageKey));
  } catch { res.status(500).send(pageKey + ' page unavailable'); }
}

app.get('/block/:ref',  (_req, res) => sendEntityPage(res, 'block.html',  'block'));
app.get('/kernel/:ref', (_req, res) => sendEntityPage(res, 'kernel.html', 'kernel'));
app.get('/output/:ref', (_req, res) => sendEntityPage(res, 'output.html', 'output'));

// Slate Inspector. Unlike every other page here this one makes NO node call —
// a slatepack is a pre-broadcast artefact, so it is decoded entirely in the
// visitor's browser and the pasted slate never reaches this server. The route
// exists only to serve the shell with SEO injected (express.static would
// otherwise only answer /slate.html).
app.get('/slate', (_req, res) => sendEntityPage(res, 'slate.html', 'slate'));

// Emission & Supply explainer — a static, node-light page (one /api/stats call
// client-side for the live supply/inflation figures). Self-canonical /emission.
app.get('/emission', (_req, res) => sendEntityPage(res, 'emission.html', 'emission'));

// ── Static files ──────────────────────────────────────────────────────────────

app.use(express.static(webDir));

// ── Custom 404 (unknown paths) — keep HTTP 404 for pool/bots ──────────────────

app.use((_req, res) => {
  try {
    const html = fs.readFileSync(path.join(webDir, '404.html'), 'utf8');
    res.status(404);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(injectGlobals(html, 'notfound'));
  } catch { res.status(404).send('Not found'); }
});

// ── Start ────────────────────────────────────────────────────────────────────

app.listen(config.port, '127.0.0.1', () => {
  log(`Tiny Explorer v${VERSION} [mainnet] listening on 127.0.0.1:${config.port}`);
  log(`Config: ${configPath} | domain: ${domain}`);
  detectNodeMode().catch(() => {});
  getTip().catch(e => log(`[WARN] initial tip: ${e.message}`));
});
