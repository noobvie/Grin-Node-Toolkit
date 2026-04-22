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
 *
 * Config (environment variables):
 *   GRINPAY_NETWORK       mainnet | testnet  (default: mainnet)
 *   GRINPAY_PORT          bridge listen port (default: 3006/3007)
 *   GRINPAY_API_KEY       X-Api-Key auth header (optional)
 *   GRINPAY_OWNER_API_URL override owner_api URL
 *   GRINPAY_WALLET_DIR    wallet data dir (locates .owner_api_secret)
 *   GRINPAY_WALLET_PASS   wallet password (default: empty)
 *   GRINPAY_TIMEOUT       request timeout in seconds (default: 30)
 *
 * Security:
 *   - Binds to 127.0.0.1 only — never exposed publicly.
 *   - Optional X-Api-Key auth (constant-time comparison).
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

const PORT    = parseInt(process.env.GRINPAY_PORT || (NETWORK === 'testnet' ? '3007' : '3006'), 10);
const API_KEY = (process.env.GRINPAY_API_KEY || '').trim();

// ── App ───────────────────────────────────────────────────────────────────────

const app = express();
app.use(express.json({ limit: '128kb' }));

// ── Logging ───────────────────────────────────────────────────────────────────

function log(level, msg) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  process.stdout.write(`[${ts}] [${level}] ${msg}\n`);
}

// ── Auth middleware ───────────────────────────────────────────────────────────

function requireApiKey(req, res, next) {
  if (!API_KEY) return next();
  const provided = req.headers['x-api-key'] || '';
  // Use constant-time comparison to prevent timing attacks on key length/content.
  // crypto.timingSafeEqual requires equal-length Buffers — the length check here
  // leaks key length only, which is acceptable for a localhost-only service.
  const a = Buffer.from(provided);
  const b = Buffer.from(API_KEY);
  const valid = a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!valid) return res.status(401).json({ success: false, error: 'Unauthorized' });
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

app.post('/api/invoice', requireApiKey, async (req, res) => {
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

app.post('/api/finalize', requireApiKey, async (req, res) => {
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

    const status = isCancelled                       ? 'cancelled'
                 : (confirmed || numConfirms >= 1)   ? 'confirmed'
                 :                                     'pending';

    return res.json({ success: true, tx_id: txId, status, confirmations: numConfirms });

  } catch (err) {
    log('ERROR', `TX_STATUS tx_id=${txId}: ${err.message}`);
    return apiErr(res, connMsg(err), connCode(err));
  }
});

// ── 404 ───────────────────────────────────────────────────────────────────────

app.use((_req, res) => res.status(404).json({ success: false, error: 'Not found' }));

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, '127.0.0.1', () => {
  log('INFO', `GrinPay bridge [${NETWORK.toUpperCase()}] listening on 127.0.0.1:${PORT}`);
  log('INFO', `owner_api → ${OWNER_API_URL}`);
  if (!API_KEY) log('WARN', 'GRINPAY_API_KEY not set — bridge accessible without auth (localhost only)');
});
