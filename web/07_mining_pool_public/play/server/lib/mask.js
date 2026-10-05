'use strict';

// The pool's public address mask, copied exactly (back-end-pool/index.js maskAddr): 9
// leading characters, an ellipsis, 4 trailing. D19: names in v1 are this mask only, and
// the pool's invariant carries over — no PUBLIC LIST ever emits a full address.
//
// A mask is not an identity: matching another address's 9…4 takes ~2^40 key generations
// (§19.13 #10). Nothing may treat two equal masks as the same player.
//
// Guests (§19.17.3, Part C5) are not addresses: their id is 'g:' + 16 base32 characters, and
// the pool's 9…4 mask would print 13 of those 18 characters. A guest's mask is instead
// `Guest-XXXX` — four base32 characters of sha256(id), so it says nothing about the id. It is
// a label, not an identity: 20 bits collide among a few thousand guests, and nothing may
// treat two equal tags as the same guest. The pool never sees a guest (D32), so this branch
// has no pool copy to stay in step with.

const crypto = require('node:crypto');

const GUEST_ID_RE = /^g:[a-z2-7]{16}$/;
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

const isGuestId = (a) => typeof a === 'string' && GUEST_ID_RE.test(a);

function guestTag(id) {
  const h = crypto.createHash('sha256').update(String(id), 'utf8').digest();
  // 20 bits = four 5-bit groups from the first three bytes.
  const n = (h[0] << 12) | (h[1] << 4) | (h[2] >> 4);
  let s = '';
  for (let i = 3; i >= 0; i--) s += B32[(n >> (i * 5)) & 31];
  return `Guest-${s}`;
}

function maskAddr(a) {
  if (isGuestId(a)) return guestTag(a);
  const s = String(a || '');
  return s.length > 16 ? `${s.slice(0, 9)}…${s.slice(-4)}` : s;
}

// A player in an ADMIN route's path or query: a pool address of this network, or a guest.
// A path segment cannot carry ':' (http.js PARAM_RE, and the pool's admin proxy refuses it
// before forwarding), so a guest travels as 'g.<16>' in a URL and is turned back into its id
// here; 'g:<16>' is accepted where the transport allows it (a query string). → the id, or null.
const GUEST_URL_RE = /^g[.:]([a-z2-7]{16})$/;
const POOL_ADDR_RE = /^t?grin1[ac-hj-np-z02-9]{58}$/;   // pool-link.js GRIN_ADDR_RE
function playerParam(v, prefix) {
  if (typeof v !== 'string') return null;
  const g = GUEST_URL_RE.exec(v);
  if (g) return `g:${g[1]}`;
  return POOL_ADDR_RE.test(v) && v.startsWith(prefix) ? v : null;
}

module.exports = { maskAddr, guestTag, isGuestId, playerParam, GUEST_ID_RE };
