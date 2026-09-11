'use strict';

// Probe-aware copy — the anchors the swap depends on, checked against the files
// that actually ship.
//
// WHY THIS FILE EXISTS. /wallet-check has two truthful sets of words: one for a
// box with the Tor liveness probe off and one for a box with it on. The static
// HTML carries the baseline — the probe button is BUILT BY THE SCRIPT, so a
// visitor whose browser never runs it has no control on the page whatever
// config.json says — and applyProbeCopy() in public/js/wallet-check.js replaces
// three elements when the probe is on.
//
// That design has exactly one silent failure, and it is the bad direction: a
// renamed or mis-typed id makes the swap a no-op, and the page then talks about
// not being able to check while the button sits directly below the sentence.
// Nobody would catch it by eye.
//
// Since the probe became ON by default for a new install (2026-09-10) that
// failure got MORE likely, not less: the swap now has to fire on most boxes,
// and the people best placed to notice it silently not firing are the ones with
// the probe off, whose page is correct either way. So the baseline copy is now
// held to a two-sided rule — it may not promise the probe (the no-script state
// has no button) and it may not deny it either (a claim about the server that
// is false wherever the flag is on). It describes the PAGE, not the box.
//
// So this asserts the CONTRACT between the three files, not the prose: every id
// and selector the JS writes to exists in the HTML it writes to, and neither
// wording claims what the other state does. It reads the files as text — there
// is no DOM here and no devDependency (06d has one npm dependency, express, and
// that is not negotiable).
//
// Run: node test/test-probe-copy.js

const assert = require('node:assert');
const fs     = require('node:fs');
const path   = require('node:path');

const APP = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(APP, rel), 'utf8');

let pass = 0, fail = 0;
const ok = (name, fn) => {
  try { fn(); pass++; console.log('  PASS  ' + name); }
  catch (e) { fail++; console.log('  FAIL  ' + name + '\n        ' + (e && e.message)); }
};

const walletHtml = read('public/wallet-check.html');
const walletJs   = read('public/js/wallet-check.js');
const chromeJs   = read('public/js/tiny-explorer.js');
const indexHtml  = read('public/index.html');
const serverJs   = read('tiny-explorer-server.js');

// ═══ 1. Every id applyProbeCopy() rewrites exists in the page ════════════════
console.log('\n[1] /wallet-check — the swap targets exist');

// Pulled out of the JS rather than hard-coded, so adding a fourth swap target
// without an id in the HTML fails here instead of shipping as a no-op.
const swapIds = [...walletJs.matchAll(/getElementById\('(wc-[a-z-]+)'\)/g)].map(m => m[1]);
const swapped = swapIds.filter(id => id !== 'wc-input' && id !== 'wc-out'
  && id !== 'wc-check' && id !== 'wc-clear');

ok('applyProbeCopy targets at least the three known elements', () => {
  for (const id of ['wc-lede', 'wc-scope-note', 'wc-detail-live']) {
    assert.ok(swapped.includes(id), 'JS no longer rewrites #' + id);
  }
});

for (const id of new Set(swapped)) {
  ok('#' + id + ' exists in wallet-check.html', () => {
    assert.ok(new RegExp('id="' + id + '"').test(walletHtml), 'no element carries id="' + id + '"');
  });
}

// ═══ 2. The two wordings stay in their own state ═════════════════════════════
console.log('\n[2] neither state claims the other\'s capability');

ok('static HTML does not promise a liveness check', () => {
  // Direction 1: the no-script state has no button, so naming one strands the
  // visitor looking for a control that was never built.
  assert.ok(!/Check over Tor/.test(walletHtml),
    'static HTML names the probe button, which only exists when the probe is on');
});

ok('static HTML does not deny a liveness check either', () => {
  // Direction 2, and the one the flipped default made live. The baseline copy
  // may not assert anything about the SERVER's capability: with the probe on —
  // now the norm — any such claim is simply false, and it is read by exactly
  // the visitor whose script failed and who has no way to tell. Assertions are
  // about the page's own actions ("nothing here has asked"), never the box's.
  const forbidden = [
    /this server is not set up to find out/i,
    /this server does not offer/i,
    /does not offer the optional Tor\s+liveness check/i,
    /never finds out/i,
  ];
  for (const re of forbidden) {
    assert.ok(!re.test(walletHtml),
      'static HTML claims the server cannot check (' + re + ') — false wherever the probe is on');
  }
  // …but it must still tell the visitor the address check alone proves nothing,
  // or the page over-reads a valid checksum as a working wallet.
  assert.ok(/does not tell you whether the wallet is online/i.test(walletHtml),
    'static HTML dropped the "a valid address is not a live wallet" warning');
});

ok('no conditional hedging survives in the static copy', () => {
  // "Where this server offers…" made the visitor resolve a conditional the page
  // already knows the answer to. Both states are now definite.
  assert.ok(!/[Ww]here this server offers/.test(walletHtml), 'hedged phrasing is back');
  assert.ok(!/[Ii]f this server offers/.test(walletHtml), 'hedged phrasing is back');
});

ok('the probe-on wording is reachable and definite', () => {
  assert.ok(/Two checks, and only the second one connects/.test(walletJs),
    'the probe-on note text is gone');
  assert.ok(/we could not check/.test(walletJs),
    'the probe-on copy dropped the third outcome, leaving a green/red binary');
});

// ═══ 3. The hub label + SEO description follow the same flag ═════════════════
console.log('\n[3] tools menu, homepage card and <meta description>');

ok('the relabel selectors match the shipped markup', () => {
  const sels = [...chromeJs.matchAll(/querySelectorAll\('(\.tx-tool[^']*wallet-check[^']*)'\)/g)]
    .map(m => m[1]);
  assert.ok(sels.length >= 2, 'applyWalletProbeLabels no longer selects both surfaces');
  // The menu row and the homepage card, as they actually appear in the HTML.
  assert.ok(/<a class="tx-tools-item" href="\/wallet-check"[^>]*>[\s\S]{0,200}?<small>/.test(walletHtml),
    'the tools-menu row lost its <small> or its class/href');
  assert.ok(/<a class="tx-tool-card" href="\/wallet-check">[\s\S]{0,300}?class="tx-tool-line"/.test(indexHtml),
    'the homepage card lost its .tx-tool-line or its class/href');
});

ok('applyWalletProbeLabels is actually called', () => {
  assert.ok(/applyWalletProbeLabels\(\);/.test(chromeJs), 'defined but never invoked');
});

ok('the SEO description branches on the probe flag', () => {
  const meta = serverJs.slice(serverJs.indexOf('  walletcheck: {'));
  const block = meta.slice(0, meta.indexOf('\n  },'));
  assert.ok(/walletProbeEnabled/.test(block),
    'walletcheck desc is a fixed string again — wrong on one of the two deployments');
  assert.ok(/It does not report whether the wallet is online/.test(block),
    'the probe-off branch of the description is gone');
});

ok('walletProbeEnabled is declared before _pageMeta reads it', () => {
  // Both are module-scope const: a reorder is a TDZ ReferenceError at startup,
  // i.e. the whole explorer fails to boot, not just this page.
  const decl = serverJs.indexOf('const walletProbeEnabled');
  const meta = serverJs.indexOf('const _pageMeta');
  assert.ok(decl > -1 && meta > -1, 'one of the declarations was renamed');
  assert.ok(decl < meta, 'walletProbeEnabled is now declared after _pageMeta (TDZ at boot)');
});

// ═══ 4. /proof's cross-reference ═════════════════════════════════════════════
console.log('\n[4] /proof no longer overstates what /wallet-check keeps local');

ok('proof.html does not say the Wallet Checker never transmits', () => {
  const proof = read('public/proof.html');
  assert.ok(!/Wallet Checker<\/a>,\s*\n?\s*which never transmit/.test(proof),
    'proof.html claims the Wallet Checker never transmits — untrue with the probe on');
  assert.ok(/optional Tor button/.test(proof),
    'proof.html lost the qualifier that keeps it true in both states');
});

console.log('\n' + '─'.repeat(72));
console.log('probe-copy: ' + pass + ' passed, ' + fail + ' failed');

module.exports = { report: () => ({ pass, fail }) };
