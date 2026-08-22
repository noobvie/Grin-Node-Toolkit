# `patches/` — the build overlay

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
it is to diff 19 k lines against `vendor/`, and that is not a review anyone repeats. So **every
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
| `backend/resources.php` | ✅ | SVG-only icon lists, the licence file entry, the upstream credit, the `$files` entry for the theme, and `THEME_COLOR` / `BACKGROUND_COLOR` |
| `errors/template.php` | ✅ | one added line — the theme, so the eight error pages nginx serves are the same wallet |
| `index.html` | ✅ | dead MWC/Epic fonts, Grin-only wallet-type select, Donate removed, the theme linked last |
| `styles/accio.css` | ✅ | **added, not replaced.** "Orbital Dawn" — the Accio theme. Loaded last so it beats upstream's colours on source order; nothing in `styles/` is edited, so the upstream diff stays readable |
| `scripts/about_section.js` | ✅ | our source-code and contact links |
| `scripts/check_for_updates.js` | ✅ | our repository; the standalone no longer checks |
| `scripts/consensus.js` | ✅ | Grin forced as the wallet type, before any override |
| `scripts/language.js` | ✅ | client twin of the brand map |
| `scripts/logo.js` | ✅ | the 3D MWC mark never initialises |
| `scripts/mqs.js` | ✅ | S9 pass 1 — the MQS transport reduced to its external surface |
| `scripts/node.js` | ✅ | our node first in both failover lists |
| `site.webmanifest` | ✅ | SVG icon, Grin-only protocol handlers |
| `privacy_policy.txt` | ❌ *(plain text — a marker would be user-visible)* | rewritten end to end for Accio: self-custody, and what the `/tor/` and `/listen` rails relay |
| `images/logo_big.svg` | ❌ *(SVG)* | **Duo** wordmark: the face pair + evenly-spaced `ACCIO` lettering, replacing the MWC one |
| `images/logo_small.svg` | ❌ *(SVG)* | **Duo** pair, white on transparent |
| `images/app_icons/app_icon.svg` | ❌ *(SVG)* | **Duo** favicon / PWA icon — two ringed discs, see below |
| `images/mask_images/mask_image.svg` | ❌ *(SVG)* | Safari pinned-tab mask — **Duo** pair, alpha only |
| `MWC Wallet license.txt` | ❌ *(licence text — must stay verbatim)* | **added, not replaced.** Byte-identical to `vendor/upstream-wallet/LICENSE`; it is what the upstream credit in `ATTRIBUTIONS` links to, and MIT requires it be retained |

## The mark is a pair ("Duo"), and the pairing is a security property

All four SVGs draw the **same Grin glyph twice**. This is not decoration. Accio's icon used to be
`0z0_media/logo_favi/grin_violet.svg` and Fidelius's is the *same path data* in green — so at 16 px
both were one coloured disc, and hue is the first signal to fail on dark chrome or for a
colour-blind viewer. The two wallets have **opposite custody models** (051 holds keys server-side,
052's live in the tab), so a mis-click means typing a passphrase into the wrong trust domain.

⚠ **What must survive any redraw is the SILHOUETTE, not the faces.** Two faces inside one disc — the
obvious way to draw "duo" — restores the exact circle Fidelius has and throws the distinction away.
`app_icon.svg` therefore uses **two discs**, and its geometry is load-bearing:

- `r_black 56.16`, `r_violet 49.14`, centres **105.62** apart. The front black ring lands **0.32**
  clear of the back violet edge, so the discs kiss without biting. **Any closer and the front disc
  eats the back glyph's smile** — the glyph fills 86% of its disc, so there is no room to overlap.
- Content reaches radius **108.97** of the 122 half-canvas — fills the square, clear of an
  adaptive-icon crop. The manifest declares `purpose: "any"`, *not* `maskable`.
- Below ~24 px the monogram is mud in any two-face mark. That is accepted: the double-lobe
  silhouette is what does the work there. Judge a redraw at 16 px, not at 128.

`mask_image.svg` is `<link rel="mask-icon">` — Safari renders **alpha only**, one flat tint. It
carries no `fill` attributes and no discs (a disc would flatten to a solid blob and hide the faces),
and the pair sits **side by side, never overlapping** — merged ink is one shape, not two.

Regenerate with `scratchpad/gen_duo_marks.sh`-style extraction rather than retyping: the glyph `d`
is 1206 chars and is lifted verbatim from the house mark. **Rebuild, never copy onto the VPS** —
each of these shifts an SRI hash that `_acb_apply_patches` recomputes.

## The theme is one file

"Orbital Dawn" is `styles/accio.css` plus three one-line hooks: the `<link>` in `index.html`,
the same `<link>` in `errors/template.php`, and the `$files` entry in `backend/resources.php`.
Upstream's 21 stylesheets are **not** overlaid. The sheet repeats upstream selectors verbatim
and wins on source order, so upstream CSS keeps flowing through the pin untouched and
`git log <PINNED_SHA>..upstream/master` stays readable.

Three things a reviewer should hold on to:

- **It must stay the LAST stylesheet.** Moved above any link it overrides and the theme
  silently half-applies. Both `<link>`s carry a marker saying so.
- **The failure mode is loud, and that is the point.** If upstream renames a selector, our
  rule stops matching and a violet control appears on screen. Compare a `sed`-based reskin,
  which fails by exiting 0 on an address that never fired.
- **Retuning is a token edit.** The `:root` block at the top maps upstream's 62 hardcoded
  colours onto ~20 tokens; the rules below it are plumbing. The build recomputes the file's
  SRI and bumps its cache version on every run, so no hash is maintained by hand.

Two traps the 2026-08-16 review found the hard way, both of which had shipped into this file:

- ⚠ **A quiet button that upstream leaves to the default is the flip's blind spot.** Upstream's
  base is `background: #6000D5; color: white`; the menu rail and the language picker override
  *only* the background, because white was legible on violet and on the rail alike. Our base ink
  is dark — it sits on a light accent fill — so every one of those inherited near-black onto
  near-black, and the main navigation was invisible until hovered at 1.2:1. A colour-coverage
  sweep cannot see this: it looks at selectors upstream *sets* a colour on, and the bug is
  upstream setting **none**. After an upstream bump, re-resolve `color` / `background` /
  `box-shadow` **per property, per button**, and look for any rule ending in `button` that sets
  a background but no colour.
- ⚠ **Do the arithmetic on the ground gradients.** "Centred below the viewport" is not a check.
  Colour reaches only `last-stop × ry` back from the centre, so the original values put the
  entire dawn at `y ≥ 110%` — off screen. All three gradients rendered as nothing, the page was
  flat navy, and it looked completely intentional. The numbers now carry their own arithmetic in
  a comment; keep it correct if you touch them.

And one shape rule: **a hairline on a sized box is an `inset` box-shadow, never a `border`.**
Upstream sets `box-sizing: content-box`, so a border on the message dialog — sized
`width: calc(100% - …)` — pushed it 2px past its parent, on the screen that shows seed phrases.

There is **no operator switch for the theme** and there should not be one: a per-deploy
visual variant doubles the acceptance surface for a build nobody watches run, and A-11 /
A-12 (`patches/` sits outside the pin; the deployed site is never re-verified) are still open.

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
