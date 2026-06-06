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

// Validate a Grin address with optional .worker_name suffix.
// Bech32 charset excludes b, i, o, 1 → [ac-hj-np-z02-9]
// Mainnet: grin1 + 54 bech32 chars = 59 chars total
// Testnet: tgrin1 + 54 bech32 chars = 60 chars total
function validateUsername(username) {
  if (!username || typeof username !== 'string') return null;
  const bech32 = '[ac-hj-np-z02-9]';
  const re = new RegExp(`^(grin1|tgrin1)(${bech32}{54})(\\.([a-z0-9_-]{1,32}))?$`);
  const m = username.match(re);
  if (!m) return null;
  return {
    grin_address: m[1] + m[2],
    worker_name: m[4] || 'default'
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
