// The grin-wallet version the pool's payout rails were last checked against, and a probe of the
// binary the pool actually runs — shown on the admin Health page's Grin Wallet card.
//
// WHY A CONSTANT, AND WHO BUMPS IT. Several payout guards depend on how grin-wallet behaves, not
// only on its API shape, and a new release can change that behaviour with no error anywhere. The
// ones checked against the v5.5.0 source on 2026-09-27 (see the gate in
// withdrawal-scheduler.js processSlatepackExpiry and docs/generated/script07_implementation.md):
//   1. `owner_api` never publishes a Tor onion — only `listen` does (controller.rs
//      foreign_listener, both the external tor and the built-in Arti path). The pool runs owner_api
//      only, so a miner's `grin-wallet receive` cannot reach it over Tor and prints the reply.
//   2. That Tor reply, if it ever reached the pool wallet, calls the Foreign finalize_tx, which
//      finalizes AND posts (foreign_rpc.rs: post_automatically = true) behind the backend's back.
//   3. The tx log records the slate state: Standard1 at lock, Standard3 after any finalize. The
//      expiry gate refunds only Standard1.
// Raise TESTED_VERSION only after re-reading those three in the new release's source. The admin
// panel's "Pool wallet safety" note on the Payout settings page states the same version (a test
// pins the two together), and the toolkit's shared pin is GWI_DEFAULT_TAG in
// scripts/lib/grin_wallet_install.sh.
const { execFile } = require('child_process');
const path = require('path');

const TESTED_VERSION = '5.5.0';
const CACHE_MS = 10 * 60 * 1000;   // a rollback (hub 05 binary store) shows up within 10 min, no restart
const TIMEOUT_MS = 5000;

let cache = null;   // { at, bin, version, error }

// "grin-wallet 5.5.0" → "5.5.0". A pre-release suffix is kept, so 5.6.0-beta.1 is not "5.6.0".
function parseVersion(out) {
  const m = /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)/.exec(String(out || ''));
  return m ? m[1] : null;
}

function runVersion(bin) {
  return new Promise((resolve) => {
    execFile(bin, ['--version'], { timeout: TIMEOUT_MS, windowsHide: true }, (err, stdout, stderr) => {
      const version = parseVersion(stdout) || parseVersion(stderr);
      if (version) return resolve({ version, error: null });
      resolve({ version: null, error: err ? (err.code === 'ENOENT' ? `no binary at ${bin}` : err.message) : 'unrecognised --version output' });
    });
  });
}

// The binary the pool's payouts use: the installer puts it INSIDE the wallet dir (see WalletTor).
async function detect(walletDir, { force = false, run = runVersion } = {}) {
  const bin = path.join(walletDir || '', 'grin-wallet');
  if (!force && cache && cache.bin === bin && Date.now() - cache.at < CACHE_MS) return cache;
  const r = await run(bin);
  cache = { at: Date.now(), bin, version: r.version, error: r.error };
  return cache;
}

// Put the result on the Health page's Grin Wallet card. An untested version is Degraded, never
// worse: the wallet may be perfectly fine — what is unknown is whether the guards above still hold.
// An unreadable version is reported but does not change the status (Tor payouts would show a
// missing binary on their own, and a wrong guess here must not bury a real problem).
function foldIntoCard(card, detected) {
  if (!card || !detected) return card;
  card.wallet_version = detected.version || null;
  card.wallet_version_tested = TESTED_VERSION;
  let note;
  if (!detected.version) {
    note = `grin-wallet version could not be read (${detected.error || 'unknown error'}) — payouts are tested with v${TESTED_VERSION}.`;
  } else if (detected.version !== TESTED_VERSION) {
    if (card.status === 'ok') card.status = 'warning';
    note = `grin-wallet v${detected.version} is NOT the version the payout guards were checked against (v${TESTED_VERSION}). ` +
      'Re-check them before relying on payouts: see Payout settings → Pool wallet safety.';
  }
  if (note) card.message = [card.message, note].filter(Boolean).join(' · ');
  return card;
}

module.exports = { TESTED_VERSION, parseVersion, detect, foldIntoCard };
