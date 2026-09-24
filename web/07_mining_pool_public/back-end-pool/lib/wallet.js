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
    this.token       = null; // keychain mask returned by open_wallet
  }

  // --- Public methods -------------------------------------------------------

  // refresh=false reads the wallet's locally-cached balance instantly (no node scan, no
  // LMDB write-lock) — use it for liveness/dashboard polls. refresh=true forces a full
  // wallet→node output scan (slow; can exceed the 10s node-fetch timeout on a fresh/busy
  // wallet → false "Down") — reserve it for the custodial reconciliation check.
  // (Mirrors the Grin Drop pattern in 059_drop/server/app.js.)
  async getBalance(refresh = false) {
    try {
      // retrieve_summary_info params: [keychain_mask, refresh_from_node, min_confirmations]
      // (the mask slot is filled in by _call from the open_wallet token)
      const result = await this._call('retrieve_summary_info', [null, !!refresh, 1]);
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

  // Full wallet transaction log (TxLogEntry[]) — the wallet's own record of every send/receive.
  // Used by the wallet-send audit (lib/reconciliation.js) to catch OS-level `grin-wallet send`
  // operations that bypass the pool ledger. retrieve_txs returns [was_refreshed, entries]; we
  // return just the entries array. refresh=true forces a fresh node scan (slow).
  async getTransactions(refresh = true) {
    const result = await this._call('retrieve_txs', [null, !!refresh, null, null]);
    return Array.isArray(result) ? result[1] : (result && result.txs) || [];
  }

  // The signed payment proof for a sent transaction — grin-wallet's PaymentProof
  // { amount, excess, recipient_address, recipient_sig, sender_address, sender_sig }, the same
  // object `grin-wallet export_proof` writes and `verify_proof` reads. Only exists for a tx that
  // REQUESTED one (the Tor CLI rail does by default for a slatepack destination; the Owner-API
  // slatepack/nostr rail passes payment_proof_recipient_address: null and so never does) and
  // only once the tx is confirmed. refresh=false reads the local tx log — the caller is expected
  // to ask only for rows the kernel backfill has already seen confirmed.
  // Params: [keychain_mask, refresh_from_node, tx_id, tx_slate_id].
  async retrievePaymentProof(slateId, refresh = false) {
    return this._call('retrieve_payment_proof', [null, !!refresh, null, String(slateId)]);
  }

  // The wallet's slatepack address at a derivation index (default 0). Deterministic from the
  // seed, so index 0 is a stable per-wallet fingerprint used as the pool's wallet-identity anchor
  // (lib/reconciliation.js probeWalletIdentity → AlertMonitor swap guard). grin-wallet Owner v3
  // `get_slatepack_address` serialises the SlatepackAddress directly to its bech32 string.
  async getSlatepackAddress(index = 0) {
    const result = await this._call('get_slatepack_address', [null, index]);
    return typeof result === 'string' ? result : (result && (result.slatepack_address || result.address)) || null;
  }

  // --- Slatepack send flow (Owner API v3) -----------------------------------
  //
  // Reinstates the interactive (no-Tor) payout, secured by ENCRYPTION rather than transport:
  // the slate is armored as a slatepack *encrypted to the miner's grin address* (an ed25519
  // SlatepackAddress — the same key used as the Tor .onion). Only the wallet holding that
  // address's private key can decrypt + `receive`, so a non-owner who triggers the payout gets
  // an undecryptable blob → no theft. The IP gate (owner-proof.js) only throttles who can trigger.
  //
  // Param order matches grin-wallet Owner API v3 (owner_rpc.rs OwnerRpc, checked against v5.4.1).
  // Every method's first param is the keychain-mask token from open_wallet (params[0], or
  // `token` for a named-params call); call sites leave it null and _call() substitutes the
  // live session token (same as 059 Drop's ownerApiSession —
  // passing an actual null gets "Supplied keychain mask is invalid" from the LMDB backend).

  // 1a. Build an unconfirmed send slate. amountGrin → nanoGRIN (u64; pool payouts stay well
  //     under 2^53 so a JS number is safe). Returns a VersionedSlate.
  async initSendTx(amountGrin, { minimumConfirmations = 1 } = {}) {
    const args = {
      src_acct_name: null,
      amount: Math.round(Number(amountGrin) * 1e9),
      minimum_confirmations: minimumConfirmations,
      max_outputs: 500,
      num_change_outputs: 1,
      selection_strategy_is_use_all: false,
      target_slate_version: null,
      payment_proof_recipient_address: null,
      ttl_blocks: null,
      estimate_only: null,
      late_lock: null
    };
    return this._call('init_send_tx', [null, args]);
  }

  // 1b. Lock the inputs the slate spends (must run before sharing the slate).
  async txLockOutputs(slate) {
    return this._call('tx_lock_outputs', [null, slate]);
  }

  // 1c. Armor + ENCRYPT the slate to the recipient address(es). recipients = [SlatepackAddress];
  //     a non-empty recipients list is what triggers age-encryption to those keys; [] gives plain
  //     armor (the Goblin/Nostr rail). Returns the `BEGINSLATEPACK…ENDSLATEPACK` string.
  //     Owner v3 signature: create_slatepack_message(token, slate, sender_index: Option<u32>,
  //     recipients: Vec<SlatepackAddress>). This call used to go out POSITIONAL as
  //     [token, sender_index, recipients, slate] — the wallet read the number 0 as the slate and
  //     every slatepack and Goblin payout failed with `InvalidArgStructure "slate" at position 1`.
  //     It now sends NAMED params (as 051 Fidelius and the 053 bridge do), which cannot be
  //     misordered. The key names must match the Rust parameter names exactly.
  //     sender_index stays 0, not null: the miner's response slatepack is then encrypted back to
  //     the pool's index-0 address, which finalize decodes with secret_indices [0].
  async createSlatepackMessage(slate, recipients, senderIndex = 0) {
    return this._call('create_slatepack_message',
      { token: null, slate, sender_index: senderIndex, recipients });
  }

  // 2. Decode the miner's returned (response) slatepack back into a slate.
  async slateFromSlatepackMessage(message, secretIndices = [0]) {
    return this._call('slate_from_slatepack_message', [null, message, secretIndices]);
  }

  // 3a. Finalize the round-tripped slate (adds the sender's partial signature).
  async finalizeTx(slate) {
    return this._call('finalize_tx', [null, slate]);
  }

  // 3b. Broadcast the finalized tx to the node (fluff = don't wait for dandelion aggregation).
  async postTx(slate, fluff = false) {
    return this._call('post_tx', [null, slate, fluff]);
  }

  // Cancel a pending tx by its slate UUID and release the wallet-side output locks taken by
  // tx_lock_outputs. Used when a slatepack payout expires unfinalized. params: [token, tx_id,
  // tx_slate_id] — pass tx_id null and match on the slate UUID.
  async cancelTx(slateId) {
    return this._call('cancel_tx', [null, null, slateId]);
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

    // 3. AES-256 key = the ECDH shared secret AS-IS. grin-wallet uses the shared point's
    //    32-byte X-coordinate directly as the key (NO extra hash); Node's computeSecret()
    //    already returns exactly that X-coordinate. An earlier sha256() over it corrupted
    //    the key, so the wallet rejected every encrypted call with "EncryptedBody:
    //    decryption failed" (balance + payouts never worked). Matches the known-good
    //    051_fidelius/server.js ownerApiSession() implementation.
    this.aesKey = ecdh.computeSecret(Buffer.from(serverPubkey, 'hex'));

    // 4. open_wallet — first encrypted call; unlocks the wallet for this session.
    //    It returns the keychain-mask token every subsequent Owner call must carry;
    //    each open_wallet re-masks the seed, so any previously issued token dies here.
    const password = this._readPassword();
    this.token = await this._encryptedCall('open_wallet', [null, password]);

    this.sessionOpen = true;
  }

  _readPassword() {
    if (!this.passFile || !fs.existsSync(this.passFile)) return '';
    return fs.readFileSync(this.passFile, 'utf-8').trim();
  }

  // Ensure session is open before making a call; re-init if it was dropped.
  // The keychain mask is always the `token` param in Owner API v3 — filled with the live
  // open_wallet token here (and re-filled on retry, since re-init rotates it). Two param
  // shapes are accepted: a positional array (token is params[0]) or a named object (token is
  // params.token). Named params are order-proof; create_slatepack_message uses them because
  // its positional order was wrong once and broke every slatepack payout.
  async _call(method, params) {
    if (!this.sessionOpen) {
      await this.initSession();
    }
    this._fillToken(params);
    try {
      return await this._encryptedCall(method, params);
    } catch (err) {
      // Session may have expired (wallet restarted) — invalidate and retry once. Match
      // case-insensitively: node-fetch surfaces a 401 as "HTTP 401: Unauthorized" (capital
      // U), a stale ECDH session surfaces as a "decryption failed" body, and a stale token
      // (the boot/watchdog unlock re-ran open_wallet, rotating the mask) surfaces as
      // "keychain mask is invalid" — all mean the session must be re-established.
      const m = String(err.message || '').toLowerCase();
      if (m.includes('unauthorized') || m.includes('session') ||
          m.includes('decryption failed') || m.includes('keychain mask')) {
        this.aesKey      = null;
        this.sessionOpen = false;
        await this.initSession();
        this._fillToken(params);
        return this._encryptedCall(method, params);
      }
      throw err;
    }
  }

  // Write the live token into either param shape _call accepts (see above).
  _fillToken(params) {
    if (Array.isArray(params)) params[0] = this.token;
    else params.token = this.token;
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
