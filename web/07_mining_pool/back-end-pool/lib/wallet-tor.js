const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

class WalletTor {
  constructor(config) {
    this.network = config.network || 'testnet';
    this.walletDir = config.wallet_dir;
    this.ownerPort = config.wallet_owner_port || (this.network === 'mainnet' ? 3420 : 13420);
    this.torSocksPort = config.tor_socks_port || 9050;
    this.torCheckTimeoutMs = config.tor_check_timeout_ms || 3000;
  }

  async sendToTorAddress(torAddress, amount) {
    try {
      if (!this.isTorAddress(torAddress)) {
        throw new Error('Invalid Tor address format');
      }

      const cmd = `grin-wallet -p ${this.walletDir} send -d '${torAddress}' -a ${amount}`;

      const result = await this.execWalletCommand(cmd);

      return {
        success: true,
        address: torAddress,
        amount,
        timestamp: new Date().toISOString(),
        output: result
      };
    } catch (err) {
      return {
        success: false,
        error: err.message,
        address: torAddress,
        amount
      };
    }
  }

  async probeToronlineStatus(torAddress, timeoutMs = null) {
    const timeout = timeoutMs || this.torCheckTimeoutMs;

    return new Promise((resolve) => {
      try {
        if (!this.isTorAddress(torAddress)) {
          resolve({
            online: false,
            reason: 'invalid_format'
          });
          return;
        }

        const startTime = Date.now();
        const timer = setTimeout(() => {
          resolve({
            online: false,
            reason: 'timeout',
            latency_ms: timeout
          });
        }, timeout);

        this.checkTorConnection(torAddress)
          .then((result) => {
            clearTimeout(timer);
            const latency = Date.now() - startTime;
            resolve({
              online: result,
              latency_ms: latency,
              checked_at: new Date().toISOString()
            });
          })
          .catch(() => {
            clearTimeout(timer);
            resolve({
              online: false,
              reason: 'connection_failed',
              checked_at: new Date().toISOString()
            });
          });
      } catch (err) {
        resolve({
          online: false,
          reason: 'error',
          error: err.message
        });
      }
    });
  }

  async checkTorConnection(torAddress) {
    return new Promise((resolve, reject) => {
      const [onionDomain, port] = torAddress.split(':');
      const targetPort = port || 3415;

      const net = require('net');
      const socket = new net.Socket();

      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error('Connection timeout'));
      }, 3000);

      socket.on('connect', () => {
        clearTimeout(timer);
        socket.destroy();
        resolve(true);
      });

      socket.on('error', () => {
        clearTimeout(timer);
        reject(new Error('Connection error'));
      });

      socket.connect(targetPort, onionDomain);
    });
  }

  isTorAddress(address) {
    const torRegex = /^[a-z2-7]{56}\.onion(:[0-9]+)?$/i;
    return torRegex.test(address);
  }

  async execWalletCommand(cmd) {
    return new Promise((resolve, reject) => {
      const proc = spawn('bash', ['-c', cmd]);

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      proc.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      proc.on('close', (code) => {
        if (code === 0) {
          resolve(stdout);
        } else {
          reject(new Error(`Command failed (code ${code}): ${stderr}`));
        }
      });

      proc.on('error', (err) => {
        reject(err);
      });
    });
  }

  async getWalletVersion() {
    try {
      const result = await this.execWalletCommand('grin-wallet --version');
      return result.trim();
    } catch (err) {
      return 'unknown';
    }
  }

  async validateWalletSetup() {
    try {
      const checks = {
        wallet_dir_exists: fs.existsSync(this.walletDir),
        config_file_exists: fs.existsSync(path.join(this.walletDir, 'grin-wallet.toml')),
        seed_file_exists: fs.existsSync(path.join(this.walletDir, '.seed')),
        version: await this.getWalletVersion()
      };

      return {
        valid: checks.wallet_dir_exists && checks.config_file_exists,
        checks
      };
    } catch (err) {
      return {
        valid: false,
        error: err.message
      };
    }
  }
}

module.exports = WalletTor;
