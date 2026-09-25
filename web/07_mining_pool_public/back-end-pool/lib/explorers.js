'use strict';

// Chain explorers — the one SERVER-side registry, and the source of the admin setting
// `branding.explorer_mainnet` (grincoin | tiny | grinscan).
//
// Every block / kernel / output the pool shows links out to a public Grin explorer in a new tab:
// the miner's independent proof. The operator picks WHICH mainnet explorer from the admin panel
// (Settings → Branding), so a dead explorer can be swapped without a code edit. It is an ENUM of
// three vetted sites, never a free-text URL, for two reasons:
//   1. The three do NOT share a path scheme (verified live 2026-07-25 / 2026-09-23). A typed URL
//      would bring back the bug where every grinscan.org link 404'd, because the path shape has
//      to travel with the host:
//        grincoin.org       /block/<h>  (hash → /hash/<hash>)  /kernel/<excess>  /output/<commit>
//        scan.grin.money    /block/<h|hash>      /kernel/<excess>          /output/<commit>
//        *.grinscan.org     /block.html?h=<h>    /kernel.html?ex=<excess>  /output.html?c=<commit>
//   2. An admin-panel compromise could otherwise point every miner's "proof" link at a fake
//      explorer that confirms whatever the pool claims.
//
// grincoin.org (aglkm/grin-explorer) takes DIGITS ONLY in /block/ — a 64-hex hash there renders
// its error page — so its style carries a separate `blockHash` segment. It answers HTTP 200 for
// every path, error page included: a status code proves nothing about a link, which is why there
// is no "test this explorer" button. Its /output/ finds UNSPENT outputs only.
//
// TESTNET IS FIXED on test.grinscan.org and ignores the setting: only grinscan has a usable testnet
// explorer (testnet.grincoin.org is PRUNED — old blocks fail; `testnet.grinscan.org` is NXDOMAIN,
// never use it).
//
// The server RESOLVES the key (resolveExplorerKey) and publishes the result as `explorer` beside
// `network` on /api/public/branding (connection.explorer), /api/pool/stats and
// /api/config/pool-info — so a client never has to get the fallback rule right itself. A client
// maps that key through its own copy of EXPLORERS; it never uses a published value as a URL.
//
// ⚠ Two browser copies of EXPLORERS/STYLES must mirror this file: public_html/js/branding.js and
// admin-panel/admin-shell.js (window.Explorer). Change a base or a segment here → change it there.
//
// Pure: no I/O, no DB. index.js starts a server on require, so the logic lives here where
// scripts/test-explorers.js can run it for real.

const deepFreeze = (o) => {
  for (const v of Object.values(o)) if (v && typeof v === 'object') deepFreeze(v);
  return Object.freeze(o);
};
const own = (obj, key) => typeof key === 'string' && Object.prototype.hasOwnProperty.call(obj, key);

// Path styles. The value is the segment placed between the base URL and the encoded reference.
// `blockHash`, when present, replaces `block` for a non-numeric block reference (a hash).
const STYLES = deepFreeze({
  path:     { block: 'block/', kernel: 'kernel/', output: 'output/' },
  grincoin: { block: 'block/', blockHash: 'hash/', kernel: 'kernel/', output: 'output/' },
  query:    { block: 'block.html?h=', kernel: 'kernel.html?ex=', output: 'output.html?c=' },
});

const EXPLORERS = deepFreeze({
  grincoin:         { base: 'https://grincoin.org',      style: 'grincoin' }, // aglkm full archive, mainnet
  tiny:             { base: 'https://scan.grin.money',   style: 'path'     }, // 06d, mainnet only
  grinscan:         { base: 'https://grinscan.org',      style: 'query'    }, // 06b mainnet
  grinscan_testnet: { base: 'https://test.grinscan.org', style: 'query'    }, // 06b testnet sibling
});

// The admin setting's whole domain. grinscan_testnet is deliberately NOT a choice: it is where
// testnet always goes, and a mainnet pool linking to it would open blocks that do not exist.
const MAINNET_CHOICES = Object.freeze(['grincoin', 'tiny', 'grinscan']);
const DEFAULT_MAINNET = 'grincoin';
const TESTNET = 'grinscan_testnet';

// Stored setting → the explorer key this pool actually uses. Testnet ignores the setting.
// Mainnet takes the stored key only if it is an OWN member of MAINNET_CHOICES — includes() on a
// string, never `in` (prototype keys like 'constructor' would pass), and never a type-coerced
// match. Anything else (unset, '', corrupt DB row, a non-string) → DEFAULT_MAINNET: an unknown
// value must never produce a broken link.
function resolveExplorerKey(network, storedKey) {
  if (network === 'testnet') return TESTNET;
  return (typeof storedKey === 'string' && MAINNET_CHOICES.includes(storedKey)) ? storedKey : DEFAULT_MAINNET;
}

// Validator for `branding.explorer_mainnet` (lib/pool-settings.js). Exact match only — no trim,
// no case folding: ' grincoin' or 'GRINCOIN' is a malformed request, not a spelling to guess at.
function validateMainnetChoice(val) {
  if (typeof val !== 'string' || !MAINNET_CHOICES.includes(val)) {
    throw new Error(`explorer_mainnet must be one of: ${MAINNET_CHOICES.join(', ')}`);
  }
  return val;
}

// Same algorithm as window.Explorer.url() in branding.js / admin-shell.js. `kind` is
// block | kernel | output (anything else is treated as block). An unknown key falls back to
// DEFAULT_MAINNET's entry — callers pass a resolveExplorerKey() result, so that is a guard, not
// a path. The value is always encodeURIComponent'ed.
function explorerUrl(key, kind, value) {
  const ex = own(EXPLORERS, key) ? EXPLORERS[key] : EXPLORERS[DEFAULT_MAINNET];
  const style = own(STYLES, ex.style) ? STYLES[ex.style] : STYLES.path;
  const v = String(value);
  const seg = (kind === 'kernel') ? style.kernel : (kind === 'output') ? style.output
    : (style.blockHash && !/^\d+$/.test(v)) ? style.blockHash : style.block;
  return ex.base.replace(/\/+$/, '') + '/' + seg + encodeURIComponent(v);
}

module.exports = {
  STYLES, EXPLORERS, MAINNET_CHOICES, DEFAULT_MAINNET, TESTNET,
  resolveExplorerKey, validateMainnetChoice, explorerUrl,
};
