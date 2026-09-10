// Tiny Explorer (06d) — run every assertion suite, report one total.
//
// Run: node test/run-all.js       (exit 0 = green, non-zero = a failure count)
//
// No test framework and no devDependency. 06d has exactly ONE npm dependency
// (express) and that is not negotiable; these files use node:assert and nothing
// else, and none of them opens a socket, writes a file or reaches the network.
// They can therefore run anywhere `node` runs, with no install step.
//
// This directory is EXCLUDED from the VPS deploy — see tinyx_deploy_files() in
// scripts/lib/06d_tiny_explorer.sh. It is a pre-ship check in the repo, not part
// of the running service.
'use strict';

const path = require('node:path');

const SUITES = [
  'test-payment-proof.js',   // R4's real-wallet fixture + its 8 negative controls
  'test-node-check.js',      // the SSRF blocklist + parseTarget
  'test-wallet-check.js',    // browser Keccak at the rate boundary + onion derivation
  'test-probe-copy.js',      // the probe-on/probe-off copy contract across 5 files
  'test-mining.js',          // the /mining money maths + which missing figure a dash blames
];

let pass = 0, fail = 0;
for (const s of SUITES) {
  const m = require(path.join(__dirname, s));
  const r = m.report();
  pass += r.pass;
  fail += r.fail;
}

console.log('\n' + '─'.repeat(72));
console.log((fail === 0 ? 'ALL PASS' : 'FAILURES') + ' — ' + pass + ' assertions passed, '
  + fail + ' failed, across ' + SUITES.length + ' suites');
process.exit(fail === 0 ? 0 : 1);
