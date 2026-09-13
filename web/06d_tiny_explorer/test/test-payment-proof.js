// Payment-proof regression tests — R4's real-wallet fixture + its eight-row
// negative-control table, made re-runnable.
//
// WHY THIS FILE EXISTS. Every byte-layout fact in lib/payment-proof.js was read
// out of grin-wallet source, and R4 settled the standing #1 risk of the /proof
// tool — "a shared misreading is uncatchable" — against a proof that
// grin-wallet's own CI asserts byte-for-byte (api/src/owner_rpc.rs:1802-1836).
// That check ran once, in a throwaway harness, and its result then lived only in
// a document. A regression in the 73-byte message would have been silent.
//
// The check is CRYPTOGRAPHIC, not textual: the message is an input to signature
// verification, so a wrong offset, width or endianness changes it and both
// ed25519 verifies fail. A test that cannot fail proves nothing, hence the
// mutations below — each touches ONE field and leaves everything else alone.
//
// No test framework and no devDependency: 06d has exactly ONE npm dependency
// (express) and keeps it. Run: node test/test-payment-proof.js
'use strict';

const assert = require('node:assert');
const path   = require('node:path');
const fs     = require('node:fs');

const APP = path.resolve(__dirname, '..');
const pp  = require(path.join(APP, 'lib/payment-proof.js'));

const FIXTURE_PATH = path.join(__dirname, 'fixtures/payment-proof-real.json');
const FIXTURE = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));

let pass = 0, fail = 0;
const ok = (name, fn) => {
  try { fn(); pass++; console.log('  PASS  ' + name); }
  catch (e) { fail++; console.log('  FAIL  ' + name + '\n        ' + (e && e.message)); }
};

const clone = () => JSON.parse(JSON.stringify(FIXTURE));
const marks = (proof) => {
  const r = pp.verifyPaymentProof(proof);
  return { R: r.checks.recipient_sig.ok, S: r.checks.sender_sig.ok, full: r };
};
// Low bit, not a random byte: it keeps an ed25519 S canonical, so the row proves
// a WRONG signature is rejected rather than a malformed one.
const flipLowBit = (hex) => {
  const b = Buffer.from(hex, 'hex');
  b[b.length - 1] ^= 0x01;
  return b.toString('hex');
};

// ── bech32 encoder, test-side only ───────────────────────────────────────────
// Row 6 re-labels the network, which means re-encoding the address under a new
// HRP — a string replace would break the checksum and the row would then prove
// the checksum works, not that the HRP is unsigned. Classic bech32 (checksum
// constant 1), matching lib/wallet-tor.js's decoder.
const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
function polymod(values) {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const b = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((b >>> i) & 1) chk ^= GEN[i];
  }
  return chk >>> 0;
}
function hrpExpand(hrp) {
  const out = [];
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) >> 5);
  out.push(0);
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) & 31);
  return out;
}
function bytesTo5bit(buf) {
  let acc = 0, bits = 0;
  const out = [];
  for (const b of buf) {
    acc = ((acc << 8) | b) & 0xffff;
    bits += 8;
    while (bits >= 5) { bits -= 5; out.push((acc >>> bits) & 31); }
  }
  if (bits > 0) out.push((acc << (5 - bits)) & 31);
  return out;
}
function bech32Encode(hrp, buf) {
  const data = bytesTo5bit(buf);
  const chk  = polymod(hrpExpand(hrp).concat(data, [0, 0, 0, 0, 0, 0])) ^ 1;
  const sum  = [];
  for (let i = 0; i < 6; i++) sum.push((chk >> (5 * (5 - i))) & 31);
  return hrp + '1' + data.concat(sum).map(d => CHARSET[d]).join('');
}
function reHrp(address, newHrp) {
  return bech32Encode(newHrp, pp.parseAddress(address, 'x').pubkey);
}

console.log('\n[1] lib/payment-proof.js — R4 fixture + negative controls');
console.log('      fixture: ' + path.relative(APP, FIXTURE_PATH).replace(/\\/g, '/'));

ok('fixture holds exactly the six PROOF_KEYS, no more', () => {
  assert.deepStrictEqual(Object.keys(FIXTURE).sort(), [...pp.PROOF_KEYS].sort());
});

ok('row 1 — baseline: BOTH signatures verify (R:ok S:ok)', () => {
  const m = marks(FIXTURE);
  assert.strictEqual(m.R, true, 'recipient_sig did not verify');
  assert.strictEqual(m.S, true, 'sender_sig did not verify');
});

ok('baseline — 60 GRIN, 33-byte excess, 73-byte message', () => {
  const { full } = marks(FIXTURE);
  assert.strictEqual(full.proof.amount_nano, '60000000000');
  assert.strictEqual(full.proof.amount_grin, '60');
  assert.strictEqual(full.proof.excess.length / 2, pp.EXCESS_BYTES);
  assert.strictEqual(full.message_hex.length / 2, pp.MESSAGE_BYTES);
  assert.strictEqual(pp.MESSAGE_BYTES, 73);
});

ok('baseline — message is amount(8 BE) + excess(33) + SENDER pubkey(32)', () => {
  const { full } = marks(FIXTURE);
  const msg = Buffer.from(full.message_hex, 'hex');
  assert.strictEqual(msg.readBigUInt64BE(0), 60000000000n);
  assert.strictEqual(msg.subarray(8, 41).toString('hex'), FIXTURE.excess);
  const senderKey = pp.parseAddress(FIXTURE.sender_address, 'x').pubkey;
  assert.strictEqual(msg.subarray(41, 73).toString('hex'), senderKey.toString('hex'));
});

ok('row 2 — amount +1 -> R:FAIL S:FAIL (the amount is in the message)', () => {
  const p = clone(); p.amount = '60000000001';
  const m = marks(p);
  assert.strictEqual(m.R, false); assert.strictEqual(m.S, false);
});

ok('row 3 — excess last byte flipped -> R:FAIL S:FAIL (all 33 bytes covered)', () => {
  const p = clone(); p.excess = flipLowBit(FIXTURE.excess);
  assert.notStrictEqual(p.excess, FIXTURE.excess);
  const m = marks(p);
  assert.strictEqual(m.R, false); assert.strictEqual(m.S, false);
});

ok('row 4 — sender/recipient swapped -> R:FAIL S:FAIL (roles are not interchangeable)', () => {
  const p = clone();
  p.sender_address    = FIXTURE.recipient_address;
  p.recipient_address = FIXTURE.sender_address;
  const m = marks(p);
  assert.strictEqual(m.R, false); assert.strictEqual(m.S, false);
});

ok('row 5 — sender_sig flipped -> R:ok S:FAIL (the two checks are independent)', () => {
  const p = clone(); p.sender_sig = flipLowBit(FIXTURE.sender_sig);
  const m = marks(p);
  assert.strictEqual(m.R, true,  'recipient must be unaffected by the sender signature');
  assert.strictEqual(m.S, false, 'a flipped sender_sig must not verify');
});

ok('row 6 — HRP tgrin -> slatepack: STILL R:ok S:ok (the HRP is NOT signed)', () => {
  const p = clone();
  p.sender_address    = reHrp(FIXTURE.sender_address, 'slatepack');
  p.recipient_address = reHrp(FIXTURE.recipient_address, 'slatepack');
  assert.ok(p.sender_address.startsWith('slatepack1'), p.sender_address);
  assert.notStrictEqual(p.sender_address, FIXTURE.sender_address);
  const m = marks(p);
  assert.strictEqual(m.R, true, 're-labelling the network must not break a signature');
  assert.strictEqual(m.S, true, 're-labelling the network must not break a signature');
  // ...and the tool must report it as a CLAIM it cannot place, never as mainnet.
  assert.strictEqual(m.full.proof.network_claim, 'unknown');
});

ok('row 6b — the re-encoded address still carries the SAME 32-byte key', () => {
  const a = pp.parseAddress(FIXTURE.sender_address, 'x').pubkey.toString('hex');
  const b = pp.parseAddress(reHrp(FIXTURE.sender_address, 'slatepack'), 'x').pubkey.toString('hex');
  assert.strictEqual(a, b);
});

ok('row 7 — amount as a BARE JSON number -> R:ok S:ok (string_or_u64 number path)', () => {
  const text = JSON.stringify(FIXTURE).replace('"amount":"60000000000"', '"amount":60000000000');
  assert.ok(text.includes('"amount":60000000000'), 'the bare-number rewrite did not apply');
  const r = pp.verifyPaymentProof(text);
  assert.strictEqual(r.checks.recipient_sig.ok, true);
  assert.strictEqual(r.checks.sender_sig.ok, true);
  assert.strictEqual(r.proof.amount_nano, '60000000000');
});

ok('row 7b — a bare u64 ABOVE 2^53 survives verbatim (no float rounding)', () => {
  // 9007199254740993 = 2^53+1, the first integer a JS number cannot hold. The
  // quote-then-parse trick in parseProofText is the only thing standing between
  // this and a silently wrong amount.
  const text = JSON.stringify(FIXTURE).replace('"amount":"60000000000"', '"amount":9007199254740993');
  const r = pp.verifyPaymentProof(text);
  assert.strictEqual(r.proof.amount_nano, '9007199254740993');
  assert.strictEqual(r.checks.sender_sig.ok, false);   // different amount -> different message
});

ok('row 8 — the u64 is BIG-endian: a little-endian message FAILS', () => {
  // Not expressible as a fixture mutation — it is a claim about
  // paymentProofMessage() itself, and the field most likely to be misread on a
  // future edit. Build the same message with the amount byte-reversed and verify
  // the REAL sender signature against both.
  const excess = Buffer.from(FIXTURE.excess, 'hex');
  const sender = pp.parseAddress(FIXTURE.sender_address, 'x').pubkey;
  const good   = pp.paymentProofMessage(60000000000n, excess, sender);
  const bad    = Buffer.from(good);
  bad.subarray(0, 8).reverse();
  assert.notStrictEqual(bad.toString('hex'), good.toString('hex'));
  const sig = Buffer.from(FIXTURE.sender_sig, 'hex');
  assert.strictEqual(pp.ed25519Verify(sender, good, sig).ok, true,  'big-endian must verify');
  assert.strictEqual(pp.ed25519Verify(sender, bad,  sig).ok, false, 'little-endian must NOT verify');
});

// ── Format guards that are not part of the eight rows ────────────────────────

ok('a decimal amount is refused before any crypto runs', () => {
  const text = JSON.stringify(FIXTURE).replace('"amount":"60000000000"', '"amount":60.5');
  assert.throws(() => pp.verifyPaymentProof(text), (e) => e.code === 'bad_amount');
});

ok('a missing key is named, not swallowed', () => {
  const p = clone(); delete p.sender_sig;
  assert.throws(() => pp.verifyPaymentProof(p), (e) => e.code === 'missing_keys');
});

ok('a self-payment (one key signing twice) is SURFACED, not hidden', () => {
  const p = clone(); p.recipient_address = FIXTURE.sender_address;
  const r = pp.verifyPaymentProof(p);
  assert.strictEqual(r.self_payment, true);
});

ok('two disagreeing HRPs are flagged — the maths cannot catch that', () => {
  const p = clone(); p.recipient_address = reHrp(FIXTURE.recipient_address, 'grin');
  const r = pp.verifyPaymentProof(p);
  assert.strictEqual(r.hrp_mismatch, true);
  assert.strictEqual(r.checks.recipient_sig.ok, true);   // still valid — HRP is unsigned
});

ok('a garbage public key is a failed CHECK, never a throw', () => {
  const r = pp.ed25519Verify(Buffer.alloc(32, 0), Buffer.alloc(73), Buffer.alloc(64));
  assert.strictEqual(r.ok, false);
});

module.exports = { report: () => ({ pass, fail }) };

if (require.main === module) {
  console.log('\n' + (fail === 0 ? 'ALL PASS' : 'FAILURES') + ' — ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
}
