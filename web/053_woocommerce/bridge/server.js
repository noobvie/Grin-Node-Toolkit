'use strict';
/**
 * server.js — GrinPay Node.js bridge for WooCommerce
 * ====================================================
 * HTTP bridge between the WooCommerce PHP plugin and the grin-wallet owner_api.
 *
 * Endpoints:
 *   GET  /api/status              — health check (versions, network, balance)
 *   GET  /api/address             — merchant Slatepack address
 *   POST /api/invoice             — create Slatepack invoice
 *   POST /api/finalize            — finalise buyer's signed response slate
 *   GET  /api/tx_status/:tx_id   — poll transaction confirmation status
 *   GET  /api/rate                — GRIN/USD rate (world.grin.money + Gate.io fallback)
 *
 * Config (environment variables):
 *   GRINPAY_NETWORK       mainnet | testnet  (default: mainnet)
 *   GRINPAY_PORT          bridge listen port (default: 3006/3007)
 *   GRINPAY_API_KEY       X-Api-Key auth header (optional)
 *   GRINPAY_HMAC_SECRET   HMAC-SHA256 secret for POST signing (optional)
 *   GRINPAY_OWNER_API_URL override owner_api URL
 *   GRINPAY_WALLET_DIR    wallet data dir (locates .owner_api_secret)
 *   GRINPAY_WALLET_PASS   wallet password (default: empty)
 *   GRINPAY_TIMEOUT       request timeout in seconds (default: 30)
 *
 * Security:
 *   - Binds to 127.0.0.1 only — never exposed publicly.
 *   - Optional X-Api-Key auth (constant-time comparison).
 *   - Optional HMAC-SHA256 POST body signing via X-Grinpay-Sig header.
 *   - Slatepack input validated before touching wallet state.
 *   - Session token kept in process memory only — never written to disk.
 */

const crypto  = require('crypto');
const express = require('express');
const {
  ownerRpc,
  walletCall,
  grinsToNanogrins,
  SLATEPACK_RE,
  TXID_RE,
  NETWORK,
  OWNER_API_URL,
} = require('./lib/wallet-api');

// ── Config ────────────────────────────────────────────────────────────────────

const PORT        = parseInt(process.env.GRINPAY_PORT || (NETWORK === 'testnet' ? '3007' : '3006'), 10);
const API_KEY     = (process.env.GRINPAY_API_KEY     || '').trim();
const HMAC_SECRET = (process.env.GRINPAY_HMAC_SECRET || '').trim();

// ── App ───────────────────────────────────────────────────────────────────────

const app = express();
// Capture raw body for HMAC verification before JSON parsing consumes the stream.
app.use(express.json({
  limit: '128kb',
  verify: (req, _res, buf) => { req._rawBody = buf.toString('utf8'); },
}));

// ── Logging ───────────────────────────────────────────────────────────────────

function log(level, msg) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  process.stdout.write(`[${ts}] [${level}] ${msg}\n`);
}

// ── Auth middleware — API key ─────────────────────────────────────────────────

function requireApiKey(req, res, next) {
  if (!API_KEY) return next();
  const provided = req.headers['x-api-key'] || '';
  // Constant-time comparison prevents timing attacks. Length leak is acceptable
  // for a localhost-only service.
  const a = Buffer.from(provided);
  const b = Buffer.from(API_KEY);
  const valid = a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!valid) return res.status(401).json({ success: false, error: 'Unauthorized' });
  next();
}

// ── Auth middleware — HMAC-SHA256 POST signing ────────────────────────────────

function requireHmac(req, res, next) {
  // Only POST requests carry a body worth signing; GETs are read-only + localhost-bound.
  if (!HMAC_SECRET || req.method !== 'POST') return next();
  const sig      = req.headers['x-grinpay-sig'] || '';
  const body     = req._rawBody || '';
  const expected = 'sha256=' + crypto.createHmac('sha256', HMAC_SECRET).update(body).digest('hex');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  const valid = a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!valid) {
    log('WARN', `HMAC mismatch for ${req.method} ${req.path}`);
    return res.status(401).json({ success: false, error: 'Invalid request signature' });
  }
  next();
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function apiErr(res, msg, code = 400) {
  return res.status(code).json({ success: false, error: msg });
}

function isConnErr(err) {
  const m = String(err.message || '');
  return m.includes('OWNER_API_DOWN') || m.includes('OWNER_API_TIMEOUT') || m.includes('ECONNREFUSED');
}

function connCode(err) { return isConnErr(err) ? 503 : 500; }
function connMsg(err, fallback) { return isConnErr(err) ? 'Wallet daemon not reachable' : (fallback || err.message); }

// ── GET /api/status ───────────────────────────────────────────────────────────

app.get('/api/status', requireApiKey, async (_req, res) => {
  // get_version does not require a session token
  let versionInfo = {};
  try {
    const v = await ownerRpc('get_version', {});
    versionInfo = v && typeof v === 'object' ? v : {};
  } catch (err) {
    log('WARN', `STATUS get_version failed: ${err.message}`);
    if (isConnErr(err)) {
      return apiErr(res, `Wallet daemon not reachable — ${err.message}`, 503);
    }
  }

  // Balance via walletCall — non-fatal; wallet may need a moment after startup
  let balance = null;
  try {
    const raw  = await walletCall('retrieve_summary_info', {
      minimum_confirmations: 1,
      refresh_from_node:     false,
    });
    // retrieve_summary_info returns (refreshed_from_node, WalletInfo) tuple
    const info = Array.isArray(raw) ? raw[1] : raw;
    balance = parseInt(info?.amount_currently_spendable || '0', 10) / 1_000_000_000;
  } catch (err) {
    log('WARN', `STATUS balance failed: ${err.message}`);
  }

  return res.json({
    success:         true,
    network:         NETWORK,
    wallet_version:  versionInfo.version      || 'unknown',
    node_version:    versionInfo.node_version || 'unknown',
    node_js_version: process.version,
    balance,
  });
});

// ── GET /api/address ──────────────────────────────────────────────────────────

app.get('/api/address', requireApiKey, async (_req, res) => {
  try {
    const result  = await walletCall('get_slatepack_address', { derivation_index: 0 });
    const address = typeof result === 'string' ? result : (result?.slatepack_address || '');
    if (!address) return apiErr(res, 'Wallet returned empty address', 500);
    return res.json({ success: true, address });
  } catch (err) {
    log('ERROR', `ADDRESS: ${err.message}`);
    return apiErr(res, connMsg(err), connCode(err));
  }
});

// ── POST /api/invoice ─────────────────────────────────────────────────────────

app.post('/api/invoice', requireApiKey, requireHmac, async (req, res) => {
  const body        = req.body || {};
  const amountStr   = String(body.amount   || '').trim();
  const description = String(body.description || '').slice(0, 200);

  if (!/^\d+(\.\d{1,9})?$/.test(amountStr) || parseFloat(amountStr) <= 0) {
    return apiErr(res, 'Invalid amount — must be a positive decimal string e.g. "0.5"');
  }

  const amountNg = grinsToNanogrins(amountStr);
  log('INFO', `INVOICE amount=${amountStr} GRIN desc="${description}"`);

  try {
    // Step 1 — create invoice slate (receiver-initiated send)
    const slate = await walletCall('issue_invoice_tx', {
      args: {
        amount:               String(amountNg),
        message:              description || null,
        dest_acct_name:       null,
        target_slate_version: null,
      },
    });

    // Step 2 — encode slate → Slatepack string
    // sender_index: null — do not embed our Tor address in the envelope.
    // With a Tor address, buyer wallets that have Tor enabled will auto-deliver
    // their response directly to our Foreign API, bypassing /api/finalize entirely
    // and leaving no DB record. null forces the copy-paste flow.
    const slatepack = await walletCall('create_slatepack_message', {
      sender_index: null,
      recipients:   [],
      slate,
    });

    const txId = String(slate?.id || slate?.tx_slate_id || '');
    log('INFO', `INVOICE_OK tx_id=${txId}`);
    return res.json({ success: true, slatepack, tx_id: txId });

  } catch (err) {
    log('ERROR', `INVOICE: ${err.message}`);
    return apiErr(res, connMsg(err), connCode(err));
  }
});

// ── POST /api/finalize ────────────────────────────────────────────────────────

app.post('/api/finalize', requireApiKey, requireHmac, async (req, res) => {
  const body          = req.body || {};
  const slateResponse = String(body.response_slate || '').trim();
  const expectedTxId  = String(body.tx_id          || '').trim();

  if (!slateResponse)               return apiErr(res, 'response_slate is required');
  if (!SLATEPACK_RE.test(slateResponse)) return apiErr(res, 'Invalid Slatepack format');

  log('INFO', `FINALIZE tx_id=${expectedTxId || '(none)'}`);

  try {
    // Step 1 — decode buyer's Slatepack response → slate object
    const signedSlate = await walletCall('slate_from_slatepack_message', {
      secret_indices: [0],
      message:        slateResponse,
    });

    // Step 2 — finalize: signs the transaction (does NOT broadcast)
    const finalSlate = await walletCall('finalize_tx', { slate: signedSlate });

    // Step 3 — broadcast to network
    // Non-fatal: if the node is temporarily unreachable, the tx is fully signed
    // in wallet LMDB and can be re-broadcast manually via grin-wallet post.
    try {
      await walletCall('post_tx', { slate: finalSlate, fluff: false });
    } catch (postErr) {
      log('WARN', `FINALIZE post_tx failed (tx signed, re-broadcast manually): ${postErr.message}`);
    }

    const txId = String(finalSlate?.id || finalSlate?.tx_slate_id || expectedTxId);
    log('INFO', `FINALIZE_OK tx_id=${txId}`);
    return res.json({ success: true, tx_id: txId });

  } catch (err) {
    log('ERROR', `FINALIZE: ${err.message}`);
    return apiErr(res, connMsg(err), connCode(err));
  }
});

// ── GET /api/tx_status/:tx_id ─────────────────────────────────────────────────

app.get('/api/tx_status/:tx_id', requireApiKey, async (req, res) => {
  const txId = req.params.tx_id;
  if (!TXID_RE.test(txId)) return apiErr(res, 'Invalid tx_id format');

  try {
    const result = await walletCall('retrieve_txs', {
      refresh_from_node: false,
      tx_id:             null,
      tx_slate_id:       txId,
    });

    // retrieve_txs returns (refreshed_from_node, Vec<TxLogEntry>) tuple
    const raw  = Array.isArray(result) ? result[1] : result;
    const list = Array.isArray(raw) ? raw : (raw ? [raw] : []);

    if (!list.length) {
      return res.json({ success: true, tx_id: txId, status: 'pending', confirmations: 0 });
    }

    const tx          = list[0];
    const confirmed   = Boolean(tx.confirmed);
    const numConfirms = parseInt(tx.num_confirmations || '0', 10);
    const txType      = String(tx.tx_type || '').toLowerCase();
    const isCancelled = txType.includes('cancel');

    // Report what the wallet says — PHP decides if confirmations >= threshold.
    const status = isCancelled ? 'cancelled'
                 : confirmed   ? 'confirmed'
                 :               'pending';

    return res.json({ success: true, tx_id: txId, status, confirmations: numConfirms });

  } catch (err) {
    log('ERROR', `TX_STATUS tx_id=${txId}: ${err.message}`);
    return apiErr(res, connMsg(err), connCode(err));
  }
});

// ── GET /api/rate ─────────────────────────────────────────────────────────────

/** In-memory rate cache — { rate_usd: number, source: string, ts: number } */
let _rateCache = null;
const RATE_TTL_MS = 15 * 60 * 1000; // 15 minutes

app.get('/api/rate', requireApiKey, async (_req, res) => {
  // Serve cached rate if still fresh
  if (_rateCache && (Date.now() - _rateCache.ts) < RATE_TTL_MS) {
    return res.json({
      success:  true,
      rate_usd: _rateCache.rate_usd,
      source:   _rateCache.source,
      cached:   true,
      age_s:    Math.floor((Date.now() - _rateCache.ts) / 1000),
    });
  }

  // Primary: world.grin.money
  try {
    const r    = await fetch('https://world.grin.money/api/price', { signal: AbortSignal.timeout(10_000) });
    const data = await r.json();
    // Defensive: try common field names the API might use
    const rate = parseFloat(
      data?.price ?? data?.usd ?? data?.USD ?? data?.rate ??
      data?.last  ?? data?.close ?? (typeof data === 'number' ? data : NaN)
    );
    if (rate > 0 && isFinite(rate)) {
      _rateCache = { rate_usd: rate, source: 'world.grin.money', ts: Date.now() };
      log('INFO', `RATE ${rate} USD/GRIN from world.grin.money`);
      return res.json({ success: true, rate_usd: rate, source: 'world.grin.money', cached: false });
    }
    log('WARN', `RATE world.grin.money: unexpected shape — ${JSON.stringify(data).slice(0, 120)}`);
  } catch (err) {
    log('WARN', `RATE world.grin.money failed: ${err.message}`);
  }

  // Fallback: Gate.io GRIN_USDT ticker
  try {
    const r      = await fetch('https://api.gateio.ws/api/v4/spot/tickers?currency_pair=GRIN_USDT', {
      signal: AbortSignal.timeout(10_000),
    });
    const data   = await r.json();
    const ticker = Array.isArray(data) ? data[0] : data;
    const rate   = parseFloat(ticker?.last ?? ticker?.close ?? NaN);
    if (rate > 0 && isFinite(rate)) {
      _rateCache = { rate_usd: rate, source: 'gate.io', ts: Date.now() };
      log('INFO', `RATE ${rate} USD/GRIN from gate.io`);
      return res.json({ success: true, rate_usd: rate, source: 'gate.io', cached: false });
    }
    log('WARN', `RATE gate.io: unexpected shape — ${JSON.stringify(data).slice(0, 120)}`);
  } catch (err) {
    log('WARN', `RATE gate.io failed: ${err.message}`);
  }

  // Serve stale cache if both sources failed — better than an error during checkout
  if (_rateCache) {
    const age_min = Math.floor((Date.now() - _rateCache.ts) / 60_000);
    log('WARN', `RATE serving stale cache (${age_min} min old)`);
    return res.json({
      success:  true,
      rate_usd: _rateCache.rate_usd,
      source:   _rateCache.source + ' (stale)',
      cached:   true,
      stale:    true,
      age_s:    Math.floor((Date.now() - _rateCache.ts) / 1000),
    });
  }

  return apiErr(res, 'Exchange rate unavailable — all sources failed', 503);
});

// ── 404 ───────────────────────────────────────────────────────────────────────

app.use((_req, res) => res.status(404).json({ success: false, error: 'Not found' }));

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, '127.0.0.1', () => {
  log('INFO', `GrinPay bridge [${NETWORK.toUpperCase()}] listening on 127.0.0.1:${PORT}`);
  log('INFO', `owner_api → ${OWNER_API_URL}`);
  if (!API_KEY)     log('WARN', 'GRINPAY_API_KEY not set — no API key auth (localhost only)');
  if (!HMAC_SECRET) log('WARN', 'GRINPAY_HMAC_SECRET not set — POST requests not HMAC-signed (localhost only)');
});
