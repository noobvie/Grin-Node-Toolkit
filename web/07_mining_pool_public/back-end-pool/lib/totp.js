const crypto = require('crypto');

// Self-hosted TOTP (RFC 6238) — no external service, no npm dependency. Authenticator-app
// compatible (Google Authenticator, Aegis, FreeOTP, etc.): SHA-1, 6 digits, 30s period.
// Used for optional admin 2FA. Secrets are base32 (RFC 4648) so they paste into any app.

const B32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const PERIOD = 30;
const DIGITS = 6;

function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (let i = 0; i < buf.length; i++) {
    value = (value << 8) | buf[i];
    bits += 8;
    while (bits >= 5) {
      out += B32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(str) {
  const clean = String(str).toUpperCase().replace(/=+$/, '').replace(/\s+/g, '');
  let bits = 0, value = 0;
  const out = [];
  for (const ch of clean) {
    const idx = B32_ALPHABET.indexOf(ch);
    if (idx === -1) continue; // ignore stray separators
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

// New random base32 secret (20 bytes = 160 bits, the RFC-recommended size for SHA-1).
function generateSecret() {
  return base32Encode(crypto.randomBytes(20));
}

// One HOTP value for an explicit counter.
function hotp(secretBase32, counter) {
  const key = base32Decode(secretBase32);
  const buf = Buffer.alloc(8);
  // 64-bit big-endian counter (JS bitwise is 32-bit, so split hi/lo).
  buf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  buf.writeUInt32BE(counter >>> 0, 4);
  const hmac = crypto.createHmac('sha1', key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const bin = ((hmac[offset] & 0x7f) << 24) | (hmac[offset + 1] << 16) |
              (hmac[offset + 2] << 8) | (hmac[offset + 3]);
  return String(bin % (10 ** DIGITS)).padStart(DIGITS, '0');
}

// Verify a submitted code and return the time-step counter it matched, or -1 for no match.
// Tolerates ±`window` steps of clock drift (default ±1 = ±30s). Constant-ish-time compare
// on the digit strings.
//
// The counter is returned, not swallowed, because RFC 6238 §5.2 requires a verifier to refuse
// a SECOND use of the same OTP — being spent is the protocol's only defence against a code
// someone has observed (shoulder-surf, screenshot, phishing page). A caller cannot implement
// that against a boolean: it has to know WHICH step was accepted so it can store it and reject
// anything at or below it next time. See auth.js verifyTotpOrRecovery / users.totp_last_counter.
// Audit §J2-5.
function verifyCounter(secretBase32, token, window = 1) {
  if (!secretBase32 || !token) return -1;
  const clean = String(token).replace(/\s+/g, '');
  if (!/^\d{6}$/.test(clean)) return -1;
  const counter = Math.floor(Date.now() / 1000 / PERIOD);
  for (let w = -window; w <= window; w++) {
    const expected = hotp(secretBase32, counter + w);
    if (expected.length === clean.length &&
        crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(clean))) {
      return counter + w;
    }
  }
  return -1;
}

// Boolean form. Kept for callers that genuinely have no replay window to protect — today only
// enrollment confirmation, which is immediately followed by a counter stamp. A NEW code check
// should almost always use verifyCounter and enforce the replay rule.
function verify(secretBase32, token, window = 1) {
  return verifyCounter(secretBase32, token, window) >= 0;
}

// otpauth:// URI for the QR code / manual entry. label = account, issuer = pool name.
function keyuri(secretBase32, label, issuer) {
  const enc = encodeURIComponent;
  const lbl = issuer ? `${enc(issuer)}:${enc(label)}` : enc(label);
  const params = `secret=${secretBase32}&algorithm=SHA1&digits=${DIGITS}&period=${PERIOD}` +
                 (issuer ? `&issuer=${enc(issuer)}` : '');
  return `otpauth://totp/${lbl}?${params}`;
}

module.exports = { generateSecret, hotp, verify, verifyCounter, keyuri, base32Encode, base32Decode, PERIOD, DIGITS };
