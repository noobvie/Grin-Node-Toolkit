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
const MAX_WORKER_NAME_LEN = 25;
const MAX_WORKER_RAW_LEN = 40;
function validateUsername(username) {
  if (!username || typeof username !== 'string') return null;
  const bech32 = '[ac-hj-np-z02-9]';
  const re = new RegExp(`^(grin1|tgrin1)(${bech32}{58})(\\.([a-z0-9_-]{1,${MAX_WORKER_RAW_LEN}}))?$`);
  const m = username.match(re);
  if (!m) return null;

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
  createJobNotification,
  createLoginResponse,
  createSubmitResponse,
  createJobTemplateResponse,
  createStatusResponse
};
