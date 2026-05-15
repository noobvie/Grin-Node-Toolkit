function parseStratumMessage(jsonStr) {
  try {
    return JSON.parse(jsonStr);
  } catch (err) {
    return null;
  }
}

function validateUsername(username) {
  if (!username || typeof username !== 'string') return null;

  const grinAddressRegex = /^grin1[a-z0-9]{49,}$/;
  const withWorker = /^grin1[a-z0-9]{49,}\.[a-z0-9_-]+$/;

  if (grinAddressRegex.test(username) || withWorker.test(username)) {
    const parts = username.split('.');
    return {
      grin_address: parts[0],
      worker_name: parts[1] || 'default'
    };
  }

  return null;
}

function createSubscribeResponse(subscriptionId, extraNonce1, extraNonce2Size) {
  return {
    jsonrpc: '2.0',
    result: [
      [
        ['mining.notify', subscriptionId],
        ['mining.set_difficulty', subscriptionId]
      ],
      extraNonce1,
      extraNonce2Size
    ],
    id: null
  };
}

function createSetDifficultyNotification(subscriptionId, difficulty) {
  return {
    jsonrpc: '2.0',
    method: 'mining.set_difficulty',
    params: [difficulty],
    id: null
  };
}

function createNotifyNotification(subscriptionId, jobId, prevHash, coinbase1, coinbase2, merkleTree, blockVersion, blockBits, blockTime, cleanJobs) {
  return {
    jsonrpc: '2.0',
    method: 'mining.notify',
    params: [
      jobId,
      prevHash,
      coinbase1,
      coinbase2,
      merkleTree,
      blockVersion,
      blockBits,
      blockTime,
      cleanJobs
    ],
    id: null
  };
}

function createShareResponse(id, accepted, errorCode = null) {
  if (accepted) {
    return {
      jsonrpc: '2.0',
      result: true,
      id
    };
  } else {
    return {
      jsonrpc: '2.0',
      error: {
        code: errorCode || -1,
        message: 'Share rejected'
      },
      id
    };
  }
}

module.exports = {
  parseStratumMessage,
  validateUsername,
  createSubscribeResponse,
  createSetDifficultyNotification,
  createNotifyNotification,
  createShareResponse
};
