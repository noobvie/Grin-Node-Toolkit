'use strict';

// Grin stratum protocol message builders.
// Reference: https://github.com/mimblewimble/grin/blob/master/doc/stratum.md
// Messages are newline-delimited JSON over a plain TCP socket.
// Protocol methods used:
//   client → server: login, submit, getjobtemplate, status
//   server → client: job (push), and responses to the above

function parseStratumMessage(jsonStr) {
  try {
    const msg = JSON.parse(jsonStr.trim());
    // u64 nonce guard: JSON.parse rounds integers past 2^53, so a miner's nonce like
    // 17293822569102704642 silently becomes …640 — the node then rejects the share as
    // "Invalid PoW" (its log shows nonces ending in zeros). Re-extract the literal
    // digits and carry the nonce as a STRING; NodeStratumClient.send() re-emits it as
    // a bare number on the node's wire.
    if (msg && msg.params && msg.params.nonce !== undefined) {
      const m = jsonStr.match(/"nonce"\s*:\s*(\d+)/);
      if (m) msg.params.nonce = m[1];
    }
    return msg;
  } catch {
    return null;
  }
}

// Validate a Grin address with optional .worker_name suffix and optional donation token.
// Bech32 charset excludes b, i, o, 1 → [ac-hj-np-z02-9]
// A Grin Slatepack address is the bech32 encoding of a 32-byte ed25519 key:
// 52 data symbols + 6 checksum symbols = 58 bech32 chars after the prefix.
// Mainnet: grin1 + 58 bech32 chars = 63 chars total
// Testnet: tgrin1 + 58 bech32 chars = 64 chars total
//
// Donation (register-free, self-service): a `donateN` token in the worker name opts the miner
// into donating N% of their PPLNS payouts to the pool prize pool. It can be the whole worker
// name or a `-`/`_`-separated suffix. The `+` form is deliberately NOT used — some miners read
// a `+NNNN` username suffix as a fixed-difficulty request.
//   grin1abc….donate10      → worker "default", donate 10%
//   grin1abc….rig01-donate10 → worker "rig01",  donate 10%
//   grin1abc….rig01          → worker "rig01",  no donation
// Edge handling: only N in 0-100 donates (donate0 = explicit opt-out). Anything else is
// treated as NOT a donation and kept as a literal worker name — a typo like `donate101`,
// `donate999`, `donate-1`, `donatexx`, or `donate` alone never causes an accidental donation.
//
// Worker label length — accept-and-shorten, never reject a realistic login:
//   · The *visible* label is capped at MAX_WORKER_NAME_LEN and a longer label is TRUNCATED from
//     the left (slice(0,N)), not rejected — a miner with a long rig name still connects and just
//     shows a tidy shortened label in public stats.
//   · MAX_WORKER_RAW_LEN is the raw accept ceiling (label + any donate token). It exists ONLY to
//     refuse pathological/abuse input; it sits well above a full 25-char label + the longest
//     `-donate100` token (35), so no real miner is ever rejected for length.
//
// Why we DON'T just cut the raw suffix to N from the left before parsing: the donateN token
// lives at the END of the name, so a left-cut would silently corrupt it — `…rig-donate100`
// clipped to `…rig-donate10` would donate 10% instead of 100%, or drop the donation entirely.
// So the token is parsed and stripped FIRST (from the full suffix), and only the leftover
// *label* is truncated — the donation % is always honored no matter how long the raw name was.
// ── bech32 checksum (BIP-173) ───────────────────────────────────────────────────────────
// A Grin Slatepack address is `bech32::encode(hrp, ed25519_pubkey.to_base32())` — the CLASSIC
// bech32 variant (checksum constant 1), not bech32m: grin-wallet pins the `bech32` 0.7 crate,
// which predates the variant split. So the last 6 symbols of every address are a checksum over
// the other 52, and verifying it is the difference between "looks like an address" and "is one".
//
// Why this is here at all (audit §J6-6): validateUsername used to check the bech32 CHARSET and
// the length and stop. Any 58 charset-valid characters were therefore a working stratum login,
// which (a) gave an anonymous client an unbounded supply of distinct addresses, each of which
// took a miner_accounts row plus three synchronous statements on the shared DB at login, and
// (b) silently accepted a miner who fat-fingered one character of their own address and then
// accrued a balance to a key nobody holds. The checksum catches exactly (b) — that is what it
// was designed for — and puts a real cost on (a).
const BECH32_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

function bech32Polymod(values) {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const top = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) {
      if ((top >> i) & 1) chk ^= GEN[i];
    }
  }
  return chk >>> 0;
}

// hrp expansion per BIP-173: high bits, a 0 separator, then low bits.
function bech32HrpExpand(hrp) {
  const out = [];
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) >> 5);
  out.push(0);
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) & 31);
  return out;
}

// Verify the 6-symbol checksum of `data` (the part AFTER the '1' separator) against `hrp`.
// Lowercase only — grin never emits an uppercase address and mixed case is invalid bech32.
function bech32ChecksumValid(hrp, data) {
  if (typeof hrp !== 'string' || typeof data !== 'string') return false;
  if (data.length < 6) return false;
  const values = [];
  for (const ch of data) {
    const v = BECH32_CHARSET.indexOf(ch);
    if (v < 0) return false;              // outside the charset (the regex already refuses these)
    values.push(v);
  }
  return bech32Polymod(bech32HrpExpand(hrp).concat(values)) === 1;
}

const MAX_WORKER_NAME_LEN = 25;
const MAX_WORKER_RAW_LEN = 40;
// `network` — 'mainnet' | 'testnet'. When given, ONLY that chain's prefix is accepted.
//
// Why it must be given (audit §J17-4): a Slatepack address is bech32(hrp, ed25519_pubkey), and
// the SAME 32-byte key encodes to two different, fully-valid, checksum-correct strings depending
// on whether the hrp is `grin` or `tgrin`. Accepting both meant one miner could hold TWO
// miner_accounts rows — two balances, each measured separately against min_withdrawal, two
// ownership proofs, no way for the product to show they are the same key — and a MAINNET pool
// would credit real GRIN to a `tgrin1…` account and then hand it to `grin-wallet send -d`,
// which is chain-aware and refuses it. The result is a stuck payout on a balance the miner
// cannot move.
//
// §J6-6 added the checksum verification that closed the charset hole; it could not close this
// one, because the checksum is computed OVER the hrp — the two spellings are not each other's
// typo, they are two correct encodings. Only the pool's own network settles which is right.
//
// The parameter is optional so the BIP-173 vector tests can exercise the encoding alone, but
// every production call site passes it. It is checked BEFORE the checksum so a wrong-network
// address is rejected on identity, not on a technicality.
function validateUsername(username, network = null) {
  if (!username || typeof username !== 'string') return null;
  const bech32 = '[ac-hj-np-z02-9]';
  const re = new RegExp(`^(grin1|tgrin1)(${bech32}{58})(\\.([a-z0-9_-]{1,${MAX_WORKER_RAW_LEN}}))?$`);
  const m = username.match(re);
  if (!m) return null;

  if (network) {
    const want = network === 'mainnet' ? 'grin1' : 'tgrin1';
    if (m[1] !== want) return null;
  }

  // Charset + length are not identity — verify the checksum those last 6 symbols ARE (§J6-6).
  // m[1] is the prefix INCLUDING the '1' separator, so the hrp is it minus the last character.
  if (!bech32ChecksumValid(m[1].slice(0, -1), m[2])) return null;

  let worker_name = m[4] || 'default';
  let donation_percent = null;

  // Extract a `donateN` token: whole worker name, or a `-`/`_`-separated suffix.
  // Only apply it when N is a sane percentage (0-100); out-of-range is a typo, so we leave
  // the worker name untouched and donate nothing.
  const dm = worker_name.match(/^(?:(.*?)[-_])?donate(\d{1,3})$/);
  if (dm) {
    const n = parseInt(dm[2], 10);
    if (n >= 0 && n <= 100) {
      donation_percent = n;
      worker_name = dm[1] || 'default'; // strip the token from the visible worker name
    }
  }

  // Cap the visible label: truncate (don't reject) anything over the limit.
  if (worker_name.length > MAX_WORKER_NAME_LEN) {
    worker_name = worker_name.slice(0, MAX_WORKER_NAME_LEN);
  }

  return {
    grin_address: m[1] + m[2],
    worker_name,
    donation_percent
  };
}

// Server → all miners: push a new job when the node finds a new block height.
// Miners must use the returned job_id in their submit.
function createJobNotification(jobId, height, difficulty, prePow) {
  return {
    id: 'Stratum',
    jsonrpc: '2.0',
    method: 'job',
    params: { difficulty, height, job_id: jobId, pre_pow: prePow }
  };
}

// Server → miner: response to "login"
function createLoginResponse(id, error = null) {
  return {
    id,
    jsonrpc: '2.0',
    method: 'login',
    result: error ? null : 'ok',
    error
  };
}

// Server → miner: response to "submit"
// blockHash is non-null when the submission solved a full block.
function createSubmitResponse(id, accepted, blockHash = null, error = null) {
  return {
    id,
    jsonrpc: '2.0',
    method: 'submit',
    result: accepted ? (blockHash ? `blockfound - ${blockHash}` : 'ok') : null,
    error: accepted ? null : { code: -1, message: error || 'Share rejected' }
  };
}

// Server → miner: response to "getjobtemplate"
// NOTE: the `method` field is REQUIRED. The Grin stratum convention (and the
// grin node's own stratum server) echoes the request method back in the
// response, and grin-miner's RpcResponse struct makes `method` non-optional AND
// routes on it (match res.method => "getjobtemplate"). Omitting it makes the
// response unparseable to grin-miner ("Error parsing response") even though the
// job still arrives via the `job` notification. Keep parity with createLogin/
// SubmitResponse, which already include it.
function createJobTemplateResponse(id, jobId, height, difficulty, prePow) {
  return {
    id,
    jsonrpc: '2.0',
    method: 'getjobtemplate',
    result: { difficulty, height, job_id: jobId, pre_pow: prePow },
    error: null
  };
}

// Server → miner: response to "status"
// sessionStats = { sessionId, height, difficulty, accepted, rejected, stale }
function createStatusResponse(id, sessionStats) {
  return {
    id,
    jsonrpc: '2.0',
    method: 'status',  // required — grin-miner routes responses on `method` (see createJobTemplateResponse)
    result: {
      id:         sessionStats.sessionId,
      height:     sessionStats.height,
      difficulty: sessionStats.difficulty,
      accepted:   sessionStats.accepted,
      rejected:   sessionStats.rejected,
      stale:      sessionStats.stale
    },
    error: null
  };
}

module.exports = {
  parseStratumMessage,
  validateUsername,
  bech32ChecksumValid,   // exported for scripts/test-stratum-guards.js (BIP-173 vectors)
  createJobNotification,
  createLoginResponse,
  createSubmitResponse,
  createJobTemplateResponse,
  createStatusResponse
};
