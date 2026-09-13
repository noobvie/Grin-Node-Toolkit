// Wallet-checker regression tests — the browser Keccak, and the two onion
// derivations agreeing.
//
// WHY THIS FILE EXISTS. /wallet-check tier 1 answers entirely in the visitor's
// browser, and the .onion it prints is arithmetic on the pasted address. The
// browser has no SHA-3 (crypto.subtle is SHA-1/256/384/512 and nothing else), so
// public/js/wallet-check.js carries a self-contained Keccak-f[1600] — and a
// hand-written sponge is exactly the kind of code that is correct for the one
// length it was tried on. It was checked once against node's sha3-256, in a
// throwaway harness, and the result then lived only in a document.
//
// THE RATE BOUNDARY IS THE WHOLE POINT. SHA3-256 absorbs 136 bytes at a time.
// 135 / 136 / 137 are the three inputs that exercise the padding branches either
// side of a full block, and a sponge that is wrong is usually wrong at exactly
// one of them. The real input (".onion checksum" + 32-byte key + 0x03 = 48
// bytes) never reaches the boundary, so shipping code alone would never notice.
//
// The second half asserts the two independent derivations agree: the browser
// port in public/js/wallet-check.js and the server original in
// lib/wallet-tor.js. They are the same arithmetic written twice, so they can
// drift, and a drift means /wallet-check prints one onion while the tier-2 probe
// dials another.
//
// Run: node test/test-wallet-check.js
'use strict';

const assert = require('node:assert');
const crypto = require('node:crypto');
const path   = require('node:path');

const APP = path.resolve(__dirname, '..');

// The browser files export a CommonJS api when `module` exists, and self-init is
// guarded by `typeof document`. slatepack-decode must land on the global first —
// wallet-check.js reads root.SlatepackDecode for its bech32.
const SPD = require(path.join(APP, 'public/js/slatepack-decode.js'));
globalThis.SlatepackDecode = SPD;
const WC = require(path.join(APP, 'public/js/wallet-check.js'));
const walletTor = require(path.join(APP, 'lib/wallet-tor.js'));

let pass = 0, fail = 0;
const ok = (name, fn) => {
  try { fn(); pass++; console.log('  PASS  ' + name); }
  catch (e) { fail++; console.log('  FAIL  ' + name + '\n        ' + (e && e.message)); }
};

const hex = (u8) => Buffer.from(u8).toString('hex');
const nodeSha3 = (buf) => crypto.createHash('sha3-256').update(buf).digest('hex');

// ═══ 1. The browser Keccak vs node crypto ════════════════════════════════════
console.log('\n[1] public/js/wallet-check.js — sha3_256 vs node crypto sha3-256');

// 135/136/137 first and named as such: they are the reason this test exists.
// 0 and 1 cover the empty/short pad, 48 is the real onion-checksum input, 272 is
// two full blocks, 273 forces a third.
const LENGTHS = [135, 136, 137, 0, 1, 32, 47, 48, 49, 134, 271, 272, 273];

for (const n of LENGTHS) {
  const boundary = (n >= 135 && n <= 137) ? '  ← RATE BOUNDARY' : '';
  ok('sha3-256 matches at ' + n + ' bytes' + boundary, () => {
    // Deterministic, non-uniform bytes: an all-zero input hides a lane that is
    // never written, and a random one is not reproducible when it fails.
    const buf = Buffer.alloc(n);
    for (let i = 0; i < n; i++) buf[i] = (i * 37 + 11) & 0xff;
    assert.strictEqual(hex(WC.sha3_256(new Uint8Array(buf))), nodeSha3(buf),
      'digest differs at length ' + n);
  });
}

ok('sha3-256 matches on 64 pseudo-random inputs of 0..300 bytes', () => {
  // One seeded LCG so a failure is reproducible from the seed alone.
  let s = 0x2545f491;
  const next = () => (s = (s * 1103515245 + 12345) >>> 0);
  for (let i = 0; i < 64; i++) {
    const n = next() % 301;
    const buf = Buffer.alloc(n);
    for (let j = 0; j < n; j++) buf[j] = next() & 0xff;
    assert.strictEqual(hex(WC.sha3_256(new Uint8Array(buf))), nodeSha3(buf),
      'digest differs at length ' + n + ' (iteration ' + i + ')');
  }
});

ok('sha3-256 of the empty string is the published NIST vector', () => {
  assert.strictEqual(hex(WC.sha3_256(new Uint8Array(0))),
    'a7ffc6f8bf1ed76651c14756a061d662f580ff4de43b49fa82d80a4b80f8434a');
});

// ═══ 2. Browser onion derivation vs lib/wallet-tor.js ════════════════════════
console.log('\n[2] onion derivation — browser port vs lib/wallet-tor.js');

// Addresses, not raw keys: the pair has to agree end-to-end, bech32 included.
// Both keys come from the R4 payment-proof fixture, so a single real-wallet
// artefact ties this file to test-payment-proof.js. The `grin1…` pair is the
// same two keys re-encoded under the mainnet HRP — which is legitimate here
// precisely because R4 row 6 established the HRP is not part of the key.
const ADDRESSES = [
  'grin1xtxavwfgs48ckf3gk8wwgcndmn0nt4tvkl8a7ltyejjcy2mc6nfs6ak9cv',
  'grin10qlk22rxjap2ny8qltc2tl996kenxr3hhwuu6hrzs6tdq08yaqgql0xgkw',
  'tgrin1xtxavwfgs48ckf3gk8wwgcndmn0nt4tvkl8a7ltyejjcy2mc6nfs9gm2lp',
  'tgrin10qlk22rxjap2ny8qltc2tl996kenxr3hhwuu6hrzs6tdq08yaqgqq6t83r',
];

for (const addr of ADDRESSES) {
  ok('both derivations agree for ' + addr.slice(0, 14) + '…', () => {
    const server = walletTor.deriveOnionAddress(addr);
    assert.ok(server && server.endsWith('.onion'), 'server derivation returned ' + server);
    assert.strictEqual(server.length, 56 + '.onion'.length, 'a v3 onion is 56 base32 chars');

    const parsed = WC.checkAddress(addr);
    assert.strictEqual(parsed.ok, true, 'browser rejected the address: ' + parsed.message);
    assert.strictEqual(parsed.onion, server, 'browser and server derived DIFFERENT onions');
  });
}

ok('both derivations agree over 32 keys spanning the byte range', () => {
  // The checksum is only 2 bytes of a SHA3, so one address agreeing is weak
  // evidence. Drive real keys through both paths.
  for (let i = 0; i < 32; i++) {
    const key = Buffer.alloc(32);
    for (let j = 0; j < 32; j++) key[j] = (i * 8 + j * 31) & 0xff;
    const fromBrowser = WC.onionV3FromPubkey(new Uint8Array(key));
    const fromServer  = walletTor.onionV3FromPubkey(key);
    assert.strictEqual(fromBrowser, fromServer, 'key #' + i + ' derived differently');
  }
});

ok('the tier-1 result carries the same pubkey the onion was built from', () => {
  const r = WC.checkAddress(ADDRESSES[0]);
  assert.strictEqual(r.pubkeyHex.length, 64);
  assert.strictEqual(r.onion, WC.onionV3FromPubkey(Buffer.from(r.pubkeyHex, 'hex')));
});

// ═══ 3. The HRP is the ONLY network signal, and it is a claim ════════════════
console.log('\n[3] public/js/wallet-check.js — network detection + checksum');

ok('grin1… reads as mainnet, tgrin1… as testnet', () => {
  assert.strictEqual(WC.checkAddress(ADDRESSES[0]).network, 'mainnet');
  assert.strictEqual(WC.checkAddress(ADDRESSES[2]).network, 'testnet');
});

ok('the SAME key under both HRPs derives the SAME onion — the HRP is not the key', () => {
  // ADDRESSES[0] and [2] are one key, two labels. A v3 onion is base32 of the
  // key alone, so a derivation that moved with the HRP would be wrong.
  assert.strictEqual(WC.checkAddress(ADDRESSES[0]).pubkeyHex,
                     WC.checkAddress(ADDRESSES[2]).pubkeyHex);
  assert.strictEqual(WC.checkAddress(ADDRESSES[0]).onion,
                     WC.checkAddress(ADDRESSES[2]).onion);
});

ok('a one-character typo fails the bech32 checksum, it is not silently accepted', () => {
  const good = ADDRESSES[0];
  const bad  = good.slice(0, -1) + (good.slice(-1) === 'q' ? 'p' : 'q');
  const r = WC.checkAddress(bad);
  assert.strictEqual(r.ok, false, 'a corrupted address must not verify');
  assert.strictEqual(r.onion, null, 'a failed check must not print an onion');
});

ok('a truncated address is refused — the common real failure', () => {
  const r = WC.checkAddress(ADDRESSES[0].slice(0, 40));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.onion, null);
});

ok('server-side isSlatepackAddress agrees with the browser on all four', () => {
  for (const a of ADDRESSES) {
    assert.strictEqual(walletTor.isSlatepackAddress(a), true, a);
    assert.strictEqual(WC.checkAddress(a).ok, true, a);
  }
  for (const a of ['', 'not-an-address', ADDRESSES[0].slice(0, 40)]) {
    assert.strictEqual(walletTor.isSlatepackAddress(a), false, JSON.stringify(a));
    assert.strictEqual(WC.checkAddress(a).ok, false, JSON.stringify(a));
  }
});

module.exports = { report: () => ({ pass, fail }) };

if (require.main === module) {
  console.log('\n' + (fail === 0 ? 'ALL PASS' : 'FAILURES') + ' — ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
}
