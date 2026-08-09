# `patches/` — the build overlay (empty until S5)

Every change we make to the vendored wallet lives here, **never inside `vendor/`**.

## How it works

`052_lib_build.sh` copies `vendor/upstream-wallet/public_html` into the build tree, then
applies this directory on top by **whole-file replacement**, mirroring the same relative
paths. No `sed`, no in-place patching of the vendored tree.

```
patches/public_html/index.html            replaces vendor/…/public_html/index.html
patches/public_html/scripts/node.js       replaces vendor/…/public_html/scripts/node.js
```

## Why an overlay and not surgery

- `vendor/SHA256SUMS` pins 270 files. One edited byte there fails the integrity check (S6).
- `git log <PINNED_SHA>..upstream/master` is how we review upstream security fixes on a
  self-custodial wallet. Editing in place makes that diff unreadable, retiring the policy.
- A replaced file is a one-line revert; a `sed` that half-applied is a debugging session.

## What S5 puts here

Grin forced as the default (and only selectable) wallet type, our node defaults first, Accio
branding/title/icons, and one `ATTRIBUTIONS` entry in `backend/resources.php` crediting the
upstream wallet — the About-page credits mechanism already exists and already renders that
list for jQuery, bech32, BLAKE2b and the rest.

## What must NOT go here

⚠️ **A global `MWC_WALLET_TYPE` → Grin rename.** It is a protocol discriminator, not branding:
MWC and Grin are different chains in this code (different HRPs, emission, address types). A
rename would not remove MWC — it would make a wallet silently running MWC consensus under a
Grin label invisible to review. If we want MWC out of the codebase we **delete** those code
paths (S9+, one subsystem per commit, each verified by rebuild + the S2 send + S4b receive).

Deleting cannot introduce a cryptographic bug the way rewriting can. **Never rewrite the
browser crypto** — that is 128k audited, shipping, hardware-wallet-compatible lines, and
rewriting them discards the entire reason this upstream was chosen.
