/* play-pow.js — the sign-up proof-of-work, browser side (design §19.17.3, Part C6).
 *
 * The server hands out a challenge and a difficulty (`bits`). We look for a nonce — 1 to 32
 * characters of [0-9A-Za-z] — such that sha256(challenge + ':' + nonce) starts with `bits`
 * zero bits. At the default 18 bits that is ~260 000 hashes on average: about a second of one
 * browser tab, which is nothing to a person and real cost to someone making accounts by the
 * thousand. The server checks the answer with ONE hash (Node's own SHA-256), so a bug here can
 * only make a sign-up FAIL, never let a wrong answer through.
 *
 *   PlayPow.solve(challenge, bits, { onProgress(tries, ms), cancelled() }) → Promise<nonce>
 *     rejects with PlayPow.Error { code: 'cancelled' | 'bad_input' }
 *
 * Why plain JavaScript and not WebCrypto (§19.15 Part C6 #1): crypto.subtle.digest is one
 * promise round trip per hash. Measured in Edge it managed ~37 000 hashes a second — 7 s on
 * average at 18 bits and 25 s on an unlucky run, several times that on a phone. Here the
 * challenge part of the message (≥ 64 bytes, the same for every try) is hashed ONCE into a
 * midstate, and each try runs only the last one or two blocks. No secret is involved, so a
 * hand-written SHA-256 carries no risk beyond a failed sign-up, and test-shell.js checks it
 * against Node's on hundreds of inputs.
 *
 * The search runs in time slices of SLICE_MS, with a setTimeout(0) between them, so the page
 * paints the progress line and stays usable. No Worker.
 */
(function () {
  'use strict';

  var SLICE_MS = 40;
  var NONCE_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';   // base36: well inside [0-9A-Za-z]

  function PowError(code, message) {
    this.name = 'PlayPowError';
    this.code = code;
    this.message = message;
  }
  PowError.prototype = Object.create(Error.prototype);
  PowError.prototype.constructor = PowError;

  // ── SHA-256 (FIPS 180-4) on 32-bit ints ──────────────────────────────────────────────
  var K = new Int32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ]);
  var IV = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];

  // One 64-byte block, big-endian, from bytes[off..off+63] into the state H (in place).
  function compress(H, W, bytes, off) {
    var t;
    for (t = 0; t < 16; t++) {
      var i = off + t * 4;
      W[t] = (bytes[i] << 24) | (bytes[i + 1] << 16) | (bytes[i + 2] << 8) | bytes[i + 3];
    }
    for (t = 16; t < 64; t++) {
      var w15 = W[t - 15], w2 = W[t - 2];
      var s0 = ((w15 >>> 7) | (w15 << 25)) ^ ((w15 >>> 18) | (w15 << 14)) ^ (w15 >>> 3);
      var s1 = ((w2 >>> 17) | (w2 << 15)) ^ ((w2 >>> 19) | (w2 << 13)) ^ (w2 >>> 10);
      W[t] = (W[t - 16] + s0 + W[t - 7] + s1) | 0;
    }
    var a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
    for (t = 0; t < 64; t++) {
      var S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      var t1 = (h + S1 + ((e & f) ^ (~e & g)) + K[t] + W[t]) | 0;
      var S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      var t2 = (S0 + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
    H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
  }

  // Printable ASCII only (the challenge alphabet + our nonces): one byte per character.
  function asciiBytes(s) {
    var out = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }

  // The hasher for one fixed prefix: its full 64-byte blocks are compressed once (the
  // midstate); hashTail(tail) finishes prefix + tail into H and returns it.
  function prefixHasher(prefix) {
    var W = new Int32Array(64);
    var mid = new Int32Array(IV);
    var full = prefix.length - (prefix.length % 64);
    for (var off = 0; off < full; off += 64) compress(mid, W, prefix, off);
    var rest = prefix.subarray(full);
    var H = new Int32Array(8);
    var buf = new Uint8Array(256);
    return function hashTail(tail) {
      var n = rest.length + tail.length;
      var blocks = Math.ceil((n + 9) / 64);
      var end = blocks * 64;
      buf.fill(0, 0, end);
      buf.set(rest, 0);
      buf.set(tail, rest.length);
      buf[n] = 0x80;
      // The message length in BITS, big-endian in the last 8 bytes (it fits in 53 bits).
      var bitLen = (prefix.length + tail.length) * 8;
      var hi = Math.floor(bitLen / 0x100000000), lo = bitLen >>> 0;
      buf[end - 8] = hi >>> 24; buf[end - 7] = (hi >>> 16) & 255; buf[end - 6] = (hi >>> 8) & 255; buf[end - 5] = hi & 255;
      buf[end - 4] = lo >>> 24; buf[end - 3] = (lo >>> 16) & 255; buf[end - 2] = (lo >>> 8) & 255; buf[end - 1] = lo & 255;
      H.set(mid);
      for (var o = 0; o < end; o += 64) compress(H, W, buf, o);
      return H;
    };
  }

  function hex(H) {
    var s = '';
    for (var i = 0; i < 8; i++) s += ('00000000' + (H[i] >>> 0).toString(16)).slice(-8);
    return s;
  }

  // Leading zero bits of the digest, read from the state words (the digest is H big-endian).
  function leadingZeroBits(H) {
    for (var i = 0, n = 0; i < 8; i++, n += 32) if (H[i] !== 0) return n + Math.clz32(H[i]);
    return 256;
  }

  // sha256 of a printable-ASCII string as hex — for the tests, which compare it with Node's.
  function sha256hex(s) {
    return hex(prefixHasher(asciiBytes(s))(new Uint8Array(0)));
  }

  // A random 4-character start, so two tabs (or a retry) never walk the same nonces.
  function startPrefix() {
    var r = new Uint8Array(4);
    if (typeof crypto !== 'undefined' && crypto && crypto.getRandomValues) crypto.getRandomValues(r);
    else for (var j = 0; j < 4; j++) r[j] = Math.floor(Math.random() * 256);
    var s = '';
    for (var i = 0; i < r.length; i++) s += NONCE_ALPHABET[r[i] % 36];
    return s;
  }

  // The nonce is the 4-character start + an 8-digit base36 counter (36^8 ≈ 2.8e12 tries), so it
  // is always 12 characters: the padding never moves, and a try only bumps the counter bytes in
  // place and runs the tail blocks — nothing is allocated per try.
  var COUNTER_DIGITS = 8;
  function solve(challenge, bits, opts) {
    opts = opts || {};
    if (typeof challenge !== 'string' || !/^[\x21-\x7e]{1,200}$/.test(challenge) ||
        typeof bits !== 'number' || !(bits >= 1 && bits <= 32)) {
      return Promise.reject(new PowError('bad_input', 'The sign-up check could not start.'));
    }
    var prefix = asciiBytes(challenge + ':');
    var W = new Int32Array(64);
    var mid = new Int32Array(IV);
    var full = prefix.length - (prefix.length % 64);
    for (var off = 0; off < full; off += 64) compress(mid, W, prefix, off);
    var rest = prefix.subarray(full);
    var nonceLen = 4 + COUNTER_DIGITS;
    var msgLen = rest.length + nonceLen;
    var end = Math.ceil((msgLen + 9) / 64) * 64;
    var buf = new Uint8Array(end);
    buf.set(rest, 0);
    buf.set(asciiBytes(startPrefix() + '00000000'), rest.length);
    buf[msgLen] = 0x80;
    var bitLen = (prefix.length + nonceLen) * 8;          // < 2^32: one word is enough
    buf[end - 4] = bitLen >>> 24; buf[end - 3] = (bitLen >>> 16) & 255; buf[end - 2] = (bitLen >>> 8) & 255; buf[end - 1] = bitLen & 255;
    var cLast = msgLen - 1, cFirst = msgLen - COUNTER_DIGITS;
    var H = new Int32Array(8);
    var tries = 0;
    var started = Date.now();

    // '0'–'9' are 48–57, 'a'–'z' 97–122: base36 with a carry.
    function bump() {
      for (var i = cLast; i >= cFirst; i--) {
        var c = buf[i];
        if (c === 57) { buf[i] = 97; return true; }
        if (c !== 122) { buf[i] = c + 1; return true; }
        buf[i] = 48;
      }
      return false;   // all 36^8 tried
    }

    return new Promise(function (resolve, reject) {
      function slice() {
        if (opts.cancelled && opts.cancelled()) { reject(new PowError('cancelled', 'Cancelled.')); return; }
        var until = Date.now() + SLICE_MS;
        do {
          for (var k = 0; k < 1024; k++) {
            H.set(mid);
            for (var o = 0; o < end; o += 64) compress(H, W, buf, o);
            tries++;
            if (leadingZeroBits(H) >= bits) {
              resolve(String.fromCharCode.apply(null, buf.subarray(rest.length, msgLen)));
              return;
            }
            if (!bump()) { reject(new PowError('bad_input', 'The sign-up check ran out of tries.')); return; }
          }
        } while (Date.now() < until);
        if (opts.onProgress) { try { opts.onProgress(tries, Date.now() - started); } catch (e) { /* a display error never stops the search */ } }
        setTimeout(slice, 0);
      }
      slice();
    });
  }

  window.PlayPow = Object.freeze({ solve: solve, sha256hex: sha256hex, Error: PowError });
})();
