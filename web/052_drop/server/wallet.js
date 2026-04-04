'use strict';
/**
 * wallet.js — Grin wallet HTTP API helpers
 *
 * Ported from Office Tools grin-payment-server.js.
 * All three functions read config fresh on each call so secrets and ports
 * picked up without restarting the process.
 *
 * Owner API v3 requires ECDH-encrypted sessions:
 *   1. init_secure_api   (secp256k1 ECDH, plain JSON-RPC — one-time)
 *   2. open_wallet       (AES-256-GCM encrypted)
 *   3. all subsequent calls (AES-256-GCM encrypted, nonce = 12 random bytes)
 *   body_enc = base64(ciphertext + 16-byte GCM auth tag)
 *
 * Foreign API is plain JSON-RPC — no encryption.
 * One session opened per request — no session caching.
 *
 * Wallet API ports:
 *   Network   Foreign   Owner
 *   Mainnet   3415      3420
 *   Testnet   13415     13420
 *
 * Auth: HTTP Basic  user="grin"  password=<api_secret file contents>
 */

const crypto = require('crypto');
const fs     = require('fs');
const { loadConfig } = require('./config');

// ── Secret file readers ────────────────────────────────────────────────────────

function _readForeignSecret(cfg) {
  try {
    const secret = fs.readFileSync(cfg.wallet_foreign_secret, 'utf8').trim();
    if (secret) return { Authorization: 'Basic ' + Buffer.from('grin:' + secret).toString('base64') };
  } catch {}
  return {};
}

function _readOwnerSecret(cfg) {
  try {
    const secret = fs.readFileSync(cfg.wallet_owner_secret, 'utf8').trim();
    if (secret) return { Authorization: 'Basic ' + Buffer.from('grin:' + secret).toString('base64') };
  } catch {}
  return {};
}

function _readWalletPass(cfg) {
  try {
    return fs.readFileSync(cfg.wallet_pass_file, 'utf8').replace(/[\r\n]/g, '') || '';
  } catch { return ''; }
}

// ── URL builders ──────────────────────────────────────────────────────────────

function _foreignUrl(cfg) {
  return `http://127.0.0.1:${cfg.wallet_foreign_api_port}/v2/foreign`;
}

function _ownerUrl(cfg) {
  return `http://127.0.0.1:${cfg.wallet_owner_api_port}/v3/owner`;
}

// ── Foreign API ───────────────────────────────────────────────────────────────

/**
 * Call the Foreign API (plain JSON-RPC, no encryption).
 * Reads .api_secret from disk on each call.
 * Throws on json.error or result.Err.
 */
async function foreignApiCall(method, params = []) {
  const cfg = loadConfig();
  const res = await fetch(_foreignUrl(cfg), {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', ..._readForeignSecret(cfg) },
    body:    JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal:  AbortSignal.timeout(30000),
  });
  const json = await res.json();
  if (json.error) {
    throw new Error(`Foreign API ${method}: ${json.error.message || JSON.stringify(json.error)}`);
  }
  if (json.result && json.result.Err) {
    throw new Error(`Foreign API ${method}: ${JSON.stringify(json.result.Err)}`);
  }
  return json.result && json.result.Ok !== undefined ? json.result.Ok : json.result;
}

// ── Owner API — ECDH session ──────────────────────────────────────────────────

/**
 * Open an Owner API v3 session:
 *   Step 1 — ECDH handshake → secp256k1 shared secret (32 bytes)
 *   Step 2 — open_wallet (encrypted) → session token
 * Returns { headers, sharedKey, token } for use with encryptedOwnerCall().
 * Reads .owner_api_secret + wallet passphrase from disk on each call.
 */
async function ownerApiSession() {
  const cfg     = loadConfig();
  const headers = { 'Content-Type': 'application/json', ..._readOwnerSecret(cfg) };
  const ownerUrl = _ownerUrl(cfg);

  // Step 1 — ECDH handshake (unencrypted, one-time)
  const ecdh = crypto.createECDH('secp256k1');
  ecdh.generateKeys();
  const ourPubKey = ecdh.getPublicKey('hex', 'compressed');

  const initRes = await fetch(ownerUrl, {
    method:  'POST',
    headers,
    body:    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'init_secure_api', params: { ecdh_pubkey: ourPubKey } }),
    signal:  AbortSignal.timeout(10000),
  });
  const initJson = await initRes.json();
  if (initJson.error) {
    throw new Error('init_secure_api: ' + (initJson.error.message || JSON.stringify(initJson.error)));
  }

  const serverPubKeyHex = initJson.result.Ok || initJson.result;
  // 32-byte secp256k1 shared secret (x-coordinate only)
  const sharedKey = ecdh.computeSecret(Buffer.from(serverPubKeyHex, 'hex'));

  // Step 2 — open_wallet (encrypted)
  const token = await encryptedOwnerCall(headers, sharedKey, ownerUrl, 'open_wallet', {
    name:     null,
    password: _readWalletPass(cfg),
  });

  return { headers, sharedKey, ownerUrl, token };
}

// ── Owner API — encrypted call ─────────────────────────────────────────────────

/**
 * Send one AES-256-GCM encrypted call to the Owner API v3.
 *   body_enc = base64(ciphertext + 16-byte GCM auth tag)
 *   nonce    = 12 random bytes, also used as JSON-RPC id (hex string)
 * Throws on any error at any layer.
 */
async function encryptedOwnerCall(headers, sharedKey, ownerUrl, method, params) {
  const nonce     = crypto.randomBytes(12);
  const nonceHex  = nonce.toString('hex');
  const inner     = JSON.stringify({ jsonrpc: '2.0', id: nonceHex, method, params });

  const cipher    = crypto.createCipheriv('aes-256-gcm', sharedKey, nonce);
  const enc       = Buffer.concat([cipher.update(inner, 'utf8'), cipher.final()]);
  const body_enc  = Buffer.concat([enc, cipher.getAuthTag()]).toString('base64');

  const encRes = await fetch(ownerUrl, {
    method:  'POST',
    headers,
    body:    JSON.stringify({
      jsonrpc: '2.0',
      id:      nonceHex,
      method:  'encrypted_request_v3',
      params:  { nonce: nonceHex, body_enc },
    }),
    signal: AbortSignal.timeout(30000),
  });
  const encJson = await encRes.json();
  if (encJson.error) {
    throw new Error(`encrypted_request_v3 (${method}): ${encJson.error.message || JSON.stringify(encJson.error)}`);
  }

  const { nonce: rNonce, body_enc: rBodyEnc } = encJson.result.Ok || encJson.result;
  const rBuf      = Buffer.from(rBodyEnc, 'base64');
  const decipher  = crypto.createDecipheriv('aes-256-gcm', sharedKey, Buffer.from(rNonce, 'hex'));
  decipher.setAuthTag(rBuf.slice(-16));
  const plain     = Buffer.concat([decipher.update(rBuf.slice(0, -16)), decipher.final()]).toString('utf8');

  const inner2 = JSON.parse(plain);
  if (inner2.error) {
    throw new Error(`Owner API ${method}: ${inner2.error.message || JSON.stringify(inner2.error)}`);
  }
  if (inner2.result && inner2.result.Err) {
    throw new Error(`Owner API ${method}: ${JSON.stringify(inner2.result.Err)}`);
  }
  return inner2.result && inner2.result.Ok !== undefined ? inner2.result.Ok : inner2.result;
}

// ── Convenience wrapper ────────────────────────────────────────────────────────

/**
 * shorthand: open a session then make one encrypted Owner API call.
 * Returns { result, session } so callers can reuse the session.
 */
async function ownerCall(method, params) {
  const session = await ownerApiSession();
  const { headers, sharedKey, ownerUrl } = session;
  const result = await encryptedOwnerCall(headers, sharedKey, ownerUrl, method, params);
  return { result, session };
}

// ── Port check ─────────────────────────────────────────────────────────────────

/**
 * Return true if the wallet port is accepting connections.
 * Used by the status screen to show wallet health.
 */
async function checkWalletPort(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v2/foreign`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'get_version', params: [] }),
      signal:  AbortSignal.timeout(5000),
    });
    // 200 OK or 401 Unauthorized both mean the wallet is listening
    return res.status === 200 || res.status === 401;
  } catch {
    return false;
  }
}

module.exports = {
  foreignApiCall,
  ownerApiSession,
  encryptedOwnerCall,
  ownerCall,
  checkWalletPort,
};
