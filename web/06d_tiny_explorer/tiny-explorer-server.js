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
const net     = require('net');
const dns     = require('dns').promises;

// Payment proof verification (POST /api/proof/verify). Pure and config-free, so
// it is unit-testable without this server — see lib/payment-proof.js.
const paymentProof = require('./lib/payment-proof');

// Node reachability check (POST /api/node-check): target parsing, the SSRF
// address blocklist and the response reader. Also pure — see lib/node-check.js.
const nodeCheck = require('./lib/node-check');

// Wallet Checker tier 2 (POST /api/wallet-check): v3-onion derivation and the
// tri-state Tor liveness probe. Ports the pool's wallet-tor.js and Accio's
// SOCKS5 client, so it adds no npm dependency — see lib/wallet-tor.js.
const walletTor = require('./lib/wallet-tor');

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

// ── Price (Gate.io USD + CoinGecko BTC), on-demand, cached ────────────────────

// CoinGecko 403s any request without a descriptive User-Agent, and Node's https
// sends none by default — so identify ourselves on every outbound call.
const HTTP_UA = 'GrinTinyExplorer/1.0 (+https://github.com/Noobvie/Grin-Node-Toolkit)';

function httpsGetJson(hostname, urlPath) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname, path: urlPath, method: 'GET', timeout: 8000,
        headers: { 'Accept': 'application/json', 'User-Agent': HTTP_UA } },
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
  // CoinGecko refines the BTC price. Was nonlogs.io until its GRIN/BTC book went
  // offline in July 2026 (api.nonlogs.io is now NXDOMAIN); with no native GRIN/BTC
  // market left, CoinGecko's aggregate is the best available. On failure the
  // Gate.io block above has already set price_btc by division, so this is additive.
  try {
    const cgRaw = await httpsGetJson('api.coingecko.com',
      '/api/v3/simple/price?ids=grin&vs_currencies=btc,usd');
    const cgBtc = parseFloat(cgRaw?.grin?.btc) || 0;
    if (cgBtc) {
      price_btc = cgBtc;
      if (!sources.includes('coingecko')) sources.push('coingecko');
      if (!price_usd && btcUsd) price_usd = cgBtc * btcUsd;
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
      // The BASIS behind g1_per_day, exposed so a client (the Mining Calculator)
      // never has to invert 1.2 / g1_per_day × 86400 to recover it — and never
      // has a reason to recompute a hashrate from difficulty. Soft-null when the
      // day-average couldn't be computed; the client falls back to hashrate_gps.
      hashrate_gps_24h: dailyHr > 0 ? dailyHr : null,
      mempool:       mempool,
    });
  } catch (e) {
    res.status(502).json({ error: 'node unreachable' });
  }
});

// The GRIN price comes from gate.io/CoinGecko and needs the node for NOTHING, but
// it only ever shipped inside /api/stats — which 502s as a whole when getTip()
// fails. A node outage therefore made every page report "GRIN price unavailable",
// which is false: the price was fine and cached. This route is the node-free half,
// so a client whose /api/stats call died can still say WHICH half broke.
app.get('/api/price', async (_req, res) => {
  const p = await getPrice().catch(() => null);
  if (!p) return res.status(502).json({ error: 'price unavailable' });
  res.setHeader('Cache-Control', 'public, max-age=60');
  res.json({
    price_usd:      p.price_usd      ?? null,
    price_btc:      p.price_btc      ?? null,
    change_24h_pct: p.change_24h_pct ?? null,
    sources:        p.sources        || [],
  });
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

// ── POST /api/proof/verify — payment proof (grin-wallet export_proof JSON) ────
//
// TWO INDEPENDENT VERDICTS, never merged into one. A valid signature over a
// kernel that never confirmed is not a settled payment, and a confirmed kernel
// with a broken signature is not a proof that THIS payer paid THIS payee — so
// the response names each half and the page renders each half.
//
// Order: signatures first, then the chain. grin-wallet's own
// verify_payment_proof checks the chain first and aborts, which would leave the
// page unable to say the signatures were fine; the maths here is identical
// either way because the two checks share no state.
//
// The body is taken as TEXT, not via express.json: `amount` may arrive as a
// bare JSON number and JSON.parse would silently round it past 2^53 (the same
// u64 trap as the PoW nonce above). lib/payment-proof.js quotes it in the raw
// text before parsing, so the raw text has to survive to it.
//
// PRIVACY: a payment proof names both parties and an amount. Nothing in this
// handler logs the body, the addresses, the amount or the excess — not on
// success and not in the error paths. Keep it that way.
// Body-parser errors (over the 16kb cap, or a broken chunked upload) reach
// express's default handler otherwise, which answers HTML and prints a stack
// trace. Answer JSON — the page reads .error — and print nothing: the trace
// would be noise, and this route's inputs are private.
// Built once at load, not per request — express.text() returns a middleware,
// and constructing one inside the handler rebuilt it on every call.
const PROOF_TEXT_BODY = express.text({ type: () => true, limit: '16kb' });

function proofBody(req, res, next) {
  PROOF_TEXT_BODY(req, res, err => {
    if (!err) return next();
    const tooBig = err.type === 'entity.too.large' || err.status === 413;
    return res.status(tooBig ? 413 : 400).json({
      error: tooBig
        ? 'That file is too large to be a payment proof (the format is six short keys).'
        : 'Could not read that request body.',
      code: tooBig ? 'too_large' : 'bad_input',
    });
  });
}

app.post('/api/proof/verify', proofBody, async (req, res) => {
  let result;
  try {
    result = paymentProof.verifyPaymentProof(typeof req.body === 'string' ? req.body : '');
  } catch (e) {
    if (e && e.name === 'ProofError') return res.status(400).json({ error: e.message, code: e.code });
    return res.status(400).json({ error: 'Could not read that proof.', code: 'bad_input' });
  }

  const sigsOk = result.checks.recipient_sig.ok && result.checks.sender_sig.ok;

  // Chain half. Only reached once both signatures verify — an unsigned file
  // gets no node call, and the page says plainly that the chain was not
  // checked rather than implying it was.
  let chain = { ok: false, checked: false, reason: 'not_checked' };
  if (sigsOk) {
    try {
      const located = await getKernel(result.proof.excess);
      if (located) {
        chain = {
          ok: true, checked: true, reason: null,
          height:    located.height,
          timestamp: located._timestamp  || null,   // unix seconds, set by attachBlockRef
          block:     located._block_hash || null,
        };
        try { const tip = await getTip(); chain.confirmations = tip.height - located.height + 1; } catch { /* tip optional */ }
      } else {
        // Kernels are kept in full by a pruned node too, so "not found" here is
        // a real answer about MAINNET — not a pruning artefact. It is still not
        // an answer about testnet: this explorer only ever talks to mainnet, and
        // the HRP that claims testnet is unsigned and unverifiable.
        chain = {
          ok: false, checked: true,
          reason: result.proof.network_claim === 'testnet' ? 'not_found_testnet_claim' : 'not_found',
        };
      }
    } catch {
      chain = { ok: false, checked: false, reason: 'node_unreachable' };
    }
  }

  const verdict = !sigsOk                 ? 'invalid_signature'
                : chain.ok                ? 'settled'
                : chain.reason === 'node_unreachable' ? 'chain_unavailable'
                : chain.reason && chain.reason.startsWith('not_found') ? 'not_on_chain'
                : 'chain_unavailable';

  res.setHeader('Cache-Control', 'no-store');
  return res.json({
    verdict,
    signatures_ok: sigsOk,
    proof:       result.proof,
    message_hex: result.message_hex,
    checks:      Object.assign({}, result.checks, { chain }),
    self_payment: result.self_payment,
    hrp_mismatch: result.hrp_mismatch,
    node_mode:    nodeMode,
  });
});

// ── Node reachability check ───────────────────────────────────────────────────
//
// "Can the world reach my node?" — asked from OUT here, which is the only place
// the question can honestly be answered. The mechanics of *why* this route is
// written the way it is live in lib/node-check.js; what follows is the part that
// touches the network, and it observes four rules:
//
//   1. RESOLVE FIRST, THEN CONNECT TO WHAT WAS RESOLVED. Every address the name
//      resolves to is run past blockedReason(), and the request is then made to
//      that literal address with the Host header carrying the original name.
//      Re-resolving at connect time would reopen DNS rebinding — the whole point
//      of checking the resolved address instead of the string.
//   2. NO REDIRECTS. A 30x is data about the target, not an instruction: this
//      code never issues the second request, so a redirect to 127.0.0.1 goes
//      nowhere. (node's http.request does not follow redirects on its own —
//      that stays true only as long as nobody swaps in a fetch/agent that does.)
//   3. ONE ATTEMPT PER QUESTION, SHORT TIMEOUT, CAPPED BODY. No retry loop — a
//      retry turns one visitor request into two outbound ones, which is how a
//      checker becomes an amplifier. Count them honestly. There are now TWO
//      legs, run in parallel against the same pinned address:
//        · the API leg — get_tip, plus a best-effort get_version on success
//          only. One outbound request when it fails, two when it succeeds.
//        · the P2P leg — ONE bare TCP connect, no bytes sent, closed the moment
//          it resolves. It is skipped entirely when the API leg already dialled
//          that same port, so the pair never double-dials one socket address.
//      So: 2 outbound on a failing check, 3 on a fully successful one. That is
//      up from 1 and 2, and it is the whole cost of the second leg — a connect
//      is a SYN, not a request. Any further call added here needs this sentence
//      rewritten again rather than quietly appended to.
//   4. NOTHING HERE LOGS THE HOST. Not the target, not the resolved address, not
//      on the error paths. Someone checking whether their own node is reachable
//      is telling us where their node is; that is theirs, not ours. Keep it so.
//
// ⚠ THE LIMITER IS IN NGINX, NOT HERE. `location = /api/node-check` carries
// zone=tinyx_probe (10r/m, burst 5) — its own zone in its own conf file,
// script06d-probe-rate-limit.conf, NOT the tinyx_api zone the rest of /api/ uses.
// An exact-match location wins outright over the /api/ prefix, so this route gets
// the probe bucket and only that one. Reached directly on :8471, bypassing nginx,
// this route is still unrated. The service binds 127.0.0.1 (app.listen below), so
// reaching :8471 means already being on the box — accepted, and reviewed as such
// in R5. What holds the public path is the nginx zone alone, so do not add a
// second listen address without re-reading that acceptance.
//
// It does now have an in-flight cap of its own (R5 finding 1, landed in R8), and
// that is a DIFFERENT control from the nginx zone: the limiter counts requests
// PER IP, this counts outbound sockets IN TOTAL. Node's default outbound agent is
// keepAlive:true / maxSockets:Infinity, so without a total cap enough distinct
// source IPs — each individually under the per-IP limit — hold N sockets for up
// to NODE_CHECK_TIMEOUT_MS each and exhaust the process's file descriptors. The
// one route that dials out would then take down the routes that do not, chain
// reads included. Mirrors /api/wallet-check's WALLET_PROBE_MAX_INFLIGHT exactly.

const NODE_CHECK_TIMEOUT_MS = 5000;
const NODE_CHECK_MAX_BYTES  = 64 * 1024;
// 8, not wallet-check's 4: a node check is a plain TCP connect with a 5 s cap,
// where a Tor probe builds a circuit and is retried, so it holds its slot for
// far longer. Operator-tunable; 0 or a non-number falls back to the default.
//
// ⚠ THE UNIT IS THE CHECK, AND A CHECK NOW HOLDS TWO SOCKETS — the API leg and
// the P2P leg run at the same time. The cap counts checks, so 8 in flight is up
// to 16 outbound sockets; that is the number to reason about against the
// process's file-descriptor limit, not the 8. It is deliberately still counted
// per check rather than per socket: the two legs share a deadline and are
// released together, so a socket-counted cap would admit half a check and then
// have nowhere to put the other half.
const NODE_CHECK_MAX_INFLIGHT = config.node_check_max_inflight || 8;
let nodeCheckInflight = 0;

// One outbound POST to a PINNED address. `address` is what DNS gave us and what
// blockedReason() cleared; `target.host` is only ever used for the Host header
// and TLS SNI, never for name resolution down here.
function nodeCheckPost(target, address, rpcBody) {
  return new Promise((resolve, reject) => {
    const lib     = target.scheme === 'https' ? https : http;
    const body    = JSON.stringify(rpcBody);
    const bracket = net.isIPv6(target.host) ? '[' + target.host + ']' : target.host;
    const defPort = target.scheme === 'https' ? 443 : 80;
    const opts = {
      host:   address,                       // pinned — no second lookup
      port:   target.port,
      path:   target.path,
      method: 'POST',
      headers: {
        'Host':           target.port === defPort ? bracket : bracket + ':' + target.port,
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
        'Accept':         'application/json',
        'User-Agent':     HTTP_UA,
      },
      timeout: NODE_CHECK_TIMEOUT_MS,
    };
    // SNI has to carry the name, or a virtual-hosted node answers with the
    // wrong certificate. An IP literal gets no SNI (sending one is illegal).
    if (target.scheme === 'https' && !net.isIP(target.host)) opts.servername = target.host;

    const req = lib.request(opts, res => {
      let data = '';
      let over = false;
      res.setEncoding('utf8');
      res.on('data', c => {
        if (over) return;
        data += c;
        if (data.length > NODE_CHECK_MAX_BYTES) {   // a node's get_tip is ~200 bytes
          over = true;
          data = data.slice(0, NODE_CHECK_MAX_BYTES);
          res.destroy();
        }
      });
      res.on('end',   () => resolve({ status: res.statusCode, body: data, truncated: over }));
      res.on('close', () => resolve({ status: res.statusCode, body: data, truncated: over }));
      res.on('error', reject);
    });
    req.on('error',   reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.write(body);
    req.end();
  });
}

// Socket-level failures, worded for someone who is trying to open a port. The
// distinction that matters to them is refused (something answered, nothing is
// listening) vs timeout (nothing answered at all — usually a firewall).
function nodeCheckNetError(err) {
  const c = String((err && err.code) || (err && err.message) || '');
  if (/timeout|ETIMEDOUT/i.test(c))            return { code: 'timeout',     reason: 'No answer before the timeout — a firewall dropping the packets looks exactly like this.' };
  if (/ECONNREFUSED/.test(c))                  return { code: 'refused',     reason: 'The connection was refused — the host answered, but nothing is listening on that port.' };
  if (/ENOTFOUND|EAI_AGAIN/.test(c))           return { code: 'dns_failed',  reason: 'No DNS record answered for that name. Check the spelling, and that the record has propagated.' };
  if (/EHOSTUNREACH|ENETUNREACH/.test(c))      return { code: 'unreachable', reason: 'No route to that host.' };
  if (/ECONNRESET|EPIPE/.test(c))              return { code: 'reset',       reason: 'The connection was closed mid-answer.' };
  if (/CERT|TLS|SSL|EPROTO/i.test(c))          return { code: 'tls_error',   reason: 'The TLS handshake failed — the certificate did not verify, or that port does not speak TLS.' };
  return { code: 'unreachable', reason: 'The connection failed.' };
}

// ── The P2P leg (3414 / 13414) ────────────────────────────────────────────────
//
// A bare TCP connect. NOTHING IS SENT and nothing is read: the socket is closed
// the instant it resolves either way. That is the entire probe, and the wording
// everywhere downstream has to match how weak it is —
//
//   open      the three-way handshake completed. Something accepted a
//             connection on that port. It is NOT proof of a Grin node: this
//             page's whole doctrine is that an HTTP 200 proves nothing, and a
//             bare accept is weaker evidence than an HTTP 200. Never let this
//             render as "node reachable"; it renders as "port open".
//   refused   the host answered with RST — reachable, nothing listening there.
//   filtered  no answer at all before the deadline. A firewall dropping packets
//             looks exactly like this, and for a P2P port it is the single
//             commonest real answer.
//
// Proving a Grin node here would mean a real Hand/Shake handshake: genesis
// hashes, capability flags and a protocol version that moves with every grin
// release. That is a standing maintenance debt in a tool whose value is being
// stateless, and it was declined deliberately — not overlooked.
//
// `address` is the SAME pinned address the API leg uses, already cleared by
// blockedReason(). net.connect does not resolve an IP literal, so there is no
// second lookup here; the assert makes that a guarantee rather than a habit.
const NODE_CHECK_P2P_TIMEOUT_MS = 4000;   // under the API leg's 5 s — a connect
                                          // that has not landed in 4 s is filtered.

function nodeCheckP2pProbe(address, port) {
  return new Promise(resolve => {
    if (!net.isIP(address)) {                 // unreachable by construction
      return resolve({ state: 'error', reason: 'The P2P probe was not given an address to dial.' });
    }
    const sock = new net.Socket();
    let settled = false;
    const finish = (state, reason) => {
      if (settled) return;
      settled = true;
      sock.destroy();                          // half-open connect, closed at once
      resolve({ state, reason });
    };
    sock.setTimeout(NODE_CHECK_P2P_TIMEOUT_MS);
    sock.once('connect', () => finish('open',
      'The connection was accepted — something is listening on that port.'));
    sock.once('timeout', () => finish('filtered',
      'No answer before the timeout — a firewall dropping the packets looks exactly like this.'));
    sock.once('error', err => {
      const c = String((err && err.code) || (err && err.message) || '');
      if (/ECONNREFUSED/.test(c))              return finish('refused',
        'The connection was refused — the host answered, but nothing is listening on that port.');
      if (/EHOSTUNREACH|ENETUNREACH/.test(c))  return finish('unreachable', 'No route to that host.');
      if (/ETIMEDOUT/i.test(c))                return finish('filtered',
        'No answer before the timeout — a firewall dropping the packets looks exactly like this.');
      return finish('error', 'The connection could not be made.');
    });
    sock.connect({ host: address, port });
  });
}

// When the visitor pointed the API check at the P2P port itself, the API leg has
// ALREADY dialled that socket address — a second connect would be a wasted
// outbound request measuring a port we just measured. Derive instead: any HTTP
// answer at all, of any shape, means the port accepted a connection.
function nodeCheckP2pFromApi(code) {
  if (code === 'refused')  return { state: 'refused',  reason: 'The connection was refused — nothing is listening on that port.' };
  if (code === 'timeout')  return { state: 'filtered', reason: 'No answer before the timeout — a firewall dropping the packets looks exactly like this.' };
  if (code === 'unreachable' || code === 'dns_failed') return { state: 'unreachable', reason: 'The connection could not be made.' };
  // ok / http_status / not_json_rpc / node_error / reset / tls_error all mean
  // the handshake completed and bytes moved — the port is open.
  return { state: 'open', reason: 'The connection was accepted — the check above reached this same port.' };
}

// Body: {"target":"host[:port]"}. Small cap — the payload is one host string.
// Shared with walletCheckBody further down: same shape, same cap, and building
// the middleware once at load beats rebuilding it on every request.
const SMALL_JSON_BODY = express.json({ limit: '1kb' });

function nodeCheckBody(req, res, next) {
  SMALL_JSON_BODY(req, res, err => {
    if (!err) return next();
    return res.status(400).json({ error: 'Could not read that request.', code: 'bad_input' });
  });
}

app.post('/api/node-check', nodeCheckBody, async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  let target;
  try {
    target = nodeCheck.parseTarget(req.body && req.body.target);
  } catch (e) {
    return res.status(400).json({ error: (e && e.message) || 'That host could not be read.', code: 'bad_input' });
  }

  // The visitor-facing shape. `peers` and `sync_state` are ALWAYS unavailable
  // and say so in words: Script 04 publishes /v2/foreign and 403s /v2/owner, so
  // from outside they are not merely unknown, they are unknowABLE. Reporting
  // them as 0 would draw a healthy node as an idle one.
  const base = {
    target:     target.display,
    host:       target.host,
    port:       target.port,
    scheme:     target.scheme,
    reachable:  false,
    node_version: null,
    height:     null,
    our_height: null,
    drift:      null,
    peers:      { available: false, reason: 'not knowable from outside — a public node exposes /v2/foreign only and refuses /v2/owner' },
    sync_state: { available: false, reason: 'not knowable from outside — same reason: sync state lives on the Owner API' },
    // A bare host name was dialled on an ASSUMED https://name:443 — the shape
    // Script 04 deploys. When that fails, the verdict is true about the endpoint
    // WE picked and says nothing about the operator's node: a node published
    // without an nginx front answers plain HTTP on 3413 and not at all on 443.
    // Hand the other form back as a ONE-CLICK RETRY rather than dialling it
    // here: a fallback would make every failing check cost an extra outbound
    // request, which is rule 3 above. A retry is a new question from the
    // visitor, so the count per question is unchanged.
    //
    // ⚠ THE DIRECTION FLIPPED ON 2026-09-10, with the default. It used to dial
    // 3413 and suggest https; it now dials https and suggests 3413. If you are
    // reading this next to a suggestion that points at 443, one of the two ends
    // has been changed without the other.
    //
    // ⚠ NAMES ONLY. A bare IP is `assumed` too, but it is assumed onto 3413,
    // which is already the right guess for an address with no name — and the
    // only alternative to offer would be https on an IP literal, which this
    // checker cannot make work: it verifies certificates and deliberately sends
    // no SNI for an IP, so that lands on `tls_error` whatever is running there.
    // A second dead end dressed as a fix.
    suggest: (target.assumed && !net.isIP(target.host)) ? {
      target: target.host + ':' + nodeCheck.DEFAULT_PORT,
      scheme: 'http',
      note: 'TLS on 443 was assumed because you gave no port or scheme — that is where a node '
          + 'behind nginx answers. A node published without a front answers plain HTTP on '
          + nodeCheck.DEFAULT_PORT + ' instead.',
    } : null,
  };

  // Total outbound-socket cap. Sits ABOVE the ++ and below `base`, so the 503
  // carries the full visitor-facing shape rather than a bare error — the client
  // renders it from the same code path as every other verdict. Everything from
  // here to the end of the handler is inside the try, so every early return
  // still runs the finally: `return` inside a try does not skip it.
  if (nodeCheckInflight >= NODE_CHECK_MAX_INFLIGHT) {
    return res.status(503).json(Object.assign(base, {
      code: 'busy',
      // The banner already says the checker is at its dial limit; repeating it
      // here just prints the same sentence twice. The detail line's job is what
      // the headline cannot say: that this is OUR limit, not their node.
      reason: 'Nothing was learned about your node — the request never left this box. '
            + 'Try again in a few seconds.',
    }));
  }

  nodeCheckInflight++;
  try {
    let addrs;
    try {
      addrs = await dns.lookup(target.host, { all: true, verbatim: true });
    } catch {
      return res.json(Object.assign(base, {
        code: 'dns_failed',
        reason: 'No DNS record answered for that name, so there was nothing to dial. '
              + 'Check the spelling, and that the record has propagated.',
      }));
    }
    if (!addrs.length) {
      return res.json(Object.assign(base, { code: 'dns_failed', reason: 'That host name resolved to nothing.' }));
    }

    // EVERY resolved address must clear the gate, not just the one we intend to
    // dial: a name answering with one public and one private address is the
    // split-horizon version of the same attack.
    for (const a of addrs) {
      const why = nodeCheck.blockedReason(a.address);
      if (why) {
        return res.status(400).json(Object.assign(base, {
          code: 'blocked',
          blocked_scope: why,
          reason: 'That name resolves to a ' + why + ' address. This checker only dials the public '
                + 'internet — from in here, a private address would be reached from inside the '
                + "server's own network, which answers a different question than the one you asked.",
        }));
      }
    }
    const address = addrs[0].address;

    // Which P2P port, and where that choice came from. `network` is the
    // visitor's toggle — 'auto' derives from a port they typed themselves,
    // 'mainnet'/'testnet' is an explicit pick. The PORT is never visitor
    // supplied; see p2pPortFor() in lib/node-check.js for why that is the line
    // between a reachability checker and a port scanner.
    const p2p      = nodeCheck.p2pPortFor(target, req.body && req.body.network);
    const samePort = target.port === p2p.port;

    // ── The API leg ──────────────────────────────────────────────────────────
    // Returns the PATCH to merge into `base` rather than answering directly, so
    // the two legs compose into one response. Every branch below was a
    // `return res.json(Object.assign(base, …))` before and is now the same
    // object without the wrapper — the response shapes are unchanged.
    async function apiLeg() {
      let answer;
      try {
        answer = await nodeCheckPost(target, address, { jsonrpc: '2.0', method: 'get_tip', params: [], id: 1 });
      } catch (e) {
        return nodeCheckNetError(e);
      }

      if (answer.status >= 300) {
        // A 30x is data about the target, never an instruction: the redirect is
        // reported and not followed. Following it is how a blocklist gets walked
        // around — Location: http://127.0.0.1:3413 is one hop from here.
        const redirect = answer.status < 400;
        return {
          code: 'http_status',
          http_status: answer.status,
          reason: redirect
            ? 'The endpoint answered HTTP ' + answer.status + ' — a redirect. Redirects are not '
              + 'followed here, and a Grin node does not redirect: point this at the node itself.'
            : (answer.status === 401 || answer.status === 403)
              ? 'The endpoint answered ' + answer.status + ' — it is there, but it refuses '
                + 'unauthenticated calls, so a wallet cannot use it either.'
              : 'The endpoint answered HTTP ' + answer.status + ', not a node reply.',
        };
      }

      let tip;
      try {
        tip = nodeCheck.readTip(answer.body);
      } catch (e) {
        const code = (e && e.code) === 'node_error' ? 'node_error' : 'not_json_rpc';
        return {
          code,
          http_status: answer.status,
          // Not a restatement of the banner: the banner says WHAT happened, this
          // says what it usually means. Printing the headline again here was the
          // one place in this route where both lines were the same sentence.
          reason: code === 'node_error'
            ? 'It is a Grin node and it is reachable — the port and the firewall are fine. A node '
              + 'that cannot give its tip is usually one that is still syncing or has just '
              + 'restarted, so try again once it has caught up.'
            : 'Something answered on that port with HTTP ' + answer.status + ', but it was not a Grin node — '
              + 'the reply carried no JSON-RPC tip. A 200 on its own proves nothing.',
        };
      }

      // Best-effort garnish, on the same pinned address. A failure here is not a
      // failure of the check: the node already proved itself with get_tip.
      let version = null;
      try {
        const v = await nodeCheckPost(target, address, { jsonrpc: '2.0', method: 'get_version', params: [], id: 1 });
        if (v.status < 400) version = nodeCheck.readVersion(v.body);
      } catch { /* version stays null → rendered "unavailable" */ }

      let ours = null;
      try { ours = (await getTip()).height; } catch { /* our own tip is optional here */ }

      return {
        reachable:    true,
        code:         'ok',
        http_status:  answer.status,
        node_version: version,
        height:       tip.height,
        last_block:   tip.last_block_pushed,
        our_height:   ours,
        drift:        ours == null ? null : ours - tip.height,   // >0 → that node is behind us
      };
    }

    // ── Both legs at once ────────────────────────────────────────────────────
    // The P2P connect learns nothing from the API leg and vice versa, so running
    // them in sequence would double the wait for no extra information. The
    // promise is created BEFORE the await so it genuinely overlaps.
    //
    // When the visitor aimed the API check at the P2P port itself, the API leg
    // already dialled that socket address and a second connect would measure a
    // port we just measured — so it is derived from the API outcome instead, and
    // the response says so with same_port.
    const p2pPromise = samePort ? null : nodeCheckP2pProbe(address, p2p.port);
    const patch      = await apiLeg();
    const p2pResult  = p2pPromise ? await p2pPromise : nodeCheckP2pFromApi(patch.code || 'ok');

    return res.json(Object.assign(base, patch, {
      p2p: Object.assign({
        port:      p2p.port,
        network:   p2p.network,
        source:    p2p.source,      // chosen | derived | default — the client
        same_port: samePort,        // words a default port more cautiously
      }, p2pResult),
    }));
  } finally {
    nodeCheckInflight--;
  }
});

// ── Wallet Tor liveness probe (Wallet Checker, tier 2) ────────────────────────
//
// Tier 1 runs in the visitor's browser and never asks this server anything. This
// route is the one extra question arithmetic cannot answer: is a wallet
// ANSWERING at the onion that address derives to. The derivation, the tri-state
// and the SOCKS client live in lib/wallet-tor.js and lib/socks5.js; what follows
// is the policy around them.
//
//   1. THE CODE DEFAULT IS FALSE — and that is NOT the same as the product
//      default. Script 06d's Configure now writes `true` on a new install and
//      installs tor to back it, so a normally-installed box has the probe ON.
//      This line is the fallback for a config that does not say: hand-edited,
//      half-restored, or written by a toolkit older than the flag. Such a
//      config must fail CLOSED — a box does not start dialling Tor on behalf of
//      visitors because a key went missing. Do not "align" this with the
//      installer; they answer different questions.
//      Either way the flag reaches the page as window.TINYEXP_WALLET_PROBE, and
//      with it false the tile serves as tier 1 with no control at all: a dead
//      button that could only ever answer "could not check" is worse than no
//      button, because it reads as every wallet being offline.
//   2. TRI-STATE OUT, ALWAYS. `online` is true | false | null and the page must
//      render three states. A null is OUR failure and says so.
//   3. NOTHING HERE LOGS THE ADDRESS. Not the address, not the derived onion,
//      not on the error paths. A Slatepack address is a wallet identity and the
//      onion is the same key again; someone checking their own wallet is
//      telling us where their money lives. It is theirs, not ours. Keep it so.
//   4. RATE LIMIT IS IN NGINX. `location = /api/wallet-check` carries
//      zone=tinyx_probe (10r/m, burst 5) — written in Part 7, in its own conf
//      file script06d-probe-rate-limit.conf, NOT the tinyx_api zone. The
//      in-flight cap below is a different control for a different failure: the
//      limiter counts requests per IP, this counts Tor circuits in total, and
//      a probe holds one for up to retries × timeout.

const walletProbeEnabled  = config.wallet_check_probe === true;
const walletProbeOpts = {
  socksHost: config.tor_socks_host || '127.0.0.1',
  socksPort: config.tor_socks_port || 9050,
  // grin-wallet publishes the foreign-API hidden service at virtual port 80,
  // NOT 3415 (impls/src/tor/config.rs). Configurable, but do not "fix" it.
  onionPort: config.tor_onion_virtual_port || 80,
  timeoutMs: config.tor_check_timeout_ms || 8000,
  retries:   config.tor_check_retries || 2,
  userAgent: HTTP_UA,
};
const WALLET_PROBE_MAX_INFLIGHT = config.tor_check_max_inflight || 4;
let walletProbeInflight = 0;

// SMALL_JSON_BODY is the same 1kb JSON parser node-check uses — see above.
function walletCheckBody(req, res, next) {
  SMALL_JSON_BODY(req, res, err => {
    if (!err) return next();
    return res.status(400).json({ error: 'Could not read that request.', code: 'bad_input' });
  });
}

app.post('/api/wallet-check', walletCheckBody, async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  if (!walletProbeEnabled) {
    // 503, not 404: the route exists, the capability is switched off. The page
    // never reaches here — this is for someone calling the API directly.
    return res.status(503).json(walletTor.verdict('probe_disabled'));
  }

  const address = (req.body && typeof req.body.address === 'string') ? req.body.address.trim() : '';
  if (!walletTor.isSlatepackAddress(address)) {
    return res.status(400).json(walletTor.verdict('invalid_address'));
  }

  if (walletProbeInflight >= WALLET_PROBE_MAX_INFLIGHT) {
    return res.status(503).json(walletTor.verdict('probe_busy'));
  }

  walletProbeInflight++;
  let result;
  try {
    result = await walletTor.probeWallet(address, walletProbeOpts);
  } catch {
    // Never leak an exception message here — it would carry the onion.
    result = walletTor.verdict('probe_failed');
  } finally {
    walletProbeInflight--;
  }

  // The address is deliberately NOT echoed back. The caller already has it, and
  // not carrying it means no response body, cache or proxy log can hold it.
  return res.json(Object.assign({ checked_at: new Date().toISOString() }, result));
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
  },
  emission: {
    title: `Grin Emission & Supply — ${domain}`,
    desc:  `How Grin's monetary policy works: a constant 1 ツ every second, forever — 60 ツ per block. Verify circulating supply yourself on ${domain}: it is simply block height × 60. No halvening, no premine, no founder reward.`,
  },
  mining: {
    title: `Grin Mining Calculator — ${domain}`,
    desc:  `Estimate Grin (GRIN) mining income from the live network hashrate on ${domain}: enter your graphs-per-second, pool fee, power draw and electricity cost to see expected GRIN per day, week and month, the USD value at the current price, and the break-even GRIN price for your power bill. An estimate at the current difficulty.`,
  },
  walletcheck: {
    title: `Grin Wallet Address Checker — ${domain}`,
    // The last sentence is the only per-deployment line in _pageMeta, and it has
    // to be: with the probe off this page genuinely cannot say whether a wallet
    // is online, and with it on that is the main reason to visit. A fixed string
    // is wrong on one of the two boxes — either a search result that promises a
    // liveness check the visitor will not find, or one that denies a capability
    // sitting on the page. The title stays fixed so the tool keeps one name.
    desc:  `Check a Grin Slatepack address on ${domain}: whether its bech32 checksum is valid, whether it is mainnet (grin1…) or testnet (tgrin1…), and the Tor .onion address the same public key derives to. The address check runs entirely in your browser — it is never sent anywhere. ` + (walletProbeEnabled
      ? `An optional second check, run only when you press it, asks that wallet's Tor address whether it is answering right now — useful before sending to an address you were given.`
      : `It does not report whether the wallet is online.`),
  },
  proof: {
    title: `Grin Payment Proof Verifier — ${domain}`,
    desc:  `Verify a Grin payment proof on ${domain}: check both ed25519 signatures from a grin-wallet export_proof file, then confirm the kernel excess actually settled on the MimbleWimble chain. Two separate checks, reported separately. The amount is attested by the two parties, never read from the chain — Grin amounts are confidential.`,
  },
  nodecheck: {
    title: `Grin Node Reachability Checker — ${domain}`,
    desc:  `Check whether your Grin node answers from the public internet on ${domain}: enter host and port and this server POSTs get_tip to /v2/foreign from outside your network. Reports reachability, node version, tip height and how far it drifts from the chain tip. Peer count and sync state are not knowable from outside and are reported as unavailable.`,
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
    : pageKey === 'mining' ? '/mining'
    : pageKey === 'walletcheck' ? '/wallet-check'
    : pageKey === 'proof' ? '/proof'
    : pageKey === 'nodecheck' ? '/node-check'
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
window.TINYEXP_WALLET_PROBE=${JSON.stringify(walletProbeEnabled)};
</script>`;

  // Strip the shell's own title/description/theme-color so the injected block is
  // the single source of truth — a duplicate would otherwise win by document
  // order and override the injected one. `meta.theme` stays available for a page
  // that needs its own colour; every page currently takes the default.
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

// Mining Calculator — node-light: one client-side /api/stats call for the live
// network hashrate and price. It CONSUMES the server's hashrate figure (the
// day-average basis behind g1_per_day) and never derives one from difficulty.
// Self-canonical /mining.
app.get('/mining', (_req, res) => sendEntityPage(res, 'mining.html', 'mining'));

// Wallet Checker (tier 1) — like /slate, this route makes NO node call and no
// outbound call of any kind. The address is checked, and its .onion derived, in
// the visitor's browser; the pasted address never reaches this server, which is
// also why there is nothing here to log. Self-canonical /wallet-check.
app.get('/wallet-check', (_req, res) => sendEntityPage(res, 'wallet-check.html', 'walletcheck'));

// Payment Proof Verifier. UNLIKE /slate and /wallet-check, this page DOES send
// what you paste to this server: ed25519 verification has no reliable browser
// equivalent (crypto.subtle's Ed25519 support is too new to rely on), and the
// kernel lookup needs the node anyway. The page says so plainly rather than
// borrowing the other two tools' "checked locally" badge. Self-canonical /proof.
app.get('/proof', (_req, res) => sendEntityPage(res, 'proof.html', 'proof'));

// Node Reachability Checker. Like /proof this page sends what you type to this
// server — it has to, since the whole question is what a request from OUTSIDE
// your network sees. Unlike /proof it makes this server dial a third party, so
// the route it posts to (/api/node-check) is the only one here with a real
// abuse surface and the only one carrying an address blocklist.
// Self-canonical /node-check.
app.get('/node-check', (_req, res) => sendEntityPage(res, 'node-check.html', 'nodecheck'));

// ── Static files ──────────────────────────────────────────────────────────────

// Every page above has a STATIC TWIN under express.static: /wallet-check.html
// serves the same file with none of injectGlobals' work done. That twin is a
// worse page in three separate ways — no <title>/description/og tags, no
// canonical, and no window.TINYEXP_* globals, which on a probe-enabled box
// means /wallet-check.html renders the probe-OFF copy and hides a feature the
// server actually has. It is also a second indexable URL for identical content,
// with the canonical missing from exactly the copy that needed it.
//
// So the twins are not served, they are redirected — 301, because the pretty
// URL is the permanent home and a crawler should collapse the pair. Must sit
// ABOVE express.static: below it the static handler answers first and this
// never runs. block/kernel/output are deliberately absent — their shells need
// a :ref segment and have no bare pretty URL to point at.
const HTML_TWINS = {
  '/index.html':        '/',
  '/slate.html':        '/slate',
  '/emission.html':     '/emission',
  '/mining.html':       '/mining',
  '/wallet-check.html': '/wallet-check',
  '/proof.html':        '/proof',
  '/node-check.html':   '/node-check',
};
// The lookup is normalised because Express matches these routes more loosely
// than it looks: `case sensitive routing` and `strict routing` are both OFF by
// default, so /Index.HTML and /index.html/ also match — and a raw
// HTML_TWINS[req.path] would be undefined for exactly those, making
// res.redirect(301, undefined) send a Location of "undefined". Falling through
// to next() on a miss is the safe default: worst case the visitor gets the
// static file they asked for, which is the behaviour that already shipped.
app.get(Object.keys(HTML_TWINS), (req, res, next) => {
  const key = req.path.toLowerCase().replace(/\/+$/, '');
  const to  = HTML_TWINS[key];
  if (!to) return next();
  return res.redirect(301, to);
});

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
