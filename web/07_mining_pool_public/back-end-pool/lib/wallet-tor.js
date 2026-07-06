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
    this.walletPassFile = config.wallet_pass_file || '';
    // Hard ceiling on a single `grin-wallet send` (Tor connect + slate round-trip). Stops a
    // hung wallet or unreachable recipient from stalling the withdrawal scheduler loop.
    this.sendTimeoutMs = config.wallet_send_timeout_ms || 120000;
  }

  // Pool payouts go to the miner's Slatepack address (grin1…/tgrin1…) — which IS their mining
  // identity. grin-wallet resolves the Slatepack address to its Tor/onion service and sends
  // over Tor automatically, so we pass the address straight through (no .onion derivation here).
  async sendToTorAddress(address, amount) {
    try {
      if (!this.isPayoutAddress(address)) {
        throw new Error('Invalid Grin payout address (expected a grin1…/tgrin1… Slatepack address)');
      }

      const result = await this.execWalletCommand([
        '--top-level-dir', this.walletDir,
        'send', '-d', address, '-a', String(amount)
      ]);

      return {
        success: true,
        address,
        amount,
        timestamp: new Date().toISOString(),
        output: result
      };
    } catch (err) {
      return {
        success: false,
        error: err.message,
        address,
        amount
      };
    }
  }

  // Reachability hint for the UI only. grin-wallet performs the real Tor connection during the
  // send and is the authoritative check, so for a well-formed address we report an "unknown"
  // tri-state (online: null) instead of guessing. We deliberately do NOT pre-probe by deriving
  // the .onion from the Slatepack address — grin-wallet already does that, and a wrong
  // derivation here would falsely block every payout.
  async probeToronlineStatus(address) {
    if (!this.isPayoutAddress(address)) {
      return { online: false, reason: 'invalid_format' };
    }
    return { online: null, reason: 'determined_at_send' };
  }

  isPayoutAddress(address) {
    return /^(grin1|tgrin1)[ac-hj-np-z02-9]{58}$/i.test(String(address || ''));
  }

  // args: string[] — passed directly to spawn, never interpolated into a shell string.
  // Feeds the wallet password (from wallet_pass_file, if set) on stdin so the non-interactive
  // `send` doesn't block on the password prompt, and enforces a timeout so a stuck send can't
  // wedge the scheduler.
  async execWalletCommand(args) {
    return new Promise((resolve, reject) => {
      const proc = spawn('grin-wallet', args);

      let stdout = '';
      let stderr = '';
      let finished = false;

      const finish = (fn, arg) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        fn(arg);
      };

      const timer = setTimeout(() => {
        proc.kill('SIGKILL');
        finish(reject, new Error(`grin-wallet timed out after ${this.sendTimeoutMs}ms`));
      }, this.sendTimeoutMs);

      proc.stdout.on('data', (data) => { stdout += data.toString(); });
      proc.stderr.on('data', (data) => { stderr += data.toString(); });

      proc.on('close', (code) => {
        if (code === 0) finish(resolve, stdout);
        else finish(reject, new Error(`Command failed (code ${code}): ${stderr}`));
      });

      proc.on('error', (err) => finish(reject, err));

      // Supply the wallet password on stdin when a pass file is configured. If none is set the
      // wallet will prompt and the timeout above will catch the resulting hang.
      try {
        if (this.walletPassFile && fs.existsSync(this.walletPassFile)) {
          const pass = fs.readFileSync(this.walletPassFile, 'utf-8').replace(/\r?\n$/, '');
          proc.stdin.write(pass + '\n');
        }
      } catch (_) { /* ignore — fall through to prompt/timeout */ }
      proc.stdin.end();
    });
  }

  async getWalletVersion() {
    try {
      const result = await this.execWalletCommand(['--version']);
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
