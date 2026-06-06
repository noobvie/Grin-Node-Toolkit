'use strict';

// grin-wallet Owner API v3 client with ECDH session.
//
// Protocol (ref: https://github.com/grincc/grin-wallet-api-tutorial):
//   1. init_secure_api  — plaintext, exchange secp256k1 pubkeys
//   2. ECDH             — derive shared AES-256 key from keypair
//   3. open_wallet      — encrypted, unlocks the wallet for this session
//   4. all other calls  — AES-256-GCM encrypted request/response envelopes
//
// The encrypted_request_v3 envelope:
//   params: { nonce: "<12-byte hex>", body_enc: "<base64(ciphertext + gcm_tag)>" }
// The encrypted response has the same shape inside result.Ok.

const crypto = require('crypto');
const fetch  = require('node-fetch');
const fs     = require('fs');

class WalletAPI {
  constructor(config) {
    this.network         = config.network || 'testnet';
    this.walletDir       = config.wallet_dir || config.grin_wallet_dir || '';
    this.ownerPort       = config.wallet_owner_port || (this.network === 'mainnet' ? 3420 : 13420);
    this.ownerUrl        = `http://127.0.0.1:${this.ownerPort}/v3/owner`;
    this.ownerSecretPath = `${this.walletDir}/.owner_api_secret`;
    this.passFile        = config.wallet_pass_file || '';
    // Session state — reset on error, re-established on next call
    this.aesKey      = null;
    this.sessionOpen = false;
  }

  // --- Public methods -------------------------------------------------------

  async getBalance() {
    try {
      // retrieve_summary_info params: [keychain_mask, refresh_from_node, min_confirmations]
      const result = await this._call('retrieve_summary_info', [null, true, 1]);
      return result;
    } catch (err) {
      console.error(`[Wallet] Balance error: ${err.message}`);
      throw new Error('Wallet balance check failed');
    }
  }

  async getTransactionInfo(txId) {
    try {
      // retrieve_txs params: [keychain_mask, refresh_from_node, tx_id, tx_slate_id]
      const result = await this._call('retrieve_txs', [null, true, txId, null]);
      return result;
    } catch (err) {
      throw new Error(`Failed to get transaction info: ${err.message}`);
    }
  }

  // Bech32 charset: lowercase except b, i, o, 1 → [ac-hj-np-z02-9]
  validateGrinAddress(address, network = 'testnet') {
    if (!address) return false;
    const prefix = network === 'mainnet' ? 'grin1' : 'tgrin1';
    if (!address.startsWith(prefix)) return false;
    const body = address.slice(prefix.length);
    return body.length > 0 && /^[ac-hj-np-z02-9]+$/.test(body) &&
           address.length >= 48 && address.length <= 62;
  }

  // --- Session management ---------------------------------------------------

  // Establish ECDH session and open the wallet.
  // Called automatically by _call() if no session exists.
  async initSession() {
    // 1. Generate ephemeral secp256k1 keypair
    const ecdh = crypto.createECDH('secp256k1');
    ecdh.generateKeys();
    const ourPubkey = ecdh.getPublicKey('hex', 'compressed');

    // 2. init_secure_api — plaintext call, returns server's compressed pubkey
    const serverPubkey = await this._plainCall('init_secure_api', { ecdh_pubkey: ourPubkey });
    if (!serverPubkey || typeof serverPubkey !== 'string') {
      throw new Error('init_secure_api returned unexpected value');
    }

    // 3. Derive AES-256 key: sha256 of the ECDH shared secret
    const sharedSecret = ecdh.computeSecret(Buffer.from(serverPubkey, 'hex'));
    this.aesKey = crypto.createHash('sha256').update(sharedSecret).digest();

    // 4. open_wallet — first encrypted call; unlocks the wallet for this session
    const password = this._readPassword();
    await this._encryptedCall('open_wallet', [null, password]);

    this.sessionOpen = true;
  }

  _readPassword() {
    if (!this.passFile || !fs.existsSync(this.passFile)) return '';
    return fs.readFileSync(this.passFile, 'utf-8').trim();
  }

  // Ensure session is open before making a call; re-init if it was dropped.
  async _call(method, params) {
    if (!this.sessionOpen) {
      await this.initSession();
    }
    try {
      return await this._encryptedCall(method, params);
    } catch (err) {
      // Session may have expired (wallet restarted) — invalidate and retry once
      if (err.message.includes('unauthorized') || err.message.includes('session')) {
        this.aesKey      = null;
        this.sessionOpen = false;
        await this.initSession();
        return this._encryptedCall(method, params);
      }
      throw err;
    }
  }

  // --- Wire-level helpers ---------------------------------------------------

  // Plaintext JSON-RPC call to /v3/owner (used only for init_secure_api).
  async _plainCall(method, params) {
    const headers = { 'Content-Type': 'application/json' };
    if (fs.existsSync(this.ownerSecretPath)) {
      const secret = fs.readFileSync(this.ownerSecretPath, 'utf-8').trim();
      headers['Authorization'] = `Basic ${Buffer.from(`grin:${secret}`).toString('base64')}`;
    }

    const res = await fetch(this.ownerUrl, {
      method:  'POST',
      headers,
      body:    JSON.stringify({ jsonrpc: '2.0', method, params, id: 1 }),
      timeout: 10000
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    const data = await res.json();
    if (data.error) throw new Error(`RPC error: ${data.error.message}`);
    if (data.result && data.result.Err) throw new Error(`Wallet error: ${JSON.stringify(data.result.Err)}`);
    return data.result && data.result.Ok !== undefined ? data.result.Ok : data.result;
  }

  // Encrypt a JSON-RPC call, send it, decrypt the response.
  async _encryptedCall(method, params) {
    if (!this.aesKey) throw new Error('No ECDH session — call initSession() first');

    // Build and encrypt the inner payload
    const inner    = JSON.stringify({ jsonrpc: '2.0', method, params, id: 1 });
    const nonce    = crypto.randomBytes(12);
    const cipher   = crypto.createCipheriv('aes-256-gcm', this.aesKey, nonce);
    const ctBuf    = Buffer.concat([cipher.update(inner, 'utf8'), cipher.final()]);
    const tag      = cipher.getAuthTag();
    const bodyEnc  = Buffer.concat([ctBuf, tag]).toString('base64');

    // Send via encrypted_request_v3 envelope
    const envResult = await this._plainCall('encrypted_request_v3', {
      nonce:    nonce.toString('hex'),
      body_enc: bodyEnc
    });

    // Decrypt response envelope
    if (!envResult || !envResult.nonce || !envResult.body_enc) {
      throw new Error('Invalid encrypted response from wallet');
    }
    const respNonce = Buffer.from(envResult.nonce, 'hex');
    const respBuf   = Buffer.from(envResult.body_enc, 'base64');
    // GCM auth tag is the last 16 bytes
    const respCt    = respBuf.slice(0, -16);
    const respTag   = respBuf.slice(-16);

    const decipher  = crypto.createDecipheriv('aes-256-gcm', this.aesKey, respNonce);
    decipher.setAuthTag(respTag);
    const decrypted = Buffer.concat([decipher.update(respCt), decipher.final()]).toString('utf8');

    const innerResp = JSON.parse(decrypted);
    if (innerResp.error) throw new Error(`Wallet RPC error: ${innerResp.error.message}`);
    if (innerResp.result && innerResp.result.Err) {
      throw new Error(`Wallet error: ${JSON.stringify(innerResp.result.Err)}`);
    }
    return innerResp.result && innerResp.result.Ok !== undefined
      ? innerResp.result.Ok
      : innerResp.result;
  }
}

module.exports = WalletAPI;
