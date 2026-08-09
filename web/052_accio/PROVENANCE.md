# Accio (052) — provenance of `vendor/`

**What `vendor/upstream-wallet/` is:** a byte-exact copy of
[`NicolasFlamel1/mwcwallet.com`](https://github.com/NicolasFlamel1/mwcwallet.com) at commit
`adef11da` (version 2.8.2, released 16 Jun 2026), vendored **2026-08-09** under the **MIT**
licence. It is a self-custodial browser wallet — keys live in the tab, never on a server —
and **Grin is already a first-class wallet type in it**, so this toolkit ports no
cryptography and compiles no WASM.

A **second, much smaller** upstream is vendored beside it:
[`NicolasFlamel1/MWC-Wallet-Standalone`](https://github.com/NicolasFlamel1/MWC-Wallet-Standalone)
at `043c2ddc` (MIT, 4 files) in `vendor/upstream-standalone-build/`. It is not part of the
wallet — it is the *build script*, and it is the behavioural spec for two later packets.

The exact pins, the reproduction command and the measured checksums are in
[`PINNED_SHA`](PINNED_SHA); the per-file manifest is [`vendor/SHA256SUMS`](vendor/SHA256SUMS),
which covers **both** trees (274 files, `sha256sum -c` clean at vendor time).

## ⛔ Never edit anything under `vendor/`

Changes go in `patches/`, applied as an **overlay at build time by file replacement** —
never `sed` into the vendored tree. Two things depend on that:

1. `vendor/SHA256SUMS` is the integrity pin. One edited byte fails the build (S6).
2. `git log adef11da..upstream/master` is how we review upstream security fixes. Editing in
   place makes that diff unreadable, which retires the review policy by accident.

## Why we vendor instead of fetching

Upstream's `build.sh` (now vendored at `vendor/upstream-standalone-build/build.sh`) line 4
`wget`s `master.zip` and line 316 deletes the tree: **unpinned**
(two runs a week apart build different wallets) and **non-durable** (it dies if the repo is
deleted, renamed or force-pushed). Every third-party library is *already committed as a file*
upstream — `third-party libraries instructions.txt` documents how they were produced, it is
not a fetch step — so vendoring this one repo captures the entire browser build with **zero**
remaining build-time downloads. Build tooling is plain PHP: no npm, no cargo, no wasm-pack,
nothing that rots.

**MIT is irrevocable for the copy we received.** With this tree and its `LICENSE` committed,
Accio is permanently independent. Everything after S0 removes *operational* dependencies —
it cannot add independence, because S0 already made it total.

## Upstream disposition table

| Upstream | Role | Size | License | Disposition |
|---|---|---|---|---|
| `mwcwallet.com` | the wallet itself (JS/PHP/CSS/WASM) | 7.1 MiB measured | **MIT** | ✅ **vendored** here at `adef11da` |
| `SOCKS-Proxy` | nginx module — browser→Tor outbound | 70 KB | MIT | ♻️ replaced by our Node gateway (S3) |
| `Block-Access` | nginx module — SSRF guard on `/tor/` | 40 KB | MIT | ♻️ replaced by our allowlist (S3) |
| `Allow-Headers` | nginx module — response-header allowlist | 6 KB | MIT | ♻️ replaced by our forwarder (S3) |
| `headers-more-nginx-module` | nginx module — **the whole security-header stack** | — | BSD | ♻️ replaced by stock `add_header … always` (S2) |
| `WebSocket-Listener` | C++ daemon — the **receive** rail | 338 KB | ⛔ **NONE** | ✍️ reimplemented (S4a/S4b) — cannot be vendored |
| `MWC-Wallet-Standalone` | build script only (4 files) | 75 KB | MIT | ✅ **vendored** at `043c2ddc` — spec for S1 + S7 |

The four nginx modules are deliberately **not** vendored. The first three build as `.so`
against the exact installed nginx, so an `apt upgrade nginx` makes `load_module` fail and
nginx then refuses to start **at all** — taking down every other vhost on the box (Fidelius,
GrinScan, the pool, Drop, the node API). They collapse into the one Node service we must
write anyway. Result: stock nginx, no modules, no apt-hold.

**⚠ There are FOUR modules, not three** (corrected 2026-08-09, during the S0 review).
Upstream's README lists only three; it omits `headers-more`, which `nginx.conf` nonetheless
uses **29 times** (`more_set_headers`, `more_clear_headers`) and which delivers the site's
entire header posture: `Content-Security-Policy`, `Strict-Transport-Security`,
`Cross-Origin-Opener-Policy`, `Cross-Origin-Embedder-Policy`, `Permissions-Policy`,
`Referrer-Policy`, `Onion-Location`, `Set-Cookie` and the `Link` preload header. This one is
replaceable with **stock** `add_header`, so the no-modules conclusion survives — but S2 must
handle three differences:

- `add_header` in a child block **discards every `add_header` inherited from its parent**.
  Re-declare the full set in each `location` that adds even one header, or the CSP silently
  disappears from exactly the routes that matter.
- `more_set_headers -s 200` is status-filtered; plain `add_header` covers only a fixed status
  list. Use `add_header … always`.
- `more_clear_headers Server` has **no stock equivalent** — `server_tokens off` shortens the
  value to `nginx` but cannot remove the header. Accept it, or strip it in the Node gateway
  for the gateway's own responses.

COOP/COEP are *not* load-bearing: `scripts/common.js:16` uses `SharedArrayBuffer` only when
`crossOriginIsolated`, and `:1994` defines a `false` fallback, so losing cross-origin isolation
degrades the wallet rather than breaking it. CSP and HSTS are a different matter — those are
security posture, and dropping them silently is the failure mode to guard against.

`WebSocket-Listener` carries no `LICENSE`/`COPYING` and no licence mention in its README
(verified 2026-08-08) — all rights reserved, so it may not be vendored, redistributed or
shipped in a deploy script. Its wire protocol is readable from the MIT *client*
(`public_html/scripts/listener.js`), which is what S4a specs and S4b implements.

## What was removed at S0 (3 of upstream's 273 files)

| Path | Action | Why |
|---|---|---|
| `fullchain.pem` | **deleted** | upstream's own dev cert — never redistribute someone else's certificate |
| `privkey.pem` | **deleted** | upstream's own **private key** — same, more so |
| `nginx.conf` | moved → `docs/upstream-nginx.conf.reference` | it is the *spec* S3/S4b replace (the `/tor/` regex, the header allowlists, the gateway on `:9000`), not config we deploy. Kept out of `vendor/` so it can never be mistaken for a file we install. |

`vendor/` is otherwise unrenamed and unmodified, including upstream's own `.gitignore`
(single line `private`; no such path exists in the tree, so it excludes nothing).

## `vendor/upstream-standalone-build/` — why a build script is pinned too

Added 2026-08-09 during the S0 review. All four of its files are vendored verbatim; nothing
was removed. Its `LICENSE` is **byte-identical** to the wallet's (same MIT text, same
`Copyright (c) 2022-2026 Nicolas Flamel`, same `bbc8b96c…`).

It is here because two later packets are specified to reimplement it, and pointing them at an
unpinned `master` on a second repo would reintroduce exactly the durability problem this whole
directory exists to solve:

- **S1** inherits its *contract*, not its code: the env vars its PHP templates expect
  (`SERVER_NAME`, `HTTPS`, `HTTPS_SERVER_ADDRESS`, `TOR_SERVER_ADDRESS`, `NO_FILE_VERSIONS`,
  `NO_FILE_CHECKSUMS`, `NO_MINIFIED_FILES`), and the proof that `php` runs at build time —
  the whole reason no `php-fpm` reaches the VPS.
- **S7** reimplements its inlining phase as a loop.

**We never run it.** It `wget`s an unpinned `master.zip` (line 4), `chmod 777 -R`s the tree
(line 7) and `rm -rf`s its own working files (line 316). A toolkit action must be idempotent
and must leave a live box intact. Read it as a specification; `052_lib_build.sh` is ours.

Measured, not inherited: `build.sh` is **316 lines**. Lines 1–37 copy and PHP-render the tree
into `./temp/` — *that intermediate tree is exactly what we want to serve*. Lines 39–311 are
the inlining phase (**273 lines, of which 253 are `sed -i`**) that folds every image, font,
WASM blob and script into one `index.html`; that phase is only needed for the S7 standalone
artefact. It is machine-generated — one near-identical command per file, each repeating the
same 250-character env prefix. Do not transcribe it. Ours is a loop.

## Measurements, verified against this tree on 2026-08-09

| Measure | Value |
|---|---|
| Wallet files vendored | 270 (upstream ships 273) |
| Wallet size | 7,443,197 bytes (7.10 MiB) |
| Standalone-build files | 4 — 74,763 bytes |
| **Manifest total** | **274 files / 7,517,960 bytes** |
| `public_html/scripts` | 5,765,081 bytes across 105 JS files |
| PHP files | 11 — **build-time only**, see below |
| WASM blobs | 5, all prebuilt and committed upstream |
| Grin default nodes | 10 mainnet + 10 testnet in `scripts/node.js` |

- **WASM:** `secp256k1-zkp-0.0.29` (91,788 B), `Ed25519-0.0.22` (69,102 B),
  `X25519-0.0.23` (24,693 B), `BLAKE2b-0.0.2` (16,178 B), and **`SMAZ-0.0.31`** (13,243 B) —
  the fifth blob is not in the original design note; it is short-string compression, not crypto.
- **Grin is already wired to this toolkit:** `scripts/node.js:512` lists `https://api.grin.money`
  and `:535` lists `https://testapi.grin.money` — our own Script 04 endpoints, in upstream's
  stock default node list.
- **Size note:** the design doc said "4.7 MB", which is GitHub's packed repository size. The
  working tree measures 7.10 MiB. Nothing is missing — `diff -r` against a fresh
  `git archive` of `adef11da` is empty.
- **PHP is build-time only.** Its sole per-request inputs are `HTTP_ACCEPT_LANGUAGE`,
  `SERVER_NAME`/`HTTPS` and a Googlebot check, all fixed or enumerable per deployment. S1
  prerenders one static page per language, so **no php-fpm reaches the VPS** — and
  `public_html/.user.ini` (a php-fpm runtime config, with upstream's own
  `session.save_path=/srv/mwcwallet.com/sessions`) must never be deployed.

## Line endings — the trap that already bit once

Upstream's blobs are **LF**. Cloning on Windows with `core.autocrlf=true` rewrites every text
file to CRLF on checkout, **and `git archive` honours that setting too** — the first attempt
at this vendoring produced a tree whose `LICENSE` hashed `eb2c5d88…` instead of upstream's
`bbc8b96c…`. **It bit a second time on the same day**, vendoring the standalone-build repo:
a default clone of it produced that identical wrong hash for the identical MIT text. Treat
the trap as certain, not likely. Always re-vendor with
`git -c core.autocrlf=false -c core.eol=lf archive`, and
note that `web/052_accio/.gitattributes` marks `vendor/**` as `-text` so this repo's own
`* text=auto eol=lf` rule can never renormalise the pinned bytes.

## Naming policy — three layers, three rules

1. **Names we choose** (dirs, scripts, systemd units, config keys, our UI) — 100 % Grin/Accio,
   zero MWC, from the first commit. Hence `vendor/upstream-wallet/`, not `vendor/mwcwallet.com/`;
   a neutral directory name is fine, *obscuring* the origin is not — which is what this file is for.
2. **User-visible strings** — 100 % Grin/Accio via the S5 build overlay. Cheap, reversible,
   and this is what actually delivers "no MWC anywhere" to a visitor.
3. **Identifiers inside `vendor/`** — **DELETE, never rename.** `MWC_WALLET_TYPE` is a protocol
   discriminator, not branding: MWC and Grin are different chains here (different HRPs, emission,
   address types). A global MWC→Grin rename would make a wallet silently running MWC consensus
   under a Grin label invisible to review — strictly worse than leaving the name alone.

## The one thing that must stay verbatim

`vendor/upstream-wallet/LICENSE`, `Copyright (c) 2022-2026 Nicolas Flamel`
(sha256 `bbc8b96cd3c66cd7d69ec75aaeae3b0d5d81d955771fadf7bc0cdc953728e32f`). MIT requires the
copyright notice be retained; it stays no matter how much else is deleted. The About-page
credit is the courteous form of the same obligation, and the mechanism already exists —
`public_html/backend/resources.php` has an `ATTRIBUTIONS` array (name → URL, licence path,
licence type) already rendering a credits list. S5 adds one entry for the upstream wallet.

## Update policy — watched, never depended on

Never *depend* on upstream to build; always retain the *option* to take a fix. S6 adds a
**Check upstream** action to `scripts/lib/052_lib_vendor.sh` that verifies both trees against
`vendor/SHA256SUMS` and reports `git log adef11da..master` (wallet) and
`git log 043c2ddc..master` (standalone build) for review. Taking a fix is a deliberate
re-vendor + re-pin, with the commands in `PINNED_SHA`. The wallet is the one that matters —
it is self-custodial and ships security fixes; the build script is a frozen spec and needs
watching only if we ever revisit S7.

Design → `docs/generated/script052_design.md`. Session log → `docs/generated/script052_implementation.md`.
