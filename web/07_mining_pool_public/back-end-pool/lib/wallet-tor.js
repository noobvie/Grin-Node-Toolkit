const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');

const socks5 = require('./socks5');

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

// ─── Tor reachability probe — PORTED from web/06d_tiny_explorer/lib/wallet-tor.js ──────────
// Ported 2026-09-23: 06d's probe answered correctly for a live wallet that this pool's old
// probe called "not reachable". It is a COPY, not a require (the two products deploy
// separately); keep the classification in step with 06d and diverge only deliberately.
// Deliberate divergences, all listed here:
//   · a non-Slatepack address is `invalid_format` → online FALSE (06d: invalid_address → null).
//     The pool is gating a payout, and "nothing can ever be sent there" is a decision.
//   · no visitor-facing message text in REASONS — the pool page words its own outcomes.
//   · probe_disabled / probe_busy are 06d server states the pool does not have.
//   · the probe lives on the WalletTor class (probeToronlineStatus is the pool's public
//     contract) with `deps` passed to the constructor instead of per call.
//   · the User-Agent is `GrinPool` and the isolation-tag prefix `grinpool-` (06d: tinyexp).
//   · `deps` may also replace checkVersion (06d injects connect only).
//   · (Part 5 review) the check_version reply has an ABSOLUTE deadline as well as 06d's idle
//     timer — the pool has no in-flight cap, so a drip-fed reply was unbounded here.
//   · (Part 5 review) a proxy that answers but not as SOCKS5 (wrong version, auth refused) is
//     tor_unavailable → null; 06d scores it false. Here a false refuses payouts.
//
// What the old probe got wrong, so nobody walks back into it:
//   1. a 3000 ms SOCKS timeout — a cold onion connect routinely takes 5–15 s;
//   2. the `socks` npm lib reports a timeout as 'Proxy connection timed out', which matched
//      neither of the old error patterns, so "we heard nothing back" was scored as a CONFIDENT
//      offline — and that same false `false` is what the withdraw pre-flight gate refuses on;
//   3. retries reused one circuit, so retry 2 re-ran retry 1's failure;
//   4. a bare SOCKS CONNECT proves a stream opened, not that a grin-wallet is there.

const FOREIGN_PATH = '/v2/foreign';
const MAX_BODY_BYTES = 16 * 1024;   // a check_version answer is ~120 bytes
const USER_AGENT = 'GrinPool';

// Reason → tri-state. The ONE map for what a probe reason means; the tor-check route returns
// these codes verbatim and the account page maps them to its own words.
const REASONS = {
  reachable:         true,    // a grin-wallet answered check_version over Tor
  reachable_auth:    true,    // HTTP 401 — a wallet that asks for credentials is still running
  onion_unreachable: false,   // tor is up here; it could not reach that wallet's onion
  onion_timeout:     false,   // tor is up here; that onion did not answer in time
  no_answer:         false,   // tunnel built, but no HTTP reply came back
  not_wallet:        false,   // something answered, and it is not a grin-wallet foreign API
  invalid_format:    false,   // not a payout address — nothing can ever be sent there
  derivation_failed: null,    // could not derive the onion, so no probe was made
  tor_unavailable:   null,    // OUR tor daemon did not answer — says nothing about the wallet
  probe_failed:      null,    // the probe broke in a way we cannot attribute
};

function verdict(reason) {
  const known = Object.prototype.hasOwnProperty.call(REASONS, reason);
  return known ? { online: REASONS[reason], reason } : { online: null, reason: 'probe_failed' };
}

// ── Failure classification — the false/null split ─────────────────────────────────────────
// Pure, and the only place the split is decided. Three signals, in order of how much they
// prove:
//   1. a SOCKS reply BYTE — the proxy spoke the protocol at us, so tor is up and the failure
//      is downstream of it;
//   2. `proxyResponded` from ./socks5.js — same conclusion, for failures after the greeting
//      but before a reply byte;
//   3. the error STRING — the fallback for any other SOCKS client, and what the tests drive.
// "rejected" is tested BEFORE the errno set on purpose: a SOCKS-level rejection can carry
// ECONNREFUSED in its text while still meaning "tor answered".
function classifyProbeError(err) {
  const reply = (err && typeof err.code === 'number') ? err.code : null;
  const responded = Boolean(err && err.proxyResponded === true);
  const msg = String((err && err.message) || err || '');

  if (reply !== null && reply !== 0) return verdict('onion_unreachable');
  // The proxy answered, but not as a working SOCKS5 proxy: wrong protocol version, or it
  // refused the auth methods / isolation credential that tor always accepts. That is OUR side
  // broken (tor_socks_port pointing at the ControlPort, an HTTP proxy, …) — we could not look.
  // `responded` below would score it a confident offline, and the gate would then refuse EVERY
  // Tor payout: the misconfigured-box brick the fail-open contract exists to prevent. The
  // strings are lib/socks5.js's own. (Review fix, payout-rails Part 5; 06d scores these false.)
  if (/answered version|reply had version|rejected every authentication method|rejected the isolation credential|selected unsupported method/i.test(msg)) {
    return verdict('tor_unavailable');
  }
  if (responded) return verdict(/timed out|timeout/i.test(msg) ? 'onion_timeout' : 'onion_unreachable');
  if (/rejected|host unreachable|onion descriptor/i.test(msg)) return verdict('onion_unreachable');
  if (/ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|EAI_AGAIN|ECONNRESET|EPIPE|EACCES/i.test(msg)) {
    return verdict('tor_unavailable');
  }
  // A timeout with not one byte back from the proxy is a stuck tor, not a stuck wallet — we
  // never got far enough to have an opinion about the wallet. THIS is the line the old probe
  // lacked: it scored 'Proxy connection timed out' as a confident offline.
  if (/timed out|timeout/i.test(msg)) return verdict('tor_unavailable');
  return verdict('probe_failed');
}

// ── Reading the answer ────────────────────────────────────────────────────────────────────
// Pure. An accepted TCP connection proves nothing (CLAUDE.md: reachability needs a parsed
// result), hence a real check_version POST. The one exception is 401: a wallet that demands
// credentials has still identified itself as a running wallet.
function readProbeAnswer(status, bodyText) {
  if (status === 401) return verdict('reachable_auth');
  if (status < 200 || status >= 300) return verdict('not_wallet');
  let data;
  try { data = JSON.parse(String(bodyText || '')); }
  catch (_) { return verdict('not_wallet'); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return verdict('not_wallet');
  // A JSON-RPC error is still a wallet answering — an older build that does not know
  // check_version is running, which is the question asked.
  if (!('result' in data) && !('error' in data)) return verdict('not_wallet');
  return verdict('reachable');
}

// One check_version POST down an already-tunnelled socket.
//
// `agent: null`, NOT `agent: false`. In Node, `false` means "build me a fresh default Agent" —
// one that dials the destination itself — and http.request only consults createConnection when
// there is NO agent. With `false` the SOCKS tunnel is built, handed back, and silently ignored
// while Node opens its own direct socket to the .onion, which cannot resolve. (Same trap, same
// wording, as 06d and web/052_accio/gateway/tor_route.js.)
//
// Two timers, and the second is the one that matters. req.setTimeout is an INACTIVITY timer —
// every byte resets it — and the far end of this socket is the address holder's own onion, so
// a reply fed one byte every few seconds held the probe open until Node's 16 KB header cap
// (~a day). In the withdraw gate that is a held request plus a held pool socket per POST, with
// nothing capping how many. `deadline` is ABSOLUTE: the whole reply must arrive within
// timeoutMs of the request. (Review fix, payout-rails Part 5; 06d has the same idle-only timer
// but caps concurrent probes at tor_check_max_inflight, which the pool does not.)
function checkVersionOverSocket(socket, opts) {
  const { onion, port, timeoutMs } = opts;
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ jsonrpc: '2.0', method: 'check_version', params: [], id: 1 });
    let settled = false;
    let req = null;
    let deadline = null;
    const done = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (err) { try { socket.destroy(); } catch (_) { /* best effort */ } reject(err); }
      else resolve(value);
    };

    try {
      req = http.request({
        method: 'POST',
        path: FOREIGN_PATH,
        headers: {
          'Host': port === 80 ? onion : onion + ':' + port,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          'Accept': 'application/json',
          'Connection': 'close',
          'User-Agent': USER_AGENT,
        },
        agent: null,
        createConnection: () => socket,
        // setHost would append a second Host header derived from host/port options we are not
        // passing; ours is already in the header set.
        setHost: false,
      }, (res) => {
        let data = '';
        let over = false;
        res.setEncoding('utf8');
        res.on('data', (c) => {
          if (over) return;
          data += c;
          if (data.length > MAX_BODY_BYTES) { over = true; data = data.slice(0, MAX_BODY_BYTES); res.destroy(); }
        });
        res.on('end', () => done(null, { status: res.statusCode, body: data }));
        res.on('close', () => done(null, { status: res.statusCode, body: data }));
        res.on('error', (e) => done(e));
      });
    } catch (e) {
      return done(e);
    }

    req.on('error', (e) => done(e));
    req.setTimeout(timeoutMs, () => req.destroy(new Error('no reply within ' + timeoutMs + 'ms')));
    deadline = setTimeout(
      () => req.destroy(new Error('no complete reply within ' + timeoutMs + 'ms')), timeoutMs);
    req.write(body);
    req.end();
  });
}

class WalletTor {
  // `deps` is for tests only: { connect, checkVersion } replace socks5.connect and
  // checkVersionOverSocket so the tri-state can be driven with no tor and no network.
  constructor(config, deps) {
    this.network = config.network || 'testnet';
    this.walletDir = config.wallet_dir;
    this.ownerPort = config.wallet_owner_port || (this.network === 'mainnet' ? 3420 : 13420);
    this.torSocksPort = config.tor_socks_port || 9050;
    // 8 s, matching 06d: a cold onion connect is routinely 5–15 s, and 3 s (the old value)
    // timed out healthy wallets. Applies to the SOCKS connect AND the check_version reply,
    // each an inactivity timeout, so one attempt can take up to ~2× this.
    this.torCheckTimeoutMs = config.tor_check_timeout_ms || 8000;
    // grin-wallet publishes the wallet's foreign API onion at virtual port 80.
    this.onionVirtualPort = config.tor_onion_virtual_port || 80;
    this.torCheckRetries = Math.max(1, config.tor_check_retries || 2);
    this.walletPassFile = config.wallet_pass_file || '';
    // Hard ceiling on a single `grin-wallet send` (Tor connect + slate round-trip). Stops a
    // hung wallet or unreachable recipient from stalling the withdrawal scheduler loop.
    this.sendTimeoutMs = config.wallet_send_timeout_ms || 120000;
    this._connect = (deps && deps.connect) || socks5.connect;
    this._checkVersion = (deps && deps.checkVersion) || checkVersionOverSocket;
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

  // Tor reachability probe: does a grin-wallet foreign API answer at this address's onion right
  // now? Derives the wallet's v3 onion from the Slatepack address, opens a SOCKS5 tunnel to
  // onion:80 through the local tor daemon, and POSTs a real check_version to /v2/foreign down
  // it. A parsed JSON-RPC answer (or an HTTP 401) is the proof — an opened stream alone is not.
  // Tri-state { online, reason } (reason codes: REASONS above):
  //   online:true  — a grin-wallet answered
  //   online:false — CONFIDENT offline: our tor spoke to us and that wallet did not answer, on
  //                  every attempt; or something answered that is not a wallet; or the address
  //                  is not a payout address at all (a decision, not a missing observation)
  //   online:null  — INDETERMINATE: we could not look. Above all: a timeout with ZERO bytes
  //                  back from 127.0.0.1:<socks> is null, not false — it means OUR tor is stuck
  //                  or down and says nothing about the miner's wallet. Callers must fail OPEN
  //                  on null (the withdraw pre-flight gate does) so a pool box with a broken tor
  //                  never refuses every Tor payout; grin-wallet stays the authority at send.
  // Each attempt uses its own SOCKS isolation tag, so tor builds it a FRESH circuit — a retry on
  // the same circuit is a re-run of the same failure. Stops early on true, on any null (our side
  // is broken; retrying only spends time) and on not_wallet (a stable fact about the far end).
  // Worst case ≈ tor_check_retries × 2 × tor_check_timeout_ms (connect + reply, each an
  // inactivity timeout): 2 × 2 × 8 s = 32 s at the defaults.
  async probeToronlineStatus(address) {
    if (!this.isPayoutAddress(address)) return verdict('invalid_format');
    const onion = this.deriveOnionAddress(address);
    if (!onion) return verdict('derivation_failed');

    let last = verdict('probe_failed');
    for (let attempt = 1; attempt <= this.torCheckRetries; attempt++) {
      const r = await this._probeOnce(onion, attempt);
      if (r.online === true || r.online === null || r.reason === 'not_wallet') return r;
      last = r;
    }
    return last;
  }

  // One attempt: tunnel, then ask. Never throws — every failure is classified.
  async _probeOnce(onion, attempt) {
    let socket;
    try {
      socket = await this._connect({
        socksHost: '127.0.0.1',
        socksPort: this.torSocksPort,
        host: onion,
        port: this.onionVirtualPort,
        timeoutMs: this.torCheckTimeoutMs,
        // Per-ATTEMPT tag → a fresh circuit per retry (tor's SocksPort isolates by SOCKS auth
        // by default). Not a secret; a circuit selector.
        isolationTag: 'grinpool-' + attempt,
      });
    } catch (err) {
      return classifyProbeError(err);
    }

    try {
      const answer = await this._checkVersion(socket, {
        onion,
        port: this.onionVirtualPort,
        timeoutMs: this.torCheckTimeoutMs,
      });
      return readProbeAnswer(answer.status, answer.body);
    } catch (_) {
      // The tunnel was BUILT, so tor is unambiguously up and reached the hidden service — this
      // failure is the far end's, never ours. Confident offline.
      return verdict('no_answer');
    } finally {
      try { socket.destroy(); } catch (_) { /* best effort */ }
    }
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
// Pure helpers, exported for scripts/test-payout-rails.js.
module.exports.REASONS = REASONS;
module.exports.classifyProbeError = classifyProbeError;
module.exports.readProbeAnswer = readProbeAnswer;
module.exports.checkVersionOverSocket = checkVersionOverSocket;
