const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ─── Bech32 + v3-onion derivation (no external deps) ─────────────────────────
// A Grin Slatepack address (grin1…/tgrin1…) IS the recipient's 32-byte ed25519 public key,
// bech32-encoded. The Tor v3 onion of that wallet is a deterministic function of the same key,
// so we can derive the onion the miner's wallet publishes and probe it directly.
const BECH32_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

function bech32Polymod(values) {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const b = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((b >>> i) & 1) chk ^= GEN[i];
  }
  return chk >>> 0;
}

function bech32HrpExpand(hrp) {
  const out = [];
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) >> 5);
  out.push(0);
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) & 31);
  return out;
}

// Grin uses classic bech32 (checksum constant 1), not bech32m. Returns the 5-bit data groups
// with the 6-symbol checksum stripped, or null on any malformed/failed-checksum input.
function bech32Decode(str) {
  const s = String(str || '');
  if (s !== s.toLowerCase() && s !== s.toUpperCase()) return null; // no mixed case
  const lowered = s.toLowerCase();
  const pos = lowered.lastIndexOf('1');
  if (pos < 1 || pos + 7 > lowered.length) return null;
  const hrp = lowered.slice(0, pos);
  const data = [];
  for (const ch of lowered.slice(pos + 1)) {
    const d = BECH32_CHARSET.indexOf(ch);
    if (d === -1) return null;
    data.push(d);
  }
  if (bech32Polymod(bech32HrpExpand(hrp).concat(data)) !== 1) return null;
  return { hrp, data: data.slice(0, data.length - 6) };
}

// 5-bit groups → 8-bit bytes (BIP173 convertbits, pad=false for decode).
function convertBits5to8(data) {
  let acc = 0, bits = 0;
  const out = [];
  for (const value of data) {
    if (value < 0 || value >> 5) return null;
    acc = ((acc << 5) | value) & 0x1fff;
    bits += 5;
    while (bits >= 8) { bits -= 8; out.push((acc >>> bits) & 0xff); }
  }
  // Leftover must be < 5 bits and all-zero, or the input was malformed.
  if (bits >= 5 || ((acc << (8 - bits)) & 0xff)) return null;
  return out;
}

function base32LowerNoPad(buf) {
  const A = 'abcdefghijklmnopqrstuvwxyz234567';
  let bits = 0, value = 0, out = '';
  for (const b of buf) {
    value = ((value << 8) | b) & 0x1fff;
    bits += 8;
    while (bits >= 5) { bits -= 5; out += A[(value >>> bits) & 31]; }
  }
  if (bits > 0) out += A[(value << (5 - bits)) & 31];
  return out;
}

// v3 onion = base32(pubkey ‖ checksum ‖ 0x03), checksum = SHA3-256(".onion checksum" ‖ pubkey ‖ 0x03)[:2].
function onionV3FromPubkey(pubkey) {
  const version = Buffer.from([0x03]);
  const checksum = crypto.createHash('sha3-256')
    .update(Buffer.concat([Buffer.from('.onion checksum', 'ascii'), pubkey, version]))
    .digest().subarray(0, 2);
  return base32LowerNoPad(Buffer.concat([pubkey, checksum, version])) + '.onion';
}

class WalletTor {
  constructor(config) {
    this.network = config.network || 'testnet';
    this.walletDir = config.wallet_dir;
    this.ownerPort = config.wallet_owner_port || (this.network === 'mainnet' ? 3420 : 13420);
    this.torSocksPort = config.tor_socks_port || 9050;
    this.torCheckTimeoutMs = config.tor_check_timeout_ms || 3000;
    // grin-wallet publishes the wallet's foreign API onion at virtual port 80.
    this.onionVirtualPort = config.tor_onion_virtual_port || 80;
    this.torCheckRetries = Math.max(1, config.tor_check_retries || 2);
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

  // Real Tor reachability probe. Derives the wallet's v3 onion from the Slatepack address and
  // SOCKS5-connects to onion:80 through the local tor daemon; a successful CONNECT means tor
  // found the hidden-service descriptor AND the wallet's foreign-API listener accepted the
  // stream — i.e. the wallet is up right now. Tri-state:
  //   online:true  — reachable (connect succeeded)
  //   online:false — CONFIDENT offline: tor is up but the HS didn't answer across all retries
  //   online:null  — INDETERMINATE: couldn't run the probe (bad address / no socks lib / tor
  //                  daemon unreachable). Callers must fail OPEN on null so a misconfigured pool
  //                  box never blocks every payout — grin-wallet stays the authority at send.
  // Retries across fresh circuits so one flaky circuit doesn't wrongly flag a healthy listener.
  async probeToronlineStatus(address) {
    if (!this.isPayoutAddress(address)) {
      return { online: false, reason: 'invalid_format' };
    }
    const onion = this.deriveOnionAddress(address);
    if (!onion) {
      return { online: null, reason: 'derivation_failed' };
    }
    let SocksClient;
    try {
      ({ SocksClient } = require('socks'));
    } catch (_) {
      return { online: null, reason: 'socks_unavailable' };
    }

    let lastReason = 'unreachable';
    for (let i = 0; i < this.torCheckRetries; i++) {
      const r = await this._torConnectOnce(SocksClient, onion);
      if (r.online === true) return { online: true, reason: 'reachable' };
      // Can't reach the tor daemon itself → we cannot judge the wallet → indeterminate (fail-open).
      if (r.online === null) return { online: null, reason: r.reason };
      lastReason = r.reason;
    }
    return { online: false, reason: lastReason };
  }

  // Derive the wallet's v3 onion from its grin1…/tgrin1… Slatepack address. Returns null on any
  // decode problem (caller treats null as indeterminate, never as "offline").
  deriveOnionAddress(address) {
    const dec = bech32Decode(address);
    if (!dec || (dec.hrp !== 'grin' && dec.hrp !== 'tgrin')) return null;
    const bytes = convertBits5to8(dec.data);
    if (!bytes || bytes.length !== 32) return null;
    return onionV3FromPubkey(Buffer.from(bytes));
  }

  // One SOCKS5 connect attempt. Separates "tor daemon unreachable" (→ null, fail-open) from
  // "tor rejected/timed out the onion stream" (→ false, a real offline signal).
  async _torConnectOnce(SocksClient, onion) {
    try {
      const info = await SocksClient.createConnection({
        proxy: { host: '127.0.0.1', port: this.torSocksPort, type: 5 },
        command: 'connect',
        destination: { host: onion, port: this.onionVirtualPort },
        timeout: this.torCheckTimeoutMs
      });
      try { info.socket.destroy(); } catch (_) { /* best-effort close */ }
      return { online: true };
    } catch (err) {
      const msg = String((err && err.message) || err || '');
      // A SOCKS-level "rejected connection" means the tor daemon answered — so the failure is the
      // hidden service, not the proxy → confident offline. A raw socket error to 127.0.0.1:<socks>
      // (ECONNREFUSED/ETIMEDOUT/EHOSTUNREACH/ENOTFOUND) means we never reached tor → indeterminate.
      if (!/rejected/i.test(msg) && /ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ENOTFOUND|ECONNRESET|EPIPE/i.test(msg)) {
        return { online: null, reason: 'tor_unavailable' };
      }
      return { online: false, reason: 'unreachable' };
    }
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
