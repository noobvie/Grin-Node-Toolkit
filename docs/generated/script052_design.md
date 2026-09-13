# Script 052 — Accio, the Grin public web wallet (design)

> **Covers code as of:** 2026-08-16 · **Last verified:** never systematically verified
> **Product code last changed:** 2026-08-22 — `scripts/052_grin_accio.sh`, `scripts/lib/052_lib_*.sh`, `web/052_accio/`

**Status: BUILT, NEVER RUN.** `052` was born on **2026-08-09** with build packet **S0 (Vendor &
pin)**; every packet through **S7** was written by **2026-08-10**, so `scripts/052_grin_accio.sh`
has no stub left in it, hub 05 key `2` dispatches to it for real, and
`web/052_accio/vendor/upstream-wallet/` holds the pinned MIT upstream at `adef11da`.
**Nothing has ever run on a VPS** — not one build, deploy, send or receive — so **S2 is no
longer a build packet at all: it is the acceptance session**, and until it passes, a menu with
no stubs is not a tested product. Independence is already permanent — see §"Read this first".

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

**So PHP becomes a build-time-only dependency.** We prerender on the build machine and serve
the result. No `php-fpm` on the VPS, no PHP security surface, and the runtime stack matches
the rest of the toolkit.

> **Corrected in S1 (2026-08-09), by reading the source:**
> **(a)** it is **not** one page per language — one `en-US` render is the whole site.
> `scripts/languages.js` is itself PHP-rendered and embeds every translation as JSON
> (`AVAILABLE_LANGUAGES`), and every string in the DOM carries its English key in
> `data-text`, so language switching is **client-side**. Per-language prerendering would
> ship six near-identical copies for nothing.
> **(b)** it is **27 templated files, not 11.** The "11 PHP files" are the `.php` *libraries*
> (`backend/`, `languages/`, `errors/template.php`) — which are **never served**. The files
> that must actually be rendered are the 27 whose first five bytes are `<?php`: `index.html`,
> 7 font CSS, 2 style CSS, 4 scripts, 8 `errors/*.html`, plus `site.webmanifest`,
> `sitemap.xml`, `robots.txt`, `browserconfig.xml` and `scripts/service_worker.js`.

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
| **S1** | Own the build (`052_lib_build.sh`) ✅ **done 2026-08-09** | 1 | authored no / run in S2 | medium | S0 |
| **S2** | Static deploy on testnet, stock nginx | 1+2 | **yes** | medium | S1 |
| **S3** | Gateway I — Tor forwarder (`/tor/`) ✅ **code done 2026-08-09** | 3 | authored no / run with S2 | medium | S2 |
| **S4a** | Listen protocol spec — read `listener.js`, write it down ✅ **done 2026-08-10** → §"Listen protocol" | 3 | no | **read-heavy** | S0 |
| **S4b** | Gateway II — `/listen` + `/wallet/<id>/v2/foreign` ✅ **code done 2026-08-10** | 3 | authored no / run with S2 | **heavy** | S3, S4a |
| **S5** | Grin-default overlay, branding, About credit ✅ **code done 2026-08-10** | 4a | authored no / run with S2 | medium | S4b |
| **S6** | Integrity + update-check (`052_lib_vendor.sh`) ✅ **done 2026-08-10** | — | no | light | S0 |
| **S7** | Mainnet, SSL, onion service, hub 05 wiring ✅ **code done 2026-08-10** | 5 | authored no / run with S2 | medium | S5 |
| **S8** | Security audit → `script052_security_audit.md` ✅ **done 2026-08-11** — 8 findings fixed, 6 open | 6 | authored no / 6 checks owed to S2 | medium | S7 |
| **S9…** | Deletion passes — one subsystem per session (**pass 1 MQS ✅ code 2026-08-11**) | 4b/4c | yes | light each | S5 |

S9 onward is optional and open-ended; each is independently revertable.

**Every packet through S7 is now written, and not one line of it has run on a VPS.** S3, S4b,
S5, S6 and finally S7 were each taken out of order because their work is authored against the
*vendored tree*, not against a running box — so S2 is no longer a packet with deliverables at
all. It is **the acceptance session**, and it pays every debt at once: S1's reproducible build,
S3's `/tor/` send, S4b's `/listen` receive, S5's rebranded render, S6's pin gate, S7's vhost,
certificate, onion and standalone artefact. That is a lot to land in one sitting, and the order
it must be attempted in is exactly that: **a build that does not render is not a branding bug,
and a send that does not go out is not a gateway bug.** Do not debug two layers at the same
time. Mainnet comes after a testnet round trip you watched succeed, never alongside it.

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

### S1 — Own the build *(no VPS to author; first real run happens in S2)* — ✅ **DONE 2026-08-09**

> **Outcome:** `scripts/lib/052_lib_build.sh` (`accio_build`, `acb_check_deps`,
> `acb_env_report`), and hub-052 key `2` "Rebuild site" is now **live** — it is how S2 runs
> the acceptance test. Five corrections to the plan below, each from reading upstream's
> source rather than its README; all are recorded in `script052_implementation.md` §S1.
> **(a)** The three `NO_*` env vars are tested with `array_key_exists`, so setting one to
> `""` **disables** the feature — a hosted build must run under `env -u` for all three.
> **(b)** We must render **27** files; `build.sh` renders 14 (it only needs what folds into
> the standalone `index.html`). Shipping its list would publish `site.webmanifest`,
> `service_worker.js`, `robots.txt`, `sitemap.xml`, `browserconfig.xml` and all 8 error pages
> as **raw PHP source**. **(c)** 221 of 252 resource entries carry a hardcoded SRI checksum —
> including `scripts/node.js`, the file S5 must patch. Patch it without refreshing the
> checksum and the browser refuses to execute it; the build now recomputes SRI + bumps the
> cache version for every patched file. **(d)** PHP CLI prints warnings to **stdout**, which
> is the built file — every render forces `display_errors=stderr`. **(e)** `php-intl` is
> required as well as `php-mbstring`, and a missing `en_US.UTF-8` locale silently reorders
> the language menu.
>
> **Not done here, deliberately:** the acceptance run. It needs `php-cli` on a VPS and is
> **S2 step 1** — run "Rebuild site" twice and diff `site.SHA256SUMS.prev` against
> `site.SHA256SUMS`. What *was* verified locally: `bash -n`, the offline grep, and 37 unit
> assertions over the two pure halves (the SRI/version rewriter and the file classifier),
> run against the real vendored tree.

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

### S3 — Gateway I: the Tor forwarder *(VPS)* — ✅ **CODE DONE 2026-08-09**

> **Outcome:** `web/052_accio/gateway/` (5 modules, **zero npm dependencies**) and
> `scripts/lib/052_lib_gateway.sh`; hub-052 key `3` "Gateway service" is now **live**.
> Six corrections to the plan below, each recorded in `script052_implementation.md` §S3.
> **(a)** The port is **7480/7490**, not `:9000` — S0 already chose those and `:9000` is
> upstream's *WebSocket-Listener* port, not its SOCKS port (that is `9050`).
> **(b)** SOCKS5 is hand-written (~90 lines, RFC 1928/1929) instead of `socks-proxy-agent`:
> this process is the one part of Accio that handles bytes from an arbitrary hidden service,
> and an npm tree there gives back exactly what S0's pin bought. The gateway therefore has
> **no dependencies at all** and its install makes no network request.
> **(c)** The `/tor/` regex must accept **one or two** slashes after the scheme. nginx runs
> `merge_slashes on`, so `/tor/http://x.onion/…` is already `/tor/http:/x.onion/…` by the time
> a proxied backend sees it — a `//`-only gateway passes every loopback test and fails for
> every real browser. Upstream's own regex says `://?` for this reason.
> **(d)** `Cache-Control` is emitted by the gateway, not by nginx `add_header`, because an
> `add_header` anywhere in the `/tor/` location would discard the inherited CSP and HSTS. The
> snippet therefore contains **no `add_header` at all**, by rule.
> **(e)** Two `require_header` semantics had to be read out of the Block-Access **source**,
> not its README: a leading `!` means the header is **optional**, and repeated directives for
> one header are **OR-ed**. Getting either backwards inverts the rule — AND-ing the three
> Origin alternatives would refuse every request ever made.
> **(f)** The onion port is fed by a **second nginx server block**, not by tor directly (the
> wallet is ~7 MB of WASM; nginx should serve it over the onion too). Classification by
> listening port is unaffected. `tor_port: 0` until S7.
>
> **Review pass, same day** — nine further defects, all fixed. Four were resource or safety
> holes the tests could not see because the tests were written alongside the code: an
> **uncapped body drain** on refused requests (the onion front has no nginx cap), a
> **concurrency slot held for the full timeout** after a client disconnected mid-flight, an
> **idle** timeout mistaken for a total one, and a missing `ACCIO_GATEWAY_CONF` **silently
> starting on defaults** — i.e. mainnet on the testnet port. Also: an unbracketed IPv6 literal
> walked past all three destination checks (fixed at the parse layer with a hostname-shape
> rule), `gzip off` was missing from the nginx snippet, and `_acg_find_vhost`'s trailing
> pipeline could kill the script under `set -e`. Full list in `script052_implementation.md`
> §"S3 review". Assertions 78 → **88** unit, 19 → **22** end-to-end.
>
> **Not done here:** the VPS half. Nothing has run on a VPS — S2 has not happened. What was
> verified locally: `bash -n`, `node --check`, the unit assertions on `guard.js`/`config.js`
> and both header allowlists, and the end-to-end assertions driving the real `server.js`
> through a fake SOCKS5 proxy into a fake onion. The browser-level check (send tGRIN to a
> Fidelius onion) still stands, and so does the box-level one.
>
> **One note for S2, who writes the vhost:** keep `try_files` inside `location / { }`, not in
> the `server` block — a server-level `try_files` is inherited by locations that do not define
> their own and would 404 every `/tor/` request. The snippet carries the warning too.

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

### S4a — Listen protocol spec *(no VPS, read-only, no code)* — ✅ **DONE 2026-08-10** → §"Listen protocol"

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

### S4b — Gateway II: `/listen` + per-wallet inbound URL *(VPS, heaviest packet)* — ✅ **CODE DONE 2026-08-10**

> **Outcome:** four more gateway modules — `ws.js` (RFC 6455 server), `store.js` (the suffix ↔
> session table), `listen_route.js` (the protocol), `wallet_route.js` (the inbound HTTP route)
> — still with **zero npm dependencies**, plus the `052_lib_gateway.sh` deploy side. Assertions
> 88 unit + 22 end-to-end (S3) → **96 total**, all driving the real `server.js` through a real
> WebSocket and a real POST. Six corrections to the plan below, each in
> `script052_implementation.md` §S4b.
> **(a)** The packet is **not** "reuse 093's Node+SQLite patterns" — SQLite needs either an npm
> package (against the zero-dependency rule S3 established) or `node:sqlite`, which wants Node
> 22.5+ and is experimental while our floor is 18. What transfers is 093's two *lessons*, and
> both are honoured. The table is a debounced, atomically-renamed JSON snapshot.
> **(b)** That snapshot is **not a cache, and its absence is not a degraded mode**: the client
> discards any suffix the gateway stops recognising and mints a new one, so an in-memory table
> changes **every wallet's receiving address on every restart** — a routine deploy. It is the
> only `ReadWritePaths` in an otherwise `ProtectSystem=strict` unit, and the self-test fails
> loudly if it is not durable.
> **(c)** A per-session socket cap must **refuse, never evict** — see the bug below.
> **(d)** `ws.js` must handle **`'end'`**, not only `'error'`/`'close'` — see the bug below.
> **(e)** The `Type` field sent to the tab must be the **bare** string `application/json`, not
> the sender's `Content-Type` header. The client compares it for equality and answers 415 for
> anything else, so an ordinary `application/json; charset=utf-8` would fail every such payment
> with a media-type error nobody could explain.
> **(f)** Three zones now, where S3 wrote one — and `nginx_ensure_rate_limit_zones` is a no-op
> when its conf file already exists, which is exactly an S3 box's state. Left alone, the new
> snippet would reference an undefined zone and **nginx would refuse to start at all**, taking
> every other vhost with it. The lib detects the missing zones and regenerates the file.
>
> **Two bugs found by the end-to-end run, both invisible to a unit test and both real:**
> **(1)** the socket cap **evicted a live connection**. A socket the peer closed stays counted
> until Node delivers its `'close'`, so a reloading tab briefly has two on the books; the
> eviction then fired on a *different*, perfectly healthy tab — a disconnect mid-payment.
> Refusing the new handshake makes the same race harmless (the client retries at 250 ms).
> **(2)** a **clean FIN never reaped the connection** — `'end'` fires and `'close'` does not,
> because the socket stays writable from our side. A closed browser tab therefore held its
> session slot until the pong timeout, up to 45 s. Both were found by watching `listen_open`,
> not by reading the code.
>
> **Decisions §11 left to us, as taken:** session = 256-bit opaque id in an `HttpOnly`
> `SameSite=Lax` cookie scoped to `Path=/listen`, `Secure` **auto** (on only when nginx reports
> `X-Forwarded-Proto: https`, and never on the onion front, where a `Secure` cookie would
> simply never be stored); suffix = 16 chars of lowercase base32 (**80 bits**, unbiased); ttl
> **90 days rolling** — and stated plainly as an *address*-lifetime policy; suffixes die with
> their session, with the per-session cap evicting the oldest *unverified* suffix so orphaned
> `Create URL`s are reclaimed without a timer guessing; inbound wait **180 s** then a cancel +
> 504; offline payee answered **503 immediately** rather than parked; body cap **1 MB** set
> explicitly in both nginx and the gateway; delivery goes to the **most recently opened**
> socket. The onion and clearnet fronts are **different cookie jars**, so the same wallet
> reached both ways holds two addresses — accepted, and arguably a privacy gain.
>
> **Not done here:** the VPS half. Nothing has run on a VPS — S2 has still not happened. The
> receive itself (Fidelius → a browser wallet's `/wallet/<suffix>` address) is the browser-level
> check, and the stock-nginx/no-`php-fpm` check is the box-level one; both stand.

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

### S5 — Overlay, branding, About credit *(VPS)* — ✅ **CODE DONE 2026-08-10** *(build + VPS run owed)*

**Read first:** §"Naming policy", layers 1 and 2 only.

**Do** — populate `web/052_accio/patches/`: Grin forced as the default and only selectable wallet
type, our node list first, Accio branding/title/icons. Add the upstream-wallet entry to the
`ATTRIBUTIONS` array in `backend/resources.php` so the About section carries the single credit.
**Overlay only** — no edits inside `vendor/`.

**Verify** — a case-insensitive `mwc` grep over the *built output* returns only the About-section
credit and the vendored `LICENSE`; re-run the S2 send and the S4b receive.

> **Outcome:** 16 files / 562 KB in `patches/public_html/`, every deviation marked `ACCIO PATCH`.
> *(S5's figure, kept as the record of this packet. The overlay is **19 files / 656 kB** as of
> S10, 2026-08-16 — S9 pass 1 added `scripts/mqs.js`, R8 added markers, S10 added the theme. Current numbers live in
> `script052_implementation.md` §"Current state", never here.)*
> Taken out of order for the same reason S3 and S4b were — the overlay is authored against the
> vendored tree, not against a running box. Full record in `script052_implementation.md`.
>
> **The packet's shape changed once, for a good reason.** The obvious reading of "Accio
> branding" is ~25 whole-file overlays (`index.html`, `site.webmanifest`, eight `errors/*.html`,
> five `languages/*.php`, `errors/template.php`, …) totalling **~1.2 MB**. It collapses to
> **two** files: every user-visible string in this app is a translation, and every translation
> passes through `getDefaultTranslation`/`getTranslation` — once server-side
> (`backend/language.php`) and once client-side (`scripts/language.js`). A phrase map applied
> at those two points rebrands the whole app, in all six languages, *and* keeps the five large
> translation tables unpatched so future upstream translation updates flow through untouched —
> which is the same argument §"The update-check feature" makes for keeping the overlay small.
> The map is deliberately **phrases** (`MWC Wallet`, `MimbleWimble Coin`), never the bare token
> `MWC`: that one is layer 3.
>
> **⚠ The "Verify" line above is not achievable and never was.** It contradicts §"Naming policy"
> layer 3, which this packet's own "Read first" excludes: **195** of the residual `mwc` hits are
> `Consensus.MWC_WALLET_TYPE` and friends — protocol discriminators that must be *deleted* in
> S9+, never renamed. The criterion that is both meaningful and testable is **"no MWC string
> reaches a user's eyes"**, and the honest form of it is the residual table in
> `script052_implementation.md` (S5): 195 layer-3 identifiers, 25 of our own `ACCIO PATCH`
> comments, 16 source literals the brand layer rewrites at runtime, 8 dormant extension-store
> URLs, 1 binary coincidence inside a Font Awesome `.woff2`, and **1 intended credit**. Zero
> user-visible. Use that table, not a bare grep count, as the S9 progress meter.
>
> **Four decisions this packet had to make that the brief did not anticipate**, each argued in
> the implementation log: icons are **SVG-only** (an offline, deterministic build cannot
> rasterise, and shipping upstream's 33 MWC PNGs was the alternative); the **3D logo is
> suppressed here rather than in S9**, because it is the most visible MWC artefact on the page
> and S9 lands *after* the S7 launch; the **Donate section is removed**, because its four
> addresses were upstream's and the brand layer cannot touch a raw `<a>`; and the About page's
> **translation contact becomes our issue tracker**, because we have no mailbox — the operator
> may want a real address before S7.

---

### S6 — Integrity + update check *(no VPS, light)* — ✅ **DONE 2026-08-10**

**Read first:** §"The update-check feature".

**Do** — `scripts/lib/052_lib_vendor.sh`: verify the vendored tree against a committed checksum
manifest before any build; a **Check upstream** menu action that clones to a scratch dir, runs
`git log --stat <PINNED_SHA>..FETCH_HEAD`, flags changed files that `patches/` touches, and
**changes nothing**. Never automatic, never on a timer.

**Verify** — `bash -n`; the check action run against the current pin reports "no changes" or a
readable list; tampering with one vendored byte makes the integrity check fail the build.

> **Outcome:** shipped as specified, plus menu key `5` wired live and `accio_build` gated on the
> check. Full record in `script052_implementation.md` §S6. Five deviations from the plan above,
> all deliberate:
>
> **(a) `sha256sum -c` alone is not an integrity check** — it verifies only the paths the
> manifest lists, so it structurally cannot see a file that was *added*. The build stages the
> whole tree, so an unlisted file ships. Verification is therefore **three** checks in a fixed
> order: the manifest's own sha256 against `PINNED_SHA` **first** (a tamperer who regenerates
> `SHA256SUMS` defeats everything downstream, and only this step notices), then `sha256sum -c`,
> then the file **set** compared both directions.
>
> **(b) `FETCH_HEAD` became `origin/HEAD`.** A shallow or single-ref fetch cannot contain the
> pinned commit, and *"is the pin still reachable?"* is the single most important answer the
> check produces — an unreachable pin is a force-push, i.e. a security event, not an update. So
> it fetches all branches, resolves the default branch via `remote set-head`, and reports that
> case separately and loudly.
>
> **(c) The scratch clone is `init --bare`.** Not one byte of upstream code is ever materialised
> as a file on the box; `log`/`diff`/`rev-list` all work fine against a bare repo.
>
> **(d) The patched-file cross-reference splits *replaced* from *added*.** One overlay file
> (`MWC Wallet license.txt`) has no upstream counterpart, so it can never conflict and must not
> be counted as a conflict risk. It is a copy of upstream's root `LICENSE`, which is why that
> path — along with `nginx.conf`, the spec S3/S4b replaced — is on a separate *watched* list.
>
> **(e) Verify gates the build, with no bypass.** `accio_build` sources this lib and refuses to
> stage anything if the check fails; a missing `052_lib_vendor.sh` is a hard error, not a
> warning. ⚠ The documented remedy for a failure is a **re-vendor in the repo**, never
> regenerating `SHA256SUMS` on the VPS — that certifies whatever is on the target, which is the
> thing being questioned.

---

### S7 — Mainnet, SSL, onion, hub wiring *(VPS)* — ✅ **CODE DONE 2026-08-10**

> **Outcome:** `scripts/lib/052_lib_nginx.sh` (vhosts, certbot, hidden service),
> `accio_build_standalone` in `052_lib_build.sh`, real `install` / `nginx` / `standalone` /
> `status` / `uninstall` actions in `052_grin_accio.sh` — **the last stub in this product is
> gone** — and hub 05 key `2` now `run_sub "052_grin_accio.sh" || true`. Five corrections to
> the plan below, all recorded in `script052_implementation.md` §S7.
> **(a)** S7 could not be written without **S2's authorable half**. "certbot vhost for
> mainnet" presupposes a vhost writer, and S2 owns that file; it is written here, for both
> networks, and S2 is now purely acceptance runs.
> **(b)** The onion needs a **second gateway snippet**, not a second include of the first.
> `_acg_write_snippet` takes a front (`nginx`|`onion`) and the onion copy proxies to
> `$ACC_TOR_PORT` — pointing the hidden service at the clearnet snippet would hand a Tor
> visitor the front whose forwarding headers are trusted, voiding the whole port split. The
> onion copy also carries **no `limit_req`**: every Tor visitor arrives from 127.0.0.1, so a
> per-IP zone there is one global bucket that lets the first busy visitor 503 everyone else.
> **(c)** `add_header` trap #1 is resolved with **one header snippet included by every block
> that adds any header of its own**, and `Cache-Control`/HSTS/`Onion-Location` are left out of
> it precisely because they differ per block or per front.
> **(d)** **Minting the onion is not the end of the job.** `TOR_SERVER_ADDRESS` is baked in at
> build time, so an onion that exists but was never built in makes the "Onion Service" address
> type hand out a *clearnet* host. Both the cert step and the onion step now offer the rebuild
> and say so loudly when it is declined; Status compares `BUILD_INFO`'s onion against the
> configured one and flags a mismatch.
> **(e)** The standalone artefact is served as a **download**, not a page: it is made of
> `data:` URIs, which this site's own CSP forbids. Rendered in place it would look broken.
>
> **Three defects found by rendering the vhosts offline before shipping them**, each of which
> would have failed `nginx -t` — i.e. left nginx refusing to start and every other vhost on
> the box down with it: a **backtick in a heredoc comment** (command substitution; two words
> silently vanished from the generated config), `http2 on;` (an **unknown directive** below
> nginx 1.25.1, so the version is now probed), and `filename=\"…\"` in `Content-Disposition`
> (three arguments where nginx wants one).
>
> **Not done here:** every acceptance run. Nothing in Accio has run on a VPS. The banner in
> `052_grin_accio.sh` and hub 05's own header both say so — *a menu with no stubs is not the
> same thing as a tested one.*

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

### S8 — Security audit *(→ `script052_security_audit.md`)* — ✅ **DONE 2026-08-11**

> **Outcome:** [script052_security_audit.md](script052_security_audit.md). Eight findings fixed,
> six open. The priority list below was the right one in three of five places and wrong in one:
> **the `/tor/` SSRF guard came out sound** (it never resolves a name, so there is no rebind
> window; its one gap was alternate IPv4 spellings in a mode that is off by default), while
> **per-wallet authorisation on `/listen` did not** — it authorised the *session* and then routed
> money by "newest socket in that session", which is a different question, and the gap between
> them let anyone holding the cookie receive payments sent to an address they could not even
> name. Response-header leakage and the vendored-WASM supply chain both came out better than
> expected (the method + Content-Type pair closes the render-hostile-HTML-on-our-origin path;
> SRI is structurally worthless for same-origin files and the pin chain is the real control).
> The CSP question this packet was told to answer is answered in the audit's A-8, measured
> against the source: `'unsafe-inline'` and `connect-src *` are both **required**, and the one
> real narrowing is `'unsafe-eval'` → `'wasm-unsafe-eval'`, staged but not yet completed.
> Two of the six open items are **new work worth building**: `patches/` sits outside the pin,
> and the deployed site is never re-verified against its build manifest.


Priorities, in order: the `/tor/` forwarder as an SSRF surface (we own this guard now — we traded
a battle-tested filter for auditability, so test it adversarially), per-wallet URL authorisation
on `/listen`, response-header leakage from a hostile onion, vendored-WASM supply chain (SRI +
pinned hashes), and CSP. Compare against `script09_security_audit.md` — the mixer/Transporter
audit covers the same Node+Tor+queue shape.

---

### S9+ — Deletion passes *(optional, one subsystem per session)*

> **Pass 1 (MQS) — ✅ CODE DONE 2026-08-11.** One new overlay file,
> `patches/public_html/scripts/mqs.js`: 1,361 lines → 105. Full record in
> `script052_implementation.md` §"S9 pass 1".
>
> **⚠ The gate below was not met and was knowingly crossed.** S7 is not green — nothing in Accio
> has ever run on a VPS — so this pass's two acceptance runs went to S2 with all the others.
> Same terms as S3/S4b/S5/S7: authored against the vendored tree, verified offline, revertable
> with one `git rm`.
>
> **"All free" was wrong about MQS, and the reason generalises.** Five symbols of the class are
> referenced **36 times from five files we do not patch** (`api.js`, `slate.js`, `wallet.js`,
> `hardware_wallet.js`, `send_payment_section.js` — 40,446 lines / 1.65 MB of overlay to touch,
> and `ADDRESS_LENGTH` alone is 16 of the 36), and one of
> those references is on the money path: `Slate.compactProofAddress` switches on
> `Mqs.ADDRESS_LENGTH`, is **not** wallet-type-gated, and runs on every payment-proof slate we
> encode. A plain `rm` makes that a `ReferenceError` on every send with a payment proof. So pass
> 1 is a **reduction**: the five-symbol external surface stays, the WebSocket transport, the
> PBKDF2/AES-GCM crypto, `getAddressVersion` and 21 of the 22 constants go.
>
> **It changes nothing observable**, and that is checked rather than argued: `getAddressVersion()`
> has arms for MWC and EPIC only, so it returns `undefined` in Grin mode and both codecs fault
> before producing or accepting an address; `isValidAddressWithHost` could only ever return
> `false`; `sendRequest`'s single caller sits inside `case Consensus.EPIC_WALLET_TYPE`. 15
> equivalence assertions run upstream and the stub side by side in Grin mode and agree at every
> entry point. **`ADDRESS_LENGTH` stays 52** — it is wire format, not branding: remove it and a
> 52-character proof address stops being rejected and starts parsing as **Tor**.
>
> One difference is real and is not hidden: the two codecs throw upstream's own error *strings*
> where upstream threw a `TypeError`. Nothing in the tree branches on that value (the string
> appears nowhere outside `mqs.js`), so control flow is identical; only the text of an error on a
> slate that fails either way can differ.
>
> **The rule this pass sets for the rest of S9:** removing a subsystem must not change how a
> slate is read, only what we do about one. And the meter is the residual *table*, not a grep
> count — measured against the S5 baseline this pass moved `MWC_WALLET_TYPE` 87 → 86 and layer-3
> hits 195 → 193, while the tree-wide case-insensitive `mwc` count stayed at **303 → 303** and
> the file's own stayed at 2.
>
> **Not built here, on purpose:** the file-deletion machinery. Pass 1 deletes no file, and unused
> build machinery is worse than none. Pass 2 is where it is born.

Order: MQS → 3D logo/Tetris → non-Grin fonts, then the product calls. Each session:
delete one subsystem, rebuild, re-run the S2 send and S4b receive, commit. Any session can be
reverted without touching the others. Full-path MWC removal (Stage 4c) is the same ritual at one
file per commit. **Do not start S9 until S7 is green.**

**Pass 2 — 3D logo / Tetris** (leaf assets, genuinely free): `models/mwc.json`,
`shaders/logo.{frag,vert}`, `glMatrix`, `tetris.js`, `styles/tetris.css`, and the WebGL half of
`logo.js` (inert since S5). This pass **does** delete files, so it must first build the deletion
machinery: drop the file from the stage, drop its `$files` entry from `backend/resources.php`,
and assert no staged file still calls `getResource()` on a path that no longer exists.
**Pass 3 — non-Grin fonts**: `fonts/{btc,eth,epic,mwc}` and the `.mwc` rule in
`styles/common.css`. S5 stopped *fetching* the MWC glyph font; this removes it.

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

`052_lib_vendor.sh` provides a **Check upstream** action (built in S6, menu key `5`):

1. Fetch upstream into a scratch **bare** clone (never into the deployed tree, and never
   checked out — no upstream file is ever materialised on the box).
2. Confirm the pinned commit is still reachable. If it is not, upstream force-pushed or
   rewrote history: report that as a security event and stop, because a diff against a
   rewritten branch is meaningless.
3. `git log --stat <PINNED_SHA>..origin/HEAD` → show what changed since our pin.
4. **Flag any changed file that our `patches/` overlay *replaces*** — those are the only ones
   that can conflict, and keeping the overlay small is what keeps this review cheap. Overlay
   files that *add* something (no upstream counterpart) are excluded: they cannot conflict.
5. Report; change nothing.

Taking an update is then a deliberate act: bump `PINNED_SHA`, rebuild, re-run the Phase 2
testnet send, re-run the audit checklist. **Never auto-update a wallet.** An automatic pull
into a self-custodial wallet is a supply-chain hole with a cron schedule attached.

## Listen protocol

Written in **S4a** (2026-08-10) by reading the MIT client only. This section is the **sole
input to S4b** — S4b must not re-read `listener.js`. Every claim below carries a citation;
`L:<n>` = `vendor/upstream-wallet/public_html/scripts/listener.js`, other files are named in
full. Paths are relative to `web/052_accio/`.

Sources read: `scripts/listener.js` (1901 lines, the whole file), `scripts/interaction.js`,
the listener-facing parts of `scripts/wallets.js` and `scripts/wallet.js`, `Api.getResponse`
in `scripts/api.js`, the HTTP-status and protocol constants in `scripts/common.js`, and the
`/listen` + `/wallet/` locations of `docs/upstream-nginx.conf.reference`.

**The client is one half of the contract.** Where it is silent, §"What the client does not
reveal" lists the gap as *our* decision — those are not omissions to be researched further,
they are the design surface S4b owns.

### 1. Transport

| | |
|---|---|
| URL | `wss://<hostname>/listen` (`ws://` if the page is HTTP) — L:1887-1894 |
| Built from | `location` for a normal page; `HTTPS_SERVER_ADDRESS` for extension/`file:`/mobile builds — L:1890 |
| Subprotocol | **none** — `new WebSocket(addr)` is called with one argument (L:1083), so the server must not select one |
| Frames | **text only.** Every send is `JSON.stringify` (L:1395-1398); every receive is `JSON.parse` on `event.data` (L:1239). A binary frame throws in `JSON.parse` and is **silently dropped** (L:1243-1247) |
| Auth / identity | **nothing.** No token, no query string, no header the client controls. See §11 |
| Keepalive | the client sends **nothing** when idle — and the browser WebSocket API exposes no ping to page JS at all, so this is a platform fact, not an upstream omission. Liveness is the server's job |
| Connected test | `readyState === 1` (L:1388-1391, L:1754-1757) |

⚠ **The default URL uses `server["hostname"]`, not `host` — the port is dropped** (L:1893).
On a site served at `https://accio.example:8443`, the wallet still tries
`wss://accio.example/listen`. Accio must therefore be served on the standard port, or the
operator has to set the "Custom Listener Address" setting by hand.

**Custom listener** (an escape hatch we inherit, and a reason the gateway must not assume it
is the only listener): two settings, `Use Custom Listener` (default `false`) and
`Custom Listener Address` (default `""`) — L:1859-1884. `getAddress()` (L:276-351) adds
`ws://` when no scheme is given, rewrites `http:`→`ws:` / `https:`→`wss:`, strips trailing
slashes, and upgrades a same-hostname insecure URL to the secure form
(`common.js:393-433`). An **empty** custom address means "no listener": `connect()` still
runs and still retries, it just logs nothing (L:1024-1041).

### 2. Message taxonomy and discrimination order

Five message kinds over one socket, discriminated **in this order** by the client (L:1256,
L:1262, L:1380). The order is load-bearing: a message carrying both `Index` and `Interaction`
is read as a *response*, and a message carrying `Interaction` but missing any one of `URL` /
`API` / `Type` / `Data` falls through to *status*.

| Direction | Kind | Discriminator |
|---|---|---|
| client → server | **request** | `Request` (string) + `Index` (number) |
| server → client | **response** | `Index` is a number → L:1256 |
| server → client | **interaction** | `Interaction` is a number **and** `URL`,`API`,`Type`,`Data` all present → L:1262 |
| client → server | **interaction response** | `Interaction` + `Type` + `Data` + `Status` |
| server → client | **status** | `Interaction` is a number, nothing else required → L:1380 |

Anything that is not valid JSON, or is not a JSON **object**, is dropped without a reply
(L:1236-1253). A message matching none of the three server→client shapes is also dropped
silently — there is no error channel back to the server, so a malformed frame from us
manifests only as the client's 2-minute timeout.

### 3. Client → server: the four requests

```json
{ "Request": "<name>", "Index": <n>, "URL": "<suffix>" }
```

`Index` is added by `sendRequest` (L:1414), taken from a per-page counter that starts at **0**
(L:25, L:1405) and wraps at `Number.MAX_SAFE_INTEGER` (L:1408-1411). `URL` is present on
three of the four.

| Name (exact string) | `URL` param | Success value (`Response`) | Sent when |
|---|---|---|---|
| `Create URL` (L:1789-1792) | *absent* (L:377-381) | **string** — the new suffix (L:385) | a wallet has no suffix — all three add paths (**create** `unlocked.js:1413`→`:1507`, **recover** `:1633`→`:1804`, **hardware** `:1929`→`:2176`), plus any render that finds one missing (`unlocked.js:2865-2868`) |
| `Change URL` (L:1796-1799) | the wallet's **current** suffix (`wallets.js:4124-4127`) | **string** — the *new* suffix (L:458) | user confirms "Change Address Suffix" (`wallet_section.js:1165-1197`) |
| `Own URL` (L:1803-1806) | the suffix being checked (L:525-532) | **boolean** (L:536) | on every `CONNECTION_OPEN` for every wallet holding a suffix (`wallets.js:1296-1311`) |
| `Delete URL` (L:1810-1813) | the suffix to release (L:595-602) | **boolean** (L:606) | after a rotate, and whenever a create/save is rolled back (`wallets.js:3935`, `:3966`, `:4171`) |

**`Change URL` is a rotate, not a rename.** The UI is a yes/no confirmation — there is no
field for the user to propose a suffix (`wallet_section.js:1165`), and the client passes its
*current* suffix and stores whatever string comes back (`wallets.js:4127-4137`). So the
parameter is "the suffix I hold", and the response is "the suffix you now hold".

A wrong-typed `Response` (e.g. a string where a boolean is expected) is rejected client-side
as a hard failure (L:536-545, L:606-615) — the type is part of the contract, not a hint.

### 4. Server → client: responses

```json
{ "Index": <n>, "Response": <string|boolean> }      // success
{ "Index": <n>, "Error": <anything> }               // failure
```

Matched to a pending request by `Index` alone (L:1489) — the request *name* is never echoed
and never checked, so `Index` must be echoed exactly. A response is treated as invalid when
it carries an `Error` key **or** lacks a `Response` key (L:1498-1501); the value of `Error`
is never read, so it may be any JSON, and no error code vocabulary exists.

Invalid-response handling differs by request, and the difference matters:

- `Create URL` / `Change URL` / `Own URL` → reject (L:421-428, L:494-501, L:572-579).
- **`Delete URL` → resolves `false`** (L:642-648). A refusal is "not deleted", not an error.

### 5. Server → client: interaction (an inbound HTTP request, relayed)

```json
{ "Interaction": <n>, "URL": "<suffix>", "API": "/v2/foreign",
  "Type": "application/json", "Data": "<base64>" }
```

All five fields are required and all four besides `Interaction` must be **strings**
(L:1262, L:1268); `Interaction` must be a **number** (L:1262). A wrong type → the client
answers **415** and drops the interaction (L:1338-1355). Undecodable `Data` → **415**
(L:1274-1298).

- **`Interaction`** — server-chosen correlation id. `toFixed()` is called on it to build
  jQuery event namespaces (L:667, L:1304, L:1613), so **mint plain integers**: `1.5` and `2`
  both render as `"2"` and would cross-wire two live interactions. Must be unique among
  in-flight interactions on a connection.
- **`URL`** — the wallet's **address suffix**, not a full URL. Looked up against the local
  wallet database (`wallets.js:513` → `getWalletFromAddressSuffix`, `:4989`).
- **`API`** — the path *after* `/wallet/<suffix>`. The only value this client accepts is
  **`/v2/foreign`** (`api.js:172` → `Api.FOREIGN_API_URL`, `api.js:14509-14513`, version
  from `api.js:17261-17265`). Anything else → **404** (`api.js:8072-8078`).
- **`Type`** — the inbound `Content-Type`. Anything but `application/json` → **415**
  (`api.js:8056-8068`).
- **`Data`** — base64 of the raw request body. Decoded with `Base64.toUint8Array`, which
  accepts standard **and** URL-safe alphabets (`base64.js-3.7.5.js:229`), then parsed as
  UTF-8 JSON-RPC; bad UTF-8 or bad JSON → **415** (`api.js:184-195`).

There is **no HTTP method field and no header field** in the protocol. The client sees a
body and a content type, nothing else. Consequences: the gateway answers CORS preflight
itself (nginx's `/wallet/` location allow-lists `Access-Control-Allow-*`, ref conf 240-275),
and no inbound header can ever reach the wallet tab.

### 6. Client → server: interaction response

```json
{ "Interaction": <n>, "Type": "application/json"|"text/plain",
  "Data": "<base64>", "Status": <http-status-number> }
```

`Type` is `application/json` when the payload is an object, `text/plain` otherwise (L:685,
L:823); `Data` is standard padded base64 of the UTF-8 bytes (L:688, `base64.js-3.7.5.js:109`),
and is the base64 of the **empty string** when the client is answering with a bare status
(L:826).

**`Status` here is a number** — an HTTP status the gateway should return to the inbound
sender (`common.js:1184-1229`):

| Constant (L:919-951) | HTTP | Emitted when |
|---|---|---|
| `OK_RESPONSE` = 0 | 200 | every successful response (L:691) — **and every JSON-RPC-level error too**, see below |
| `UNAUTHORIZED_RESPONSE` = 1 | 401 | **never sent by this client** — defined only |
| `FORBIDDEN_RESPONSE` = 2 | 403 | **never sent by this client** — defined only |
| `NOT_FOUND_RESPONSE` = 3 | 404 | no wallet owns that suffix, or wallet gone mid-flight (`wallets.js:1159`, `:1273`, `:1290`); unsupported `API` (`api.js:8077`); interaction arriving on a socket the client has already abandoned (L:1359-1376) |
| `UNSUPPORTED_MEDIA_TYPE_RESPONSE` = 4 | 415 | non-JSON `Type`, undecodable `Data`, malformed fields (L:1293, L:1353; `api.js:191`, `:8059`, `:8067`) |

⚠ **A rejected payment is still HTTP 200.** `respondWithError` only leaves the 200 when
`data` is a bare **number** (L:761-764); a JSON-RPC error object (user declined, invalid
params) is sent as an object, so it is transported as 200 with a JSON-RPC `error` body
(`wallets.js:1174-1181`). That is correct JSON-RPC and the gateway must not "helpfully"
translate it to a 4xx.

### 7. Server → client: status (the ack of §6)

```json
{ "Interaction": <n>, "Status": "Succeeded" }     // success
{ "Interaction": <n>, "Error": <anything> }       // failure
```

**`Status` here is a string** — `"Succeeded"` (L:1845-1848) is the only value the client
*treats* as success (L:699), though see the ack-window warning below for what it actually
acts on. The type asymmetry with §6 is the single easiest thing to get wrong in S4b: the
same key name is a number one way and a string the other.

**One message shape, two roles, decided by timing.** Both roles are keyed to the same
interaction id, and the client hands the id from one handler to the other at the moment it
replies (the cancel handler is torn down on the first line of `respondWithData` /
`respondWithError`, L:667-670, L:748-752, and the ack handler is registered as the reply is
sent, L:1640):

| Status arrives… | Role | Effect |
|---|---|---|
| **before** the tab has replied | **cancel** | anything that is not `"Succeeded"` — including an `Error` key or a missing `Status` key — marks the interaction canceled (L:1304-1321), which aborts the in-progress wallet operation (`interaction.js:96-107`, consumed at `wallets.js:575-579`) |
| **after** the tab has replied | **ack** | resolves on any **string** `Status`; rejects only on an `Error` key, a missing `Status`, a non-string `Status`, or silence (L:1652-1661, L:693-705) |

So the gateway **can** abort work the tab is doing — send a status carrying `Error` for that
interaction id before the tab replies (the natural use: the inbound HTTP client hung up). A
settings change cancels every outstanding interaction the same way (L:1324-1331).

⚠ **In the ack window, a non-`"Succeeded"` string does not mean failure — it commits.** The
client resolves on any string `Status` and only compares it to `"Succeeded"` to decide a
boolean (L:696-699) that its caller then **ignores** (`wallets.js:586` takes a zero-argument
`.then`). So `{"Status":"Nope"}` records the transaction exactly as `"Succeeded"` would.
The only ways to signal ack-failure are an `Error` key, a missing/non-string `Status`, or
silence — each of which lands in the rollback below. Send `"Succeeded"`, or send `Error`;
nothing else.

⚠ **The ack is the commit point, and this is money-relevant.** The tab records the received
transaction only *inside* the success branch of its reply
(`wallets.js:586` → the whole `.then(…)` block through `:1092`). If the ack never arrives, the
120 s `RESPONSE_TIMEOUT_SECONDS` fires (L:1626-1634), `respondWithData` rejects, and the
client takes the rollback path (`wallets.js:1093-1127`): it releases the wallet lock, saves
**only** the key-derivation counter, and **does not record the transaction** — while the
gateway may already have handed the signed slate back to the sender, who can finalise and
broadcast it. Funds are not lost (the wallet finds the output on its next chain scan), but the
receiver's transaction list will not show a payment the sender considers made.

**Therefore, for S4b:** send the status **after** the response has actually been handed to the
inbound sender, and send it reliably. Note the mechanism precisely — silence does **not**
cancel; it stalls for 120 s and then lands in the rollback above.

### 8. Timeouts and the retry ladder

| Constant | Value | Where |
|---|---|---|
| `REQUEST_TIMEOUT_SECONDS` | **120 s** (`2 × 60`) | L:1761-1764, applied L:1480 |
| `RESPONSE_TIMEOUT_SECONDS` | **120 s** (aliases the above) | L:1768-1771, applied L:1634 |
| `INITIAL_RETRY_DELAY_MILLISECONDS` | **250 ms** | L:1719-1722 |
| `MAXIMUM_RETRY_DELAY_MILLISECONDS` | **10 s** | L:1726-1729 |
| `RETRY_DELAY_SCALING_FACTOR` | **2** | L:1733-1736 |
| `CONNECTION_CLOSE_FAIL_THRESHOLD` | **3** | L:1782-1785 |

**Reconnect ladder** — the delay is `min(10 s, retryDelay)` and `retryDelay` doubles after
each attempt (L:1116-1127 for a constructor throw, L:1209-1220 for a close): **250, 500,
1000, 2000, 4000, 8000, 10000, 10000 …**. It resets to 250 ms on a successful `open`
(L:1153), on a listener settings change (L:182), and on `window` `online`/`offline`
(L:208, L:257). Reconnection is unconditional and unbounded — **there is no give-up state.**
A tab left open against a dead gateway retries every 10 s forever.

**Close threshold** — a pending request or interaction-response survives reconnects: it is
**re-sent verbatim on every `CONNECTION_OPEN`** (L:1511-1514, L:1665-1668) and only fails
after the **3rd** close (L:1520, L:1674). So the *same* `Index` can legitimately arrive on
two different connections, and a `Create URL` that we answered on a socket the client did not
survive **will be asked again** — under a new session, with the old suffix orphaned.

### 9. Address suffix ↔ the wallet's public address

The suffix the server mints is not the address; the wallet composes the address
(`wallet.js:3598-3610`):

```
HTTPS address :  <HTTPS_SERVER_ADDRESS>/wallet/<suffix>
Tor address   :  <TOR_SERVER_ADDRESS>/wallet/<suffix>
Foreign API   :  <address>/v2/foreign          (api.js:14509-14513)
```

Both `*_SERVER_ADDRESS` values are baked in at build time (S1's env contract), which is why
`TOR_SERVER_ADDRESS` must be set as soon as S7 mints the onion — otherwise the "Onion
Service" address type hands out a clearnet host.

If the returned string itself parses as a URL, the wallet uses it **verbatim** as the address
instead (`wallet.js:3048-3056`) — the custom-listener case. Our gateway mints bare suffixes.

⚠ **Mint lowercase alphanumeric suffixes only.** Inbound lookup lowercases the incoming
suffix (`wallets.js:5007`) but the wallet stores what it was given **verbatim**
(`wallets.js:3923`, `:9250`). A suffix containing an uppercase letter would therefore be
saved as an index key that the lookup can never match: the address displays fine, the sender
delivers fine, and **every inbound payment is answered 404** with nothing in the UI to
explain it. Upstream's nginx accepts `[a-zA-Z0-9]+` (ref conf 240) — that is the ceiling,
not the target. Length is our choice (§11 item 2).

### 10. Ownership across reconnects — the load-bearing gap

**What the client does:** on `CONNECTION_OPEN` it calls `Own URL` for every wallet that holds
a suffix (`wallets.js:1296-1311`). `true` → the suffix is marked verified. `false` → the
wallet **discards it and calls `Create URL`** (`wallets.js:4035-4048`), i.e. *the wallet's
receiving address silently changes*. On close, every suffix is marked unverified again
(`wallets.js:1317-1335`).

**What the client sends to prove ownership: nothing.** No token, no key, no signature, no
identifier — `Own URL` carries only the suffix, which is public (it is the payee's address).
Taken alone, a server implementing this protocol literally would let any tab claim any
address.

**How upstream closes it:** a **session cookie on the WebSocket handshake**. The client never
touches it (its only `document.cookie` write is the language cookie, `language.js:1471`), but
upstream's nginx proves it exists — across the whole conf, `proxy_set_header Cookie` and
`allow_header Set-Cookie` appear **only** in the two `/listen` blocks (ref conf 217 + 223
clearnet, 1065 + 1071 onion), and `/listen` adds `Vary: Cookie` (ref conf 233). No other
location forwards a cookie or is allowed to set one. Nothing else in the request is stable
across a reconnect.

**Therefore, for S4b:** ownership is bound to a server-issued, `HttpOnly`+`Secure`+
`SameSite` session cookie set on the `/listen` handshake response; `Own URL` answers `true`
only when the suffix's owning session matches the requesting connection's session. The
consequences are ours to state plainly, because they are user-visible:

- A cookie loss (private-window close, cookie clear, expiry) **changes the user's receiving
  address**, by design of the client's `false → Create URL` path. The expiry we choose *is*
  an address-lifetime policy.
- The onion front and the clearnet front are different origins with different cookie jars;
  the same wallet reached both ways gets two sessions and therefore two suffixes. Decide
  whether that is acceptable (it is arguably good for privacy) and document it.
- A stolen cookie is a stolen inbound address: the thief can `Change URL`/`Delete URL` and
  make the victim's address stop receiving. It cannot spend — keys never leave the tab — so
  this is a denial-of-receipt, not a theft. Ownership checks belong on all three of
  `Change URL`, `Delete URL` **and** the delivery path.

### 11. What the client does not reveal — these are our decisions

Each of these is invisible in `listener.js` by construction. S4b decides them; S8 audits them.

1. **Session/ownership mechanism** — see §10. Inferred from nginx, not from the client.
2. **Suffix alphabet, length and entropy.** Constraints known: lowercase (§9) and
   `[a-zA-Z0-9]+` at the nginx layer. Everything else is ours — and the suffix is a bearer
   name for an address, so it needs enough entropy to resist enumeration.
3. **Quotas.** Max suffixes per session, max concurrent sockets per session/IP, per-connection
   message rate. Nothing in the protocol limits how often a tab may call `Create URL`, and
   §8's re-send-on-reconnect makes accidental repeats normal.
4. **Lifetime and garbage collection.** When does an unused suffix expire? What happens to
   the suffix orphaned by an unacknowledged `Create URL`? The client never re-claims a suffix
   it has forgotten, so without GC the table only grows.
5. **Delivery when the owner is offline.** Upstream holds the inbound HTTP request open for
   `proxy_read_timeout 208w` (ref conf 255) — an unbounded resource hold, the same objection
   S3 raised about the `/tor/` rail. Ours must be bounded; the client-side ceiling is the
   120 s response timeout (§8), so anything beyond ~2 min is pure cost. Decide the status
   returned to the sender when nobody answers (502/504 vs. a JSON-RPC error).
6. **Interaction-id allocation** — integers, unique in flight (§5); reuse policy is ours.
7. **Inbound body cap.** The client has none, and upstream's `/wallet/` location sets **no**
   `client_max_body_size` (the 10M appears only on `/tor/` and `/donate/`, ref conf 184, 307,
   346, 385), so it silently inherits nginx's 1 MB default. Set it explicitly.
8. **Liveness.** The client never pings (§1) and upstream's `/listen` has
   `proxy_read_timeout 60s` (ref conf 209). An idle socket therefore dies at 60 s, the client
   reconnects, and each reconnect costs an `Own URL` per wallet. **The server must send
   WebSocket pings well inside 60 s** — or the whole population re-handshakes every minute.
9. **Behaviour on an unknown `Request` name, a duplicate `Index`, or a request arriving before
   any session exists.** Not observable from the client; note that saying *nothing* costs the
   user a 120 s stall, so answer with `Error` rather than dropping.
10. **Whether a second socket for the same session is allowed**, and which one owns delivery.
11. **Logging policy.** Not a protocol question, but the same rule as S3's `/tor/` rail
    applies with more force: a suffix is a payee address and an inbound POST is a payment.
    **Never log suffix ↔ IP ↔ timestamp together.**

### 12. Traps worth carrying verbatim into S4b

- `Status` is a **number** client→server and the **string** `"Succeeded"` server→client (§6, §7).
- Message discrimination is **ordered**; `Index` wins over `Interaction` (§2).
- The status message is a **cancel** before the tab replies and an **ack** after it (§7); the
  ack is the point at which the tab records the received transaction, so a lost ack loses the
  receiver's record of a payment the sender can still finalise. Silence does **not** cancel —
  it stalls 120 s and then rolls back.
- `Delete URL` treats an error response as `false`, and `deleteAddressSuffix` retries a
  *rejected* delete immediately and recursively (`wallets.js:4223-4227`) — a connection-level
  failure here is a client-side retry loop, so answer `Delete URL` with a well-formed message
  even when refusing.
- The same `Index` may arrive on a later connection; `Create URL` is **not** idempotent (§8).
- Uppercase in a minted suffix breaks receiving, silently and permanently (§9).
- The default listener URL drops the port (§1).

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
