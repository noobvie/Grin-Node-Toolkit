# Script 052 — Accio, the Grin public web wallet (design)

**Status: IN BUILD.** `052` was born on **2026-08-09** with build packet **S0 (Vendor & pin)**:
`scripts/052_grin_accio.sh` exists as a menu skeleton (every action a stub) and
`web/052_accio/vendor/upstream-wallet/` holds the pinned MIT upstream at `adef11da`. Nothing is
deployed and hub 05 key `2` still dispatches `_slot_notice` until S7. Independence is already
permanent — see §"Read this first".

- Provenance and the pin → `web/052_accio/PROVENANCE.md`, `web/052_accio/PINNED_SHA`
- Session log (the handoff between build sessions) → `docs/generated/script052_implementation.md`
- Moved here from `script05_design.md` PART A at S0, per the numbering rule: an unbuilt product
  lives under its hub's number; it gets its own the day its first file is created.

---

> **Rewritten 2026-08-08.** The previous design said to `wasm-pack build` the grin-wallet Rust
> crate and hand-write a browser wallet around it. That premise was **wrong on both halves**
> and is preserved only in git history. See "Correction of premise" below.

## Correction of premise

Two findings from reading the actual upstream, both of which shrink the work by an order of
magnitude and move the risk somewhere completely different:

1. **The repo to refactor is not `MWC-Wallet-Standalone`.** That repo is *only a build script*.
   Its `build.sh` `wget`s `NicolasFlamel1/mwcwallet.com` and inlines it into one self-contained
   HTML file. The real source is **`NicolasFlamel1/mwcwallet.com`** — MIT, v2.8.2 (16 Jun 2026),
   actively maintained, 105 JS files / ~6 MB of scripts, PHP + nginx backend.

2. **Grin is already a first-class wallet type upstream.** `consensus.js` carries
   `Consensus.GRIN_WALLET_TYPE` throughout, with `grin`/`tgrin` HRPs and Grin's own emission
   and fee rules; `node.js` ships **10 mainnet + 10 testnet default Grin nodes** — including
   `https://api.grin.money` and `https://testapi.grin.money` (this toolkit's own Script 04
   endpoints) at `node.js:512` and `node.js:535`. The author confirms it on the Grin forum:
   the wallet "works with Grin, Epic Cash, and MimbleWimble Coin."

**There is therefore no cryptography to port and no WASM to compile.** All the crypto is
already vendored as prebuilt WASM in the upstream repo (`secp256k1-zkp-0.0.29.wasm`,
`Ed25519-0.0.22.wasm`, `X25519-0.0.23.wasm`, `BLAKE2b-0.0.2.wasm`). The work is **vendoring,
de-branding, and server-side deployment**.

## The durability problem — why we vendor, not fetch

Upstream's `build.sh` line 4 is:

```bash
wget "https://github.com/NicolasFlamel1/mwcwallet.com/archive/refs/heads/master.zip"
```

…and line 316 deletes the extracted tree. That build is **unpinned** (it takes `master` HEAD,
so two runs a week apart produce different wallets) and **non-durable** (it dies the moment
the repo is deleted, renamed, or force-pushed). A wallet product that cannot be rebuilt from
our own repo is not a product we can ship.

**Decision: vendor every upstream into `Grin-Node-Toolkit` and write our own build script.**
This is legal for everything MIT, and cheap — the entire browser side is one 4.7 MB repo, and
because all third-party libraries are *already committed as files* upstream (the
`third-party libraries instructions.txt` is documentation of how they were produced, not a
fetch step), vendoring that one repo captures the whole browser build with **zero** remaining
build-time downloads. Build tooling is plain PHP — no npm, no cargo, no wasm-pack, nothing
that rots.

| Upstream | Role | Size | License | Disposition |
|---|---|---|---|---|
| `mwcwallet.com` | the wallet itself (JS/PHP/CSS/WASM) | 7.10 MiB measured | **MIT** | ✅ **vendored** at `adef11da` |
| `SOCKS-Proxy` | nginx module — browser→Tor outbound | 70 KB | MIT | ♻️ **replace** — see "Stack simplification" |
| `Block-Access` | nginx module — SSRF guard on `/tor/` | 40 KB | MIT | ♻️ **replace** |
| `Allow-Headers` | nginx module — response-header allowlist | 6 KB | MIT | ♻️ **replace** |
| `headers-more-nginx-module` | nginx module — **CSP/HSTS/COOP/COEP and the rest** | — | BSD | ♻️ **replace** with stock `add_header … always` (S2) |
| `WebSocket-Listener` | C++ daemon — the **receive** rail | 338 KB | ⛔ **NONE** | ✍️ **reimplement** (cannot vendor) |
| `MWC-Wallet-Standalone` | build script only (4 files) | 75 KB | MIT | ✅ **vendored** at `043c2ddc` — spec for S1 + S7 |

**Net result: we vendor two upstream repos — the wallet and a 4-file build script we never
run — and write one service of our own.** (S0 vendored the wallet; the build script was added
in the S0 review, because S1 and S7 are both specified to reimplement it and an unpinned
`master` on a second repo is the same durability hole this section exists to close. Size
correction from the same review: 4.7 MB was GitHub's *packed* repo size; the working tree is
7,443,197 bytes.)

### ⛔ The one hard blocker: `WebSocket-Listener` is unlicensed

No `LICENSE`, `LICENSE.md`, `LICENSE.txt` or `COPYING`, and no licence mention in the README
(verified 2026-08-08). Unlicensed means **all rights reserved** — we may not vendor,
redistribute, or ship it in a deploy script. It is also the least-maintained of the set (last
push Nov 2025).

This matters because it *is* the inbound path. A browser tab cannot open a listening socket
or a Tor hidden service, so upstream's answer is a server-side gateway: it mints a public
HTTPS Foreign-API URL per browser wallet (`/wallet/<id>/v2/foreign`) and relays POSTs down an
open WebSocket to the tab (`/listen`).

**Our answer: reimplement the `/listen` gateway ourselves.** The wire protocol is fully
readable from the *client* side, which is MIT (`listener.js` — `CREATE_URL_REQUEST_NAME`,
`CHANGE_URL_REQUEST_NAME`, `OWN_URL_REQUEST_NAME`, `DELETE_URL_REQUEST_NAME`, the
OK/UNAUTHORIZED/FORBIDDEN/NOT_FOUND/UNSUPPORTED_MEDIA_TYPE response set, and its retry and
timeout constants). Reimplementing a server against an MIT client is clean-room enough and
leaves us owning the one component we must be able to patch. We have directly relevant
experience: **093 Grin Transporter** is already a Node + SQLite store-and-forward slate queue,
so the same lib patterns apply. Ask upstream to add a licence anyway — if they do, deploying
theirs becomes a valid alternative, but the plan must not *depend* on that answer.

## Stack simplification — how we get to stock nginx and no PHP

Upstream's server stack carries two liabilities we should not inherit. Both are removable,
and removing them is what makes the deployment genuinely ours.

### Liability 1 — the nginx C modules (the real operational hazard)

They build as `.so` files against the **exact** installed nginx version (the build patches
copies of `ngx_http_proxy_module.c` / `ngx_http_upstream.c` inside the module tree; the stock
nginx binary is *not* replaced). An `apt upgrade nginx` therefore makes `load_module` fail —
and nginx then **refuses to start at all**, taking down every other vhost on the box
(Fidelius, GrinScan, the pool, Drop, the node API). Same failure class as the CLAUDE.md
warning about package upgrades resetting `nginx.conf`. Mitigating it needs `apt-mark hold`
plus a drift-rebuild plus an `nginx -t` gate — three moving parts guarding a risk we can
simply delete instead.

**Delete it: all three modules collapse into the one service we already have to write.**

| Module | What it really does | Our replacement |
|---|---|---|
| `SOCKS-Proxy` | HTTP request → Tor SOCKS5 `127.0.0.1:9050` | ~50 lines of Node over `socks-proxy-agent` |
| `Block-Access` | destination filter on `/tor/` (SSRF guard) | an allowlist check in our forwarder — **more** auditable, since it's our code |
| `Allow-Headers` | strips every *response* header except an allowlist (stops a hostile onion injecting headers) | we build the response ourselves and copy only allowlisted headers |

Because `WebSocket-Listener` is unlicensed and must be reimplemented anyway (below), this is
**one** Node service, not two. nginx then does nothing but serve static files and
`proxy_pass` — **stock nginx from apt, no modules, no version hold, no ABI hazard, and no
coupling of the other products to Accio.**

#### ⚠ There is a FOURTH module, and upstream's README does not list it

Found in the S0 review (2026-08-09), by reading the conf rather than the README. Upstream's
`nginx.conf` calls `more_set_headers` / `more_clear_headers` **29 times** — that is
`headers-more-nginx-module`, and it carries the site's **entire** security-header posture:

`Content-Security-Policy` · `Strict-Transport-Security` · `Cross-Origin-Opener-Policy` ·
`Cross-Origin-Embedder-Policy` · `Permissions-Policy` · `Referrer-Policy` · `Onion-Location` ·
`X-Frame-Options` · `X-Content-Type-Options` · `Set-Cookie` · `Link` (preload) · `Vary` ·
`Cache-Control`

This does **not** overturn the no-modules conclusion — stock `add_header` covers it — but S2
must handle three differences, and the first one fails *silently*:

1. **`add_header` in a child block discards every `add_header` inherited from its parent.**
   Declaring one header inside a `location` drops the whole inherited set. Either declare the
   full set in every block that adds any header, or keep all of them in `server` scope and add
   none in any `location`. This is how a CSP disappears from exactly the routes that matter.
2. `more_set_headers -s 200` is status-filtered; plain `add_header` applies only to a fixed
   status list (200, 201, 204, 206, 301, 302, 303, 304, 307, 308). Use `add_header … always`.
3. `more_clear_headers Server` has **no stock equivalent.** `server_tokens off` shortens the
   value to `nginx` but cannot remove the header. Accept that, or strip it in the Node gateway
   for the gateway's own responses.

**COOP/COEP are not load-bearing** — `public_html/scripts/common.js:16` uses
`SharedArrayBuffer` only when `crossOriginIsolated`, and `:1994` defines a `false` fallback,
so losing cross-origin isolation degrades the wallet instead of breaking it. CSP and HSTS are
a different matter: those are security posture on a self-custodial wallet, and trap #1 above
drops them without any error.

**Rate-limit zones, same file, same packet:** upstream declares bare `tor`, `listen`, `wallet`
and `donate` zones. Zone names are global to nginx across every product on the box, so ours
must be `accio_*`, written through `nginx_ensure_rate_limit_zone` from
`scripts/lib/nginx_shared_helpers.sh` — never an inline `limit_req_zone` (CLAUDE.md rule 1).

### Liability 2 — PHP at runtime

11 PHP files. Their only per-request inputs are `HTTP_ACCEPT_LANGUAGE` (language
negotiation), `SERVER_NAME` / `HTTPS` (canonical + hreflang meta), and a Googlebot check —
all of which are fixed for a given deployment or enumerable at build time. Upstream already
proves this: `build.sh` sets `SERVER_NAME`, `HTTPS`, `HTTPS_SERVER_ADDRESS` and
`TOR_SERVER_ADDRESS` as env vars and runs `php` **once** to emit fully static output.

**So PHP becomes a build-time-only dependency.** We prerender one static page per language on
the build machine and serve the result. No `php-fpm` on the VPS, no PHP security surface, and
the runtime stack matches the rest of the toolkit.

### Resulting architecture

```
User's Browser (holds the seed; server never sees it)
  ├── secp256k1-zkp / Ed25519 / X25519 / BLAKE2b   ← prebuilt WASM, vendored
  ├── IndexedDB                                     ← encrypted wallet data per wallet
  ├── send    → /tor/<onion>  ──────────┐
  └── receive ← /listen (WebSocket)  ─┐ │
                                      │ │
Our VPS                               │ │
  ├── nginx (STOCK — static + proxy)  │ │
  │     /               → prerendered static HTML/JS/CSS/WASM
  │     /tor/<url>      ──────────────┼─┤
  │     /listen (WS)    ──────────────┤ │
  │     /wallet/<id>/v2/foreign  ─────┴─┴─→ grin-accio-gateway (Node, :9000)
  │                                           ├─ Tor forwarder + SSRF allowlist
  ├── tor (SOCKS 127.0.0.1:9050) ←────────────┤  + response-header allowlist
  │                                           └─ per-wallet inbound URL → open socket
  └── grin node (Script 01/04) ←───────────── browser polls chain via api.grin.money
```

Runtime daemons: **nginx + tor + one Node service.** Nothing under `/opt/grin/` holds a seed;
no `grin-wallet` binary is involved; custody is zero. Note it is still **not** a static site —
the gateway is what makes sending and receiving possible at all.

### Language choice

- **Browser side: keep upstream's JavaScript exactly as it is. Do not rewrite it.** That
  ~6 MB is audited, shipping, hardware-wallet-compatible MimbleWimble crypto. Reimplementing
  it in another language would discard the entire reason for choosing this upstream and is
  the single most dangerous thing we could do to a self-custodial wallet.
- **Server side: Node.js**, per CLAUDE.md's stack (Node/Express + SQLite is already the
  toolkit's web backend for 053, 059, 07 and 093). 093 Transporter is the same shape — a
  store-and-forward slate queue — so its lib patterns transfer directly. Go or Rust would buy
  nothing here and would be the only such component in the toolkit.
- **Build side: PHP**, on the build machine only, because that is what upstream's templates
  are and rewriting the template layer would fork us from every upstream security fix for no
  runtime benefit.

## Repo layout

```
scripts/
  052_grin_accio.sh              main product script
  lib/
    052_lib_vendor.sh            vendored-source integrity + pin check
    052_lib_build.sh             our replacement for upstream build.sh (prerender)
    052_lib_gateway.sh           install/manage the Node gateway service
    052_lib_nginx.sh             stock-nginx vhost + certbot + onion service
web/052_accio/
  vendor/upstream-wallet/        pinned upstream tree + PINNED_SHA + LICENSE
  gateway/                       our Node service: /listen + /wallet/<id> + /tor forwarder
  patches/                       branding + Grin-default overlay (see Stage 4a)
  PROVENANCE.md                  what vendor/ is, where it came from, the measurements
docs/generated/script052_*.md    design/implementation/security_audit, once 052 exists
```

No `vendor/nginx-modules/` — that is the point of the simplification above.

Per the numbering rule, `052_*` files and `script052_*.md` are created **the day the build
starts** — until then this design stays here under the hub's number.

## Naming policy — three layers, three different rules

The goal is that **nothing a user sees says MWC**, with a single credit in the About section.
That is achievable, but the three layers must be handled differently or we trade a cosmetic
win for a real hazard.

### Layer 1 — names we choose: 100 % Grin/Accio, zero MWC (free)

Directory names, script names, the systemd unit, the service, config keys, our own UI strings.
Nothing forces upstream's naming on us. Hence `vendor/upstream-wallet/`, not
`vendor/mwcwallet.com/`. `PROVENANCE.md` records what it actually is — a neutral directory
name is fine, *obscuring* the origin is not.

### Layer 2 — user-visible strings: 100 % Grin/Accio, via the Stage 4a overlay (cheap)

Title, branding, icons, fonts, the wallet-type selector, coin labels. All of it is reachable
from the build overlay without touching a code path. **This is what actually delivers "no MWC
anywhere" to a visitor**, and it lands in Stage 4a — early, cheap, reversible.

### Layer 3 — identifiers inside the vendored tree: DELETE, never rename

⚠️ **`MWC_WALLET_TYPE` is not branding — it is a protocol discriminator.** MWC and Grin are
different chains in this code: different HRPs, different emission, different address types.
A global MWC→Grin rename would not remove MWC; it would produce a codebase in which the Grin
path and the mislabelled MWC path are **indistinguishable**, so a wallet silently running MWC
consensus rules under a Grin label becomes invisible to review. That is strictly worse than
leaving the name alone.

A rename also destroys the update-check: `git log <PINNED_SHA>..upstream/master` becomes
unreadable when every identifier differs, which kills the "watched" policy outright.

**If we don't want MWC in the codebase, we delete the MWC code paths.** Scope, measured:
86 `MWC_WALLET_TYPE` occurrences across 17 files, 244 case-insensitive `mwc` hits in scripts —
concentrated in `api.js` (22), `consensus.js` (21) and `slate.js` (13). Tractable: roughly a
week, one file per commit, each verified by rebuild + the Stage 2 send + Stage 3 receive.
Optional Stage 4c, and only *after* the wallet is proven working — never as opening surgery.

### The one thing that must stay verbatim

`vendor/upstream-wallet/LICENSE`, carrying `Copyright (c) 2022-2026 Nicolas Flamel`. MIT
requires the copyright notice be retained — it is the condition under which we have the right
to use the code at all, and it stays regardless of how much we delete. The About-page credit
is the courteous version of the same obligation, and **the mechanism already exists**:
`backend/resources.php` has an `ATTRIBUTIONS` array (name → URL, licence path, licence type)
that already renders a credits list in the About section for jQuery, bech32, BLAKE2b and the
rest. Add one entry for the upstream wallet and the "mention it once as credit/inspiration"
requirement is done, in the app's own idiom.

## Roadmap

### Read this first: independence is won at Stage 0, and it is a licensing fact

**MIT is irrevocable for the copy we receive.** Upstream cannot un-license what is already
published, cannot delete our copy, and cannot change the terms retroactively. The moment the
vendored tree and its `LICENSE` are committed to this repo, Accio is **permanently
independent** — that is a property of copyright law, not something more engineering earns us.

Everything after Stage 0 therefore buys something *different*: it removes **operational**
dependencies (their build recipe, their nginx modules, their PHP, their unlicensed daemon) and
shrinks how much adopted code we carry. Both are real and worth doing. Neither adds
independence, because Stage 0 already made it total.

The one thing that would *reduce* safety while adding no independence is rewriting the browser
crypto. It is already MIT and already ours; a rewrite trades 128k audited, shipping lines for
new lines nobody has reviewed. **The way to shrink adopted code is deletion, not rewriting** —
see Stage 4.

### Stage 0 — Independence (½ day, no VPS)

Commit `vendor/upstream-wallet/` at a pinned SHA, with `LICENSE`, `PINNED_SHA`, and a short
`PROVENANCE.md` recording where it came from and the measurements in this document. Vendor the
tree **unrenamed** — see "Naming policy"; our own naming is Grin/Accio from the first commit.
*Exit criterion: the tree is in our repo under MIT. **Independence is now permanent.***

### Stage 1 — Own the build (1–2 days, no VPS)

Write `052_lib_build.sh`, our replacement for upstream's `build.sh`, reading **only** from
`vendor/`, never the network — this is what kills the unpinned `wget`. Prerender per language
so PHP is build-time only.
*Exit criteria: (a) `git clone` + build succeeds with networking off; (b) two runs produce
byte-identical output; (c) the built tree serves from a plain static file server with the
wallet UI fully functional up to the point of needing a network.*

### Stage 2 — Reference deploy on testnet, sends only (2–3 days, first VPS work)

Stock nginx + Tor + a testnet vhost pointed at `testapi.grin.money`, running the wallet
**unmodified**, with the `/tor/` route through a minimal forwarder. Prove the vendored wallet
works *before* we start changing things — never debug our patches and their stack at once.
*Exit criterion: a real tGRIN send lands, proven against a Fidelius wallet.*

### Stage 3 — Own the server (the biggest build; kills 4 upstream dependencies)

One Node service, `grin-accio-gateway`, carrying all four jobs: the `/listen` WebSocket rail
protocol-compatible with `listener.js`, the per-wallet `/wallet/<id>/v2/foreign` inbound URL,
the Tor forwarder replacing `SOCKS-Proxy`, and the SSRF + response-header allowlists replacing
`Block-Access` / `Allow-Headers`. Reuse 093 Transporter's lib patterns. This decides whether
Accio can receive at all, and it is what leaves the deployment 100 % ours.
*Exit criterion: a tGRIN payment **received** into a browser wallet, and the deployed box runs
stock nginx with zero custom modules and no php-fpm.*

### Stage 4 — Own the front end: overlay, then delete (optional, incremental, reversible)

**4a — Grin-default overlay + branding.** A `patches/` overlay applied at build time: Grin
forced as the default and only selectable wallet type, our node defaults first, Accio branding.
**Overlay, not surgery** — `MWC_WALLET_TYPE` branches touch 17 files including `crypto.js`,
`slate.js`, `slatepack.js` and `api.js`, and a self-custodial wallet is the worst place in this
toolkit to hand-edit crypto branching for cosmetic reasons.

**4b — Shrink by deletion.** Deleting code cannot introduce a cryptographic bug the way
rewriting can, and every deletion is verified the same cheap way: rebuild, re-run the Stage 2
send and Stage 3 receive. Do it one subsystem per commit. Measured candidates:

| Subsystem | Size | Verdict |
|---|---|---|
| MQS transport (`mqs.js`) | 39 KB / 1,361 lines | ✅ **free** — MWC-only rail, Grin never used it |
| Non-Grin coin fonts (mwc/epic/btc/eth) | 8 KB | ✅ free |
| 3D logo + Tetris easter egg (`logo.js`, `tetris.js`, `glMatrix`, `models/mwc.json`) | 466 KB / 11,372 lines | ✅ free — cosmetic only |
| Unused translations (6 language files) | 400 KB | ⚠️ product call — cheap to keep |
| QR camera scanning (`jsQR`, `camera_worker`, generator) | 322 KB / 12,573 lines | ⚠️ **a real feature** — scanning an address is genuinely useful; keep unless you want it gone |
| Ledger / Trezor support | 433 KB / 14,047 lines | ⚠️ **NOT dead weight — verified** — `hardware_wallet.js` returns the Ledger application name `"Grin"` and uses `SLATEPACK_ADDRESS_TYPE` for Grin. Deleting it removes a working Grin feature. |

Free deletions total roughly **0.5 MB / 12.7k lines**. Going further is a *product* decision
about features, not a cleanup — which is exactly why this stage is optional and last.

### Stage 5 — Mainnet, SSL, onion service, hub wiring

certbot vhost, Tor hidden service for the wallet itself, hub 05 key `2` switched from
`_slot_notice` to `run_sub "052_grin_accio.sh"`, and a standalone single-HTML build as a
downloadable artefact (offline/airgapped — note it **cannot receive** without the user running
their own gateway).

### Stage 6 — Security audit → `docs/generated/script052_security_audit.md`

Priorities: the
`/tor/` forwarder as an SSRF surface (we now own this guard outright — `Block-Access` is no
longer doing it for us, which is a gain in auditability and a loss of a battle-tested filter,
so test it hard), the gateway's per-wallet URL authorisation, response-header leakage from
hostile onions, vendored-WASM supply chain (SRI + pinned SHAs), and CSP.

## Build plan — one work packet per chat session

The roadmap above says *what* and *why*. This section says *how to actually execute it* without
any single session growing large enough to be compacted. The stages map to sessions but are not
1:1 — Stage 3 is deliberately split, and two small libs are pulled out of their stages.

### The rule that makes this work: the doc is the handoff, not the chat

Every session ends by writing its outcome into `docs/generated/script052_implementation.md`
(created in S0). The **next** session reads that file plus the relevant part of this design —
never the previous conversation. If a session ends with knowledge only in the chat log, the
packet is not finished.

**Standing header — paste at the top of each new session**, substituting the packet number:

```
Working on Accio (script 052), session S<n> of docs/generated/script052_design.md
§"Build plan". Read that packet's "Read first" list, do the "Do" list, verify with
"Verify", then do "Close-out". Do not read other packets. Do not run scripts locally —
this is a VPS product.
```

### Packet map

| # | Packet | Stage | VPS? | Weight | Depends on |
|---|---|---|---|---|---|
| **S0** | Vendor & pin — *this is where 052 is born* ✅ **done 2026-08-09** | 0 | no | light | — |
| **S1** | Own the build (`052_lib_build.sh`) | 1 | authored no / run in S2 | medium | S0 |
| **S2** | Static deploy on testnet, stock nginx | 1+2 | **yes** | medium | S1 |
| **S3** | Gateway I — Tor forwarder (`/tor/`) | 3 | **yes** | medium | S2 |
| **S4a** | Listen protocol spec — read `listener.js`, write it down | 3 | no | **read-heavy** | S0 |
| **S4b** | Gateway II — `/listen` + `/wallet/<id>/v2/foreign` | 3 | **yes** | **heavy** | S3, S4a |
| **S5** | Grin-default overlay, branding, About credit | 4a | yes | medium | S4b |
| **S6** | Integrity + update-check (`052_lib_vendor.sh`) | — | no | light | S0 |
| **S7** | Mainnet, SSL, onion service, hub 05 wiring | 5 | **yes** | medium | S5 |
| **S8** | Security audit → `script052_security_audit.md` | 6 | yes | medium | S7 |
| **S9…** | Deletion passes — one subsystem per session | 4b/4c | yes | light each | S5 |

S6 has no dependency past S0 and needs no VPS — it is the natural filler for a short session.
S9 onward is optional and open-ended; each is independently revertable.

---

### S0 — Vendor & pin *(no VPS, ~½ day)* — ✅ **DONE 2026-08-09**

The only packet whose output is legally significant: after it, Accio is permanently independent.

> **Outcome:** vendored at `adef11daadf04e4ec259d6febcc720da3daaa6c7` (v2.8.2), 270 of upstream's
> 273 files, 7,443,197 bytes, `vendor/SHA256SUMS` clean. Full record in
> `web/052_accio/PROVENANCE.md`; per-session detail in `script052_implementation.md`.
> Three corrections to the plan below, all recorded in PROVENANCE:
> **(a)** the tree measures **7.10 MiB**, not 4.7 MB — that figure was GitHub's *packed*
> repository size, and nothing is missing (`diff -r` against a fresh archive is empty);
> **(b)** the nginx reference landed at **`web/052_accio/docs/upstream-nginx.conf.reference`**
> (product-local — `docs/generated/` only takes `script##_*.md`);
> **(c)** cloning on Windows with `core.autocrlf=true` rewrites every text file to CRLF, **and
> `git archive` honours that setting too** — the first attempt produced a tree whose `LICENSE`
> hashed `eb2c5d88…` instead of upstream's `bbc8b96c…`. Re-vendor only with
> `git -c core.autocrlf=false -c core.eol=lf archive`, and note that `web/052_accio/.gitattributes`
> now marks `vendor/**` as `-text` so this repo's `* text=auto eol=lf` can never renormalise the pin.
> Two files were added beyond the plan: `vendor/SHA256SUMS` (the per-file pin S6 verifies against —
> vendor time is the honest moment to certify it) and that `.gitattributes`.
>
> **Review pass, same day** — three further corrections, all applied:
> **(d)** a **second upstream is now vendored**: `MWC-Wallet-Standalone` at `043c2ddc` (MIT, 4
> files, 75 KB) in `vendor/upstream-standalone-build/`. S1 and S7 are both specified to
> reimplement its `build.sh`, and leaving it unpinned on a second repo reproduced the exact
> durability hole this packet exists to close. `vendor/SHA256SUMS` now covers **both** trees —
> **274 files / 7,517,960 bytes**, manifest sha256 `0c7c1b8d…`. It is a spec; we never run it.
> The CRLF trap in (c) reoccurred while vendoring it, on the byte-identical `LICENSE`.
> **(e)** there are **four** custom nginx modules, not three — upstream's README omits
> `headers-more`, which its conf calls 29 times and which carries CSP/HSTS/COOP/COEP and the
> rest. Stock `add_header … always` replaces it; see §"Liability 1" for the child-block trap
> that drops inherited headers silently. **(f)** the inlining phase is 273 lines of which
> **253** are `sed -i` — the earlier "270" was wrong, and both numbers collided confusingly
> with the file counts.
>
> **Not done here, deliberately:** hub 05 key `2` still dispatches `_slot_notice`. Wiring is S7.
> Its notice text and the stale `script05_design.md PART A` pointers across CLAUDE.md, README,
> `script05_implementation.md` and `script051_security_audit.md` were corrected in the review —
> a doc move that leaves dangling referrers is an unfinished move.

**Read first:** this document, §"Correction of premise" → §"Naming policy".

**Do**
1. `git clone --depth 1 https://github.com/NicolasFlamel1/mwcwallet.com`, record the SHA,
   **delete `.git/`** (we vendor a tree, not a nested repo).
2. Drop `fullchain.pem` / `privkey.pem` (upstream's own dev certs — never ship someone's keys)
   and `nginx.conf` → keep the latter as `web/052_accio/docs/upstream-nginx.conf.reference` instead; it is the
   spec S3/S4b are replacing, and it should not look like config we deploy.
3. Commit to `web/052_accio/vendor/upstream-wallet/`, **unrenamed**, with `LICENSE` intact.
4. Write `web/052_accio/PINNED_SHA` (SHA + upstream URL + date + upstream version tag) and
   `web/052_accio/PROVENANCE.md` (what this tree is, the provenance table from this document,
   the naming policy in three lines, and "never edit files here — use `patches/`").
5. Create `scripts/052_grin_accio.sh` — banner + menu skeleton, every action a stub. This is what
   *assigns the number*; hub 05 key `2` still points at `_slot_notice` until S7. Menu shape, in
   the toolkit's own idiom (nothing here comes from upstream):

   ```
   1) Install / deploy  (testnet | mainnet)      5) Check upstream        → 052_lib_vendor.sh
   2) Rebuild site                → 052_lib_build.sh     6) Build standalone HTML → 052_lib_build.sh
   3) Gateway service  status/start/stop/logs    7) Status
   4) Nginx, SSL & onion          → 052_lib_nginx.sh     8) Uninstall     0) Back
   ```

   Config persists to `/opt/grin/accio-<net>/grin_accio.conf` (domain, network, node URL, gateway
   port, onion address) and is re-read by every action, so a rebuild never re-prompts. **Every
   action must be idempotent** — unlike upstream's `build.sh`, ours run against a live box with
   other vhosts, live certs and a running gateway that must survive.
6. Move this whole PART A to `docs/generated/script052_design.md`; leave a one-line pointer in
   `script05_design.md`. Create `script052_implementation.md` with a "Session log" heading.

**Verify** — `bash -n scripts/052_grin_accio.sh`; `vendor/upstream-wallet/LICENSE` present and
byte-identical to upstream; no `.git`, no `.pem` under `vendor/`; `git status --short` clean
after commit; recorded file count and total size match what upstream's archive contains.

**Close-out** — session-log entry with the pinned SHA. Update memory
`project_web_wallet_051_vs_055` ("052 exists, vendored at `<sha8>`") and the `MEMORY.md` hook.

---

### S1 — Own the build *(no VPS to author; first real run happens in S2)*

**Read first:** §"Liability 2 — PHP at runtime"; `vendor/upstream-wallet/` top-level layout;
`vendor/upstream-standalone-build/build.sh` (pinned at `043c2ddc` — it is **vendored**, so read
it locally; do not fetch it, and never run it).

Two key facts about upstream's `build.sh`, both of which shrink this packet:

- It is **machine-generated** — 316 lines, one near-identical command per file, each repeating the
  same 250-character env prefix. Do not transcribe it. Ours is a loop.
- **It does two jobs, and only the first belongs here.** Lines 1–37 copy the tree and PHP-render
  it into `./temp/` — *that intermediate tree is exactly what we want to serve*. Lines 39–311 then
  inline every image, font, WASM blob and script into a single `index.html`, which is only needed
  for the **standalone artefact in S7**. So S1 is roughly build.sh's first tenth.

What we inherit from it is its **contract**, not its code: the env-var interface his PHP templates
expect, and the demonstration that `php` can run at build time — which is the whole reason no
`php-fpm` reaches the VPS. Do not inherit `chmod 777 -R` (line 7), the `wget` (line 4), or the
`rm -rf` cleanup: a toolkit action must be idempotent and must leave a live box intact.

**Do** — write `scripts/lib/052_lib_build.sh` providing `accio_build <net> <domain> <outdir>`,
reading its parameters from `/opt/grin/accio-<net>/grin_accio.conf` (never re-prompting):
- Export the same env contract upstream uses: `SERVER_NAME`, `HTTPS`, `HTTPS_SERVER_ADDRESS`,
  `TOR_SERVER_ADDRESS`, `NO_FILE_VERSIONS`, `NO_FILE_CHECKSUMS`, `NO_MINIFIED_FILES`.
- Walk `vendor/upstream-wallet/public_html`; run `php` on each file the templates require
  (`index.html`, `styles/*.css`, `fonts/*/*.css`, the three web workers, `languages.js`), copy
  everything else verbatim.
- Apply `patches/` on top if present (empty until S5) — overlay by file replacement, never `sed`
  into `vendor/`.
- Emit a `SHA256SUMS` manifest of the built tree.
- **Assert zero network access**: no `wget`/`curl` anywhere in the script; state this in a header
  comment as the reason the script exists.

**Verify** — `bash -n`; a `grep -n 'wget\|curl' ` over the lib returns nothing; the acceptance
run (offline, and twice for byte-identical output) is **S2 step 1** — do not claim it passed here.

**Close-out** — session log records the env contract and which files need PHP, so S2 does not
re-derive it.

---

### S2 — Static deploy on testnet *(first VPS work)*

Prove the **unmodified** vendored wallet works before we change anything. Never debug our
patches and upstream's behaviour at the same time.

**Read first:** §"Resulting architecture"; S1's session-log entry; `web/052_accio/docs/upstream-nginx.conf.reference`.

**Do**
1. On the VPS: `apt install php-cli` (build-time only), run `accio_build` — this is S1's real
   acceptance test. Run it twice, diff the `SHA256SUMS`.
2. Write `scripts/lib/052_lib_nginx.sh`: **stock nginx**, static root, HTTP-only vhost first, then
   certbot, then the SSL vhost (CLAUDE.md Let's Encrypt bootstrap order). No `load_module`, no
   `php-fpm`, no rate-limit zone written inline — use `nginx_ensure_rate_limit_zone` from
   `lib/nginx_shared_helpers.sh` with a `script052-` conf basename.
3. Point the wallet's default node at `https://testapi.grin.money` (Script 04 must be deployed —
   it supplies HTTPS + CORS + the preflight answer the browser needs).

**Verify** — page loads over HTTPS; create a wallet in the browser; **balance syncs** (proves the
node rail end-to-end); build and send a **slatepack** to a Fidelius testnet wallet and finalize it.
That is a real tGRIN send with *no gateway involved at all*.

**Close-out** — session log: build timing, nginx conf path, the exact node URL, and anything
upstream did that surprised us.

---

### S3 — Gateway I: the Tor forwarder *(VPS)*

**Read first:** §"Liability 1"; `web/052_accio/docs/upstream-nginx.conf.reference` lines ~132–190 (the `/tor/`
location — it is the full spec: URL shape `^/tor/(https?)://?(.+/.*)$`, which request headers are
forwarded, which upstream headers are ignored, the timeouts).

**Do** — create `web/052_accio/gateway/` (Node, listening **127.0.0.1:9000**; upstream uses
`ip6-localhost:9000`, we bind loopback explicitly) with only the `/tor/` route:
- SOCKS5 to `127.0.0.1:9050` via `socks-proxy-agent` (replaces `SOCKS-Proxy`).
- **Destination allowlist** before connecting — `.onion` only by default, no private/link-local
  IPs, no localhost (replaces `Block-Access`; this is now *our* SSRF guard and S8 tests it hard).
- Build the response ourselves and copy **only allowlisted** response headers (replaces
  `Allow-Headers` — this is the part `add_header` cannot do).
- Forward exactly the request headers upstream's config forwards, no more.
Plus `scripts/lib/052_lib_gateway.sh` — systemd unit `grin-accio-gateway-<net>`, dedicated
non-root user, `nginx proxy_pass` for `/tor/`.

**Verify** — send tGRIN from the browser wallet to a **Fidelius onion address** and have it
arrive. Then confirm the guard: a `/tor/http://127.0.0.1:3413/...` request is refused.

---

### S4a — Listen protocol spec *(no VPS, read-only, no code)*

Split out precisely because it is the one read-heavy packet. Reading `listener.js` (48 KB) and
writing the gateway in one session is what would force a compaction.

**Read first:** §"The one hard blocker"; `vendor/upstream-wallet/public_html/scripts/listener.js`.

**Do** — append a **§"Listen protocol"** section to `script052_design.md` recording, from the
MIT client alone: the four request names (`CREATE_URL`, `CHANGE_URL`, `OWN_URL`, `DELETE_URL`),
the exact JSON message shapes in both directions, the response status set (OK / UNAUTHORIZED /
FORBIDDEN / NOT_FOUND / UNSUPPORTED_MEDIA_TYPE), the retry ladder (initial/maximum delay,
scaling factor, close-fail threshold), `REQUEST_TIMEOUT_SECONDS` / `RESPONSE_TIMEOUT_SECONDS`,
and how a wallet proves ownership of a URL across reconnects. Note anything the client does
*not* reveal — those are our design decisions, and they must be listed as such.

**Verify** — every claim carries a `listener.js:<line>` citation. No code written this session.

---

### S4b — Gateway II: `/listen` + per-wallet inbound URL *(VPS, heaviest packet)*

**Read first:** the §"Listen protocol" section from S4a **only** — not `listener.js` again.

**Do** — extend the gateway with the WebSocket rail: `/listen`, per-wallet
`/wallet/<id>/v2/foreign` minting, and relay of inbound Foreign-API POSTs down the open socket.
Reuse 093 Transporter's Node+SQLite patterns (`docs/generated/script09_design.md`), including its
two hard-won lessons: **partition capacity per writer** (a per-victim cap is a DoS *on* the
victim), and **normalise the wallet id at the route, not in mounted middleware** (Express
rebuilds `req.params` per layer). Add nginx `proxy_pass` with WebSocket upgrade headers and the
`limit_req zone=listen` equivalent upstream uses.

**Verify** — a tGRIN payment **received** into a browser wallet from Fidelius. Then confirm the
box runs stock nginx with zero custom modules (`nginx -V | grep -c load_module` behaviour, and no
`.so` referenced in any conf) and no `php-fpm` process.

---

### S5 — Overlay, branding, About credit *(VPS)*

**Read first:** §"Naming policy", layers 1 and 2 only.

**Do** — populate `web/052_accio/patches/`: Grin forced as the default and only selectable wallet
type, our node list first, Accio branding/title/icons. Add the upstream-wallet entry to the
`ATTRIBUTIONS` array in `backend/resources.php` so the About section carries the single credit.
**Overlay only** — no edits inside `vendor/`.

**Verify** — a case-insensitive `mwc` grep over the *built output* returns only the About-section
credit and the vendored `LICENSE`; re-run the S2 send and the S4b receive.

---

### S6 — Integrity + update check *(no VPS, light — good filler session)*

**Read first:** §"The update-check feature".

**Do** — `scripts/lib/052_lib_vendor.sh`: verify the vendored tree against a committed checksum
manifest before any build; a **Check upstream** menu action that clones to a scratch dir, runs
`git log --stat <PINNED_SHA>..FETCH_HEAD`, flags changed files that `patches/` touches, and
**changes nothing**. Never automatic, never on a timer.

**Verify** — `bash -n`; the check action run against the current pin reports "no changes" or a
readable list; tampering with one vendored byte makes the integrity check fail the build.

---

### S7 — Mainnet, SSL, onion, hub wiring *(VPS)*

certbot vhost for mainnet, a Tor hidden service for Accio itself, mainnet node defaults, and hub
05 key `2` switched from `_slot_notice` to the real dispatch (`|| true`-guarded, per CLAUDE.md).

The **standalone single-HTML artefact** goes here too — this is where build.sh's inlining phase
(its lines 39–311, vendored at `vendor/upstream-standalone-build/build.sh`) finally becomes
relevant. That range is 273 lines, **253 of them `sed -i`**. Reimplement it as a loop over the
asset list, not as 253 transcribed substitutions against markup: base64 each image/font/WASM/shader/model
and fold each script into the page. Ship it with an explicit note in the UI that it **cannot
receive** without a gateway.

**Verify** — a real mainnet GRIN send and receive; hub 05 launches 052; `nginx -t` clean; the
other vhosts on the box are unaffected.

---

### S8 — Security audit *(→ `script052_security_audit.md`)*

Priorities, in order: the `/tor/` forwarder as an SSRF surface (we own this guard now — we traded
a battle-tested filter for auditability, so test it adversarially), per-wallet URL authorisation
on `/listen`, response-header leakage from a hostile onion, vendored-WASM supply chain (SRI +
pinned hashes), and CSP. Compare against `script09_security_audit.md` — the mixer/Transporter
audit covers the same Node+Tor+queue shape.

---

### S9+ — Deletion passes *(optional, one subsystem per session)*

Order: MQS → 3D logo/Tetris → non-Grin fonts (all free), then the product calls. Each session:
delete one subsystem, rebuild, re-run the S2 send and S4b receive, commit. Any session can be
reverted without touching the others. Full-path MWC removal (Stage 4c) is the same ritual at one
file per commit. **Do not start S9 until S7 is green.**

## What "independent" does and does not buy us

Vendoring makes us **legally and operationally** independent: MIT permits the fork, one pinned
SHA is the only upstream artefact, the build runs offline, and after the simplification above
every server-side component is ours. Upstream can vanish tomorrow and Accio still builds and
deploys.

It does **not** make us maintenance-free, and the design should say so plainly:

- We inherit ~6 MB of someone else's wallet JavaScript that we did not write and cannot fully
  audit. Upstream is active (v2.8.2, Jun 2026) and ships security fixes to a **self-custodial
  wallet**. Cutting the cord means those fixes become ours to find.
- Grin consensus changes (a hard fork, a fee-formula change) land in *our* copy on *our*
  schedule.

**Policy: pinned, never dependent — but watched.** Keep `PINNED_SHA` plus a documented
`git log <PINNED_SHA>..upstream/master` review as a periodic chore. We never *depend* on
upstream to build, and we retain the *option* to take a security fix. That is the difference
between independence and isolation.

### Provenance of the vendored tree (measured 2026-08-08)

Worth recording, because "vendor 6 MB of someone else's code" deserves to be an informed
decision rather than a leap of faith:

| | |
|---|---|
| Original JS by the upstream author | **88 files, 128,337 lines** (28 % of lines are comments — the code is verbose and heavily annotated, which is why it is large) |
| Documented third-party libraries | **1.48 MB, 23 files** — jQuery, jsQR, glMatrix, bignumber.js, bech32, js-sha256/sha3, base64, crc32, QR generator, normalize.css |
| Cryptographic primitives | **Blockstream `libsecp256k1-zkp`**, via the author's own WASM wrappers — the same library Grin itself uses through Rust bindings |
| Remainder | fonts, icons, a 3D logo model (`models/mwc.json`, base64 textures), and PHP translation files for ~10 languages |

So it is **original wallet logic on top of standard, widely-reviewed crypto primitives** — not
a clone of another wallet, and not hand-rolled cryptography. That is the right shape. The
author is also a known Grin contributor (completed a `secp256k1-zkp` Python-wrapper bounty on
the Grin forum), and is **not** connected to the MWC coin project itself — this is an
independent wallet that happens to support MWC, Epic and Grin.

### The update-check feature (menu option, never automatic)

`052_lib_vendor.sh` provides a **Check upstream** action:

1. Fetch upstream into a scratch clone (never into the deployed tree).
2. `git log --stat <PINNED_SHA>..FETCH_HEAD` → show what changed since our pin.
3. **Flag any changed file that our `patches/` overlay touches** — those are the only ones
   that can conflict, and keeping the overlay small is what keeps this review cheap.
4. Report; change nothing.

Taking an update is then a deliberate act: bump `PINNED_SHA`, rebuild, re-run the Phase 2
testnet send, re-run the audit checklist. **Never auto-update a wallet.** An automatic pull
into a self-custodial wallet is a supply-chain hole with a cron schedule attached.

## Decisions still open

| # | Question | Notes |
|---|---|---|
| 1 | ~~Own nginx instance or shared?~~ | **Resolved** — stock nginx, no custom modules, so sharing the box's nginx is safe again. |
| 2 | Ask upstream to licence `WebSocket-Listener`? | Worth asking; plan must not depend on the answer, and after the simplification we'd likely still write our own. |
| 3 | Vendor 4.7 MB into the repo? | Consistent with existing practice (`web/07_mining_pool_public/back-end-pool/node_modules` is committed). |
| 4 | Does Accio supersede the 051 "public wallet" line? | 051 Fidelius is server-held-keys and stays; Accio is the non-custodial sibling. |
| 5 | Cadence for the upstream-diff review? | Suggest quarterly, and always before a mainnet release. |

## Reference

- https://github.com/NicolasFlamel1/mwcwallet.com — **the actual upstream** (MIT)
- https://github.com/NicolasFlamel1/MWC-Wallet-Standalone — single-HTML build script (MIT)
- https://github.com/NicolasFlamel1/SOCKS-Proxy · `Block-Access` · `Allow-Headers` (MIT)
- https://github.com/NicolasFlamel1/WebSocket-Listener — **unlicensed**, do not vendor
- https://forum.grin.mw/t/a-browser-based-wallet-or-ui/11639 — author confirms Grin support
