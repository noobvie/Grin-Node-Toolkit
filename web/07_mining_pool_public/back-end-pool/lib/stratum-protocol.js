'use strict';

// Grin stratum protocol message builders.
// Reference: https://github.com/mimblewimble/grin/blob/master/doc/stratum.md
// Messages are newline-delimited JSON over a plain TCP socket.
// Protocol methods used:
//   client → server: login, submit, getjobtemplate, status
//   server → client: job (push), and responses to the above

function parseStratumMessage(jsonStr) {
  try {
    return JSON.parse(jsonStr.trim());
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
// Worker label length: the *visible* label is capped at MAX_WORKER_NAME_LEN chars. A longer
// label is silently TRUNCATED (not rejected) so a miner with a long rig name still connects —
// the cap just keeps the public stats tidy and limits junk/abuse. The regex's own bound is a
// looser anti-abuse guard on raw input size; the donateN token is parsed before truncation so
// `…rig01verylong-donate10` still donates and shows a 10-char label.
const MAX_WORKER_NAME_LEN = 10;
function validateUsername(username) {
  if (!username || typeof username !== 'string') return null;
  const bech32 = '[ac-hj-np-z02-9]';
  const re = new RegExp(`^(grin1|tgrin1)(${bech32}{58})(\\.([a-z0-9_-]{1,64}))?$`);
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
function createJobTemplateResponse(id, jobId, height, difficulty, prePow) {
  return {
    id,
    jsonrpc: '2.0',
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
