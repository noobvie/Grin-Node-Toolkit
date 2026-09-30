'use strict';

// The pool's public address mask, copied exactly (back-end-pool/index.js maskAddr): 9
// leading characters, an ellipsis, 4 trailing. D19: names in v1 are this mask only, and
// the pool's invariant carries over — no PUBLIC LIST ever emits a full address.
//
// A mask is not an identity: matching another address's 9…4 takes ~2^40 key generations
// (§19.13 #10). Nothing may treat two equal masks as the same player.

function maskAddr(a) {
  const s = String(a || '');
  return s.length > 16 ? `${s.slice(0, 9)}…${s.slice(-4)}` : s;
}

module.exports = { maskAddr };
