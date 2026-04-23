'use strict';
/**
 * wallet-api.js — grin-wallet Owner API client for GrinPay bridge
 *
 * Owner API v3 session flow:
 *   1. init_secure_api  — secp256k1 ECDH handshake (unencrypted)
 *   2. open_wallet      — AES-256-GCM encrypted, returns session token
 *   3. all subsequent calls — AES-256-GCM encrypted with token
 *
 * Session token is cached in process memory and re-opened automatically
 * when the wallet daemon rejects it (restart / expiry).
 *
 * Config (environment variables):
 *   GRINPAY_NETWORK          mainnet | testnet  (default: mainnet)
 *   GRINPAY_OWNER_API_URL    override owner_api URL (default: auto from network)
 *   GRINPAY_WALLET_DIR       wallet data dir — used to locate .owner_api_secret
 *   GRINPAY_WALLET_PASS      wallet password (default: empty string)
 *   GRINPAY_TIMEOUT          request timeout in seconds (default: 30)
 *
 * Adapted from web/052_drop/server/wallet.js (proven ECDH pattern).
 */

const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');

// ── Config ────────────────────────────────────────────────────────────────────

const NETWORK        = (process.env.GRINPAY_NETWORK || 'mainnet').toLowerCase();
const IS_TESTNET     = NETWORK === 'testnet';
const OWNER_PORT     = IS_TESTNET ? 13420 : 3420;
const OWNER_API_URL  = process.env.GRINPAY_OWNER_API_URL || `http://127.0.0.1:${OWNER_PORT}/v3/owner`;
const WALLET_DIR     = process.env.GRINPAY_WALLET_DIR || '';
const WALLET_PASS    = process.env.GRINPAY_WALLET_PASS || '';
const TIMEOUT_MS     = parseInt(process.env.GRINPAY_TIMEOUT || '30', 10) * 1000;

// ── Validators ────────────────────────────────────────────────────────────────

const SLATEPACK_RE = /^BEGINSLATEPACK\.[A-Za-z0-9+/=\s]{10,65000}ENDSLATEPACK\.$/s;
const TXID_RE      = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── In-memory session cache ───────────────────────────────────────────────────

let _session = null; // { sharedKey: Buffer, token: string }

// ── Auth header ───────────────────────────────────────────────────────────────

function _ownerHeaders() {
  const base = { 'Content-Type': 'application/json' };
  if (!WALLET_DIR) return base;
  try {
    const secret = fs.readFileSync(path.join(WALLET_DIR, '.owner_api_secret'), 'utf8').trim();
    return { ...base, Authorization: 'Basic ' + Buffer.from('grin:' + secret).toString('base64') };
  } catch {
    return base;
  }
}

// ── Raw JSON-RPC (unencrypted) ────────────────────────────────────────────────

async function ownerRpc(method, params) {
  let res;
  try {
    res = await fetch(OWNER_API_URL, {
      method:  'POST',
      headers: _ownerHeaders(),
      body:    JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal:  AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    if (err.cause?.code === 'ECONNREFUSED' || err.code === 'ECONNREFUSED')
      throw new Error(`OWNER_API_DOWN — start grin-wallet owner_api (port ${OWNER_PORT})`);
    if (err.name === 'TimeoutError')
      throw new Error(`OWNER_API_TIMEOUT — owner_api at ${OWNER_API_URL} did not respond`);
    throw err;
  }
  const json = await res.json();
  if (json.error) throw new Error(`owner_api ${method}: ${json.error.message || JSON.stringify(json.error)}`);
  const r = json.result;
  if (r && r.Err) throw new Error(`owner_api ${method}: ${JSON.stringify(r.Err)}`);
  return r && r.Ok !== undefined ? r.Ok : r;
}

// ── AES-256-GCM encrypted call ────────────────────────────────────────────────

async function _encryptedCall(sharedKey, method, params) {
  const nonce    = crypto.randomBytes(12);
  const nonceHex = nonce.toString('hex');
  const inner    = JSON.stringify({ jsonrpc: '2.0', id: nonceHex, method, params });

  const cipher   = crypto.createCipheriv('aes-256-gcm', sharedKey, nonce);
  const enc      = Buffer.concat([cipher.update(inner, 'utf8'), cipher.final()]);
  const body_enc = Buffer.concat([enc, cipher.getAuthTag()]).toString('base64');

  const res  = await fetch(OWNER_API_URL, {
    method:  'POST',
    headers: _ownerHeaders(),
    body:    JSON.stringify({
      jsonrpc: '2.0', id: nonceHex,
      method:  'encrypted_request_v3',
      params:  { nonce: nonceHex, body_enc },
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const json = await res.json();
  if (json.error)
    throw new Error(`encrypted_request_v3 (${method}): ${json.error.message || JSON.stringify(json.error)}`);

  const { nonce: rNonce, body_enc: rBodyEnc } = json.result.Ok || json.result;
  const rBuf     = Buffer.from(rBodyEnc, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', sharedKey, Buffer.from(rNonce, 'hex'));
  decipher.setAuthTag(rBuf.slice(-16));
  const plain    = Buffer.concat([decipher.update(rBuf.slice(0, -16)), decipher.final()]).toString('utf8');

  const inner2 = JSON.parse(plain);
  if (inner2.error) throw new Error(`Owner API ${method}: ${inner2.error.message || JSON.stringify(inner2.error)}`);
  if (inner2.result && inner2.result.Err) throw new Error(`Owner API ${method}: ${JSON.stringify(inner2.result.Err)}`);
  return inner2.result && inner2.result.Ok !== undefined ? inner2.result.Ok : inner2.result;
}

// ── ECDH handshake + open_wallet ─────────────────────────────────────────────

async function _openWallet() {
  const ecdh = crypto.createECDH('secp256k1');
  ecdh.generateKeys();

  const serverPubHex = await ownerRpc('init_secure_api', { ecdh_pubkey: ecdh.getPublicKey('hex', 'compressed') });
  const sharedKey    = ecdh.computeSecret(Buffer.from(serverPubHex, 'hex'));
  const token        = await _encryptedCall(sharedKey, 'open_wallet', { name: null, password: WALLET_PASS });

  return { sharedKey, token };
}

// ── Public: token-gated call with auto-reopen ─────────────────────────────────

async function walletCall(method, params = {}) {
  if (!_session) _session = await _openWallet();
  try {
    return await _encryptedCall(_session.sharedKey, method, { token: _session.token, ...params });
  } catch (err) {
    const msg = err.message.toLowerCase();
    if (msg.includes('not opened') || msg.includes('invalid token') || msg.includes('token')) {
      _session = await _openWallet();
      return await _encryptedCall(_session.sharedKey, method, { token: _session.token, ...params });
    }
    throw err;
  }
}

// ── Amount conversion ─────────────────────────────────────────────────────────

function grinsToNanogrins(amountStr) {
  // Uses BigInt to avoid IEEE 754 rounding (e.g. 0.1 GRIN = exactly 100_000_000 ng)
  const [int, frac = ''] = String(amountStr).split('.');
  const fracPadded = frac.padEnd(9, '0').slice(0, 9);
  return BigInt(int) * 1_000_000_000n + BigInt(fracPadded);
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  ownerRpc,
  walletCall,
  grinsToNanogrins,
  SLATEPACK_RE,
  TXID_RE,
  NETWORK,
  OWNER_API_URL,
};
