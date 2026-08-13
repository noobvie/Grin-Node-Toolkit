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

## Every deviation carries an `ACCIO PATCH` marker

A patched file is a whole-file copy, so the change itself is invisible — the only way to see
it is to diff 13 k lines against `vendor/`, and that is not a review anyone repeats. So **every
place a patched file departs from upstream is marked with the literal string `ACCIO PATCH`,
followed by what it does and why.** `grep -rn 'ACCIO PATCH' patches/` is the index of this
overlay, and `script052_implementation.md` §"Review plan" tells reviewers to work from that
grep rather than from a diff.

⚠ **A patch with no marker is invisible to the documented review method.** The R8 review found
exactly that: `scripts/check_for_updates.js` had six rewritten URLs and not one marker, so it
had never been read by anyone but its author.

Some formats have no comment syntax that stays out of the rendered output — plain `.txt`, and
SVG where a comment would ride along in every cached copy. **Those are recorded in the table
below instead**, which is therefore part of the marker convention and not a courtesy index.

| File | Marked inline | Why it is here |
|---|---|---|
| `backend/language.php` | ✅ | brand phrase map + branding of the translation table |
| `backend/resources.php` | ✅ | SVG-only icon lists, the licence file entry, the upstream credit |
| `index.html` | ✅ | dead MWC/Epic fonts, Grin-only wallet-type select, Donate removed |
| `scripts/about_section.js` | ✅ | our source-code and contact links |
| `scripts/check_for_updates.js` | ✅ | our repository; the standalone no longer checks |
| `scripts/consensus.js` | ✅ | Grin forced as the wallet type, before any override |
| `scripts/language.js` | ✅ | client twin of the brand map |
| `scripts/logo.js` | ✅ | the 3D MWC mark never initialises |
| `scripts/mqs.js` | ✅ | S9 pass 1 — the MQS transport reduced to its external surface |
| `scripts/node.js` | ✅ | our node first in both failover lists |
| `site.webmanifest` | ✅ | SVG icon, Grin-only protocol handlers |
| `privacy_policy.txt` | ❌ *(plain text — a marker would be user-visible)* | rewritten end to end for Accio: self-custody, and what the `/tor/` and `/listen` rails relay |
| `images/logo_big.svg` | ❌ *(SVG)* | Grin wordmark replacing the MWC one |
| `images/logo_small.svg` | ❌ *(SVG)* | as above |
| `images/app_icons/app_icon.svg` | ❌ *(SVG)* | favicon / PWA icon |
| `images/mask_images/mask_image.svg` | ❌ *(SVG)* | Safari pinned-tab mask |
| `MWC Wallet license.txt` | ❌ *(licence text — must stay verbatim)* | **added, not replaced.** Byte-identical to `vendor/upstream-wallet/LICENSE`; it is what the upstream credit in `ATTRIBUTIONS` links to, and MIT requires it be retained |

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
