'use strict';

// ─── "Is the block we stored the block the chain has at this height?" ────────────────
//
// ONE comparator, used by BOTH readers:
//   · rewards.js          — the pre-credit re-verification (fails closed: refuses to credit)
//   · orphan-detector.js  — the maturity/orphan decision (fails DESTRUCTIVE: orphans the
//                           block and reverses every miner's credit for it)
//
// They used to carry two different comparisons — `String(a) !== String(b)` in one and a bare
// `===` in the other — and only one of them was destructive on a false mismatch. Audit §J5-3.
// Never re-implement this inline; add to it here.
//
// ── Why the nonce cannot be compared exactly ───────────────────────────────────────────
// grin-node.js reads the node's reply with `response.json()`, i.e. JSON.parse, which rounds
// any integer past 2^53 to the nearest double. A Grin nonce is a full-width random u64
// (grin-miner draws `rand::OsRng…gen()` per attempt), so ~99.95% of them arrive ALREADY
// LOSSY — whatever we stored, and however correctly we stored it. The only comparison that
// can succeed is one that pushes BOTH sides through the SAME rounding. `Number(a) ===
// Number(b)` below therefore looks exactly like the precision bug it is preventing: that is
// deliberate, and it is why the hash is preferred whenever both sides can supply one.
//
// ── Why the hash is the real answer ────────────────────────────────────────────────────
// `blocks.hash` is a 64-hex string end to end and never passes through a JS number: grin's
// stratum answers `blockfound - <hash>` and node-stratum-client takes the tail verbatim,
// the column is TEXT, and `get_header(h).hash` is the same hex. When both sides look like a
// block hash, that comparison is authoritative and the nonce is not consulted at all.

const HASH_RE = /^[0-9a-f]{64}$/i;

// A value that has the shape of a Grin block hash. Anything else means "we cannot compare
// hashes here", NOT "the hashes differ" — the distinction is the whole point of `unknown`.
function isBlockHash(v) {
  return HASH_RE.test(String(v === null || v === undefined ? '' : v));
}

// Normalise a nonce to the lossy double both sides are forced through (see above).
// Returns null when the value cannot be a nonce at all — blank, non-numeric, or the empty
// string the §J5-1 migration writes for a legacy row whose nonce was destroyed by REAL
// storage before it could ever be read. null ⇒ "unknown", never "mismatch".
function nonceKey(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  // Decimal digits, optionally with a pure-zero fraction. No hex, no exponent form: an
  // exponent rendering ('9.22e+18') has already lost digits and would compare unequal to the
  // node's own rounding of the same value — worse than useless, since the caller's mismatch
  // branch is destructive.
  //
  // The `.0` tail is not hypothetical: node:sqlite binds every JS number as a double, so a
  // caller that passes a NUMBER rather than String(nonce) lands '12345.0' in this TEXT column.
  // creditBlock() binds a string, but nothing stops a test fixture, a migration or a future
  // call site from binding a number, and rejecting the value there would fail closed on a
  // block that is perfectly fine.
  if (!/^\d+(\.0+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * Compare a stored `blocks` row against a node `get_header()` result.
 *
 * @returns {{verdict:'match'|'mismatch'|'unknown', by:'hash'|'nonce'|null, detail:string}}
 *
 * Contract every caller must honour:
 *   match     — the chain carries our block at this height.
 *   mismatch  — the chain carries a DIFFERENT block at this height. This is the only verdict
 *               that may orphan a block or block a payout.
 *   unknown   — we could not compare. MUST be treated as "try again later", never as a
 *               mismatch. An unknown that condemns a block is exactly the failure §J5-2 and
 *               the original message-matching bug were both about.
 */
function compareBlockToHeader(block, header) {
  if (!header || typeof header !== 'object') {
    return { verdict: 'unknown', by: null, detail: 'no header returned by the node' };
  }

  // 1. Hash — authoritative when both sides can supply one.
  if (isBlockHash(block && block.hash) && isBlockHash(header.hash)) {
    const ours = String(block.hash).toLowerCase();
    const theirs = String(header.hash).toLowerCase();
    return ours === theirs
      ? { verdict: 'match', by: 'hash', detail: `hash ${ours}` }
      : { verdict: 'mismatch', by: 'hash', detail: `DB hash ${ours}, node hash ${theirs}` };
  }

  // 2. Nonce — the fallback, and only ever an approximate one.
  const ourN = nonceKey(block && block.nonce);
  const theirN = nonceKey(header.nonce);
  if (ourN === null || theirN === null) {
    return {
      verdict: 'unknown',
      by: null,
      detail:
        `neither side is comparable — DB hash ${JSON.stringify(block && block.hash)} / ` +
        `nonce ${JSON.stringify(block && block.nonce)}, node hash ${JSON.stringify(header.hash)} / ` +
        `nonce ${JSON.stringify(header.nonce)}`,
    };
  }
  return ourN === theirN
    ? { verdict: 'match', by: 'nonce', detail: `nonce ~${ourN} (hash not comparable)` }
    : { verdict: 'mismatch', by: 'nonce', detail: `DB nonce ~${ourN}, node nonce ~${theirN}` };
}

module.exports = { compareBlockToHeader, isBlockHash, nonceKey, HASH_RE };
