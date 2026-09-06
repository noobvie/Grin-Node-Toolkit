'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Wallet Checker — TIER 2: the Tor liveness probe (POST /api/wallet-check)
//
// Tier 1 (public/js/wallet-check.js) answers "is this address intact, and what
// .onion does it derive to" with no network at all. This file answers the one
// question arithmetic cannot: is anything ANSWERING at that onion right now.
//
// PORTED, not re-derived, from
// web/07_mining_pool_public/back-end-pool/lib/wallet-tor.js — the bech32 and
// v3-onion halves were validated there against an independent Python reference
// (memory project_pool_tor_preflight_gate). The SOCKS5 client is the sibling
// port in ./socks5.js. Between them this route adds ZERO npm dependencies; 06d
// still has exactly one (express) and that is a standing rule, not an accident.
//
// ── The two things this file exists to get right ────────────────────────────
//
// 1. VIRTUAL PORT 80, NOT 3415. grin-wallet publishes the wallet foreign API
//    hidden service as `HiddenServicePort 80 <listener>` (impls/src/tor/
//    config.rs, source-verified 2026-07-19). Dialling 3415 through Tor fails
//    for every healthy wallet in existence, which reads as "everyone is
//    offline" rather than as a bug.
//
// 2. TRI-STATE, NEVER A GREEN/RED BINARY.
//      true  — a grin-wallet answered our check_version JSON-RPC (an HTTP 401
//              counts: it still proves a wallet is there)
//      false — CONFIDENT offline: tor spoke to us and the hidden service did
//              not answer, across every retry, on fresh circuits
//      null  — INDETERMINATE: we could not run the probe at all. Bad address,
//              or nothing at 127.0.0.1:<socks> — i.e. OUR tor is down.
//    Rendering our own outage as the visitor's wallet being offline is the same
//    class of lie as reporting a healthy remote node's peer count as 0: it
//    draws a working thing as a broken one, and the visitor has no way to tell.
//    The whole point of the false/null split is that `null` is OUR fault and
//    must be worded that way on the page.
//
// ⚠ One deliberate divergence from the pool: an address that is not a Slatepack
// address returns null here, not false. The pool was gating a PAYOUT, so "this
// can never be paid" was a decision it was entitled to make. This is a
// reachability checker, and tier 1 has already told the visitor the address is
// malformed in far more detail — a second, vaguer "offline" verdict on top of
// that would be noise, and it would be an observation we never made.
//
// The probe is INERT unless the operator turns it on: wallet_check_probe
// defaults to false, because a box with no tor daemon would otherwise answer
// "could not check" to every visitor forever.
// ─────────────────────────────────────────────────────────────────────────────

const crypto = require('crypto');
const http   = require('http');

const socks5 = require('./socks5');

const FOREIGN_PATH   = '/v2/foreign';
const MAX_BODY_BYTES = 16 * 1024;   // a check_version answer is ~120 bytes

// ── Bech32 + v3-onion derivation (verbatim port, no external deps) ───────────
// A Grin Slatepack address (grin1…/tgrin1…) IS the wallet's 32-byte ed25519
// public key, bech32-encoded, and a v3 onion is that same key re-wrapped. So
// the onion is arithmetic on the address — there is nothing to look up.

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

// Grin uses classic bech32 (checksum constant 1), not bech32m. Returns the
// 5-bit groups with the 6-symbol checksum stripped, or null on any malformed or
// failed-checksum input.
function bech32Decode(str) {
  const s = String(str || '');
  if (s !== s.toLowerCase() && s !== s.toUpperCase()) return null;   // no mixed case
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

// v3 onion = base32(pubkey ‖ checksum ‖ 0x03),
// checksum = SHA3-256(".onion checksum" ‖ pubkey ‖ 0x03)[:2].
function onionV3FromPubkey(pubkey) {
  const version = Buffer.from([0x03]);
  const checksum = crypto.createHash('sha3-256')
    .update(Buffer.concat([Buffer.from('.onion checksum', 'ascii'), pubkey, version]))
    .digest().subarray(0, 2);
  return base32LowerNoPad(Buffer.concat([pubkey, checksum, version])) + '.onion';
}

// Same shape check the pool uses. 58 data characters after the hrp is the only
// length a 32-byte payload can produce, so this rejects the obvious junk before
// the checksum work starts.
function isSlatepackAddress(address) {
  return /^(grin1|tgrin1)[ac-hj-np-z02-9]{58}$/i.test(String(address || ''));
}

// → "<56 chars>.onion", or null on any decode problem. Null is INDETERMINATE at
// the caller, never "offline".
function deriveOnionAddress(address) {
  const dec = bech32Decode(address);
  if (!dec || (dec.hrp !== 'grin' && dec.hrp !== 'tgrin')) return null;
  const bytes = convertBits5to8(dec.data);
  if (!bytes || bytes.length !== 32) return null;
  return onionV3FromPubkey(Buffer.from(bytes));
}

// ── Verdict vocabulary ───────────────────────────────────────────────────────
// One map so the server, the page and this file cannot drift apart on what a
// reason means. `online` is the tri-state; the text is written for the visitor,
// and the null wording says WE could not check rather than implying anything
// about their wallet.

const REASONS = {
  reachable:         { online: true,  message: 'The wallet answered over Tor just now.' },
  reachable_auth:    { online: true,  message: 'A grin-wallet answered over Tor, and asked for credentials — it is running.' },
  onion_unreachable: { online: false, message: 'Tor is working here, but nothing answered at that wallet’s Tor address.' },
  onion_timeout:     { online: false, message: 'Tor is working here, but that wallet’s Tor address did not answer in time.' },
  no_answer:         { online: false, message: 'The connection was accepted but no reply came back — something is there, but it is not answering as a wallet.' },
  not_wallet:        { online: false, message: 'Something answered at that Tor address, but it was not a grin-wallet foreign API.' },
  invalid_address:   { online: null,  message: 'That is not a Slatepack address, so there was nothing to probe.' },
  derivation_failed: { online: null,  message: 'The Tor address could not be derived from that address, so no probe was made.' },
  tor_unavailable:   { online: null,  message: 'This server could not reach its own Tor daemon, so the check could not run. This says nothing about the wallet.' },
  probe_disabled:    { online: null,  message: 'The Tor liveness check is switched off on this server.' },
  probe_busy:        { online: null,  message: 'Too many checks are already running here. Try again in a moment.' },
  probe_failed:      { online: null,  message: 'The check could not be completed here. This says nothing about the wallet.' },
};

function verdict(reason, extra) {
  const r = REASONS[reason] || REASONS.probe_failed;
  return Object.assign({ online: r.online, reason, message: r.message }, extra || {});
}

// ── Failure classification — the false/null split ────────────────────────────
//
// Pure, and the only place the split is decided. Three signals, in order of how
// much they prove:
//
//   1. a SOCKS reply BYTE — the proxy spoke the protocol at us, so tor is up
//      and the failure is downstream of it;
//   2. `proxyResponded` from ./socks5.js — same conclusion, for the failures
//      that happen after the greeting but before a reply byte;
//   3. the error STRING — the fallback, and the only signal the pool had. Kept
//      because it is what any other SOCKS client would leave us with, and
//      because it is what the unit tests drive.
//
// "rejected" is tested BEFORE the errno set on purpose: a SOCKS-level rejection
// can carry ECONNREFUSED in its text while still meaning "tor answered".
function classifyProbeError(err) {
  const reply     = (err && typeof err.code === 'number') ? err.code : null;
  const responded = Boolean(err && err.proxyResponded === true);
  const msg       = String((err && err.message) || err || '');

  if (reply !== null && reply !== 0) {
    return verdict('onion_unreachable', {
      socks_reply: reply,
      socks_reply_text: socks5.REPLY_TEXT[reply] || null,
    });
  }
  if (responded) {
    return verdict(/timed out|timeout/i.test(msg) ? 'onion_timeout' : 'onion_unreachable');
  }
  if (/rejected|host unreachable|onion descriptor/i.test(msg)) {
    return verdict('onion_unreachable');
  }
  if (/ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|EAI_AGAIN|ECONNRESET|EPIPE|EACCES/i.test(msg)) {
    return verdict('tor_unavailable');
  }
  // A timeout with not one byte back from the proxy is a stuck tor, not a
  // stuck wallet — we never got far enough to have an opinion about the wallet.
  if (/timed out|timeout/i.test(msg)) return verdict('tor_unavailable');
  return verdict('probe_failed');
}

// ── Reading the answer ───────────────────────────────────────────────────────
//
// Pure. An accepted TCP connection proves nothing (CLAUDE.md, *reachability
// needs a parsed result*) — hence a real check_version POST rather than a bare
// SOCKS connect. The one exception is 401: a wallet that demands credentials
// has still identified itself as a wallet that is running, and whether the
// foreign API over Tor asks for basic auth is an open question the Part 9 VPS
// session settles. Treating 401 as online means that answer does not gate this.
function readProbeAnswer(status, bodyText) {
  if (status === 401) return verdict('reachable_auth', { http_status: status });
  if (status < 200 || status >= 300) return verdict('not_wallet', { http_status: status });

  let data;
  try { data = JSON.parse(String(bodyText || '')); }
  catch { return verdict('not_wallet', { http_status: status }); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return verdict('not_wallet', { http_status: status });
  }
  // A JSON-RPC error is still a wallet answering — an older build that does not
  // know check_version is running, which is the question asked.
  if (!('result' in data) && !('error' in data)) {
    return verdict('not_wallet', { http_status: status });
  }

  // Result<T,E> comes across as {"Ok":T} / {"Err":E}; garnish only, never the
  // verdict.
  let apiVersion = null;
  const r = data.result;
  const inner = (r && typeof r === 'object' && 'Ok' in r) ? r.Ok : r;
  if (inner && typeof inner === 'object' && typeof inner.foreign_api_version === 'number') {
    apiVersion = inner.foreign_api_version;
  }
  return verdict('reachable', { http_status: status, foreign_api_version: apiVersion });
}

// ── The network half ─────────────────────────────────────────────────────────

// One check_version POST down an already-tunnelled socket.
//
// `agent: null`, NOT `agent: false`. In Node, `false` means "build me a fresh
// default Agent" — an agent that dials the destination itself — and
// http.request only consults createConnection when there is NO agent. With
// `false` the SOCKS tunnel is built, handed back, and then silently ignored
// while Node opens its own direct socket to the .onion, which cannot resolve.
// That is the entire Tor rail bypassed by one wrong falsy value. (Same trap,
// same wording, as web/052_accio/gateway/tor_route.js.)
function checkVersionOverSocket(socket, opts) {
  const { onion, port, timeoutMs, userAgent } = opts;
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ jsonrpc: '2.0', method: 'check_version', params: [], id: 1 });
    let settled = false;
    const done = (err, value) => {
      if (settled) return;
      settled = true;
      if (err) { try { socket.destroy(); } catch { /* best effort */ } reject(err); }
      else resolve(value);
    };

    let req;
    try {
      req = http.request({
        method:  'POST',
        path:    FOREIGN_PATH,
        headers: {
          'Host':           port === 80 ? onion : onion + ':' + port,
          'Content-Type':   'application/json',
          'Content-Length': Buffer.byteLength(body),
          'Accept':         'application/json',
          'Connection':     'close',
          'User-Agent':     userAgent || 'GrinTinyExplorer',
        },
        agent: null,
        createConnection: () => socket,
        // setHost would append a second Host header derived from host/port
        // options we are not passing; ours is already in the header set.
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
        res.on('end',   () => done(null, { status: res.statusCode, body: data }));
        res.on('close', () => done(null, { status: res.statusCode, body: data }));
        res.on('error', (e) => done(e));
      });
    } catch (e) {
      return done(e);
    }

    req.on('error', (e) => done(e));
    req.setTimeout(timeoutMs, () => req.destroy(new Error('no reply within ' + timeoutMs + 'ms')));
    req.write(body);
    req.end();
  });
}

// One attempt: tunnel, then ask. `deps.connect` is injectable so the tri-state
// can be unit-tested against fabricated errors with no tor and no network.
async function probeOnce(onion, opts, deps) {
  const connect = (deps && deps.connect) || socks5.connect;

  let socket;
  try {
    socket = await connect({
      socksHost:    opts.socksHost,
      socksPort:    opts.socksPort,
      host:         onion,
      port:         opts.onionPort,
      timeoutMs:    opts.timeoutMs,
      // Per-ATTEMPT isolation tag → a fresh circuit per retry. Reusing the
      // circuit would make retry 2 a re-run of the same failure, which is the
      // one thing the retry exists not to be. Not a secret; a circuit selector.
      isolationTag: 'tinyexp-' + opts.attempt,
    });
  } catch (err) {
    return classifyProbeError(err);
  }

  try {
    const answer = await checkVersionOverSocket(socket, {
      onion,
      port:      opts.onionPort,
      timeoutMs: opts.timeoutMs,
      userAgent: opts.userAgent,
    });
    return readProbeAnswer(answer.status, answer.body);
  } catch {
    // The tunnel was BUILT, so tor is unambiguously up and reached the hidden
    // service — this failure is the far end's, never ours. Confident offline.
    return verdict('no_answer');
  } finally {
    try { socket.destroy(); } catch { /* best effort */ }
  }
}

// Tri-state probe. Retries on fresh circuits so one flaky circuit does not flag
// a healthy listener, and returns the moment an answer settles the question:
//   · online → nothing more to learn
//   · not_wallet → a stable fact about the far end; another circuit says the same
//   · tor_unavailable / any null → OUR side is broken, so retrying only spends
//     time before printing the same "could not check"
async function probeWallet(address, options, deps) {
  const opts = {
    socksHost:  (options && options.socksHost) || '127.0.0.1',
    socksPort:  (options && options.socksPort) || 9050,
    onionPort:  (options && options.onionPort) || 80,
    timeoutMs:  (options && options.timeoutMs) || 8000,
    retries:    Math.max(1, (options && options.retries) || 2),
    userAgent:  (options && options.userAgent) || 'GrinTinyExplorer',
  };

  if (!isSlatepackAddress(address)) return verdict('invalid_address');
  const onion = deriveOnionAddress(address);
  if (!onion) return verdict('derivation_failed');

  let last = verdict('probe_failed');
  for (let attempt = 1; attempt <= opts.retries; attempt++) {
    const r = await probeOnce(onion, Object.assign({ attempt }, opts), deps);
    if (r.online === true || r.online === null || r.reason === 'not_wallet') return r;
    last = r;
  }
  return last;
}

module.exports = {
  FOREIGN_PATH,
  REASONS,
  bech32Decode, convertBits5to8, base32LowerNoPad, onionV3FromPubkey,
  isSlatepackAddress, deriveOnionAddress,
  classifyProbeError, readProbeAnswer, verdict,
  probeOnce, probeWallet,
};
