const fetch = require('node-fetch');

class WalletAPI {
  constructor(config) {
    this.network = config.network || 'testnet';
    this.walletDir = config.wallet_dir;
    this.ownerPort = config.wallet_owner_port || (this.network === 'mainnet' ? 3420 : 13420);
    this.foreignPort = config.wallet_foreign_port || (this.network === 'mainnet' ? 3415 : 13415);
    this.baseUrl = `http://127.0.0.1:${this.foreignPort}`;
    this.ownerUrl = `http://127.0.0.1:${this.ownerPort}`;
    this.secretPath = `${this.walletDir}/.foreign_api_secret`;
    this.ownerSecretPath = `${this.walletDir}/.owner_api_secret`;
  }

  async getBalance() {
    try {
      const result = await this._rpcCall(this.ownerUrl, 'get_balance', {}, this.ownerSecretPath);
      return result;
    } catch (err) {
      // FIX #6: Don't expose wallet paths or internal details
      console.error(`[Wallet] Balance error: ${err.message}`);
      throw new Error('Wallet balance check failed');
    }
  }

  async sendTransaction(dest, amount) {
    try {
      const result = await this._rpcCall(this.ownerUrl, 'send', {
        dest,
        amount,
        minimum_confirmations: 1
      }, this.ownerSecretPath);
      return result;
    } catch (err) {
      throw new Error(`Failed to send transaction: ${err.message}`);
    }
  }

  async getTransactionInfo(txId) {
    try {
      const result = await this._rpcCall(this.ownerUrl, 'get_tx_info', {
        tx_id: txId
      }, this.ownerSecretPath);
      return result;
    } catch (err) {
      throw new Error(`Failed to get transaction info: ${err.message}`);
    }
  }

  validateGrinAddress(address, network = 'testnet') {
    if (!address) return false;

    // FIX #8: Proper testnet/mainnet prefix validation (was hardcoded to 'grin1' for both)
    const prefixes = {
      'mainnet': 'grin1',
      'testnet': 'tgrin1'
    };
    const expectedPrefix = prefixes[network] || 'grin1';

    if (!address.startsWith(expectedPrefix)) return false;

    // Validate length (Grin addresses are typically 48-62 chars including prefix)
    if (address.length < 48 || address.length > 62) return false;

    // Validate only lowercase alphanumeric (after prefix)
    const addressBody = address.substring(expectedPrefix.length);
    const validChars = /^[a-z0-9]+$/;
    return validChars.test(addressBody) && addressBody.length > 0;
  }

  async _rpcCall(baseUrl, method, params = {}, secretPath) {
    const fs = require('fs');

    let secret = null;
    if (secretPath && fs.existsSync(secretPath)) {
      secret = fs.readFileSync(secretPath, 'utf-8').trim();
    }

    const headers = {
      'Content-Type': 'application/json'
    };

    if (secret) {
      const credentials = Buffer.from(`grin:${secret}`).toString('base64');
      headers['Authorization'] = `Basic ${credentials}`;
    }

    const payload = {
      jsonrpc: '2.0',
      method,
      params,
      id: Math.random().toString(36).substring(7)
    };

    try {
      const response = await fetch(`${baseUrl}/v3/owner`, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        timeout: 10000
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json();

      if (data.error) {
        throw new Error(`RPC error: ${data.error.message}`);
      }

      return data.result;
    } catch (err) {
      throw new Error(`RPC call failed (${method}): ${err.message}`);
    }
  }
}

module.exports = WalletAPI;
