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
      throw new Error(`Failed to get wallet balance: ${err.message}`);
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

    const prefix = network === 'mainnet' ? 'grin1' : 'grin1';
    if (!address.startsWith(prefix)) return false;

    if (address.length < 15 || address.length > 80) return false;

    const validChars = /^[a-z0-9]+$/;
    return validChars.test(address.substring(5));
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
