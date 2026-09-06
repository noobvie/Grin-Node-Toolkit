'use strict';

// ── Grin payment proof verifier — pure, no config, no node calls ─────────────
//
// Verifies the JSON file written by `grin-wallet export_proof`. Every layout
// fact below is from the "Payment proof — verified wire facts" subsection of
// docs/generated/script06_design.md, which was read field-by-field from
// mimblewimble/grin-wallet at v5.4.1 (the toolkit's pin) and re-checked at
// v5.5.0 and master. Do not "improve" a byte layout here without re-reading
// that subsection — a guessed layout produces a verifier that calls every
// honest proof invalid, which is worse than no tool.
//
// The file is the serde form of ONE struct (libwallet/src/api_impl/types.rs
// PaymentProof) — no wrapper, no envelope, no armor, and exactly six keys.
//
// The signed message is 73 bytes, one concatenation, NO hashing and NO domain
// separator (libwallet/src/internal/tx.rs payment_proof_message):
//
//     amount        u64 BIG-ENDIAN      8 bytes
//   ‖ excess        raw commitment     33 bytes
//   ‖ sender_pubkey raw ed25519        32 bytes
//
// Both signatures are over that SAME message: recipient_sig verifies under
// recipient_address, sender_sig under sender_address. ed25519 does its own
// SHA-512 internally — do NOT pre-hash.
//
// This module deliberately does NOT touch the chain. A signature check and a
// kernel lookup are two independent verdicts and the caller must be able to
// report which one failed; the chain half lives in the server route.
//
// THE BYTE LAYOUT IS CONFIRMED (R4, 2026-09-06 — design doc,
// "R4 — RESOLVED 2026-09-06"). It did NOT need a VPS. grin-wallet's Owner API
// rustdoc carries a complete real PaymentProof (api/src/owner_rpc.rs:1802-1836)
// whose response the surrounding doctest macro asserts byte-for-byte in CI, so
// it is the output of the very serde impls tabulated above. Running it through
// this file unmodified verifies BOTH signatures, and the check is cryptographic
// rather than textual: a wrong offset, width or endianness would change the
// 73-byte message and both ed25519 verifies would fail. That fixture and R4's
// eight-row negative-control table now ship as ../test/fixtures/payment-proof-*
// and ../test/test-payment-proof.js — run them, don't re-derive them.
//
// STILL UNCONFIRMED (bounded, and no longer ship-blocking):
//   1. grin-wallet calls ed25519-dalek's NON-STRICT `verify` (pin
//      `ed25519-dalek = "1.0.0-pre.4"`, libwallet/Cargo.toml:26); whether that
//      and Node's OpenSSL-backed crypto.verify agree on adversarial edge cases
//      (small-order / non-canonical public keys, non-canonical S) is still
//      unknown, and settling it needs a Rust toolchain, not a VPS. The
//      DIRECTION is known: Node returns a clean ok:false on the four canonical
//      small-order / non-canonical encodings (no throw, no 500), and dalek's
//      non-strict path is the more permissive of the two — so a disagreement
//      can only make this tool STRICTER than grin-wallet, on a CRAFTED file,
//      and it fails CLOSED. Honest proofs are unaffected. Genuinely open.
//   2. No NON-grin-wallet implementation has been consulted, and no proof
//      exported from an operator's own wallet has been read. Neither is a
//      correctness gate any more — the first is an interop unknown, the second
//      an ergonomics check (that `export_proof` output pastes into the page
//      cleanly). Worth doing once on the VPS; not a reason to hold /proof.
//
// Reuse: bech32 comes from ../public/js/slatepack-decode.js (it exports a
// CommonJS api when required), so there is no second bech32 in this repo.
//
// PRIVACY: nothing in this file logs, and nothing may be added that does. A
// payment proof names both parties and an amount.

const crypto = require('crypto');
const SPD    = require('../public/js/slatepack-decode.js');

const { bech32Decode, wordsToBytes, formatGrin } = SPD._internal;

// Wire constants — all three are read back as fixed-size arrays by
// _decode_payment_proof_message (tx.rs:465-484), so none of them is inferred.
const EXCESS_BYTES  = 33;
const PUBKEY_BYTES  = 32;
const SIG_BYTES     = 64;
const MESSAGE_BYTES = 8 + EXCESS_BYTES + PUBKEY_BYTES;   // 73
const U64_MAX       = (1n << 64n) - 1n;

// SubjectPublicKeyInfo DER header for id-Ed25519 (RFC 8410). Fixed prefix +
// the raw 32-byte key is a complete SPKI, which is the only form
// crypto.createPublicKey accepts for an ed25519 public key.
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

// The six keys, in struct order (types.rs:310-331). There is no version field,
// no timestamp, no tx UUID and no fee.
const PROOF_KEYS = ['amount', 'excess', 'recipient_address', 'recipient_sig',
                    'sender_address', 'sender_sig'];

class ProofError extends Error {
  constructor(code, message) { super(message); this.name = 'ProofError'; this.code = code; }
}

// ── Input parsing ────────────────────────────────────────────────────────────

// `amount` is serialised by grin's string_or_u64 as a decimal STRING, but it
// DESERIALISES from a string or a bare number (secp_ser.rs:275-299) — so a
// hand-edited or third-party file may carry either, and both must be accepted.
//
// A bare number is the trap: u64 nanogrin passes 2^53 above ~9M GRIN and
// JSON.parse would silently round it, exactly as the PoW nonce does elsewhere
// in this app. So quote it in the RAW TEXT first, then parse, then BigInt.
const AMOUNT_BARE_RE  = /("amount"\s*:\s*)(\d+)(?=\s*[,}])/;
const AMOUNT_FLOAT_RE = /"amount"\s*:\s*\d+\s*\./;

function parseProofText(text) {
  if (typeof text !== 'string' || !text.trim()) {
    throw new ProofError('empty', 'No proof supplied.');
  }
  if (AMOUNT_FLOAT_RE.test(text)) {
    throw new ProofError('bad_amount', 'amount must be a whole number of nanogrin, not a decimal.');
  }
  let obj;
  try {
    obj = JSON.parse(text.replace(AMOUNT_BARE_RE, '$1"$2"'));
  } catch {
    throw new ProofError('bad_json', 'That is not valid JSON. Export it with: grin-wallet export_proof');
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new ProofError('bad_json', 'Expected a JSON object with six keys.');
  }
  const missing = PROOF_KEYS.filter(k => obj[k] === undefined || obj[k] === null);
  if (missing.length) {
    throw new ProofError('missing_keys', 'Not a payment proof — missing: ' + missing.join(', '));
  }
  return obj;
}

function parseAmount(raw) {
  const s = typeof raw === 'string' ? raw.trim() : String(raw);
  if (!/^\d+$/.test(s)) throw new ProofError('bad_amount', 'amount must be a decimal number of nanogrin.');
  const v = BigInt(s);
  if (v > U64_MAX) throw new ProofError('bad_amount', 'amount exceeds u64.');
  return v;
}

function parseHex(raw, bytes, field) {
  if (typeof raw !== 'string' || !/^[0-9a-fA-F]*$/.test(raw.trim())) {
    throw new ProofError('bad_hex', field + ' must be hex.');
  }
  const hex = raw.trim().toLowerCase();
  if (hex.length !== bytes * 2) {
    throw new ProofError('bad_hex',
      field + ' must be ' + bytes + ' bytes (' + (bytes * 2) + ' hex characters), got ' + hex.length + '.');
  }
  return Buffer.from(hex, 'hex');
}

// A Slatepack address IS a 32-byte ed25519 public key in bech32
// (libwallet/src/slatepack/address.rs). The HRP is kept verbatim rather than
// mapped to a boolean: it is a CLAIM about the network, not evidence — see
// networkClaim() below.
function parseAddress(raw, field) {
  if (typeof raw !== 'string') throw new ProofError('bad_address', field + ' must be a string.');
  const dec = bech32Decode(raw.trim());
  if (!dec) throw new ProofError('bad_address', field + ' is not a valid bech32 address (checksum failed).');
  const key = wordsToBytes(dec.words);
  if (!key || key.length !== PUBKEY_BYTES) {
    throw new ProofError('bad_address', field + ' does not hold a ' + PUBKEY_BYTES + '-byte key.');
  }
  return { hrp: dec.hrp, pubkey: Buffer.from(key), text: raw.trim() };
}

// grin-wallet's TryFrom<&str> accepts WHATEVER HRP it is handed (address.rs:86)
// and neither signature covers it — the message carries the raw 32-byte key.
// So this is what the file claims, and nothing more.
function networkClaim(hrp) {
  if (hrp === 'grin')  return 'mainnet';
  if (hrp === 'tgrin') return 'testnet';
  return 'unknown';
}

// ── The signed message ───────────────────────────────────────────────────────

function paymentProofMessage(amount, excess33, senderPubkey32) {
  const msg = Buffer.alloc(MESSAGE_BYTES);
  msg.writeBigUInt64BE(amount, 0);                 // u64 BIG-endian, 8 bytes
  excess33.copy(msg, 8);                           // commitment as stored, 33
  senderPubkey32.copy(msg, 8 + EXCESS_BYTES);      // raw ed25519 key, 32
  return msg;
}

// ── ed25519 ──────────────────────────────────────────────────────────────────

// Returns {ok, reason}. OpenSSL rejects a non-canonical point at import on some
// builds and at verify on others, so BOTH are caught: a bad key is a failed
// check, never a 500.
function ed25519Verify(pubkey32, message, sig64) {
  let key;
  try {
    key = crypto.createPublicKey({
      key: Buffer.concat([SPKI_PREFIX, pubkey32]), format: 'der', type: 'spki',
    });
  } catch {
    return { ok: false, reason: 'key_rejected' };
  }
  try {
    return { ok: crypto.verify(null, message, key, sig64) === true, reason: null };
  } catch {
    return { ok: false, reason: 'signature_rejected' };
  }
}

// ── Public entry point ───────────────────────────────────────────────────────

// Verifies both signatures and returns a structured result. Throws ProofError
// (with .code) for input the format cannot hold at all; a well-formed proof
// whose signatures do not verify is a RESULT, not an exception.
//
// Verification order follows grin-wallet's verify_payment_proof
// (owner.rs:1191-1257) for the two signature steps: recipient first, then
// sender. grin-wallet checks the chain BEFORE either; we deliberately do it
// after, in the caller, so the page can name which half failed. Its step 5
// (is either address mine?) needs a wallet and is simply omitted.
function verifyPaymentProof(input) {
  const obj = typeof input === 'string' ? parseProofText(input) : parseProofText(JSON.stringify(input));

  const amount    = parseAmount(obj.amount);
  const excess    = parseHex(obj.excess, EXCESS_BYTES, 'excess');
  const recipient = parseAddress(obj.recipient_address, 'recipient_address');
  const sender    = parseAddress(obj.sender_address, 'sender_address');
  const recipSig  = parseHex(obj.recipient_sig, SIG_BYTES, 'recipient_sig');
  const sendSig   = parseHex(obj.sender_sig,    SIG_BYTES, 'sender_sig');

  const message = paymentProofMessage(amount, excess, sender.pubkey);

  const recipientCheck = ed25519Verify(recipient.pubkey, message, recipSig);
  const senderCheck    = ed25519Verify(sender.pubkey,    message, sendSig);

  return {
    proof: {
      amount_nano:   amount.toString(),          // string: JSON cannot hold u64
      amount_grin:   formatGrin(amount),
      excess:        excess.toString('hex'),
      sender_address:    sender.text,
      recipient_address: recipient.text,
      sender_hrp:        sender.hrp,
      recipient_hrp:     recipient.hrp,
      network_claim:     networkClaim(sender.hrp),
      network_claim_recipient: networkClaim(recipient.hrp),
    },
    message_hex: message.toString('hex'),
    checks: {
      recipient_sig: recipientCheck,
      sender_sig:    senderCheck,
    },
    // Surfaced, never hidden: both checks use the same message, so ONE key
    // signing twice satisfies both. That is a self-attestation, not a payment.
    self_payment: sender.pubkey.equals(recipient.pubkey),
    // The two HRPs disagreeing means the file was assembled by hand — neither
    // signature covers the HRP, so this cannot be caught by the maths.
    hrp_mismatch: sender.hrp !== recipient.hrp,
  };
}

module.exports = {
  ProofError, PROOF_KEYS,
  EXCESS_BYTES, PUBKEY_BYTES, SIG_BYTES, MESSAGE_BYTES,
  parseProofText, parseAmount, parseHex, parseAddress, networkClaim,
  paymentProofMessage, ed25519Verify, verifyPaymentProof,
};
