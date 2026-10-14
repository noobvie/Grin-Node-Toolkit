# Script 052 — Accio: implementation

> **Covers code as of:** 2026-08-24 · **Last verified:** 2026-08-24, PARTIAL — the doc's own record of `bash -n` 5/5 and `node --check` 9/9 over the tree; no systematic doc-vs-code pass
> **Product code last changed:** 2026-08-22 — `scripts/052_grin_accio.sh`, `scripts/lib/052_lib_*.sh`, `web/052_accio/`
> Prose last edited 2026-10-13 (the session log re-sectioned to the implementation template: as-built by subject · runbook · *Build notes — obstacles & lessons* · open items; the per-session verification lists, the review plan and its hunt lists dropped, raw text in git at `e8932ab`). A re-section, not a verification.

**Product:** Accio, the public self-custodial browser wallet — a vendored, pinned upstream wallet plus our overlay, a zero-dependency Node gateway and a nginx/Tor front. Design → [`script052_design.md`](script052_design.md); findings → [`script052_security_audit.md`](script052_security_audit.md); the overlay's own rules → `web/052_accio/patches/README.md`.

This file is the as-built record and the handoff to the acceptance session: if a session ends with knowledge only in a conversation, the work is not finished.

| Section | Contents |
|---|---|
| [What shipped](#what-shipped) | as built, by subject |
| [Runbook](#runbook) | building, rolling back, bootstrapping, recovering state |
| [Build notes](#build-notes--obstacles--lessons) | obstacles & lessons |
| [Open items](#open-items) | what is owed, and what is known and not fixed |

---

# What shipped

**Status:** designed · built (every menu key live, no stub left) · **not VPS-tested** — nothing has ever run on a VPS: not one build, deploy, send or receive. The next session is the acceptance session (S2), not a build session; it owes every run listed under *Open items*, testnet before mainnet. A menu with no stubs is not a tested one.

## Current state

| | |
|---|---|
| Built | Vendor + pin, site build, standalone build, gateway (both rails), nginx/TLS/onion, overlay + branding, the MQS reduction, theme and the security audit — all 2026-08-09 → 2026-08-16. **Not built:** the optional deletion passes 2 and 3, and the A-11 / A-12 mechanisms |
| Audit | **[script052_security_audit.md](script052_security_audit.md)** — written 2026-08-11, amended by the later reviews. **16 findings fixed, 6 open.** The one that mattered: inbound payments were routed by SESSION, so a cookie could redirect a stranger's payment into another wallet (A-1, and A-18 when it turned out A-1's accepted residual gave the whole of A-1 back) |
| Review | **Complete, 2026-08-11 → 2026-08-12** — every authored file was read once, deliberately, before any VPS time is spent on it. Findings are in *Build notes* and the audit. The pin-enforcement review's 8 fixes (deny-list offline guard, `ext::` URL, report path, `${root:?}`, INT/TERM trap) are verifiable in `052_lib_vendor.sh`; their only write-up is memory `project_web_wallet_051_vs_055` |
| Next | **The acceptance session (S2)** — no longer a build session. First VPS work; it owes every run under *Open items*. Everything that can be authored has been |
| Deployed anywhere? | **No.** Nothing has ever run on a VPS. Not one build, deploy, send or receive. |
| Script 052 menu | **every key is LIVE** since 2026-08-10 — there is no stub left in this product. That is not the same as tested |
| Overlay | `patches/public_html/` — **19 files / 656 kB** (17 replace a vendored file, 2 add one; 678,170 bytes measured 2026-08-24, after the Duo marks of 2026-08-17 — it was 671,637 on 2026-08-16, and only the four SVGs changed between), **49 `ACCIO PATCH` markers, 34 of them in the published file set** (`backend/` and `errors/template.php` are build-time only, never served). Search for that string, not for a diff — and see `patches/README.md` for the five files whose format cannot carry an inline marker, which the table there covers instead |
| Theme | **"Orbital Dawn"** — `styles/accio.css`, loaded **last** so it beats upstream's colours on source order. Upstream's 22 stylesheets are not overlaid; the three hooks are the `<link>` in `index.html`, the same `<link>` in `errors/template.php`, and the `$files` entry + `THEME_COLOR`/`BACKGROUND_COLOR` in `backend/resources.php`. Retuning is a `:root` token edit. **Never seen in a browser** — see *Theme* |
| Pin enforcement | `accio_build` refuses to stage anything unless `acv_verify_vendor` passes — manifest-vs-`PINNED_SHA`, then `sha256sum -c`, then the file set both ways. **No bypass.** Never "fix" a failure by regenerating `SHA256SUMS` on the VPS |
| Branding | Two files (`backend/language.php`, `scripts/language.js`) carry a phrase map that rebrands the whole app in all six languages. **The two maps must stay identical** — 12 entries each. A new language must be checked against the map before it ships: three of the six translators did not keep the English word order, which left 27 strings unbranded until 2026-08-12 |
| Hub 05 key `2` | `run_sub "052_grin_accio.sh" \|\| true` since 2026-08-10. The `_slot_notice` arm is deleted, not aliased |
| Upstream pin (wallet) | `adef11daadf04e4ec259d6febcc720da3daaa6c7` (v2.8.2, MIT) |
| Upstream pin (build script) | `043c2ddc8105721a0b75ece3f614d44b66c79150` (MIT) — a spec, never run |
| Manifest | `vendor/SHA256SUMS` — **274 files / 7,517,960 bytes** across both trees |
| Gateway modules | **9**, still **zero npm dependencies**. Regression suite `gateway/test/` — 4 files, **78 tests, 78 pass, 0 fail** under `node --test` (measured 2026-08-12). Run it from `web/052_accio/gateway/`; **`node --test test/` fails on Windows** — use no argument, or `node --test "test/*.test.js"` |
| Libraries | **4** — `052_lib_build.sh` (site + standalone), `052_lib_gateway.sh`, `052_lib_nginx.sh`, `052_lib_vendor.sh` |
| Gateway state | `/opt/grin/accio-<net>/gateway-state/` — the suffix ↔ session table. **Losing it changes every wallet's receiving address.** The only `ReadWritePaths` in the unit |

**Verified 2026-08-24, on the tree as it now stands:** `bash -n` 5/5 · `node --check` 9/9 ·
`node --test` **78 pass / 0 fail** · `sha256sum -c vendor/SHA256SUMS` 274/274, zero mismatches ·
`git status --short -- web/052_accio/vendor/` empty · the two brand phrase maps parsed out of
`backend/language.php` and `scripts/language.js` and compared as ordered pairs — **12 entries
each, identical, same order** · no `TODO`/`FIXME`/stub anywhere in the product · working tree
clean.

## Invariants

No change to this product may break these.

- **`vendor/` is untouchable**; deviations live in `patches/` and are marked `ACCIO PATCH`.
- **`MWC_WALLET_TYPE` is a chain discriminator, not branding** — never renamed.
- **nginx `add_header` in a child block discards the parent's set** — every block that adds
  any header of its own must include the headers snippet.
- **`TOR_SERVER_ADDRESS` is baked in at BUILD time** — minting an onion without a rebuild
  ships a clearnet host to the user who picked "Onion Service".
- **`gateway-state/` is durable state, not a cache** — losing it changes the receiving
  address of every wallet that ever connected.
- **A deletion pass is a reduction, not an `rm`, and must never change how a slate is READ.**
- Menu loops under `set -e`: every `case` dispatch `||`-guarded; no function ending in
  `[[ … ]] && cmd`.

## Vendor, pin and integrity

**Status:** built 2026-08-09 (vendor and pin) and 2026-08-10 (integrity check), not VPS-tested.

**Outcome: `052` exists, and Accio is permanently independent.** MIT is irrevocable for the
copy we received, so that is now a licensing fact rather than something later engineering
earns. Everything after this removes *operational* dependencies only.

**Files created**

| Path | What it is |
|---|---|
| `web/052_accio/vendor/upstream-wallet/` | the pinned upstream tree, 270 files, unrenamed and unmodified |
| `web/052_accio/vendor/SHA256SUMS` | per-file pin, `sha256sum -c` clean at vendor time |
| `web/052_accio/PINNED_SHA` | shell-sourceable pin record + the exact reproduction command |
| `web/052_accio/PROVENANCE.md` | what `vendor/` is, disposition table, measurements, naming policy |
| `web/052_accio/.gitattributes` | `vendor/** -text` — stops this repo renormalising the pinned bytes |
| `web/052_accio/docs/upstream-nginx.conf.reference` | upstream's `nginx.conf`, kept as the spec the gateway replaces |
| `web/052_accio/gateway/README.md` | the four jobs our Node service carries |
| `web/052_accio/patches/README.md` | overlay rules and the marker table |
| `scripts/052_grin_accio.sh` | menu skeleton, every action a stub — **this is what assigned the number** |
| `docs/reference/script052_design.md` | PART A moved out of `script05_design.md` |
| `docs/reference/script052_implementation.md` | this file |

**The pin**

```
UPSTREAM      github.com/NicolasFlamel1/mwcwallet.com
SHA           adef11daadf04e4ec259d6febcc720da3daaa6c7   ("Removed AscendEX compatibility
              from README", 2026-07-30)
VERSION       2.8.2, released 16 Jun 2026 16:02:00 UTC
LICENSE       MIT, sha256 bbc8b96cd3c66cd7d69ec75aaeae3b0d5d81d955771fadf7bc0cdc953728e32f
VENDORED      270 files / 7,443,197 bytes  (upstream ships 273)
MANIFEST      vendor/SHA256SUMS, sha256 fb43f4ef82669c8c1db42985e1285067d47f5836d8196764ca03afa8e94644f0
```

**Removed from the tree:** `fullchain.pem` + `privkey.pem` deleted (upstream's own dev cert
and **private key** — never redistribute someone else's key material), `nginx.conf` moved to
`web/052_accio/docs/upstream-nginx.conf.reference` so it can never be mistaken for config we
deploy. Nothing else was touched, including upstream's own `.gitignore`.

**Design measurements re-verified against the real tree** — all confirmed: 105 JS files, 11
PHP files, and `scripts/node.js` lines **512** / **535** do carry `https://api.grin.money` and
`https://testapi.grin.money`, i.e. this toolkit's own Script 04 endpoints ship in upstream's
stock default node list.

Two files exist because of what vendoring found:

- `vendor/SHA256SUMS` — the integrity check is specified as verifying the tree "against a committed checksum",
  and vendor time is the only honest moment to certify what we actually received. the check now
  consumes this file rather than minting one from a tree nobody re-checked.
- `web/052_accio/.gitattributes` — `vendor/** -text`, so this repo's `* text=auto eol=lf` cannot renormalise the pinned bytes (see *Build notes*).

- **Upstream's nginx config** — `web/052_accio/docs/upstream-nginx.conf.reference` (58,454 bytes) is the
  behavioural spec for the `/tor/` regex, the request/response header allowlists and
  upstream's gateway on `:9000`. Read it; never deploy it.

**Outcome: the pin is now checked instead of asserted.** Vendoring put two upstreams in the tree and wrote
`vendor/SHA256SUMS`; for a day that manifest was a comment nothing read. `scripts/lib/052_lib_vendor.sh`
(≈560 lines, no new dependency) is the reader, and `accio_build` will not stage a single file
until it passes. Menu key `5` **Check upstream** is live.

**Files**

| Path | What changed |
|---|---|
| `scripts/lib/052_lib_vendor.sh` | **new.** `acv_verify_vendor` (offline), `acv_check_upstream` (the only network action in 052), `acv_pin_report`, `acv_vendor_menu` |
| `scripts/lib/052_lib_build.sh` | `accio_build` sources the lib and gates on `acv_verify_vendor --quiet` before staging; header records that the no-network property now spans two files |
| `scripts/052_grin_accio.sh` | key `5` → `acv_vendor_menu`; header, "we write exactly **four** things", live-key banner |

### The check is three checks, and the order is the design

`sha256sum -c` was the whole plan. It is not sufficient, for a reason worth stating plainly:

1. **The manifest's own sha256, against `PINNED_SHA` — first.** Anyone who edits `vendor/` and
   then regenerates `SHA256SUMS` defeats step 2 completely. This step is the only one that
   notices, so it cannot run second. Verified by test: tamper a byte, regenerate the manifest,
   and the check still fails — on this step.
2. **`sha256sum -c` over all 274 listed paths.**
3. **The file set, both directions.** Step 2 verifies only what the manifest *lists*, so it
   **structurally cannot see a file that was added**. That is the more interesting attack
   anyway: the build copies the whole vendored tree, so a dropped-in `backdoor.js` ships to a
   self-custodial wallet without one listed hash changing.

Each is worthless alone — step 1 trusts the tree, step 2 trusts the manifest, step 3 proves
nothing about content. Only the three together mean anything.

⚠ **The remedy for a failure is a re-vendor in this repo, never a regenerated manifest on the
VPS.** Regenerating on the target certifies whatever is on the target, which is exactly the
thing being questioned. The failure message says so, because the obvious "fix" is the wrong one.

### Three deliberate choices in the upstream check

**`FETCH_HEAD` became `origin/HEAD`.** The spec said `git log --stat <PINNED_SHA>..FETCH_HEAD`.
A shallow or single-ref fetch cannot *contain* the pinned commit, and the most important answer
this action produces is **"is our pin still reachable?"** — a "no" means upstream force-pushed
or rewrote history, which is a security event, not an update, and a diff against a rewritten
branch is meaningless. So it fetches every branch at full depth, resolves the default branch via
`remote set-head origin -a`, and reports the unreachable case separately and loudly (rc 1). Our
copy is unaffected either way, and the message says that too — `vendor/` is ours and byte-pinned.

**The scratch clone is `init --bare`.** `log`, `diff` and `rev-list` all work fine against a bare
repo, so there is no reason to ever materialise upstream code as a file on a box that serves a
wallet. Asserted by test: after a check run, no upstream filename exists anywhere under the
scratch directory.

**The overlay cross-reference splits *replaced* from *added*.** `patches/public_html/` has 16
files but only **15** shadow a vendored file. `MWC Wallet license.txt` is upstream's root
`LICENSE` copied under `public_html` so the About credit has a link target inside the served
root — it has no upstream counterpart, so upstream can never "change" it and it must not be
counted as conflict risk. It surfaced as a failing assertion, not by reading: the first version
of the test demanded every overlay path exist upstream, and one did not.

That one file also produced the check's most useful small feature. Because our copy is a *copy*,
an upstream licence change silently makes the About credit misstate the licence — so upstream's
root `LICENSE` is on a **watched** list alongside `nginx.conf` (the spec the gateway replaced, kept
outside `vendor/` at `docs/upstream-nginx.conf.reference`). Neither is cross-referenced by the
overlay check; both are reported when they change.

### The overlay list is derived, never written down

`_acv_patched_upstream_paths` walks `patches/public_html/` at run time. A hand-kept copy would be
wrong on the first session that forgot to update it — and that is precisely the session where a
missed conflict silently reverts a patch. later deletion passes will grow this overlay; nothing
needs updating here when they do.

### The offline property now spans two files, so it is proved in both

`052_lib_build.sh`'s whole argument is that a build makes no network request. That claim now
depends on a second file, so `_acv_assert_offline_path` mirrors `_acb_assert_offline`: it greps
the **parsed function bodies** (`declare -f`) of the verify chain for a fetcher in command
position. Parsed bodies, not the file — this lib is *supposed* to contain a fetcher, in
`acv_check_upstream`, which no build ever calls. Bash discards comments when it parses a
function, so comments cannot trip it.

⚠ **A message string can trip it**, since ` name ` inside quotes looks the same as a command.
That is on purpose and cheap to live with — the verify chain must not name these tools in its
output either, which is why its failure text points at `PINNED_SHA`'s recipe instead of spelling
a command out. The detector is tested both ways: it passes on the shipped chain, and it catches a
fetcher planted into `acv_verify_vendor`.

One gap in it was found and closed while reviewing: this lib never spells the tool out — it
invokes it through `"$ACV_GIT_BIN"` — so a literal-name-only pattern would have missed the exact
form a future edit is most likely to copy. `ACV_GIT_BIN` is now part of the pattern, and there is
an assertion for each spelling.

**Verify was not made bypassable.** A `--force`/`ACCIO_SKIP_VERIFY` escape hatch was considered
and rejected: a build that can skip its integrity check is worse than one with no check, because
the manifest then reads as evidence it never provided. A missing `052_lib_vendor.sh` is likewise a
hard error, not a warning.

`patches/` is deliberately not integrity-checked: it is our own code, versioned in this repo, and the manifest exists to prove that what came from upstream is unchanged. A patches manifest is proposed under *Open items*.

## Build (site and standalone)

**Status:** hosted build built 2026-08-09 and standalone build 2026-08-10, both reviewed 2026-08-12, not VPS-tested.

**Outcome: `scripts/lib/052_lib_build.sh`, and 052's key `2` "Rebuild site" is LIVE.** The
build is the first thing Accio actually *does*. Its defining property is that it makes **no
network request**: it reads `vendor/` and `patches/` and nothing else, which is what makes the
pin mean anything. `_acb_assert_offline` re-checks that at runtime, so a future edit that
adds a downloader fails the build instead of quietly weakening the pin.

**Public entries** — `accio_build [net] [domain] [outdir]`, `acb_check_deps`, `acb_env_report`.

### The env contract

| Var | Hosted build | Standalone | Why |
|---|---|---|---|
| `SERVER_NAME` | the domain | the domain | canonical URL, hreflang, manifest, sitemap, robots |
| `HTTPS` | `on` once a cert exists, else **absent** | `on` | tested with `array_key_exists` **and** `=== "on"` |
| `HTTPS_SERVER_ADDRESS` | set with `HTTPS` | set | **absent → the JS falls back to `location.hostname`, which is what a hosted site wants**. Presence also flips the HTTP/HTTPS label in the address-type selector |
| `TOR_SERVER_ADDRESS` | **absent until the onion is minted** | the onion | absent → the "Onion Service" address type hands out a *clearnet* host. Set it as soon as the onion exists |
| `NO_FILE_VERSIONS` | **must be ABSENT** | `""` | see #1 |
| `NO_FILE_CHECKSUMS` | **must be ABSENT** | `""` | see #1 |
| `NO_MINIFIED_FILES` | **must be ABSENT** | `""` | see #1 |
| `REQUEST_URI` | `"/"` | `"/"` | keeps `errors/503.html` on its maintenance branch instead of `require`-ing 404.html |
| `SERVER_PROTOCOL` | `HTTP/1.1` | same | only avoids an undefined-index notice in the error pages |
| `HTTP_ACCEPT_LANGUAGE` | `en-US,en;q=0.9` | same | one render is the whole site — see #2 |
| `HTTP_USER_AGENT` | **absent** | absent | only drives a Googlebot test and the manifest's mobile-icon split; the default is right |

### What the build had to account for

1. **The three `NO_*` vars are tested for PRESENCE, not value.**
   `backend/resources.php:1760/1771/1782` all use `array_key_exists()`. So
   `NO_FILE_VERSIONS=""` — which is exactly what upstream's `build.sh` writes — **disables**
   file versions. That is correct for the standalone artefact and wrong for a hosted site.
   The trap is that an operator with one of these exported in a shell profile would silently
   strip cache-busting **and Subresource Integrity** from the entire site, with no error and
   no visible symptom. Every render therefore runs under `env -u` for all three.

2. **We must render 27 files. `build.sh` renders 14.**
   `build.sh` only needs what folds into a single self-contained `index.html`. A *hosted*
   site also needs `site.webmanifest`, `sitemap.xml`, `robots.txt`, `browserconfig.xml`,
   `scripts/service_worker.js` and the eight `errors/*.html` — every one of them PHP-templated
   too. Transcribing build.sh's list would have published those as **raw PHP source**: the
   manifest breaks PWA install and `service_worker.js` breaks offline caching, neither with
   an error anyone would trace back to the build.
   So the build **discovers** templated files instead of listing them. Detection is the
   leading five bytes `<?php` — verified exact across all 266 files, with **zero** false
   positives among the binaries. Content-grep is *not* safe here: `<?=` is three bytes, and
   over 7 MB of WASM a random occurrence is likely, not rare.
   Also corrected: the design's "11 PHP files" are the `.php` *libraries*
   (`backend/` x4, `languages/` x6, `errors/template.php`) and they are **never served**.
   The build excludes them, along with `public_html/.user.ini` (php-fpm runtime config that
   even hardcodes upstream's own `session.save_path`). 266 files in → 12 excluded, 27
   rendered, 227 copied verbatim, 254 published.

3. **221 of 252 resource entries carry a HARDCODED SRI checksum — and `scripts/node.js`
   is one of them.** They are plain `base64(sha512(bytes))` of the pristine file. All 221
   were recomputed and verified against the vendored tree (a second, cryptographic proof
   that the pin is byte-exact, independent of the `diff -r`).
   `scripts/node.js` (Version 41, SRI present) is **precisely the file the overlay patches** to
   make our Grin nodes the default. Patch it without refreshing the checksum and the browser
   refuses to execute it on integrity grounds — the wallet never boots, and the console error
   points at SRI, not at us. So `_acb_apply_patches` now recomputes the checksum **and bumps
   the cache version** for every patched file. **Adding a patch only means dropping a file in `patches/`.**
   - Order matters: patches are overlaid on a **staging copy**, and PHP renders *from* it.
     That is also why patching `backend/resources.php` works, and why `service_worker.js`
     (which embeds the whole `$files` table as JSON) automatically picks up the new sums.
   - Upstream's own invariant, worth keeping: **every PHP-rendered file has
     `Checksum => NULL`.** You cannot SRI bytes that vary per deployment. If a patch ever
     makes a currently-static file templated, its checksum must go NULL too.
   - The rewriter hard-fails if a path *is* listed in `$files` but its `"Version"` /
     `"Checksum"` lines no longer match — i.e. an upstream bump reformatted the table. A
     silently stale SRI is a page that will not load; failing the build is strictly better.
     **The guard is on the FIELDS, not on the block's braces** (see the review note below):
     finding the entry proves nothing, because a rewriter that finds a block and matches
     none of its lines copies them through untouched and still reports success.
   - `$files` is not the only table in `resources.php` — `ATTRIBUTIONS` follows it with 22
     name-keyed entries carrying `URL`/`License Path`/`License Type` and **no** Version or
     Checksum. Exit code map: `0` rewritten, `3` no such entry, `4` found but drifted.

4. **PHP CLI prints warnings to STDOUT.** Rendering redirects stdout into the built file, so
   a single undefined-index notice would be injected straight into `index.html` or the
   manifest. Every render forces `display_errors=stderr`, treats a non-zero rc or an empty
   output as fatal, and surfaces any stderr instead of swallowing it.

5. **Build deps are `php-cli php-mbstring php-intl`** — `intl` is not optional
   (`locale_accept_from_http`, `NumberFormatter`) and is easy to miss. Separately,
   `backend/language.php:604` calls `setlocale(LC_ALL, "en_US.UTF-8")`, which **fails
   silently** on a minimal Debian where that locale was never generated, changing the
   `strcoll()` order of the language menu. Harmless to the wallet, but it stops two boxes
   producing identical bytes, so `acb_check_deps` warns and prints
   `apt-get install -y locales && locale-gen en_US.UTF-8`.

- **PHP files** — the 11 PHP files are `backend/{additional_text,common,language,resources}.php`,
  `errors/template.php`, and six `languages/*.php`. `public_html/.user.ini` is a php-fpm
  *runtime* config (it even hardcodes upstream's `session.save_path=/srv/mwcwallet.com/sessions`)
  — it must **not** be deployed, since PHP is build-time only.

### Known, accepted degradations of prerendering

- `site.webmanifest` picks desktop-vs-mobile app icons from the User-Agent. Prerendered,
  everyone gets the desktop set — same sizes, same files, cosmetic only. If it ever matters,
  the overlay drops the `Mobile Only` split.
- `errors/503.html` / `errors/error.html` branch on `Referer` + `REQUEST_URI` to hide the URL
  and to 404 a direct hit. With `REQUEST_URI="/"` they render as the plain maintenance/error
  page, which is the right fallback. **Whether nginx points `error_page` at them at all is
  a deployment decision** — nginx's own pages are a valid alternative.
- Language is negotiated per request upstream; here one `en-US` render is the whole site,
  because `scripts/languages.js` embeds every translation as JSON and switching is
  client-side. That is a *correction* to the design, not a degradation.

**The SRI refresh works, and it now has a NULL mode.** The overlay patches `scripts/node.js` and eight
other files that carry a hardcoded checksum (see *What the build had to account for*); `_acb_apply_patches` recomputed all
nine and every one was verified against the patched bytes. Using the machinery for real also
found the hole in it — see *Build notes*.

### The standalone builder: a loop, where upstream has 253 `sed` commands

The spec is `vendor/upstream-standalone-build/build.sh` lines 39–311 — 273 lines, **253 of them
machine-generated `sed -i`**, each naming one file path and one HTML attribute verbatim.
Transcribing it would have produced a build that silently stops inlining an asset the moment a
path changes — and **our own overlay already changes several**: the overlay replaced the whole raster
icon set with one SVG, so a large part of build.sh's image list does not exist in our tree at
all. Every phase therefore *discovers* its asset list from the rendered files; upstream's list
was used only as proof that the phases are the right ones.

Seven phases, and the order is not free:

| | Phase | Discovered from |
|---|---|---|
| A | strip the head links that only make sense on a served site | 7 line patterns (markup, not assets) |
| B | images → `data:` URIs in `index.html` | `(src\|href)="\./…"` |
| C | shaders / model / WASM → `data:` URIs in the `.js` that loads them | `"." + getResource(…)` |
| D | fonts → `data:` URIs in the rendered `.css` | `url("…")`, resolved per stylesheet |
| E | the workers' `importScripts()` → the imported file's text | `importScripts("…");` |
| F | workers → `<script type="javascript/worker">` + a Blob URL rewrite | `scripts/*_worker.js` |
| G+H | stylesheets and scripts → `<style>` / `<script>` in the page | `<link href>` / `<script src>` |

- **C/D/E must precede F/G/H**: once a `.js` or `.css` has been folded into the page it is no
  longer a file anything can substitute into. **F must precede H**, because F rewrites the very
  scripts (`slate.js`, `output.js`, `camera.js`) that H then inlines.
- **Phase F is the one piece of upstream cleverness worth carrying verbatim.** A `Worker` needs
  a URL and a standalone page has none, so the worker's source is parked in the page as
  `<script id="slate_worker" type="javascript/worker">` — a type no browser executes — and
  `Slate.WORKER_FILE_LOCATION` is rewritten to
  `URL.createObjectURL(new Blob([…textContent], {"type": "application/javascript"}))`. Ours
  derives the triple (`<name>_worker.js` → `<name>.js` → class `<Name>`) and **verifies the
  constant exists before rewriting anything**, skipping with a warning rather than half-
  processing a worker it cannot place.
- **Phase C resolves both reference forms.** `getResource("./scripts/X.wasm")` is a literal;
  `getResource(Logo.MODEL_FILE_LOCATION)` is a class constant whose `static get` returns the
  path, and the getter is looked up across *every* script because nothing guarantees it lives
  in the file that calls it.
- **Every substitution is applied from a sed SCRIPT FILE, never an argv expression.** The
  secp256k1 WASM is ~2 MB, its base64 ~2.7 MB, and a single sed argument that size is at or
  over `ARG_MAX`. Upstream hit exactly this and had to convert two of its own substitutions to
  a here-doc; a script file sidesteps it for all of them. Base64 contains no `#`, `&` or `\`,
  so `s#…#…#` is safe by construction.
- **The env contract is the only difference from a hosted build.** `_acb_render_one` now
  branches on `_ACB_STANDALONE`: hosted runs `env -u NO_FILE_VERSIONS -u NO_FILE_CHECKSUMS -u
  NO_MINIFIED_FILES` (absent = features ON, see above), standalone sets all three (present =
  OFF). Versions and SRI are meaningless once nothing is fetched, and leaving SRI on would have
  the browser check a hash against bytes it no longer loads.
- **Same gates as the hosted build, and they matter more here**: `acv_verify_vendor` must pass
  before a single file is staged. This artefact is handed to someone to run *offline*, where
  nothing will ever re-check it and no security update can reach it.
- Post-conditions: no `<?php` anywhere in the output, and a **warning** (never a failure) with
  the count of relative references left behind — upstream's own artefact leaves a handful, for
  features that do not work offline anyway, so a hard failure would be wrong. The count is
  printed so a jump in it gets noticed.
- Output: `$ACC_DIR/standalone/accio-wallet-<net>-v<upstream version>.html` plus a `.sha256`,
  and a `current.html` copy for the download route. The name is ours (naming policy layer 1) —
  nothing about a file an operator hands out should say MWC.

### ⚠ Three things that look like omissions and are load-bearing — do not "fix" them

1. **`.js` is absent from `_acb_sa_mime` on purpose.** `"." + getResource("./scripts/slate_worker.js")`
   is the *body* of `Slate.WORKER_FILE_LOCATION`, and phase F rewrites that constant at its call
   sites into a Blob URL. Inline the getter's path in phase C and phase F has nothing left to
   point at. Verified: the only 3 `.js` literals phase C sees are exactly the three worker getters.
2. **Dropping `defer` when inlining is upstream's behaviour**, not our regression — `build.sh`'s
   `i --><script>` also emits a bare tag.
3. **Phase F's `.*` still must never become `[^>]*`** (already in CLAUDE.md).

## Gateway

**Status:** `/tor/` forwarder built 2026-08-09, `/listen` and the per-wallet inbound URL built 2026-08-10, both reviewed 2026-08-11 → 2026-08-12, not VPS-tested. Zero npm dependencies; its install makes no network request.

**Outcome: `web/052_accio/gateway/` and `scripts/lib/052_lib_gateway.sh`, and 052's key `3`
"Gateway service" is LIVE.** This is the first thing Accio does that a static site cannot: a
browser tab cannot open a TCP connection to a hidden service, so sending a slate to a payee's
`.onion` needs a forwarder. Three of upstream's four nginx C modules collapse into it, which
is what lets the whole product run behind **stock nginx from apt** — a module `.so` built
against the exact installed nginx makes `load_module` fail after an `apt upgrade nginx`, and
nginx then refuses to start *at all*, taking every other vhost on the box with it.

**Public entries** — `acg_gateway_menu`, `acg_install_gateway`, `acg_nginx_glue`,
`acg_selftest`, `acg_service_ctl`, `acg_status`, `acg_logs`, `acg_uninstall_gateway`.

**The listen rail's input contract was `script052_design.md` §"Listen protocol" and nothing else, and it
held** — `listener.js` was never opened while writing it. The same rule applies to anyone touching the
listen rail later: the spec is the contract, and re-reading the 1901-line client is the
compaction that spec exists to prevent.

### The five modules, and why the guard is its own file

```
server.js      two listeners, routing, counters, /health, shutdown
config.js      gateway.json loader — every default is the SAFE value
guard.js       the whole of "no": parsing + destination/path/method/Origin/Content-Type
socks5.js      RFC 1928 + 1929 CONNECT client, zero dependencies
tor_route.js   the forward + both header allowlists
```

`guard.js` is pure — no sockets, no I/O, inputs in and a verdict out. That is deliberate: it
replaces `Block-Access`, which was a battle-tested C filter, and ours is not. Being pure is
what makes it exhaustively testable, and the audit reads that one file.

### Six decisions where the gateway differs from upstream's nginx layer

1. **The port is 7480/7490, not `:9000`.** The design's gateway text says "listening 127.0.0.1:9000
   (upstream uses ip6-localhost:9000)". Two things wrong with inheriting that: 7480/7490 had already
   been chosen after checking the whole repo for collisions, and `:9000` is upstream's
   **WebSocket-Listener** port — its SOCKS proxy is `:9050`. Copying `9000` would have put our
   Tor forwarder on the port the `/listen` rail is described against.

2. **SOCKS5 is hand-written, not `socks-proxy-agent`.** ~90 lines against one command
   (CONNECT), one address type (domain name) and one optional auth method. The package is
   fine; the objection is specific — this process is the only part of Accio that handles bytes
   chosen by an arbitrary hidden service, so its transitive tree (agent-base, socks,
   smart-buffer, ip-address, debug) becomes supply chain on a *wallet* front end, and
   reintroducing an unpinned npm fetch at install time hands back exactly what vendoring bought. **The gateway has no npm dependencies and its install makes no network
   request.** If a later rail genuinely needs `ws`, that is a decision to take then, on its own merits.
   - Side benefit that turned out to matter: passing the hostname to Tor (ATYP `0x03`) means
     this process **never resolves a name**, so there is no window between "the guard checked
     the host" and "the socket connected" — DNS rebinding has nothing to rebind.
   - The SOCKS username is used as Tor's circuit-isolation selector (`IsolateSOCKSAuth` is on
     by default), set to the destination host: two payees never share a circuit, while a retry
     to the same payee reuses one instead of paying a fresh build.

3. **The `/tor/` regex must accept ONE *or two* slashes after the scheme.** nginx runs
   `merge_slashes on` by default, so `/tor/http://abc.onion/v2/foreign` has already become
   `/tor/http:/abc.onion/v2/foreign` by the time a proxied backend sees it. Upstream's own
   regex is `^/tor/(https?)://?(.+/.*)$` for exactly this reason. A `//`-only gateway passes
   every direct-to-loopback test and fails for every real browser — it would have looked like
   a working service that nobody could send from.

4. **`Cache-Control` is emitted by the gateway, and the nginx snippet has NO `add_header` at
   all.** Upstream sets it with `add_header` in the `/tor/` location. Stock nginx cannot do
   that safely here: an `add_header` anywhere in a location block discards **every**
   `add_header` inherited from the server block, so one line in this location would silently
   strip CSP and HSTS from precisely the route that talks to untrusted hidden services. The
   snippet carries that as a rule in its own header comment, in capitals, because the failure
   is invisible.

5. **Two `require_header` semantics had to come from the Block-Access source, not its README.**
   A leading `!` on the header name means the header is **OPTIONAL** (absent passes, present
   must match), and repeated directives for the *same* header are **OR-ed**. Both are recorded
   at the top of `guard.js`. Getting either backwards inverts the rule: AND-ing upstream's
   three `Origin` alternatives would refuse every request ever made, and reading `!` as "must
   be absent" would refuse every browser request. Note what this makes `Origin`: not an
   authorisation control (it is optional, and same-origin requests may omit it) but a cheap
   filter against a third-party page using us as an open proxy. The real controls are the
   destination and path checks.

6. **The onion port is fed by a second nginx server block, not by tor directly.** the original port note
   says "classify by `socket.localPort`", which is right, but left the static site unexplained:
   the wallet is ~7 MB of WASM that nginx should serve over the onion exactly as it does over
   TLS. So tor → nginx (onion server block) → gateway `tor_port`, while nginx (clearnet) →
   gateway `port`. The trust boundary is intact and the site is still served by nginx.
   `tor_port: 0` keeps the second listener closed until the onion is minted.

### Where we are stricter than upstream, on purpose

- **Onion shape.** Upstream checks only the TLD (`.onion`). We require a well-formed v3
  address — 56 base32 chars (`a-z2-7`), optional subdomains. `evil.onion` is not a reachable
  service but it *is* a name Tor would try to resolve, and the name is what the whole SSRF
  story rests on.
- **Read timeout 3 min, not 208 weeks.** Upstream's `socks_proxy_read_timeout 208w` is an
  unbounded resource hold any client can take out for free. A Foreign API call answers in
  milliseconds.
- **A hard `max_concurrent` (64) on in-flight forwards.** Without it, a few hundred requests
  to unreachable onions each hold a socket for the full connect timeout and the box runs out
  of descriptors — which takes down the products sharing it, not just Accio.
- **`X-Content-Type-Options: nosniff` on every response** — a hidden service picks its own
  Content-Type, and upstream's response allowlist has no way to add a header.
- **`Transfer-Encoding` is not copied back**, though upstream allows it: it is hop-by-hop and
  this process re-frames the body. `Content-Length` is dropped alongside it when the upstream
  answered chunked.
- **The onion front rate-limits itself** (one shared token bucket, 10 r/s burst 40). It has no
  nginx `limit_req` in front of it and no client identity to key on; inventing a key from a
  header would let the caller mint identities at will, which is the very thing the separate
  port exists to prevent. Deliberately one bucket — a weaker control, and an honest one.

### Privacy properties worth not regressing

- The forwarded request header set is upstream's six exactly (`Accept-Encoding`,
  `Content-Type`, `Content-Length`, `Authorization`, `Access-Control-Request-Headers`,
  `Access-Control-Request-Method`) plus a `Host` built from the *destination* and
  `Connection: close`. `Cookie`, `Referer`, `User-Agent`, `Accept-Language`, `Origin` and every
  `X-Forwarded-*` are absent by construction, so the payee's wallet learns nothing about the
  payer beyond the slate. Do not "just add one" to debug something.
- **`log_destinations` defaults to OFF and must stay off.** A `/tor/` destination is the
  payee's wallet address; a journal of those is the payment graph Grin exists in order not to
  have. The nginx snippet likewise passes no `X-Forwarded-For`, so the gateway never holds a
  visitor IP it could log.

- **Ports chosen** (checked free against the whole repo — 7420 Fidelius, 7456/7466/7556/7566
  Transporter, 7516/7517/7572 in use): gateway **7480** mainnet / **7490** testnet, onion
  front **7580** / **7590**. The onion deliberately gets its own local port — nginx and Tor
  both arrive on `127.0.0.1`, and a Tor client that can forge `X-Forwarded-For` would mint a
  fresh identity per request and void every per-client limit. This is 093's lesson, applied
  before the service exists rather than after.

**Outcome: Accio can now receive.** Four modules were added to the same service and the same
unit the `/tor/` forwarder built — `ws.js`, `store.js`, `listen_route.js`, `wallet_route.js` — replacing
upstream's `WebSocket-Listener`, the one component we may not ship at all (no `LICENSE`, no
`COPYING`, no licence mention in its README). The gateway still has **zero npm dependencies**.
Written entirely against §"Listen protocol" in the design doc; `listener.js` was never opened,
which is what the written protocol spec made possible.

| File | Lines | What it is |
|---|---|---|
| `ws.js` | ~340 | RFC 6455 server: handshake, framing, masking, fragmentation, control frames, ping/pong |
| `store.js` | ~300 | the suffix ↔ session table: mint, own, release, quotas, GC, durable snapshot |
| `listen_route.js` | ~480 | the protocol itself: four requests, interactions, the cancel/ack duality |
| `wallet_route.js` | ~150 | `/wallet/<suffix>/v2/foreign`: parse, normalise, CORS, body cap |

### Six decisions the design left open

1. **"Reuse 093 Transporter's Node+SQLite patterns" cannot be taken literally.** SQLite needs
   either an npm package — against the zero-dependency rule above — or
   `node:sqlite`, which requires Node 22.5+ and is still experimental while our floor is 18.
   What actually transfers is 093's two *lessons*, and both are honoured: capacity is
   partitioned per writer rather than per victim, and the wallet id is normalised at the route.
   The store is a debounced, atomically-renamed JSON snapshot — one small row per wallet, no
   queries, no joins, no ordering. If it ever grows a second index, revisit; not before.
2. **The snapshot is not a cache, and losing it is not a degraded mode.** The client discards
   any suffix the gateway stops recognising and immediately mints a new one, so an in-memory
   table changes **the receiving address of every wallet that has ever connected, on every
   restart** — i.e. on every routine deploy — while payments already travelling to an old
   address are answered 404 with nothing in the UI to explain it. This is the first thing this
   service writes to disk: `/opt/grin/accio-<net>/gateway-state/`, the **only**
   `ReadWritePaths` in an otherwise `ProtectSystem=strict` unit (exactly as the unit's comment asked
   — the path was added, not `ProtectSystem` relaxed). The self-test now fails loudly when the
   table is not durable, because nothing else on that screen would reveal it.
3. **A per-session socket cap must REFUSE, never evict** — see the bugs below.
4. **`ws.js` must handle `'end'`, not only `'error'` and `'close'`** — see the bugs below.
5. **The `Type` field relayed to the tab must be the BARE string `application/json`.** The
   client compares it for equality and answers 415 for anything else (§5), so passing through
   a perfectly ordinary `application/json; charset=utf-8` from the sender would fail every such
   payment with a media-type error nobody could explain. `wallet_route.js` verifies the real
   header; `listen_route.js` sends the constant.
6. **Three rate zones now, where the first version wrote one — and the helper will not add them.**
   `nginx_ensure_rate_limit_zones` is a no-op when its conf file already exists, which is
   precisely the state of a box that only ever had the `/tor/` rail (`script052-rate-limits.conf`, containing `accio_tor` alone).
   Left alone, the `/listen` snippet references `accio_listen`/`accio_wallet`, nginx fails "unknown
   limit_req_zone", **and nginx then refuses to start at all**, taking Fidelius, GrinScan, the
   pool, Drop and the node API with it. `_acg_ensure_zones` detects the missing zones, backs
   the file up, regenerates it, and refuses to touch a file that is not ours.

### The eleven §11 decisions, as taken

The design listed these as ours; recording the answers here so the audit checks decisions rather than
re-deriving them.

| # | Decision |
|---|---|
| 1 | Session = 256-bit CSPRNG id, opaque, looked up server-side (no MAC — a forged cookie must *guess* an entry, and a MAC would put a secret in a service whose claim is that it holds none). Cookie `HttpOnly`, `SameSite=Lax`, `Path=/listen`, `Secure` **auto** |
| 2 | Suffix = 16 chars of lowercase RFC 4648 base32 = **80 bits**, unbiased (32 symbols, 5-bit mask). Lowercase is enforced, not assumed — §9's trap is silent and permanent |
| 3 | 16 suffixes/session, 100 000 global, 8 sockets/session, 512 global, 20 msg/s (burst 60) per socket |
| 4 | Suffixes die **with their session** (90-day rolling ttl). No separate suffix ttl: one outliving its session could never be claimed again, and one expiring inside a live session would change a working address under a user who did nothing wrong. Orphaned `Create URL`s are reclaimed by evicting the oldest **unverified** suffix when the per-session cap bites — `Own URL` is the only signal the protocol gives that a client actually kept what we minted |
| 5 | Offline payee → **503 immediately** with `Retry-After`, not parked. Upstream holds the request for `proxy_read_timeout 208w`; a wallet that is not open genuinely cannot receive, and saying so lets the sender retry. Connected-but-silent tab → cancel + **504** at 180 s |
| 6 | Interaction ids: per-connection integers from 1. `Number.isSafeInteger` guarded, because `toFixed()` is called on them to build event namespaces |
| 7 | Inbound body cap **1 MB**, set explicitly in *both* nginx and the gateway (upstream sets none and silently inherits nginx's default) |
| 8 | Server pings every **25 s**, pong deadline 20 s; config refuses a ping interval ≥ 55 s outright |
| 9 | Unknown request name → `Error` response, never silence (silence costs the client a 120 s stall). A request with no numeric `Index` is dropped — there is nothing to correlate a reply to |
| 10 | Several sockets per session allowed; delivery goes to the **most recently opened** one. Broadcasting would ask several tabs to receive the same payment |
| 11 | Counts only, never a suffix, a session id, an origin or a peer. `log_destinations` (off by default) governs both rails |

**Also decided, and user-visible:** the onion front and the clearnet front are different
origins and therefore **different cookie jars**, so the same wallet reached both ways holds two
sessions and two receiving addresses. Accepted — arguably a privacy gain — but it means an
address minted over the onion is not the one shown over TLS.

### Ordering that is money-relevant, and must not be "tidied"

The ack is a commit point (§7): the tab records the received transaction only inside the
success branch of its reply. So `listen_route.js` writes the response to the **sender first**
and sends `{"Status":"Succeeded"}` only once the bytes have actually flushed (`finish`, with
`close`-before-`writableFinished` treated as failure). If the write fails, the tab is sent an
`Error` instead so it rolls back deliberately rather than by 120 s timeout. Anyone refactoring
this into "ack then respond" reintroduces the case where the tab records a payment the sender
never received. A JSON-RPC-level rejection still travels as **HTTP 200** and must not be
translated to a 4xx.

### The deploy side

- **Dedicated `grinaccio` system user, not `grin`.** This is the only Accio component exposed
  to bytes from an arbitrary hidden service, and `grin` owns node directories, wallet seeds and
  API secrets belonging to every other product on the box. The unit is hardened
  (`ProtectSystem=strict` with **no** `ReadWritePaths` — the gateway writes nothing at all;
  `CapabilityBoundingSet=`, `RestrictAddressFamilies`, `NoNewPrivileges`).
  `MemoryDenyWriteExecute` is deliberately **absent**: V8 JITs, and setting it makes node fail
  to start with an error that points nowhere useful.
- **One unit per network, `grin-accio-<short>`** — not the design's `grin-accio-gateway-<net>`.
  `052_grin_accio.sh` already defined `ACC_SERVICE` and its network badge that way before the
  gateway was written, and the `/listen` rail extends this same service rather than adding a second.
- **nginx glue is two artefacts plus an offer.** `nginx_ensure_rate_limit_zone accio_tor 10r/s`
  → `conf.d/script052-rate-limits.conf` (never an inline `limit_req_zone`), and the location
  block → `snippets/accio-<net>-gateway.conf`. The vhost `include` is inserted by awk that
  tracks brace depth (so it cannot land inside a nested `location{}`), targeting the `443`
  block and falling back to the first `server{}` for the pre-certbot HTTP-only file. It backs
  the vhost up first, runs `nginx -t`, and **restores on failure** — a broken nginx config does
  not just break Accio, it stops nginx starting and takes every vhost down. Uninstall removes
  the include too: a dangling `include` is the same failure.
- Deps are Node ≥18 (no `node:sqlite` needed here, unlike 059/093) and `tor` as a **client**;
  the install verifies `127.0.0.1:9050` is actually listening rather than trusting the unit
  state, because a tor with `SocksPort 0` looks healthy and forwards nothing.

## Nginx, TLS and the onion service

**Status:** built 2026-08-10, reviewed 2026-08-10 and 2026-08-12, not VPS-tested.

**Written:** `scripts/lib/052_lib_nginx.sh` (the web front — vhosts, certbot, Tor hidden
service, the standalone download route), `accio_build_standalone` + seven inlining phases in
`052_lib_build.sh`, a second front for `_acg_write_snippet` in `052_lib_gateway.sh`, real
`acc_install` / `acc_nginx` / `acc_standalone` / `acc_status` / `acc_uninstall` in
`052_grin_accio.sh` (**`_acc_stub` is deleted — there is no stub left in this product**), and
hub 05 key `2` switched to `run_sub "052_grin_accio.sh" || true`.

### Five decisions, each with the failure it avoids

1. **One header snippet, included by every block that adds a header of its own.**
   `/etc/nginx/snippets/accio-<net>-headers.conf` carries X-Frame-Options,
   X-Content-Type-Options, Referrer-Policy, COOP/COEP, CSP and Permissions-Policy. It carries
   **neither** `Cache-Control`, HSTS **nor** `Onion-Location`, and that omission is the design:
   those three differ per block or per front, so each block sets its own after including the
   shared set. This is the only structure that survives Liability 1's trap #1 —
   `add_header` in a child block *discards* the parent's set rather than merging with it, so
   the static-asset location (which must set `immutable`) and the standalone download location
   (which must set `Content-Disposition`) would otherwise each serve a wallet page with **no
   CSP at all**, silently and with nothing in the response but their absence.
   - **CSP is upstream's, verbatim**, `'unsafe-eval'` and `connect-src *` included. Each loose
     directive is load-bearing: `'unsafe-eval'` is how the WASM crypto instantiates,
     `'unsafe-inline'` is what the build's inlining produces, and `connect-src *` is the
     visitor pointing the wallet at their own node — the one thing a self-custodial wallet is
     for. Tightening it is a question to answer with the wallet in front of you (see *The CSP, answered against the source*).
   - **HSTS drops `includeSubDomains` and `preload`**, unlike upstream. Upstream owns its whole
     apex; this toolkit does not — the same box routinely serves `api.`, `testapi.`, `scan.`
     and a pool vhost, and an operator deploying Accio at an apex would be forcing HTTPS onto
     every sibling host that exists now or ever will, from one wallet's vhost.
   - `more_clear_headers Server` still has no stock equivalent. `server_tokens off` is as far
     as nginx goes, and that is accepted rather than worked around.

2. **The onion front needs its own gateway snippet, not a second include of the first.**
   `_acg_write_snippet` now takes a front — `nginx` (127.0.0.1:$ACC_PORT) or `onion`
   (127.0.0.1:$ACC_TOR_PORT). Including the clearnet snippet from the onion vhost would send
   Tor traffic to the port whose forwarding headers the gateway *trusts*, which voids the
   entire reason the two ports exist (the gateway classifies by `socket.localPort`; a Tor
   client controls its own headers and could otherwise forge `X-Forwarded-For` and mint a
   fresh identity per request).
   - **The onion copy carries no `limit_req`, deliberately.** Every Tor visitor arrives from
     127.0.0.1, so `$binary_remote_addr` is a single key for all of them: a zone that *looks*
     per-client is one global bucket, and the first busy visitor 503s everyone else. The
     gateway already meters that front on purpose (`onion_rate_per_second`,
     `onion_inbound_rate_per_second`) — the same global limit, applied knowingly, with an
     error that explains itself instead of one that blames nginx.
   - `acg_nginx_glue` writes both snippets unconditionally, even with no hidden service
     configured. It costs one file, nothing includes it until the onion vhost exists, and the
     alternative — writing it only once Tor is up — means an operator who enables the onion
     first gets a `.onion` that serves the static page and 404s every gateway route.
   - `acg_uninstall_gateway` now sweeps **both** vhosts for a dangling include. Leaving the
     onion vhost pointing at a deleted snippet is the same box-wide outage as leaving the
     clearnet one, by a different file name.

3. **Minting the onion is not the end of the job — the site must be rebuilt.**
   `TOR_SERVER_ADDRESS` is baked in at *build* time; it is what the wallet's "Onion Service"
   address type hands out. An onion that exists but was never built in therefore advertises a
   **clearnet** host to the visitor who specifically chose the onion. So: `acn_onion_enable`
   and the certificate step both call `_acn_offer_rebuild`, which states plainly what is stale
   and warns loudly if the rebuild is declined; `acn_status` and `acc_status` compare
   `site.BUILD_INFO`'s recorded onion against the configured one and flag a mismatch. Disabling
   the onion runs the same path in reverse, and drops `Onion-Location` from the clearnet vhost
   — advertising an onion that no longer answers sends every Tor Browser visitor to a dead
   address.

4. **Location order is load-bearing, and the naive install gets it wrong.**
   nginx tries regex locations in source order. The static-asset location
   (`~* \.(?:js|css|json|wasm|…)$`) is unanchored, so it can match a `/tor/` destination path
   and answer it as a missing file. The vhost writer therefore emits the gateway include
   *first* — but on a first deploy the snippet does not exist yet (the gateway is installed
   after the web front), so `acg_nginx_glue` appends its own include at the **end** of the
   server block, i.e. after the asset location. Fixed with `acn_refresh_vhost`: a
   prompt-free regeneration from config that both `acc_install` (after the glue) and
   `acg_nginx_glue` itself (when the lib is loadable) call, which rewrites the file wholesale
   so the appended copy disappears and the correctly placed one takes over.
   Impact if it were left: no *legitimate* request is affected (the gateway's own path pattern
   is `^(?:/.+)?/v2/foreign$`, which never ends in an asset extension, and `location = /listen`
   is an exact match that beats every regex), so this is a wrong error code rather than a hole
   — but the invariant is documented in three files and code that violates it is how the next
   person learns the wrong lesson.

5. **The standalone artefact is served as a download, not as a page.** It is made of `data:`
   URIs, which this site's own CSP forbids; rendered in place it would half-load and look
   broken. `location = /standalone.html` aliases `$ACC_DIR/standalone/current.html` and sets
   `Content-Disposition: attachment`. `current.html` is a **copy, not a symlink** — nginx can
   be configured with `disable_symlinks on`, and a download that 403s on some boxes and not
   others is worse than 10 MB of disk.

### Port map of the onion path

Three listeners, three ports — see *Build notes* for the collision this table prevents.

| claimant | was | now |
|---|---|---|
| nginx onion block `listen` | `127.0.0.1:$ACC_TOR_PORT` | `127.0.0.1:$ACC_TOR_FRONT_PORT` **(new: 7581/7591)** |
| torrc `HiddenServicePort` → | `127.0.0.1:$ACC_TOR_PORT` | `127.0.0.1:$ACC_TOR_FRONT_PORT` |
| gateway `listen()` (`server.js:295`) | `127.0.0.1:$ACC_TOR_PORT` | unchanged |
| onion snippet `proxy_pass` | `127.0.0.1:$ACC_TOR_PORT` | unchanged — the only one already right |

Also settled while writing the vhosts: no `/.well-known/acme-challenge/` webroot location.
`certbot --nginx` inserts its own for the duration of a challenge, and a webroot rooted at the
site directory would be a trap — **every build replaces that directory by an atomic rename**,
so a challenge file could be swapped out from under certbot between the write and the fetch.

### Hub 05 wiring

The `_slot_notice` arm for key `2` is **deleted, not aliased** — a key that changed hands never
keeps an alias (CLAUDE.md: a second `case` arm is dead code, and if reached would open the
wrong product with no error). Key `2` is now `run_sub "052_grin_accio.sh" || true`.

The stated reason for deferring the wiring was that *wiring a menu of stubs advertises a product
that cannot do anything*. That condition is now gone: every key does what it names. What has
**not** changed is that nothing has run on a VPS, so three places say so plainly — the 052
banner, the network submenu, and hub 05's own header. A menu with no stubs is not a tested one.

Hub 05 also gained `_052_installed` / `_052_status` and a status row, keyed on
`grin_accio.conf` rather than on the gateway unit: the site can be deployed and serving with
the gateway not yet installed, and a row calling that "not installed" would hide the exact
thing an operator is looking for.

## Overlay, branding and the MQS reduction

**Status:** overlay built 2026-08-10, MQS reduction built 2026-08-11, branding reviewed 2026-08-12, not VPS-tested. `ACCIO PATCH` is the review index — see `patches/README.md`.

**The overlay is `web/052_accio/patches/public_html/`** (current file and marker counts → *Current state*). Every deviation
from upstream carries the marker `ACCIO PATCH` followed by its reasoning; `grep -rn "ACCIO
PATCH" web/052_accio/patches/` is the index of the overlay, and the right way to review it (a
`diff` against `vendor/` is dominated by two 170 KB files in which four lines changed).

### Two files rebrand the whole app

The obvious reading of "Accio branding" is a whole-file overlay of everything that says MWC:
`index.html`, `site.webmanifest`, `errors/template.php`, the eight `errors/*.html`, the five
`languages/*.php`, plus the JS. That is **~1.2 MB** of duplicated upstream, and five large
translation tables that every future upstream translation update would then have to be merged
into by hand.

It collapses to two files, because of a property of this codebase worth stating plainly:
**every user-visible string in the app is a translation, and every translation passes through
`getDefaultTranslation()` or `getTranslation()`** — once server-side in `backend/language.php`,
once client-side in `scripts/language.js`. A phrase map applied at those two points rebrands
the entire product, in all six languages, including files we never touch.

The map is applied in three places, and all three are required:

| Where | What | Why it is not optional |
|---|---|---|
| `getDefaultTranslation($text)` | brand the input | this string becomes the `data-text` attribute — the key the client-side translator looks up later |
| `getTranslation($text)` | brand the lookup key | the table is branded, so an unbranded key stops matching and the string silently falls back to English |
| `getAvailableLanguages()` | brand every **key and value** of each `Text` table | `scripts/languages.js` re-exports this table to the browser verbatim; brand only the values and every client that switches language gets "MWC Wallet" back |

`scripts/language.js` carries the identical map for the client side. **If the two ever diverge
the failure is silent** — not an error, just a string quietly rendering in English.

Consequences worth knowing before someone "simplifies" this:

- **An upstream bump cannot reintroduce MWC text.** New strings are branded on arrival.
- **Nothing in the built output says where "Accio" came from.** The map is the single place to
  look, which is why `patches/README.md` names it first.
- It is **phrases only** — `"MWC Wallet"` and `"MimbleWimble Coin"`. Never the bare token
  `MWC`: that is the ticker and a protocol discriminator (design §"Naming policy" layer 3).

### Arguments are matched WHOLE-VALUE, never by substring

`Language.getTranslation(text, textArguments)` also brands its arguments, which is how
upstream's URLs get replaced without patching the 266 KB `application.js` that contains them:
`https://mwcwallet.com` becomes this deployment's own `HTTPS_SERVER_ADDRESS`, upstream's onion
becomes `TOR_SERVER_ADDRESS`, and the three `MWC-Wallet-*/releases` links become our releases
page.

That argument list also carries **user data** — wallet names, addresses, file names. A
substring rule there would silently rewrite a user's own text, so `brandArgument()` matches the
whole value or leaves it alone; no user value equals one of upstream's URLs by accident. (It
also uses `Object.prototype.hasOwnProperty.call`, because `"toString" in {}` is `true`.)

**This is not decoration.** The string it fixes is the wallet's anti-phishing line — *"Make
sure that you're accessing … for free from its official site at %1$m"* — shown on the screen
where a user is about to type a passphrase. Shipped unpatched it would have told Accio users
that the official site is `mwcwallet.com`.

### The credit, and the trap it set

`ATTRIBUTIONS["MWC Wallet"]` in `backend/resources.php`, linking upstream's repo and
`./MWC Wallet license.txt` (a byte-identical copy of `vendor/upstream-wallet/LICENSE`,
sha256 `bbc8b96c…`, matching PROVENANCE). Rendered by `about_section.js` in the app's own
idiom, next to jQuery and BLAKE2b. Upstream's copyright line in the About section
("© 2022–… Nicolas Flamel.") stays verbatim — that is the licence condition, not a courtesy.

**The trap:** the first draft put `https://github.com/NicolasFlamel1/mwcwallet.com` in
`brandLinks` as "the source-code URL", which would have rewritten *the credit's own link to
point at us*. The same literal means two different things — "where this build's source lives"
and "the work we forked" — and no map can tell them apart. Fixed by patching
`about_section.js` explicitly for the source link (which also collapses upstream's four-way
extension/standalone/mobile/site branch, since Accio is one repository) and removing that URL
from the map. Covered by a test asserting the credit's name, URL and licence path all survive
branding untouched.

### Four decisions: icons, the logo, the Donate section, the translation contact

**1. Icons are SVG-only.** Upstream ships `favicon.ico`, 20 app-icon PNGs, 8 touch-icon PNGs
and 4 tile PNGs — 33 rasters of the MWC mark. The build is offline and deterministic by
design, so it *cannot* rasterise at build time, and hand-committing 33 PNGs was not something
this session could do well. So `FAVICONS`, `TOUCH_ICONS` and `TILE_IMAGES` are emptied and
`APP_ICONS` holds one SVG. The alternative — leaving them populated — means shipping the MWC
bowtie as our favicon, the exact leak branding exists to close. SVG-only is also this
repo's house convention: 051, 06b, 06d and the 07 pool all ship an SVG favicon and no raster
set.

- `site.webmanifest` needed its own patch for this: upstream's loop emits only the five-part
  `APP_ICONS` entries and hardcodes `"type": "image/png"`, so a one-part SVG entry produced
  `"icons": []` — **a manifest with no icons is a PWA that will not offer to install.**
- The PNG *files* stay in the tree, unreferenced (~100 KB); deleting them is a later deletion pass.
- **The one real loss is the iOS home-screen touch icon**, which has no SVG form. Recipe to
  add it later, no code change required: rasterise `images/app_icons/app_icon.svg` at
  57/76/114/120/144/152/167/180 px (`rsvg-convert -w N -h N`), drop the PNGs into
  `patches/public_html/images/touch_icons/`, and restore the `TOUCH_ICONS` array.

**2. The 3D logo is suppressed, not deleted.** `scripts/logo.js` renders a WebGL model from
`./models/mwc.json` — upstream's MWC mark, spinning, on the wallet screen. There is no Grin
model to swap in, so the design schedules it for deletion in the second deletion pass — but **that pass lands
after launch**, which would mean launching Accio with a rotating MWC logo. Suppressed
now, reversibly, in two lines.

> The interesting part is *which* two lines. Killing WebGL alone is not enough and is actively
> worse: `allowShowing()` gates on `this.compatible`, which stays `true`, so `main` still gets
> class `logo` — and the rule `main.logo > div > div > div.logo` **hides the SVG wordmark** to
> make room for a canvas that can never paint. The page would then show *no* logo at all.
> Setting `compatible = false` takes the path a browser without WebGL takes, and the CSS keeps
> the SVG mark. (Upstream has the same latent bug for genuinely WebGL-less browsers.)

**3. The Donate section is removed.** Its four rows were Bitcoin / MimbleWimble Coin / Grin /
Epic Cash, every one a `https://mwcwallet.com/donate/*` link in plain markup — the brand layer
cannot touch a raw `<a>`, and keeping them would route an Accio user's donation to upstream
without saying so. We have no address of our own, and inventing one is not ours to do.
`about_section.js:addDonateInformation()` prepends to `div.donate`; with the div gone that
`find()` is empty and `prepend()` is a no-op, so nothing else needed touching. **Restoring it
is one `<h3>` and one `<li>` with the operator's Grin address — an operator decision at deploy.**

**4. The translation contact became our issue tracker.** Upstream invites translators to email
`nicolasflamel@mwcwallet.com`. We have no mailbox, so the argument maps to
`…/Grin-Node-Toolkit/issues` and a third map entry rewrites the sentence around it
(`"You can email %1$m"` → `"You can open an issue at %1$m"`). Only the **English** phrasing
matches; the other five languages keep their own wording around a link that now goes to
GitHub. **If the operator wants a real address before launch, this is the one line to change** —
and doing so removes the sentence-rewrite entry too.

### Residual `mwc` in the published tree — the honest table

A verify line ("a case-insensitive `mwc` grep over the built output returns
only the About-section credit and the vendored `LICENSE`") **is not achievable, and it
contradicts the naming policy.** §"Naming policy" layer 3 says MWC
*identifiers* must be deleted by later deletion passes, never renamed — so they are still there, by design.

Measured over the files that ship byte-for-byte (excluding `*.php`, `backend/`, `languages/`,
`.user.ini`, and the templated files whose bytes PHP replaces):

| Count | Category | Disposition |
|---|---|---|
| 195 | Layer-3 identifiers — `Consensus.MWC_WALLET_TYPE`, MWC node URLs, `explorer.mwc.mw`, `web+mwc`, `"mwcmain"`, the `.mwc` CSS class | **Later deletion passes.** Unreachable: `getWalletType()` can no longer return MWC |
| 25 | Our own `ACCIO PATCH` comments and the brand map itself | intended |
| 16 | Source literals inside `getDefaultTranslation('… MWC Wallet …')` | rewritten at runtime; a user sees "Accio" |
| 8 | Firefox / Chrome / Edge / Opera add-on store URLs in `application.js` | dormant — reachable only from inside a browser extension, which we do not ship. Revisit if one is ever built |
| 1 | The byte sequence `mwc` inside `font_awesome-5.15.4.woff2` | coincidence |
| 1 | `privacy_policy.txt`'s credit sentence | **intended** |

Plus, in the *rendered* `index.html`: the `ATTRIBUTIONS` JSON carrying the credit — name, URL
and licence path, three occurrences on one line. **Zero user-visible MWC strings.**

Use this table as the deletion progress meter, not a bare grep count. The number that should fall is
the 195.

### Smaller things worth not rediscovering

- **This pin has no minified files.** All 252 `$files` entries are `"Minified" => FALSE`, so
  `getResource()` never rewrites a patched path to a `.min` variant our overlay did not
  produce. Worth re-checking after any upstream bump — it would silently bypass every patch.
- **The MWC glyph font is no longer fetched.** `fonts/mwc/` holds the MimbleWimble Coin
  currency symbol, and only `language.js`'s `case Consensus.MWC_WALLET_TYPE` renders it, so the
  `<link rel="preload">` and its stylesheet were two round trips on every visit for a glyph
  nothing can produce. Deleting the font *files* and the `.mwc` rule in `styles/common.css` is
  still the third deletion pass; this only stops fetching them.
- **`Consensus.WALLET_MWC_TEXT_VALUE` and `WALLET_GRIN_TEXT_VALUE` now both evaluate to
  "Grin"** (both are `getDefaultTranslation` calls, and the map rewrites the first). Harmless:
  the only place they are distinguished is the `switch` in the unreachable
  `getWalletTypeUpstream()`. Do not "fix" it by special-casing the map.
- **`getWalletTypeUpstream()` is upstream's resolution logic, kept verbatim and unreachable.**
  Deleting it would turn a one-block diff into a 100-line rewrite and make the next upstream
  change to that logic unreviewable.
- **The wallet-type `<option>` value must stay `"1"`.** It is `Consensus.GRIN_WALLET_TYPE`, a
  consensus discriminator, not a menu index.
- **`privacy_policy.txt` is now ours and makes factual claims about the gateway** — that the
  `/tor/` relay does not store requests, and that nginx's access log records the destination
  onion in the request line. Both match `gateway/tor_route.js` today (it logs only errors).
  **Re-verify this against the deployed nginx config at acceptance**, because a privacy policy that
  is wrong about logging is worse than no policy.
- Brand colour is **violet `#9400D3`**, from this repo's house palette
  (`web/0z0_media/logo_favi/grin_violet.svg`), chosen because it sits beside upstream's
  existing `#7A00D9` theme — so the marks drop in with **zero CSS changes**. `BACKGROUND_COLOR`
  and `THEME_COLOR` are deliberately left as upstream set them.

**`check_for_updates.js` is dead code in a hosted build.** Its three repointed URL pairs sit in
the extension / mobile-app / `file://` branches; the hosted `else` sets no URL and *hides* the
update-check setting entirely. Kept anyway — it costs one overlay file and it is correct if a
standalone artefact is ever built — but do not expect to see it do anything on the VPS, and
note `noobvie/Grin-Node-Toolkit` has no releases, so `/releases/latest` would 404 if it ran.

**Deliverable: one new overlay file, `patches/public_html/scripts/mqs.js`.** Upstream's is 1,361
lines / 38,479 bytes; ours is 105 / 4,161. Nothing else in the repo changed — the overlay
machinery handles a new patch file on its own, including the SRI refresh.

### What MQS is, and why it was first on the list

MQS is MimbleWimble Coin's "message queue service" — a slate transport. `Mqs.sendRequest` opens a
**WebSocket to a host named inside the recipient string**, subscribes to a queue keyed by a
secp256k1 address, signs a challenge the server issues, and exchanges PBKDF2 + AES-GCM payloads.
Accio receives over Tor and the gateway. None of that is ours to run, and an unreachable network
client that dials an attacker-chosen host is exactly the sort of thing a self-custodial wallet
should not be carrying around.

### Why this is a reduction and not an `rm`, and why that is not a cop-out

The design's order — "MQS then 3D logo/Tetris then non-Grin fonts (**all free**)" — is right
about two of the three. MQS is not free, and the reason is worth recording because it will recur.

**Five symbols of the class are referenced from outside it, 36 times, across five files we do not
patch:** `api.js` (17,419 lines), `slate.js` (6,763), `hardware_wallet.js` (8,501),
`wallet.js` (4,226), `send_payment_section.js` (3,537) — 40,446 lines, 1.65 MB. Overlaying those
to remove the references would turn every future `git log <PIN>..upstream` review into a manual
merge — the precise cost the overlay design avoids.

The references are **not** evenly spread, and the shape matters: `ADDRESS_LENGTH` alone accounts
for 16 of the 36, and 8 of those 16 are in `slate.js`.

Worse, one of the references is on the money path. `Slate.compactProofAddress` switches on
`Mqs.ADDRESS_LENGTH` and is **not** wallet-type-gated: it runs on every payment-proof slate we
*encode*. Delete the file and that becomes `ReferenceError: Mqs is not defined` on every send
with a payment proof. A "free" cleanup that breaks sending is not a cleanup.

So the external surface stays and everything behind it goes:

| Kept (the 5 external symbols) | Deleted |
|---|---|
| `ADDRESS_LENGTH` → 52 | `sendRequest` — the WebSocket client, subscription protocol, challenge signing, reconnect loop |
| `publicKeyToMqsAddress` → throws | `encrypt` / `decrypt` — PBKDF2-derived AES-GCM |
| `mqsAddressToPublicKey` → throws | `getAddressVersion` — the MWC/EPIC version bytes |
| `isValidAddressWithHost` → `false` | 21 of the 22 static getters — every constant only the above used |
| `sendRequest` → rejects | |

### Why it changes no behaviour — provably, not by inspection

`Consensus.getWalletType()` returns Grin unconditionally (the overlay's `consensus.js`), and upstream's
MQS is **already dead in Grin mode**:

- `getAddressVersion()` has `case` arms for MWC and EPIC **only**, so it returns `undefined` for
  Grin. Both codecs then fault on `version["length"]` before they can produce or accept an
  address. They could only ever throw. They now throw upstream's own error strings
  (`"Invalid MQS address."`, `"Invalid public key."`) instead of a `TypeError`.

  That last difference is real and worth stating precisely rather than waving away. Most call
  sites `try`/`catch` and convert to a fixed message (`"Unsupported slate."`, `"Unsupported
  response from the recipient."`) or sit in a promise chain that rejects. **Two do not:**
  `Slate.compactProofAddress` and `Slate.uncompactProofAddress` have no local handler, so the
  thrown value propagates. It still cannot change control flow — the string
  `"Invalid MQS address."` appears **nowhere** in the tree outside `mqs.js`, so nothing branches
  on it, and both upstream and the stub fail the same call. The only reachable difference is the
  text of an error on a slate that is rejected either way. **No new user-visible string was
  introduced.**
- `isValidAddressWithHost()` catches that fault and returns `false`. It could only ever return
  `false`.
- `sendRequest` has exactly **one** caller, in `api.js`, inside `case Consensus.EPIC_WALLET_TYPE`.
  All five of those switches set `sendAsMqs = false` by hand in their MWC/GRIN arms. It is
  unreachable, not merely unused.

### What is deliberately kept, and why removing it would have been the real bug

`ADDRESS_LENGTH` is **wire format, not branding.** `slate.js` switches on a proof address's
*length* to decide how to parse it, and `Slate.uncompactProofAddress` reads a leading bit meaning
"this proof address is MQS". Drop the constant and a 52-character proof address stops being
rejected and starts falling into the **Tor** branch instead — a parsing change on the money path,
wearing a deletion's clothes. The rule this pass sets for every later one: *removing a subsystem
must not change how a slate is read, only what we do about one.*

### The MQS residual table

The file's case-insensitive `mwc` hit count is **unchanged at 2** — but the composition is the
point, and it is the composition the residual table above measures:

| | before | after |
|---|---|---|
| Layer-3 (`Consensus.MWC_WALLET_TYPE` + upstream's `// MWC wallet` comment) | 2 | **0** |
| Our own `ACCIO PATCH` comment prose | 0 | 2 |

Tree-wide that is **195 → 193** layer-3 hits and **25 → 27** of our own comments — the two
buckets' total is unchanged at 220, which is what "the raw count does not move" actually means.
Measured over the simulated published tree (the same file set as the residual table above: no `*.php`, `backend/`, `languages/`
or `.user.ini`), comparing the 16-patch baseline against this reduction's 17:

| Metric | 16-patch baseline | after the MQS reduction |
|---|---|---|
| case-insensitive `mwc` hits | 303 | **303** |
| `MWC_WALLET_TYPE` occurrences | 87 | **86** |
| `ACCIO PATCH` markers | 24 | **25** |

Anyone using a bare grep count as the deletion progress meter would score this pass at zero, which is
why the design says not to. The number that moved is 34,328 bytes and 1,256 lines of unreachable
transport and crypto.

**The Duo mark (`0ad5564`) is fully documented — in `patches/README.md`, not here**, and that is
the right place by the overlay's own rule: a patch author looks at the patch tree, not at a 3,700-line
session log. The README gained a section explaining why the mark is a **pair of discs** and why
that is a security property rather than decoration (Accio and Fidelius have opposite custody
models, their old marks were the same path in two hues, and hue is the first signal to fail at
16 px or for a colour-blind viewer). The load-bearing geometry — `r_black 56.16`, `r_violet
49.14`, centres `105.62` apart, front ring `0.32` clear of the back edge — is recorded there
too, along with the trap: **two faces in one disc restores the exact Fidelius circle and throws
the distinction away.** Judge a redraw at 16 px, not at 128.

The stale `Checksum` those four SVGs left in `backend/resources.php` is **not a defect and needs
no action** — `_acb_apply_patches` pass 2 recomputes SRI for every overlaid file from the staged
bytes, SVGs included, so the committed value is a starting point exactly as it is for the theme.
Confirmed by reading the loop, which is driven by `patched[]`, not by a fixed list.

## Theme — "Orbital Dawn"

**Status:** built 2026-08-16, reviewed the same day, **never seen in a browser**.

Accio inherited the vendored wallet's look along with its crypto. The theme gives it its own,
without touching a byte of `vendor/styles/`.

Three directions were rendered on the real Accio screen and **Orbital Dawn** was chosen: the
wallet on the night side of a planet, sunrise on the limb below the frame, one warm accent and
nothing else lit.

### The mechanism — one file, loaded last

`patches/public_html/styles/accio.css` is **added**, not a replacement. It repeats upstream
selectors verbatim and wins on **source order**; where upstream's selector is more specific it
repeats that one too. Upstream's 22 stylesheets stay untouched, so
`git log <PINNED_SHA>..upstream/master` — the only way we review upstream security fixes on a
self-custodial wallet — stays readable.

The alternative was overlaying the 14 colour-bearing stylesheets (4,800 lines) with tokenised
copies. Rejected: it puts our bytes in the way of that diff forever and turns every upstream
colour touch into a manual merge. **The cost of the choice we made is that an upstream selector
rename silently stops matching — but that failure is visible on screen as a violet control**,
which is the loudest failure mode available here and the opposite of the "sed that exits 0"
class this product keeps getting bitten by.

Three hooks, each marked:

| Hook | Why |
|---|---|
| `index.html` — one `<link>`, **last** | order is the whole mechanism; above any link it overrides and the theme half-applies |
| `errors/template.php` — the same `<link>` | the eight error pages carry their **own** copy of the ground, the spinner and the entire message dialog in an inline `<style>`. nginx serves 404 from here, and 503 during maintenance |
| `backend/resources.php` — `$files` entry + `THEME_COLOR` / `BACKGROUND_COLOR` | see below |

### It is a light-to-dark flip, not a hue swap

Worth stating because it sizes the work. Upstream is a violet gradient ground and violet chrome
with **near-white content panels and near-black text**. Orbital Dawn is dark throughout, so every
`color: rgb(12, 12, 13)` upstream sets on a panel had to be restated — miss one and it is black
text on a navy panel. Coverage was checked mechanically, not by eye: every colour-bearing rule in
the 14 vendored stylesheets was extracted with its selector and its at-rule context and matched
against this sheet. **6 upstream rules are deliberately not restated** — all of them
`color: white` / `stroke: white` on a surface that is still dark or still coloured.

Two things that only that sweep would have found:

- **The row separator** (`section.css`, inside `@media (max-width: 400px)`) is `black` at 0.2
  alpha. A grey hairline on white; invisible on navy. Restated as a real line.
- **The dangerous-confirm fill** carries upstream's `color: white` label. `--acc-danger` (#E4574F)
  is only 3.6:1 under white, so fills that carry white text use a separate `--acc-danger-fill`
  (#C0392F, 5.0:1). Semantic colours are kept off the accent entirely, so "warm" never has to mean
  both *primary action* and *something is wrong* on one screen.

### `THEME_COLOR` and `BACKGROUND_COLOR` are not decoration

`BACKGROUND_COLOR` is read by more than the manifest: the PWA splash, the Windows tile, the
Safari pinned-tab mask tint, and `scripts/startup_images_creator.js`, which **fills the generated
iOS launch images with it** before drawing the white mark. Left violet, the installed app opens
with a violet flash into a navy wallet every single time. `THEME_COLOR` was upstream's `#FFFFFF`,
i.e. a white browser bar above a near-black page on every mobile browser.

### The `$files` entry earns its place

Without one, `getChecksum()` returns the empty string and the theme ships un-SRI'd — but that is
the smaller half. `$files` is also what `scripts/service_worker.js` precaches (`Cache => TRUE`)
and what it hashes to derive its **cache version**, so an unlisted stylesheet is a theme that
never reaches a returning PWA user. `_acb_apply_patches` rewrites the Checksum from the staged
bytes and bumps the Version on every build, so the value in the repo is a starting point, not
something maintained by hand.

### No operator switch, deliberately

A `theme=` config key was considered and rejected. It would double the acceptance surface of a
build nobody watches run, and it would have to be agreed by the standalone build, the nginx layer
and both status screens. **A-11 and A-12 are still open** — `patches/` sits outside the pin, and
the deployed site is never re-verified — and a per-deploy visual variant makes both worse. The
tuning surface is the `:root` token block; a theme change is a token edit plus a rebuild.

### Hardware wallets are NOT obsolete — checked, because it was asked

The `Hardware` button beside Create and Recover is a real, wired Grin feature, not MWC residue:

- `hardware_wallet.js:8339` returns the Ledger application name **"Grin" / "Grin Testnet"** for
  `GRIN_WALLET_TYPE`, next to MWC's and Epic's.
- `hardware_wallet.js:5973` uses `SLATEPACK_ADDRESS_TYPE` for Grin when finishing a transaction —
  Grin-specific, not a fallthrough.
- The wallets rail renders **`.ledger` / `.trezor` watermarks** on hardware rows
  (`unlocked.css`), and the message dialog has a PIN-matrix widget for them.
- `HardwareWallet.isSupported()` gates on WebUSB/WebBluetooth, so a browser without either gets a
  clear error rather than a dead button.

This confirms `script052_design.md` line 373 by a second route. **What the repo cannot tell us** is
whether that Ledger app is installable from Ledger Live's catalogue today — that is a live check,
listed below. Do not delete this surface on a guess; deleting it removes a working feature.

## Security audit

**Status:** written 2026-08-11 and amended by the later reviews; **16 findings fixed, 6 open** — the table of record is [`script052_security_audit.md`](script052_security_audit.md).

**Deliverable: [script052_security_audit.md](script052_security_audit.md).** Scope was the
gateway, the four libs, the nginx artefacts they generate, the unit, and the pin chain — not the
vendored wallet, which stays explicitly unaudited for the reasons the design already records.

Method was a read of the code plus **47 offline assertions** driving the real `guard.js`,
`store.js`, `listen_route.js`, `wallet_route.js` and `config.js`, plus an offline render of all
three nginx artefacts read block by block. No server was started, nothing ran against a VPS, and
nothing was left running.

### The finding that mattered

**Inbound payments were routed by SESSION, not by ADDRESS.** `deliver()` picked the most
recently opened socket in the owning session, which is not the same question the cookie answers:
a cookie proves which session a tab is in, never which address it holds. Anyone who obtained the
cookie could open a `/listen` socket, send no protocol message at all, and be handed the next
inbound slate for an address they had never seen — their wallet answers it with their own
output, the payer's send succeeds, and neither UI shows anything wrong. Not knowing the suffix
was no obstacle, which is why 80 bits of entropy did not help.

Delivery is routed to a socket that has **claimed that specific suffix** (minted it here, or confirmed it here with `Own URL`). The fallback to the old rule that this fix first kept was itself the same defect (A-18) and has been deleted: a payee whose tab has not claimed the address gets the 503 + `Retry-After` any offline payee gets.

### The other fixes

`store.js` had **no bound on the session table at all** — a handshake mints a session before the
client asks for anything, nothing capped it, nothing evicted it, and `flush()` re-serialised the
whole table every 2 s, so a handshake flood was a memory leak and a disk amplifier at one
WebSocket each. Empty sessions are now never persisted, `createSession()` is capped and evicts
empties first (never a session that owns an address), `sweep()` drops unclaimed sessions after an
hour, and a full address table evicts the oldest *unverified* suffix and says so loudly instead
of silently refusing every new wallet an address. Two new config keys: `max_sessions`,
`empty_session_ttl_ms`.

`max_inbound_in_flight` was checked **after** `readBody` had buffered a whole megabyte, so it
capped relays and not memory — reads and parked interactions now share one budget, reserved
before the read. The SSRF guard's private-address rule only recognised **dotted-quad** IPv4, so
`2130706433`, `127.1` and `0x7f000001` walked past it whenever clearnet was enabled; it is now a
shape rule (at least one dot, final label starts with a letter) that covers every notation at
once. Two clearnet locations included the header snippet and still answered with **no HSTS**,
because HSTS is deliberately not in the snippet — the same trap this file warns about, one level
in. Over-rate WebSocket messages were dropped in silence while the comment beside them promised
an `Error`. The unit gained `IPAddressDeny=any` + `IPAddressAllow=localhost`, which turns the
whole SSRF story from "our regex is right" into "the kernel will not carry the packet", plus
`MemoryMax`. The CSP gained the four directives that do not fall back to `default-src`.

### The CSP, answered against the source

`'unsafe-inline'` in script-src is **required** — `index.html` carries 144 inline event handlers.
`connect-src *` is **required** — the visitor picks their own node. `'unsafe-eval'` is the one
genuine narrowing available: there is **no `eval()` and no `Function("…")` anywhere in the
tree**, and the only caller is `WebAssembly.instantiate`, which is what `'wasm-unsafe-eval'`
exists for. That token is now listed **alongside** `'unsafe-eval'`, not instead of it, so
dropping the wider one is a one-word edit — do that once S2 has watched the wallet boot and sign
without it. And the honest summary: with `'unsafe-inline'` and `connect-src *` both structurally
required, this CSP is **not** XSS containment for this app and must not be described as one.

---

# Runbook

**Status:** the operator-facing flows are the product script's menus (hub 05 key `2`); this section records what an acceptance or recovery session needs that the menus do not say.

## Build and roll back

### What a build does

```
vendor/upstream-wallet/public_html   immutable, never written
     | cp -a
<outdir>.stage    <- patches/public_html/ overlaid whole-file, SRI refreshed
     | php, once per templated file
<outdir>.new  ->  assert  ->  manifest  ->  atomic swap  ->  <outdir>
```

The swap is **last**, so a failed build leaves the live tree untouched — this runs on a box
with other vhosts, live certs and a running gateway. Rollback: `<outdir>.prev`. Artefacts sit
*outside* the served root: `<outdir>.SHA256SUMS` (+ `.prev`) and `<outdir>.BUILD_INFO`.
The build reports "byte-identical to the previous build" itself, so the first acceptance step is one action.

Post-conditions before publishing: `index.html` non-empty; **no** file in the output still
starts with `<?php`; **no** `*.php`, `backend/`, `languages/` or `.user.ini` reached it.

## First-run bootstrap

### Why "Rebuild site" can run before anything else is installed

`SERVER_NAME` is baked into the output, so a build needs the domain. "Rebuild site" asks for
it **once** when `$ACC_CONF` has none, writes `ACCIO_DOMAIN` / `NETWORK` / `NODE_URL` /
`GATEWAY_PORT` / `TOR_PORT` / `HTTPS` / `ONION`, and never asks again. the installer writes
the same keys. `_acc_conf_set` and `_acc_load_lib` were added to `052_grin_accio.sh`.

## Recovering the address table

`/opt/grin/accio-<net>/gateway-state/` is durable state, not a cache — losing it changes the receiving address of every wallet that ever connected, and payments already travelling to an old address then answer 404. It is the only `ReadWritePaths` in the unit and `listen-state.json` is a mode-600 atomic snapshot.

- A snapshot that is invalid JSON, or carries an unknown `version`, is **moved aside, not deleted** (and counted on `/health`); the service then starts empty.
- A snapshot the service **cannot read** (for example an `089` restore that left it `root:root`) stops the service on purpose, with the reason and fix in the message. Fix the ownership; do not delete the file.
- Restart the gateway twice during acceptance and confirm the receiving address is unchanged both times.

## Running the gateway tests

`node --test` from `web/052_accio/gateway/` (bare, auto-discovery: 78 tests across four files; `node --test "test/*.test.js"` gives 77). `node --test test/` fails on Windows with `MODULE_NOT_FOUND`. The suites use no sockets, exit on their own and are not deployed. Quote the runner, never a remembered count.

---

# Build notes — obstacles & lessons

One entry per real obstacle hit while building Accio: **Symptom** · **Cause** · **Fix** · **Lesson**,
grouped by subject. The hash is the first commit that carries the fix — `bdf1afa` (2026-08-13) is a
batch commit holding the whole build and review arc, `b9ee1f2` the theme. The session-by-session log
this section was distilled from (per-packet verification lists, the review plan and its hunt lists,
test-count histories) is in git: `git show e8932ab:docs/reference/script052_implementation.md`.
Audit ids (`A-1` …) are rows in [`script052_security_audit.md`](script052_security_audit.md).
Nothing below has run on a VPS.

## Vendoring and the pin

### `git archive` honours `core.autocrlf`
**Symptom:** the vendored `LICENSE` hashed `eb2c5d88…`, not upstream's `bbc8b96c…` — a "byte-exact,
pinned" tree that was neither. **Cause:** a Windows clone with `core.autocrlf=true` rewrote every text
file, and `git archive` applies the same setting; it recurred on the second upstream the same day.
**Fix:** `git -c core.autocrlf=false -c core.eol=lf archive`, checked against the raw blob and a
`diff -r` of a fresh extraction (`8cac9de`, `b70dab7`). **Lesson:** spot-checking one file proves
nothing; compare the raw blob, and treat the CRLF trap as certain, not likely.

### This repo would have re-broken the pin on the next clone
**Symptom:** none yet. **Cause:** the root `.gitattributes` sets `* text=auto eol=lf`, right for our
scripts and wrong for a checksummed tree. **Fix:** `web/052_accio/.gitattributes` sets `vendor/** -text`
(`git check-attr text` → unset) (`8cac9de`). **Lesson:** a vendored tree needs its own attributes file.

### The spec we reimplement lived in a second, unpinned repo
**Symptom:** the build env contract and the standalone inliner were both taken from `build.sh` in
`MWC-Wallet-Standalone`, which nothing pinned. **Fix:** vendored at `043c2ddc` into
`vendor/upstream-standalone-build/` (4 files, MIT), covered by the same manifest; never run — it
`wget`s an unpinned `master.zip` and `chmod 777 -R`s its tree (`b70dab7`).
**Lesson:** if you reimplement a spec, pin the spec.

### A doc move that leaves referrers is unfinished
**Symptom:** after Accio's design moved out of `script05_design.md`, `CLAUDE.md` still said 052 was
reserved and hub 05's live notice told operators it was "NOT BUILT YET". **Fix:** five files and the
runtime string chased (`b70dab7`). **Lesson:** after moving a doc, grep every referrer — including
strings that print at runtime.

### The file-set check could not see a symlink
**Symptom:** a symlink dropped under `vendor/` was listed by nothing and checked by nothing, yet the
build's `cp -a` shipped it. **Cause:** `find -type f` lists regular files only, and `sha256sum -c` reads
only what the manifest names. **Fix:** `! -type d`, proved with a FIFO because Windows cannot make a
symlink unprivileged (`bdf1afa`). **Lesson:** "the file set, both ways" means every non-directory.

### A missing `vendor/` printed a clean bill of health
**Symptom:** the upstream check said "none of the changed files are replaced by `patches/`".
**Cause:** the overlay list is derived by testing each patch against `vendor/`; with no tree every patch
is an *addition*. **Fix:** zero replaced files is reported UNKNOWN (`bdf1afa`).
**Lesson:** a derived list that comes back empty is "unknown", not "none".

### The offline guard greps parsed function bodies, and a tool can hide behind a variable
**Symptom:** a literal-name pattern would have missed `"$ACV_GIT_BIN"`, the form a future edit is most
likely to copy. **Fix:** `declare -f` bodies of the verify chain (comments vanish at parse time) and
`ACV_GIT_BIN` in the pattern, with a test for each spelling; the chain's messages must not name a
fetcher either (`bdf1afa`). **Lesson:** an offline guard needs a planted fetcher that it is seen to catch.

### Small shell traps in the verifier
`awk '{print $2}'` truncated the two manifest paths that contain spaces and reported phantom deletions —
cut by column 67. `git log … | head -n 25` exits 141 (SIGPIPE) under `pipefail` and kills a `set -e`
caller, so it is `|| true`. `grep -c` prints `0` *and* exits 1, so `|| echo 0` emits two lines.
A review of `052_lib_vendor.sh` also made 8 fixes (deny-list offline guard, `ext::` URL, report path,
`${root:?}`, INT/TERM trap) that have no write-up beyond the file itself (`bdf1afa`).

## Build

### The lib does not run under `set -e`
**Symptom:** fifteen of sixteen findings in `052_lib_build.sh` descended from one header sentence
claiming it ran under the caller's `set -euo pipefail`. **Cause:** every call site is `fn || error …`
or `if fn; then`, which disables errexit for the whole function body, and re-issuing `set -e` inside
does not undo it. **Fix:** the header states the rule with worked examples; every command that creates,
copies or moves is guarded (`bdf1afa`). **Lesson:** the `||`-guarded dispatch the toolkit mandates is
exactly what turns errexit off in the callee — memory `project_lib_errexit_suppression`.

### A failed overlay copy got a valid checksum for the un-patched bytes
**Symptom:** none visible — the build succeeded and the browser loaded the file. **Cause:** an unguarded
`cp -f` still pushed the path into `patched[]`; the SRI pass then hashed whatever sat in the stage, the
pristine upstream file. With the `node.js` patch that is a wallet talking to upstream's nodes.
**Fix:** guard the copy and record success only (`bdf1afa`). **Lesson:** the highest-impact defect
found in Accio was a step that reported work it had not done.

### The "atomic swap" nested on failure and still reported success
**Symptom:** a failed rotate left the old tree serving, a junk `site/site.new/` under the nginx root,
and `Built N files`. **Cause:** `mv "$new" "$outdir"` does not fail when `$outdir` exists — it moves
`$new` inside it. **Fix:** prove the rotate before publishing; roll the old tree back if the publish
fails; the test extracts the real block from the source and injects `mv` failures (`bdf1afa`).
**Lesson:** after a security rebuild, written evidence that the fix shipped must not outlive a failure.

### Steps that can succeed by doing nothing
Counters sat beside the copies, so they described intent while the manifest recorded damage — the
output assert now takes an expected file count. `_acb_set_resource_entry`'s unguarded `mv` logged
"checksum refreshed" over a stale SRI. An unknown MIME type dropped an asset silently (now one warning
per extension, `ACB_SA_NOINLINE`); a missing `importScripts()` target or a non-converging 5-pass loop
now warns; an empty checksum or base64 blob (a `data:` URI of zero bytes) is refused (`bdf1afa`).

### The worker phase never fired
**Symptom:** the standalone shipped, logged `inlined 3 web worker(s)` and threw on
`null["textContent"]` at the first slate. **Cause:** "tightening" upstream's `.*` to `[^>]*` — the text
between the `src` attribute and the trailing `><!--` contains the `>` that closes the opening tag, and
`sed` exits 0 on an address that never matches. **Fix:** upstream's `.*` for that one address, plus a
guard between the insert and the irreversible rewrite (`bdf1afa`). **Lesson:** tightening a vendored
regex changes the contract with upstream's markup; make every phase prove it fired.

### The resource-table rewriter passed its tests for the wrong reason
**Symptom:** none — the output was right. **Cause:** the last `$files` entry closes `\t\t]` with no
comma, so matching `\t\t],` walked into the next table, which only worked because that table carries no
`Version`/`Checksum` lines. Separately the drift guard keyed on the block's braces, so a renamed field
copied through and still logged "SRI refreshed". **Fix:** match `^\t\t\]`, assert on the fields
(`bdf1afa`). **Lesson:** finding the entry proves nothing; assert that the lines you meant to change changed.

### Overlay order decided which checksums were refreshed
**Symptom:** `MWC Wallet license.txt` was reported "not in the resources table" although the patched
table lists it. **Cause:** the SRI pass read `$files` from the stage as it went, so a patched
`resources.php` only affected paths sorting after it. **Fix:** two passes — overlay everything, then
refresh against the final table; a patch that makes a static file templated now clears its checksum
instead of leaving the hash of the old bytes (`bdf1afa`).

### The build log said "refreshed" over an untouched `NULL`
**Cause:** one exit code (0) for "wrote a checksum" and "upstream marks this `Checksum => NULL`, left
alone". **Fix:** a distinct exit 5 and no "version bumped" wording — a `Version 0` entry is deliberately
not bumped (`bdf1afa`). **Lesson:** the log of a build nobody watches is the acceptance evidence.

### Build state leaked across calls
`accio_build [net]` re-pointed every `ACC_*` global for the rest of the hub session — mainnet/testnet
isolation rested on nobody using the documented argument; a mismatch now refuses. `_ACB_STANDALONE` was
a global with a manual reset, so any `return` added in the standalone loop would have leaked standalone
mode (no SRI, no versions) into the next hosted build; it is a parameter (`bdf1afa`).

### Standalone publish could ship the previous build or a truncated file
A failed `mv` could republish the earlier artefact of the same version, hash it and announce it, after
`rm -rf` destroyed the fresh one. `current.html` was rewritten in place under a live nginx, so a
concurrent ~10 MB download got a truncated wallet (now written aside and renamed). `sha256sum` recorded
an absolute path, so `-c` only worked from `/`. An empty `$outdir` made `rm -rf` reach upward — guarded
with an explicit check first, because a bare `${var:?}` in a sourced lib exits the whole toolkit (`bdf1afa`).

### `set -e` restored unconditionally, and null-byte noise
`set +e … set -e` around an `awk` turned errexit **on** for a caller that had it off; replaced by
`cmd || rc=$?`. Reading magic bytes through a command substitution printed 24 "ignored null byte"
warnings per build; piping through `tr -d '\0'` cannot create a false positive (`bdf1afa`).

### Small build traps
An apostrophe in a comment inside a single-quoted `awk` program ended the string ("upstream's" cost a
`bash -n` failure). `${onion:+http://$onion}${onion:-…}` expands both halves and printed the onion
twice. `abs="$(cd … && pwd)/$(basename …)"` takes its status from `basename`, so a failed `cd` produced
`/name.svg`. A diagnostic stripped `*/public_html/` from a path that lives under `<outdir>.stage` (`bdf1afa`).

## Gateway

### `agent: false` is not "no agent"
**Symptom:** the Tor rail bypassed by one falsy value — the SOCKS tunnel was built, then ignored while
Node opened a direct socket to the `.onion` and failed with `ECONNREFUSED` and an empty message.
**Cause:** `false` means "construct a fresh default Agent", and `http.request` consults `createConnection`
only when there is no agent. **Fix:** `agent: null` (`bdf1afa`).

### A socket left in flowing mode never delivered a byte
**Symptom:** every forward returned 504. **Cause:** reading the handshake with a `'data'` listener
starts the flow; `pause()` sets `flowing = false` permanently, so the HTTP client's later `on('data')`
never auto-resumed. **Fix:** read the handshake with `'readable'` + `socket.read(n)`, which keeps the
socket paused; leftover bytes stay in its own buffer (`bdf1afa`).

### Refusing a request mid-body
**Symptom:** the client saw `ECONNRESET` instead of the 413; and a refused request drained an uncapped
body. **Cause:** destroying the socket right after writing raced the response out of the client's
buffer; the onion front has no nginx in front, so anyone could stream gigabytes into a route that had
already said 403. **Fix:** drain with a hard stop at `max_body_bytes`, then close normally; every error
response carries `Connection: close` (`bdf1afa`).

### A disconnected client held its concurrency slot for the full timeout
**Cause:** `res.once('close')` was registered inside the `'response'` handler, so it did not exist while
waiting on the circuit — the window that matters; `'aborted'` does not fire once the body completed.
`max_concurrent` of those is a free denial of service. **Fix:** registered at the top of `forward()`;
`in_flight` returns to 0 within 400 ms of the client vanishing (`bdf1afa`).

### An idle timeout is not a deadline, and a timer armed before its target
`proxyReq.setTimeout()` is idle-only, so a hidden service trickling a byte every two minutes held a slot
for ever — a separate total deadline was added. That deadline was armed before `const proxyReq`, so a
synchronous throw from `transport.request()` left a timer firing into a binding in its temporal dead
zone, an uncaught ReferenceError; it is now armed after the request exists (`bdf1afa`).

### A missing config started the gateway on defaults
**Symptom:** a unit that lost its `Environment=` line would start the **mainnet** gateway on the
**testnet** port — running, `is-active`, wrong. **Cause:** the loader was fatal only when the path was
set and unreadable. **Fix:** fatal, asserted end to end (`bdf1afa`).

### The SSRF guard's shape rules
An unbracketed IPv6 literal (`http://::1/`) parses as host `":"` and walked past all three checks with
clearnet enabled — fixed at the parse layer by requiring a DNS-name shape. `^19[89]\.1[89]\.` blocked
ordinary `199.18.x` (reserved is `198.18/15`); an over-block is a bug like an under-block. The private
rule recognised only dotted quads, so `2130706433`, `127.1` and `0x7f000001` passed — now a shape rule
(a dot, final label starts with a letter). A destination **port allowlist** (default 80/443) stops the
route being a port scanner for hidden services (`bdf1afa`).

### One request that found a bug could kill every wallet's socket
A non-`Denied` throw out of `guard.inspect`, then `walletRoute.handle` and `hub.handleUpgrade`, each
propagated to the process: the gateway is one process serving every wallet. Wrapped, with last-resort
`uncaughtException`/`unhandledRejection` handlers that log and **do not exit**. `stats.tor_ok` also
counted client-aborted requests as successes because `res.statusCode` defaults to 200 (`bdf1afa`).

### The socket cap evicted a live connection
**Symptom:** found by `/health` `listen_open` refusing to move. **Cause:** a peer-closed socket stays on
the books until `'close'`, so a reloading tab counted twice and the eviction hit a different, healthy
tab mid-payment; pruning by `ws.closed` is the same information checked earlier. **Fix:** change the
policy, not the detection — refuse the new handshake; the 250 ms reconnect finds the corpse reaped.
Default cap 4 → 8 (`bdf1afa`). **Lesson:** a cap must refuse, never evict.

### A clean FIN never reaped the connection
**Cause:** `ws.js` listened for `'error'` and `'close'` but not `'end'`; a browser closing a tab sends a
FIN and nothing else, so the socket stayed on the books until the pong timeout (up to 45 s), holding a
session slot. **Fix:** handle `'end'`; a clean `sock.end()` now clears the count inside 50 ms (`bdf1afa`).

### A frame pipelined into the upgrade was parsed before anyone could listen
**Cause:** the constructor parsed `head` — whatever arrived in the same packet as the upgrade — before
`_register()` attached a listener. A valid first `Own URL` was emitted into the void (the wallet waits
120 s, then discards its address and mints a new one); a bad first frame threw out of `handshake()`
after the 101 was already sent. **Fix:** buffer `head` and parse on `process.nextTick` (`bdf1afa`).

### `emit('error')` with no listener was a remote kill switch
An `'error'` with no listener is a `throw`, and three places emitted it directly: one malformed frame
from any peer dropped every tab's socket, and the restart storm is self-sustaining. All three go through
`_emitError()`, which checks `listenerCount('error')`; `'close'` still carries the reason (`bdf1afa`).

### Session lifetime versus socket lifetime
`mint()` accepted a session that had expired under an open socket, so the new address *worked* — until
the next restart, when `_load()` dropped it. Only the handshake refreshed the rolling ttl, so a tab that
stayed connected could have its address swept; every request now touches the session. `touchSuffix` had
no caller, so receiving money did not count as activity — it is called on the tab's **accepted response**,
never on the arriving request, or a stranger who knows an address could keep its session alive
(`bdf1afa`). **Lesson:** the activity clock must count the activity that matters most.

### Over-rate requests were dropped in silence
**Cause:** the bucket was taken before the parse, so no `Index` was left to answer with, contradicting
the comment above it and the design (silence costs the client a 120 s stall). **Fix:** parse first, bucket
second; the reply is 1:1 with the frame refused, so never an amplifier (`bdf1afa`).

### `destroy()` threw away the close frame written one line earlier
Every deliberate close code reached the client as an unexplained reset. `end()` first, `destroy()` on a
250 ms unref'd timer. Two more in passing: the interaction-id wrap was checked *after* handing the id
out, and a snapshot with an unknown `version` started empty and let the next flush overwrite it (`bdf1afa`).

### Inbound payments were routed by session, not by address (A-1, then A-18)
**Symptom:** anyone holding a session cookie could open `/listen`, claim nothing, and be handed the next
inbound slate for an address they had never seen. **Cause:** `deliver()` chose the newest socket of the
owning session; a cookie proves which session, never which address. **Fix:** deliver only to a socket that
has claimed that suffix. The first fix kept a fallback to the old rule, described as a sub-second
reconnect window — but `claimants` is empty whenever the legitimate tab is closed, so it re-opened A-1 in
full; the fallback is deleted and a counter `inbound_unclaimed` separates "live but unclaimed" from
"no socket" (`bdf1afa`). **Lesson:** a comment that understates a residual is part of the bug.

### The session table had no bound
A handshake mints a session before the client asks for anything; nothing capped or evicted it, and
`flush()` re-serialised the whole table every 2 s — a memory leak and a disk amplifier at one WebSocket
each. Empty sessions are never persisted, creation is capped and evicts empties first (never one that
owns an address), unclaimed sessions are swept after an hour, a full address table evicts the oldest
*unverified* suffix loudly (`bdf1afa`).

### A read error on the snapshot destroyed every receiving address
**Cause:** invalid JSON and a wrong `version` moved the file aside; any other read error logged and
started empty, so the next `flush()` renamed over live addresses — rename takes its permission from the
directory. An `089` restore that leaves `listen-state.json` `root:root` is enough. **Fix:** fatal, with
the reason and fix in the message (`bdf1afa`). **Lesson:** every failure path of a durable read must
either move the file aside or stop.

### A quoted boolean inverted the SSRF default
**Symptom:** `"allow_clearnet_destinations": "false"` loaded and turned the guard **off**. **Cause:** only
`listen_enabled` was type-checked; the non-empty string is truthy. **Fix:** `BOOLEANS`/`STRINGS` lists
beside `POSITIVE_INTS`, a wrong type refuses to start (`bdf1afa`). **Lesson:** hand-editing is an
expected workflow, so the permissive reading of a typo is the dangerous one — memory
`project_config_loader_type_traps`.

### Store evictions orphaned the socket's mirror of the table
`Create URL` in a loop kept the table capped at 16 per session while `state.owned` grew at the full
message rate until the socket closed — reachable with `curl`, because an absent `Origin` is allowed.
One `store.onForget` hook now covers all five removal paths by construction (`bdf1afa`).

### The flush debounce bounded frequency, not volume
At 100k rows (~10 MB) a trickle of mints meant ~10 MB every 2 s on a box shared with the node and the
pool. The delay scales with the table (+1× per 10k rows) (`bdf1afa`).

### Refusals the sender could not read
Refusals inside the inbound rail go through `listen.sendJson`, which attaches CORS; the two raised in
`server.js` (rail disabled, onion bucket empty) did not, so another wallet's tab saw one opaque network
error for both. Both go through `walletRoute.refuse` (`bdf1afa`).

### Token buckets with a non-monotonic clock
`Math.min` clamped the top and nothing clamped the bottom: a one-hour backward step at 10/s left −36,000
tokens, refusing everything for the next hour with nothing in the journal — and on `/listen`, 50
violations close the socket, so a clock correction could disconnect every wallet. Delta and floor are
clamped (`bdf1afa`).

### The inbound read budget was 256 MB, and the address was checked after it
256 concurrent reads × 1 MB, and `store.lookup()` ran only after the body was buffered, so a POST to a
suffix that never existed cost a megabyte before its 404 — reachable by one client on the onion front,
where the bucket is a rate limit, not a concurrency one. `hub.knows()` runs before `beginRead()`.
Separately a 1 MB body cap met a 256 KB frame cap only at runtime (base64 is 4 out per 3 in, ~192 KB
usable): `loadConfig` derives `inbound_max_forwardable` and clamps with a warning rather than refusing,
because an earlier `gateway.json` carries 1048576 (`bdf1afa`).

### `refuse()` could throw
`message.replace` on an `err.message` that was undefined raised a TypeError in an `'upgrade'` listener,
which reaches `uncaughtException`. Coerced with `String()` (`bdf1afa`).

### A probed claim that turned out fine
`server.requestTimeout` covers *receiving* only — a response withheld for 4 s under a 1.5 s timeout
still answered 200 after ~4 s. No bug; recorded so `send_timeout_ms` (120 s) beside `inbound_timeout_ms`
(180 s) is not re-opened.

## Nginx, TLS, onion and installer

### `add_header` in a child block drops the parent's set — five times
**Symptom:** a CSP or HSTS missing from exactly the routes that matter, with nothing in the response but
the absence. **Cause:** upstream's 29 `more_set_headers` calls became stock `add_header … always`, which
a child block replaces rather than merges. It recurred in the `/tor/` location, the asset and
standalone locations, two clearnet locations that included the headers snippet and still had no HSTS
(HSTS is deliberately not in it), `Onion-Location` set at server level, and HSTS as a literal in three
blocks. **Fix:** two snippets — shared, and TLS-only (HSTS + `Onion-Location`) — that every block adding
a header of its own includes; the `/tor/` snippet carries no `add_header` and the gateway emits
`Cache-Control` (`bdf1afa`). **Lesson:** a repeated literal is how the next one goes missing.

### The onion path had three listeners and two ports
**Symptom:** none until `acn_onion_enable` ran: nginx's onion block took the gateway's port, the
gateway's `listen()` got `EADDRINUSE` and exited, and the working clearnet rails died with it. **Cause:**
a second nginx block sits between tor and the gateway but only two ports were allocated. **Fix:**
`ACC_TOR_FRONT_PORT` (7581/7591) for nginx's block, `ACC_TOR_PORT` for the gateway (`bdf1afa`).
**Lesson:** nothing reports it — `nginx -t` does not bind, `reload` returns before the master binds, and
both status screens grepped `ss` for the same port, so one line went green whichever process won.
`_acn_reload` now verifies the listener after the reload.

### The zone upgrade wrote no zones, announced success, and would have stopped nginx booting
**Cause:** `_acg_ensure_zones` backed the conf up **inside** `/etc/nginx/conf.d/`, then called a helper
whose duplicate guard greps recursively — it found `accio_tor` in the backup (nginx does not load it) and
returned 0 without writing; the detection loop and the status screen used the same grep and reported
"present" for good. The snippets then referenced zones that did not exist. **Fix:** backups under
`$ACC_DIR/nginx-backups` (old ones evacuated), `_acg_zone_defined` asks only the files nginx loads, and
the outcome is re-checked rather than the exit code (`bdf1afa`). **Lesson:** a zone name is global to
nginx — ours are `accio_*` — and a helper that no-ops on an existing file will not add a zone to it.

### Backups beside loaded config count as config
Vhost backups in `sites-available` satisfied the status grep forever, even after a rollback restored a
vhost without the include; `_acg_find_vhost` could return the **onion** vhost (it also carries
`root $ACC_SITE_DIR`) and have the clearnet snippet inserted into it — and the discarded return of
`_acg_ensure_zones` let snippets be written anyway. Backups moved out, `-onion` excluded, the return
gated, status reads `sites-enabled` (`bdf1afa`).

### Uninstall left a dangling include
**Cause:** the entry script's uninstall re-implemented both libs from a path list and kept none of their
reasoning; an include can live in a vhost we never named, and nginx then **refuses to start**, taking
every vhost down (A-16). **Fix:** a grep-driven sweep of `sites-available` only (a `sites-enabled` symlink
would be replaced by `sed -i`), with `%` as the sed delimiter — the `|…|d` idiom errors the moment the
pattern carries an alternation — and `(gateway(-onion)?|(tls-)?headers)` so the TLS snippet is swept
(`bdf1afa`). **Lesson:** copying a working `sed` idiom is not reusing it; the delimiter is part of the pattern.

### The self-test failed on a healthy gateway
The `/listen` probe wanted 400; `server.js` answers 426 Upgrade Required, deliberately. An assertion
that cries wolf teaches the operator to read past a red self-test, on the screen that gates the first
real send. The probe now wants 426 (`bdf1afa`).

### Redeploying took HTTPS down, and the TLS vhost contradicted its own ACME reasoning
The HTTP bootstrap carries no `/.well-known/acme-challenge/` location because every build replaces the
site directory by atomic rename, yet the TLS vhost's port-80 block had one — removed; `certbot --nginx`
inserts its own for the life of the challenge. The bootstrap was also written on every deploy, and has no
`listen 443`, so HTTPS was down between two reloads: it is written only when no certificate exists. Static
assets carried `Cache-Control` twice (`expires 2y` plus `add_header`) (`bdf1afa`).

### Generated nginx config built through an unquoted heredoc
A backtick in a comment ran `includeSubDomains` as a command and the word vanished from the file —
harmless only because it named nothing real. `http2 on;` is unknown below nginx 1.25.1 (Debian 12 ships
1.22) and the old `listen … http2` form warns above it, so `_acn_http2_listen` asks the binary.
`filename=\"…\"` collapsed to three nginx arguments; the quotes were dropped. All three would have failed
`nginx -t` — and on this box that means every other vhost goes with it. Found by rendering offline and
reading the output (`bdf1afa`).

### `try_files` and `gzip` in the gateway locations
`try_files` at server level is inherited by locations that define none and runs before the content phase,
which would 404 every `/tor/` request — keep it inside `location / { }`. `gzip off; gzip_vary off;` was
not transcribed from upstream: with `gzip_proxied any` nginx would recompress JSON-RPC responses that mix
attacker-influenced and secret content (`bdf1afa`).

### Smaller nginx / tor / installer faults
Without `options-ssl-nginx.conf` the vhost inherited nginx's TLS floor (`TLSv1 TLSv1.1 TLSv1.2` before
1.23) — an explicit `ssl_protocols` now sits in the `else`. `acn_onion_disable` deleted the gateway's onion
snippet, so the next enable produced an onion that 404s every send; it is kept. Three hard `tor` restarts
would drop the node API's onion, Fidelius's, the Transporter's and every in-flight pool-payout circuit —
`_acn_tor_reload` reloads first. `apt-get install tor` ran with no `update` and `yum` with no EPEL.
`ACCIO_HTTPS` stayed `on` after a failed TLS reload (the build reads that key, not the vhost) (`bdf1afa`).

### The installer wrote JSON and units through unvalidated, unguarded paths
Every `mkdir`/`cp`/`chmod`/`cat >` was unguarded in a lib that runs without errexit; a failed
`mkdir -p "$state_dir"` ships a unit whose `ReadWritePaths` names a missing directory, and systemd refuses
with "Failed to set up mount namespacing". `_acg_json_set` warned and returned success for the key that
decides whether addresses survive a restart. `$domain`/`$onion` went into `gateway.json` raw, and
`x", "allow_clearnet_destinations": true, "domain": "x` is valid JSON that turns the .onion-only policy
off — both are re-validated at the point of use (`bdf1afa`).

### The entry script's status screens reported from paths that exist
The network badge said "installed (stopped)" for a directory created by typing a domain; the deploy
summary printed `https://` after a declined certbot; the rebuild prompt accepted any string as a domain;
`_acc_load_lib` returned non-zero silently on a lib that failed to source; the uninstall sourced the nginx
lib with `2>/dev/null`, so a missing lib left the torrc hidden-service block publishing to a dead port.
Each now keys on the unit file or reports the failure (`bdf1afa`). **Lesson:** a directory is not an
installation.

### `_acc_conf_set` injected through `sed` (A-17)
A `|` in an operator-typed value became a `sed` flag (`w /path`, as root) and a `&` corrupted the line.
Rewritten without `sed`; the conf is read key by key and never `source`d, which is also why reordering
keys is safe (`bdf1afa`).

### Authoring against fakes before the box
The gateway was written before its first VPS run, against a fake SOCKS proxy and a fake onion, and that
proved more than a live smoke test would have: it found the three Node-semantics bugs above, each of
which a live test would have shown only as "the send hangs". It does not replace the box — see Open items.

## Overlay, branding and theme

### A patch nothing could review (A-23)
**Symptom:** the "offline" standalone fetched `api.github.com/…/releases/latest` on every load.
**Cause:** `check_for_updates.js` carried six rewritten URLs and no `ACCIO PATCH` marker, so it sat
outside the only review method (grep the marker) through the build and five reviews; it also compared the
toolkit's release tags with the upstream wallet's `VERSION_NUMBER`, so it never could have worked.
**Fix:** the marker, and `patches/README.md` now states the rule with a table of every patch file — the
table is the marker for the five whose format cannot hold a comment (`bdf1afa`). **Lesson:** put a rule
where the person doing the work looks, not in the three docs they do not open.

### The brand map was identical in both files and still missing 27 strings
Dutch (7), Greek (8) and Simplified Chinese (12) did not keep English word order (*MWC Portemonnee*,
*Πορτοφόλι MWC*, *MWC钱包*), among them the page title, the error and maintenance titles, and the
currency label beside a balance. **Fix:** nine translated spellings added to both maps (12 entries each,
identical), then a leak scan over every language table → 0 (`bdf1afa`). **Lesson:** "the maps match" is
necessary and proves nothing; branch the real map over each table. A checker that parses with a regex is
defeated by a comment shaped like data.

### The credit's own link was rewritten to point at us
`https://github.com/NicolasFlamel1/mwcwallet.com` in `brandLinks` as "the source-code URL" also rewrote
the licence credit. One literal meant two things ("where this build lives", "the work we forked") and no
map can tell them apart. **Fix:** `about_section.js` patched explicitly for the source link, the URL
removed from the map, and a test asserting the credit's name, URL and licence path survive (`bdf1afa`).

### A symmetry the overlay missed
The patch that stopped preloading `fonts/mwc/` argued that `class="mwc"` is emitted at one place,
unreachable now. `class="epic"` is three lines below, unreachable for the identical reason, and its font
was still preloaded. The Epic preload and stylesheet are gone; BTC's stay (`Prices` renders a real
figure) (`bdf1afa`).

### The dawn never rendered
**Symptom:** `body` was flat `--acc-space`, and the approved mockup had the same flaw. **Cause:** colour
reaches only `last-stop × ry` back from the centre; with `cy 152% / ry 62% / last 68%` it stopped at
`y = 110%`, below the frame. **Fix:** recomputed to `y = 61%`, with the six numbers and the arithmetic in
a comment (`b9ee1f2`). **Lesson:** a flat dark ground reads as a deliberate design — do the arithmetic;
and flag that fixing it changes what was signed off.

### Quiet buttons inherited our dark ink
**Symptom:** the main navigation shipped at 1.2:1 (`#2A1405` on `#0F1226`). **Cause:** upstream's base is
`background: #6000D5; color: white` and quiet buttons override only `background`; our base ink is dark
(it sits on a light accent), so every one that did not restate `color` inherited it, and `box-shadow`
leaked the same way. A colour-coverage sweep only sees selectors upstream *sets* a colour on. **Fix:**
resolve `color`/`background`/`box-shadow` per property, per button, across all 31 contexts (`b9ee1f2`).

### A hairline on a sized box
`aside.message > div > div` is `width: calc(100% - …)` under `content-box`, so a 1px `border` pushed the
seed-phrase dialog 2px past its parent. An `inset` box-shadow ring costs no layout; the four notification
bars got the same swap for uniformity (`b9ee1f2`).

### A semantic colour that is a dot cannot also be a fill under text
`--acc-ok-deep` under `--acc-ink` was 3.4:1 (upstream's own 3.6:1 under white), and `--acc-danger` is
3.6:1 under white. Separate fill tokens — `--acc-ok-fill` 5.0:1, `--acc-danger-fill` 5.0:1 — keep every
fill that carries text above AA. The section arrows, language picker and rail buttons also inherited
`--acc-glow` from the base rule and got `none` explicitly (`b9ee1f2`).

## Tests and process

### A passing suite is evidence only for the run you watched
The record said 96/0; re-running turned up **95/1**. The failing test asserted `mint()` throws at the
global cap after minting three addresses and verifying none — three reclaimable orphans, so it
correctly evicted and succeeded. The global cap has two branches and the test constructed one while
asserting the other. The 96 later described a scratchpad harness that no longer existed (`bdf1afa`).
**Lesson:** quote the runner, not a remembered number; every count in this doc was measured with a command.

### The offline assertions were never in the repo
`guard.js` exported seven symbols "for the offline assertions" and a grep found zero consumers: the SSRF
boundary had nothing runnable behind it. `gateway/test/` now holds `node:test` suites (no dependencies,
no sockets, exit on their own, not deployed — the installer copies top-level `*.js` only). Two store
assertions were mutation-checked and every rail fix has a `⚠ THE NEGATIVE CONTROL` comment naming the
revert that must turn it red (`bdf1afa`). **Lesson:** a test never seen to fail for the right reason is
not evidence.

### Test doubles must match Node's semantics
A body double that produced data only on `resume()` failed three tests until it matched a real stream
(attaching `'data'` is what flows it, on a later tick); one that delivers synchronously on subscribe is
equally wrong because `readBody` registers `'data'` before `'end'`. A CR/LF injection test failed against
correct code because it checked that the text was absent, not that no second header line appeared.
`attachSocket` drives the real `hub._register` so the suite cannot pass against a drifted shape.

### Doc counts go stale in the session that certifies them
A review of the doc's own numbers (`17 files / 567 kB`, `25` markers, `96` assertions, "10 fixed, 6 open")
found four stale and then invalidated two of its own by adding markers and comments in the same session.
**Lesson:** measure with a command, say where to run it — and `node --test test/` fails on Windows with
`MODULE_NOT_FOUND`; use bare `node --test` (78, auto-discovery) from `web/052_accio/gateway/`, or
`node --test "test/*.test.js"` (77).

---

# Open items

**Status:** nothing here has run on a VPS. Six to ten defects fixed per review in code that has never run on a box is a reason to trust the acceptance session more, not to shorten it. Run testnet before mainnet.

## Known gaps (not fixed)

### A live tab's address can be reclaimed from under it

Fixing a wrong test (see *Build notes*) made the real gap visible, and the corrected test demonstrates it directly:
session `b`'s mint reclaims session `a`'s address. `verified` is set **only** by `Own URL`, and
`_createUrl` does not set it — so an address stays unverified from the moment it is minted until
the tab *reconnects*, which for a socket held open by the ping loop may be days. For that whole
window `_evictGlobalOldestUnverified` may reclaim it: the tab keeps displaying an address the
store no longer knows, inbound payments to it answer 404, and the tab is never told, because
`Own URL` is only re-sent on reconnect.

It only fires when the global table is full, which `mint()` already documents as a degraded mode
whose real lever is the nginx rate zones — but "degraded" here means *silently wrong receiving
address*, which is the exact failure the listen rail's design exists to prevent. The fix is not a one-liner:
it needs a third state between unverified and verified — *held by a live socket* — which the hub
already knows (`state.owned`) and the store does not. **Do not patch this during acceptance.**
It belongs with the other open audit items.

### Left open, deliberately (audit)

Two accepted trade-offs (`allow_null_origin` makes `/tor/` an open proxy to onion Foreign APIs —
the standalone build needs it; and repeated inbound requests to a known address cannot be bounded
cheaply). Two inherent ones (the 404-vs-503 presence oracle; no runtime integrity on the WASM,
which SRI could not fix anyway for same-origin files). **Two that are new work and should be
built:** `patches/` is applied over the pinned tree and is itself outside the pin, and the
deployed site is never re-verified against the build manifest — the second is the attack that
matters most for a self-custodial wallet, since whatever `$ACC_SITE_DIR` serves is what signs a
visitor's transactions.

Both are in the audit in full. In short:

- **A-11** (`patches/` is outside the pin): a `patches/SHA256SUMS` verified by the same three
  checks `acv_verify_vendor` already runs, in the same order — manifest hash from `PINNED_SHA`
  first, then `sha256sum -c`, then the file set **both ways**. Two deliberate differences from
  `vendor/`: it is **fatal on a clean tree, advisory on a dirty one** (editing a patch is normal
  work; editing `vendor/` never is), and regeneration is a repo commit, never a VPS action —
  which needs saying twice here precisely because this manifest legitimately changes often.
- **A-12** (the deployed site is never re-verified): `accio_verify_deployed`, the same three
  checks over `$ACC_SITE_DIR`, **plus an off-box hash** of the manifest. The on-box half catches
  accident and a partial deploy; only the off-box line resists someone with root, and 082 already
  has that pattern and its wording.

Not implemented because the code belongs in `052_lib_vendor.sh` and `052_lib_build.sh`, and the review that
specified them does not chase a fix across a boundary. **A-12 is the most valuable unwritten thing in this product:** every other
control in the pin chain exists to decide which bytes get written into `$ACC_SITE_DIR`, and
nothing has ever looked at them afterwards.

### Smaller known gaps

- `ACC_ADDR_HRP` and `ACC_STANDALONE_SRC` are set and read by nobody (`ACC_STANDALONE_SRC` is the only pointer to the second pinned upstream). Nothing in the shell layer ever checks an address HRP, so `tgrin`/`grin` separation rests entirely on the browser wallet's chain type.
- A hostile hidden service's **response** body has no size cap on the `/tor/` rail, only the 180 s deadline — tolerable because the pipe applies backpressure and the bytes go to the browser that asked.

**Worth knowing before the first content edit after launch:** a `Version 0` entry (upstream's "emit no `?query`") is not cache-busted, so a later change to `privacy_policy.txt` will not reach
a browser that already has it. Harmless now (nothing has ever been served), but bump that entry
to 1 the first time the policy changes in anger.

**`logo_big.svg` is placeholder-quality.** It is a geometric stroked *ACCIO*, built by hand
because there is no drawing tool in this loop: the letterforms are correct, nothing clips the
`278×47` viewBox at `stroke-width:6`, and it is white-on-transparent like upstream's — but the
letter spacing is loose and uneven (gaps of 31/36/41/36 units). It renders as a CSS
`background-image` at the top of the unlocked view, so it is the single most visible thing on
the page. Look at it in step 3 and treat replacing it as a design task, not a bug.

**Two residuals the earlier audit did not name.** `favicon.ico` is still upstream's MWC mark in
the tree and still listed in `$files` (`FAVICONS` is empty, so nothing links to it, and a page
with an explicit `<link rel="icon">` never falls back to `/favicon.ico` — but a direct fetch of
that path still serves the bowtie). And `fonts/mwc/` is no longer linked from `index.html` yet
remains in `$files`, so the service worker still precaches it. Both are file-deletion work,
which is deletion-pass work; neither is user-visible.

Two knowingly accepted: `--acc-faint` on a panel is 3.6:1, used only for placeholders and
disabled controls (WCAG exempts disabled, placeholders are advisory); and the toggle switch
inherits the dark ink, which is inert because it carries no text — verified, it has no
`content` and its knob is a `> span`.

## Deletion passes (optional)

**S9's deletion passes are the one exception, and they are optional.** They are authorable
offline like everything else, and pass 1 was, but the design gates them on *"the acceptance runs are green"* — i.e.
on the acceptance session having happened. Pass 1 crossed that gate knowingly and paid for it in
argument and static verification; **pass 2 should wait for a box**, because it is the pass that
starts deleting files rather than reducing one.

**Pass 2 — the 3D logo / Tetris.** `models/mwc.json`, `shaders/logo.frag`, `shaders/logo.vert`,
`glMatrix`, `tetris.js`, `styles/tetris.css`, and the WebGL half of `logo.js` (already inert). These are leaf assets with no money-path reference, so this pass genuinely can delete
files — and it is where the **file-deletion machinery** has to be built: removing a file from the
stage, dropping its `$files` entry from `backend/resources.php`, and asserting that no staged
file still calls `getResource()` on a path that no longer exists. That machinery was deliberately
*not* built here, because this pass deletes no file and unused build machinery is worse than
none.

**Pass 3 — non-Grin fonts.** `fonts/btc`, `fonts/eth`, `fonts/epic`, `fonts/mwc` and the `.mwc`
rule in `styles/common.css`. The overlay already stopped *fetching* the MWC glyph font; this removes the
files.

## Acceptance runs owed (S2)

Everything the build authored and reviewed owes a run on a box. Grouped by subject; the first VPS session works through them in this order.

### Pin and build

**First build:**

The real acceptance run — `apt-get install -y php-cli
php-mbstring php-intl`, then "Rebuild site" **twice**, then
`diff /opt/grin/accio-test/site.SHA256SUMS.prev /opt/grin/accio-test/site.SHA256SUMS`.

**Pin and upstream check:**

1. **Run key `5` → `1` Verify** on the box before the first build. It should report 274 files and
   the same manifest hash. If it does not, the transfer to the VPS corrupted the tree — find that
   out before nginx serves it, not after.
2. **Run key `5` → `2` Check upstream** once with real network. It has only ever seen a `file://`
   remote; this proves the real fetch, and the pin was already ~10 days old at vendor time, so expect a
   short list rather than "no changes". **Do not take an update before launch** — record it.
3. Confirm the report file lands in `/opt/grin/logs/` and that the scratch dir under `/tmp` is
   gone afterwards.

**Overlay and branding:**

1. **`php -l` on the two patched PHP files** — `backend/language.php` and
   `backend/resources.php`. There is no PHP on the dev machine, so the brand layer and the
   icon/attribution tables have never been parsed. Do this *before* the first build; a parse
   error there fails every render at once.
2. **Rebuild site**, then read the log: 16 `patched` lines and 14 `sri` lines, no `ERROR`.
   The 14 break down exactly, and any other split means the overlay drifted from the table:
   **10** `checksum refreshed` (4 SVGs + 6 JS), **2** `upstream sets no checksum here, none
   written` (`privacy_policy.txt`, `MWC Wallet license.txt` — both `Checksum => NULL` by
   upstream's own convention for files fetched as links, not as subresources), **1**
   `templated, checksum cleared` (`site.webmanifest`), **1** `not in the resources table`
   (`index.html`, which upstream never lists). The two `backend/` files are excluded by
   design and produce no `sri` line at all.
3. Load the site and confirm, in this order — the page shows the **Accio wordmark** (not a
   blank space, which would mean the logo CSS assumption in decision 2 is wrong); the tab icon
   is the violet Grin roundel; Settings → Wallet type offers **only Grin**; About shows the
   **MWC Wallet credit** with a working licence link and a source link to our repo; the Donate
   section is **gone**; then switch the language to German and confirm the strings stay
   branded — that is the one check that proves the table-key branding, and the one thing no
   unit test here could reach.
4. `curl -s https://<domain>/site.webmanifest | python3 -m json.tool` — must parse, must carry
   one SVG icon, and must list exactly four `web+grin*` protocol handlers.
5. Re-run the send and the receive against the **rebranded** build, not just the pristine
   one — the patched `consensus.js` and `node.js` are both on the money path.

**MQS reduction:**

Two runs, the ones the design names: **a send and a receive after a rebuild.** Specifically —
build the site, confirm `scripts/mqs.js` in the published tree is the stub and that the browser
does not report an SRI failure on it (the one failure mode a wrong checksum here produces is a
wallet that never boots), then send once and receive once. A payment **with a payment proof** is
the run that matters, because that is the path `Slate.compactProofAddress` is on.

**Build review:**

Nothing new in kind — but the count post-condition and the swap rollback are both first-run
behaviours that only a real build exercises, and the standalone `current.html` rename wants a
concurrent download during a rebuild to prove it. As ever: **nothing here has run on a VPS.**

### Gateway

**`/tor/` forwarder:**

1. `3) Gateway service → 1) Install`, then `→ 3) Self-test` — the self-test probes must
   all pass on the box (16 since the `/listen` rail; see the next list).
2. `→ 2) nginx glue`, then confirm `nginx -t` and that `/tor/` reaches the gateway.
3. The real thing: from the browser wallet, **send tGRIN to a Fidelius onion address and have
   it arrive.** Then re-confirm that `curl` of `/tor/http://127.0.0.1:3413/v2/foreign` is
   refused.
4. Confirm the box is running stock nginx: no `load_module`, no `.so` referenced in any conf,
   no `php-fpm` process.

**`/listen` rail and inbound URL:**

1. `→ 3) Self-test` now runs **16** probes; all must pass, including the durability check.
2. `→ 2) nginx glue` on a box that already has the `/tor/`-era zone file — confirm the regeneration path
   runs and `nginx -t` is clean **before** any reload.
3. The real thing: **have Fidelius pay a browser wallet's `/wallet/<suffix>` address and watch
   it arrive**, then confirm the receiving address is unchanged after `systemctl restart`.
4. Confirm stock nginx (no `load_module`, no `.so` in any conf) and no `php-fpm`.

**Entry script and uninstall:**

An uninstall on a box where the include landed in a vhost we did not name, followed by a real
`systemctl restart nginx` — `nginx -t` is not the test, because the failure mode is nginx
refusing to start. And the network picker's badge after an uninstall.

**Gateway install:**

Everything the install review touched is still un-run. Two acceptance steps it adds:

- **The self-test must read 16/16** on a fresh install, and the `/listen` probe specifically
  must report 426 — that probe has never passed.
- **On a box installed before the `/listen` rail, run "nginx glue" and then confirm all three `accio_*` zones exist in a
  file nginx actually loads** before any reload. This is the only finding that can take the
  whole box down, and it is invisible from the screen that used to report it.

**Gateway core:**

- The **port allowlist is a behaviour change**: a payee whose onion Foreign API is not on 80 or
  443 is now refused. Nothing we ship composes such an address, but the first send to a third
  party is what would find out. Set `allowed_destination_ports: []` to restore any-port.
- **Restart the gateway twice during acceptance** and confirm the receiving address is
  unchanged both times. C1 means a state dir the service cannot read now stops the service,
  which is the intended behaviour and will look like a failed deploy if it ever fires.

**Money rails:**

- **Blocking, and upgraded from a curiosity by C1:** watch a real client send `Own URL` for every
  held suffix on reconnect. With the fallback gone, a client that does not claim cannot receive at
  all. `inbound_unclaimed` in `/health` is the instrument — it should be near zero in steady state
  and non-zero only around reconnects.
- Confirm a receive still works with the body cap at 128 KiB. Nothing we ship composes a slate
  anywhere near it, but the first real receive is what would find out.

**Security audit:**

Six items, listed at the end of the audit: watch a real client claim its addresses (then delete
A-1's fallback); `curl -I` the headers on `/`, on an asset and on `/standalone.html`; confirm the
tightened CSP boots the wallet, then drop `'unsafe-eval'` and confirm again; confirm
`IPAddressDeny` did not break `/tor/`; confirm the address table survives a restart on the box;
and probe `/tor/` against a hostile onion of your own that answers with `Set-Cookie`, a
`Location` and its own CSP.

### Nginx, TLS and the onion

**Web front, TLS, onion, standalone:**

1. `nginx -t` clean after the deploy, and **every other vhost on the box still answering** —
   that is the check that matters, not Accio's own.
2. A real **mainnet** GRIN send and receive, *after* the same round trip has passed on testnet.
3. The certificate issues, the site loads over HTTPS, and the security headers are actually
   present **on an asset response and on `/standalone.html`**, not just on `/`. Those are the
   two locations that set their own `add_header`, so they are where trap #1 would show.
4. The onion: `cat /var/lib/tor/grin-accio-<net>/hostname` publishes, the page loads over it,
   a send and a receive work through the onion front, and the wallet's "Onion Service" address
   type hands out **the onion**, not the clearnet host (that is the rebuild in decision 3).
5. The standalone artefact: it builds, `/standalone.html` downloads it, and the saved file
   **opens from `file://` with the network off** and can build and sign a payment. Check the
   leftover-reference warning count while you are there.
6. Hub 05 key `2` opens Accio, and the other keys still open what they always did.

**Onion path ports:**

The whole of it, unchanged — but C1 adds one acceptance step that did not exist: after
enabling the onion, **confirm nginx holds `:7591` and the gateway holds `:7590` at the same
time**, and that the gateway is still running. That is the check the old status screen could
not have made. As ever: **nothing here has run on a VPS.**

### Branding and theme

**Brand maps and the standalone:**

- **Switch the language to Dutch, Greek and Simplified Chinese and read the title bar, the error
  page and the balance screen.** That is the fix this pass made and the only place it can be
  confirmed. English proves nothing here — English was never broken.
- **Open the standalone artefact with the network tab recording.** It must make no request to
  `api.github.com`, or to anything else it was not asked to.
- Confirm the About page still renders the upstream credit with its licence link, and that
  `MWC Wallet license.txt` resolves from the served root — it has a space in its filename and is
  reached through an `<a href>`, which is upstream's own pattern but has never been loaded.

**Theme:**

**Nothing in the theme has been seen in a browser.** It is CSS against a DOM read from source.

- **Look at the unlocked screen.** The whole flip depends on `main > div.unlocked > div > div > div`
  being the one rule that paints both content panels. Read from source; never rendered.
- **Tab through it.** `:focus { outline: none !important }` is upstream's, in the inline `<style>`,
  so every focus ring here is a `box-shadow`. If one group was missed, that control has no visible
  focus state at all.
- **Open a message dialog** (send confirmation, or a seed phrase). Its container, its `h2` and its
  `p` are styled in `index.html`'s inline `<style>`, not in `message.css` — a different override
  path from everything else, and the screen where a seed is read.
- **Force a 404 and a 503.** That is the only way to confirm the `errors/template.php` link
  resolves; the leading-dot idiom is upstream's, but ours is the first line to use it for a file
  upstream never had.
- **Install the PWA** and watch the splash. That is `BACKGROUND_COLOR` and
  `startup_images_creator.js`, and nothing else exercises it.
- **Narrow the window below 400px** for the separator rule, and check the "Remind me later"
  variants in the notification bars — both live only in `max-width` media queries.
- **Plug in a Ledger** and see whether a `Grin` app is installable and connects. If it is not
  available to ordinary users, the honest move is a note beside the button — not deleting a
  working code path.
